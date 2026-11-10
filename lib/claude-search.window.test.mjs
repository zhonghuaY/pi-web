import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() }, interopDefault: true });
const { searchProjectedSessions } = await jiti.import('./claude-search.ts');

function session(index) {
  return { id: `session-${index}`, modified: String(100 - index).padStart(3, '0'), firstMessage: 'ordinary title' };
}

function history(text, hasMore = false) {
  return { context: { messages: [{ role: 'user', content: text }], entryIds: ['message'], hasMore } };
}

test('default projected search keeps its original time bound and ordering', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const reads = [];
  const sessions = [session(2), session(0), session(1), session(3)];
  const result = await searchProjectedSessions(sessions, 'needle', new AbortController().signal, async id => {
    reads.push(id);
    now += 1100;
    return history('no match');
  });
  assert.deepEqual(reads, ['session-0', 'session-1', 'session-2']);
  assert.equal(result.truncated, true);
  assert.equal(result.progress, undefined);
});

test('continuation retains history truncation after all sessions are scanned', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const sessions = Array.from({ length: 5 }, (_, index) => session(index));
  const read = async id => {
    now += 1100;
    return history(id === 'session-4' ? 'needle' : 'no match', id === 'session-0');
  };
  const first = await searchProjectedSessions(sessions, 'needle', new AbortController().signal, read, { nextIndex: 0, results: [], truncated: false });
  assert.equal(first.progress?.truncated, true);
  const last = await searchProjectedSessions(sessions, 'needle', new AbortController().signal, read, first.progress);
  assert.equal(last.results[0]?.session.id, 'session-4');
  assert.equal(last.truncated, true);
  assert.equal(last.progress, undefined);
});

test('continuation stops at the result cap', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const sessions = Array.from({ length: 35 }, (_, index) => session(index));
  const reads = [];
  const read = async id => {
    reads.push(id);
    now += 1100;
    return history('needle');
  };
  let progress = { nextIndex: 0, results: [], truncated: false };
  let result;
  do {
    result = await searchProjectedSessions(sessions, 'needle', new AbortController().signal, read, progress);
    progress = result.progress;
  } while (progress);
  assert.equal(result.results.length, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.progress, undefined);
  assert.deepEqual(reads, sessions.slice(0, 30).map(item => item.id));
});
