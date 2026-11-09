import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "./claude-test-home.mjs";

await isolateClaudeHome();
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-handoff-server-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCodexEnabled = process.env.PI_WEB_CODEX;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_CODEX = "1";
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousCodexEnabled === undefined) delete process.env.PI_WEB_CODEX;
  else process.env.PI_WEB_CODEX = previousCodexEnabled;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  createSessionHandoff,
  parseSessionHandoffRequest,
  resolveExistingHandoffTarget,
  SessionHandoffError,
} = await jiti.import("./session-handoff-server.ts");

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const baseSession = {
  path: "claude:target",
  id: "claude:123e4567-e89b-42d3-a456-426614174001",
  cwd: "/tmp/project",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Continue in Claude",
  backend: "claude",
  relation: {
    kind: "handoff",
    sourceSessionId: "source-id",
    sourceBackend: "pi",
    sourceEntryId: "tip-7",
    requestId,
  },
};

test("parses the handoff boundary without accepting coercions or unstable ids", () => {
  assert.deepEqual(parseSessionHandoffRequest({ targetBackend: "claude", requestId, trustProject: true }), {
    targetBackend: "claude", requestId, trustProject: true,
  });
  assert.deepEqual(parseSessionHandoffRequest({ targetBackend: "codex", requestId }), {
    targetBackend: "codex", requestId, trustProject: false,
  });
  for (const value of [
    null,
    { targetBackend: "other", requestId },
    { targetBackend: "claude", requestId: "retry-me" },
    { targetBackend: "claude", requestId, trustProject: "yes" },
  ]) assert.equal(parseSessionHandoffRequest(value), null);
});

test("admits every declared Codex edge through the durable coordinator", async () => {
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  const edges = [
    ["pi-source", "codex"],
    ["claude:123e4567-e89b-42d3-a456-426614174001", "codex"],
    [codex, "pi"],
    [codex, "claude"],
  ];
  let sends = 0;
  for (const [index, [sourceSessionId, targetBackend]] of edges.entries()) {
    const operationId = `123e4567-e89b-42d3-a456-${String(index + 10).padStart(12, "0")}`;
    const sourceBackend = sourceSessionId.startsWith("claude:") ? "claude" : sourceSessionId.startsWith("codex:") ? "codex" : "pi";
    const targetId = targetBackend === "codex"
      ? `codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7${index}`
      : targetBackend === "claude" ? `claude:123e4567-e89b-42d3-a456-${String(index + 30).padStart(12, "0")}` : `pi-target-${index}`;
    const result = await createSessionHandoff(sourceSessionId, {
      targetBackend, requestId: operationId, trustProject: targetBackend === "claude",
    }, {
      findExistingTarget: async () => null,
      readSource: async () => ({
        backend: sourceBackend,
        info: { path: sourceSessionId, id: sourceSessionId, cwd: "/tmp", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 1, firstMessage: "Source" },
        leafId: `tip-${index}`,
        messages: [{ role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: `visible-${index}` }] }],
      }),
      createTarget: async (_source, built) => ({
        info: { path: targetId, id: targetId, cwd: "/tmp", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 1, firstMessage: built.title, backend: targetBackend, relation: built.relation },
        send: async () => { sends++; },
      }),
      hasDurablePrompt: async () => true,
    });
    assert.equal(result.session.backend, targetBackend);
    assert.equal(result.session.relation.sourceBackend, sourceBackend);
    assert.equal(result.transfer.sourceEntryId, `tip-${index}`);
  }
  assert.equal(sends, 4);
});

test("finds one persisted idempotent target and rejects request id reuse", () => {
  assert.equal(resolveExistingHandoffTarget([baseSession], "source-id", "claude", requestId), baseSession);
  assert.equal(resolveExistingHandoffTarget([], "source-id", "claude", requestId), null);
  assert.throws(
    () => resolveExistingHandoffTarget([baseSession], "another-source", "claude", requestId),
    (error) => error instanceof SessionHandoffError && error.status === 409,
  );
});

test("invalid source or persisted target namespace receives a typed refusal", async () => {
  await assert.rejects(
    createSessionHandoff("unknown:source", { targetBackend: "pi", requestId, trustProject: false }),
    (error) => error instanceof SessionHandoffError && error.status === 400,
  );
  assert.throws(
    () => resolveExistingHandoffTarget([{ ...baseSession, id: "unknown:target" }], "source-id", "claude", requestId),
    (error) => error instanceof SessionHandoffError && error.status === 400,
  );
});

test("rejects a same-backend handoff before reading or mutating the source", async () => {
  await assert.rejects(
    createSessionHandoff("pi-source", { targetBackend: "pi", requestId, trustProject: false }),
    (error) => error instanceof SessionHandoffError && error.status === 400,
  );
});

test("admits both executable directed edges past graph admission", async () => {
  for (const [sourceSessionId, targetBackend] of [
    ["pi-source", "claude"],
    ["claude:123e4567-e89b-42d3-a456-426614174001", "pi"],
  ]) {
    await assert.rejects(
      createSessionHandoff(sourceSessionId, { targetBackend, requestId, trustProject: false }),
      (error) => !(error instanceof SessionHandoffError && error.status === 400),
    );
  }
});
