import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ClientMethod, isInitializeResponse, isRpcEnvelope, isRpcNotification, isRpcRequest, type RpcId, type RpcRequest, type RpcNotification } from "./protocol";
import { inspectCodexVersion, type VersionInspection } from "./version";

const MAX_LINE = 4 * 1024 * 1024;
const MAX_STDERR = 4096;
const MAX_PENDING = 1024;
const DEFAULT_TIMEOUT = 30_000;

export class CodexTransportError extends Error {
  readonly kind: "spawn" | "version" | "protocol" | "exit" | "timeout" | "cancelled" | "rpc" | "closed" | "capacity";
  readonly code?: number;
  readonly rpcMessage?: string;
  constructor(kind: CodexTransportError["kind"], rpcError?: { code: number; message: string }) {
    super(`Codex transport ${kind}`);
    this.kind = kind;
    this.name = "CodexTransportError";
    if (rpcError) {
      this.code = rpcError.code;
      this.rpcMessage = rpcError.message;
    }
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void };
export type ServerRequestHandler = (request: RpcRequest, signal: AbortSignal) => Promise<unknown> | unknown;
export type TransportOptions = {
  onNotification?: (notification: RpcNotification) => void;
  onFailure?: (error: CodexTransportError) => void;
  serverRequests?: Readonly<Record<string, ServerRequestHandler>>;
  requestTimeoutMs?: number;
  interactionTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};
export type RequestOptions = { id?: RpcId; signal?: AbortSignal; timeoutMs?: number };

export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("PI_WEB_")) delete env[key];
  return env;
}

export function inspectInstalledCodex(binary = "codex", env = codexEnvironment(), cwd?: string): Promise<VersionInspection> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--version"], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const finish = (error?: CodexTransportError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(inspectCodexVersion(output));
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new CodexTransportError("timeout")); }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 256) { child.kill("SIGKILL"); finish(new CodexTransportError("version")); }
      else output += chunk.toString();
    });
    child.on("error", () => finish(new CodexTransportError("spawn")));
    child.on("close", code => finish(code === 0 ? undefined : new CodexTransportError("spawn")));
  });
}

export class CodexTransport {
  private state: "open" | "closing" | "closed" = "open";
  private readonly pending = new Map<RpcId, Pending>();
  private readonly usedIds = new Set<RpcId>();
  private readonly interactions = new Map<RpcId, AbortController>();
  private readonly decoder = new StringDecoder("utf8");
  private input = "";
  private stderr = Buffer.alloc(0);
  private nextId = 0;
  private shutdownPromise?: Promise<void>;
  private readonly closed: Promise<void>;
  private finishClosed!: () => void;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: TransportOptions;
  constructor(child: ChildProcessWithoutNullStreams, options: TransportOptions = {}) {
    this.child = child;
    this.options = options;
    this.closed = new Promise(resolve => { this.finishClosed = resolve; });
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stdout.on("error", () => this.fail(new CodexTransportError("protocol")));
    child.stdin.on("error", () => this.fail(new CodexTransportError("exit")));
    child.stderr.on("data", (chunk: Buffer) => {
      const tail = chunk.length > MAX_STDERR ? chunk.subarray(chunk.length - MAX_STDERR) : chunk;
      this.stderr = Buffer.concat([this.stderr, tail]).subarray(-MAX_STDERR);
    });
    child.stderr.on("error", () => this.fail(new CodexTransportError("exit")));
    child.on("error", () => this.fail(new CodexTransportError("spawn")));
    child.on("exit", () => this.fail(new CodexTransportError("exit")));
    child.on("close", () => { this.fail(new CodexTransportError("exit")); this.finishClosed(); });
  }

  get stderrBytes(): number { return this.stderr.length; }
  get isOpen(): boolean { return this.state === "open" && !this.child.stdin.destroyed && this.child.exitCode === null && this.child.signalCode === null; }

  private write(message: unknown): void {
    if (this.state !== "open" || this.child.stdin.destroyed) throw new CodexTransportError("closed");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE || this.child.stdin.writableLength + Buffer.byteLength(line) > MAX_LINE) throw new CodexTransportError("capacity");
    this.child.stdin.write(line);
  }

  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(new CodexTransportError("cancelled"));
    if (this.pending.size >= MAX_PENDING || this.usedIds.size >= 65536) return Promise.reject(new CodexTransportError("capacity"));
    let id = options.id;
    if (id === undefined) {
      do { id = ++this.nextId; } while (this.usedIds.has(id));
    }
    if (this.usedIds.has(id)) return Promise.reject(new CodexTransportError("capacity"));
    this.usedIds.add(id);
    return new Promise((resolve, reject) => {
      const cancel = () => settle(new CodexTransportError("cancelled"));
      const timer = setTimeout(() => settle(new CodexTransportError("timeout")), options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); this.pending.delete(id); };
      const settle = (error: Error) => { cleanup(); reject(error); };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", cancel, { once: true });
      try { this.write({ id, method, params }); } catch (error) { settle(error instanceof CodexTransportError ? error : new CodexTransportError("protocol")); }
    });
  }

  notify(method: string, params: unknown = {}): void { this.write({ method, params }); }

  private receive(chunk: Buffer): void {
    if (this.state !== "open") return;
    this.input += this.decoder.write(chunk);
    for (;;) {
      const end = this.input.indexOf("\n");
      if (end < 0) break;
      if (Buffer.byteLength(this.input.slice(0, end)) > MAX_LINE) { this.fail(new CodexTransportError("protocol")); return; }
      const line = this.input.slice(0, end);
      this.input = this.input.slice(end + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.fail(new CodexTransportError("protocol")); return; }
      if (!isRpcEnvelope(value)) { this.fail(new CodexTransportError("protocol")); return; }
      if (isRpcRequest(value)) this.handleServerRequest(value);
      else if (isRpcNotification(value)) {
        try { this.options.onNotification?.(value); } catch { this.fail(new CodexTransportError("protocol")); return; }
      } else {
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        pending.cleanup();
        if ("error" in value) pending.reject(new CodexTransportError("rpc", value.error)); else pending.resolve(value.result);
      }
      if (this.state !== "open") return;
    }
    if (Buffer.byteLength(this.input) > MAX_LINE) this.fail(new CodexTransportError("protocol"));
  }

  private handleServerRequest(request: RpcRequest): void {
    const handler = Object.prototype.hasOwnProperty.call(this.options.serverRequests ?? {}, request.method) ? this.options.serverRequests?.[request.method] : undefined;
    if (this.interactions.has(request.id)) {
      this.fail(new CodexTransportError("protocol"));
      return;
    }
    if (!handler || this.interactions.size >= MAX_PENDING) {
      try { this.write({ id: request.id, error: { code: -32601, message: "Unsupported server request" } }); } catch { this.fail(new CodexTransportError("exit")); }
      return;
    }
    const controller = new AbortController();
    this.interactions.set(request.id, controller);
    const timer = setTimeout(() => finish(false), this.options.interactionTimeoutMs ?? DEFAULT_TIMEOUT);
    let done = false;
    const finish = (ok: boolean, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.interactions.delete(request.id);
      controller.abort();
      if (this.state !== "open") return;
      try { this.write(ok && result !== undefined ? { id: request.id, result } : { id: request.id, error: { code: -32603, message: "Server request failed" } }); }
      catch { this.fail(new CodexTransportError("exit")); }
    };
    controller.signal.addEventListener("abort", () => finish(false), { once: true });
    Promise.resolve().then(() => controller.signal.aborted ? undefined : handler(request, controller.signal)).then(result => finish(true, result), () => finish(false));
  }

  private fail(error: CodexTransportError): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.input = "";
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    for (const interaction of this.interactions.values()) interaction.abort();
    this.interactions.clear();
    if (error.kind === "protocol" || error.kind === "spawn") this.child.kill("SIGKILL");
    if (error.kind !== "closed") {
      try { this.options.onFailure?.(error); } catch { /* transport failure is already final */ }
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (this.state !== "closed") {
        this.fail(new CodexTransportError("closed"));
        this.child.stdin.end();
      }
      const wait = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.shutdownTimeoutMs ?? 1500); })]);
        if (timer) clearTimeout(timer);
      };
      await wait();
      if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill("SIGTERM"); await wait(); }
      if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill("SIGKILL"); await wait(); }
    })();
    return this.shutdownPromise;
  }
}

export async function startCodexTransport(options: TransportOptions & { binary?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CodexTransport> {
  const binary = options.binary ?? "codex";
  const env = codexEnvironment(options.env);
  const version = await inspectInstalledCodex(binary, env, options.cwd);
  if (version.state !== "supported") throw new CodexTransportError("version");
  const child = spawn(binary, ["app-server", "--stdio"], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const transport = new CodexTransport(child, options);
  try {
    const result = await transport.request(ClientMethod.initialize, { clientInfo: { name: "pi-web", version: "0.15.0" }, capabilities: { experimentalApi: true } });
    if (!isInitializeResponse(result)) throw new CodexTransportError("protocol");
    transport.notify(ClientMethod.initialized);
    return transport;
  } catch (error) { await transport.shutdown(); throw error; }
}
