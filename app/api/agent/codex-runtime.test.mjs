import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { isolateClaudeHome, isolatePiHome } from '../../../lib/claude-test-home.mjs';

await isolateClaudeHome();
await isolatePiHome();
process.env.PI_WEB_CODEX = '1';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runCodexMutationOnce } = await jiti.import('../../../lib/agent-backends/codex/mutation-journal.ts');
const { createCodexSession, getCodexSession, shutdownCodexSession } = await jiti.import('../../../lib/agent-backends/codex.ts');
const { getAllowedFileRoots, isExistingFilePathAllowed } = await jiti.import('../../../lib/file-access.ts');
const eventsRoute = await jiti.import('./[id]/events/route.ts');
const historyRoute = await jiti.import('../sessions/[id]/route.ts');
const newRoute = await jiti.import('./new/route.ts');
const commandRoute = await jiti.import('./[id]/route.ts');
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const post = body => new Request('http://localhost/api/agent/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('unknown backends never start a Pi runtime', async () => {
  const response = await newRoute.POST(post({ backend: 'unknown', type: 'ensure_session', cwd: '/tmp', requestId: uuid(20) }));
  assert.equal(response.status, 400);
});

test('pending create or prompt returns outcome unknown without dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-api-'));
  const binary = join(dir, 'codex');
  const log = join(dir, 'requests');
  const threadId = '01900000-0000-7000-8000-000000000002';
  let actor;
  try {
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(); }
const id = '${threadId}';
const thread = { id, sessionId: id, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: process.env.TEST_CWD, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] };
readline.createInterface({ input: process.stdin }).on('line', line => { const q = JSON.parse(line); fs.appendFileSync(process.env.TEST_LOG, q.method + '\\n'); if (!('id' in q)) return; const result = q.method === 'initialize' ? { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' } : { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: process.env.TEST_CWD, model: 'test', modelProvider: 'test', sandbox: { type: 'readOnly' } }; console.log(JSON.stringify({ id: q.id, result })); });
`);
    await chmod(binary, 0o700);
    const createId = uuid(1);
    await runCodexMutationOnce({ kind: 'create', requestId: createId, scope: dir, digest: hash(['codex-create-v1', dir, null]) }, async () => { throw Error('lost'); });
    const createResponse = await newRoute.POST(post({ backend: 'codex', type: 'ensure_session', cwd: dir, requestId: createId }));
    const createBody = await createResponse.json();
    assert.equal(createResponse.status, 409); assert.equal(createBody.code, 'outcome_unknown'); assert.equal('accepted' in createBody, false);
    const created = await createCodexSession({ cwd: dir, requestId: uuid(2) }, { binary, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: join(dir, 'codex-home'), TEST_CWD: dir, TEST_LOG: log } });
    assert.equal(created.ok, true); actor = created.value;
    const promptId = uuid(3), message = 'hello';
    await runCodexMutationOnce({ kind: 'prompt', requestId: promptId, scope: actor.sessionId, digest: hash(['codex-prompt-v1', actor.sessionId, message]) }, async () => { throw Error('lost'); });
    const response = await commandRoute.POST(post({ type: 'prompt', requestId: promptId, message }), { params: Promise.resolve({ id: actor.sessionId }) });
    const body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.code, 'outcome_unknown'); assert.equal('accepted' in body, false);
    const requests = await readFile(log, 'utf8');
    assert.equal(requests.includes('turn/start'), false);
  } finally { if (actor) await shutdownCodexSession(actor); await rm(dir, { recursive: true, force: true }); }
});

test('resume refusal and definitive rejection retain typed HTTP bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-api-errors-'));
  const binary = join(dir, 'codex');
  const log = join(dir, 'requests');
  const nativeId = '01900000-0000-7000-8000-000000000003';
  const prior = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, PI_WEB_CODEX: process.env.PI_WEB_CODEX, TEST_CWD: process.env.TEST_CWD, TEST_LOG: process.env.TEST_LOG, TEST_MODE: process.env.TEST_MODE };
  let actor;
  try {
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(); }
const id = '${nativeId}';
const thread = { id, sessionId: id, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: process.env.TEST_CWD, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] };
const response = { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: process.env.TEST_CWD, model: 'test', modelProvider: 'test', sandbox: { type: 'readOnly' } };
readline.createInterface({ input: process.stdin }).on('line', line => { const q = JSON.parse(line); fs.appendFileSync(process.env.TEST_LOG, q.method + '\\n'); if (!('id' in q)) return; if ((q.method === 'thread/read' && process.env.TEST_MODE === 'read') || (q.method === 'thread/resume' && process.env.TEST_MODE === 'resume') || (q.method === 'thread/start' && process.env.TEST_MODE === 'reject')) return console.log(JSON.stringify({ id: q.id, error: { code: -32600, message: 'refused' } })); const result = q.method === 'initialize' ? { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' } : q.method === 'thread/read' ? { thread } : response; console.log(JSON.stringify({ id: q.id, result })); });
`);
    await chmod(binary, 0o700);
    Object.assign(process.env, { PATH: `${dir}:${prior.PATH}`, HOME: dir, CODEX_HOME: join(dir, 'codex-home'), TEST_CWD: dir, TEST_LOG: log, TEST_MODE: 'create' });
    assert.equal(isExistingFilePathAllowed(dir, await getAllowedFileRoots()), false);
    const created = await newRoute.POST(post({ backend: 'codex', type: 'ensure_session', cwd: dir, requestId: uuid(10) }));
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    actor = getCodexSession(createdBody.sessionId);
    assert.ok(actor);
    assert.equal(isExistingFilePathAllowed(dir, await getAllowedFileRoots()), true);
    const invalid = await commandRoute.POST(new Request('http://localhost/api/agent/command', { method: 'POST', body: '{' }), { params: Promise.resolve({ id: actor.sessionId }) });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'invalid_request');
    const liveState = await commandRoute.GET(new Request('http://localhost/api/agent/state'), { params: Promise.resolve({ id: actor.sessionId }) });
    assert.equal(liveState.status, 200); assert.equal((await liveState.json()).state.backend, 'codex');
    await shutdownCodexSession(actor); actor = undefined;
    const context = { params: Promise.resolve({ id: `codex:${nativeId}` }) };
    process.env.TEST_MODE = 'read';
    const unavailable = await eventsRoute.GET(new Request('http://localhost/api/events'), context);
    assert.equal(unavailable.status, 409); assert.equal((await unavailable.json()).code, 'thread_unavailable');
    const retry = await newRoute.POST(post({ backend: 'codex', type: 'ensure_session', cwd: dir, requestId: uuid(10) }));
    const retryBody = await retry.json();
    assert.equal(retry.status, 409); assert.equal(retryBody.code, 'thread_unavailable'); assert.equal(retryBody.sessionId, `codex:${nativeId}`);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'thread/start').length, 1);
    process.env.TEST_MODE = 'resume';
    const refused = await eventsRoute.GET(new Request('http://localhost/api/events'), context);
    assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'resume_refused');
    process.env.TEST_MODE = 'reject';
    const rejected = await newRoute.POST(post({ backend: 'codex', type: 'ensure_session', cwd: dir, requestId: uuid(11) }));
    const body = await rejected.json();
    assert.equal(rejected.status, 400); assert.equal(body.code, 'native_rejected'); assert.equal(body.nativeCode, -32600); assert.equal(body.accepted, false);
    process.env.PI_WEB_CODEX = '1';
    process.env.TEST_MODE = 'read';
    const history = await historyRoute.GET(new Request('http://localhost/api/sessions/current'), context);
    assert.equal(history.status, 503);
    assert.notEqual(history.status, 404);
    const historyBody = await history.json();
    assert.equal(historyBody.reason, 'history-unavailable');
    assert.equal('context' in historyBody, false);
    assert.equal('messages' in historyBody, false);
  } finally {
    if (actor) await shutdownCodexSession(actor);
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});

test('the command route sends steer once and refuses a concurrent different steer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-steer-route-'));
  const binary = join(dir, 'codex');
  const log = join(dir, 'requests');
  let actor;
  try {
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(); }
const id = '01900000-0000-7000-8000-000000000004';
const thread = { id, sessionId: id, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: process.env.TEST_CWD, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] };
const send = value => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line); fs.appendFileSync(process.env.TEST_LOG, q.method + '\\n');
  if (!('id' in q)) return;
  if (q.method === 'initialize') return send({ id: q.id, result: { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' } });
  if (q.method === 'thread/start') return send({ id: q.id, result: { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: process.env.TEST_CWD, model: 'test', modelProvider: 'test', sandbox: { type: 'readOnly' } } });
  if (q.method === 'turn/start') return send({ id: q.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
  if (q.method === 'turn/steer') return setTimeout(() => send({ id: q.id, result: { turnId: q.params.expectedTurnId } }), 100);
});
`);
    await chmod(binary, 0o700);
    const created = await createCodexSession({ cwd: dir, requestId: uuid(30) }, { binary, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: join(dir, 'codex-home'), TEST_CWD: dir, TEST_LOG: log } });
    assert.equal(created.ok, true); actor = created.value;
    const context = { params: Promise.resolve({ id: actor.sessionId }) };
    const prompt = await commandRoute.POST(post({ type: 'prompt', requestId: uuid(31), message: 'start' }), context);
    assert.equal(prompt.status, 200);
    const input = { type: 'prompt', requestId: uuid(32), message: 'steer', streamingBehavior: 'steer' };
    const first = commandRoute.POST(post(input), context);
    const joined = commandRoute.POST(post(input), context);
    const busy = await commandRoute.POST(post({ ...input, requestId: uuid(33), message: 'different' }), context);
    assert.equal(busy.status, 409);
    assert.equal((await first).status, 200);
    assert.equal((await joined).status, 200);
    assert.equal((await readFile(log, 'utf8')).split('\n').filter(method => method === 'turn/steer').length, 1);
  } finally {
    if (actor) await shutdownCodexSession(actor);
    await rm(dir, { recursive: true, force: true });
  }
});
