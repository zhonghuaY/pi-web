import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";

const root = await mkdtemp(join(process.env.HOME, "service-aggregate-"));
for (const key of ["JITI_ALIAS", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"]) delete process.env[key];
Object.assign(process.env, {
  HOME: root, PI_CODING_AGENT_DIR: join(root, "pi"), CODEX_HOME: join(root, "codex-home"),
  CLAUDE_CONFIG_DIR: join(root, "claude"), PI_WEB_CODEX: "1", PI_WEB_CLAUDE: "1",
  TEST_PROJECT: join(root, "project"), TEST_CTL: join(root, "control"), TEST_LOG: join(root, "native.log"),
});
await Promise.all([process.env.PI_CODING_AGENT_DIR, process.env.TEST_PROJECT, process.env.TEST_CTL].map(path => mkdir(path, { recursive: true })));
const binary = join(root, "codex");
await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const log = method => fs.appendFileSync(process.env.TEST_LOG, method + '\\n');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(0); }
log('app-server');
const id = '019c1bed-f24e-7f5f-a7f2-496c101e4e7a';
const thread = { id, sessionId: id, preview: 'native needle', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: process.env.TEST_PROJECT, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] };
const send = value => console.log(JSON.stringify(value));
const later = (flag, fn) => { const marker = path.join(process.env.TEST_CTL, flag); if (!fs.existsSync(marker)) return fn(); const timer = setInterval(() => { if (!fs.existsSync(marker)) { clearInterval(timer); fn(); } }, 10); };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line); log(q.method || 'response');
  if (!('id' in q) || !q.method) return;
  if (q.method === 'initialize') return send({ id: q.id, result: { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' } });
  if (q.method === 'thread/start') return send({ id: q.id, result: { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: thread.cwd, model: 'test', modelProvider: 'test', sandbox: { type: 'readOnly' } } });
  if (q.method === 'turn/start') { const turn = { id: 'turn-1', status: 'inProgress', items: [] }; send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId: turn.id, itemId: 'item-a', startedAtMs: 1, availableDecisions: ['accept', 'decline', 'cancel'] } }); return send({ id: q.id, result: { turn } }); }
  if (q.method === 'thread/list') return later('hold-list', () => fs.existsSync(path.join(process.env.TEST_CTL, 'fail-list')) ? send({ id: q.id, error: { code: -32603, message: 'unavailable' } }) : send({ id: q.id, result: { data: fs.existsSync(path.join(process.env.TEST_CTL, 'listed')) ? [thread] : [], nextCursor: null } }));
  if (q.method === 'thread/read') return later('hold-read', () => send({ id: q.id, result: { thread } }));
  send({ id: q.id, error: { code: -32601, message: 'unsupported' } });
});
`);
await chmod(binary, 0o700);
process.env.PATH = `${root}:${process.env.PATH}`;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { getCodexSession, shutdownCodexSession } = await jiti.import("../agent-backends/codex.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const piDir = join(process.env.PI_CODING_AGENT_DIR, "sessions", "--fixture--");
await mkdir(piDir, { recursive: true });
const manager = SessionManager.create(process.env.TEST_PROJECT, piDir);
manager.appendMessage({ role: "user", content: "pi needle", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "response" }], timestamp: Date.now() });
const piId = manager.getSessionId();
const claudeId = "claude:123e4567-e89b-42d3-a456-426614174001";
const codexId = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
const claudeInfo = { id: claudeId, backend: "claude", path: "claude-fixture", cwd: process.env.TEST_PROJECT, created: new Date(1).toISOString(), modified: new Date(2).toISOString(), messageCount: 1, firstMessage: "claude fixture" };
const registryKey = Symbol.for("pi-web.claude-backend.registry");
globalThis[registryKey] = { sessions: new Map([[claudeId, { sessionId: claudeId, isAlive: () => true, isRunning: () => true, isAwaitingInput: () => false, hasActiveSubagents: () => false, getInfo: () => claudeInfo }]]), createRequests: new Map(), cleanupInstalled: true };
const count = async method => (await readFile(process.env.TEST_LOG, "utf8").catch(() => "")).split("\n").filter(line => line === method).length;
const waitFor = async predicate => { for (let n = 0; n < 400; n++) { if (await predicate()) return; await delay(20); } throw new Error("fixture did not settle"); };
test.after(async () => { const actor = getCodexSession(codexId); if (actor) await shutdownCodexSession(actor); await rm(root, { recursive: true, force: true }); });

test("live Codex membership and activity appear beside Pi and Claude", async () => {
  const before = await sessions.running();
  const created = await sessions.createRuntime({ backend: "codex", cwd: process.env.TEST_PROJECT, type: "ensure_session", requestId: "123e4567-e89b-42d3-a456-426614174000" });
  assert.equal(created.status, 200);
  const actor = getCodexSession(codexId);
  assert.ok(actor);
  const beforeDisabled = await count("thread/read");
  process.env.PI_WEB_CODEX = "0";
  try {
    assert.equal((await sessions.commandRuntime(codexId, { type: "get_state" })).status, 503);
    assert.equal((await sessions.runtimeEvents(codexId, new AbortController().signal, { holder: null, address: "127.0.0.1", client: "test" })).status, 503);
    assert.equal(await count("thread/read"), beforeDisabled);
  } finally { process.env.PI_WEB_CODEX = "1"; }
  const afterCreate = await sessions.running();
  assert.ok(afterCreate.sessionListVersion > before.sessionListVersion, "actor membership invalidates the list");
  assert.ok(afterCreate.runningSessionIds.includes(claudeId));
  const prompted = await sessions.commandRuntime(codexId, { type: "prompt", message: "hello", requestId: "123e4567-e89b-42d3-a456-426614174001" });
  assert.equal(prompted.status, 200);
  await waitFor(async () => (await sessions.lease({ id: codexId })).value.awaitingInput);
  const list = await sessions.list({ force: true, summary: false });
  const running = await sessions.running();
  for (const id of [piId, claudeId, codexId]) assert.ok(list.sessions.some(row => row.id === id), id);
  assert.equal(list.sessions.filter(row => row.id === codexId).length, 1);
  for (const snapshot of [list, running]) {
    assert.ok(snapshot.runningSessionIds.includes(codexId));
    assert.ok(snapshot.awaitingInputSessionIds.includes(codexId));
    assert.ok(snapshot.runningSessionIds.includes(claudeId));
  }
  await shutdownCodexSession(actor);
  const removed = await sessions.running();
  assert.ok(removed.sessionListVersion > running.sessionListVersion, "actor removal invalidates the list");
  assert.ok(!removed.runningSessionIds.includes(codexId));
});

test("slow catalogue is bounded and concurrent list/search calls share one scan", async () => {
  await writeFile(join(process.env.TEST_CTL, "hold-list"), "");
  const safety = setTimeout(() => void rm(join(process.env.TEST_CTL, "hold-list"), { force: true }), 2200);
  const before = await count("thread/list");
  const processesBefore = await count("app-server");
  const start = performance.now();
  const calls = await Promise.all([
    ...Array.from({ length: 3 }, () => sessions.list({ force: true, summary: false })),
    sessions.search("needle", new AbortController().signal),
  ]);
  const elapsed = performance.now() - start;
  try {
    assert.ok(elapsed < 1300, `unrelated backends waited ${elapsed}ms`);
    await waitFor(async () => (await count("thread/list")) > before);
    assert.equal((await count("thread/list")) - before, 1);
    assert.equal((await count("app-server")) - processesBefore, 1);
    for (const result of calls) assert.match(result.backendErrors?.codex ?? "", /Codex/i);
    for (const result of calls.slice(0, 3)) {
      assert.ok(result.sessions.some(row => row.id === piId));
      assert.ok(result.sessions.some(row => row.id === claudeId));
    }
    assert.ok(calls[3].results.some(result => result.session.id === piId));
  } finally { clearTimeout(safety); await rm(join(process.env.TEST_CTL, "hold-list"), { force: true }); }
  await waitFor(async () => (await sessions.list({ force: false, summary: true })).backendErrors?.codex === undefined);
  assert.ok((await sessions.running()).sessionListVersion > Math.max(...calls.slice(0, 3).map(result => result.sessionListVersion)), "late scan invalidates partial list");
});

test("slow Codex history search is bounded and repeated queries do not spawn overlapping readers", async () => {
  await writeFile(join(process.env.TEST_CTL, "listed"), "");
  let loaded;
  await waitFor(async () => {
    loaded = await sessions.list({ force: true, summary: true });
    return loaded.sessions.some(row => row.id === codexId);
  });
  assert.ok(loaded.sessions.some(row => row.id === codexId));
  await writeFile(join(process.env.TEST_CTL, "hold-read"), "");
  const safety = setTimeout(() => void rm(join(process.env.TEST_CTL, "hold-read"), { force: true }), 2200);
  const before = await count("thread/read");
  const start = performance.now();
  const calls = await Promise.all(["needle", "needle", "other"].map(query => sessions.search(query, new AbortController().signal)));
  const elapsed = performance.now() - start;
  try {
    assert.ok(elapsed < 1300, `Codex search waited ${elapsed}ms`);
    await waitFor(async () => (await count("thread/read")) > before);
    assert.equal((await count("thread/read")) - before, 1);
    for (const result of calls) assert.match(result.backendErrors?.codex ?? "", /Codex/i);
    assert.ok(calls[0].results.some(result => result.session.id === piId));
  } finally { clearTimeout(safety); await rm(join(process.env.TEST_CTL, "hold-read"), { force: true }); }
  await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
  const recovered = await sessions.search("needle", new AbortController().signal);
  assert.equal(recovered.backendErrors?.codex, undefined);
  assert.ok(recovered.results.some(result => result.session.id === codexId));
});

test("handoff deduplication still fails closed on a failed native catalogue", async () => {
  await writeFile(join(process.env.TEST_CTL, "fail-list"), "");
  const before = await count("thread/start");
  try {
    const result = await sessions.handoff(piId, { targetBackend: "codex", requestId: "123e4567-e89b-42d3-a456-426614174009", trustProject: false });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(await count("thread/start"), before);
  } finally { await rm(join(process.env.TEST_CTL, "fail-list"), { force: true }); }
});

test("missing cwd preserves Pi and Codex history while runtime admission blocks resume", async () => {
  await rm(process.env.TEST_PROJECT, { recursive: true, force: true });
  const history = { tail: 50, deferThinking: false, deferToolResultImages: false };
  const pi = await sessions.read(piId, { ...history, force: false, summaryTree: false });
  assert.equal(pi.ok, true);
  assert.ok(pi.value.context.messages.some(message => message.content === "pi needle"));
  const codex = await sessions.read(codexId, { ...history, force: false, summaryTree: false });
  assert.equal(codex.ok, true);
  assert.equal(codex.value.info.cwd, process.env.TEST_PROJECT);
  const before = await count("thread/resume");
  const events = await sessions.runtimeEvents(codexId, new AbortController().signal, { holder: null, address: "127.0.0.1", client: "test" });
  assert.equal(events.kind, "error");
  assert.equal(events.status, 409);
  assert.equal(events.body.reason, "cwd-missing");
  assert.equal(events.body.cwd, process.env.TEST_PROJECT);
  assert.equal(await count("thread/resume"), before);
});
