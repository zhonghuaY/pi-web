import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../claude-test-home.mjs';
await isolateClaudeHome();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { projectCodexCatalogue, projectCodexSessionInfo } = await jiti.import('./projection.ts');
const { projectCodexHistory } = await jiti.import('./history.ts');
const { buildSessionHandoff } = await jiti.import('../../session-handoff.ts');
const id = '019a1234-abcd-7abc-8abc-123456789abc';
const thread = (overrides = {}) => ({ id, sessionId: id, preview: 'hello', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: '/tmp/missing-project', cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [], ...overrides });

test('projects renamed and unsaved thread metadata with runtime capabilities', () => {
  const result = projectCodexSessionInfo(thread({ id: id.toUpperCase(), name: 'Renamed', ephemeral: true }));
  assert.equal(result.state, 'projected');
  assert.equal(result.info.id, `codex:${id}`);
  assert.equal(result.info.name, 'Renamed');
  assert.equal(result.info.cwd, '/tmp/missing-project');
  assert.equal(result.info.transient, true);
  assert.equal(result.info.capabilities.prompt, true);
  assert.equal(result.info.capabilities.stop, true);
  assert.equal(result.info.capabilities.steer, true);
  assert.equal(result.info.capabilities.followUp, false);
  assert.equal(result.info.modified, '1970-01-01T00:00:02.000Z');
});

test('restores native handoff title and relation from validated history', () => {
  const built = buildSessionHandoff({
    requestId: '123e4567-e89b-42d3-a456-426614174000', sourceSessionId: 'source', sourceBackend: 'pi',
    sourceEntryId: 'tip', sourceTitle: 'Source title', targetBackend: 'codex',
    messages: [{ role: 'assistant', provider: 'test', model: 'test', content: [{ type: 'text', text: 'visible' }] }],
  });
  const result = projectCodexSessionInfo(thread({ turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: built.prompt }] },
  ] }] }));
  assert.equal(result.state, 'projected');
  assert.equal(result.info.firstMessage, built.title);
  assert.deepEqual(result.info.relation, built.relation);
});

test('filters malformed identities, absent cwd and invalid timestamps distinctly', () => {
  assert.deepEqual(projectCodexSessionInfo(thread({ id: 'bad' })), { state: 'filtered', reason: 'invalid-id' });
  assert.deepEqual(projectCodexSessionInfo(thread({ cwd: '' })), { state: 'filtered', reason: 'missing-cwd' });
  assert.deepEqual(projectCodexSessionInfo(thread({ updatedAt: 1e100 })), { state: 'filtered', reason: 'invalid-timestamp' });
});

test('native fork ancestry survives catalogue refresh without mistaking a subagent parent for a fork', () => {
  const origin = '019a1234-abcd-7abc-8abc-123456789abd';
  const copy = projectCodexSessionInfo(thread({ forkedFromId: origin, parentThreadId: null }));
  assert.deepEqual(copy.info.relation, { kind: 'fork', originSessionId: `codex:${origin}` });
  assert.equal(copy.info.parentSessionId, `codex:${origin}`);
  assert.equal(projectCodexSessionInfo(thread({ parentThreadId: origin })).info.relation, undefined);
  assert.equal(projectCodexSessionInfo(thread({ forkedFromId: 'invalid' })).state, 'projected');
});

test('fork of a handoff retains native fork lineage in history and catalogue', () => {
  const origin = '019a1234-abcd-7abc-8abc-123456789abd';
  const built = buildSessionHandoff({
    requestId: '123e4567-e89b-42d3-a456-426614174000', sourceSessionId: 'source', sourceBackend: 'pi',
    sourceEntryId: 'tip', sourceTitle: 'Source title', targetBackend: 'codex',
    messages: [{ role: 'user', content: 'visible' }],
  });
  const fork = thread({ forkedFromId: origin, turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: built.prompt }] },
  ] }] });
  const expected = { kind: 'fork', originSessionId: `codex:${origin}` };
  const info = projectCodexHistory(fork, { tail: 50 }).info;
  assert.equal(info.firstMessage, built.title);
  assert.equal(info.parentSessionId, `codex:${origin}`);
  assert.deepEqual(info.relation, expected);
  assert.deepEqual(projectCodexCatalogue([fork])[0].relation, expected);
  assert.deepEqual(projectCodexSessionInfo({ ...fork, forkedFromId: 'invalid' }).info.relation, built.relation);
});

test('merges duplicate native rows by canonical key and newest metadata', () => {
  const rows = projectCodexCatalogue([thread({ id: id.toUpperCase(), updatedAt: 1, name: 'older' }), thread({ updatedAt: 2, name: 'newer' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `codex:${id}`);
  assert.equal(rows[0].name, 'newer');
});
