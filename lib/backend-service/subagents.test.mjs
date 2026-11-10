import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome, isolatePiHome } from "../claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
await isolatePiHome();
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-service-subagents-")));
test.after(() => rm(root, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { GET } = await jiti.import("../../app/api/sessions/[id]/subagents/route.ts");
const nativeId = "123e4567-e89b-42d3-a456-426614174010";
const id = `claude:${nativeId}`;
const project = join(nativeHome, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
const agentDir = join(project, nativeId, "subagents");
await mkdir(agentDir, { recursive: true });
const timestamp = "2026-01-01T00:00:00.000Z";
await writeFile(join(project, `${nativeId}.jsonl`), JSON.stringify({
  type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null,
  cwd: root, timestamp, isSidechain: false, message: { role: "user", content: "Parent prompt" },
}) + "\n");
await writeFile(join(agentDir, "agent-child.jsonl"), JSON.stringify({
  type: "assistant", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174012", parentUuid: null,
  cwd: root, timestamp, isSidechain: true, message: { role: "assistant", model: "native-model", content: [{ type: "text", text: "Child result" }] },
}) + "\n");
const get = (sessionId, query = "") => GET(new Request(`http://localhost/subagents${query}`), { params: Promise.resolve({ id: sessionId }) });

function noRuntimes(t) {
  const priorPi = globalThis.__piSessions;
  const key = Symbol.for("pi-web.claude-backend.registry");
  const priorClaude = globalThis[key];
  const pi = new Map();
  const claude = new Map();
  globalThis.__piSessions = pi;
  globalThis[key] = { sessions: claude, createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis.__piSessions = priorPi; globalThis[key] = priorClaude; });
  return () => { assert.equal(pi.size, 0); assert.equal(claude.size, 0); };
}

test("lists Claude children and reads a child without starting a runtime", async (t) => {
  const checkRuntimes = noRuntimes(t);
  const list = { parentSessionId: id, agents: [{ id: "child" }] };
  assert.deepEqual(await sessions.subagents({ id }), { ok: true, value: list });
  const listResponse = await get(id);
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listResponse.json(), list);
  const child = await sessions.subagents({ id, agentId: "child" });
  assert.equal(child.ok, true);
  assert.deepEqual(Object.keys(child.value).sort(), ["agentId", "cwd", "entryIds", "messages", "parentSessionId", "readonly"].sort());
  assert.equal(child.value.parentSessionId, id);
  assert.equal(child.value.agentId, "child");
  assert.equal(child.value.cwd, root);
  assert.equal(child.value.readonly, true);
  assert.equal(child.value.messages[0].content[0].text, "Child result");
  assert.equal(child.value.entryIds.length, 1);
  const childResponse = await get(id, "?agentId=child");
  assert.equal(childResponse.status, 200);
  assert.equal(childResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await childResponse.json(), JSON.parse(JSON.stringify(child.value)));
  checkRuntimes();
});

test("missing Claude sessions and children retain both 404 responses", async (t) => {
  const checkRuntimes = noRuntimes(t);
  for (const [sessionId, agentId, message] of [
    ["claude:123e4567-e89b-42d3-a456-426614174019", undefined, "Claude session not found"],
    [id, "missing", "Subagent not found in this session"],
  ]) {
    assert.deepEqual(await sessions.subagents({ id: sessionId, agentId }), { ok: false, kind: "claude-error", status: 404, error: message });
    const response = await get(sessionId, agentId ? `?agentId=${agentId}` : "");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), null);
    assert.equal(await response.text(), JSON.stringify({ error: message }));
  }
  checkRuntimes();
});

test("identity refusals preserve status, exact body and cache headers", async (t) => {
  const checkRuntimes = noRuntimes(t);
  for (const [sessionId, outcome, body] of [
    ["bad/id", { ok: false, kind: "invalid", reason: "invalid-id" }, '{"error":"Invalid session id","reason":"invalid-id"}'],
    ["future:123", { ok: false, kind: "invalid", reason: "unknown-namespace" }, '{"error":"Invalid session id","reason":"unknown-namespace"}'],
    ["pi:123", { ok: false, kind: "invalid", reason: "unknown-namespace" }, '{"error":"Invalid session id","reason":"unknown-namespace"}'],
    ["codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a", { ok: false, kind: "unsupported" }, '{"error":"Codex sessions are not available","reason":"backend-unavailable"}'],
    ["pi-session", { ok: false, kind: "wrong-backend" }, '{"error":"This endpoint reads native Claude subagents"}'],
  ]) {
    assert.deepEqual(await sessions.subagents({ id: sessionId }), outcome);
    const response = await get(sessionId);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), null);
    assert.equal(await response.text(), body);
  }
  checkRuntimes();
});
