import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../../claude-test-home.mjs';

await isolateClaudeHome();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { ClientMethod, NotificationMethod, ServerRequestMethod, isRpcEnvelope, isInitializeResponse, CODEX_PROTOCOL_VERSION, SUPPORTED_CODEX_CLI_VERSION } = await jiti.import('./protocol.ts');
const { inspectCodexVersion } = await jiti.import('./version.ts');

test('protocol constants pin the tested method families', () => {
  assert.equal(CODEX_PROTOCOL_VERSION, 'v2');
  assert.equal(SUPPORTED_CODEX_CLI_VERSION, '0.153.4');
  assert.equal(ClientMethod.initialize, 'initialize');
  assert.equal(ClientMethod.turnStart, 'turn/start');
  assert.equal(ClientMethod.modelList, 'model/list');
  assert.equal(ClientMethod.skillsList, 'skills/list');
  assert.equal(ClientMethod.mcpStatusList, 'mcpServerStatus/list');
  assert.equal(ClientMethod.threadSettingsUpdate, 'thread/settings/update');
  assert.equal(ClientMethod.threadFork, 'thread/fork');
  assert.equal(ClientMethod.threadCompact, 'thread/compact/start');
  assert.equal(NotificationMethod.threadSettingsUpdated, 'thread/settings/updated');
  assert.equal(ServerRequestMethod.commandApproval, 'item/commandExecution/requestApproval');
  assert.equal(NotificationMethod.agentMessageDelta, 'item/agentMessage/delta');
});

test('envelope guard accepts requests, notifications and responses', () => {
  for (const value of [{ id: 1, method: 'a', params: {} }, { id: '1', method: 'a' }, { method: 'notice' }, { id: 1, result: null }, { id: '1', error: { code: -1, message: 'bad' } }, { jsonrpc: '2.0', id: 0, result: {} }]) assert.equal(isRpcEnvelope(value), true);
});

test('negative control rejects malformed envelopes', () => {
  for (const value of [null, [], {}, { id: null, result: 1 }, { id: 1 }, { id: 1, result: 1, error: {} }, { id: 1, error: { code: 3 } }, { method: 'a', id: null }, { method: 'a', result: 1 }, { jsonrpc: '1.0', method: 'a' }]) assert.equal(isRpcEnvelope(value), false);
});

test('initialize shape and exact supported version', () => {
  assert.equal(isInitializeResponse({ userAgent: 'x', codexHome: 'x', platformFamily: 'unix', platformOs: 'darwin' }), true);
  assert.equal(isInitializeResponse({ userAgent: 'x' }), false);
  assert.deepEqual(inspectCodexVersion('codex-cli 0.153.4\n'), { state: 'supported', version: '0.153.4' });
  assert.deepEqual(inspectCodexVersion('codex-cli 0.153.5'), { state: 'unsupported', version: '0.153.5' });
  assert.deepEqual(inspectCodexVersion('codex-cli 0.153.4-beta'), { state: 'unsupported', version: '0.153.4-beta' });
  assert.deepEqual(inspectCodexVersion('other 0.153.4'), { state: 'invalid' });
});
