import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

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
  for (const value of [
    null,
    { targetBackend: "other", requestId },
    { targetBackend: "claude", requestId: "retry-me" },
    { targetBackend: "claude", requestId, trustProject: "yes" },
  ]) assert.equal(parseSessionHandoffRequest(value), null);
});

test("finds one persisted idempotent target and rejects request id reuse", () => {
  assert.equal(resolveExistingHandoffTarget([baseSession], "source-id", "claude", requestId), baseSession);
  assert.equal(resolveExistingHandoffTarget([], "source-id", "claude", requestId), null);
  assert.throws(
    () => resolveExistingHandoffTarget([baseSession], "another-source", "claude", requestId),
    (error) => error instanceof SessionHandoffError && error.status === 409,
  );
});

test("rejects a same-backend handoff before reading or mutating the source", async () => {
  await assert.rejects(
    createSessionHandoff("pi-source", { targetBackend: "pi", requestId, trustProject: false }),
    (error) => error instanceof SessionHandoffError && error.status === 400,
  );
});
