import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../../claude-test-home.mjs';

await isolateClaudeHome();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { codexPayloadValidators } = await jiti.import('./payloads.ts');
const version = { state: 'supported', version: '0.153.4' };
const result = codexPayloadValidators(version);
assert.equal(result.state, 'supported');
const { validate } = result.validators;
const item = { type: 'agentMessage', id: 'item', text: 'hello' };
const turn = { id: 'turn', status: 'completed', items: [item] };
const thread = { id: 'thread', sessionId: 'session', preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: '/tmp', cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [turn] };
const ids = { threadId: 'thread', turnId: 'turn', itemId: 'item' };
const threadResponse = { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: '/tmp', model: 'test', modelProvider: 'test', sandbox: { type: 'readOnly' } };
const usage = { cachedInputTokens: 1, inputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 5 };
const examples = [
  ['thread/list', { data: [thread] }, 'data', 1],
  ['thread/read', { thread }, 'thread', 1],
  ['account/read', { requiresOpenaiAuth: false, account: null }, 'requiresOpenaiAuth', 'no'],
  ['thread/start:response', threadResponse, 'thread', 1],
  ['thread/resume:request', { threadId: 'thread' }, 'threadId', 1],
  ['thread/resume:response', threadResponse, 'thread', 1],
  ['turn/start:request', { threadId: 'thread', input: [{ type: 'text', text: 'hello', text_elements: [] }] }, 'input', 1],
  ['turn/start:response', { turn }, 'turn', 1],
  ['turn/steer:request', { threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'hello', text_elements: [] }] }, 'expectedTurnId', 1],
  ['turn/steer:response', { turnId: 'turn' }, 'turnId', 1],
  ['turn/interrupt:request', { threadId: 'thread', turnId: 'turn' }, 'turnId', 1],
  ['item/commandExecution/requestApproval:response', { decision: 'accept' }, 'decision', 1],
  ['item/fileChange/requestApproval:response', { decision: 'decline' }, 'decision', 1],
  ['item/tool/requestUserInput:response', { answers: { q: { answers: ['yes'] } } }, 'answers', 1],
  ['thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { last: usage, total: usage } }, 'tokenUsage', 1],
  ['thread/started', { thread }, 'thread', 1],
  ['remoteControl/status/changed', { installationId: 'fixture', serverName: 'fixture', status: 'disabled' }, 'status', 1],
  ['error', { threadId: 'thread', turnId: 'turn', error: { message: 'failure' }, willRetry: false }, 'willRetry', 1],
  ['turn/started', { threadId: 'thread', turn }, 'turn', 1],
  ['turn/completed', { threadId: 'thread', turn }, 'turn', 1],
  ['item/started', { ...ids, item, startedAtMs: 1 }, 'startedAtMs', '1'],
  ['item/completed', { ...ids, item, completedAtMs: 1 }, 'completedAtMs', '1'],
  ['item/agentMessage/delta', { ...ids, delta: 'x' }, 'delta', 1],
  ['item/reasoning/textDelta', { ...ids, delta: 'x', contentIndex: 0 }, 'contentIndex', '0'],
  ['item/reasoning/summaryTextDelta', { ...ids, delta: 'x', summaryIndex: 0 }, 'summaryIndex', '0'],
  ['serverRequest/resolved', { threadId: 'thread', requestId: 1 }, 'requestId', null],
  ['item/commandExecution/requestApproval', { ...ids, startedAtMs: 1 }, 'startedAtMs', '1'],
  ['item/fileChange/requestApproval', { ...ids, startedAtMs: 1 }, 'startedAtMs', '1'],
  ['item/permissions/requestApproval', { ...ids, startedAtMs: 1, cwd: '/tmp', permissions: {} }, 'permissions', []],
  ['item/tool/requestUserInput', { ...ids, isBlocking: true, questions: [{ id: 'q', header: 'header', question: 'question' }] }, 'questions', {}],
  ['mcpServer/elicitation/request', { threadId: 'thread', serverName: 'server', mode: 'form', message: 'question', requestedSchema: { type: 'object', properties: {} } }, 'serverName', 1],
  ['execCommandApproval', { callId: 'call', conversationId: 'thread', command: [], cwd: '/tmp', parsedCmd: [] }, 'command', {}],
  ['applyPatchApproval', { callId: 'call', conversationId: 'thread', fileChanges: {} }, 'fileChanges', []],
];

const model = { id: 'native-model', model: 'native-model', displayName: 'Native model', description: 'Fixture metadata', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Maximum' }, { reasoningEffort: 'ultra', description: 'Ultra' }], defaultReasoningEffort: 'max' };
const threadSettings = { approvalPolicy: 'on-request', approvalsReviewer: 'user', collaborationMode: { mode: 'default', settings: { model: 'native-model' } }, cwd: '/tmp', model: 'native-model', modelProvider: 'test', sandboxPolicy: { type: 'readOnly' } };
const skill = { name: 'fixture', description: 'Fixture skill', enabled: true, path: '/tmp/fixture/SKILL.md', scope: 'repo' };
const skillGroup = { cwd: '/tmp', errors: [{ path: '/tmp/bad/SKILL.md', message: 'Invalid fixture' }], skills: [skill] };
const mcpServer = { name: 'fixture', authStatus: 'notLoggedIn', tools: { fixture: { name: 'fixture', inputSchema: { type: 'object' } } }, resources: [{ name: 'metadata', uri: 'fixture://metadata' }], resourceTemplates: [{ name: 'template', uriTemplate: 'fixture://{name}' }] };
const nativeExamples = [
  ['model/list:request', { cursor: 'page', limit: 2, includeHidden: true }, {}, { cursor: 1, limit: -1, includeHidden: 'yes' }],
  ['model/list:response', { data: [model] }, { data: {} }],
  ['thread/settings/update:request', { threadId: 'thread', model: 'native-model', cwd: '/tmp', effort: 'ultra' }, { threadId: 1 }, { model: 1, cwd: 1, effort: '' }],
  ['thread/settings/update:response', {}, {}],
  ['thread/settings/updated', { threadId: 'thread', threadSettings }, { threadId: 1, threadSettings: [] }],
  ['skills/list:request', { cwds: ['/tmp'], forceReload: true }, {}, { cwds: [1], forceReload: 1 }],
  ['skills/list:response', { data: [skillGroup] }, { data: {} }],
  ['mcpServerStatus/list:request', { cursor: 'page', limit: 2, threadId: 'thread', detail: 'toolsAndAuthOnly' }, {}, { cursor: 1, limit: 1.5, threadId: 1, detail: 'future' }],
  ['mcpServerStatus/list:response', { data: [mcpServer] }, { data: {} }],
  ['thread/fork:request', { threadId: 'thread', model: 'native-model', modelProvider: 'test', cwd: '/tmp', excludeTurns: true }, { threadId: 1 }, { model: 1, modelProvider: 1, cwd: 1, excludeTurns: null }],
  ['thread/fork:response', threadResponse, { thread: 1, approvalPolicy: 1, approvalsReviewer: 1, cwd: 1, model: 1, modelProvider: 1, sandbox: 1 }],
  ['thread/compact/start:request', { threadId: 'thread' }, { threadId: 1 }],
  ['thread/compact/start:response', {}, {}],
];

for (const [method, payload, required, optional = {}] of nativeExamples) {
  test(`${method} accepts schema-valid metadata and enforces its actual required fields`, () => {
    assert.equal(validate(method, payload).state, 'valid');
    for (const [field, wrong] of Object.entries(required)) {
      const missing = { ...payload };
      delete missing[field];
      assert.deepEqual(validate(method, missing), { state: 'invalid' }, `${method} requires ${field}`);
      assert.deepEqual(validate(method, { ...payload, [field]: wrong }), { state: 'invalid' }, `${method} rejects mistyped ${field}`);
    }
    for (const [field, wrong] of Object.entries(optional)) {
      assert.deepEqual(validate(method, { ...payload, [field]: wrong }), { state: 'invalid' }, `${method} rejects invalid ${field}`);
    }
    for (const wrong of [null, [], 'payload', 1]) assert.deepEqual(validate(method, wrong), { state: 'invalid' });
  });
}

const nestedExamples = [
  ['model metadata', 'model/list:response', model, { id: 1, model: 1, displayName: 1, description: 1, hidden: 1, isDefault: 1, supportedReasoningEfforts: {}, defaultReasoningEffort: '' }, value => ({ data: [value] })],
  ['model effort option', 'model/list:response', model.supportedReasoningEfforts[0], { reasoningEffort: '', description: 1 }, value => ({ data: [{ ...model, supportedReasoningEfforts: [value] }] })],
  ['effective settings', 'thread/settings/updated', threadSettings, { approvalPolicy: 1, approvalsReviewer: 1, collaborationMode: {}, cwd: 1, model: 1, modelProvider: 1, sandboxPolicy: {} }, value => ({ threadId: 'thread', threadSettings: value })],
  ['skills group', 'skills/list:response', skillGroup, { cwd: 1, errors: {}, skills: {} }, value => ({ data: [value] })],
  ['skill metadata', 'skills/list:response', skill, { name: 1, description: 1, enabled: 1, path: 1, scope: 'future' }, value => ({ data: [{ ...skillGroup, skills: [value] }] })],
  ['skill error', 'skills/list:response', skillGroup.errors[0], { path: 1, message: 1 }, value => ({ data: [{ ...skillGroup, errors: [value] }] })],
  ['MCP server', 'mcpServerStatus/list:response', mcpServer, { name: 1, authStatus: 'future', tools: [], resources: {}, resourceTemplates: {} }, value => ({ data: [value] })],
  ['MCP tool metadata', 'mcpServerStatus/list:response', mcpServer.tools.fixture, { name: 1 }, value => ({ data: [{ ...mcpServer, tools: { fixture: value } }] })],
  ['MCP resource metadata', 'mcpServerStatus/list:response', mcpServer.resources[0], { name: 1, uri: 1 }, value => ({ data: [{ ...mcpServer, resources: [value] }] })],
  ['MCP resource template', 'mcpServerStatus/list:response', mcpServer.resourceTemplates[0], { name: 1, uriTemplate: 1 }, value => ({ data: [{ ...mcpServer, resourceTemplates: [value] }] })],
];

for (const [name, method, payload, required, wrap] of nestedExamples) {
  test(`${name} rejects missing or mistyped required nested fields`, () => {
    assert.equal(validate(method, wrap(payload)).state, 'valid');
    for (const [field, wrong] of Object.entries(required)) {
      const missing = { ...payload };
      delete missing[field];
      assert.deepEqual(validate(method, wrap(missing)), { state: 'invalid' }, `${name} requires ${field}`);
      assert.deepEqual(validate(method, wrap({ ...payload, [field]: wrong })), { state: 'invalid' }, `${name} rejects mistyped ${field}`);
    }
  });
}

test('accepts empty optional requests and object responses without inventing required fields', () => {
  for (const method of ['model/list:request', 'skills/list:request', 'mcpServerStatus/list:request', 'thread/settings/update:response', 'thread/compact/start:response']) {
    assert.equal(validate(method, {}).state, 'valid');
    assert.equal(validate(method, { future: { opaque: true } }).state, 'valid');
  }
  assert.equal(validate('thread/settings/update:response', { threadId: 1, threadSettings: null }).state, 'valid');
  assert.equal(validate('skills/list:request', { cwds: null }).state, 'invalid');
  assert.equal(validate('skills/list:request', { forceReload: null }).state, 'invalid');
  assert.equal(validate('model/list:request', { limit: 1.5 }).state, 'invalid');
  assert.equal(validate('mcpServerStatus/list:request', { limit: -1 }).state, 'invalid');
});

test('preserves omitted and nullable metadata in native payloads', () => {
  for (const payload of [{}, { cursor: null, limit: null, includeHidden: null }]) assert.equal(validate('model/list:request', payload).state, 'valid');
  for (const payload of [{}, { cursor: null, limit: null, threadId: null, detail: null }]) assert.equal(validate('mcpServerStatus/list:request', payload).state, 'valid');
  for (const nextCursor of [undefined, null, 'page']) {
    const cursor = nextCursor === undefined ? {} : { nextCursor };
    assert.equal(validate('model/list:response', { data: [model], ...cursor }).state, 'valid');
    assert.equal(validate('mcpServerStatus/list:response', { data: [], ...cursor }).state, 'valid');
  }
  for (const effort of [undefined, null, 'max', 'ultra', 'future-effort']) {
    const option = effort === undefined ? {} : { effort };
    assert.equal(validate('thread/settings/update:request', { threadId: 'thread', ...option }).state, 'valid');
    assert.equal(validate('thread/settings/updated', { threadId: 'thread', threadSettings: { ...threadSettings, ...option } }).state, 'valid');
    for (const method of ['thread/start:response', 'thread/resume:response', 'thread/fork:response']) {
      const reasoning = effort === undefined ? {} : { reasoningEffort: effort };
      assert.equal(validate(method, { ...threadResponse, ...reasoning }).state, 'valid');
    }
  }
  assert.equal(validate('thread/settings/update:request', { threadId: 'thread', model: null, cwd: null }).state, 'valid');
  assert.equal(validate('thread/fork:request', { threadId: 'thread', model: null, modelProvider: null, cwd: null }).state, 'valid');
  assert.equal(validate('skills/list:response', { data: [{ cwd: '/tmp', skills: [{ ...skill, shortDescription: null, pluginId: null, interface: null, dependencies: null }], errors: [] }] }).state, 'valid');
  assert.equal(validate('mcpServerStatus/list:response', { data: [{ ...mcpServer, pluginId: null, runtimeStatus: null, serverInfo: null }] }).state, 'valid');
  assert.equal(validate('model/list:response', { data: [{ ...model, upgrade: null, upgradeInfo: null, modelSpecialty: null, availabilityNux: null, defaultServiceTier: null, multiAgentVersion: null }] }).state, 'valid');
});

test('keeps native effort strings schema-bound and effective settings authoritative', () => {
  for (const effort of ['', 1, false]) {
    assert.equal(validate('model/list:response', { data: [{ ...model, defaultReasoningEffort: effort }] }).state, 'invalid');
    assert.equal(validate('model/list:response', { data: [{ ...model, supportedReasoningEfforts: [{ reasoningEffort: effort, description: 'Invalid' }] }] }).state, 'invalid');
    assert.equal(validate('thread/settings/updated', { threadId: 'thread', threadSettings: { ...threadSettings, effort } }).state, 'invalid');
    for (const method of ['thread/start:response', 'thread/resume:response', 'thread/fork:response']) assert.equal(validate(method, { ...threadResponse, reasoningEffort: effort }).state, 'invalid');
  }
  assert.equal(validate('model/list:response', { data: [{ ...model, defaultReasoningEffort: null }] }).state, 'invalid');
  for (const field of ['model', 'modelProvider', 'cwd']) {
    assert.equal(validate('thread/settings/updated', { threadId: 'thread', threadSettings: { ...threadSettings, [field]: null } }).state, 'invalid');
    for (const method of ['thread/start:response', 'thread/resume:response', 'thread/fork:response']) assert.equal(validate(method, { ...threadResponse, [field]: null }).state, 'invalid');
  }
});

test('keeps unconstrained MCP schemas opaque and unknown payload methods invalid', () => {
  for (const inputSchema of [null, {}, true, 'opaque', 1, []]) assert.equal(validate('mcpServerStatus/list:response', { data: [{ ...mcpServer, tools: { fixture: { name: 'fixture', inputSchema } } }] }).state, 'valid');
  assert.equal(validate('mcpServerStatus/list:response', { data: [{ ...mcpServer, tools: { fixture: { name: 'fixture' } } }] }).state, 'invalid');
  assert.deepEqual(validate('future/method', {}), { state: 'invalid' });
  assert.deepEqual(validate('mcpServer/startupStatus/updated', { name: 'fixture', status: 'ready' }), { state: 'invalid' });
});

for (const [method, payload, required, wrong] of examples) {
  test(`${method} validates its pinned payload and rejects missing or mistyped fields`, () => {
    assert.equal(validate(method, payload).state, 'valid');
    const missing = { ...payload };
    delete missing[required];
    assert.deepEqual(validate(method, missing), { state: 'invalid' });
    assert.deepEqual(validate(method, { ...payload, [required]: wrong }), { state: 'invalid' });
  });
}

test('validates lifecycle payloads without required fields', () => {
  assert.equal(validate('thread/start:request', {}).state, 'valid');
  assert.equal(validate('thread/start:request', { cwd: 1 }).state, 'invalid');
  assert.equal(validate('turn/interrupt:response', {}).state, 'valid');
  assert.equal(validate('turn/interrupt:response', null).state, 'invalid');
});

test('rejects unknown nested discriminators and schema-forbidden properties', () => {
  assert.equal(validate('thread/read', { thread: { ...thread, status: { type: 'future' } } }).state, 'invalid');
  assert.equal(validate('thread/read', { thread: { ...thread, source: { custom: 'x', unexpected: true } } }).state, 'invalid');
  assert.equal(validate('item/started', { ...ids, startedAtMs: 1, item: { ...item, type: 'future' } }).state, 'invalid');
  assert.equal(validate('account/read', { account: { type: 'future' }, requiresOpenaiAuth: true }).state, 'invalid');
  assert.equal(validate('mcpServer/elicitation/request', { threadId: 'thread', serverName: 'server', mode: 'future', message: 'x' }).state, 'invalid');
  assert.equal(validate('item/permissions/requestApproval', { ...ids, startedAtMs: 1, cwd: '/tmp', permissions: { unexpected: true } }).state, 'invalid');
});

test('accepts nullable fields omitted by the JSON Schema', () => {
  assert.equal(validate('account/read', { requiresOpenaiAuth: true }).state, 'valid');
  assert.equal(validate('thread/list', { data: [thread] }).state, 'valid');
  assert.equal(validate('item/tool/requestUserInput', { ...ids, isBlocking: true, questions: [{ id: 'q', header: 'h', question: 'q' }] }).state, 'valid');
});

test('fails closed for invalid and unsupported CLI versions', () => {
  for (const inspection of [{ state: 'invalid' }, { state: 'unsupported', version: '0.153.3' }, { state: 'unsupported', version: '0.153.5' }, { state: 'supported', version: '0.153.5' }]) {
    assert.deepEqual(codexPayloadValidators(inspection), { state: 'unsupported', reason: 'version' });
  }
});

test('fails closed when the pinned schema fixture is absent, corrupt, incomplete or changed', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-web-schema-test-'));
  try {
    const source = dirname(fileURLToPath(import.meta.url));
    const original = JSON.parse(await readFile(join(source, 'schemas.json'), 'utf8'));
    const cases = [
      ['absent', () => undefined],
      ['corrupt JSON', () => '{'],
      ['changed schema', bundle => { bundle.schemas['account/read'] = {}; return JSON.stringify(bundle); }],
      ['missing native schema', bundle => { delete bundle.schemas['model/list:response']; return JSON.stringify(bundle); }],
      ['invalid schema', bundle => { bundle.schemas['model/list:response'] = { type: 'invalid-type' }; return JSON.stringify(bundle); }],
      ['unknown schema format', bundle => { bundle.schemas['model/list:response'] = { type: 'string', format: 'unobserved' }; return JSON.stringify(bundle); }],
      ['wrong fixture version', bundle => { bundle.version = '0.153.5'; return JSON.stringify(bundle); }],
    ];
    for (const [index, [name, change]] of cases.entries()) {
      await t.test(name, async () => {
        const dir = join(temp, String(index));
        await mkdir(dir);
        for (const file of ['payloads.ts', 'version.ts', 'protocol.ts']) await copyFile(join(source, file), join(dir, file));
        await symlink(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
        const fixture = change(structuredClone(original));
        if (fixture !== undefined) await writeFile(join(dir, 'schemas.json'), fixture);
        const isolated = createJiti(join(dir, 'entry.mjs'), { moduleCache: false });
        const isolatedPayloads = await isolated.import(join(dir, 'payloads.ts'));
        assert.deepEqual(isolatedPayloads.codexPayloadValidators(version), { state: 'unsupported', reason: 'schema' });
      });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
