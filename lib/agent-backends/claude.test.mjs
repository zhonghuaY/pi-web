import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const types = await jiti.import("./types.ts");
const projection = await jiti.import("./claude-projection.ts");
const configModule = await jiti.import("./claude-config.ts");
const runtimeModule = await jiti.import("./claude-runtime.ts");
const facade = await jiti.import("./claude.ts");
const wire = await jiti.import("../agent-event-wire.ts");
const streaming = await jiti.import("../streaming-message.ts");
const metadataModule = await jiti.import("./claude-metadata.ts");
const executableModule = await jiti.import("./claude-executable.ts");

const NATIVE_ID = "123e4567-e89b-42d3-a456-426614174000";

class FakeQuery {
  rows = [];
  waiters = [];
  closed = false;
  interrupted = 0;
  model = null;
  permissionMode = null;
  settings = [];

  [Symbol.asyncIterator]() { return this; }

  next() {
    const row = this.rows.shift();
    if (row) return Promise.resolve({ done: false, value: row });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  emit(message) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.rows.push(message);
  }

  async initializationResult() { return {}; }
  async supportedCommands() { return [{ name: "compact", description: "Compact", argumentHint: "", builtin: true }, { name: "compact", description: "Shadowed skill", argumentHint: "" }, { name: "project-review", description: "Run project review", argumentHint: "<scope>" }]; }
  async supportedModels() { return [{ value: "native-model", displayName: "Native", description: "Configured", supportsEffort: true }]; }
  async interrupt() { this.interrupted += 1; return { still_queued: [] }; }
  async setModel(model) { this.model = model; }
  async setPermissionMode(mode) { this.permissionMode = mode; }
  async applyFlagSettings(settings) { this.settings.push(settings); }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
}

function fakeDependencies() {
  const calls = [];
  const queries = [];
  let lockReleases = 0;
  const deps = {
    query(params) {
      calls.push(params);
      const query = new FakeQuery();
      queries.push(query);
      return query;
    },
    async acquireLock() { return async () => { lockReleases += 1; }; },
    async getConfiguration() {
      return {
        available: true,
        model: "settings-model",
        settingSources: [],
        requiresProjectTrust: true,
      };
    },
    executablePath: "/trusted/claude",
    env: {
      PATH: "/bin",
      ANTHROPIC_AUTH_TOKEN: "native-token",
      AWS_PROFILE: "claude-bedrock",
      GITHUB_TOKEN: "unrelated-secret",
      PI_MODEL: "parent-model",
      PI_WEB_PASSWORD: "host-secret",
      PI_SUBAGENT_PARENT_SESSION: "host-session",
      CLAUDECODE: "parent-identity",
      CLAUDE_CODE_ENTRYPOINT: "parent-entrypoint",
    },
    now: () => 1_000,
    idleTimeoutMs: 60_000,
    interruptTimeoutMs: 50,
  };
  return { deps, calls, queries, get lockReleases() { return lockReleases; } };
}

async function eventually(check) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition did not become true");
}

test("Claude web IDs are strict namespaced UUIDs and never paths", () => {
  const webId = types.claudeWebSessionId(NATIVE_ID);
  assert.equal(webId, "claude:" + NATIVE_ID);
  assert.equal(types.isClaudeSessionId(webId), true);
  assert.equal(types.nativeClaudeSessionId(webId), NATIVE_ID);
  assert.equal(types.getSessionBackend(webId), "claude");
  assert.equal(types.getSessionBackend(NATIVE_ID), "pi");
  for (const invalid of ["claude:../settings.json", "claude:not-a-uuid", "claude:" + NATIVE_ID + "/x", NATIVE_ID]) {
    assert.equal(types.isClaudeSessionId(invalid), false);
    assert.throws(() => types.nativeClaudeSessionId(invalid), /Invalid Claude session id/);
  }
});

test("creation requires a stable UUID and coalesces only the same cwd", async () => {
  assert.throws(() => facade.createClaudeSession("/tmp/a"), /requestId must be a UUID/);
  const requestId = randomUuid(20);
  const first = facade.createClaudeSession("/tmp/a", { requestId });
  const retry = facade.createClaudeSession("/tmp/a", { requestId });
  assert.equal(retry, first);
  assert.throws(
    () => facade.createClaudeSession("/tmp/b", { requestId }),
    (error) => error?.status === 409,
  );
  await facade.closeAllClaudeSessions();
});

test("rejected provisional creation is discardable while an explicit dormant session remains recoverable", async (t) => {
  await facade.closeAllClaudeSessions();
  const metadataRoot = await mkdtemp(join(tmpdir(), "pi-web-claude-rejected-"));
  t.after(() => rm(metadataRoot, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = metadataRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const rejectedRequestId = randomUuid(21);
  const rejected = facade.createClaudeSession("/tmp/rejected", { requestId: rejectedRequestId });
  await assert.rejects(
    rejected.send({ type: "prompt", message: "no trust", requestId: randomUuid(22) }),
    (error) => error?.status === 409,
  );
  assert.equal(facade.getClaudeRuntimeSnapshot().sessions.some((row) => row.id === rejected.sessionId), true);
  assert.equal(await facade.discardRejectedClaudeCreation(rejected.sessionId, rejectedRequestId), true);
  assert.equal(facade.getClaudeSession(rejected.sessionId), undefined);

  const dormantRequestId = randomUuid(23);
  const dormant = facade.createClaudeSession("/tmp/dormant", { requestId: dormantRequestId });
  assert.equal(facade.getClaudeSession(dormant.sessionId), dormant);
  assert.equal(dormant.isProvisionalUnaccepted(), true);
  await facade.closeAllClaudeSessions();
});

test("creation request bookkeeping is bounded and evicts only provisional wrappers", async () => {
  await facade.closeAllClaudeSessions();
  for (let index = 0; index < 270; index += 1) {
    facade.createClaudeSession("/tmp/bounded", { requestId: randomUuid(1_000 + index) });
  }
  assert.equal(facade.getClaudeRuntimeSnapshot().sessions.length, 256);
  await facade.closeAllClaudeSessions();
});

test("native history projection keeps UUID fork points and splits tool results from user text", () => {
  const assistant = projection.projectClaudeHistoryMessage({
    type: "assistant",
    uuid: NATIVE_ID,
    session_id: NATIVE_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "assistant",
      model: "claude-native",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "inspect" },
        { type: "text", text: "Checking" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
      ],
    },
  });
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].entryId, NATIVE_ID);
  assert.deepEqual(assistant[0].message.content.map((block) => block.type), ["thinking", "text", "toolCall"]);
  assert.equal(assistant[0].message.provider, "claude");

  const envelope = projection.projectClaudeHistoryMessage({
    type: "user",
    uuid: "223e4567-e89b-42d3-a456-426614174000",
    session_id: NATIVE_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "file body", is_error: false },
        { type: "text", text: "continue" },
      ],
    },
  });
  assert.deepEqual(envelope.map((entry) => entry.message.role), ["user", "toolResult"]);
  assert.deepEqual(envelope.map((entry) => entry.entryId), [
    "223e4567-e89b-42d3-a456-426614174000",
    "223e4567-e89b-42d3-a456-426614174000",
  ]);
  assert.equal(envelope[1].message.toolCallId, "tool-1");
});

test("configuration uses the native resolver and returns only the frozen safe summary", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-claude-config-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".claude"));
  const projectSettings = join(cwd, ".claude", "settings.json");
  await writeFile(projectSettings, JSON.stringify({ model: "native-model" }));
  let calls = 0;
  const resolver = async (options) => {
    calls += 1;
    assert.deepEqual(options, { cwd, settingSources: ["user", "project", "local"] });
    return {
      effective: {
        model: "native-model",
        env: { SECRET: "must-not-leak" },
        permissions: { defaultMode: "bypassPermissions" },
      },
      provenance: {},
      sources: [{ source: "project", path: projectSettings, settings: { model: "native-model" } }],
    };
  };
  const summary = await configModule.readClaudeConfiguration(cwd, resolver);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(summary).sort(), ["available", "model", "requiresProjectTrust", "resources", "settingSources"]);
  assert.equal(summary.model, "native-model");
  assert.equal(summary.requiresProjectTrust, true);
  assert.equal(summary.settingSources.find((source) => source.scope === "project").exists, true);
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
  assert.equal(JSON.stringify(summary).includes("bypassPermissions"), false);
  const unavailable = await configModule.readClaudeConfiguration(cwd, async () => {
    throw new Error("parse failed near ANTHROPIC_API_KEY=secret-value");
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "Claude settings could not be loaded");
  assert.equal(JSON.stringify(unavailable).includes("secret-value"), false);
});

test("dormant reads and SSE subscription do not create a Query", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true }, fake.deps);
  const events = [];
  const unsubscribe = wrapper.onEvent((event) => events.push(event));
  const state = await wrapper.send({ type: "get_state" });
  const tools = await wrapper.send({ type: "get_tools" });
  const commands = await wrapper.send({ type: "get_commands" });
  const models = await wrapper.send({ type: "get_models" });
  const config = await wrapper.send({ type: "get_config" });
  assert.equal(fake.calls.length, 0);
  assert.equal(state.lifecycle, "dormant");
  assert.equal(state.requiresProjectTrust, true);
  assert.equal(wrapper.getInfo().capabilities.setModel, true);
  assert.equal(wrapper.getInfo().capabilities.sideChat, true);
  assert.deepEqual(tools, { tools: [], available: false, reason: "session-not-started" });
  assert.deepEqual(commands, { commands: [], available: false, reason: "project-trust-required" });
  assert.equal(models.complete, false);
  assert.equal(models.effectiveModel, "settings-model");
  assert.equal(config.model, "settings-model");
  assert.deepEqual(events, []);
  unsubscribe();
  await wrapper.close();
});

test("trusted discovery starts no model run, returns native commands and models, and applies live choices", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true, trustProject: true }, fake.deps);
  const commands = await wrapper.send({ type: "get_commands" });
  const models = await wrapper.send({ type: "get_models" });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(commands.commands, [
    { name: "compact", description: "Compact", argumentHint: "", source: "extension" },
    { name: "project-review", description: "Run project review", argumentHint: "<scope>", source: "skill" },
  ]);
  assert.equal(models.complete, true);
  assert.deepEqual(models.models[0].supportedEffortLevels, undefined);
  assert.deepEqual(await wrapper.send({ type: "set_model", modelId: "opus" }), { provider: "claude", id: "opus" });
  assert.equal(fake.queries[0].model, "opus");
  assert.deepEqual(await wrapper.send({ type: "set_effort", effort: "high" }), { effort: "high" });
  assert.deepEqual(fake.queries[0].settings, [{ effortLevel: "high" }]);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  fake.queries[0].emit({ type: "system", subtype: "commands_changed", commands: [{ name: "new-skill", description: "Shadowed", argumentHint: "" }, { name: "new-skill", description: "New", argumentHint: "", builtin: true }], uuid: randomUuid(8), session_id: NATIVE_ID });
  await eventually(() => events.some((event) => event.type === "claude_commands_changed"));
  assert.deepEqual(events.find((event) => event.type === "claude_commands_changed").commands, [
    { name: "new-skill", description: "New", argumentHint: "", source: "extension" },
  ]);
  await wrapper.send({ type: "prompt", message: "/project-review src", requestId: randomUuid(58) });
  const input = await fake.calls[0].prompt[Symbol.asyncIterator]().next();
  assert.equal(input.value.message.content[0].text, "/project-review src");
  await wrapper.close();
});

test("first prompt requires trust and starts one native query without a model override", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: false }, fake.deps);
  const requestId = randomUuid(10);
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hello", requestId }),
    (error) => error instanceof runtimeModule.ClaudeConflictError && error.status === 409,
  );
  assert.equal(fake.calls.length, 0);

  const accepted = await wrapper.send({ type: "prompt", message: "hello", trustProject: true, requestId });
  const duplicate = await wrapper.send({ type: "prompt", message: "ignored", trustProject: true, requestId });
  assert.deepEqual(duplicate, accepted);
  assert.equal(fake.calls.length, 1);
  const options = fake.calls[0].options;
  assert.equal("model" in options, false);
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal(options.cwd, "/tmp/project");
  assert.equal(options.pathToClaudeCodeExecutable, "/trusted/claude");
  assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, "native-token");
  assert.equal(options.env.AWS_PROFILE, "claude-bedrock");
  assert.equal("GITHUB_TOKEN" in options.env, false);
  assert.equal("PI_MODEL" in options.env, false);
  assert.equal("PI_WEB_PASSWORD" in options.env, false);
  assert.equal("PI_SUBAGENT_PARENT_SESSION" in options.env, false);
  assert.equal("CLAUDECODE" in options.env, false);
  assert.equal("CLAUDE_CODE_ENTRYPOINT" in options.env, false);
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });

  const input = await fake.calls[0].prompt[Symbol.asyncIterator]().next();
  assert.equal(input.value.message.content[0].text, "hello");
  await wrapper.close();
  assert.equal(fake.lockReleases, 1);
});

test("creation model and effort become native startup options", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(9), "/tmp/project", { existing: false, trustProject: true, modelId: "opus", effort: "xhigh" }, fake.deps);
  await wrapper.send({ type: "ensure_session", trustProject: true });
  assert.equal(fake.calls[0].options.model, "opus");
  assert.equal(fake.calls[0].options.effort, "xhigh");
  await wrapper.close();
});

test("stream projection replaces partial output with one final message and reports native lifecycle", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true, trustProject: true }, fake.deps);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.send({ type: "prompt", message: "run", requestId: randomUuid(11) });
  const query = fake.queries[0];
  query.emit({
    type: "system", subtype: "init", uuid: randomUuid(1), session_id: NATIVE_ID,
    apiKeySource: "none", claude_code_version: "2.1.318", cwd: "/tmp/project", tools: ["Read"], mcp_servers: [],
    model: "native-model", permissionMode: "default", slash_commands: ["compact"], output_style: "default", skills: [], plugins: [],
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(2), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "message_start", message: { id: "msg-1", model: "native-model" } },
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(3), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(4), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第一句。" } },
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(5), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\n\n" } },
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(6), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第二段。" } },
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(7), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "content_block_stop", index: 0 },
  });
  query.emit({
    type: "stream_event", uuid: randomUuid(5), session_id: NATIVE_ID, parent_tool_use_id: null,
    event: { type: "message_stop" },
  });
  query.emit({
    type: "assistant", uuid: randomUuid(5), session_id: NATIVE_ID, parent_tool_use_id: null,
    message: { id: "msg-1", role: "assistant", model: "native-model", content: [{ type: "text", text: "第一句。\n\n第二段。" }], stop_reason: "end_turn", usage: {} },
  });
  query.emit(resultMessage());
  await eventually(() => events.some((event) => event.type === "agent_settled"));
  const finals = events.filter((event) => event.type === "message_end");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].message.content[0].text, "第一句。\n\n第二段。");
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
  let streamState = streaming.INITIAL_STREAMING_STATE;
  let rendered = null;
  const renderedTextDeltas = [];
  for (const event of events) {
    const client = wire.toClientAgentEvent(event);
    if (!client) continue;
    if (client.type === "agent_start") streamState = streaming.streamReducer(streamState, { type: "start" });
    if (client.type === "message_start" && client.message?.role === "assistant") {
      streamState = streaming.streamReducer(streamState, { type: "snapshot", message: client.message });
    }
    if (client.type === "message_update") {
      streamState = streaming.streamReducer(streamState, { type: "delta", event: client.assistantMessageEvent });
      rendered = streamState.streamingMessage;
      if (client.assistantMessageEvent.type === "text_delta") renderedTextDeltas.push(rendered.content[0].text);
    }
  }
  assert.deepEqual(renderedTextDeltas, ["第一句。", "第一句。\n\n", "第一句。\n\n第二段。"]);
  assert.equal(rendered.content[0].text, "第一句。\n\n第二段。");
  assert.equal(events.filter((event) => event.type === "message_start").length, 1);
  assert.equal(events.filter((event) => event.type === "message_update").length, 5);
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.lifecycle, "idle");
  assert.deepEqual(state.model, { provider: "claude", id: "native-model" });
  assert.equal(state.usageScope, "latest-result-metrics-with-cumulative-query-or-resumed-session-usage");
  assert.equal(state.latestResultUsage.cumulativeTotalCostUsd, 0.01);
  query.emit({ type: "system", subtype: "session_state_changed", state: "idle", uuid: randomUuid(7), session_id: NATIVE_ID });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  await wrapper.close();
});

test("interaction requests replay, answer once, and reject a late second tab with 409", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true, trustProject: true }, fake.deps);
  const firstEvents = [];
  wrapper.onEvent((event) => firstEvents.push(event));
  await wrapper.send({ type: "prompt", message: "ask", requestId: randomUuid(12) });
  const canUseTool = fake.calls[0].options.canUseTool;
  const controller = new AbortController();
  const pending = canUseTool("AskUserQuestion", {
    questions: [{ question: "Choose", header: "Choice", multiSelect: false, options: [{ label: "A", description: "first" }] }],
  }, {
    signal: controller.signal,
    requestId: "interaction-1",
    toolUseID: "tool-1",
  });
  await eventually(() => firstEvents.some((event) => event.type === "agent_interaction_request"));
  const request = firstEvents.find((event) => event.type === "agent_interaction_request");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0].id, request.id);
  assert.equal(replay[0].kind, "question");

  assert.deepEqual(await wrapper.send({ type: "answer_interaction", id: request.id, answers: { Choose: "A" } }), { accepted: true });
  const result = await pending;
  assert.equal(result.behavior, "allow");
  assert.deepEqual(result.updatedInput.answers, { Choose: "A" });
  await assert.rejects(
    wrapper.send({ type: "answer_interaction", id: request.id, answers: { Choose: "A" } }),
    (error) => error instanceof runtimeModule.ClaudeConflictError && error.status === 409,
  );
  assert.equal(firstEvents.filter((event) => event.type === "agent_interaction_closed").length, 1);
  await wrapper.close();
});

test("idle expiry closes the native query and releases its writer lock", async () => {
  const fake = fakeDependencies();
  fake.deps.idleTimeoutMs = 5;
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true, trustProject: true }, fake.deps);
  await wrapper.send({ type: "ensure_session", trustProject: true });
  await eventually(() => fake.queries[0].closed && fake.lockReleases === 1);
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.lifecycle, "dormant");
  assert.equal(wrapper.isAlive(), true);
  await wrapper.close();
});

test("accepted native next-turn input stays active across idle expiry until its echo and result", async () => {
  const fake = fakeDependencies();
  fake.deps.idleTimeoutMs = 5;
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true, trustProject: true }, fake.deps);
  await wrapper.send({ type: "prompt", message: "first", requestId: randomUuid(13) });
  await assert.rejects(wrapper.send({ type: "steer", message: "no" }), /does not support Pi steer semantics/);
  const queued = await wrapper.send({ type: "follow_up", message: "second", requestId: randomUuid(14) });
  assert.equal(queued.queued, true);
  const iterator = fake.calls[0].prompt[Symbol.asyncIterator]();
  const first = await iterator.next();
  const second = await iterator.next();
  assert.equal(first.value.priority, "now");
  assert.equal(second.value.priority, "next");
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  fake.queries[0].emit(resultMessage());
  await eventually(() => events.some((event) => event.type === "prompt_done"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.lifecycle, "running");
  assert.equal(wrapper.isRunning(), true);
  assert.equal(wrapper.isStreaming, true);
  assert.equal(events.some((event) => event.type === "agent_settled"), false);
  assert.deepEqual(state.queuedMessages.followUp, ["second"]);
  fake.queries[0].emit({ type: "user", uuid: second.value.uuid, session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: "user", content: "second" } });
  await eventually(() => events.some((event) => event.type === "queue_update" && event.followUp.length === 0));
  assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages.followUp, []);
  fake.queries[0].emit(resultMessage());
  await eventually(() => events.some((event) => event.type === "agent_settled"));
  assert.equal(wrapper.isRunning(), false);
  await wrapper.close();
});

test("side sessions persist their parent and enforce a zero-tool policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-claude-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "metadata.json");
  const sideId = randomUuid(30);
  const operationId = await metadataModule.beginClaudeSideFork("claude:" + NATIVE_ID, "/tmp/project", [NATIVE_ID], path);
  const pendingMetadata = await metadataModule.readClaudeWebMetadata(path);
  assert.equal(metadataModule.claudeSidePolicy(sideId, "/tmp/project", pendingMetadata).policy, "side-read-only");
  assert.equal(metadataModule.claudeSidePolicy(NATIVE_ID, "/tmp/project", pendingMetadata), undefined);
  await metadataModule.completeClaudeSideFork(operationId, sideId, path);
  const metadata = await metadataModule.readClaudeWebMetadata(path);
  assert.deepEqual(metadata.pendingSideForks, {});
  assert.deepEqual(metadata.sessions[sideId], {
    parentSessionId: "claude:" + NATIVE_ID,
    policy: "side-read-only",
    createdAt: metadata.sessions[sideId].createdAt,
  });

  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(sideId, "/tmp/project", {
    existing: true,
    side: true,
    trustProject: true,
  }, fake.deps);
  await wrapper.send({ type: "ensure_session", trustProject: true });
  const options = fake.calls[0].options;
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.permissionMode, "plan");
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.equal(options.forwardSubagentText, false);
  assert.equal(options.settings.disableAllHooks, true);
  const denied = await options.canUseTool("Bash", { command: "touch /tmp/no" }, {
    signal: new AbortController().signal,
    requestId: "side-deny",
    toolUseID: "side-tool",
  });
  assert.equal(denied.behavior, "deny");
  await assert.rejects(
    wrapper.send({ type: "set_permission_mode", mode: "default" }),
    (error) => error?.status === 409,
  );
  await assert.rejects(
    wrapper.send({ type: "set_model", model: "other" }),
    (error) => error?.status === 409,
  );
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "/permissions", requestId: randomUuid(40) }),
    (error) => error?.status === 409,
  );
  await wrapper.close();
  await metadataModule.deleteClaudeWebMetadata(sideId, path);
  assert.deepEqual((await metadataModule.readClaudeWebMetadata(path)).sessions, {});
  await writeFile(path, JSON.stringify({ version: 1, sessions: { [sideId]: { policy: "side-read-only" } } }));
  await assert.rejects(metadataModule.readClaudeWebMetadata(path), /metadata could not be loaded/);
});

test("persisted side policy rejects an already-created unrestricted wrapper", async (t) => {
  await facade.closeAllClaudeSessions();
  const root = await mkdtemp(join(tmpdir(), "pi-web-claude-policy-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const wrapper = facade.createClaudeSession("/tmp/project", { requestId: randomUuid(54) });
  const operationId = await metadataModule.beginClaudeSideFork("claude:" + NATIVE_ID, wrapper.cwd, []);
  await metadataModule.completeClaudeSideFork(operationId, wrapper.nativeSessionId);
  await assert.rejects(
    facade.ensureClaudeSession(wrapper.sessionId),
    (error) => error?.status === 409,
  );
  await metadataModule.deleteClaudeWebMetadata(wrapper.nativeSessionId);
  await facade.closeAllClaudeSessions();
});

test("concurrent startup coalesces, synchronous query failure releases, and idle restart resumes", async () => {
  const fake = fakeDependencies();
  let unlockAcquire;
  let lockAcquires = 0;
  fake.deps.acquireLock = async () => {
    lockAcquires += 1;
    await new Promise((resolve) => { unlockAcquire = resolve; });
    return async () => {};
  };
  const wrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(31), "/tmp/project", {
    existing: false,
    trustProject: true,
  }, fake.deps);
  const first = wrapper.send({ type: "prompt", message: "one", requestId: randomUuid(32) });
  const second = wrapper.send({ type: "follow_up", message: "two", requestId: randomUuid(33) });
  await eventually(() => lockAcquires === 1);
  unlockAcquire();
  await Promise.all([first, second]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.sessionId, randomUuid(31));
  assert.equal("resume" in fake.calls[0].options, false);
  await wrapper.close();

  const failed = fakeDependencies();
  failed.deps.query = () => { throw new Error("secret query failure"); };
  const broken = new runtimeModule.ClaudeSessionWrapper(randomUuid(34), "/tmp/project", {
    existing: false,
    trustProject: true,
  }, failed.deps);
  await assert.rejects(broken.send({ type: "ensure_session", trustProject: true }), /could not be started/);
  assert.equal(failed.lockReleases, 1);
  assert.equal((await broken.send({ type: "get_state" })).lifecycle, "dormant");
  await broken.close();

  const restarting = fakeDependencies();
  restarting.deps.idleTimeoutMs = 5;
  const restartId = randomUuid(35);
  const restart = new runtimeModule.ClaudeSessionWrapper(restartId, "/tmp/project", {
    existing: false,
    trustProject: true,
  }, restarting.deps);
  await restart.send({ type: "ensure_session", trustProject: true });
  await eventually(() => restarting.queries[0].closed);
  await restart.send({ type: "ensure_session", trustProject: true });
  assert.equal(restarting.calls.length, 2);
  assert.equal(restarting.calls[1].options.resume, restartId);
  assert.equal("sessionId" in restarting.calls[1].options, false);
  await restart.close();
});

test("stop and close cancel startup while the writer lock is still pending", async () => {
  const stoppedFake = fakeDependencies();
  let releaseStopLock;
  let stopLockEntered = false;
  stoppedFake.deps.acquireLock = async () => {
    stopLockEntered = true;
    await new Promise((resolve) => { releaseStopLock = resolve; });
    return async () => {};
  };
  const stoppedWrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(46), "/tmp/project", {
    existing: false,
    trustProject: true,
  }, stoppedFake.deps);
  const stoppedPrompt = stoppedWrapper.send({ type: "prompt", message: "must not run", requestId: randomUuid(47) });
  const stoppedRejection = assert.rejects(stoppedPrompt, (error) => error?.status === 409);
  await eventually(() => stopLockEntered);
  const stopping = stoppedWrapper.send({ type: "stop" });
  releaseStopLock();
  assert.deepEqual(await stopping, { stopped: true, cancelledStartup: true, stillQueued: [] });
  await stoppedRejection;
  assert.equal(stoppedFake.calls.length, 0);
  assert.equal((await stoppedWrapper.send({ type: "get_state" })).lifecycle, "dormant");
  await stoppedWrapper.close();

  const closedFake = fakeDependencies();
  let releaseCloseLock;
  let closeLockEntered = false;
  closedFake.deps.acquireLock = async () => {
    closeLockEntered = true;
    await new Promise((resolve) => { releaseCloseLock = resolve; });
    return async () => {};
  };
  const closedWrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(48), "/tmp/project", {
    existing: false,
    trustProject: true,
  }, closedFake.deps);
  const closedPrompt = closedWrapper.send({ type: "prompt", message: "must not revive", requestId: randomUuid(49) });
  const closedRejection = assert.rejects(closedPrompt, (error) => error?.status === 409);
  await eventually(() => closeLockEntered);
  const closing = closedWrapper.close();
  releaseCloseLock();
  await closing;
  await closedRejection;
  assert.equal(closedFake.calls.length, 0);
  assert.equal(closedWrapper.isAlive(), false);
});

test("result settles the turn without a public idle frame while background tasks keep the runtime alive", async () => {
  const fake = fakeDependencies();
  fake.deps.idleTimeoutMs = 5;
  const wrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(50), "/tmp/project", {
    existing: true,
    trustProject: true,
  }, fake.deps);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.send({ type: "prompt", message: "background", requestId: randomUuid(51) });
  fake.queries[0].emit({
    type: "system", subtype: "background_tasks_changed", uuid: randomUuid(52), session_id: NATIVE_ID,
    tasks: [{ task_id: "bg-1", ambient: false }],
  });
  fake.queries[0].emit(resultMessage());
  await eventually(() => events.some((event) => event.type === "agent_settled"));
  const settled = await wrapper.send({ type: "get_state" });
  assert.equal(settled.lifecycle, "idle");
  assert.equal(settled.subagentsActive, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fake.queries[0].closed, false);
  fake.queries[0].emit({
    type: "system", subtype: "background_tasks_changed", uuid: randomUuid(53), session_id: NATIVE_ID,
    tasks: [],
  });
  await eventually(() => fake.queries[0].closed);
  await wrapper.close();
});

test("disabled runtime keeps reads dormant and executable resolution uses explicit or PATH executables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-claude-executable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === "win32" ? "claude.exe" : "claude");
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o700);
  assert.equal(await executableModule.resolveClaudeExecutable({ PATH: root }), binary);
  assert.equal(await executableModule.resolveClaudeExecutable({ PI_WEB_CLAUDE_EXECUTABLE: binary, PATH: "" }), binary);
  await assert.rejects(
    executableModule.resolveClaudeExecutable({ PI_WEB_CLAUDE_EXECUTABLE: "relative/claude", PATH: root }),
    /executable absolute path/,
  );

  const previous = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_CLAUDE;
    else process.env.PI_WEB_CLAUDE = previous;
  });
  assert.throws(
    () => facade.createClaudeSession("/tmp/project", { requestId: randomUuid(41) }),
    (error) => error?.status === 409,
  );
  const fake = fakeDependencies();
  fake.deps.env.PI_WEB_CLAUDE = "0";
  const wrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(42), "/tmp/project", {
    existing: true,
    trustProject: true,
  }, fake.deps);
  assert.equal((await wrapper.send({ type: "get_state" })).lifecycle, "dormant");
  assert.equal((await wrapper.send({ type: "get_config" })).available, true);
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "blocked", requestId: randomUuid(43) }),
    (error) => error?.status === 409,
  );
  assert.equal(fake.calls.length, 0);
  await wrapper.close();
});

test("exclusive metadata mutation blocks prompt startup without a time-of-check race", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(44), "/tmp/project", {
    existing: true,
    trustProject: true,
  }, fake.deps);
  let finish;
  const mutation = wrapper.withExclusiveMutation(() => new Promise((resolve) => { finish = resolve; }));
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "racing", requestId: randomUuid(45) }),
    (error) => error?.status === 409,
  );
  assert.equal(fake.calls.length, 0);
  finish();
  await mutation;
  await wrapper.close();
});

test("unexpected query exit settles pending callbacks and bounded stop closes a stuck query", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(36), "/tmp/project", {
    existing: true,
    trustProject: true,
  }, fake.deps);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.send({ type: "prompt", message: "ask", requestId: randomUuid(37) });
  const controller = new AbortController();
  controller.abort();
  const alreadyAborted = await fake.calls[0].options.canUseTool("Read", {}, {
    signal: controller.signal,
    requestId: "aborted",
    toolUseID: "tool-aborted",
  });
  assert.equal(alreadyAborted.behavior, "deny");
  const pending = fake.calls[0].options.canUseTool("Read", {}, {
    signal: new AbortController().signal,
    requestId: "pending",
    toolUseID: "tool-pending",
  });
  fake.queries[0].close();
  assert.equal((await pending).behavior, "deny");
  await eventually(() => events.some((event) => event.type === "agent_interaction_closed" && event.reason === "session_closed"));
  await wrapper.close();

  const stuck = fakeDependencies();
  stuck.deps.interruptTimeoutMs = 5;
  const stuckWrapper = new runtimeModule.ClaudeSessionWrapper(randomUuid(38), "/tmp/project", {
    existing: true,
    trustProject: true,
  }, stuck.deps);
  await stuckWrapper.send({ type: "prompt", message: "run", requestId: randomUuid(39) });
  stuck.queries[0].interrupt = () => new Promise(() => {});
  const stopped = await stuckWrapper.send({ type: "stop" });
  assert.equal(stopped.forced, true);
  assert.equal(stuck.queries[0].closed, true);
  await stuckWrapper.close();
});

function randomUuid(index) {
  return "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
}

test("native API error results are not announced as successful completion", async () => {
  const fake = fakeDependencies();
  const wrapper = new runtimeModule.ClaudeSessionWrapper(NATIVE_ID, "/tmp/project", { existing: true, trustProject: true }, fake.deps);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  try {
    await wrapper.send({ type: "prompt", message: "one", requestId: randomUuid(99) });
    fake.queries[0].emit({ ...resultMessage(), is_error: true, result: "API Error: invalid image" });
    await eventually(() => events.some((event) => event.type === "agent_settled"));
    assert.equal(events.find((event) => event.type === "prompt_done").aborted, true);
    assert.equal(events.find((event) => event.type === "agent_settled").aborted, true);
    assert.equal(wrapper.isRunning(), false);
  } finally { await wrapper.close(); }
});

function resultMessage() {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUuid(6),
    session_id: NATIVE_ID,
  };
}
