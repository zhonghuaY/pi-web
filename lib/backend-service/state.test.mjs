import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-service-state-"));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentHome;
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  await rm(agentHome, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const claude = await jiti.import("../agent-backends/claude.ts");
const { GET: sessionGet } = await jiti.import("../../app/api/sessions/[id]/state/route.ts");
const { GET: agentGet } = await jiti.import("../../app/api/agent/[id]/route.ts");
const request = (id, missingPi = "not-found", includeSystemPrompt = true) => ({ id, missingPi, includeSystemPrompt });
const get = (handler, id, query = "") => handler(new Request(`http://localhost/api/test${query}`), { params: Promise.resolve({ id }) });

test("Pi state distinguishes missing, persisted and live sessions without starting a wrapper", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-state-data-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  const id = manager.getSessionId();
  cacheSessionPath(id, manager.getSessionFile());
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  t.after(async () => {
    globalThis.__piSessions = previous;
    invalidateSessionPathCache(id);
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await sessions.state(request("missing-state-id", "idle")), { ok: true, value: { running: false } });
  assert.deepEqual(await sessions.state(request("missing-state-id")), { ok: false, kind: "not-found" });
  assert.equal((await get(sessionGet, "missing-state-id")).status, 404);
  assert.deepEqual(await (await get(agentGet, "missing-state-id")).json(), { running: false });
  assert.deepEqual(await sessions.state(request(id)), { ok: true, value: { running: false } });
  assert.equal(getRpcSession(id), undefined);
  globalThis.__piSessions.set(id, {
    isAlive: () => true,
    send: async () => ({ systemPrompt: "prompt", isStreaming: true }),
  });
  assert.deepEqual(await sessions.state(request(id)), { ok: true, value: { running: true, state: { systemPrompt: "prompt", isStreaming: true } } });
  assert.deepEqual(await (await get(agentGet, id, "?systemPrompt=0")).json(), { running: true, state: { isStreaming: true } });
  assert.deepEqual(await (await get(sessionGet, id)).json(), { running: true, state: { systemPrompt: "prompt", isStreaming: true } });
});

test("Claude live and persisted state use the existing native behavior", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-state-claude-")));
  const nativeId = "123e4567-e89b-42d3-a456-426614174010";
  const id = `claude:${nativeId}`;
  const project = join(nativeHome, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const wrappers = new Map();
  globalThis[key] = { sessions: wrappers, createRequests: new Map(), cleanupInstalled: true };
  t.after(async () => {
    globalThis[key] = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${nativeId}.jsonl`), JSON.stringify({
    type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null,
    cwd: dir, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: "fixture" },
  }) + "\n");
  const dormant = await sessions.state(request(id));
  assert.equal(dormant.ok, true);
  assert.equal(dormant.value.running, false);
  assert.equal(dormant.value.state.backend, "claude");
  assert.equal(dormant.value.state.requiresProjectTrust, true);
  assert.deepEqual(dormant.value.state.capabilities, claude.CLAUDE_CAPABILITIES);
  assert.equal(wrappers.size, 0);
  wrappers.set(id, { isAlive: () => true, send: async () => ({ backend: "claude", systemPrompt: "native" }) });
  assert.deepEqual(await sessions.state(request(id, "idle", false)), { ok: true, value: { running: true, state: { backend: "claude", systemPrompt: "native" } } });
  for (const handler of [sessionGet, agentGet]) {
    assert.deepEqual(await (await get(handler, id, "?systemPrompt=0")).json(), { running: true, state: { backend: "claude", systemPrompt: "native" } });
  }
});

test("state refuses unknown and Codex identities without starting a runtime", async () => {
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  const before = claude.getClaudeRuntimeSnapshot();
  assert.deepEqual(await sessions.state(request("future:123")), { ok: false, kind: "invalid", reason: "unknown-namespace" });
  assert.deepEqual(await sessions.state(request(codex)), { ok: false, kind: "unsupported" });
  for (const handler of [sessionGet, agentGet]) {
    for (const [id, reason] of [["future:123", "unknown-namespace"], [codex, "backend-unavailable"]]) {
      const response = await get(handler, id);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).reason, reason);
    }
  }
  assert.equal(getRpcSession(codex), undefined);
  assert.deepEqual(claude.getClaudeRuntimeSnapshot(), before);
});

test("state preserves backend-specific error mapping", async (t) => {
  const id = "claude:123e4567-e89b-42d3-a456-426614174012";
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const error = Object.assign(new Error("fixture error"), { status: 418 });
  globalThis[key] = { sessions: new Map([[id, { isAlive: () => true, send: async () => { throw error; } }]]), createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis[key] = previous; });
  const result = await sessions.state(request(id));
  assert.equal(result.kind, "error");
  assert.equal(result.backend, "claude");
  for (const handler of [sessionGet, agentGet]) {
    const response = await get(handler, id);
    assert.equal(response.status, 418);
    assert.deepEqual(await response.json(), { error: "fixture error" });
  }
});
