import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { projectItem } = await jiti.import("@/lib/agent-backends/codex/history");

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const thread = { modelProvider: "fixture", model: "model" };
const activity = (item, completed = false) => ({ ...projectItem(item, thread), completed });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], provider: "fixture", model: "model" });
const snapshot = items => ({ type: "connected", isStreaming: true, turnSnapshot: { turnId: "turn1", items } });

let nextSession = 1;
async function setup({ backend = "codex", history = [] } = {}) {
  const suffix = String(nextSession++).padStart(12, "0");
  const id = backend === "codex" ? `codex:019c1bed-f24e-7f5f-a7f2-${suffix}` : `${backend}-session-${suffix}`;
  const encoded = encodeURIComponent(id);
  let entries = history;
  const sources = [];
  globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window ??= new EventTarget();
  globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame ??= clearTimeout;
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
  };
  globalThis.fetch = async url => {
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url.startsWith(`/api/sessions/${encoded}?`)) return json({
      sessionId: id, filePath: "", totalActiveMs: 0, tree: [], leafId: null,
      context: { messages: entries.map(entry => entry.message), entryIds: entries.map(entry => entry.id), oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "native", model: null },
    });
    if (url === `/api/sessions/${encoded}/state`) return json({ running: true, state: { backend, isStreaming: true, isPromptRunning: true } });
    if (url.startsWith(`/api/agent/${encoded}/lease`)) return json({ success: true, running: true, awaitingInput: false, subagentsActive: false });
    if (url.startsWith(`/api/agent/${encoded}`)) return json({ running: true, state: { backend, isStreaming: true, isPromptRunning: true } });
    return json({});
  };
  const hook = renderHook(useAgentSession, { session: { id, backend, name: "S", cwd: "/tmp" }, t: key => key });
  await settle();
  hook.flush();
  const stream = () => sources.find(source => source.readyState !== 2);
  assert.ok(stream(), "event stream opened");
  return {
    hook,
    setHistory(next) { entries = next; },
    async emit(...events) { for (const event of events) stream().emit(event); await settle(); hook.flush(); },
    async reconnect() {
      const previous = stream();
      previous.onerror?.();
      mock.timers.tick(1_000);
      await settle();
      hook.flush();
      assert.ok(stream());
      assert.notEqual(stream(), previous);
    },
  };
}

test("reconnect restores each projected activity and only unfinished native IDs run", async () => {
  const state = await setup();
  try {
    const items = [
      activity({ type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: "progress" }),
      activity({ type: "fileChange", id: "file", changes: [{ path: "src/a.ts", kind: { type: "update" } }], status: "inProgress" }),
      activity({ type: "mcpToolCall", id: "mcp", server: "docs", tool: "lookup", status: "inProgress", arguments: { secret: "NEVER_EXPOSE" }, result: { content: [{ type: "text", text: "searching" }] } }),
      activity({ type: "dynamicToolCall", id: "dynamic", tool: "inspect", status: "inProgress", arguments: { secret: "NEVER_EXPOSE" }, contentItems: [{ type: "text", text: "working" }] }),
      activity({ type: "commandExecution", id: "done", command: "true", aggregatedOutput: "done", exitCode: 0 }, true),
    ];
    await state.emit(snapshot(items));
    assert.deepEqual(state.hook.result.messages, items.map(item => item.message));
    assert.deepEqual(state.hook.result.messageItemIds, items.map(item => item.id));
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [
      { id: "command", name: "bash" }, { id: "file", name: "fileChange" },
      { id: "mcp", name: "mcpToolCall" }, { id: "dynamic", name: "dynamicToolCall" },
    ] });
    assert.doesNotMatch(JSON.stringify(state.hook.result.messages), /NEVER_EXPOSE/);

    const final = { ...items[0].message, output: "finished", exitCode: 0 };
    await state.emit({ type: "message_end", entryId: "command", message: final }, { type: "tool_execution_end", toolCallId: "command", toolName: "bash" });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [
      { id: "file", name: "fileChange" }, { id: "mcp", name: "mcpToolCall" }, { id: "dynamic", name: "dynamicToolCall" },
    ] });
  } finally { state.hook.unmount(); }
});

test("a broken stream reconnects to the missed command snapshot and later completion", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let state;
  try {
    state = await setup();
    const old = activity({ type: "commandExecution", id: "old", command: "true", aggregatedOutput: "started" });
    await state.emit(snapshot([old]));
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "old", name: "bash" }] });
    await state.reconnect();
    const oldFinished = { ...old.message, output: "finished while disconnected", exitCode: 0 };
    const running = activity({ type: "commandExecution", id: "missed", command: "sleep 600", aggregatedOutput: "in progress" });
    await state.emit(snapshot([{ id: "old", message: oldFinished, completed: true }, running]));
    assert.deepEqual(state.hook.result.messages, [oldFinished, running.message]);
    assert.deepEqual(state.hook.result.messageItemIds, ["old", "missed"]);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "missed", name: "bash" }] });
    const finished = { ...running.message, output: "done", exitCode: 0 };
    await state.emit({ type: "message_end", entryId: "missed", message: finished }, { type: "tool_execution_end", toolCallId: "missed", toolName: "bash" });
    assert.deepEqual(state.hook.result.messages, [oldFinished, finished]);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
  } finally {
    state?.hook.unmount();
    mock.timers.reset();
  }
});

test("completion and history reconcile the restored item by native ID without duplication", async () => {
  const state = await setup();
  try {
    const running = activity({ type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: "partial" });
    const finished = { ...running.message, output: "complete", exitCode: 0 };
    await state.emit(snapshot([running]));
    assert.deepEqual(state.hook.result.messageItemIds, ["command"]);
    assert.equal(state.hook.result.agentPhase?.kind, "running_tools");
    await state.emit({ type: "message_end", entryId: "command", message: finished }, { type: "tool_execution_end", toolCallId: "command", toolName: "bash" });
    assert.deepEqual(state.hook.result.messages, [finished]);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
    await state.emit(snapshot([{ id: "command", message: finished, completed: true }]));
    assert.deepEqual(state.hook.result.messages, [finished]);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
    state.setHistory([{ id: "command", message: finished }]);
    await state.emit({ type: "agent_end" });
    assert.deepEqual(state.hook.result.entryIds, ["command"]);
    assert.deepEqual(state.hook.result.messageItemIds, ["command"]);
    await state.emit(snapshot([{ id: "command", message: { ...finished, output: "older snapshot" }, completed: true }]));
    assert.deepEqual(state.hook.result.messages, [finished]);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
    await state.emit({ type: "message_end", entryId: "command", message: finished });
    assert.deepEqual(state.hook.result.messages, [finished]);
    assert.deepEqual(state.hook.result.messageItemIds, ["command"]);
  } finally { state.hook.unmount(); }
});

test("a running snapshot refreshes activity already present in loaded history", async () => {
  const old = activity({ type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: "old" });
  const current = activity({ type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: "new output" });
  const state = await setup({ history: [old] });
  try {
    await state.emit(snapshot([current]));
    assert.deepEqual(state.hook.result.messages, [current.message]);
    assert.deepEqual(state.hook.result.messageItemIds, ["command"]);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "command", name: "bash" }] });
  } finally { state.hook.unmount(); }
});

test("finishing one native activity leaves other live activities running", async () => {
  const state = await setup();
  try {
    const bash = { role: "bashExecution", command: "sleep", output: "" };
    const mcp = { role: "custom", customType: "mcpToolCall", content: "", display: true };
    await state.emit(snapshot([]),
      { type: "message_end", entryId: "bash", message: bash },
      { type: "tool_execution_start", toolCallId: "bash", toolName: "bash" },
      { type: "message_end", entryId: "mcp", message: mcp },
      { type: "tool_execution_start", toolCallId: "mcp", toolName: "mcpToolCall" });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [
      { id: "bash", name: "bash" }, { id: "mcp", name: "mcpToolCall" },
    ] });
    await state.emit({ type: "message_end", entryId: "bash", message: { ...bash, exitCode: 0 } },
      { type: "tool_execution_end", toolCallId: "bash", toolName: "bash" });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "mcp", name: "mcpToolCall" }] });
  } finally { state.hook.unmount(); }
});

test("assistant chunks continue from the selected snapshot", async () => {
  const state = await setup();
  try {
    const item = { id: "answer", message: assistant("hello"), completed: false };
    await state.emit(snapshot([item]));
    assert.deepEqual(state.hook.result.messageItemIds, ["answer"]);
    assert.equal(state.hook.result.streamingStore.getState().streams.get("answer").content[0].text, "hello");
    await state.emit({ type: "message_update", entryId: "answer", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } });
    assert.equal(state.hook.result.streamingStore.getState().streams.get("answer").content[0].text, "hello!");
  } finally { state.hook.unmount(); }
});

test("Pi and Claude connected snapshots keep their existing assistant-only handling", async () => {
  for (const backend of ["pi", "claude"]) {
    const state = await setup({ backend });
    try {
      const reply = { id: "answer", message: assistant("hello"), completed: false };
      const command = activity({ type: "commandExecution", id: "command", command: "true" });
      await state.emit(snapshot([reply, command]));
      assert.deepEqual(state.hook.result.messages, [reply.message]);
      assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
    } finally { state.hook.unmount(); }
  }
});

test("Pi and Claude message events retain their existing phase and streaming behavior", async () => {
  for (const backend of ["pi", "claude"]) {
    const state = await setup({ backend });
    try {
      await state.emit(snapshot([]), { type: "tool_execution_start", toolCallId: "tool", toolName: "read" });
      await state.emit({ type: "message_end", entryId: "answer", message: assistant("done") });
      assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
      await state.emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "read" },
        { type: "message_start", entryId: "next", message: assistant("hello") });
      assert.equal(state.hook.result.agentPhase, null);
      await state.emit({ type: "message_update", entryId: "next", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } });
      assert.equal(state.hook.result.streamingStore.getState().streams.get("next").content[0].text, "hello!");
    } finally { state.hook.unmount(); }
  }
});

test("correction: loaded running activity takes the completed reconnect snapshot", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let state;
  try {
    const command = (output, status, exitCode) => activity({
      type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: output,
      status, ...(exitCode === undefined ? {} : { exitCode }), privateNative: "NEVER_EXPOSE",
    }, status !== "inProgress");
    const loaded = command("old history", "inProgress");
    const running = command("before disconnect and a longer buffered output", "inProgress");
    const finished = command("finished while disconnected", "failed", 7);
    const other = activity({ type: "mcpToolCall", id: "other", server: "docs", tool: "lookup", status: "inProgress" });
    const otherDone = activity({ type: "mcpToolCall", id: "other", server: "docs", tool: "lookup", status: "completed" }, true);
    state = await setup({ history: [loaded] });
    const originalKey = state.hook.result.messageKeys[0];
    await state.emit(snapshot([running]));
    assert.equal(state.hook.result.messages[0].output, running.message.output);
    await state.reconnect();
    await state.emit(snapshot([finished, other]));
    assert.deepEqual(state.hook.result.messages, [finished.message, other.message]);
    assert.deepEqual(state.hook.result.messageItemIds, ["command", "other"]);
    assert.equal(state.hook.result.messageKeys[0], originalKey);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "other", name: "mcpToolCall" }] });
    assert.doesNotMatch(JSON.stringify(state.hook.result.messages), /NEVER_EXPOSE/);
    await state.emit({ type: "message_end", entryId: "other", message: otherDone.message },
      { type: "tool_execution_end", toolCallId: "other", toolName: "mcpToolCall" });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
    state.setHistory([finished, otherDone]);
    await state.emit({ type: "agent_end" });
    assert.deepEqual(state.hook.result.messages, [finished.message, otherDone.message]);
    assert.deepEqual(state.hook.result.entryIds, ["command", "other"]);
    assert.deepEqual(state.hook.result.messageItemIds, ["command", "other"]);
    assert.equal(state.hook.result.messageKeys[0], originalKey);
  } finally { state?.hook.unmount(); mock.timers.reset(); }
});

test("correction: terminal loaded history outranks an older incomplete snapshot", async () => {
  const terminal = activity({ type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: "terminal without exit", status: "failed" }, true);
  const older = activity({ type: "commandExecution", id: "command", command: "sleep 600", aggregatedOutput: "older", status: "inProgress" });
  const other = activity({ type: "mcpToolCall", id: "other", server: "docs", tool: "lookup", status: "inProgress" });
  const state = await setup({ history: [terminal] });
  try {
    const originalKey = state.hook.result.messageKeys[0];
    await state.emit(snapshot([older, other]));
    assert.equal(state.hook.result.messages[0].output, "terminal without exit");
    assert.equal(state.hook.result.messages[0].codexStatus, "failed");
    assert.deepEqual(state.hook.result.messageItemIds, ["command", "other"]);
    assert.equal(state.hook.result.messageKeys[0], originalKey);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "other", name: "mcpToolCall" }] });
    await state.emit(snapshot([{ ...older, completed: true }, other]));
    assert.equal(state.hook.result.messages[0].output, "terminal without exit");
  } finally { state.hook.unmount(); }
});

test("correction: a terminal live activity also outranks an older incomplete snapshot", async () => {
  const finished = activity({ type: "commandExecution", id: "command", command: "true", aggregatedOutput: "final", status: "completed", exitCode: 0 }, true);
  const older = activity({ type: "commandExecution", id: "command", command: "true", aggregatedOutput: "old", status: "inProgress" });
  const other = activity({ type: "fileChange", id: "other", changes: [], status: "inProgress" });
  const state = await setup();
  try {
    await state.emit(snapshot([finished]));
    const originalKey = state.hook.result.messageKeys[0];
    await state.emit(snapshot([older, other]));
    assert.deepEqual(state.hook.result.messages, [finished.message, other.message]);
    assert.deepEqual(state.hook.result.messageItemIds, ["command", "other"]);
    assert.equal(state.hook.result.messageKeys[0], originalKey);
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "other", name: "fileChange" }] });
  } finally { state.hook.unmount(); }
});

test("correction: assistant completion preserves known running native tools", async () => {
  const state = await setup();
  try {
    const command = activity({ type: "commandExecution", id: "command", command: "sleep", status: "inProgress" });
    const other = activity({ type: "mcpToolCall", id: "other", server: "docs", tool: "lookup", status: "inProgress" });
    await state.emit(snapshot([command, other]));
    await state.emit({ type: "message_end", entryId: "answer", message: assistant("partial explanation") });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [
      { id: "command", name: "bash" }, { id: "other", name: "mcpToolCall" },
    ] });
    await state.emit({ type: "tool_execution_end", toolCallId: "command", toolName: "bash" });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "other", name: "mcpToolCall" }] });
    await state.emit({ type: "tool_execution_end", toolCallId: "other", toolName: "mcpToolCall" });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "waiting_model" });
    await state.emit({ type: "agent_settled", aborted: true });
    assert.equal(state.hook.result.agentRunning, true);
    await state.emit({ type: "prompt_done", aborted: true });
    assert.equal(state.hook.result.agentPhase, null);
    assert.equal(state.hook.result.agentRunning, false);
  } finally { state.hook.unmount(); }
});

test("correction: assistant streaming preserves known running native tools", async () => {
  const state = await setup();
  try {
    const running = activity({ type: "commandExecution", id: "command", command: "sleep", status: "inProgress" });
    await state.emit(snapshot([running]));
    await state.emit({ type: "message_start", entryId: "answer", message: assistant("hello") });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "command", name: "bash" }] });
    await state.emit({ type: "message_update", entryId: "answer", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } });
    assert.equal(state.hook.result.streamingStore.getState().streams.get("answer").content[0].text, "hello!");
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "command", name: "bash" }] });
    await state.emit({ type: "message_end", entryId: "answer", message: assistant("hello!") });
    assert.deepEqual(state.hook.result.agentPhase, { kind: "running_tools", tools: [{ id: "command", name: "bash" }] });
  } finally { state.hook.unmount(); }
});
