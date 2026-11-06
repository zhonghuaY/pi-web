import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { handoffSessionFromResponse } = await jiti.import("./useAgentSession.ts");

const target = {
  id: "target-id",
  cwd: "/project",
  path: "/session.jsonl",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:01:00.000Z",
  firstMessage: "Continue in Pi · Source",
  messageCount: 1,
  backend: "pi",
  relation: {
    kind: "handoff",
    sourceSessionId: "claude:123e4567-e89b-42d3-a456-426614174000",
    sourceBackend: "claude",
    sourceEntryId: "tip-id",
    requestId: "123e4567-e89b-42d3-a456-426614174001",
  },
};

test("keeps the server handoff provenance before the target is reloaded", () => {
  assert.deepEqual(handoffSessionFromResponse({ success: true, data: { session: target } })?.relation, target.relation);
});

test("does not trust a malformed handoff relation from the response", () => {
  const parsed = handoffSessionFromResponse({
    success: true,
    data: { session: { ...target, relation: { ...target.relation, sourceBackend: "other" } } },
  });
  assert.equal(parsed?.relation, undefined);
});
