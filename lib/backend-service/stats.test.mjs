import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-service-stats-"));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentHome;
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  await rm(agentHome, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { POST } = await jiti.import("../../app/api/sessions/stats/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const claude = await jiti.import("../agent-backends/claude.ts");

test("stats reads persisted and live branches without starting sessions and omits failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-service-stats-data-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "go", timestamp: Date.now() });
  const id = manager.getSessionId();
  cacheSessionPath(id, manager.getSessionFile());
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    invalidateSessionPathCache(id);
    await rm(dir, { recursive: true, force: true });
  });
  const beforeClaude = claude.getClaudeRuntimeSnapshot();
  globalThis.__piSessions.set("broken-stats-id", { isAlive: () => { throw new Error("unreadable"); } });
  const persisted = await sessions.stats({ ids: [id, "missing-stats-id", "broken-stats-id"] });
  assert.equal(persisted.ok, true);
  assert.deepEqual(Object.keys(persisted.value.stats), [id]);
  assert.equal(persisted.value.stats[id].tokens.total, 0);
  assert.equal(getRpcSession(id), undefined);
  assert.deepEqual(claude.getClaudeRuntimeSnapshot(), beforeClaude);

  manager.appendModelChange("provider", "selected-model");
  const selectedLeaf = manager.getLeafId();
  globalThis.__piSessions.set(id, { isAlive: () => true, inner: { sessionManager: manager } });
  let result = await sessions.stats({ ids: [id, id] });
  assert.deepEqual(result.value.stats[id].model, { provider: "provider", modelId: "selected-model" });
  const cached = await sessions.stats({ ids: [id] });
  assert.strictEqual(cached.value.stats[id], result.value.stats[id]);
  manager.resetLeaf();
  result = await sessions.stats({ ids: [id] });
  assert.equal(result.value.stats[id].model, null);
  manager.branch(selectedLeaf);
  result = await sessions.stats({ ids: [id] });
  assert.deepEqual(result.value.stats[id].model, { provider: "provider", modelId: "selected-model" });
});

test("stats route sends no-store and preserves Codex refusal", async () => {
  const post = (ids) => POST(new Request("http://localhost/api/sessions/stats", {
    method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
  }));
  const response = await post(["missing-stats-id"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { stats: {} });
  const refusal = await post(["codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a"]);
  assert.equal(refusal.status, 400);
  assert.deepEqual(await refusal.json(), { error: "Codex sessions are not available", reason: "backend-unavailable" });
});

test("stats rejects unknown and unsupported namespaces before reading any session", async () => {
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  const beforeClaude = claude.getClaudeRuntimeSnapshot();
  assert.deepEqual(await sessions.stats({ ids: ["future:123"] }), { ok: false, kind: "invalid", reason: "unknown-namespace" });
  assert.deepEqual(await sessions.stats({ ids: [codex] }), { ok: false, kind: "unsupported" });
  assert.equal(getRpcSession(codex), undefined);
  assert.deepEqual(claude.getClaudeRuntimeSnapshot(), beforeClaude);
});
