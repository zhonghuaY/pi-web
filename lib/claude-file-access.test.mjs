import test from "node:test";
import assert from "node:assert/strict";
import { isFilePathReferencedByClaudeMessages, isValidSessionId } from "./session-file-references-core.ts";

test("native session keys cannot carry a filesystem path", () => {
  assert.equal(isValidSessionId("claude:76dd1bed-f24e-4f5f-a7f2-496c101e4e7a"), true);
  for (const id of [null, "claude:../../secret", "claude:/tmp/a", "claude:76dd1bed-f24e-4f5f-a7f2-496c101e4e7a/../a"]) assert.equal(isValidSessionId(id), false);
});
test("Claude file links authorize exact user/assistant references only", () => {
  const messages = [{ role: "assistant", content: [{ type: "text", text: "See /tmp/result.txt:12" }] }];
  assert.equal(isFilePathReferencedByClaudeMessages("/tmp/result.txt", messages), true);
  assert.equal(isFilePathReferencedByClaudeMessages("/tmp/result", messages), false);
  assert.equal(isFilePathReferencedByClaudeMessages("/tmp/result.txt.bak", messages), false);
});
test("native tools report paths but MCP and provider metadata cannot authorize arbitrary files", () => {
  const result = { role: "toolResult", toolName: "Read", content: [{ type: "text", text: "/private/secret.txt" }] };
  assert.equal(isFilePathReferencedByClaudeMessages("/private/secret.txt", [result]), true);
  assert.equal(isFilePathReferencedByClaudeMessages("/private/secret.txt", [{ ...result, toolName: "mcp__server__read" }]), false);
  assert.equal(isFilePathReferencedByClaudeMessages("/private/secret.txt", [{ role: "system", content: "/private/secret.txt" }]), false);
});
