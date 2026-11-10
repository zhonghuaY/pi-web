import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const testHome = await mkdtemp(join(tmpdir(), 'pi-web-codex-catalogue-test-'));
const isolated = {
  HOME: join(testHome, 'home'), PI_CODING_AGENT_DIR: join(testHome, 'pi'),
  CODEX_HOME: join(testHome, 'codex'), CLAUDE_CONFIG_DIR: join(testHome, 'claude'),
};
await Promise.all(Object.values(isolated).map(path => mkdir(path)));
const keys = [...Object.keys(isolated), 'JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT', 'PI_WEB_CODEX'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
Object.assign(process.env, isolated, { PI_WEB_CODEX: '1' });
for (const key of ['JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT']) delete process.env[key];
const spawnNode = childProcess.spawn;

const targetId = '019a1234-abcd-7abc-8abc-123456789abc';
const forkId = '019a1234-abcd-7abc-8abc-123456789abd';
const emptyId = '019a1234-abcd-7abc-8abc-123456789abe';
const thread = (id, overrides = {}) => ({
  id, sessionId: id, preview: '', ephemeral: false, projectId: null,
  modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: '/tmp/project',
  cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [], ...overrides,
});

// Exercise the actual transport and pinned schema without launching a native CLI or a server.
let fixture;
let calls;
let activeReads = 0;
let peakReads = 0;
let killedChildren = 0;
mock.method(childProcess, 'spawn', (_binary, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const close = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
  };
  child.kill = () => { killedChildren++; close(); return true; };
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString());
      calls.push(request);
      if ('id' in request) {
        let result;
        let error;
        if (request.method === 'initialize') result = { userAgent: 'fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' };
        else if (request.method === 'thread/list') result = fixture.pages[request.params.cursor ?? 'first'];
        else if (request.method === 'thread/read') {
          activeReads++;
          peakReads = Math.max(peakReads, activeReads);
          const response = fixture.reads[request.params.threadId.toLowerCase()];
          if (response?.error) error = response.error;
          else result = response;
        } else throw new Error(`Unexpected browsing operation: ${request.method}`);
        queueMicrotask(() => {
          if (request.method === 'thread/read') activeReads--;
          child.stdout.write(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }) + '\n');
        });
      }
      done();
    },
    final(done) { close(); done(); },
  });
  if (args[0] === '--version') {
    queueMicrotask(() => { child.stdout.end('codex-cli 0.153.4\n'); child.exitCode = 0; child.emit('close', 0, null); });
  } else {
    assert.deepEqual(args, ['app-server', '--stdio']);
  }
  return child;
});
syncBuiltinESMExports();
after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(testHome, { recursive: true, force: true });
});

const newReader = async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, moduleCache: false });
  return jiti.import('./agent-catalog.ts');
};
const setup = () => { fixture = { pages: {}, reads: {} }; calls = []; activeReads = 0; peakReads = 0; killedChildren = 0; };
const methods = () => calls.map(call => call.method);

test('cold catalogue recovers handoff and fork metadata from history with empty list turns', async () => {
  setup();
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, moduleCache: false });
  const { buildSessionHandoff } = await jiti.import('./session-handoff.ts');
  const built = buildSessionHandoff({
    requestId: '123e4567-e89b-42d3-a456-426614174000', sourceSessionId: 'pi-source', sourceBackend: 'pi',
    sourceEntryId: 'tip', sourceTitle: 'Earlier work', targetBackend: 'codex',
    messages: [{ role: 'user', content: 'context' }],
  });
  const turns = [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: built.prompt }] },
  ] }];
  const target = thread(targetId, { preview: '', updatedAt: 3 });
  const fork = thread(forkId, { preview: 'preview unavailable', forkedFromId: targetId, updatedAt: 4 });
  const empty = thread(emptyId);
  fixture.pages.first = { data: [target, empty], nextCursor: 'next' };
  fixture.pages.next = { data: [fork], nextCursor: null };
  fixture.reads[targetId] = { thread: { ...target, name: 'stale read title', turns } };
  fixture.reads[forkId] = { thread: { ...fork, turns } };
  fixture.reads[emptyId] = { error: { code: -32601, message: 'list_turns is not supported yet' } };

  // Each reader starts with only the native fixture; no live runtime is created.
  for (let restart = 0; restart < 2; restart++) {
    if (restart === 1) fixture.pages.next.data = [{ ...fork, forkedFromId: null }];
    const { readCodexCatalogue } = await newReader();
    const start = calls.length;
    const result = await readCodexCatalogue();
    assert.equal(result.error, 'Codex session history is unavailable');
    assert.equal(result.sessions.length, 3);
    const imported = result.sessions.find(row => row.id === `codex:${targetId}`);
    assert.equal(imported.firstMessage, built.title);
    assert.equal(imported.name, undefined, 'list metadata remains authoritative');
    assert.deepEqual(imported.relation, built.relation);
    const copied = result.sessions.find(row => row.id === `codex:${forkId}`);
    assert.equal(copied.firstMessage, built.title);
    assert.equal(copied.parentSessionId, `codex:${targetId}`);
    assert.deepEqual(copied.relation, { kind: 'fork', originSessionId: `codex:${targetId}` });
    const operations = calls.slice(start);
    assert.deepEqual(operations.filter(call => call.method === 'thread/list').map(call => call.params.cursor), [undefined, 'next']);
    assert.deepEqual(operations.filter(call => call.method === 'thread/read').map(call => call.params.threadId).sort(), [targetId, forkId, emptyId].sort());
    assert.ok(operations.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === true));
    assert.ok(operations.every(call => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(call.method)));
  }
});

test('invalid or incomplete list pagination discards all rows', async () => {
  const { readCodexCatalogue } = await newReader();
  const valid = thread(targetId, { preview: 'plain preview' });
  const cases = [
    { pages: { first: { data: [valid], nextCursor: 'next' }, next: { data: 'invalid' } }, reads: {} },
    { pages: { first: { data: [valid], nextCursor: 'next' }, next: { data: [], nextCursor: 'next' } }, reads: {} },
  ];
  for (const failure of cases) {
    fixture = failure;
    calls = [];
    assert.deepEqual(await readCodexCatalogue(), { sessions: [], error: 'Codex session history is unavailable' });
    assert.ok(methods().every(method => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(method)));
  }
});

test('each failed history keeps its validated list row and marks the catalogue incomplete', async () => {
  const { readCodexCatalogue } = await newReader();
  const valid = thread(targetId, { preview: 'plain preview', name: 'Trusted title', cwd: '/trusted/project' });
  const other = thread(forkId, { preview: 'another session' });
  const cases = [
    { error: { code: -32601, message: 'list_turns is not supported yet' } },
    { error: { code: -32603, message: 'read failed' } },
    { error: { code: -32601, message: 'different failure' } },
    { error: { code: -32601, message: 'list_turns is not supported yet: different failure' } },
    { thread: thread(emptyId, { name: 'Untrusted title', cwd: '/untrusted', forkedFromId: forkId }) },
    { thread: { ...valid, name: 'Untrusted title', cwd: '/untrusted', turns: 'invalid' } },
  ];
  for (const failedRead of cases) {
    setup();
    fixture.pages.first = { data: [valid, other], nextCursor: null };
    fixture.reads[targetId] = failedRead;
    fixture.reads[forkId] = { thread: other };
    const result = await readCodexCatalogue();
    assert.equal(result.error, 'Codex session history is unavailable');
    assert.deepEqual(result.sessions.map(row => row.id).sort(), [`codex:${targetId}`, `codex:${forkId}`].sort());
    const retained = result.sessions.find(row => row.id === `codex:${targetId}`);
    assert.equal(retained.name, 'Trusted title');
    assert.equal(retained.cwd, '/trusted/project');
    assert.equal(retained.firstMessage, 'plain preview');
    assert.equal(retained.relation, undefined);
    assert.equal(retained.parentSessionId, undefined);
    assert.ok(methods().every(method => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(method)));
  }
});

test('a failed history does not prevent later rows from being hydrated', async () => {
  setup();
  const rows = Array.from({ length: 6 }, (_, index) => thread(`019a1234-abcd-7abc-8abc-${String(index).padStart(12, '0')}`, { preview: `session ${index}` }));
  fixture.pages.first = { data: rows, nextCursor: null };
  for (const row of rows) fixture.reads[row.id] = { thread: row };
  fixture.reads[rows[0].id] = { error: { code: -32601, message: 'list_turns is not supported yet' } };
  fixture.reads[rows[5].id] = { thread: { ...rows[5], forkedFromId: rows[1].id } };
  const { readCodexCatalogue } = await newReader();
  const result = await readCodexCatalogue();
  assert.equal(result.error, 'Codex session history is unavailable');
  assert.equal(result.sessions.length, rows.length);
  assert.deepEqual(result.sessions.find(row => row.id === `codex:${rows[5].id}`).relation, { kind: 'fork', originSessionId: `codex:${rows[1].id}` });
  assert.equal(calls.filter(call => call.method === 'thread/read').length, rows.length);
  assert.equal(peakReads, 4);
});

test('an oversized history closes the shared transport without losing validated list rows', async () => {
  setup();
  const rows = Array.from({ length: 9 }, (_, index) => thread(`019a1234-abcd-7abc-8abc-${String(index).padStart(12, '0')}`, { preview: `session ${index}`, updatedAt: index + 1 }));
  fixture.pages.first = { data: rows, nextCursor: null };
  for (const row of rows) fixture.reads[row.id] = { thread: row };
  fixture.reads[rows[0].id] = { thread: { ...rows[0], turns: [{ id: 'big-turn', status: 'completed', items: [
    { id: 'big-item', type: 'agentMessage', text: 'x'.repeat(4 * 1024 * 1024 + 1) },
  ] }] } };
  const { readCodexCatalogue } = await newReader();
  const result = await readCodexCatalogue();
  assert.equal(result.error, 'Codex session history is unavailable');
  assert.deepEqual(result.sessions.map(row => row.id), rows.toReversed().map(row => `codex:${row.id}`));
  assert.deepEqual(result.sessions.map(row => row.firstMessage), rows.toReversed().map(row => row.preview));
  assert.equal(peakReads, 4);
  assert.ok(killedChildren > 0, 'the oversized line fails and closes the shared transport');
  assert.equal(calls.filter(call => call.method === 'thread/read').length, 4, 'closed transport stops further history reads');
  assert.ok(methods().every(method => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(method)));
});

test('unprojectable canonical rows retain valid sessions and mark discovery incomplete', async () => {
  const { readCodexCatalogue } = await newReader();
  for (const overrides of [
    { cwd: '' },
    { createdAt: 8_640_000_000_001 },
    { updatedAt: -8_640_000_000_001 },
  ]) {
    setup();
    const visible = thread(targetId, { preview: 'visible session' });
    const hidden = thread(forkId.toUpperCase(), overrides);
    fixture.pages.first = { data: [visible, hidden], nextCursor: null };
    fixture.reads[targetId] = { thread: visible };
    fixture.reads[forkId] = { thread: thread(forkId) };
    const result = await readCodexCatalogue();
    assert.deepEqual(result.sessions.map(row => row.id), [`codex:${targetId}`]);
    assert.equal(result.error, 'Codex session history is unavailable');
  }
});

test('an unprojectable existing handoff target blocks deduplication before source or target work', async () => {
  setup();
  const requestId = '123e4567-e89b-42d3-a456-426614174098';
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, moduleCache: false });
  const { buildSessionHandoff } = await jiti.import('./session-handoff.ts');
  const { createSessionHandoff } = await jiti.import('./session-handoff-server.ts');
  const { readCodexThread } = await jiti.import('./agent-backends/codex/catalogue.ts');
  const { projectCodexSessionInfo } = await jiti.import('./agent-backends/codex/projection.ts');
  const built = buildSessionHandoff({
    requestId, sourceSessionId: 'pi-source', sourceBackend: 'pi', sourceEntryId: 'tip',
    sourceTitle: 'Earlier work', targetBackend: 'codex', messages: [{ role: 'user', content: 'context' }],
  });
  const visible = thread(targetId, { preview: 'visible session' });
  const hidden = thread(forkId, { cwd: '' });
  const history = thread(forkId, { turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: built.prompt }] },
  ] }] });
  fixture.pages.first = { data: [visible, hidden], nextCursor: null };
  fixture.reads[targetId] = { thread: visible };
  fixture.reads[forkId] = { thread: history };

  const authoritative = projectCodexSessionInfo(await readCodexThread(forkId));
  assert.equal(authoritative.state, 'projected');
  assert.deepEqual(authoritative.info.relation, built.relation);

  let sourceReads = 0;
  let targetCreations = 0;
  let reachedCreation = false;
  await assert.rejects(createSessionHandoff('pi-source', { targetBackend: 'codex', requestId, trustProject: false }, {
    readSource: async () => {
      sourceReads++;
      return {
        backend: 'pi', info: { id: 'pi-source', path: 'fixture', cwd: isolated.HOME, created: new Date(1).toISOString(), modified: new Date(2).toISOString(), firstMessage: 'Earlier work', messageCount: 1 },
        leafId: 'tip', messages: [{ role: 'user', content: 'context' }],
      };
    },
    createTarget: async () => { targetCreations++; throw new Error('target must not be created'); },
    seam: point => { if (point === 'before-target-creation') { reachedCreation = true; throw new Error('stopped before target creation'); } },
  }), error => error.status === 503 && error.message === 'Codex session history is unavailable');
  assert.equal(sourceReads, 0);
  assert.equal(reachedCreation, false);
  assert.equal(targetCreations, 0);
});

test('an incomplete catalogue blocks handoff deduplication before source or target work', async () => {
  setup();
  const row = thread(targetId, { preview: 'visible session' });
  fixture.pages.first = { data: [row], nextCursor: null };
  fixture.reads[targetId] = { error: { code: -32601, message: 'list_turns is not supported yet' } };
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, moduleCache: false });
  const { createSessionHandoff } = await jiti.import('./session-handoff-server.ts');
  let touched = false;
  await assert.rejects(createSessionHandoff('pi-source', {
    targetBackend: 'codex', requestId: '123e4567-e89b-42d3-a456-426614174099', trustProject: false,
  }, {
    readSource: async () => { touched = true; throw new Error('source must not be read'); },
    createTarget: async () => { touched = true; throw new Error('target must not be created'); },
  }), error => error.status === 503 && error.message === 'Codex session history is unavailable');
  assert.equal(touched, false);
  assert.ok(methods().every(method => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(method)));
});

test('matching history can only contribute history metadata, not list identity', async () => {
  setup();
  const valid = thread(targetId, { preview: 'list preview', name: 'Trusted title', cwd: '/trusted/project' });
  fixture.pages.first = { data: [valid], nextCursor: null };
  fixture.reads[targetId] = { thread: { ...valid, sessionId: emptyId, name: 'Untrusted title', cwd: '/untrusted' } };
  const { readCodexCatalogue } = await newReader();
  const result = await readCodexCatalogue();
  assert.equal(result.error, undefined);
  assert.equal(result.sessions[0].id, `codex:${targetId}`);
  assert.equal(result.sessions[0].name, 'Trusted title');
  assert.equal(result.sessions[0].cwd, '/trusted/project');
  assert.equal(result.sessions[0].firstMessage, 'list preview');
});

test('invalid and duplicate rows do not cause unnecessary history reads', async () => {
  setup();
  const valid = thread(targetId, { preview: 'ordinary', updatedAt: 4 });
  fixture.pages.first = { data: [thread('invalid-id'), { ...valid, id: targetId.toUpperCase(), updatedAt: 3 }, valid], nextCursor: null };
  fixture.reads[targetId] = { thread: valid };
  const { readCodexCatalogue } = await newReader();
  const result = await readCodexCatalogue();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sessions.map(row => row.id), [`codex:${targetId}`]);
  assert.equal(calls.filter(call => call.method === 'thread/read').length, 1);
});

test('history reads are bounded and preserve catalogue order', async () => {
  setup();
  const rows = Array.from({ length: 11 }, (_, index) => thread(`019a1234-abcd-7abc-8abc-${String(index).padStart(12, '0')}`, { updatedAt: index + 1 }));
  fixture.pages.first = { data: rows, nextCursor: null };
  for (const row of rows) fixture.reads[row.id] = { thread: row };
  const { readCodexCatalogue } = await newReader();
  const result = await readCodexCatalogue();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.sessions.map(row => row.id), rows.toReversed().map(row => `codex:${row.id}`));
  assert.equal(calls.filter(call => call.method === 'thread/read').length, rows.length);
  assert.equal(peakReads, 4);
});

test('handoff metadata survives a fresh process reading persisted history', async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, moduleCache: false });
  const { buildSessionHandoff } = await jiti.import('./session-handoff.ts');
  const built = buildSessionHandoff({
    requestId: '123e4567-e89b-42d3-a456-426614174001', sourceSessionId: 'pi-source', sourceBackend: 'pi',
    sourceEntryId: 'tip', sourceTitle: 'Persisted work', targetBackend: 'codex',
    messages: [{ role: 'user', content: 'context' }],
  });
  const row = thread(targetId);
  const turns = [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: built.prompt }] },
  ] }];
  const path = join(testHome, 'persisted-native-fixture.json');
  await writeFile(path, JSON.stringify({
    pages: { first: { data: [row], nextCursor: null } },
    reads: { [targetId]: { thread: { ...row, turns } } },
    title: built.title, relation: built.relation,
  }));
  const output = await new Promise((resolve, reject) => {
    const child = spawnNode(process.execPath, [
      '--experimental-strip-types', '--test', '--experimental-test-isolation=none', '--test-name-pattern=^restart fixture reader$', fileURLToPath(import.meta.url),
    ], { env: { ...process.env, PIWEB_TEST_RESTART_FIXTURE: path }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, text }));
  });
  assert.equal(output.code, 0, output.text);
  assert.match(output.text, /pass 1/);
});

if (process.env.PIWEB_TEST_RESTART_FIXTURE) {
  test('restart fixture reader', async () => {
    setup();
    const persisted = JSON.parse(await readFile(process.env.PIWEB_TEST_RESTART_FIXTURE, 'utf8'));
    fixture.pages = persisted.pages;
    fixture.reads = persisted.reads;
    const { readCodexCatalogue } = await newReader();
    const result = await readCodexCatalogue();
    assert.equal(result.error, undefined);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].firstMessage, persisted.title);
    assert.deepEqual(result.sessions[0].relation, persisted.relation);
    assert.ok(methods().every(method => ['initialize', 'initialized', 'thread/list', 'thread/read'].includes(method)));
  });
}

test('standalone list and read retain their pagination and error semantics', async () => {
  setup();
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false, moduleCache: false });
  const { listCodexThreads, readCodexThread } = await jiti.import('./agent-backends/codex/catalogue.ts');
  const row = thread(targetId);
  fixture.pages.first = { data: [row], nextCursor: '' };
  fixture.pages[''] = { data: [thread(forkId)], nextCursor: null };
  fixture.reads[targetId] = { thread: row };
  assert.deepEqual((await listCodexThreads()).map(item => item.id), [targetId, forkId]);
  assert.deepEqual(calls.filter(call => call.method === 'thread/list').map(call => call.params.cursor), [undefined, '']);
  assert.equal(calls.some(call => call.method === 'thread/read'), false);
  assert.deepEqual((await readCodexThread(targetId)).turns, []);
  fixture.reads[targetId] = { thread: thread(forkId) };
  await assert.rejects(readCodexThread(targetId), error => error.kind === 'invalid-payload');
  fixture.reads[targetId] = { error: { code: -32601, message: 'list_turns is not supported yet' } };
  await assert.rejects(readCodexThread(targetId), error => error.kind === 'unavailable');
  fixture.reads[targetId] = { error: { code: -32603, message: 'failed' } };
  await assert.rejects(readCodexThread(targetId), error => error.kind === 'rpc' && error.code === -32603);
});

test('disabled Codex does not browse', async () => {
  setup();
  const previous = process.env.PI_WEB_CODEX;
  process.env.PI_WEB_CODEX = '0';
  try {
    const { readCodexCatalogue } = await newReader();
    assert.deepEqual(await readCodexCatalogue(), { sessions: [] });
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_CODEX;
    else process.env.PI_WEB_CODEX = previous;
  }
});
