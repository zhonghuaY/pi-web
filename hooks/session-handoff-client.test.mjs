import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { handoffSessionFromResponse, createRequestId } = await jiti.import("./useAgentSession.ts");

test("request IDs remain UUID v4 on HTTP without crypto.randomUUID", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
    else delete globalThis.crypto.randomUUID;
  });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  const ids = Array.from({ length: 100 }, () => createRequestId());
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
});

test("HTTP handoff reaches project trust and retains its request ID on retry", async () => {
  const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let handler;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleSessionHandoff") handler = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler);
  const pending = [];
  const context = {
    crypto: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) },
    session: { id: "source" }, sessionIdRef: { current: "source" },
    backendRef: { current: "pi" }, handoffSwitching: false,
    backends: { claude: { available: true } }, handoffRequestRef: { current: null },
    claudeProjectTrustConfirmedRef: { current: false },
    setPendingClaudeTrustSubmission: (value) => pending.push(value),
  };
  context.createRequestId = new Script(`(${createRequestId.toString()})`).runInNewContext(context);
  const callback = new Script(ts.transpileModule(`(${handler.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText).runInNewContext(context);
  callback("claude");
  callback("claude");
  assert.equal(pending.length, 2);
  assert.equal(pending[0].kind, "handoff");
  assert.match(pending[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(pending[1].requestId, pending[0].requestId);
});

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
