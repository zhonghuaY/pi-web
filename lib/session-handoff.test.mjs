import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const {
  buildSessionHandoff,
  HANDOFF_CONTEXT_CUSTOM_TYPE,
  parseSessionHandoffMetadata,
  projectSessionHandoffMessage,
  sessionHandoffRelation,
  sessionHandoffTitle,
} = await createJiti(import.meta.url).import("./session-handoff.ts");

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const source = {
  requestId,
  sourceSessionId: "source-id",
  sourceBackend: "pi",
  sourceEntryId: "tip-7",
  sourceTitle: " Fix the parser ",
  targetBackend: "claude",
};

const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: content }], timestamp: 2 });

test("builds a strict, source-labelled prompt and restores its persistent relation", () => {
  const built = buildSessionHandoff({ ...source, messages: [user("question"), assistant("answer")] });
  assert.equal(built.title, "Continue in Claude · Fix the parser");
  assert.match(built.prompt, /^<!-- pi-web-handoff:/);
  assert.match(built.prompt, /\*\*User\*\*\nquestion/);
  assert.match(built.prompt, /\*\*Assistant\*\*\nanswer/);
  assert.doesNotMatch(built.prompt, /private/);
  assert.deepEqual(sessionHandoffRelation(built.prompt), {
    kind: "handoff", sourceSessionId: "source-id", sourceBackend: "pi", sourceEntryId: "tip-7", requestId,
  });
  assert.equal(sessionHandoffTitle(built.prompt, "claude"), built.title);
  assert.equal(parseSessionHandoffMetadata(built.prompt)?.sourceTitle, "Fix the parser");
});

test("projects imported context as a visible custom card instead of a user message", () => {
  const built = buildSessionHandoff({ ...source, messages: [user("question")] });
  const projected = projectSessionHandoffMessage(user(built.prompt));
  assert.equal(projected?.role, "custom");
  assert.equal(projected?.customType, HANDOFF_CONTEXT_CUSTOM_TYPE);
  assert.equal(projected?.display, true);
  assert.match(projected?.content ?? "", /^# Imported context from Pi/);
  assert.equal(projected?.details?.sourceSessionId, "source-id");
});

test("moves only visible conversation and summaries within message and character budgets", () => {
  const built = buildSessionHandoff({
    ...source,
    maxMessages: 2,
    maxCharacters: 256,
    messages: [
      { role: "toolResult", toolCallId: "secret", content: [{ type: "text", text: "sensitive output" }], timestamp: 0 },
      { role: "custom", customType: "compaction", content: "old summary", display: true, timestamp: 0 },
      user("older request"),
      assistant("x".repeat(300)),
      user("latest request"),
    ],
  });
  assert.equal(built.transferredMessages, 1);
  assert.equal(built.truncated, true);
  assert.match(built.prompt, /latest request/);
  assert.doesNotMatch(built.prompt, /sensitive output|secret|private/);
  assert.doesNotMatch(built.prompt, /older request/);
});

test("rejects malformed or forged metadata and empty transferable context", () => {
  assert.equal(parseSessionHandoffMetadata("<!-- pi-web-handoff:%7Bbad -->\ntext"), null);
  assert.equal(parseSessionHandoffMetadata("prefix <!-- pi-web-handoff:%7B%7D -->"), null);
  assert.throws(() => buildSessionHandoff({
    ...source,
    messages: [{ role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "only tool output" }], timestamp: 0 }],
  }), /no transferable visible context/);
});
