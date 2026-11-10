import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-service-rename-"));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentHome;
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  await rm(agentHome, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { PATCH } = await jiti.import("../../app/api/sessions/[id]/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache, openSessionManager, getSessionListVersion } = await jiti.import("../session-reader.ts");
const claude = await jiti.import("../agent-backends/claude.ts");
const patch = (id, name) => PATCH(new Request("http://localhost/api/test", {
  method: "PATCH", body: JSON.stringify({ name }),
}), { params: Promise.resolve({ id }) });

test("rename updates the Pi disk and live wrapper and invalidates cached reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-rename-data-"));
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
  const cached = openSessionManager(path);
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.rename({ id, name: "  Disk title  " }), { ok: true, value: { ok: true } });
  assert.equal(SessionManager.open(path).getSessionName(), "Disk title");
  assert.notStrictEqual(openSessionManager(path), cached);
  assert.equal(openSessionManager(path).getSessionName(), "Disk title");
  assert.ok(getSessionListVersion() > version);
  let liveName;
  globalThis.__piSessions.set(id, { isAlive: () => true, inner: { setSessionName: (name) => { liveName = name; } } });
  const before = await readFile(path, "utf8");
  const liveVersion = getSessionListVersion();
  assert.deepEqual(await sessions.rename({ id, name: " Live title " }), { ok: true, value: { ok: true } });
  assert.equal(liveName, "Live title");
  assert.equal(await readFile(path, "utf8"), before);
  assert.ok(getSessionListVersion() > liveVersion);
  globalThis.__piSessions.clear();
  assert.deepEqual(await sessions.rename({ id, name: "" }), { ok: true, value: { ok: true } });
  assert.equal(SessionManager.open(path).getSessionName(), undefined);
  assert.deepEqual(await sessions.rename({ id: "missing-rename-test", name: "Name" }), { ok: false, kind: "not-found" });
  assert.equal((await patch("missing-rename-test", "Name")).status, 404);
});

test("rename uses Claude's existing runtime admission and native mutation", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-rename-claude-")));
  const nativeId = "123e4567-e89b-42d3-a456-426614174010";
  const id = `claude:${nativeId}`;
  const project = join(nativeHome, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const wrappers = new Map();
  globalThis[key] = { sessions: wrappers, createRequests: new Map(), cleanupInstalled: true };
  t.after(async () => {
    const wrapper = wrappers.get(id);
    if (wrapper) await wrapper.close();
    globalThis[key] = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  await mkdir(project, { recursive: true });
  const path = join(project, `${nativeId}.jsonl`);
  await writeFile(path, JSON.stringify({
    type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null,
    cwd: dir, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: "fixture" },
  }) + "\n");
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.rename({ id, name: "  Claude title  " }), { ok: true, value: { ok: true } });
  assert.equal(wrappers.size, 1);
  assert.ok(getSessionListVersion() > version);
  assert.match(await readFile(path, "utf8"), /Claude title/u);
  const wrapper = wrappers.get(id);
  assert.deepEqual(await sessions.rename({ id, name: "Second title" }), { ok: true, value: { ok: true } });
  assert.strictEqual(wrappers.get(id), wrapper);
  assert.match(await readFile(path, "utf8"), /Second title/u);
  assert.deepEqual(await sessions.rename({ id, name: "   " }), { ok: false, kind: "empty-name" });
  const response = await patch(id, " ");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Name is required" });
  assert.deepEqual(await sessions.rename({ id: "claude:123e4567-e89b-42d3-a456-426614174012", name: "Missing" }).then((result) => [result.ok, result.kind, result.backend]), [false, "error", "claude"]);
});

test("disabled Claude rename keeps its refusal ahead of empty-name validation", async (t) => {
  const previous = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_CLAUDE;
    else process.env.PI_WEB_CLAUDE = previous;
  });
  const id = "claude:123e4567-e89b-42d3-a456-426614174010";
  assert.deepEqual(await sessions.rename({ id, name: "" }), { ok: false, kind: "disabled" });
  const response = await patch(id, "");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Claude is disabled" });
});

test("rename rejects invalid and unsupported identities before dispatch", async () => {
  const before = claude.getClaudeRuntimeSnapshot();
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  assert.deepEqual(await sessions.rename({ id: "future:123", name: "Title" }), { ok: false, kind: "invalid", reason: "unknown-namespace" });
  assert.deepEqual(await sessions.rename({ id: codex, name: "Title" }), { ok: false, kind: "unsupported" });
  assert.deepEqual(claude.getClaudeRuntimeSnapshot(), before);
  const response = await patch(codex, "Title");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Codex sessions are not available", reason: "backend-unavailable" });
});
