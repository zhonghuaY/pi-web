import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-service-delete-"));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentHome;
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  await rm(agentHome, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { DELETE } = await jiti.import("../../app/api/sessions/[id]/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, resolveSessionPath, getSessionListVersion, invalidateSessionPathCache, openSessionManager } = await jiti.import("../session-reader.ts");
const { readSessionUiState, updateSessionUiState } = await jiti.import("../session-ui-state.ts");
const remove = (id) => DELETE(new Request("http://localhost/api/test", { method: "DELETE" }), { params: Promise.resolve({ id }) });

async function piFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-data-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  const id = manager.getSessionId();
  const path = manager.getSessionFile();
  cacheSessionPath(id, path);
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  t.after(async () => {
    globalThis.__piSessions = previous;
    invalidateSessionPathCache(id);
    await rm(dir, { recursive: true, force: true });
  });
  return { id, path, manager };
}

test("Pi deletion removes disk data, cached reads and sidebar state", async (t) => {
  const { id, path } = await piFixture(t);
  await updateSessionUiState({ action: "set", ids: [id, "other"], pinned: true });
  await updateSessionUiState({ action: "set", ids: [id], archived: true });
  const original = await readFile(path);
  const cached = openSessionManager(path);
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.delete({ id }), { ok: true, value: { ok: true } });
  await assert.rejects(access(path), { code: "ENOENT" });
  assert.equal(await resolveSessionPath(id), null);
  assert.equal(readSessionUiState().sessions[id], undefined);
  assert.ok(readSessionUiState().sessions.other.pinnedAt);
  assert.ok(getSessionListVersion() > version);
  assert.deepEqual(await sessions.delete({ id }), { ok: false, kind: "not-found" });
  const response = await remove(id);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
  await writeFile(path, original);
  assert.notStrictEqual(openSessionManager(path), cached);
});

test("single Pi deletion shuts down a running wrapper", async (t) => {
  const { id, path, manager } = await piFixture(t);
  let stopped = false;
  globalThis.__piSessions.set(id, {
    sessionId: id, sessionFile: path, inner: { sessionManager: manager },
    isAlive: () => true, isRunning: () => true,
    shutdown: async () => { stopped = true; },
  });
  assert.deepEqual(await sessions.delete({ id }), { ok: true, value: { ok: true } });
  assert.equal(stopped, true);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("Claude delete uses native admission and clears sidebar state", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-delete-claude-")));
  const nativeId = "123e4567-e89b-42d3-a456-426614174020";
  const id = `claude:${nativeId}`;
  const project = join(nativeHome, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const wrappers = new Map();
  globalThis[key] = { sessions: wrappers, createRequests: new Map(), cleanupInstalled: true };
  t.after(async () => {
    for (const wrapper of wrappers.values()) await wrapper.close();
    globalThis[key] = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  await mkdir(project, { recursive: true });
  const path = join(project, `${nativeId}.jsonl`);
  await writeFile(path, JSON.stringify({
    type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174021", parentUuid: null,
    cwd: dir, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: "fixture" },
  }) + "\n");
  await updateSessionUiState({ action: "set", ids: [id], pinned: true });
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.delete({ id }), { ok: true, value: { ok: true } });
  await assert.rejects(access(path), { code: "ENOENT" });
  assert.equal(readSessionUiState().sessions[id], undefined);
  assert.ok(getSessionListVersion() > version);
  const missing = await remove(id);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "Claude session not found" });
});

test("Claude status-bearing errors retain their response status and message", async (t) => {
  const id = "claude:123e4567-e89b-42d3-a456-426614174022";
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  let status = 404;
  const wrapper = {
    cwd: agentHome, isAlive: () => true, isSideSession: () => false,
    withExclusiveMutation: async () => { throw Object.assign(new Error("Native refusal"), { status }); },
  };
  globalThis[key] = { sessions: new Map([[id, wrapper]]), createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis[key] = previous; });
  for (status of [404, 423]) {
    assert.deepEqual(await sessions.delete({ id }), { ok: false, kind: "claude-error", status, error: "Native refusal" });
    const response = await remove(id);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "Native refusal" });
  }
});

test("disabled Claude delete preserves its refusal", async (t) => {
  const previous = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_CLAUDE;
    else process.env.PI_WEB_CLAUDE = previous;
  });
  const id = "claude:123e4567-e89b-42d3-a456-426614174020";
  assert.deepEqual(await sessions.delete({ id }), { ok: false, kind: "claude-error", status: 409, error: "Claude is disabled" });
  const response = await remove(id);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Claude is disabled" });
});

test("delete rejects malformed, unknown and unsupported identities", async () => {
  for (const [id, expected, body] of [
    ["claude:not-a-uuid", { ok: false, kind: "invalid", reason: "invalid-id" }, { error: "Invalid session id", reason: "invalid-id" }],
    ["future:123", { ok: false, kind: "invalid", reason: "unknown-namespace" }, { error: "Invalid session id", reason: "unknown-namespace" }],
    ["codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a", { ok: false, kind: "unsupported" }, { error: "Codex sessions are not available", reason: "backend-unavailable" }],
  ]) {
    assert.deepEqual(await sessions.delete({ id }), expected);
    const response = await remove(id);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), body);
  }
});
