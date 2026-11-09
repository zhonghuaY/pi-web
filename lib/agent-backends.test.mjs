import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const {
  answerAgentInteraction,
  canLoadAgentSlashCommands,
  isAgentInteractionRequest,
  mergeAgentBackendScope,
  parseAgentBackends,
  reconcilePendingAgentInteractions,
  requiresClaudeProjectTrust,
  sameAgentCapabilities,
  sessionBackend,
  sessionCapabilities,
  shouldHandleWebSlashCommand,
  StableRequestId,
  upsertPendingAgentInteraction,
} = await createJiti(import.meta.url).import("./agent-backends.ts");

test("historical sessions default to Pi while Claude capabilities fail closed", () => {
  assert.equal(sessionBackend({ id: "session-1" }), "pi");
  assert.equal(sessionCapabilities({ id: "session-1" }).compact, true);
  assert.equal(sessionBackend({}), null);
  assert.equal(sessionBackend({ id: "unknown:123" }), null);
  assert.equal(sessionCapabilities({ id: "unknown:123", capabilities: { compact: true } }).compact, false);
  assert.equal(sessionBackend({ backend: "claude" }), "claude");
  assert.deepEqual(Object.values(sessionCapabilities({ backend: "claude" })), Array(15).fill(false));
});

test("capability equality and creation IDs stay stable across fresh object renders and retries", () => {
  const first = sessionCapabilities({ backend: "claude", capabilities: { fork: true, export: true } });
  const second = sessionCapabilities({ backend: "claude", capabilities: { fork: true, export: true } });
  assert.notEqual(first, second);
  assert.equal(sameAgentCapabilities(first, second), true);
  const backends = parseAgentBackends({ backends: { pi: { available: true } } });
  const current = { backend: "claude", capabilities: first, backends };
  assert.equal(mergeAgentBackendScope(current, { backend: "claude", capabilities: second, backends }), current);
  assert.notEqual(mergeAgentBackendScope(current, { backend: "pi", capabilities: second, backends }), current);

  let creates = 0;
  const id = new StableRequestId(() => `creation-${++creates}`);
  assert.equal(id.get(), "creation-1");
  assert.equal(id.get(), "creation-1");
  assert.equal(creates, 1);
});

test("backend status parser keeps native model/settings and only explicit capabilities", () => {
  const result = parseAgentBackends({ success: true, data: { backends: {
    pi: { available: true },
    claude: {
      available: true,
      model: "claude-opus-native",
      requiresProjectTrust: true,
      settingSources: [{ scope: "user", path: "/home/u/.claude/settings.json", exists: true }],
      resources: { skills: { status: "loaded", count: 3 } },
      capabilities: { fork: true, export: true, followUp: true },
    },
  } } });
  assert.equal(result.claude.available, true);
  assert.equal(result.claude.claude?.model, "claude-opus-native");
  assert.equal(result.claude.claude?.requiresProjectTrust, true);
  assert.deepEqual(result.claude.claude?.settingSources, [{ scope: "user", path: "/home/u/.claude/settings.json", exists: true }]);
  assert.equal(result.claude.capabilities.fork, true);
  assert.equal(result.claude.capabilities.export, true);
  assert.equal(result.claude.capabilities.followUp, true);
  assert.equal(result.claude.capabilities.side, false);
  assert.equal(result.claude.capabilities.compact, false);
});

test("Codex discovery is optional and accepts array and object envelopes", () => {
  assert.equal(parseAgentBackends({}).codex, undefined);
  for (const backends of [{ codex: { available: true, capabilities: { fork: true, rename: false, delete: false } } }, [{ backend: "codex", available: true, capabilities: { fork: true, rename: false, delete: false } }]]) {
    const codex = parseAgentBackends({ backends }).codex;
    assert.equal(codex.available, true);
    assert.equal(codex.capabilities.fork, true);
    assert.equal(codex.capabilities.compact, false);
    assert.equal(codex.capabilities.rename, false);
    assert.equal(codex.capabilities.delete, false);
  }
});

test("existing Claude trust fails closed until runtime or configuration proves trust", () => {
  const unknown = parseAgentBackends({ backends: { claude: { available: true } } });
  assert.equal(unknown.claude.claude?.requiresProjectTrust, undefined);
  assert.equal(requiresClaudeProjectTrust(false, null, unknown.claude.claude?.requiresProjectTrust), true);
  assert.equal(requiresClaudeProjectTrust(false, null, undefined), true);
  assert.equal(requiresClaudeProjectTrust(false, null, true), true);
  assert.equal(requiresClaudeProjectTrust(false, false, true), false);
  assert.equal(requiresClaudeProjectTrust(false, true, false), true);
  assert.equal(requiresClaudeProjectTrust(true, null, false), false);
});

test("Claude command discovery can create a trusted no-prompt session and native collisions stay native", () => {
  assert.equal(canLoadAgentSlashCommands("claude", null), true);
  assert.equal(canLoadAgentSlashCommands("claude", "claude:uuid"), true);
  assert.equal(canLoadAgentSlashCommands("pi", null), true);
  assert.equal(shouldHandleWebSlashCommand("claude", "reload"), false);
  assert.equal(shouldHandleWebSlashCommand("claude", "compact"), false);
  assert.equal(shouldHandleWebSlashCommand("claude", "session"), true);
  assert.equal(shouldHandleWebSlashCommand("claude", "side"), true);
  assert.equal(shouldHandleWebSlashCommand("pi", "reload"), true);
  assert.equal(shouldHandleWebSlashCommand("codex", "compact"), true);
  assert.equal(shouldHandleWebSlashCommand("codex", "clone"), true);
  assert.equal(shouldHandleWebSlashCommand("codex", "name"), false);
  assert.equal(shouldHandleWebSlashCommand("codex", "session"), false);
  assert.equal(shouldHandleWebSlashCommand("codex", "copy"), false);
});

test("interaction request guard accepts only the shared permission/question envelope", () => {
  assert.equal(isAgentInteractionRequest({ type: "agent_interaction_request", id: "p1", kind: "permission", title: "Run tool" }), true);
  assert.equal(isAgentInteractionRequest({ type: "agent_interaction_request", id: "q1", kind: "question", title: "Choose", questions: [] }), true);
  assert.equal(isAgentInteractionRequest({ type: "agent_interaction_request", id: "x", kind: "confirm", title: "Wrong" }), false);
  assert.equal(isAgentInteractionRequest({ type: "agent_interaction_closed", id: "p1" }), false);
});

test("interaction reconnect drops stale dialogs and replay restores still-pending requests", () => {
  const request = { type: "agent_interaction_request", id: "keep", kind: "permission", title: "Keep" };
  const stale = { type: "agent_interaction_request", id: "stale", kind: "question", title: "Stale", submitting: false, error: null };
  const current = upsertPendingAgentInteraction([stale], request);
  assert.deepEqual(current.map((item) => item.id), ["stale", "keep"]);
  assert.deepEqual(reconcilePendingAgentInteractions(current, ["keep"]).map((item) => item.id), ["keep"]);
  const afterEmptySnapshot = reconcilePendingAgentInteractions(current, []);
  assert.deepEqual(afterEmptySnapshot, []);
  assert.deepEqual(upsertPendingAgentInteraction(afterEmptySnapshot, request).map((item) => item.id), ["keep"]);
});

test("interaction answer posts the exact shared command and rejects non-accepted responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await answerAgentInteraction("claude:abc", "q1", { answers: { "Pick one": "A, B" } });
  assert.equal(calls[0].url, "/api/agent/claude%3Aabc");
  assert.deepEqual(JSON.parse(calls[0].init.body), { type: "answer_interaction", id: "q1", answers: { "Pick one": "A, B" } });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "stale request" }), { status: 409, headers: { "content-type": "application/json" } });
  await assert.rejects(() => answerAgentInteraction("claude:abc", "q1", { cancelled: true }), /stale request/);
});
