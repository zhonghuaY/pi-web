import { parseSessionKey } from "@/lib/session-identity";
import { codexPayloadValidators, type CodexPayloads } from "./internal/payloads";
import { ClientMethod, SUPPORTED_CODEX_CLI_VERSION } from "./internal/protocol";
import { CodexTransportError, startCodexTransport, type CodexTransport } from "./internal/transport";

export type CodexThread = CodexPayloads["thread/read"]["thread"];
export type CodexCatalogueOptions = { binary?: string; env?: NodeJS.ProcessEnv; cwd?: string };

export class CodexCatalogueError extends Error {
  constructor(readonly kind: "unavailable" | "invalid-payload" | "incomplete") {
    super(`Codex history ${kind}`);
    this.name = "CodexCatalogueError";
  }
}

const inspection = codexPayloadValidators({ state: "supported", version: SUPPORTED_CODEX_CLI_VERSION });

async function usingTransport<T>(options: CodexCatalogueOptions, fn: (transport: CodexTransport, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (inspection.state !== "supported") throw new CodexCatalogueError("unavailable");
  const transport = await startCodexTransport({ ...options, requestTimeoutMs: 10_000, shutdownTimeoutMs: 500 });
  try { return await fn(transport, AbortSignal.timeout(30_000)); }
  finally { await transport.shutdown(); }
}

async function listThreads(transport: CodexTransport, signal: AbortSignal): Promise<CodexThread[]> {
  if (inspection.state !== "supported") throw new CodexCatalogueError("unavailable");
  const { validators } = inspection;
  const threads: CodexThread[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const payload = validators.validate("thread/list", await transport.request(ClientMethod.threadList, { limit: 100, ...(cursor !== undefined ? { cursor } : {}) }, { signal }));
    if (payload.state !== "valid") throw new CodexCatalogueError("invalid-payload");
    threads.push(...payload.value.data);
    cursor = payload.value.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new CodexCatalogueError("incomplete");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return threads;
}

async function readThread(transport: CodexTransport, signal: AbortSignal, threadId: string): Promise<CodexThread> {
  if (inspection.state !== "supported") throw new CodexCatalogueError("unavailable");
  const payload = inspection.validators.validate("thread/read", await transport.request(ClientMethod.threadRead, { threadId, includeTurns: true }, { signal }));
  if (payload.state !== "valid" || payload.value.thread.id.toLowerCase() !== threadId.toLowerCase()) throw new CodexCatalogueError("invalid-payload");
  return payload.value.thread;
}

export async function listCodexThreads(options: CodexCatalogueOptions = {}): Promise<CodexThread[]> {
  return usingTransport(options, listThreads);
}

export async function mapCodexThreadsWithHistory<T>(project: (thread: CodexThread) => T | null, options: CodexCatalogueOptions = {}): Promise<{ rows: T[]; incomplete: boolean }> {
  return usingTransport(options, async (transport, signal) => {
    const threads = await listThreads(transport, signal);
    const projected = threads.map(project);
    const groups = new Map<string, number[]>();
    let incomplete = false;
    for (const [index, thread] of threads.entries()) {
      if (projected[index] === null) {
        // A canonical row without a projection may hide an existing handoff target.
        if (parseSessionKey(`codex:${thread.id}`).ok) incomplete = true;
        continue;
      }
      const id = thread.id.toLowerCase();
      const indexes = groups.get(id) ?? [];
      indexes.push(index);
      groups.set(id, indexes);
    }
    const pending = [...groups.values()];
    let next = 0;
    let transportClosed = false;
    const worker = async () => {
      while (!transportClosed && next < pending.length) {
        const indexes = pending[next++];
        const first = threads[indexes[0]];
        try {
          const history = await readThread(transport, signal, first.id);
          for (const index of indexes) {
            const row = threads[index];
            projected[index] = project({
              ...row, turns: history.turns,
              ...((!("forkedFromId" in row) || row.forkedFromId === null) && "forkedFromId" in history ? { forkedFromId: history.forkedFromId } : {}),
            });
            if (projected[index] === null) incomplete = true;
          }
        } catch (error) {
          incomplete = true;
          if (error instanceof CodexTransportError && (error.kind === "protocol" || error.kind === "exit" || error.kind === "closed" || error.kind === "spawn" || error.kind === "cancelled")) {
            transportClosed = true;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
    return { rows: projected.filter((value): value is T => value !== null), incomplete };
  });
}

export async function readCodexThread(threadId: string, options: CodexCatalogueOptions = {}): Promise<CodexThread> {
  return usingTransport(options, async (transport, signal) => {
    try { return await readThread(transport, signal, threadId); }
    catch (error) {
      if (error instanceof CodexTransportError && error.kind === "rpc" && error.code === -32601) {
        throw new CodexCatalogueError("unavailable");
      }
      throw error;
    }
  });
}
