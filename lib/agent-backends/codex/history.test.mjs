import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../claude-test-home.mjs';
await isolateClaudeHome();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { projectCodexHistory, projectCodexHandoffMessages } = await jiti.import('./history.ts');
const { codexBatchInput } = await jiti.import('./batch.ts');
const { codexThreadHasUserEnvelope } = await jiti.import('./user-envelope.ts');
const { buildSessionHandoff } = await jiti.import('../../session-handoff.ts');
const id = '019a1234-abcd-7abc-8abc-123456789abc';
const thread = turns => ({ id, sessionId: id, preview: 'hello', ephemeral: false, projectId: null, modelProvider: 'openai', model: 'test-model', createdAt: 1, updatedAt: 2, cwd: '/tmp/project', cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns });

test('projects empty history and paginates completed turns without losing items', () => {
  assert.deepEqual(projectCodexHistory(thread([]), { tail: 2 }).context.messages, []);
  const data = thread([{ id: 'turn', status: 'completed', items: [
    { id: 'one', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
    { id: 'two', type: 'agentMessage', text: 'world' },
    { id: 'three', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/tmp', status: 'completed' },
  ] }]);
  const last = projectCodexHistory(data, { tail: 2 });
  assert.deepEqual(last.context.entryIds, ['two', 'three']);
  assert.equal(last.context.hasMore, true);
  assert.equal(last.context.turnsBefore, 1);
  assert.equal(last.context.messages[0].content[0].text, 'world');
  const earlier = projectCodexHistory(data, { tail: 2, before: last.context.oldestEntryId });
  assert.deepEqual(earlier.context.entryIds, ['one']);
  assert.equal(earlier.context.messages[0].content, 'hello');
  assert.equal(earlier.context.hasMore, false);
  assert.throws(() => projectCodexHistory(data, { tail: 2, before: 'missing' }), /cursor/);
});

test('queued batches retain separate messages and cursors across history reload and handoff', () => {
  const batch = codexBatchInput(['one\nwith lines', 'two', 'three'].map((message, i) => ({
    requestId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, message,
  })));
  const data = thread([{ id: 'turn', status: 'completed', items: [
    { id: 'queued', type: 'userMessage', clientId: batch.clientUserMessageId, content: batch.input },
    { id: 'reply', type: 'agentMessage', text: 'reply' },
  ] }]);
  const snapshot = projectCodexHistory(data, { tail: 3 });
  assert.deepEqual(snapshot.context.messages.slice(0, 2).map(message => message.content), ['two', 'three']);
  assert.equal(snapshot.context.turnsBefore, 1);
  const before = projectCodexHistory(structuredClone(data), { tail: 3, before: snapshot.context.oldestEntryId });
  assert.deepEqual(before.context.messages.map(message => message.content), ['one\nwith lines']);
  assert.deepEqual(projectCodexHandoffMessages(data).filter(message => message.role === 'user').map(message => message.content), ['one\nwith lines', 'two', 'three']);
});

test('incomplete batch metadata preserves the original native user message', () => {
  const data = thread([{ id: 'turn', status: 'completed', items: [{
    id: 'queued', type: 'userMessage', clientId: 'pi-web-batch-v1:["invalid"]',
    content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  }] }]);
  assert.deepEqual(projectCodexHistory(data, { tail: 5 }).context.messages.map(message => message.content), ['one\ntwo']);
});

test('native handoff capture keeps only typed text and exact proof requires the whole user envelope', () => {
  const built = buildSessionHandoff({
    requestId: '123e4567-e89b-42d3-a456-426614174000', sourceSessionId: 'source', sourceBackend: 'pi',
    sourceEntryId: 'tip', sourceTitle: 'Source', targetBackend: 'codex',
    messages: [{ role: 'user', content: 'visible source' }],
  });
  const imported = { id: 'imported', type: 'userMessage', content: [{ type: 'text', text: built.prompt }] };
  const mixed = { id: 'mixed', type: 'userMessage', content: [
    { type: 'text', text: '[image: /legitimate-text]' },
    { type: 'image', path: '/secret/image.png' },
    { type: 'text', text: 'visible text' },
  ] };
  const data = thread([{ id: 'turn', status: 'completed', items: [imported, mixed] }]);
  const projected = projectCodexHandoffMessages(data);
  assert.equal(projected[0].role, 'custom');
  assert.equal(projected[1].role, 'user');
  assert.equal(projected[1].content, '[image: /legitimate-text]\nvisible text');
  assert.doesNotMatch(projected[1].content, /secret\/image/);
  assert.equal(codexThreadHasUserEnvelope(data, built.prompt), true);
  const partial = thread([{ id: 'turn', status: 'completed', items: [
    { ...imported, content: [{ type: 'text', text: built.prompt.slice(0, -1) }] },
  ] }]);
  const extraInput = thread([{ id: 'turn', status: 'completed', items: [
    { ...imported, content: [...imported.content, { type: 'image', path: '/extra.png' }] },
  ] }]);
  const annotated = thread([{ id: 'turn', status: 'completed', items: [
    { ...imported, content: [{ type: 'text', text: built.prompt, text_elements: [{ byteRange: { start: 0, end: 1 }, placeholder: 'special' }] }] },
  ] }]);
  assert.equal(codexThreadHasUserEnvelope(annotated, built.prompt), false);
  const emptyElements = thread([{ id: 'turn', status: 'completed', items: [
    { ...imported, content: [{ type: 'text', text: built.prompt, text_elements: [] }] },
  ] }]);
  assert.equal(codexThreadHasUserEnvelope(emptyElements, built.prompt), true);
  assert.equal(codexThreadHasUserEnvelope(partial, built.prompt), false);
  assert.equal(codexThreadHasUserEnvelope(extraInput, built.prompt), false);
});

test('unhandled native items never expose opaque protocol fields', () => {
  const data = thread([{ id: 'turn', status: 'completed', items: [
    { id: 'one', type: 'webSearch', query: 'ordinary query', action: { type: 'search', hidden: 'SENTINEL_PRIVATE_RPC' }, privateNative: 'SENTINEL_PRIVATE_RPC' },
  ] }]);
  const message = projectCodexHistory(data, { tail: 2 }).context.messages[0];
  assert.equal(message.role, 'custom');
  assert.equal(message.customType, 'webSearch');
  assert.equal(message.details, undefined);
  assert.doesNotMatch(JSON.stringify(message), /SENTINEL_PRIVATE_RPC/);
});

test('preserves unrecognized validated activity as an inspectable message', () => {
  const data = thread([{ id: 'turn', status: 'completed', items: [{ id: 'one', type: 'fileChange', changes: [], privateNative: 'SENTINEL_PRIVATE_RPC' }] }]);
  const message = projectCodexHistory(data, { tail: 2 }).context.messages[0];
  assert.equal(message.role, 'custom');
  assert.deepEqual(message.details.changes, []);
  assert.doesNotMatch(JSON.stringify(message), /SENTINEL_PRIVATE_RPC/);
});
