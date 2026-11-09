import assert from "node:assert/strict";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-service-fork-"));
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
const { cacheSessionPath, getSessionListVersion, invalidateSessionPathCache, resolveSessionPath } = await jiti.import("../session-reader.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-fork-data-"));
  const manager = SessionManager.create(dir, dir);
  const root = manager.appendMessage({ role: "user", content: "Fork me", timestamp: Date.now() });
  const first = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first" }], timestamp: Date.now() });
  manager.branch(root);
  const second = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: Date.now() });
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
  return { id, path, manager, first, second };
}

function texts(path) {
  return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse)
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => entry.message.content[0].text);
}

function wrapper(source, running) {
  return {
    sessionFile: source.path, isAlive: () => true, isRunning: () => running,
    inner: { sessionManager: { getLeafId: () => source.first, getEntry: (id) => source.manager.getEntry(id) } },
    send: () => { throw new Error("runtime command"); },
    shutdown: () => { throw new Error("runtime shutdown"); },
  };
}

test("disk fork returns its row and does not start a runtime", async (t) => {
  const source = await fixture(t);
  const version = getSessionListVersion();
  const result = await sessions.fork({ id: source.id, side: false, sideName: "ignored" });
  assert.equal(result.ok, true);
  const { sessionId, session } = result.value;
  t.after(() => invalidateSessionPathCache(sessionId));
  assert.notEqual(sessionId, source.id);
  assert.equal(session.id, sessionId);
  assert.equal(session.parentSessionId, source.id);
  assert.deepEqual(session.relation, { kind: "fork", originSessionId: source.id });
  assert.match(session.name, /^Fork me · [0-9a-f]{4}$/);
  assert.deepEqual(texts(session.path), ["second"]);
  assert.equal(globalThis.__piSessions.size, 0);
  assert.ok(getSessionListVersion() > version);
});

test("side chats preserve default and provided names and their relation", async (t) => {
  const source = await fixture(t);
  for (const [sideName, expected] of [[undefined, "Side chat"], ["Selected text", "Selected text"]]) {
    const result = await sessions.fork({ id: source.id, side: true, sideName });
    assert.equal(result.ok, true);
    const { sessionId, session } = result.value;
    t.after(() => invalidateSessionPathCache(sessionId));
    assert.equal(session.name, expected);
    assert.equal(session.parentSessionId, source.id);
    assert.deepEqual(session.relation, { kind: "side", parentSessionId: source.id });
    assert.deepEqual(texts(session.path), ["second"]);
  }
  assert.equal(globalThis.__piSessions.size, 0);
});

test("missing source invalidates the catalogue", async (t) => {
  await fixture(t);
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.fork({ id: "missing-session", side: false }), {
    ok: false, kind: "refusal", code: "not_found", error: "Session not found",
  });
  assert.ok(getSessionListVersion() > version);
});

test("source deleted behind its cached path is forgotten", async (t) => {
  const source = await fixture(t);
  unlinkSync(source.path);
  const version = getSessionListVersion();
  assert.deepEqual(await sessions.fork({ id: source.id, side: false }), {
    ok: false, kind: "refusal", code: "not_found", error: "Session not found",
  });
  assert.equal(await resolveSessionPath(source.id), null);
  assert.ok(getSessionListVersion() > version);
});

test("live leaf wins unless a foreign append moved an idle wrapper behind disk", async (t) => {
  const source = await fixture(t);
  globalThis.__piSessions.set(source.id, wrapper(source, true));
  const live = await sessions.fork({ id: source.id, side: false });
  assert.equal(live.ok, true);
  t.after(() => invalidateSessionPathCache(live.value.sessionId));
  assert.deepEqual(texts(live.value.session.path), ["first"]);
  appendFileSync(source.path, `${JSON.stringify({ type: "session_info", id: "ext00001", parentId: source.second, timestamp: new Date().toISOString(), name: "External" })}\n`);
  const idle = wrapper(source, false);
  globalThis.__piSessions.set(source.id, idle);
  const disk = await sessions.fork({ id: source.id, side: false });
  assert.equal(disk.ok, true);
  t.after(() => invalidateSessionPathCache(disk.value.sessionId));
  assert.deepEqual(texts(disk.value.session.path), ["second"]);
  assert.match(disk.value.session.name, /^External · [0-9a-f]{4}$/);
  assert.equal(globalThis.__piSessions.get(source.id), idle);
});
