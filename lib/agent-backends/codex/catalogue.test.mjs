import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { listCodexThreads, readCodexThread } = await jiti.import('./catalogue.ts');
const thread = id => ({ id, sessionId: id, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: '/tmp', cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] });

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-codex-catalogue-'));
  const binary = join(dir, 'codex');
  const log = join(dir, 'requests');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(0); }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(req) + '\\n');
  if (!('id' in req)) return;
  let result;
  if (req.method === 'initialize') result = { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' };
  else if (req.method === 'thread/list') result = req.params.cursor !== undefined ? JSON.parse(process.env.TEST_PAGE_TWO) : JSON.parse(process.env.TEST_PAGE_ONE);
  else if (req.method === 'thread/read') {
    if (process.env.TEST_ERROR) { console.log(JSON.stringify({ id: req.id, error: JSON.parse(process.env.TEST_ERROR) })); return; }
    result = JSON.parse(process.env.TEST_READ);
  } else throw Error('unexpected method');
  console.log(JSON.stringify({ id: req.id, result }));
});
`);
  await chmod(binary, 0o700);
  const options = { binary, cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir, TEST_LOG: log, TEST_PAGE_ONE: JSON.stringify({ data: [thread('first')], nextCursor: 'next' }), TEST_PAGE_TWO: JSON.stringify({ data: [thread('second')], nextCursor: null }), TEST_READ: JSON.stringify({ thread: thread('first') }) } };
  try { await run(options, log); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('follows every catalogue cursor without running a thread or turn', async () => {
  await fixture(async (options, log) => {
    assert.deepEqual((await listCodexThreads(options)).map(item => item.id), ['first', 'second']);
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(request => request.method), ['initialize', 'initialized', 'thread/list', 'thread/list']);
    assert.equal(requests.at(-1).params.cursor, 'next');
  });
});

test('follows even an empty cursor when the server returns one', async () => {
  await fixture(async (options, log) => {
    options.env.TEST_PAGE_ONE = JSON.stringify({ data: [thread('first')], nextCursor: '' });
    assert.deepEqual((await listCodexThreads(options)).map(item => item.id), ['first', 'second']);
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(requests.at(-1).params.cursor, '');
  });
});

test('never returns a partial list for an invalid page or cursor loop', async () => {
  await fixture(async options => {
    options.env.TEST_PAGE_TWO = JSON.stringify({ data: 'invalid' });
    await assert.rejects(listCodexThreads(options), error => error.kind === 'invalid-payload');
    options.env.TEST_PAGE_TWO = JSON.stringify({ data: [], nextCursor: 'next' });
    await assert.rejects(listCodexThreads(options), error => error.kind === 'incomplete');
  });
});

test('read preserves empty threads and treats method refusal as unavailable', async () => {
  await fixture(async options => {
    assert.deepEqual((await readCodexThread('first', options)).turns, []);
    await assert.rejects(readCodexThread('other', options), error => error.kind === 'invalid-payload');
    options.env.TEST_ERROR = JSON.stringify({ code: -32601, message: 'list_turns is not supported yet' });
    await assert.rejects(readCodexThread('first', options), error => error.kind === 'unavailable');
    for (const code of [-32600, -32603, -32000]) {
      options.env.TEST_ERROR = JSON.stringify({ code, message: 'failed' });
      await assert.rejects(readCodexThread('first', options), error => error.kind === 'rpc' && error.code === code);
    }
  });
});
