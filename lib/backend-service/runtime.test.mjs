import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isolateClaudeHome } from "../claude-test-home.mjs";

await isolateClaudeHome();
const home = await mkdtemp(join(tmpdir(), "pi-web-runtime-test-"));
process.env.PI_CODING_AGENT_DIR = home;
const cwd = join(home, "project");
await mkdir(cwd);
await writeFile(join(home, "settings.json"), "{}");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const { listAgentEventStreams } = await jiti.import("../agent-event-stream.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { buildSessionHandoff } = await jiti.import("../session-handoff.ts");
const { withHandoffRecord } = await jiti.import("../session-handoff-store.ts");
const { GET: bashRoute } = await jiti.import("../../app/api/agent/[id]/bash-output/route.ts");

test.after(async () => { await rm(home, { recursive: true, force: true }); });

test("concurrent fresh sessions get distinct ids and dispatch commands", async (t) => {
  const results = await Promise.all(Array.from({ length: 3 }, () => sessions.createRuntime({ cwd, type: "ensure_session", toolNames: [] })));
  const ids = results.map((result) => result.body.sessionId);
  t.after(async () => { await Promise.all(ids.map((id) => getRpcSession(id)?.shutdown())); });
  assert.equal(new Set(ids).size, 3);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.data, null);
    const command = await sessions.commandRuntime(result.body.sessionId, { type: "get_state" });
    assert.equal(command.status, 200);
    assert.equal(command.body.success, true);
  }
  const fresh = await sessions.createRuntime({ cwd, type: "get_state", toolNames: [] });
  t.after(async () => { await getRpcSession(fresh.body.sessionId)?.shutdown(); });
  assert.equal(typeof fresh.body.data, "object");
});

test("prompt commands are sent once to an existing Pi runtime", async () => {
  const id = "runtime-prompt-test";
  const previous = globalThis.__piSessions;
  const sent = [];
  globalThis.__piSessions = new Map([[id, { isAlive: () => true, send: async (command) => { sent.push(command); return { accepted: true }; } }]]);
  try {
    const command = { type: "prompt", message: "test prompt" };
    assert.deepEqual(await sessions.commandRuntime(id, command), { status: 200, body: { success: true, data: { accepted: true } } });
    assert.deepEqual(sent, [command]);
  } finally { globalThis.__piSessions = previous; }
});

test("Claude admission and command use native results", async (t) => {
  const oldEnabled = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "1";
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const id = "claude:123e4567-e89b-42d3-a456-426614174010";
  const sent = [];
  globalThis[key] = { sessions: new Map([[id, { cwd, isAlive: () => true, isSideSession: () => false, isStreaming: false, streamingMessage: null, onEvent: () => () => {}, send: async (command) => { sent.push(command); return "native"; } }]]), createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis[key] = previous; if (oldEnabled === undefined) delete process.env.PI_WEB_CLAUDE; else process.env.PI_WEB_CLAUDE = oldEnabled; });
  const admission = await sessions.createRuntime({ backend: "claude", cwd, type: "ensure_session" });
  assert.equal(admission.status, 400);
  assert.equal(admission.body.error, "A stable requestId UUID is required");
  const refused = await sessions.createRuntime({ backend: "claude", cwd, type: "prompt", message: "do not run", requestId: randomUUID() });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /trust/i);
  const draft = await sessions.createRuntime({ backend: "claude", cwd, type: "ensure_session", requestId: randomUUID() });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.data, null);
  assert.equal(draft.body.state.lifecycle, "dormant");
  assert.deepEqual(await sessions.commandRuntime(id, { type: "get_state" }), { status: 200, body: { success: true, data: "native" } });
  assert.deepEqual(sent, [{ type: "get_state" }]);
  const controller = new AbortController();
  const meta = { holder: "page-claude", address: "192.0.2.2", client: "Safari · iOS" };
  const events = await sessions.runtimeEvents(id, controller.signal, meta);
  assert.equal(events.kind, "stream");
  const info = listAgentEventStreams().find((entry) => entry.sessionId === id);
  assert.deepEqual({ holder: info.holder, address: info.address, client: info.client }, meta);
  controller.abort();
  await events.stream.cancel();
});

test("events return a live stream and stop on abort", async () => {
  const id = "runtime-events-test";
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[id, { isAlive: () => true, isStreaming: false, streamingMessage: null, onEvent: () => () => {} }]]);
  const controller = new AbortController();
  try {
    const meta = { holder: "page-1", address: "192.0.2.1", client: "Chrome · macOS" };
    const result = await sessions.runtimeEvents(id, controller.signal, meta);
    assert.equal(result.kind, "stream");
    assert.ok(result.stream instanceof ReadableStream);
    const info = listAgentEventStreams().find((entry) => entry.sessionId === id);
    assert.deepEqual({ holder: info.holder, address: info.address, client: info.client }, meta);
    controller.abort();
    await result.stream.cancel();
    assert.equal((await sessions.runtimeEvents(id, controller.signal, meta)).kind, "aborted");
  } finally { globalThis.__piSessions = previous; }
});

test("handoff reports durable retry receipts and typed admission and storage errors", async (t) => {
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "Source context", timestamp: 1 });
  const source = manager.getSessionId();
  const tip = manager.getLeafId();
  cacheSessionPath(source, manager.getSessionFile());
  t.after(() => invalidateSessionPathCache(source));
  const requestId = randomUUID();
  const request = { targetBackend: "claude", requestId, trustProject: true };
  const built = buildSessionHandoff({ requestId, sourceSessionId: source, sourceBackend: "pi", sourceEntryId: tip,
    sourceTitle: "Source context", targetBackend: "claude", messages: [{ role: "user", content: "Source context", timestamp: 1 }] });
  const session = { id: `claude:${randomUUID()}`, path: "target", cwd, created: "2026-01-01", modified: "2026-01-01", messageCount: 1,
    firstMessage: built.title, backend: "claude", relation: built.relation };
  const transfer = { sourceSessionId: source, sourceEntryId: tip, transferredMessages: 4, omittedMessages: 2, truncated: true };
  await withHandoffRecord(requestId, async (_record, save) => save({ version: 1, requestId, sourceSessionId: source, targetBackend: "claude",
    sourceEntryId: tip, envelopeDigest: createHash("sha256").update(built.prompt).digest("hex"), transfer, stage: "complete", target: session }));
  assert.deepEqual(await sessions.handoff(source, request), { ok: true, value: { session, transfer } });
  assert.deepEqual(await sessions.handoff(source, { ...request, targetBackend: "codex" }), {
    ok: false, status: 409, message: "Codex sessions are not available", reason: "backend-unavailable",
  });
  assert.deepEqual(await sessions.handoff(source, { ...request, targetBackend: "pi" }), {
    ok: false, status: 400, message: "Target backend must be different from the source backend",
  });
  await writeFile(join(home, "pi-web-handoffs", requestId, "record.json"), "invalid json");
  const corrupted = await sessions.handoff(source, request);
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.status, 500);
});

test("auto-name applies generated titles and refuses closed or missing sessions", async (t) => {
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "Name this conversation", timestamp: Date.now() });
  const id = manager.getSessionId();
  cacheSessionPath(id, manager.getSessionFile());
  const previous = globalThis.__piSessions;
  let alive = true;
  let title;
  let ready = 0;
  const wrapper = {
    isAlive: () => alive,
    waitUntilReady: async () => { ready++; },
    inner: {
      setSessionName: (value) => { title = value; },
      agent: {
        state: { systemPrompt: "system", model: { provider: "test", id: "test-model" }, thinkingLevel: "off", tools: [], messages: [{ role: "user", content: "Name this conversation", timestamp: 1 }] },
        convertToLlm: (messages) => messages,
        streamFunction: () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Useful Title" }], api: "test", provider: "test", model: "test-model", stopReason: "stop", timestamp: Date.now() } }));
          return stream;
        },
      },
    },
  };
  globalThis.__piSessions = new Map([[id, wrapper]]);
  t.after(() => { globalThis.__piSessions = previous; invalidateSessionPathCache(id); });
  assert.deepEqual(await sessions.autoName(id), { status: 200, body: { title: "Useful Title", usage: null } });
  assert.equal(title, "Useful Title");
  assert.equal(ready, 1);
  wrapper.inner.agent.streamFunction = () => {
    alive = false;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Other Title" }], api: "test", provider: "test", model: "test-model", stopReason: "stop", timestamp: Date.now() } }));
    return stream;
  };
  assert.deepEqual(await sessions.autoName(id), { status: 409, body: { error: "The session was closed while its title was being generated. Please try again." } });
  assert.equal(title, "Useful Title");
  assert.deepEqual(await sessions.autoName(randomUUID()), { status: 404, body: { error: "Session not found" } });
});

test("Claude fork uses the runtime and preserves native errors", async (t) => {
  const oldEnabled = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "1";
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  const id = "claude:123e4567-e89b-42d3-a456-426614174010";
  let mutations = 0;
  globalThis[key] = { sessions: new Map([[id, { cwd, isAlive: () => true, isSideSession: () => false, withExclusiveMutation: async () => { mutations++; throw Object.assign(new Error("fork refused"), { status: 423 }); } }]]), createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis[key] = previous; if (oldEnabled === undefined) delete process.env.PI_WEB_CLAUDE; else process.env.PI_WEB_CLAUDE = oldEnabled; });
  assert.deepEqual(await sessions.fork({ id, side: false, body: { entryId: "invalid" } }), { kind: "native", status: 400, body: { error: "Invalid Claude fork entry id" } });
  assert.equal(mutations, 0);
  assert.deepEqual(await sessions.fork({ id, side: false, body: { entryId: randomUUID() } }), { kind: "native", status: 423, body: { error: "fork refused" } });
  assert.equal(mutations, 1);
});

test("bash output preserves authorization, size and missing-file responses", async (t) => {
  const file = join(tmpdir(), `pi-bash-${randomUUID()}.log`);
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bash-session-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  manager.appendMessage({ role: "bashExecution", command: "test", output: "", fullOutputPath: file, timestamp: Date.now() });
  const id = manager.getSessionId();
  cacheSessionPath(id, manager.getSessionFile());
  t.after(async () => { invalidateSessionPathCache(id); await rm(file, { force: true }); await rm(dir, { recursive: true, force: true }); });
  const get = (sessionId, path = file, download = false) => bashRoute(new Request(`http://localhost/bash-output?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`), { params: Promise.resolve({ id: sessionId }) });
  assert.equal((await get("future:123")).status, 400);
  assert.equal((await (await get("codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a")).json()).reason, "backend-unavailable");
  assert.equal((await get("claude:123e4567-e89b-42d3-a456-426614174010")).status, 403);
  assert.equal((await get(id, "/not-allowed")).status, 400);
  assert.equal((await get(randomUUID())).status, 403);
  assert.equal((await get(id)).status, 404);
  await writeFile(file, "output");
  assert.equal((await (await get(id)).json()).data.output, "output");
  const download = await get(id, file, true);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(await download.text(), "output");
  await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.equal((await get(id)).status, 413);
});
