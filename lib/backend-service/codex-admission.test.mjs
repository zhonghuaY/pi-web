import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = await mkdtemp(join(process.env.HOME, "service-admission-"));
for (const key of ["JITI_ALIAS", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"]) delete process.env[key];
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: join(root, "pi"),
  CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  PI_WEB_CODEX: "0",
  PI_WEB_CLAUDE: "0",
});
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const bin = join(root, "bin");
await mkdir(bin);
const log = join(root, "native-started");
await writeFile(join(bin, "codex"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, 'started\\n');\nprocess.exit(1);\n`);
await chmod(join(bin, "codex"), 0o700);
process.env.PATH = `${bin}:${process.env.PATH}`;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { parseAgentBackends } = await jiti.import("../agent-backends.ts");
const { GET: backendsRoute } = await jiti.import("../../app/api/agent/backends/route.ts");
const { cacheSessionPath } = await jiti.import("../session-reader.ts");
test.after(async () => { await rm(root, { recursive: true, force: true }); });

const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const meta = { holder: null, address: "127.0.0.1", client: "test" };

test("disabled Codex refuses every process-admitting operation", async () => {
  for (const value of ["0", "false"]) {
    process.env.PI_WEB_CODEX = value;
    const create = await sessions.createRuntime({ backend: "codex", cwd: root, type: "ensure_session", requestId });
    const prompt = await sessions.commandRuntime(codex, { type: "prompt", requestId, message: "hello" });
    const state = await sessions.commandRuntime(codex, { type: "get_state" });
    const events = await sessions.runtimeEvents(codex, new AbortController().signal, meta);
    const fork = await sessions.fork({ id: codex, side: false });
    for (const result of [create, prompt, state, events, fork]) {
      assert.equal(result.status, 503);
      assert.match(result.body.error, /disabled/i);
    }
    assert.equal(existsSync(log), false, "disabled calls must not even probe the binary");
  }
  process.env.PI_WEB_CODEX = "0";
});

test("invalid and unsupported session namespaces never reach Pi lookup", async () => {
  const previous = globalThis.__piSessions;
  const ids = ["future:123", "claude:not-a-uuid", "codex:not-a-uuid", "bad/id"];
  const unsupported = [codex, "claude:123e4567-e89b-42d3-a456-426614174001"];
  for (const id of [...ids, ...unsupported]) cacheSessionPath(id, join(root, "must-not-read"));
  globalThis.__piSessions = new Map([...ids, ...unsupported].map(id => [id, { isAlive: () => { throw new Error("Pi dispatch"); } }]));
  try {
    for (const id of ids) {
      assert.equal((await sessions.autoName(id)).status, 400, `autoName ${id}`);
      const fork = await sessions.fork({ id, side: false });
      assert.equal(fork.kind, "native", `fork ${id}`);
      assert.equal(fork.status, 400, `fork ${id}`);
      assert.equal((await sessions.commandRuntime(id, { type: "get_state" })).status, 400);
      assert.equal((await sessions.runtimeEvents(id, new AbortController().signal, meta)).status, 400);
      const history = { tail: 50, deferThinking: false, deferToolResultImages: false };
      for (const result of await Promise.all([
        sessions.read(id, { ...history, force: false, summaryTree: false }), sessions.context(id, history),
        sessions.state({ id, missingPi: "not-found", includeSystemPrompt: false }), sessions.lease({ id }),
        sessions.stats({ ids: [id] }), sessions.rename({ id, name: "name" }), sessions.delete({ id }),
        sessions.deleteBulk({ ids: [id] }), sessions.exportSession({ id }), sessions.subagents({ id }),
        sessions.thinking({ id, entryId: "entry", blockIndex: 0 }), sessions.toolResultImage({ id, entryId: "entry", blockIndex: 0 }),
      ])) assert.equal(result.kind, "invalid", `service operation ${id}`);
      assert.equal((await sessions.bashOutput(id, join(root, "output"), false)).kind, "invalid-id");
      const handoff = await sessions.handoff(id, { targetBackend: "pi", requestId, trustProject: false });
      assert.equal(handoff.status, 400);
    }
    for (const id of unsupported) assert.equal((await sessions.autoName(id)).status, 400, `autoName ${id}`);
  } finally { globalThis.__piSessions = previous; }
});

test("describe exposes safe Codex availability reasons through browser normalization", async () => {
  const binary = join(bin, "codex");
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    for (const [kind, reason] of [["disabled", "disabled"], ["missing", "not-installed"], ["incompatible", "unsupported-version"], ["available", undefined]]) {
      process.env.PI_WEB_CODEX = kind === "disabled" ? "0" : "1";
      if (kind === "missing") await rm(binary, { force: true });
      if (kind === "incompatible" || kind === "available") {
        const version = kind === "available" ? "0.153.4" : "0.1.0";
        await writeFile(binary, `#!${process.execPath}\nconsole.log('codex-cli ${version}');\n`);
        await chmod(binary, 0o700);
      }
      const description = await sessions.describe(root);
      const row = description.backends.find(entry => entry.backend === "codex");
      assert.equal(row.available, kind === "available", kind);
      assert.equal(row.reason, reason, kind);
      const response = await backendsRoute(new Request(`http://localhost/api/agent/backends?cwd=${encodeURIComponent(root)}`));
      assert.equal(response.status, 200, kind);
      const normalized = parseAgentBackends(await response.json());
      assert.equal(normalized.codex.available, kind === "available", kind);
      assert.equal(normalized.codex.reason, reason, kind);
    }
  } finally {
    process.env.PATH = previousPath;
    process.env.PI_WEB_CODEX = "0";
  }
});
