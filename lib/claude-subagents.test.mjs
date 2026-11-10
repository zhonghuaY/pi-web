import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { readClaudeSubagents } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./claude-subagents.ts");
const nativeId = "123e4567-e89b-42d3-a456-426614174000";
const parent = "claude:" + nativeId;

test("native child transcript reads are bound to their parent catalogue", async () => {
  const calls = [];
  const api = {
    async getSessionInfo(id) { assert.equal(id, nativeId); return { cwd: "/isolated/project" }; },
    async listSubagents(id, options) { assert.equal(id, nativeId); assert.equal(options.dir, "/isolated/project"); return ["agent-one"]; },
    async getSubagentMessages(...args) {
      calls.push(args);
      return [{ type: "assistant", uuid: nativeId, message: { role: "assistant", model: "native-model", content: [{ type: "text", text: "child result" }] } }];
    },
  };
  assert.deepEqual(await readClaudeSubagents(parent, undefined, api), { parentSessionId: parent, agents: [{ id: "agent-one" }] });
  await assert.rejects(readClaudeSubagents(parent, "../../other-project", api), (error) => error.status === 404);
  assert.equal(calls.length, 0);
  const result = await readClaudeSubagents(parent, "agent-one", api);
  assert.equal(result.readonly, true);
  assert.equal(result.messages[0].content[0].text, "child result");
  assert.deepEqual(calls, [[nativeId, "agent-one", { dir: "/isolated/project" }]]);
});
test("invalid parent ids fail before any native history lookup", async () => {
  const api = { getSessionInfo() { throw new Error("must not be invoked"); } };
  await assert.rejects(readClaudeSubagents("claude:../../secret", undefined, api), /Invalid Claude session id/);
});
