import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome, isolatePiHome } from "../claude-test-home.mjs";

await isolateClaudeHome();
await isolatePiHome();
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const claude = await jiti.import("../agent-backends/claude.ts");
const { POST } = await jiti.import("../../app/api/agent/[id]/lease/route.ts");
const idle = { success: true, running: false, awaitingInput: false, subagentsActive: false };

test("lease renews only a live wrapper and reports its activity", async (t) => {
  const previous = globalThis.__piSessions;
  const previousRuns = globalThis.__piSubagentRuns;
  const previousNotifications = globalThis.__piSubagentParentNotifications;
  const previousConsumed = globalThis.__piSubagentConsumedResults;
  globalThis.__piSessions = new Map();
  globalThis.__piSubagentRuns = new Map();
  globalThis.__piSubagentParentNotifications = new Set();
  globalThis.__piSubagentConsumedResults = new Map();
  t.after(() => {
    globalThis.__piSessions = previous;
    globalThis.__piSubagentRuns = previousRuns;
    globalThis.__piSubagentParentNotifications = previousNotifications;
    globalThis.__piSubagentConsumedResults = previousConsumed;
  });
  let renewals = 0;
  let alive = true;
  const id = "lease-test-session";
  globalThis.__piSessions.set(id, {
    isAlive: () => alive,
    renewIdleTimer: () => { renewals += 1; },
    isRunning: () => true,
    isAwaitingInput: () => true,
  });
  globalThis.__piSubagentRuns.set("child", { run: { sessionId: "child", parentSessionId: id } });
  assert.deepEqual(await sessions.lease({ id }), {
    ok: true, value: { success: true, running: true, awaitingInput: true, subagentsActive: true },
  });
  assert.equal(renewals, 1);
  alive = false;
  assert.deepEqual(await sessions.lease({ id }), {
    ok: true, value: { ...idle, subagentsActive: true },
  });
  assert.equal(renewals, 1);
  assert.deepEqual(await sessions.lease({ id: "missing-lease-session" }), { ok: true, value: idle });
  assert.equal(getRpcSession("missing-lease-session"), undefined);
});

test("lease renews a live Claude wrapper and reports its subagents", async (t) => {
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const wrappers = new Map();
  globalThis[key] = { sessions: wrappers, createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis[key] = previous; });
  const id = "claude:123e4567-e89b-42d3-a456-426614174001";
  let renewals = 0;
  wrappers.set(id, {
    isAlive: () => true,
    renewIdleTimer: () => { renewals += 1; },
    isRunning: () => true,
    isAwaitingInput: () => false,
    hasActiveSubagents: () => true,
  });
  assert.deepEqual(await sessions.lease({ id }), {
    ok: true, value: { success: true, running: true, awaitingInput: false, subagentsActive: true },
  });
  assert.equal(renewals, 1);
});

test("lease accepts Codex identities without starting a runtime", async (t) => {
  const beforeClaude = claude.getClaudeRuntimeSnapshot();
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  assert.deepEqual(await sessions.lease({ id: "future:123" }), { ok: false, kind: "invalid", reason: "unknown-namespace" });
  assert.deepEqual(await sessions.lease({ id: codex }), { ok: true, value: idle });
  const registryKey = Symbol.for("pi-web.codex-backend.registry");
  const extrasKey = Symbol.for("pi-web.codex-backend.actor-extras");
  const registry = globalThis[registryKey];
  const extras = globalThis[extrasKey];
  const actor = {
    sessionId: codex,
    cwd: "/tmp/codex-lease",
    state: { kind: "ready", transport: {}, threadId: codex.slice("codex:".length), turn: { kind: "idle" } },
    listeners: new Set(),
  };
  const interactions = new Set();
  registry.actors.set(codex, actor);
  extras.set(actor, { operation: undefined, settingsPending: undefined, interactions });
  t.after(() => registry.actors.delete(codex));
  assert.deepEqual(await sessions.lease({ id: codex }), { ok: true, value: idle });
  actor.state.turn = { kind: "running" };
  interactions.add({ announced: true, requests: new Map([["question", {}]]) });
  assert.deepEqual(await sessions.lease({ id: codex }), {
    ok: true, value: { success: true, running: true, awaitingInput: true, subagentsActive: false },
  });
  assert.deepEqual(await sessions.lease({ id: "claude:123e4567-e89b-42d3-a456-426614174001" }), { ok: true, value: idle });
  assert.equal(getRpcSession(codex), undefined);
  assert.deepEqual(claude.getClaudeRuntimeSnapshot(), beforeClaude);
});

test("lease route preserves success and refusal headers and bodies", async () => {
  const request = new Request("http://localhost/api/agent/test/lease", { method: "POST" });
  const response = await POST(request, { params: Promise.resolve({ id: "missing-lease-session" }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), idle);
  const refusal = await POST(request, { params: Promise.resolve({ id: "future:123" }) });
  assert.equal(refusal.status, 400);
  assert.equal(refusal.headers.get("cache-control"), null);
  assert.deepEqual(await refusal.json(), { error: "Invalid session id", reason: "unknown-namespace" });
});
