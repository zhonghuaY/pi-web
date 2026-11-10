import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { isolateClaudeHome, isolatePiHome } from '../claude-test-home.mjs';

const originalHome = homedir();
const isolatedHome = await mkdtemp(join(tmpdir(), 'codex-actor-home-'));
process.env.HOME = isolatedHome;
after(() => rm(isolatedHome, { recursive: true, force: true }));
for (const key of ['JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT']) delete process.env[key];
await isolateClaudeHome();
await isolatePiHome();
process.env.PI_WEB_CODEX = '1';
const { createJiti } = await import('jiti');
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const actor = await jiti.import('./codex.ts');
const { commandRuntime, runtimeEvents } = await jiti.import('../backend-service/runtime.ts');
const { projectCodexHistory } = await jiti.import('./codex/history.ts');
const { carryMessageKeys } = await jiti.import('../message-keys.ts');
const { reconcileCodexSnapshot, mergeCodexHistory } = await jiti.import('../codex-reconcile.ts');
const { CodexTransport } = await jiti.import('./codex/internal/transport.ts');
const requestId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const threadId = '01900000-0000-7000-8000-000000000001';
const otherThreadId = '01900000-0000-7000-8000-000000000002';
const initialSignalListeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-actor-'));
  const binary = join(dir, 'codex');
  const log = join(dir, 'requests');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(); }
const id = process.env.TEST_THREAD_ID || '${threadId}';
const thread = { id, sessionId: id, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: process.env.TEST_CWD, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] };
let effective = { model: 'test', modelProvider: 'test', effort: 'low' };
const response = { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: process.env.TEST_CWD, model: 'test', modelProvider: 'test', sandbox: { type: 'readOnly' } };
const send = x => console.log(JSON.stringify(x));
fs.appendFileSync(process.env.TEST_LOG, 'pid:' + process.pid + '\\n');
process.on('SIGUSR1', () => process.exit(17));
let turnCount = 0, activeTurnId, steerCount = 0;
const pendingSteers = [];
process.on('SIGUSR2', () => {
 for (const emit of pendingSteers.splice(0)) emit();
 if (activeTurnId) send({ method: 'turn/completed', params: { threadId: id, turn: { id: activeTurnId, status: 'completed', items: [] } } });
});
readline.createInterface({ input: process.stdin }).on('line', line => {
 const q = JSON.parse(line); fs.appendFileSync(process.env.TEST_LOG, (q.method ?? ('reply:' + q.error?.code)) + '\\n');
 if (!q.method) {
   if (q.id === 'questionRpc' && q.result) { fs.appendFileSync(process.env.TEST_LOG, 'question-answers:' + (q.result.answers.q1?.answers[0] === 'synthetic-secret-19' && q.result.answers.q2?.answers[0] === 'synthetic-response-23') + '\\n'); fs.appendFileSync(process.env.TEST_LOG, 'question-count:' + Object.keys(q.result.answers).length + '\\n'); }
   if (q.id === 'approvalRpc' && q.result) fs.appendFileSync(process.env.TEST_LOG, 'approval-decision:' + q.result.decision + '\\n');
   return;
 }
 if (!('id' in q)) return;
 if (q.method === 'initialize') return send({ id: q.id, result: { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' } });
 if (q.method === 'thread/resume' && process.env.TEST_RESUME_ERROR) return send({ id: q.id, error: { code: -32600, message: 'refused' } });
 if (q.method === 'thread/start' && process.env.TEST_PENDING_CREATE && JSON.parse(fs.readFileSync(process.env.TEST_PENDING_CREATE, 'utf8')).stage !== 'pending') process.exit(1);
 if (q.method === 'model/list') {
   const entries = [{ id: 'display-id', model: 'test', displayName: 'Test', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'max', 'ultra', 'future'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'low' }, { id: 'other-id', model: 'other', displayName: 'Other', description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }], defaultReasoningEffort: 'medium' }];
   if (process.env.TEST_CATALOGUE === 'cycle') return send({ id: q.id, result: { data: entries.slice(0, 1), nextCursor: 'repeat' } });
   if (process.env.TEST_CATALOGUE === 'invalid') entries[0].defaultReasoningEffort = 'absent';
   if (process.env.TEST_CATALOGUE === 'missing') return send({ id: q.id, error: { code: -32601, message: 'unavailable' } });
   return send({ id: q.id, result: { data: q.params.cursor ? entries.slice(1) : entries.slice(0, 1), nextCursor: q.params.cursor ? null : 'second' } });
 }
 if (q.method === 'thread/start' || q.method === 'thread/resume') {
   if (q.params.model) effective = { ...effective, model: q.params.model, effort: q.params.config?.model_reasoning_effort ?? 'low' };
   fs.appendFileSync(process.env.TEST_LOG, 'start-payload:' + JSON.stringify(q.params) + '\\n');
   send({ id: q.id, result: { ...response, model: effective.model, reasoningEffort: effective.effort } });
   if (process.env.TEST_LATE_SETTINGS) setTimeout(() => send({ method: 'thread/settings/updated', params: { threadId: id, threadSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'user', collaborationMode: { mode: 'default', settings: { model: 'other', developer_instructions: null, reasoning_effort: null } }, sandboxPolicy: { type: 'readOnly' }, cwd: process.env.TEST_CWD, modelProvider: 'native-provider', model: 'other', effort: 'medium' } } }), 30);
   return;
 }
 if (q.method === 'thread/settings/update') {
   fs.appendFileSync(process.env.TEST_LOG, 'settings-payload:' + JSON.stringify(q.params) + '\\n');
   if (process.env.TEST_SETTINGS === 'die') return process.exit(1);
   if (process.env.TEST_SETTINGS === 'reject') return send({ id: q.id, error: { code: -32602, message: 'rejected' } });
   const event = { method: 'thread/settings/updated', params: { threadId: process.env.TEST_SETTINGS === 'wrong' ? '01900000-0000-7000-8000-000000000099' : id, threadSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'user', collaborationMode: { mode: 'default', settings: { model: q.params.model, developer_instructions: null, reasoning_effort: null } }, sandboxPolicy: { type: 'readOnly' }, cwd: process.env.TEST_CWD, modelProvider: 'native-provider', model: q.params.model, effort: q.params.effort } } };
   if (process.env.TEST_SETTINGS !== 'missing') send(event);
   return setTimeout(() => send({ id: q.id, result: {} }), 30);
 }
 if (q.method === 'thread/read') return process.env.TEST_READ_ERROR ? send({ id: q.id, error: { code: Number(process.env.TEST_READ_ERROR), message: 'unavailable' } }) : send({ id: q.id, result: { thread } });
 if (q.method === 'turn/steer') {
   if (process.env.TEST_USER_EVENTS) {
     const item = { type: 'userMessage', id: 'steer-' + ++steerCount, clientId: q.params.clientUserMessageId ?? null, content: q.params.input };
     const emitItem = () => {
       send({ method: 'item/started', params: { threadId: id, turnId: q.params.expectedTurnId, item, startedAtMs: 1 } });
       const completed = { method: 'item/completed', params: { threadId: id, turnId: q.params.expectedTurnId, item, completedAtMs: 2 } };
       send(completed); send(completed);
     };
     if (process.env.TEST_FOREIGN_STEER) {
       const foreign = { ...item, id: 'foreign-steer', clientId: 'another-client-message' };
       send({ method: 'item/completed', params: { threadId: id, turnId: q.params.expectedTurnId, item: foreign, completedAtMs: 1 } });
       setTimeout(emitItem, 150);
     } else if (process.env.TEST_DEFER_STEERS) pendingSteers.push(emitItem);
     else emitItem();
   }
   if (process.env.TEST_STEER_MODE === 'lost') return;
   if (process.env.TEST_STEER_MODE === 'die' && !fs.existsSync(process.env.TEST_STEER_MARKER)) { fs.writeFileSync(process.env.TEST_STEER_MARKER, '1'); return process.exit(1); }
   if (process.env.TEST_STEER_MODE === 'reject') return send({ id: q.id, error: { code: -32600, message: 'refused' } });
   return setTimeout(() => send({ id: q.id, result: { turnId: q.params.expectedTurnId } }), 80);
 }
 if (q.method === 'turn/interrupt') {
   send({ id: q.id, result: {} });
   if (process.env.TEST_HOLD && !process.env.TEST_IGNORE_INTERRUPT) {
     const event = { method: 'turn/completed', params: { threadId: id, turn: { id: activeTurnId, status: 'interrupted', items: [] } } };
     send(event); setTimeout(() => send(event), 10);
   }
   return;
 }
 if (q.method === 'turn/start') {
   fs.appendFileSync(process.env.TEST_LOG, 'prompt-payload:' + JSON.stringify(q.params) + '\\n');
   if (process.env.TEST_REJECT_BATCH && q.params.input.length > 1) return send({ id: q.id, error: { code: -32602, message: 'rejected' } });
   if (process.env.TEST_PENDING_PROMPT && JSON.parse(fs.readFileSync(process.env.TEST_PENDING_PROMPT, 'utf8')).stage !== 'pending') process.exit(1);
   if (process.env.TEST_LEGACY) send({ id: 'legacy', method: 'execCommandApproval', params: {} });
   const turn = { id: activeTurnId = 'turn-' + ++turnCount, status: 'inProgress', items: [] };
   if (process.env.TEST_USER_EVENTS) {
     const item = { type: 'userMessage', id: 'user-' + turn.id, clientId: q.params.clientUserMessageId ?? null, content: q.params.input };
     send({ method: 'item/started', params: { threadId: id, turnId: turn.id, item, startedAtMs: 1 } });
     send({ method: 'item/completed', params: { threadId: id, turnId: turn.id, item, completedAtMs: 2 } });
   }
   if (process.env.TEST_QUESTIONS) send({ id: 'questionRpc', method: 'item/tool/requestUserInput', params: { threadId: id, turnId: turn.id, itemId: 'item-q', isBlocking: true, questions: [{ id: 'q1', header: 'h1', question: 'Same?', isSecret: true }, { id: 'q2', header: 'h2', question: 'Same?', isOther: true }] } });
   if (process.env.TEST_APPROVAL) send({ id: 'approvalRpc', method: process.env.TEST_APPROVAL === 'file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId: id, turnId: turn.id, itemId: 'item-a', startedAtMs: 1, command: 'pwd', cwd: process.env.TEST_CWD, reason: 'inspect', privateNative: 'SENTINEL_APPROVAL_RPC', ...(process.env.TEST_APPROVAL === 'omitted' ? {} : process.env.TEST_APPROVAL === 'rich' ? { availableDecisions: ['acceptForSession', 'decline'] } : { availableDecisions: ['accept', 'decline', 'cancel'] }) } });
   if (process.env.TEST_EXIT) { send({ id: q.id, result: { turn } }); return setTimeout(() => process.exit(1), 50); }
   if (process.env.TEST_HOLD) {
     if (process.env.TEST_STREAM_HOLD) send({ method: 'item/agentMessage/delta', params: { threadId: id, turnId: turn.id, itemId: 'item-1', delta: 'Hello' } });
     return setTimeout(() => send({ id: q.id, result: { turn } }), 80);
   }
   if (process.env.TEST_ACTIVITY) {
     const emitItem = (method, item) => send({ method, params: { threadId: id, turnId: turn.id, item, ...(method === 'item/started' ? { startedAtMs: 1 } : { completedAtMs: 2 }) } });
     const command = { type: 'commandExecution', id: 'activity-command', command: 'printf hello', cwd: process.env.TEST_CWD, commandActions: [], status: 'inProgress', aggregatedOutput: 'step one', privateNative: 'SENTINEL_ACTIVITY_RPC' };
     emitItem('item/started', command);
     send({ method: 'item/commandExecution/outputDelta', params: { threadId: id, turnId: turn.id, itemId: command.id, delta: ' and two', privateNative: 'SENTINEL_ACTIVITY_RPC' } });
     emitItem('item/completed', { ...command, status: 'completed', aggregatedOutput: 'final output', exitCode: 0 });
     emitItem('item/completed', { ...command, status: 'completed', aggregatedOutput: 'final output', exitCode: 0 });
     const file = { type: 'fileChange', id: 'activity-file', status: 'inProgress', changes: [{ path: 'src/a.ts', diff: '+hello', kind: { type: 'update' }, hidden: 'SENTINEL_ACTIVITY_RPC' }] };
     emitItem('item/started', file);
     emitItem('item/completed', { ...file, status: 'completed' });
     const mcp = { type: 'mcpToolCall', id: 'activity-mcp', status: 'inProgress', server: 'docs', tool: 'lookup', arguments: { privateNative: 'SENTINEL_ACTIVITY_RPC' } };
     send({ method: 'item/mcpToolCall/progress', params: { threadId: id, turnId: turn.id, itemId: mcp.id, message: 'searching docs', privateNative: 'SENTINEL_ACTIVITY_RPC' } });
     emitItem('item/started', mcp);
     emitItem('item/completed', { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'useful result', hidden: 'SENTINEL_ACTIVITY_RPC' }], structuredContent: { secret: 'SENTINEL_ACTIVITY_RPC' } } });
     const dynamic = { type: 'dynamicToolCall', id: 'activity-dynamic', status: 'inProgress', tool: 'inspect', arguments: { hidden: 'SENTINEL_ACTIVITY_RPC' } };
     emitItem('item/started', dynamic);
     emitItem('item/completed', { ...dynamic, status: 'completed', contentItems: [{ type: 'inputText', text: 'dynamic result' }, { type: 'inputImage', imageUrl: 'SENTINEL_ACTIVITY_RPC' }] });
     const early = { type: 'commandExecution', id: 'activity-early', command: 'printf early', cwd: process.env.TEST_CWD, commandActions: [], status: 'inProgress' };
     send({ method: 'item/commandExecution/outputDelta', params: { threadId: id, turnId: turn.id, itemId: early.id, delta: 'early output' } });
     emitItem('item/started', early);
     emitItem('item/completed', { ...early, status: 'completed', aggregatedOutput: 'early output final', exitCode: 0 });
   }
   if (process.env.TEST_NATIVE_FAILURE) {
     if (process.env.TEST_NATIVE_FAILURE !== 'turn') send({ method: 'error', params: { threadId: id, turnId: turn.id, error: { message: 'SENTINEL_PRIVATE_ERROR' }, willRetry: process.env.TEST_NATIVE_FAILURE.startsWith('retry') } });
     if (process.env.TEST_NATIVE_FAILURE === 'retry-error') send({ method: 'error', params: { threadId: id, turnId: turn.id, error: { message: 'SENTINEL_PRIVATE_ERROR' }, willRetry: false } });
     const end = { method: 'turn/completed', params: { threadId: id, turn: { ...turn, status: process.env.TEST_NATIVE_FAILURE === 'retry' ? 'completed' : 'failed', error: { message: 'SENTINEL_PRIVATE_ERROR' } } } };
     send(end); send(end); return send({ id: q.id, result: { turn } });
   }
   const item = { type: 'agentMessage', id: 'item-1', text: 'Hello' };
   if (process.env.TEST_REASONING) {
     const common = { threadId: id, turnId: turn.id, itemId: 'reason' };
     send({ method: 'item/reasoning/textDelta', params: { ...common, contentIndex: 1, delta: 'c2' } });
     send({ method: 'item/reasoning/summaryTextDelta', params: { ...common, summaryIndex: 1, delta: 's2' } });
     send({ method: 'item/reasoning/summaryTextDelta', params: { ...common, summaryIndex: 0, delta: 's1' } });
     send({ method: 'item/reasoning/textDelta', params: { ...common, contentIndex: 0, delta: 'c1' } });
     send({ method: 'item/completed', params: { threadId: id, turnId: turn.id, item: { type: 'reasoning', id: 'reason', summary: ['s1', 's2'], content: ['c1', 'c2'] }, completedAtMs: 1 } });
   }
   send({ method: 'item/agentMessage/delta', params: { threadId: id, turnId: turn.id, itemId: item.id, delta: 'Hello' } });
   send({ method: 'item/completed', params: { threadId: id, turnId: turn.id, item, completedAtMs: 1 } });
   if (process.env.TEST_REPEATED) {
     send({ method: 'item/completed', params: { threadId: id, turnId: turn.id, item, completedAtMs: 1 } });
     send({ method: 'item/completed', params: { threadId: id, turnId: turn.id, item: { type: 'agentMessage', id: 'item-2', text: 'World' }, completedAtMs: 1 } });
   }
   send({ method: 'turn/completed', params: { threadId: id, turn: { ...turn, status: 'completed' } } });
   return send({ id: q.id, result: { turn } });
 }
});
`);
  await chmod(binary, 0o700);
  const options = { binary, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: join(dir, 'codex-home'), TEST_CWD: dir, TEST_LOG: log } };
  try { await fn({ dir, options, log }); } finally { const live = actor.getCodexSession(`codex:${threadId}`); if (live) await actor.shutdownCodexSession(live); await rm(dir, { recursive: true, force: true }); }
}

test('removed cwd keeps an existing actor observable but refuses execution, resume and create', async () => {
  await fixture(async ({ dir, options, log }) => {
    const cwd = join(dir, 'removed-work');
    await mkdir(cwd);
    const scoped = { ...options, env: { ...options.env, TEST_CWD: cwd } };
    const created = await actor.createCodexSession({ cwd, requestId: requestId(9801) }, scoped);
    assert.equal(created.ok, true);
    await rm(cwd, { recursive: true });
    const before = await readFile(log, 'utf8');
    const current = await actor.ensureCodexSession(created.value.sessionId, scoped);
    assert.equal(current.ok, true);
    assert.equal(current.value, created.value);
    const prompt = await actor.promptCodexSession(created.value, { message: 'Do not recreate the removed project', requestId: requestId(9803) });
    assert.equal(prompt.ok, false);
    assert.equal(prompt.error.kind, 'cwd-missing');
    assert.equal(prompt.error.cwd, cwd);
    for (const operation of [
      () => actor.updateCodexSettings(created.value, { model: 'native-model', effort: 'medium' }),
      () => actor.forkCodexSession(created.value),
      () => actor.compactCodexSession(created.value),
    ]) {
      const refused = await operation();
      assert.equal(refused.ok, false);
      assert.equal(refused.error.kind, 'cwd-missing');
    }
    assert.equal(await readFile(log, 'utf8'), before);
    await actor.shutdownCodexSession(created.value);
    const resumed = await actor.ensureCodexSession(created.value.sessionId, scoped);
    assert.equal(resumed.ok, false);
    assert.equal(resumed.error.kind, 'cwd-missing');
    assert.equal(resumed.error.cwd, cwd);
    const methods = (await readFile(log, 'utf8')).split('\n');
    assert.equal(methods.includes('thread/resume'), false);
    assert.equal(methods.filter(method => method === 'thread/start').length, 1);
    const nativeCalls = await readFile(log, 'utf8');
    const fresh = await actor.createCodexSession({ cwd, requestId: requestId(9802) }, scoped);
    assert.equal(fresh.ok, false);
    assert.equal(fresh.error.kind, 'cwd-missing');
    assert.equal(await readFile(log, 'utf8'), nativeCalls);
  });
});

test('create records admission before one native start and replays its id', async () => {
  await fixture(async ({ dir, options, log }) => {
    const input = { cwd: dir, requestId: requestId(1) };
    options.env.TEST_PENDING_CREATE = join(process.env.PI_CODING_AGENT_DIR, 'pi-web-codex-mutations', 'create', input.requestId, 'record.json');
    const [one, two] = await Promise.all([actor.createCodexSession(input, options), actor.createCodexSession(input, options)]);
    assert.equal(one.ok, true); assert.equal(two.ok, true); assert.equal(one.value.sessionId, two.value.sessionId);
    await actor.shutdownCodexSession(one.value);
    const replay = await actor.createCodexSession(input, options);
    assert.equal(replay.ok, true); assert.equal(replay.value.sessionId, one.value.sessionId);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(s => s === 'thread/start').length, 1);
    const conflict = await actor.createCodexSession({ ...input, model: 'different' }, options);
    assert.equal(conflict.error.kind, 'conflict');
  });
});

test('prompt admits once and emits native item lifecycle', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_PENDING_PROMPT = join(process.env.PI_CODING_AGENT_DIR, 'pi-web-codex-mutations', 'prompt', requestId(3), 'record.json');
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(2) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const input = { requestId: requestId(3), message: 'hello' };
    const prompt = await actor.promptCodexSession(created.value, input);
    assert.equal(prompt.ok, true); assert.equal(prompt.value.kind, 'live');
    assert.equal((await prompt.value.completion).kind, 'completed');
    const replay = await actor.promptCodexSession(created.value, input);
    assert.equal(replay.value.kind, 'replayed');
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(s => s === 'turn/start').length, 1);
    assert.deepEqual(events.map(event => event.type), ['session_settings', 'agent_start', 'turn_start', 'message_start', 'message_update', 'message_end', 'turn_end', 'agent_end', 'prompt_done']);
    assert.equal(events.find(event => event.type === 'message_end').message.content[0].text, 'Hello');
  });
});

test('handoff capture excludes every current native mutator and releases for later work', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(900) }, options);
    assert.equal(created.ok, true);
    let enterCapture;
    const entered = new Promise(resolve => { enterCapture = resolve; });
    let releaseCapture;
    const held = new Promise(resolve => { releaseCapture = resolve; });
    const capture = actor.withCodexHandoffSnapshot(created.value.sessionId, async () => {
      enterCapture();
      await held;
      return 'snapshot';
    });
    await entered;
    const results = await Promise.all([
      actor.ensureCodexSession(created.value.sessionId, options),
      actor.updateCodexSettings(created.value, { model: 'test', effort: 'low' }),
      actor.promptCodexSession(created.value, { requestId: requestId(901), message: 'blocked prompt' }),
      actor.steerCodexSession(created.value, { requestId: requestId(902), message: 'blocked steer' }),
      actor.stopCodexSession(created.value),
    ]);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.error.kind, 'conflict');
    }
    assert.equal(actor.answerCodexInteraction(created.value, { id: 'missing', cancelled: true }).error.kind, 'conflict');
    await assert.rejects(actor.shutdownCodexSession(created.value), error => error.reason === 'capture-active');
    await assert.rejects(
      actor.withCodexHandoffSnapshot(created.value.sessionId, async () => null),
      error => error.reason === 'capture-active',
    );
    releaseCapture();
    assert.equal(await capture, 'snapshot');
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(904), message: 'admitted after capture' });
    assert.equal(prompt.ok, true);
    await prompt.value.completion;
  });
});

test('unrelated create completes during capture while replay of the captured thread is excluded', async () => {
  await fixture(async ({ dir, options, log }) => {
    const sourceInput = { cwd: dir, requestId: requestId(940) };
    const source = await actor.createCodexSession(sourceInput, options);
    assert.equal(source.ok, true);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const capture = actor.withCodexHandoffSnapshot(source.value.sessionId, async () => { await held; return 'captured'; });
    let other;
    try {
      const otherOptions = { ...options, env: { ...options.env, TEST_THREAD_ID: otherThreadId } };
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(941) }, otherOptions);
      assert.equal(created.ok, true, JSON.stringify(created));
      other = created.value;
      assert.equal(other.sessionId, `codex:${otherThreadId}`);
      const replay = await actor.createCodexSession(sourceInput, options);
      assert.equal(replay.error.kind, 'conflict');
      assert.equal(actor.getCodexSession(source.value.sessionId), source.value);
      assert.equal((await readFile(log, 'utf8')).split('\n').filter(line => line === 'thread/start').length, 2);
    } finally {
      release();
      await capture;
      if (other) await actor.shutdownCodexSession(other);
    }
  });
});

test('capture admits its source while an unrelated create is in flight', async () => {
  await fixture(async ({ dir, options }) => {
    const source = await actor.createCodexSession({ cwd: dir, requestId: requestId(942) }, options);
    assert.equal(source.ok, true);
    let enteredStart, releaseStart;
    const started = new Promise(resolve => { enteredStart = resolve; });
    const startHeld = new Promise(resolve => { releaseStart = resolve; });
    const originalRequest = CodexTransport.prototype.request;
    CodexTransport.prototype.request = function (method, ...args) {
      if (method === 'thread/start') {
        enteredStart();
        return startHeld.then(() => originalRequest.call(this, method, ...args));
      }
      return originalRequest.call(this, method, ...args);
    };
    const otherOptions = { ...options, env: { ...options.env, TEST_THREAD_ID: otherThreadId } };
    const creating = actor.createCodexSession({ cwd: dir, requestId: requestId(943) }, otherOptions);
    let releaseCapture;
    const held = new Promise(resolve => { releaseCapture = resolve; });
    let captureEntered = false;
    try {
      await started;
      const capture = actor.withCodexHandoffSnapshot(source.value.sessionId, async () => {
        captureEntered = true;
        await held;
        return 'captured';
      });
      const captured = capture.then(value => ({ value }), error => ({ error }));
      try {
        assert.equal(captureEntered, true);
        releaseStart();
        const created = await creating;
        assert.equal(created.ok, true, JSON.stringify(created));
        assert.equal(created.value.sessionId, `codex:${otherThreadId}`);
        assert.equal(actor.getCodexSession(source.value.sessionId), source.value);
      } finally {
        releaseCapture();
        const result = await captured;
        if (captureEntered) assert.equal(result.value, 'captured');
      }
    } finally {
      releaseStart();
      CodexTransport.prototype.request = originalRequest;
      const created = await creating;
      if (created.ok) await actor.shutdownCodexSession(created.value);
    }
  });
});

test('accepted create cannot register a captured history-only thread and can replay after release', async () => {
  await fixture(async ({ dir, options, log }) => {
    const source = await actor.createCodexSession({ cwd: dir, requestId: requestId(944) }, options);
    assert.equal(source.ok, true);
    await actor.shutdownCodexSession(source.value);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const capture = actor.withCodexHandoffSnapshot(source.value.sessionId, async () => { await held; return 'captured'; });
    const captured = capture.then(value => ({ value }), error => ({ error }));
    const input = { cwd: dir, requestId: requestId(945) };
    try {
      const created = await actor.createCodexSession(input, options);
      assert.equal(created.ok, false);
      assert.equal(created.error.kind, 'conflict');
      assert.equal(actor.getCodexSession(source.value.sessionId), undefined);
      const record = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, 'pi-web-codex-mutations', 'create', input.requestId, 'record.json'), 'utf8'));
      assert.equal(record.stage, 'accepted');
    } finally {
      release();
      await captured;
    }
    assert.equal((await captured).value, 'captured');
    const replay = await actor.createCodexSession(input, options);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.value.sessionId, source.value.sessionId);
    const rows = (await readFile(log, 'utf8')).split('\n');
    assert.equal(rows.filter(line => line === 'thread/start').length, 2);
    assert.equal(rows.filter(line => line === 'thread/resume').length, 1);
  });
});

for (const [index, signal] of ['SIGINT', 'SIGTERM'].entries()) {
  test(`process ${signal} queues captured actor shutdown until capture ${index ? 'fails' : 'completes'}`, async () => {
    await fixture(async ({ dir, options }) => {
      const source = await actor.createCodexSession({ cwd: dir, requestId: requestId(950 + index * 2) }, options);
      assert.equal(source.ok, true);
      const otherOptions = { ...options, env: { ...options.env, TEST_THREAD_ID: otherThreadId } };
      const other = await actor.createCodexSession({ cwd: dir, requestId: requestId(951 + index * 2) }, otherOptions);
      assert.equal(other.ok, true);
      const events = [];
      actor.subscribeCodexSession(source.value, event => events.push(event));
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const capture = actor.withCodexHandoffSnapshot(source.value.sessionId, async () => {
        await held;
        if (index) throw new Error('capture failed');
        return 'captured';
      });
      const captured = capture.then(value => ({ value }), error => ({ error }));
      try {
        const listeners = process.listeners(signal).filter(listener => !initialSignalListeners.get(signal).has(listener));
        assert.equal(listeners.length, 1);
        listeners[0]();
        listeners[0]();
        assert.equal(source.value.state.kind, 'ready');
        assert.equal(actor.getCodexSession(source.value.sessionId), source.value);
        assert.equal(actor.getCodexSession(other.value.sessionId), undefined);
        await assert.rejects(actor.shutdownCodexSession(source.value), error => error.reason === 'capture-active');
        assert.equal(events.filter(event => event.type === 'session_shutdown').length, 0);
      } finally {
        release();
        await captured;
        await actor.shutdownCodexSession(other.value);
      }
      const result = await captured;
      if (index) assert.match(result.error.message, /capture failed/);
      else assert.equal(result.value, 'captured');
      assert.notEqual(source.value.state.kind, 'ready');
      assert.equal(actor.getCodexSession(source.value.sessionId), undefined);
      await actor.shutdownCodexSession(source.value);
      assert.equal(source.value.state.kind, 'closed');
      assert.equal(events.filter(event => event.type === 'session_shutdown').length, 1);
    });
  });
}

test('native settings notifications wait until handoff capture releases', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_LATE_SETTINGS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(908) }, options);
    assert.equal(created.ok, true);
    const capturedModel = await actor.withCodexHandoffSnapshot(created.value.sessionId, async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(actor.codexSessionState(created.value).settings.model, 'test');
      return actor.codexSessionState(created.value).settings.model;
    });
    assert.equal(capturedModel, 'test');
    assert.equal(actor.codexSessionState(created.value).settings.model, 'other');
  });
});

test('history-only capture wins the race with resume and releases after failure', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(905) }, options);
    const sessionId = created.value.sessionId;
    await actor.shutdownCodexSession(created.value);
    let releaseCapture;
    const held = new Promise(resolve => { releaseCapture = resolve; });
    let enteredCapture;
    const entered = new Promise(resolve => { enteredCapture = resolve; });
    const capture = actor.withCodexHandoffSnapshot(sessionId, async () => {
      enteredCapture();
      await held;
      throw new Error('capture failed');
    });
    await entered;
    const ensuredWhileCaptured = await actor.ensureCodexSession(sessionId, options);
    assert.equal(ensuredWhileCaptured.error.kind, 'conflict');
    releaseCapture();
    await assert.rejects(capture, /capture failed/);
    const ensured = await actor.ensureCodexSession(sessionId, options);
    assert.equal(ensured.ok, true);
    await actor.shutdownCodexSession(ensured.value);
    const resuming = actor.ensureCodexSession(sessionId, options);
    await assert.rejects(actor.withCodexHandoffSnapshot(sessionId, async () => null), error => error.reason === 'source-busy');
    assert.equal((await resuming).ok, true);
  });
});

test('handoff capture refuses running and settings-pending actors', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_APPROVAL = 'command';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(906) }, options);
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(907), message: 'hold' });
    assert.equal(prompt.ok, true);
    await assert.rejects(actor.withCodexHandoffSnapshot(created.value.sessionId, async () => null), error => error.reason === 'source-busy');
    const stopping = actor.stopCodexSession(created.value);
    await assert.rejects(actor.withCodexHandoffSnapshot(created.value.sessionId, async () => null), error => error.reason === 'source-busy');
    await stopping;
    delete options.env.TEST_HOLD;
    delete options.env.TEST_APPROVAL;
    const settings = actor.updateCodexSettings(created.value, { model: 'test', effort: 'medium' });
    await assert.rejects(actor.withCodexHandoffSnapshot(created.value.sessionId, async () => null), error => error.reason === 'source-busy');
    assert.equal((await settings).ok, true);
    const closing = actor.shutdownCodexSession(created.value);
    await assert.rejects(actor.withCodexHandoffSnapshot(created.value.sessionId, async () => null), error => error.reason === 'source-busy');
    await closing;
  });
});

test('resume returns a typed refusal for readable thread', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(7) }, options);
    await actor.shutdownCodexSession(created.value);
    options.env.TEST_RESUME_ERROR = '1';
    const result = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(result.error.kind, 'resume-refused');
    assert.equal(result.error.code, -32600);
  });
});

test('item completion replaces streamed content exactly once', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_REPEATED = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(8) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(9), message: 'hello' });
    await prompt.value.completion;
    const ends = events.filter(event => event.type === 'message_end');
    assert.deepEqual(ends.map(event => event.message.content[0].text), ['Hello', 'World']);
    assert.deepEqual(ends.map(event => event.entryId), ['item-1', 'item-2']);
  });
});

test('duplicate outstanding server request IDs close the transport', async () => {
  class Child extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough(); exitCode = null; signalCode = null;
    stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    kill(signal) { this.signalCode = signal; this.emit('exit', null, signal); this.emit('close', null, signal); return true; }
  }
  const child = new Child();
  const transport = new CodexTransport(child, { serverRequests: { wait: () => new Promise(() => {}) }, shutdownTimeoutMs: 1 });
  const pending = transport.request('health', {});
  child.stdout.write(`${JSON.stringify({ id: 'duplicate', method: 'wait' })}\n`);
  child.stdout.write(`${JSON.stringify({ id: 'duplicate', method: 'wait' })}\n`);
  await assert.rejects(pending, error => error.kind === 'protocol');
  assert.equal(child.signalCode, 'SIGKILL');
  await transport.shutdown();
});

test('transport failure and shutdown settle waiters and close stream once', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_EXIT = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(10) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(11), message: 'hello' });
    const guard = setTimeout(() => {}, 15000);
    try { assert.equal((await prompt.value.completion).kind, 'transport-fatal'); } finally { clearTimeout(guard); }
    await actor.shutdownCodexSession(created.value);
    assert.equal(events.filter(event => event.type === 'session_shutdown').length, 1);
  });
});

test('unprompted thread after restart returns thread-unavailable', async () => {
  await fixture(async ({ dir, options }) => {
    const input = { cwd: dir, requestId: requestId(4) };
    const created = await actor.createCodexSession(input, options);
    const record = join(process.env.PI_CODING_AGENT_DIR, 'pi-web-codex-mutations', 'create', input.requestId, 'record.json');
    const before = await readFile(record, 'utf8');
    await actor.shutdownCodexSession(created.value);
    options.env.TEST_READ_ERROR = '-32600';
    const resumed = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(resumed.ok, false); assert.equal(resumed.error.kind, 'thread-unavailable');
    assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    const replay = await actor.createCodexSession(input, options);
    assert.equal(replay.error.kind, 'thread-unavailable');
    assert.equal(replay.error.sessionId, created.value.sessionId);
    assert.equal(await readFile(record, 'utf8'), before);
  });
});

test('immediate Stop remains effective while prompt admission checks the directory', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(9820) }, options);
    assert.equal(created.ok, true);
    const prompting = actor.promptCodexSession(created.value, { requestId: requestId(9821), message: 'start' });
    const stopping = actor.stopCodexSession(created.value);
    const [prompt, stopped] = await Promise.all([prompting, stopping]);
    assert.equal(prompt.ok, true);
    assert.equal(stopped.ok, true);
    const requests = (await readFile(log, 'utf8')).split('\n');
    assert.equal(requests.filter(method => method === 'turn/interrupt').length, 1);
    assert.equal((await prompt.value.completion).kind, 'interrupted');
    assert.equal(actor.codexSessionState(created.value).isStreaming, false);
  });
});

test('stop settles all waiters during start and ignores late completion', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(5) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const prompting = actor.promptCodexSession(created.value, { requestId: requestId(6), message: 'hello' });
    const duplicate = actor.promptCodexSession(created.value, { requestId: requestId(6), message: 'hello' });
    const busy = await actor.promptCodexSession(created.value, { requestId: requestId(16), message: 'other' });
    assert.equal(busy.error.kind, 'conflict');
    const first = actor.stopCodexSession(created.value);
    const second = actor.stopCodexSession(created.value);
    const prompt = await prompting;
    const duplicatePrompt = await duplicate;
    assert.equal(prompt.value.kind, 'live'); assert.equal(duplicatePrompt.value.turnId, prompt.value.turnId);
    const [a, b, completion] = await Promise.all([first, second, prompt.value.completion]);
    assert.equal(a.value.completion.kind, 'interrupted'); assert.equal(b.value.completion.kind, 'interrupted'); assert.equal(completion.kind, 'interrupted');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(events.filter(event => event.type === 'prompt_done').length, 1);
    const requests = (await readFile(log, 'utf8')).split('\n');
    assert.equal(requests.filter(s => s === 'turn/interrupt').length, 1);
    assert.equal(requests.filter(s => s === 'turn/start').length, 1);
  });
});

async function safeCodexBinary() {
  const blocked = [originalHome, homedir()].flatMap(home => [join(home, '.codex'), join(home, '.pi', 'agent')]);
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    let candidate = resolve(path || '.', 'codex');
    for (let depth = 0; depth < 16; depth++) {
      if (blocked.some(root => candidate === root || candidate.startsWith(`${root}${sep}`))) break;
      try {
        const info = await lstat(candidate);
        if (!info.isSymbolicLink()) { if (info.isFile()) return candidate; break; }
        candidate = resolve(dirname(candidate), await readlink(candidate));
      } catch { break; }
    }
  }
  return null;
}

test('real CLI settings, provider values and resume use the product actor', async t => {
  const binary = await safeCodexBinary();
  if (!binary) { t.skip('pinned Codex CLI unavailable outside protected homes'); return; }
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }, timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.153.4') { t.skip('pinned Codex CLI unavailable outside protected homes'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'codex-actor-real-'));
  const home = join(dir, 'home');
  const cwd = join(dir, 'work');
  await mkdir(home); await mkdir(cwd);
  const providerRequests = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body); providerRequests.push({ model: request.model, effort: request.reasoning?.effort });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      const response = { id: 'resp_local', object: 'response', created_at: 1, status: 'in_progress', model: 'mock', output: [] };
      emit('response.created', { response });
      const item = { id: 'msg_local', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'Local reply.' });
      emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'Local reply.' });
      emit('response.output_item.done', { output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'Local reply.', annotations: [] }] } });
      emit('response.completed', { response: { ...response, status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let live;
  try {
    const port = server.address().port;
    await writeFile(join(home, 'config.toml'), `model = "gpt-6-astra"\nmodel_provider = "localmock"\n[model_providers.localmock]\nname = "Local Mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    const options = { binary, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: dir, LANG: 'C.UTF-8' } };
    const untouched = await actor.createCodexSession({ cwd, requestId: requestId(840) }, options);
    assert.equal(untouched.ok, true, JSON.stringify(untouched));
    live = untouched.value;
    assert.equal(actor.codexSessionState(live).settings.effort, null);
    const defaultTurn = await actor.promptCodexSession(live, { requestId: requestId(841), message: 'Respond briefly.' });
    assert.equal(defaultTurn.ok, true, JSON.stringify(defaultTurn));
    assert.equal((await defaultTurn.value.completion).kind, 'completed');
    assert.deepEqual(providerRequests.at(-1), { model: 'gpt-6-astra', effort: 'low' });
    await actor.shutdownCodexSession(live); live = undefined;
    const created = await actor.createCodexSession({ cwd, requestId: requestId(14), model: 'gpt-6-astra', effort: 'high' }, options);
    assert.equal(created.ok, true, JSON.stringify(created)); live = created.value;
    assert.equal(actor.codexSessionState(live).settings.effort, 'high');
    const events = []; actor.subscribeCodexSession(live, event => events.push(event));
    const prompted = await actor.promptCodexSession(live, { requestId: requestId(15), message: 'Respond briefly.' });
    assert.equal(prompted.ok, true, JSON.stringify(prompted));
    assert.equal((await prompted.value.completion).kind, 'completed');
    assert.equal(events.filter(event => event.type === 'message_end').some(event => event.message.content?.some(block => block.type === 'text' && block.text === 'Local reply.')), true);
    assert.deepEqual(providerRequests.at(-1), { model: 'gpt-6-astra', effort: 'high' });
    for (const [index, effort] of ['max', 'ultra'].entries()) {
      const updated = await actor.updateCodexSettings(live, { model: 'gpt-6-astra', effort });
      assert.equal(updated.ok, true, JSON.stringify(updated));
      assert.equal(updated.value.effort, effort);
      const turn = await actor.promptCodexSession(live, { requestId: requestId(830 + index), message: 'Respond briefly.' });
      assert.equal(turn.ok, true, JSON.stringify(turn));
      assert.equal((await turn.value.completion).kind, 'completed');
      assert.deepEqual(providerRequests.at(-1), { model: 'gpt-6-astra', effort: effort === 'ultra' ? 'xhigh' : 'max' });
    }
    await actor.shutdownCodexSession(live); live = undefined;
    const resumed = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(resumed.ok, true, JSON.stringify(resumed)); live = resumed.value;
    assert.equal(actor.codexSessionState(live).settings.effort, 'ultra');
  } finally {
    if (live) await actor.shutdownCodexSession(live);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});

test('reasoning and answer retain separate item identities through history refresh and reconnect', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_REASONING = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(12) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(13), message: 'hi' });
    await prompt.value.completion;
    const ends = events.filter(event => event.type === 'message_end');
    assert.deepEqual(ends.map(event => event.entryId), ['reason', 'item-1']);
    const thread = { id: threadId, sessionId: threadId, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: '/tmp', cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [{ type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'hi', text_elements: [] }] }, { type: 'reasoning', id: 'reason', summary: ['s1', 's2'], content: ['c1', 'c2'] }, { type: 'agentMessage', id: 'item-1', text: 'Hello' }] }] };
    const turnItems = thread.turns[0].items;
    turnItems.unshift({ type: 'userMessage', id: 'anchor', content: [{ type: 'text', text: 'previous', text_elements: [] }] });
    turnItems.unshift({ type: 'userMessage', id: 'older', content: [{ type: 'text', text: 'older', text_elements: [] }] });
    const history = projectCodexHistory(thread, { tail: 4 }).context;
    const expanded = projectCodexHistory(thread, { tail: 50 }).context;
    assert.equal(history.messages[2].content[0].thinking, 's1\ns2\nc1\nc2');
    assert.equal(ends[0].message.content[0].thinking, history.messages[2].content[0].thinking);
    const live = [history.messages[0], { role: 'user', content: 'hi' }, ...ends.map(event => event.message)];
    const aliases = carryMessageKeys({ messages: live, entryIds: ['anchor'], aliases: new Map() }, history);
    assert.equal(aliases.size, 3); assert.equal(aliases.get('reason'), 'live:anchor:1'); assert.equal(aliases.get('item-1'), 'live:anchor:2');
    const reconnect = carryMessageKeys({ messages: history.messages, entryIds: history.entryIds, aliases }, expanded);
    assert.equal(reconnect.get('reason'), 'live:anchor:1'); assert.equal(reconnect.get('item-1'), 'live:anchor:2');
  });
});

test('a Codex follow-up is queued during a run and remains queued after Stop', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1501) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1502), message: 'first' });
    const queued = await commandRuntime(created.value.sessionId, {
      type: 'prompt', requestId: requestId(1503), message: 'second', streamingBehavior: 'followUp',
    });
    assert.equal(queued.status, 200);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['second']);
    await actor.stopCodexSession(created.value);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['second']);
  });
});

test('Codex projects a delivered steer once from the native user message', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_USER_EVENTS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1505) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1506), message: 'first' });
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const sent = await actor.steerCodexSession(created.value, { requestId: requestId(1507), message: 'steered' });
    assert.equal(sent.ok, true);
    assert.equal(events.filter(event => event.type === 'message_end' && event.message?.role === 'user' && event.message.content === 'steered').length, 1);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex delivers queued follow-ups in order and emits each message', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_USER_EVENTS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1511) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1512), message: 'first' });
    const submissions = await Promise.all([
      commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1513), message: 'second', streamingBehavior: 'followUp' }),
      commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1514), message: 'third', streamingBehavior: 'followUp' }),
    ]);
    assert.deepEqual(submissions.map(row => row.status), [200, 200]);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['second', 'third']);
    const waitForMessage = text => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('queued message was not delivered')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type === 'message_end' && event.message?.role === 'user' && event.message.content === text) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
    let delivered = waitForMessage('second');
    process.kill(created.value.state.transport.child.pid, 'SIGUSR2');
    await delivered;
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['third']);
    delivered = waitForMessage('third');
    process.kill(created.value.state.transport.child.pid, 'SIGUSR2');
    await delivered;
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, []);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'turn/start').length, 3);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex all mode delivers follow-ups together with separate live messages', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_USER_EVENTS = '1';
    options.queueModes = { steering: 'one-at-a-time', followUp: 'all' };
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1580) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1581), message: 'first' });
    for (const [index, message] of ['one', 'two', 'three'].entries()) await commandRuntime(created.value.sessionId, {
      type: 'prompt', requestId: requestId(1582 + index), message, streamingBehavior: 'followUp',
    });
    const received = [];
    const delivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('batch was not delivered')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type !== 'message_end' || event.message?.role !== 'user') return;
        received.push(event.message.content);
        if (received.length === 3) { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    });
    process.kill(created.value.state.transport.child.pid, 'SIGUSR2'); await delivered;
    assert.deepEqual(received, ['one', 'two', 'three']);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, []);
    const requests = (await readFile(log, 'utf8')).split('\n');
    assert.equal(requests.filter(method => method === 'turn/start').length, 2);
    const payload = JSON.parse(requests.filter(line => line.startsWith('prompt-payload:')).at(-1).slice('prompt-payload:'.length));
    const historyThread = { id: threadId, sessionId: threadId, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', model: 'test', createdAt: 1, updatedAt: 2, cwd: dir, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [{ id: 'batch', status: 'completed', items: [{ id: 'user-turn-2', type: 'userMessage', content: payload.input, clientId: payload.clientUserMessageId }] }] };
    assert.deepEqual(projectCodexHistory(historyThread, { tail: 10 }).context.messages.map(message => message.content), received);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex restores every follow-up when a native batch is rejected', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_REJECT_BATCH = '1';
    options.queueModes = { steering: 'one-at-a-time', followUp: 'all' };
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1590) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1591), message: 'first' });
    for (const [index, message] of ['one', 'two', 'three'].entries()) await commandRuntime(created.value.sessionId, {
      type: 'prompt', requestId: requestId(1592 + index), message, streamingBehavior: 'followUp',
    });
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('rejected batch did not settle')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => { if (event.type === 'prompt_done') { clearTimeout(timer); unsubscribe(); resolve(); } });
    });
    process.kill(created.value.state.transport.child.pid, 'SIGUSR2'); await ended;
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['one', 'two', 'three']);
    assert.deepEqual((await commandRuntime(created.value.sessionId, { type: 'clear_queue' })).body.data.followUp, ['one', 'two', 'three']);
  });
});

test('Codex all mode submits each pending steer before waiting for consumption', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_USER_EVENTS = '1'; options.env.TEST_DEFER_STEERS = '1';
    options.queueModes = { steering: 'all', followUp: 'one-at-a-time' };
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1585) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1586), message: 'first' });
    for (const [index, message] of ['one', 'two', 'three'].entries()) await commandRuntime(created.value.sessionId, {
      type: 'prompt', requestId: requestId(1587 + index), message, streamingBehavior: 'steer',
    });
    for (let i = 0; i < 100 && (await readFile(log, 'utf8')).split('\n').filter(line => line === 'turn/steer').length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(line => line === 'turn/steer').length, 3);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, ['one', 'two', 'three']);
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('turn was not completed')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => { if (event.type === 'prompt_done') { clearTimeout(timer); unsubscribe(); resolve(); } });
    });
    process.kill(created.value.state.transport.child.pid, 'SIGUSR2'); await ended;
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, []);
  });
});

test('Codex recall removes queued follow-ups without duplicating retried requests', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1521) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1522), message: 'first' });
    const input = { type: 'prompt', requestId: requestId(1523), message: 'second', streamingBehavior: 'followUp' };
    assert.equal((await commandRuntime(created.value.sessionId, input)).status, 200);
    assert.equal((await commandRuntime(created.value.sessionId, input)).status, 200);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['second']);
    const recalled = await commandRuntime(created.value.sessionId, { type: 'clear_queue' });
    assert.deepEqual(recalled.body.data, { steering: [], followUp: ['second'] });
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, []);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex accepts and delivers multiple steering messages in order', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_USER_EVENTS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1531) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1532), message: 'first' });
    const received = [];
    const delivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('steers were not delivered')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type !== 'message_end' || event.message?.role !== 'user') return;
        received.push(event.message.content);
        if (received.length === 2) { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    });
    const responses = await Promise.all([
      commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1533), message: 'steer one', streamingBehavior: 'steer' }),
      commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1534), message: 'steer two', streamingBehavior: 'steer' }),
    ]);
    assert.deepEqual(responses.map(row => row.status), [200, 200]);
    await delivered;
    assert.deepEqual(received, ['steer one', 'steer two']);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, []);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'turn/steer').length, 2);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex confirms a steer by client identity rather than identical text', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_USER_EVENTS = '1';
    options.env.TEST_FOREIGN_STEER = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1539) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1540), message: 'first' });
    let queuedAtForeign;
    const delivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('steer was not delivered')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type !== 'message_end' || event.message?.role !== 'user') return;
        if (event.entryId === 'foreign-steer') queuedAtForeign = actor.codexSessionState(created.value).queuedMessages.steering;
        if (event.entryId === 'steer-1') { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    });
    const response = await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1543), message: 'identical', streamingBehavior: 'steer' });
    assert.equal(response.status, 200);
    await delivered;
    assert.deepEqual(queuedAtForeign, ['identical']);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, []);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex Stop interrupts an unconfirmed steer without retracting it and preserves pending input', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_STEER_MODE = 'lost';
    options.requestTimeoutMs = 1000;
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1535) }, options);
    assert.equal(created.ok, true);
    const events = [];
    const unsubscribe = actor.subscribeCodexSession(created.value, event => events.push(event));
    await actor.promptCodexSession(created.value, { requestId: requestId(1536), message: 'first' });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1537), message: 'steer one', streamingBehavior: 'steer' });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1538), message: 'steer two', streamingBehavior: 'steer' });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1575), message: 'follow-up', streamingBehavior: 'followUp' });
    for (let i = 0; i < 100 && !(await readFile(log, 'utf8')).split('\n').includes('turn/steer'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok((await readFile(log, 'utf8')).split('\n').includes('turn/steer'));
    assert.equal((await commandRuntime(created.value.sessionId, { type: 'clear_queue' })).status, 409);
    const stopped = await commandRuntime(created.value.sessionId, { type: 'abort' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.data.stopped, true);
    assert.equal(stopped.body.data.completion.kind, 'interrupted');
    assert.equal(actor.codexSessionState(created.value).isStreaming, false);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages, { steering: ['steer one', 'steer two'], followUp: ['follow-up'] });
    assert.ok(events.some(event => event.type === 'prompt_error' && /could not confirm/i.test(event.errorMessage)));
    const methods = (await readFile(log, 'utf8')).split('\n');
    assert.equal(methods.filter(method => method === 'turn/interrupt').length, 1);
    assert.equal(methods.filter(method => method === 'turn/steer').length, 1);
    assert.equal(methods.filter(method => method === 'turn/start').length, 1);
    const recalled = await commandRuntime(created.value.sessionId, { type: 'clear_queue' });
    assert.deepEqual(recalled.body.data, { steering: ['steer one', 'steer two'], followUp: ['follow-up'] });
    unsubscribe();
  });
});

test('Codex does not automatically retry an unconfirmed steer after Stop', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1544) }, options);
    assert.equal(created.ok, true);
    const events = [];
    const unsubscribe = actor.subscribeCodexSession(created.value, event => events.push(event));
    await actor.promptCodexSession(created.value, { requestId: requestId(1545), message: 'first' });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1546), message: 'pending', streamingBehavior: 'steer' });
    for (let i = 0; i < 100 && !(await readFile(log, 'utf8')).split('\n').includes('turn/steer'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok((await readFile(log, 'utf8')).split('\n').includes('turn/steer'));
    await actor.stopCodexSession(created.value);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, ['pending']);
    assert.ok(events.some(event => event.type === 'prompt_error' && /could not confirm/i.test(event.errorMessage)));
    await actor.promptCodexSession(created.value, { requestId: requestId(1547), message: 'resume' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'turn/steer').length, 1);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, ['pending']);
    await actor.stopCodexSession(created.value);
    unsubscribe();
  });
});

test('Codex does not retry a steer that was consumed before Stop', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_USER_EVENTS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1548) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1549), message: 'first' });
    const delivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('steer was not delivered')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type === 'message_end' && event.message?.role === 'user' && event.message.content === 'delivered') {
          clearTimeout(timer); unsubscribe(); resolve();
        }
      });
    });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1550), message: 'delivered', streamingBehavior: 'steer' });
    await delivered;
    await actor.stopCodexSession(created.value);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.steering, []);
    await actor.promptCodexSession(created.value, { requestId: requestId(1557), message: 'resume' });
    await actor.stopCodexSession(created.value);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'turn/steer').length, 1);
  });
});

test('a Codex steer arriving after the run settles starts a new turn', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1541) }, options);
    assert.equal(created.ok, true);
    const result = await commandRuntime(created.value.sessionId, {
      type: 'prompt', requestId: requestId(1542), message: 'late steer', streamingBehavior: 'steer',
    });
    assert.equal(result.status, 200);
    assert.equal(actor.codexSessionState(created.value).isStreaming, true);
    await actor.stopCodexSession(created.value);
  });
});

test('Codex delivers a steer before a previously queued follow-up', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_USER_EVENTS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1551) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1552), message: 'first' });
    const delivered = [];
    const complete = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('queued messages were not delivered')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type !== 'message_end' || event.message?.role !== 'user') return;
        delivered.push(event.message.content);
        if (delivered.length === 1) process.kill(created.value.state.transport.child.pid, 'SIGUSR2');
        if (delivered.length === 2) { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1553), message: 'follow-up', streamingBehavior: 'followUp' });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1554), message: 'steer', streamingBehavior: 'steer' });
    await complete;
    assert.deepEqual(delivered, ['steer', 'follow-up']);
    await actor.stopCodexSession(created.value);
  });
});

test('an unconfirmed Codex steer stops automatic queue delivery', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_STEER_MODE = 'lost';
    options.requestTimeoutMs = 1000;
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1561) }, options);
    assert.equal(created.ok, true);
    await actor.promptCodexSession(created.value, { requestId: requestId(1562), message: 'first' });
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('turn did not end')); }, 5000);
      const unsubscribe = actor.subscribeCodexSession(created.value, event => {
        if (event.type === 'prompt_done') { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1563), message: 'unconfirmed', streamingBehavior: 'steer' });
    await commandRuntime(created.value.sessionId, { type: 'prompt', requestId: requestId(1564), message: 'follow-up', streamingBehavior: 'followUp' });
    process.kill(created.value.state.transport.child.pid, 'SIGUSR2');
    await ended;
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages, { steering: ['unconfirmed'], followUp: ['follow-up'] });
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'turn/start').length, 1);
    const recalled = await commandRuntime(created.value.sessionId, { type: 'clear_queue' });
    assert.deepEqual(recalled.body.data, { steering: ['unconfirmed'], followUp: ['follow-up'] });
  });
});

test('concurrent identical steers join while distinct requests are refused', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(51) }, options);
    assert.equal(created.ok, true);
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(52), message: 'start' });
    assert.equal(prompt.ok, true);
    const input = { requestId: requestId(53), message: 'steer' };
    const first = actor.steerCodexSession(created.value, input);
    const duplicate = actor.steerCodexSession(created.value, input);
    const other = await actor.steerCodexSession(created.value, { requestId: requestId(54), message: 'different' });
    assert.equal(other.error.kind, 'conflict');
    assert.equal((await first).ok, true);
    assert.equal((await duplicate).ok, true);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(s => s === 'turn/steer').length, 1);
    await actor.stopCodexSession(created.value);
  });
});

test('a lost steer response blocks further steers until the turn settles', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_STEER_MODE = 'lost';
    options.requestTimeoutMs = 1000;
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(55) }, options);
    assert.equal(created.ok, true);
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(56), message: 'start' });
    assert.equal(prompt.ok, true);
    const first = await actor.steerCodexSession(created.value, { requestId: requestId(57), message: 'steer' });
    assert.equal(first.error.operation, 'steer');
    const retry = await actor.steerCodexSession(created.value, { requestId: requestId(58), message: 'different' });
    assert.equal(retry.error.kind, 'outcome-unknown');
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(s => s === 'turn/steer').length, 1);
    await actor.stopCodexSession(created.value);
    const next = await actor.promptCodexSession(created.value, { requestId: requestId(59), message: 'new turn' });
    assert.equal(next.ok, true);
    const after = await actor.steerCodexSession(created.value, { requestId: requestId(60), message: 'new steer' });
    assert.equal(after.error.kind, 'outcome-unknown');
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(s => s === 'turn/steer').length, 2);
    await actor.stopCodexSession(created.value);
  });
});

test('one native question request splits and aggregates same-text questions exactly once', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_QUESTIONS = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(71) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    const started = await actor.promptCodexSession(created.value, { requestId: requestId(72), message: 'start' });
    assert.equal(started.ok, true);
    const questions = events.filter(event => event.type === 'agent_interaction_request');
    assert.equal(questions.length, 2);
    assert.notEqual(questions[0].id, questions[1].id);
    assert.equal(questions[0].questions[0].isSecret, true);
    const replay = [];
    const unsubscribe = actor.subscribeCodexSession(created.value, event => replay.push(event));
    assert.deepEqual(replay.filter(event => event.type === 'agent_interaction_request').map(event => event.id), questions.map(event => event.id));
    unsubscribe();
    assert.equal(actor.answerCodexInteraction(created.value, { id: questions[1].id, answers: { 'Same?': 'synthetic-response-23' } }).ok, true);
    assert.equal(actor.answerCodexInteraction(created.value, { id: questions[1].id, answers: { 'Same?': 'synthetic-response-23' } }).error.kind, 'conflict');
    assert.equal(actor.answerCodexInteraction(created.value, { id: 'wrong-rpc', answers: { 'Same?': 'synthetic-secret-19' } }).error.kind, 'conflict');
    assert.equal(actor.answerCodexInteraction(created.value, { id: questions[0].id, answers: { 'Same?': 'synthetic-secret-19' } }).ok, true);
    let requests = '';
    for (let i = 0; i < 50; i++) {
      requests = await readFile(log, 'utf8');
      if (requests.includes('question-answers:true')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(requests.split('\n').filter(line => line === 'question-answers:true').length, 1);
    assert.equal(requests.includes('synthetic-secret-19'), false);
    assert.equal(JSON.stringify(events).includes('synthetic-secret-19'), false);
    await actor.stopCodexSession(created.value);
  });
});

test('removed cwd preserves runtime Stop and approval Cancel without allowing steer', async () => {
  for (const [index, action] of ['abort', 'cancel'].entries()) {
    await fixture(async ({ dir, options, log }) => {
      const cwd = join(dir, 'removed-active-work');
      await mkdir(cwd);
      options.env.TEST_CWD = cwd;
      options.env.TEST_HOLD = '1'; options.env.TEST_APPROVAL = 'command';
      const created = await actor.createCodexSession({ cwd, requestId: requestId(9810 + index * 3) }, options);
      assert.equal(created.ok, true);
      const events = [];
      const unsubscribe = actor.subscribeCodexSession(created.value, event => events.push(event));
      try {
        const started = await actor.promptCodexSession(created.value, { message: 'start', requestId: requestId(9811 + index * 3) });
        assert.equal(started.ok, true);
        const approval = events.find(event => event.type === 'agent_interaction_request');
        assert.ok(approval);
        await rm(cwd, { recursive: true });
        const steer = await actor.steerCodexSession(created.value, { message: 'do not steer into a removed project', requestId: requestId(9812 + index * 3) });
        assert.equal(steer.ok, false);
        assert.equal(steer.error.kind, 'cwd-missing');
        if (action === 'cancel') {
          const cancelled = await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: approval.id, cancelled: true });
          assert.equal(cancelled.status, 200);
        }
        const stopped = await commandRuntime(created.value.sessionId, { type: 'abort' });
        assert.equal(stopped.status, 200);
        await started.value.completion;
        let lines = [];
        for (let attempt = 0; attempt < 50; attempt++) {
          lines = (await readFile(log, 'utf8')).split('\n');
          if (lines.includes('approval-decision:cancel')) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(lines.filter(line => line === 'approval-decision:cancel').length, 1, `${action}: ${lines.join(', ')}`);
        assert.equal(lines.filter(line => line === 'turn/interrupt').length, 1);
        assert.equal(lines.includes('turn/steer'), false);
        assert.equal(actor.codexSessionState(created.value).isStreaming, false);
      } finally { unsubscribe(); }
    });
  }
});

test('cancelling or stopping a split question settles its native RPC once', async () => {
  for (const [n, action] of [[95, 'cancel'], [98, 'stop']]) {
    await fixture(async ({ dir, options, log }) => {
      options.env.TEST_HOLD = '1'; options.env.TEST_QUESTIONS = '1';
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(n) }, options);
      const events = [];
      actor.subscribeCodexSession(created.value, event => events.push(event));
      await actor.promptCodexSession(created.value, { requestId: requestId(n + 1), message: 'start' });
      const questions = events.filter(event => event.type === 'agent_interaction_request');
      assert.equal(questions.length, 2);
      if (action === 'cancel') assert.equal((await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: questions[0].id, cancelled: true })).status, 200);
      else await actor.stopCodexSession(created.value);
      assert.equal((await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: questions[1].id, answers: { 'Same?': 'x' } })).status, 409);
      let requests = '';
      for (let i = 0; i < 50; i++) {
        requests = await readFile(log, 'utf8');
        if (requests.includes('question-count:0')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(requests.split('\n').filter(line => line === 'question-count:0').length, 1);
      if (action === 'cancel') await actor.stopCodexSession(created.value);
    });
  }
});

test('command and file approvals answer once and stop cancels a pending approval', async () => {
  for (const [n, kind] of [[80, 'command'], [83, 'file']]) {
    await fixture(async ({ dir, options, log }) => {
      options.env.TEST_HOLD = '1'; options.env.TEST_APPROVAL = kind;
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(n) }, options);
      const events = [];
      actor.subscribeCodexSession(created.value, event => events.push(event));
      await actor.promptCodexSession(created.value, { requestId: requestId(n + 1), message: 'start' });
      const approval = events.find(event => event.type === 'agent_interaction_request');
      assert.ok(approval);
      const response = await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: approval.id, approved: kind === 'command' });
      assert.equal(response.status, 200);
      assert.equal((await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: approval.id, approved: true })).status, 409);
      await actor.stopCodexSession(created.value);
      const lines = (await readFile(log, 'utf8')).split('\n');
      assert.equal(lines.filter(line => line === `approval-decision:${kind === 'command' ? 'accept' : 'decline'}`).length, 1);
    });
  }
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_APPROVAL = 'command';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(86) }, options);
    await actor.promptCodexSession(created.value, { requestId: requestId(87), message: 'start' });
    await actor.stopCodexSession(created.value);
    let requests = '';
    for (let i = 0; i < 50; i++) {
      requests = await readFile(log, 'utf8');
      if (requests.includes('approval-decision:cancel')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(requests.split('\n').filter(line => line === 'approval-decision:cancel').length, 1);
  });
});

test('an actor with no subscriber is reaped after its work finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await fixture(async ({ dir, options }) => {
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1139) }, options);
      assert.equal(created.ok, true);
      t.mock.timers.tick(600000);
      assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
      t.mock.timers.reset();
      await actor.shutdownCodexSession(created.value);
    });
  } finally { t.mock.timers.reset(); }
});

test('idle reaping waits for the last subscriber and lease lookup does not renew it', async t => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1140) }, options);
    const unsubscribe = actor.subscribeCodexSession(created.value, () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      t.mock.timers.tick(600000);
      assert.equal(actor.getCodexSession(created.value.sessionId), created.value);
      unsubscribe();
      t.mock.timers.tick(599999);
      assert.equal(actor.codexLeaseState(created.value).alive, true);
      t.mock.timers.tick(1);
      assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    } finally { t.mock.timers.reset(); await actor.shutdownCodexSession(created.value); }
  });
});

test('Codex retains stopped queued messages until they are recalled, then can be reaped', async t => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1170) }, options);
    const unsubscribe = actor.subscribeCodexSession(created.value, () => {});
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(1171), message: 'first' });
    const queued = await commandRuntime(created.value.sessionId, { type: 'prompt', streamingBehavior: 'followUp', message: 'pending', requestId: requestId(1172) });
    assert.equal(queued.status, 200);
    assert.deepEqual(actor.codexSessionState(created.value).queuedMessages.followUp, ['pending']);
    await actor.stopCodexSession(created.value);
    await prompt.value.completion;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      unsubscribe();
      t.mock.timers.tick(600000);
      assert.equal(actor.getCodexSession(created.value.sessionId), created.value);
      const recalled = await commandRuntime(created.value.sessionId, { type: 'clear_queue' });
      assert.deepEqual(recalled.body.data, { steering: [], followUp: ['pending'] });
      t.mock.timers.tick(600000);
      assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    } finally { t.mock.timers.reset(); await actor.shutdownCodexSession(created.value); }
  });
});

test('Codex returns pending messages when an unresponsive Stop closes the native process', async t => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_IGNORE_INTERRUPT = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1173) }, options);
    const events = [];
    const unsubscribe = actor.subscribeCodexSession(created.value, event => events.push(event));
    await actor.promptCodexSession(created.value, { requestId: requestId(1174), message: 'first' });
    const steer = await commandRuntime(created.value.sessionId, { type: 'prompt', streamingBehavior: 'steer', message: 'uncertain steer', requestId: requestId(1175) });
    const followUp = await commandRuntime(created.value.sessionId, { type: 'prompt', streamingBehavior: 'followUp', message: 'pending', requestId: requestId(1176) });
    assert.equal(steer.status, 200);
    assert.equal(followUp.status, 200);
    await new Promise(resolve => setTimeout(resolve, 120));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stopping = actor.stopCodexSession(created.value);
    t.mock.timers.tick(30000);
    t.mock.timers.reset();
    const stopped = await stopping;
    unsubscribe();
    assert.equal(stopped.ok, true);
    assert.deepEqual(stopped.value.steering, ['uncertain steer']);
    assert.deepEqual(stopped.value.followUp, ['pending']);
    assert.ok(events.some(event => event.type === 'prompt_error' && /could not confirm the queued steer/i.test(event.errorMessage)));
    assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
  });
});

test('idle cleanup defers across capture and respects a new subscriber', async t => {
  for (const [index, reconnect] of [false, true].entries()) {
    await fixture(async ({ dir, options }) => {
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1150 + index) }, options);
      const unsubscribe = actor.subscribeCodexSession(created.value, () => {});
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let release;
      const held = new Promise(resolve => { release = resolve; });
      let captured;
      try {
        unsubscribe();
        captured = actor.withCodexHandoffSnapshot(created.value.sessionId, () => held);
        t.mock.timers.tick(600000);
        assert.equal(actor.getCodexSession(created.value.sessionId), created.value);
        if (reconnect) actor.subscribeCodexSession(created.value, () => {});
        release('snapshot');
        assert.equal(await captured, 'snapshot');
        assert.equal(actor.getCodexSession(created.value.sessionId), reconnect ? created.value : undefined);
      } finally { release(); if (captured) await captured.catch(() => {}); t.mock.timers.reset(); await actor.shutdownCodexSession(created.value); }
    });
  }
});

test('active prompt, approval and settings work cannot be reaped', async t => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_APPROVAL = 'command';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1160) }, options);
    const unsubscribe = actor.subscribeCodexSession(created.value, () => {});
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(1161), message: 'start' });
    unsubscribe();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try { t.mock.timers.tick(600000); assert.equal(actor.getCodexSession(created.value.sessionId), created.value); }
    finally { t.mock.timers.reset(); }
    await actor.stopCodexSession(created.value);
    await prompt.value.completion;
    const second = actor.subscribeCodexSession(created.value, () => {});
    const pending = actor.updateCodexSettings(created.value, { model: 'test', effort: 'low' });
    second();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try { t.mock.timers.tick(600000); assert.equal(actor.getCodexSession(created.value.sessionId), created.value); }
    finally { t.mock.timers.reset(); }
    assert.equal((await pending).ok, true);
  });
});

test('native inventory work prevents idle reaping', async t => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1162) }, options);
    const unsubscribe = actor.subscribeCodexSession(created.value, () => {});
    const original = CodexTransport.prototype.request;
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    CodexTransport.prototype.request = async function(method, ...args) {
      if (method !== 'mcpServerStatus/list') return original.call(this, method, ...args);
      entered(); await held;
      return { data: [], nextCursor: null };
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let pending;
    try {
      unsubscribe();
      pending = actor.codexMcp(created.value);
      await started;
      t.mock.timers.tick(600000);
      assert.equal(actor.getCodexSession(created.value.sessionId), created.value);
    } finally { t.mock.timers.reset(); release(); CodexTransport.prototype.request = original; }
    assert.equal((await pending).ok, true);
  });
});

test('native activity stays visible through lifecycle, progress and history reconciliation', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_ACTIVITY = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1130) }, options);
    const events = [];
    let activeSnapshot;
    actor.subscribeCodexSession(created.value, event => {
      events.push(event);
      if (event.type === 'tool_execution_update' && event.toolCallId === 'activity-command') activeSnapshot = actor.codexTurnSnapshot(created.value);
    });
    const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(1131), message: 'start' });
    assert.equal((await prompt.value.completion).kind, 'completed');
    const activity = events.filter(event => event.toolCallId?.startsWith('activity-'));
    for (const id of ['activity-command', 'activity-file', 'activity-mcp', 'activity-dynamic', 'activity-early']) {
      assert.equal(activity.filter(event => event.toolCallId === id && event.type === 'tool_execution_start').length, 1, id);
      assert.equal(activity.filter(event => event.toolCallId === id && event.type === 'tool_execution_end').length, 1, id);
    }
    assert.match(JSON.stringify(activity.find(event => event.type === 'tool_execution_update' && event.toolCallId === 'activity-command')), /step one and two/);
    assert.match(JSON.stringify(activity.find(event => event.type === 'tool_execution_update' && event.toolCallId === 'activity-mcp')), /searching docs/);
    const mcpMessages = events.filter(event => event.type === 'message_end' && event.entryId === 'activity-mcp');
    assert.equal(mcpMessages.at(-2).message.content, 'searching docs');
    assert.doesNotMatch(JSON.stringify(events), /SENTINEL_ACTIVITY_RPC/);
    const started = activeSnapshot.items.find(item => item.id === 'activity-command');
    assert.equal(started.completed, false);
    assert.equal(started.message.output, 'step one and two');
    const final = events.filter(event => event.type === 'message_end' && event.entryId?.startsWith('activity-'));
    const latest = [...new Map(final.map(event => [event.entryId, event.message])).entries()];
    assert.deepEqual(latest.map(([id]) => id), ['activity-command', 'activity-file', 'activity-mcp', 'activity-dynamic', 'activity-early']);
    assert.equal(latest[0][1].output, 'final output');
    assert.equal(latest[1][1].details.changes[0].path, 'src/a.ts');
    assert.equal(latest[2][1].content, 'useful result');
    assert.equal(latest[3][1].content, 'dynamic result');
    assert.equal(latest[4][1].output, 'early output final');
    assert(events.some(event => event.type === 'message_end' && event.entryId === 'activity-early' && event.message.output === 'early output'));
    const liveIds = new WeakMap(), keys = new WeakMap();
    const live = reconcileCodexSnapshot([], [], liveIds, keys, latest.map(([id, message]) => ({ id, message, completed: true })));
    const historyThread = { id: threadId, sessionId: threadId, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: dir, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [{ id: 'turn-1', status: 'completed', items: [
      { type: 'commandExecution', id: 'activity-command', command: 'printf hello', cwd: dir, commandActions: [], status: 'completed', aggregatedOutput: 'final output', exitCode: 0 },
      { type: 'fileChange', id: 'activity-file', status: 'completed', changes: [{ path: 'src/a.ts', diff: '+hello', kind: { type: 'update' } }] },
      { type: 'mcpToolCall', id: 'activity-mcp', status: 'completed', server: 'docs', tool: 'lookup', arguments: {}, result: { content: [{ type: 'text', text: 'useful result' }] } },
      { type: 'dynamicToolCall', id: 'activity-dynamic', status: 'completed', tool: 'inspect', arguments: {}, contentItems: [{ type: 'inputText', text: 'dynamic result' }] },
      { type: 'commandExecution', id: 'activity-early', command: 'printf early', cwd: dir, commandActions: [], status: 'completed', aggregatedOutput: 'early output final', exitCode: 0 },
    ] }] };
    const persisted = projectCodexHistory(historyThread, { tail: 10 }).context;
    assert.deepEqual(persisted.messages, latest.map(([, message]) => message));
    assert.equal(mergeCodexHistory({ entryIds: [], messages: live }, persisted, liveIds).length, 5);
  });
});

test('omitted approval decisions can be safely cancelled without leaking native params', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_APPROVAL = 'omitted';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1100) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    await actor.promptCodexSession(created.value, { requestId: requestId(1101), message: 'start' });
    const approval = events.find(event => event.type === 'agent_interaction_request');
    assert.deepEqual(approval.approvalOptions, { accept: false, decline: false });
    assert.equal(approval.input.command, 'pwd');
    assert.equal(approval.input.cwd, dir);
    assert.doesNotMatch(JSON.stringify(approval), /SENTINEL_APPROVAL_RPC|threadId|turnId|itemId/);
    assert.equal(actor.answerCodexInteraction(created.value, { id: approval.id, cancelled: true }).ok, true);
    assert.equal(actor.answerCodexInteraction(created.value, { id: approval.id, cancelled: true }).ok, false);
    await actor.stopCodexSession(created.value);
    await actor.shutdownCodexSession(created.value);
    const lines = (await readFile(log, 'utf8')).split('\n');
    assert.equal(lines.filter(line => line === 'reply:-32603').length, 1);
    assert.equal(lines.some(line => line.startsWith('approval-decision:')), false);
  });
});

test('failed native turns and error notifications show sanitized errors and settle once', async () => {
  for (const [index, mode] of ['turn', 'error', 'retry', 'retry-failed', 'retry-error'].entries()) {
    await fixture(async ({ dir, options }) => {
      options.env.TEST_NATIVE_FAILURE = mode;
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1110 + index * 2) }, options);
      assert.ok(created.ok, "native create failed: " + JSON.stringify(created));
      const events = [];
      actor.subscribeCodexSession(created.value, event => events.push(event));
      const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(1111 + index * 2), message: 'start' });
      assert.equal((await prompt.value.completion).kind, mode === 'retry' ? 'completed' : 'failed');
      assert.equal(events.filter(event => event.type === 'prompt_done').length, 1);
      assert.equal(events.filter(event => event.type === 'prompt_error').length, mode.startsWith('retry-') ? 2 : 1);
      assert.equal(typeof events.find(event => event.type === 'prompt_error').errorMessage, 'string');
      assert.doesNotMatch(JSON.stringify(events), /SENTINEL_PRIVATE_ERROR/);
    });
  }
});

test('unexpected idle process exit evicts its actor before another prompt is journaled', async () => {
  await fixture(async ({ dir, options, log }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1120) }, options);
    const events = [];
    let notify;
    const shutdown = new Promise(resolve => { notify = resolve; });
    actor.subscribeCodexSession(created.value, event => { events.push(event); if (event.type === 'session_shutdown') notify(); });
    const pid = Number((await readFile(log, 'utf8')).match(/pid:(\d+)/)[1]);
    process.kill(pid, 'SIGUSR1');
    await shutdown;
    assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    assert.equal(events.filter(event => event.type === 'prompt_error').length, 1);
    assert.equal(events.filter(event => event.type === 'session_shutdown').length, 1);
    const old = await actor.promptCodexSession(created.value, { requestId: requestId(1121), message: 'not sent' });
    assert.equal(old.ok, false);
    await assert.rejects(readFile(join(process.env.PI_CODING_AGENT_DIR, 'pi-web-codex-mutations', 'prompt', requestId(1121), 'record.json')));
    const replacement = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(replacement.ok, true);
    assert.notEqual(replacement.value, created.value);
    const next = await actor.promptCodexSession(replacement.value, { requestId: requestId(1122), message: 'new prompt' });
    assert.equal(next.ok, true);
    assert.equal((await next.value.completion).kind, 'completed');
    await actor.shutdownCodexSession(created.value);
    assert.equal(actor.getCodexSession(created.value.sessionId), replacement.value);
  });
});

test('unexpected idle exit delivers a visible SSE error and closes the stream', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1126) }, options);
    const controller = new AbortController();
    const response = await runtimeEvents(created.value.sessionId, controller.signal, { holder: null, address: null, client: null });
    assert.equal(response.kind, 'stream');
    const reader = response.stream.getReader();
    const events = [];
    let connected;
    const ready = new Promise(resolve => { connected = resolve; });
    const consume = (async () => {
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += new TextDecoder().decode(chunk.value);
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6)); events.push(event);
          if (event.type === 'connected') connected();
        }
      }
    })();
    try {
      await ready;
      process.kill(created.value.state.transport.child.pid, 'SIGUSR1');
      let guard;
      try { await Promise.race([consume, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('SSE did not close')), 3000); })]); }
      finally { clearTimeout(guard); }
      assert.equal(events.filter(event => event.type === 'prompt_error').length, 1);
      assert.equal(typeof events.find(event => event.type === 'prompt_error').errorMessage, 'string');
      assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    } finally { controller.abort(); await consume; }
  });
});

test('a closed input pipe is rejected before prompt journal admission', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1124) }, options);
    created.value.state.transport.child.stdin.destroy();
    const result = await actor.promptCodexSession(created.value, { requestId: requestId(1125), message: 'cannot be sent' });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'transport-fatal');
    await assert.rejects(readFile(join(process.env.PI_CODING_AGENT_DIR, 'pi-web-codex-mutations', 'prompt', requestId(1125), 'record.json')), error => error.code === 'ENOENT');
    assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
  });
});

test('process exit during capture defers eviction and invalidates the snapshot', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1123) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const capture = actor.withCodexHandoffSnapshot(created.value.sessionId, () => held);
    const child = created.value.state.transport.child;
    const exited = new Promise(resolve => child.once('exit', resolve));
    process.kill(child.pid, 'SIGUSR1');
    try {
      await exited;
      assert.equal(actor.getCodexSession(created.value.sessionId), created.value);
      assert.equal(events.some(event => event.type === 'session_shutdown'), false);
    } finally { release('obsolete'); }
    await assert.rejects(capture, error => error.reason === 'source-changed');
    assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    assert.equal(events.filter(event => event.type === 'session_shutdown').length, 1);
    const replacement = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(replacement.ok, true);
    assert.notEqual(replacement.value, created.value);
  });
});

test('richer command approvals never send an unlisted decision', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_APPROVAL = 'rich';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(93) }, options);
    const events = [];
    actor.subscribeCodexSession(created.value, event => events.push(event));
    await actor.promptCodexSession(created.value, { requestId: requestId(94), message: 'start' });
    const approval = events.find(event => event.type === 'agent_interaction_request');
    assert.deepEqual(approval.approvalOptions, { accept: false, decline: true });
    assert.equal((await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: approval.id, approved: true })).status, 409);
    assert.equal((await commandRuntime(created.value.sessionId, { type: 'answer_interaction', id: approval.id, approved: false })).status, 200);
    await actor.stopCodexSession(created.value);
    const lines = (await readFile(log, 'utf8')).split('\n');
    assert.equal(lines.filter(line => line === 'approval-decision:decline').length, 1);
    assert.equal(lines.some(line => line === 'approval-decision:accept' || line === 'approval-decision:acceptForSession'), false);
  });
});

test('runtime rejects interaction answers from another process generation or RPC', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1'; options.env.TEST_QUESTIONS = '1';
    const first = await actor.createCodexSession({ cwd: dir, requestId: requestId(90) }, options);
    const oldEvents = [];
    actor.subscribeCodexSession(first.value, event => oldEvents.push(event));
    await actor.promptCodexSession(first.value, { requestId: requestId(91), message: 'start' });
    const old = oldEvents.find(event => event.type === 'agent_interaction_request');
    assert.equal((await commandRuntime(first.value.sessionId, { type: 'answer_interaction', id: 'wrong-rpc', answers: { 'Same?': 'x' } })).status, 409);
    await actor.shutdownCodexSession(first.value);
    const replacement = await actor.ensureCodexSession(first.value.sessionId, options);
    assert.equal(replacement.ok, true);
    await actor.promptCodexSession(replacement.value, { requestId: requestId(92), message: 'new turn' });
    const stale = await commandRuntime(first.value.sessionId, { type: 'answer_interaction', id: old.id, answers: { 'Same?': 'x' } });
    assert.equal(stale.status, 409);
    await actor.stopCodexSession(replacement.value);
  });
});

test('native steer rejection is definitive', async () => {
  await fixture(async ({ dir, options }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_STEER_MODE = 'reject';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(68) }, options);
    await actor.promptCodexSession(created.value, { requestId: requestId(69), message: 'start' });
    const rejected = await actor.steerCodexSession(created.value, { requestId: requestId(70), message: 'steer' });
    assert.equal(rejected.error.kind, 'native-rejected');
    assert.equal(rejected.error.code, -32600);
    await actor.stopCodexSession(created.value);
  });
});

test('legacy server approval requests are refused without approval', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_LEGACY = '1';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(66) }, options);
    const turn = await actor.promptCodexSession(created.value, { requestId: requestId(67), message: 'start' });
    assert.equal(turn.ok, true);
    await turn.value.completion;
    let requests = '';
    for (let i = 0; i < 50; i++) {
      requests = await readFile(log, 'utf8');
      if (requests.includes('reply:-32601')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(requests, /reply:-32601/);
  });
});

test('transport death settles the old turn without resending its steer', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_HOLD = '1';
    options.env.TEST_STEER_MODE = 'die';
    options.env.TEST_STEER_MARKER = join(dir, 'steer-died');
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(61) }, options);
    const firstTurn = await actor.promptCodexSession(created.value, { requestId: requestId(62), message: 'start' });
    assert.equal(firstTurn.ok, true);
    const lost = await actor.steerCodexSession(created.value, { requestId: requestId(63), message: 'steer' });
    assert.equal(lost.error.kind, 'outcome-unknown');
    assert.equal((await firstTurn.value.completion).kind, 'transport-fatal');
    const resumed = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(resumed.ok, true);
    const lines = (await readFile(log, 'utf8')).split('\n');
    const resumePayloadLine = lines.slice(lines.indexOf('thread/resume')).find(line => line.startsWith('start-payload:'));
    const resumePayload = JSON.parse(resumePayloadLine.replace(/^start-payload:/, ''));
    assert.equal(resumePayload.approvalPolicy, 'never');
    assert.equal(resumePayload.sandbox, 'danger-full-access');
    const next = await actor.promptCodexSession(resumed.value, { requestId: requestId(64), message: 'new turn' });
    assert.equal(next.ok, true);
    const steer = await actor.steerCodexSession(resumed.value, { requestId: requestId(65), message: 'new steer' });
    assert.equal(steer.ok, true);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(s => s === 'turn/steer').length, 2);
    await actor.stopCodexSession(resumed.value);
  });
});

test('runtime SSE settles each terminal turn once, including transport death and shutdown', async () => {
  for (const [index, mode] of ['completed', 'interrupted', 'shutdown', 'fatal', 'failed', 'native-error'].entries()) {
    await fixture(async ({ dir, options }) => {
      if (['interrupted', 'shutdown', 'fatal'].includes(mode)) options.env.TEST_HOLD = '1';
      if (mode === 'fatal') options.env.TEST_EXIT = '1';
      if (mode === 'failed') options.env.TEST_NATIVE_FAILURE = 'turn';
      if (mode === 'native-error') options.env.TEST_NATIVE_FAILURE = 'error';
      const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(1200 + index * 2) }, options);
      assert.equal(created.ok, true);
      const controller = new AbortController();
      const response = await runtimeEvents(created.value.sessionId, controller.signal, { holder: null, address: null, client: null });
      assert.equal(response.kind, 'stream');
      const reader = response.stream.getReader();
      const observed = [];
      let buffer = '';
      let notify;
      const settled = new Promise(resolve => { notify = resolve; });
      const reading = (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += new TextDecoder().decode(chunk.value);
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (!frame.startsWith('data: ')) continue;
            const event = JSON.parse(frame.slice(6)); observed.push(event);
            if (event.type === 'connected') notify('connected');
            if (event.type === 'agent_settled') notify('settled');
          }
        }
      })();
      assert.equal(await settled, 'connected');
      const done = new Promise(resolve => { notify = resolve; });
      const prompt = await actor.promptCodexSession(created.value, { requestId: requestId(1201 + index * 2), message: 'hello' });
      assert.equal(prompt.ok, true);
      if (mode === 'interrupted') await actor.stopCodexSession(created.value);
      if (mode === 'shutdown') await actor.shutdownCodexSession(created.value);
      let timer;
      try { assert.equal(await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 15000); })]), 'settled', mode); }
      finally { clearTimeout(timer); }
      controller.abort();
      await reading;
      const events = observed.filter(event => ['agent_start', 'prompt_done', 'prompt_error', 'agent_settled', 'error'].includes(event.type));
      assert.equal(events.filter(event => event.type === 'agent_settled').length, 1, mode);
      assert.equal(events.at(-1).type, 'agent_settled', mode);
      assert.equal(events.at(-1).aborted, mode === 'interrupted' || mode === 'shutdown' || mode === 'fatal', mode);
      if (['completed', 'interrupted', 'failed', 'native-error'].includes(mode)) assert.equal(events.at(-2).type, 'prompt_done', mode);
      if (mode === 'fatal') assert.equal(events.at(-2).type, 'error');
      if (['fatal', 'failed', 'native-error'].includes(mode)) {
        const errors = events.filter(event => event.type === 'prompt_error');
        assert.equal(errors.length, 1, mode);
        assert.equal(typeof errors[0].errorMessage, 'string');
        assert.doesNotMatch(JSON.stringify(errors), /SENTINEL_PRIVATE_ERROR/);
      }
    });
  }
});

test('native catalogue is complete, preserves id/model, and creates no thread', async () => {
  await fixture(async ({ dir, options, log }) => {
    const catalogue = await actor.codexModels(dir, undefined, options);
    assert.equal(catalogue.ok, true);
    assert.deepEqual(catalogue.value.map(row => [row.id, row.model, row.defaultEffort]), [['display-id', 'test', 'low'], ['other-id', 'other', 'medium']]);
    assert.ok(catalogue.value[0].efforts.some(row => row.value === 'future'));
    assert.equal((await readFile(log, 'utf8')).includes('thread/start'), false);
    for (const mode of ['cycle', 'invalid', 'missing']) {
      options.env.TEST_CATALOGUE = mode;
      assert.equal((await actor.codexModels(dir, undefined, options)).ok, false, mode);
    }
  });
});

test('atomic native initial effort has one start and effort identity conflict', async () => {
  await fixture(async ({ dir, options, log }) => {
    const input = { cwd: dir, requestId: requestId(801), model: 'test', effort: 'ultra' };
    const created = await actor.createCodexSession(input, options);
    assert.equal(created.ok, true);
    assert.deepEqual(actor.codexSessionState(created.value).settings, { backend: 'codex', model: 'test', modelProvider: 'test', effort: 'ultra' });
    const requests = (await readFile(log, 'utf8')).split('\n');
    assert.equal(requests.filter(row => row === 'thread/start').length, 1);
    assert.equal(requests.includes('thread/settings/update'), false);
    assert.deepEqual(JSON.parse(requests.find(row => row.startsWith('start-payload:')).slice('start-payload:'.length)), { cwd: dir, approvalPolicy: 'never', sandbox: 'danger-full-access', model: 'test', config: { model_reasoning_effort: 'ultra' } });
    assert.equal((await actor.createCodexSession({ ...input, effort: 'max' }, options)).error.kind, 'conflict');
    assert.equal((await actor.createCodexSession({ cwd: dir, requestId: requestId(802), effort: 'ultra' }, options)).error.kind, 'invalid');
  });
});

test('settings notification before acknowledgement is authoritative and shares prompt admission', async () => {
  await fixture(async ({ dir, options, log }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(803) }, options);
    const updating = actor.updateCodexSettings(created.value, { model: 'test', effort: 'ultra' });
    assert.equal((await actor.promptCodexSession(created.value, { requestId: requestId(804), message: 'blocked' })).error.kind, 'conflict');
    const updated = await updating;
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.value, { backend: 'codex', model: 'test', modelProvider: 'native-provider', effort: 'ultra' });
    assert.deepEqual(actor.codexSessionState(created.value).settings, updated.value);
    assert.equal((await actor.updateCodexSettings(created.value, { model: 'other', effort: 'ultra' })).error.kind, 'invalid');
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(row => row === 'thread/settings/update').length, 1);
    const replay = [];
    actor.subscribeCodexSession(created.value, event => replay.push(event));
    assert.deepEqual(replay[0], { type: 'session_settings', settings: updated.value });
  });
});

for (const mode of ['missing', 'wrong', 'die']) test(`settings ${mode} does not synthesize effective state or replay`, async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_SETTINGS = mode;
    options.requestTimeoutMs = 2_000;
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(810 + ['missing', 'wrong', 'die'].indexOf(mode)) }, options);
    const before = actor.codexSessionState(created.value).settings;
    const result = await actor.updateCodexSettings(created.value, { model: 'test', effort: 'max' });
    assert.deepEqual(result.error, { kind: 'outcome-unknown', operation: 'settings' });
    assert.deepEqual(actor.codexSessionState(created.value).settings, before);
    assert.equal((await actor.promptCodexSession(created.value, { requestId: requestId(820), message: 'blocked' })).error.kind, mode === 'die' ? 'transport-fatal' : 'closed');
    assert.equal((await actor.updateCodexSettings(created.value, { model: 'test', effort: 'max' })).error.kind, 'closed');
    assert.equal(actor.getCodexSession(created.value.sessionId), undefined);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(row => row === 'thread/settings/update').length, 1);
  });
});

test('runtime accepts one complete settings operation and refuses Pi fields and effort-only commands', async () => {
  await fixture(async ({ dir, options }) => {
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(850) }, options);
    for (const body of [{ type: 'set_settings', effort: 'ultra' }, { type: 'set_settings', model: 'test', effort: 'ultra', provider: 'codex' }, { type: 'set_thinking_level', level: 'high' }]) {
      assert.equal((await commandRuntime(created.value.sessionId, body)).status, 400);
    }
    const result = await commandRuntime(created.value.sessionId, { type: 'set_settings', model: 'test', effort: 'future' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.effort, 'future');
    const state = await commandRuntime(created.value.sessionId, { type: 'get_state' });
    assert.deepEqual(state.body.data.settings, result.body.data);
  });
});

test('shutdown during settings settles uncertainty once and a new generation does not inherit pending settings', async () => {
  await fixture(async ({ dir, options, log }) => {
    options.env.TEST_SETTINGS = 'missing';
    const created = await actor.createCodexSession({ cwd: dir, requestId: requestId(851) }, options);
    const pending = actor.updateCodexSettings(created.value, { model: 'test', effort: 'max' });
    await new Promise(resolve => setTimeout(resolve, 80));
    await actor.shutdownCodexSession(created.value);
    assert.equal((await pending).error.operation, 'settings');
    const resumed = await actor.ensureCodexSession(created.value.sessionId, options);
    assert.equal(resumed.ok, true);
    assert.equal(actor.codexSessionState(resumed.value).settings.effort, 'low');
    assert.equal(actor.codexSessionState(resumed.value).settingsPending, false);
    assert.equal(actor.codexSessionState(resumed.value).settingsUncertain, false);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(row => row === 'thread/settings/update').length, 1);
  });
});
