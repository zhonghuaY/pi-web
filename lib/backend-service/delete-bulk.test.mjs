import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-bulk-delete-"));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentHome;
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  await rm(agentHome, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { POST } = await jiti.import("../../app/api/sessions/delete/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, getSessionListVersion, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { readSessionUiState, updateSessionUiState } = await jiti.import("../session-ui-state.ts");
const registryKey = Symbol.for("pi-web.claude-backend.registry");
const claudeId = (n) => `claude:123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-bulk-data-")));
  const previousPi = globalThis.__piSessions;
  const previousClaude = globalThis[registryKey];
  const wrappers = new Map();
  globalThis.__piSessions = new Map();
  globalThis[registryKey] = { sessions: wrappers, createRequests: new Map(), cleanupInstalled: true };
  const ids = [];
  const project = join(nativeHome, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  t.after(async () => {
    for (const wrapper of wrappers.values()) if (typeof wrapper.close === "function") await wrapper.close();
    globalThis.__piSessions = previousPi;
    globalThis[registryKey] = previousClaude;
    for (const id of ids) invalidateSessionPathCache(id);
    await rm(dir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  async function pi() {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
    const id = manager.getSessionId();
    const path = manager.getSessionFile();
    ids.push(id);
    cacheSessionPath(id, path);
    return { id, path, manager };
  }
  async function claude(n) {
    const id = claudeId(n);
    const nativeId = id.slice(7);
    await mkdir(project, { recursive: true });
    const path = join(project, `${nativeId}.jsonl`);
    await writeFile(path, JSON.stringify({ type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174021", parentUuid: null, cwd: dir, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: "fixture" } }) + "\n");
    return { id, path };
  }
  return { pi, claude, wrappers };
}

test("mixed deletion removes Pi and unique Claude sessions and their sidebar state", async (t) => {
  const f = await fixture(t);
  const pi = await f.pi();
  const claude = await f.claude(30);
  await updateSessionUiState({ action: "set", ids: [pi.id, claude.id, "untouched"], pinned: true });
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.deleteBulk({ ids: [pi.id, claude.id, claude.id, "missing-pi"] }), {
    ok: true, value: { deleted: [pi.id, claude.id], missing: ["missing-pi"], running: [] },
  });
  await assert.rejects(access(pi.path), { code: "ENOENT" });
  await assert.rejects(access(claude.path), { code: "ENOENT" });
  assert.equal(readSessionUiState().sessions[pi.id], undefined);
  assert.equal(readSessionUiState().sessions[claude.id], undefined);
  assert.ok(readSessionUiState().sessions.untouched.pinnedAt);
  assert.ok(getSessionListVersion() > version);
});

test("bulk delete keeps running Pi sessions and reports missing ones", async (t) => {
  const f = await fixture(t);
  const pi = await f.pi();
  let stopped = false;
  globalThis.__piSessions.set(pi.id, {
    sessionId: pi.id, sessionFile: pi.path, inner: { sessionManager: pi.manager },
    isAlive: () => true, isRunning: () => true, isAwaitingInput: () => false,
    shutdown: async () => { stopped = true; },
  });
  assert.deepEqual(await sessions.deleteBulk({ ids: [pi.id, "missing-pi", "missing-pi"] }), {
    ok: true, value: { deleted: [], missing: ["missing-pi"], running: [pi.id] },
  });
  await access(pi.path);
  assert.equal(stopped, false);
});

test("Claude 409 and 404 map to running and missing, with cleanup and cache invalidation", async (t) => {
  const f = await fixture(t);
  const running = claudeId(31);
  const missing = claudeId(32);
  for (const [id, status] of [[running, 409], [missing, 404]]) {
    f.wrappers.set(id, { cwd: agentHome, isAlive: () => true, isSideSession: () => false,
      withExclusiveMutation: async () => { throw Object.assign(new Error("refused"), { status }); } });
  }
  await updateSessionUiState({ action: "set", ids: [running, missing], pinned: true });
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.deleteBulk({ ids: [running, missing, running] }), {
    ok: true, value: { deleted: [], missing: [missing], running: [running] },
  });
  assert.ok(readSessionUiState().sessions[running].pinnedAt);
  assert.ok(readSessionUiState().sessions[missing].pinnedAt);
  assert.ok(getSessionListVersion() > version);
});

test("unexpected Claude errors propagate", async (t) => {
  const f = await fixture(t);
  const id = claudeId(33);
  f.wrappers.set(id, { cwd: agentHome, isAlive: () => true, isSideSession: () => false,
    withExclusiveMutation: async () => { throw Object.assign(new Error("native failure"), { status: 423 }); } });
  await assert.rejects(sessions.deleteBulk({ ids: [id] }), { message: "native failure", status: 423 });
  const response = await POST(new Request("http://localhost/api/sessions/delete", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "native failure" });
});

test("disabled Claude refuses mixed deletion before any files or sidebar state change", async (t) => {
  const f = await fixture(t);
  const pi = await f.pi();
  const claude = await f.claude(34);
  await updateSessionUiState({ action: "set", ids: [pi.id, claude.id], pinned: true });
  const previous = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "0";
  t.after(() => { if (previous === undefined) delete process.env.PI_WEB_CLAUDE; else process.env.PI_WEB_CLAUDE = previous; });
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.deleteBulk({ ids: [pi.id, claude.id] }), { ok: false, kind: "disabled" });
  const response = await POST(new Request("http://localhost/api/sessions/delete", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ ids: [pi.id, claude.id] }) }));
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Claude is disabled" });
  await access(pi.path);
  await access(claude.path);
  assert.ok(readSessionUiState().sessions[pi.id].pinnedAt);
  assert.ok(readSessionUiState().sessions[claude.id].pinnedAt);
  assert.equal(getSessionListVersion(), version);
});

test("all identities are checked before deletion and route refusals carry no-store", async (t) => {
  const f = await fixture(t);
  const pi = await f.pi();
  for (const [id, outcome, body] of [
    ["claude:not-a-uuid", { ok: false, kind: "invalid", reason: "invalid-id" }, { error: "ids must be session ids" }],
    ["claude:123e4567-e89b-02d3-a456-426614174021", { ok: false, kind: "invalid", reason: "invalid-id" }, { error: "Invalid session id", reason: "invalid-id" }],
    ["future:123", { ok: false, kind: "invalid", reason: "unknown-namespace" }, { error: "ids must be session ids" }],
    ["codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a", { ok: false, kind: "unsupported" }, { error: "Codex sessions are not available", reason: "backend-unavailable" }],
  ]) {
    assert.deepEqual(await sessions.deleteBulk({ ids: [pi.id, id] }), outcome);
    const response = await POST(new Request("http://localhost/api/sessions/delete", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ ids: [pi.id, id] }) }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), body);
    await access(pi.path);
  }
});
