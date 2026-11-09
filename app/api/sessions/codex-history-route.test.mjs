import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../../lib/claude-test-home.mjs';

await isolateClaudeHome();

const home = await mkdtemp(join(tmpdir(), 'pi-web-codex-routes-'));
const bin = join(home, 'codex');
const requestLog = join(home, 'requests');
await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(0); }
let listed = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  fs.appendFileSync(process.env.TEST_REQUEST_LOG, JSON.stringify(req) + '\\n');
  if (!('id' in req)) return;
  let result;
  if (req.method === 'initialize') result = { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' };
  else if (req.method === 'thread/list') {
    listed = true;
    if (process.env.TEST_LIST_ERROR) { console.log(JSON.stringify({ id: req.id, error: { code: -32603, message: 'temporary failure' } })); return; }
    result = JSON.parse(req.params.cursor === undefined ? process.env.TEST_PAGE_ONE : process.env.TEST_PAGE_TWO);
  } else if (req.method === 'thread/read') {
    if (process.env.TEST_READ_ERROR) { console.log(JSON.stringify({ id: req.id, error: { code: -32601, message: 'list_turns is not supported yet' } })); return; }
    const configured = JSON.parse(process.env.TEST_THREAD_READ);
    result = { ...configured, thread: { ...configured.thread, id: req.params.threadId, sessionId: req.params.threadId } };
  } else throw Error('unexpected method');
  const reply = () => console.log(JSON.stringify({ id: req.id, result }));
  if (req.method === 'thread/read' && !listed && process.env.TEST_SEARCH_READ_DELAY_MS) setTimeout(reply, Number(process.env.TEST_SEARCH_READ_DELAY_MS));
  else reply();
});
`);
await chmod(bin, 0o700);
const saved = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT', 'PI_WEB_CODEX', 'TEST_REQUEST_LOG', 'TEST_PAGE_ONE', 'TEST_PAGE_TWO', 'TEST_THREAD_READ', 'TEST_READ_ERROR', 'TEST_LIST_ERROR', 'TEST_SEARCH_READ_DELAY_MS'].map(key => [key, process.env[key]]));
Object.assign(process.env, { PATH: `${home}${delimiter}${saved.PATH}`, HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), PI_CODING_AGENT_DIR: join(home, 'pi'), PI_WEB_CODEX: '1', TEST_REQUEST_LOG: requestLog });
for (const key of ['JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT']) delete process.env[key];
test.after(async () => {
  const pendingSearch = globalThis.__piCodexBrowseState?.search;
  pendingSearch?.controller.abort();
  await pendingSearch?.promise;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(home, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET: read } = await jiti.import('./[id]/route.ts');
const { GET: context } = await jiti.import('./[id]/context/route.ts');
const { GET: list } = await jiti.import('./route.ts');
const { GET: search } = await jiti.import('./search/route.ts');
const { GET: events } = await jiti.import('../agent/[id]/events/route.ts');
const { GET: backends } = await jiti.import('../agent/backends/route.ts');
const { getRpcSession } = await jiti.import('../../../lib/rpc-manager.ts');
const { SessionManager } = await jiti.import('@earendil-works/pi-coding-agent');
const pi = SessionManager.create(home);
pi.appendMessage({ role: 'user', content: 'Pi fixture', timestamp: Date.now() });
const claudeId = '123e4567-e89b-42d3-a456-426614174000';
const projectDir = join(home, 'claude', 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
await mkdir(projectDir, { recursive: true });
await writeFile(join(projectDir, `${claudeId}.jsonl`), JSON.stringify({ type: 'user', uuid: '123e4567-e89b-42d3-a456-426614174001', parentUuid: null, sessionId: claudeId, cwd: home, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Claude fixture' } }) + '\n');
const nativeId = '019a1234-abcd-7abc-8abc-123456789abc';
const id = `codex:${nativeId}`;
const native = (overrides = {}) => ({ id: nativeId, sessionId: nativeId, preview: 'hello', ephemeral: false, projectId: null, modelProvider: 'openai', createdAt: 1, updatedAt: 2, cwd: home, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [], ...overrides });
const call = (handler, query = '') => handler(new Request(`http://localhost/api/sessions/test${query}`), { params: Promise.resolve({ id }) });

process.env.TEST_PAGE_ONE = JSON.stringify({ data: [native({ name: 'Renamed' })], nextCursor: 'second' });
process.env.TEST_PAGE_TWO = JSON.stringify({ data: [native({ id: '019a1234-abcd-7abc-8abc-123456789abd', sessionId: '019a1234-abcd-7abc-8abc-123456789abd', preview: 'External CLI' })], nextCursor: null });
process.env.TEST_THREAD_READ = JSON.stringify({ thread: native({ turns: [{ id: 'turn', status: 'completed', items: [
  { type: 'userMessage', id: 'first', content: [{ type: 'text', text: 'hello' }] },
  { type: 'agentMessage', id: 'second', text: 'answer' },
] }] }) });

test('lists all pages and reads a completed external thread without starting a runtime', async () => {
  const discovery = await (await backends(new Request(`http://localhost/api/agent/backends?cwd=${encodeURIComponent(home)}`))).json();
  const codex = discovery.backends.find(backend => backend.backend === 'codex');
  assert.equal(codex.browsingAvailable, true);
  assert.equal(codex.available, true);
  assert.equal(codex.capabilities.history, true);
  assert.equal(codex.capabilities.prompt, true);
  const response = await list(new Request('http://localhost/api/sessions?summary=1'));
  assert.equal(response.status, 200);
  const catalogue = await response.json();
  assert.equal(catalogue.sessions.find(row => row.id === id).name, 'Renamed');
  assert.ok(catalogue.sessions.some(row => row.firstMessage === 'External CLI'));
  const first = await call(read, '?tail=1');
  assert.equal(first.status, 200);
  const snapshot = await first.json();
  assert.equal(snapshot.context.messages[0].content[0].text, 'answer');
  assert.equal(snapshot.context.hasMore, true);
  const earlier = await call(context, '?tail=1&before=second');
  assert.equal((await earlier.json()).context.messages[0].content, 'hello');
  assert.equal(getRpcSession(id), undefined);
  const requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(request => request.method === 'thread/list' && request.params.cursor === 'second'));
  assert.ok(requests.every(request => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(request.method)));
});

test('search includes matching Codex history after a bounded partial response', async () => {
  const previousDelay = process.env.TEST_SEARCH_READ_DELAY_MS;
  process.env.TEST_SEARCH_READ_DELAY_MS = '900';
  try {
    const query = () => search(new Request('http://localhost/api/sessions/search?q=answer'));
    let response = await query();
    assert.equal(response.status, 200);
    let result = await response.json();
    assert.equal(result.truncated, true);
    assert.equal(result.backendErrors?.codex, 'Codex session history is unavailable');
    const deadline = Date.now() + 8_000;
    while (!result.results.some(hit => hit.session.id === id && hit.match === 'answer') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      response = await query();
      assert.equal(response.status, 200);
      result = await response.json();
      if (!result.results.some(hit => hit.session.id === id && hit.match === 'answer')) {
        assert.equal(result.truncated, true);
        assert.equal(result.backendErrors?.codex, 'Codex session history is unavailable');
      }
    }
    assert.ok(result.results.some(hit => hit.session.id === id && hit.match === 'answer'));
    assert.equal(result.backendErrors?.codex, undefined);
  } finally {
    if (previousDelay === undefined) delete process.env.TEST_SEARCH_READ_DELAY_MS;
    else process.env.TEST_SEARCH_READ_DELAY_MS = previousDelay;
  }
});

test('an empty unsaved thread remains distinguishable from unavailable history', async () => {
  const oldPage = process.env.TEST_PAGE_ONE;
  const oldRead = process.env.TEST_THREAD_READ;
  process.env.TEST_PAGE_ONE = JSON.stringify({ data: [native({ ephemeral: true })], nextCursor: null });
  process.env.TEST_THREAD_READ = JSON.stringify({ thread: native({ ephemeral: true }) });
  try {
    const catalogue = await (await list(new Request('http://localhost/api/sessions?summary=1&force=1'))).json();
    assert.equal(catalogue.sessions.find(row => row.id === id).transient, true);
    const response = await call(read);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).context.messages, []);
  } finally { process.env.TEST_PAGE_ONE = oldPage; process.env.TEST_THREAD_READ = oldRead; }
});

test('early refusal stays unavailable but a missing cwd only prevents runtime admission', async () => {
  process.env.TEST_READ_ERROR = '1';
  try {
    const refusal = await call(read);
    assert.equal(refusal.status, 503);
    assert.equal((await refusal.json()).reason, 'backend-unavailable');
    const catalogue = await (await list(new Request('http://localhost/api/sessions?summary=1&force=1'))).json();
    assert.ok(catalogue.sessions.some(row => row.id === id));
    assert.ok(catalogue.sessions.some(row => row.id === 'codex:019a1234-abcd-7abc-8abc-123456789abd'));
    assert.ok(catalogue.sessions.some(row => row.id === pi.getSessionId()));
    assert.ok(catalogue.sessions.some(row => row.id === `claude:${claudeId}`));
    assert.equal(catalogue.backendErrors.codex, 'Codex session history is unavailable');
  } finally { delete process.env.TEST_READ_ERROR; }
  const missing = join(home, 'missing');
  process.env.TEST_THREAD_READ = JSON.stringify({ thread: native({ cwd: missing }) });
  try {
    const response = await call(read);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).info.cwd, missing);
    const page = await call(context);
    assert.equal(page.status, 200);
    assert.deepEqual((await page.json()).context.messages, []);
    const runtime = await events(new Request('http://localhost/api/agent/events'), { params: Promise.resolve({ id }) });
    assert.equal(runtime.status, 409);
    const refused = await runtime.json();
    assert.equal(refused.reason, 'cwd-missing');
    assert.equal(refused.cwd, missing);
    const methods = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    assert.equal(methods.includes('thread/start'), false);
    assert.equal(methods.includes('thread/resume'), false);
  } finally { process.env.TEST_THREAD_READ = JSON.stringify({ thread: native() }); }
});

test('a Codex catalogue failure leaves the other backends responsive', async () => {
  process.env.TEST_LIST_ERROR = '1';
  try {
    const response = await list(new Request('http://localhost/api/sessions?summary=1&force=1'));
    assert.equal(response.status, 200);
    const catalogue = await response.json();
    assert.equal(catalogue.backendErrors.codex, 'Codex session history is unavailable');
    assert.ok(catalogue.sessions.some(row => row.id === pi.getSessionId()));
    assert.ok(catalogue.sessions.some(row => row.id === `claude:${claudeId}`));
    assert.equal((await read(new Request('http://localhost/api/sessions/pi'), { params: Promise.resolve({ id: pi.getSessionId() }) })).status, 200);
    assert.equal((await read(new Request('http://localhost/api/sessions/claude'), { params: Promise.resolve({ id: `claude:${claudeId}` }) })).status, 200);
  } finally { delete process.env.TEST_LIST_ERROR; }
});
