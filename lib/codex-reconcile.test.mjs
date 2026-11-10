import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "./claude-test-home.mjs";

await isolateClaudeHome();
const { reconcileCodexSnapshot, mergeCodexHistory } = await createJiti(import.meta.url).import("./codex-reconcile.ts");
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });
const user = text => ({ role: "user", content: text });

test("reconnect keeps the prompt and history, replaces completed items by id, and retains unmatched live items", () => {
  const ids = new WeakMap(), keys = new WeakMap();
  const prompt = user("prompt"), old = assistant("old"), other = assistant("other"), loaded = assistant("loaded");
  ids.set(old, "one"); ids.set(other, "wrong-id"); keys.set(old, "sticky");
  const replacement = assistant("complete"), active = assistant("partial");
  const result = reconcileCodexSnapshot([loaded, prompt, old, other], ["loaded"], ids, keys, [
    { id: "loaded", message: assistant("old loaded"), completed: true },
    { id: "one", message: replacement, completed: true },
    { id: "active", message: active, completed: false },
  ]);
  assert.deepEqual(result, [loaded, prompt, replacement, other, active]);
  assert.equal(ids.get(active), "active");
  assert.equal(keys.get(replacement), "sticky");
  assert.equal(ids.get(replacement), "one");
});

test("selected native activity status prevents terminal history and live items from regressing", () => {
  const ids = new WeakMap(), keys = new WeakMap();
  const running = { role: "custom", customType: "mcpToolCall", content: "working", display: true, details: { status: "inProgress" } };
  const finished = { ...running, content: "done", details: { status: "completed" } };
  const terminal = { role: "custom", customType: "fileChange", content: "terminal", display: true, details: { status: "failed" } };
  const stale = { ...terminal, content: "stale", details: { status: "inProgress" } };
  const live = { role: "bashExecution", command: "true", output: "done", exitCode: 0, codexStatus: "completed" };
  const staleLive = { role: "bashExecution", command: "true", output: "stale", codexStatus: "inProgress" };
  ids.set(live, "live"); keys.set(live, "sticky-live");
  const result = reconcileCodexSnapshot([running, terminal, live], ["running", "terminal"], ids, keys, [
    { id: "running", message: finished, completed: true },
    { id: "terminal", message: stale, completed: false },
    { id: "live", message: staleLive, completed: false },
  ]);
  assert.deepEqual(result, [finished, terminal, live]);
  assert.equal(ids.get(result[2]), "live");
  assert.equal(keys.get(result[2]), "sticky-live");
});

test("history landing a prefix retains the optimistic prompt or consumes its persisted copy once", () => {
  const ids = new WeakMap();
  const anchor = user("earlier"), prompt = user("prompt"), done = assistant("done"), late = assistant("late");
  ids.set(done, "done"); ids.set(late, "late");
  const previous = { messages: [anchor, prompt, done, late], entryIds: ["anchor"] };
  const partial = { messages: [anchor, user("prompt"), assistant("done")], entryIds: ["anchor", "prompt", "done"] };
  assert.deepEqual(mergeCodexHistory(previous, partial, ids), [...partial.messages, late]);
  const beforePrompt = { messages: [anchor], entryIds: ["anchor"] };
  assert.deepEqual(mergeCodexHistory(previous, beforePrompt, ids), previous.messages);
});
