import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import ts from 'typescript';
import { isolateClaudeHome, isolatePiHome } from '../lib/claude-test-home.mjs';
await isolateClaudeHome();
await isolatePiHome();
const { isClaudeEffort, CLAUDE_EFFORTS, codexSelectionForModel } = await import('../lib/agent-session-choices.ts');
const source = await readFile(new URL('./useAgentSession.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const handleReasoningChange =');
const end = source.indexOf('  // The head of each queue', start);
const derive = new Script(ts.transpileModule(`(() => {${source.slice(start, end)}; return reasoningControl; })()`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
const model = { id: 'catalogue-id', model: 'native-model', label: 'Native', isDefault: true, defaultEffort: 'low', efforts: ['low', 'max', 'ultra', 'future'].map(value => ({ value, description: `native ${value}` })) };
function control(overrides = {}) {
  const changes = [], saved = [];
  const context = {
    useCallback: callback => callback, useMemo: callback => callback(),
    backend: 'pi', backendRef: { current: overrides.backend ?? 'pi' }, capabilities: { effort: true },
    displayModel: { provider: 'pi-provider', modelId: 'pi-model' }, modelThinkingLevels: {}, modelThinkingLevelMaps: {},
    isNew: true, newSessionThinkingLevel: null, thinkingLevel: 'high', savedDefaultThinkingLevel: 'medium',
    displayThinkingLevel: 'high',
    sessionIdRef: { current: null }, codexDraft: null, codexDraftRef: { current: null }, codexSettings: null,
    codexSettingsRef: { current: null }, codexModelChoices: [model], modelError: null, modelSwitching: false, agentRunning: false,
    isClaudeEffort, CLAUDE_EFFORT_LEVELS: CLAUDE_EFFORTS,
    translate: key => key,
    handleSetDefaultThinkingLevel: level => saved.push(level),
    handleThinkingLevelChange: level => changes.push(level),
    handleCodexSettingsChange: pair => changes.push(pair), ...overrides,
  };
  return { value: derive.runInNewContext(context), changes, saved, context };
}

test('Pi rows preserve automatic selection, mapped labels and explicit default stars', () => {
  const { value, changes, saved } = control({ modelThinkingLevels: { 'pi-provider:pi-model': ['low', 'medium', 'high'] }, modelThinkingLevelMaps: { 'pi-provider:pi-model': { high: 'mapped-high' } } });
  assert.deepEqual(Array.from(value.rows, row => row.key), ['auto', 'low', 'medium', 'high']);
  assert.equal(value.rows[0].selected, true);
  const high = value.rows.find(row => row.key === 'high');
  assert.equal(high.label, 'mapped-high'); assert.equal(high.originalLabel, 'high');
  assert.equal(value.label, 'mapped-high');
  assert.equal(value.rows.find(row => row.key === 'medium').star.isDefault, true);
  high.star.onSave(); assert.deepEqual(saved, ['high']); assert.deepEqual(changes, []);
  value.onChange(high.choice); assert.deepEqual(changes, ['high']);
});

test('Claude rows filter supported efforts and automatic choice keeps its null reset', () => {
  const { value, changes } = control({ backend: 'claude', displayModel: { provider: 'claude', modelId: 'sonnet' }, modelThinkingLevels: { 'claude:sonnet': ['low', 'high', 'ultra'] } });
  assert.deepEqual(Array.from(value.rows, row => row.key), ['auto', 'low', 'high']);
  assert.equal(value.rows.some(row => row.star), false);
  assert.equal(value.rows[0].choice.effort, null);
  assert.equal(value.rows[0].description, 'chat.claudeReasoningDefault');
  value.onChange(value.rows[0].choice); assert.deepEqual(changes, ['auto']);
  assert.equal(control({ backend: 'claude', displayModel: { provider: 'claude', modelId: 'sonnet' }, modelThinkingLevels: { 'claude:sonnet': [] } }).value, null);
});

test('native rows preserve future strings, passive default and complete model-bound choices', () => {
  const selection = { model: model.model, effort: 'ultra' };
  const { value, changes } = control({ backend: 'codex', codexDraft: selection, codexDraftRef: { current: selection } });
  assert.deepEqual(Array.from(value.rows, row => row.key), ['low', 'max', 'ultra', 'future']);
  assert.equal(value.label, 'ultra'); assert.equal(value.rows[2].selected, true);
  assert.match(value.rows[0].description, /chat.nativeReasoningDefault/);
  assert.equal(value.rows.some(row => row.star), false);
  value.onChange(value.rows[3].choice);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ model: 'native-model', effort: 'future' }]);
  value.onChange({ backend: 'codex', model: 'stale-model', effort: 'future' });
  value.onChange({ backend: 'pi', level: 'high' });
  assert.equal(changes.length, 1);
});

test('native untouched defaults and missing catalogue retain truthful display without invented rows', () => {
  const untouched = control({ backend: 'codex' }).value;
  assert.equal(untouched.label, 'chat.nativeReasoningUnresolved'); assert.equal(untouched.rows.length, 0); assert.equal(untouched.disabled, true);
  const effective = { backend: 'codex', model: 'removed-model', modelProvider: 'provider', effort: 'future-unlisted' };
  const missing = control({ backend: 'codex', isNew: false, codexSettings: effective, codexSettingsRef: { current: effective }, codexModelChoices: [], modelError: 'unavailable' }).value;
  assert.equal(missing.label, 'future-unlisted'); assert.equal(missing.disabled, true); assert.equal(missing.rows.length, 0);
  const active = control({ backend: 'codex', codexDraft: { model: model.model, effort: 'max' }, agentRunning: true }).value;
  assert.equal(active.disabled, true);
});

test('model switches retain supported effort or use that model advertised default', () => {
  assert.deepEqual(codexSelectionForModel(model, 'ultra'), { model: model.model, effort: 'ultra' });
  assert.deepEqual(codexSelectionForModel(model, 'absent'), { model: model.model, effort: 'low' });
  assert.deepEqual(codexSelectionForModel({ ...model, defaultEffort: 'medium', efforts: [{ value: 'medium', description: '' }] }, null), { model: model.model, effort: 'medium' });
});

const ast = ts.createSourceFile('useAgentSession.ts', source, ts.ScriptTarget.Latest, true);
const declarations = [];
function visit(node) { if (ts.isVariableDeclaration(node)) declarations.push(node); ts.forEachChild(node, visit); }
visit(ast);
function callback(name, context) {
  const node = declarations.find(node => node.name.getText(ast) === name);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText).runInNewContext(context);
}

test('fresh native create serializes only a complete explicit pair and learns untouched native settings', async () => {
  const { parseCodexSettings } = await import('../lib/agent-session-choices.ts');
  for (const selection of [null, { model: 'native-model', effort: 'ultra' }]) {
    const requests = [], effective = [];
    const context = {
      isNew: true, newSessionCwd: '/project', backendRef: { current: 'codex' },
      sessionIdRef: { current: null }, ensuringNewSessionRef: { current: null }, creationRequestIdRef: { current: { get: () => 'stable-identity' } },
      codexDraftRef: { current: selection }, codexSettingsRef: { current: null },
      newSessionModelOverrideRef: { current: null }, thinkingLevelOverrideRef: { current: null }, sessionToolsPinnedRef: { current: false },
      claudeProjectTrustConfirmedRef: { current: true }, parseCodexSettings,
      asConcreteThinkingLevel: () => null, setCodexSettings: value => effective.push(value),
      fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ sessionId: 'codex:test', state: { settings: { backend: 'codex', model: 'native-model', modelProvider: 'actual-provider', effort: selection?.effort ?? 'low' } } }) }; },
    };
    const ensure = callback('ensureNewSession', context);
    assert.equal(await ensure(), 'codex:test');
    assert.deepEqual(requests, [{ backend: 'codex', cwd: '/project', type: 'ensure_session', requestId: 'stable-identity', ...(selection ?? {}) }]);
    assert.equal(effective[0].effort, selection?.effort ?? 'low');
    assert.equal(await ensure(), 'codex:test'); assert.equal(requests.length, 1);
  }
});

test('Claude automatic reasoning sends the existing null reset rather than a Pi command', async () => {
  const commands = [], writes = [];
  const context = {
    backendRef: { current: 'claude' }, sessionIdRef: { current: 'claude:test' }, thinkingLevelOverrideRef: { current: 'high' },
    setNewSessionThinkingLevel: value => writes.push(value), setCurrentThinkingOverride() {}, setLiveThinkingLevel() {},
    sendAgentCommand: async (id, command) => commands.push({ id, ...command }),
  };
  await callback('handleThinkingLevelChange', context)('auto');
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [{ id: 'claude:test', type: 'set_effort', effort: null }]);
  assert.deepEqual(writes, [null]);
});

test('Pi model selection accepts a custom provider named codex in new and existing sessions', async () => {
  for (const isNew of [true, false]) {
    const commands = [], drafts = [], reloads = [];
    const context = {
      backend: 'pi', backendRef: { current: 'pi' }, isNew,
      newSessionModelOverrideRef: { current: null },
      setNewSessionModel: value => drafts.push(value), setPendingModel() {},
      thinkingLevelOverrideRef: { current: null }, thinkingLevelPinsRef: { current: {} },
      defaultThinkingLevelRef: { current: null }, asConcreteThinkingLevel: () => null,
      setNewSessionDefaultThinkingLevel() {},
      sessionIdRef: { current: isNew ? null : 'pi-session' }, ensuringNewSessionRef: { current: null },
      modelSwitchPendingRef: { current: false }, currentModelOverride: null,
      setCurrentModelOverride() {}, setModelSwitching() {}, setLiveModel() {},
      agentRunningRef: { current: false }, bashRunningRef: { current: false },
      sendAgentCommand: async (id, command) => { commands.push({ id, ...command }); return { provider: command.provider, id: command.modelId }; },
      loadSession: async id => reloads.push(id),
    };
    const select = callback('handleModelChange', context);
    await select('codex', 'pi-model');
    if (isNew) {
      assert.deepEqual(JSON.parse(JSON.stringify(drafts)), [{ provider: 'codex', modelId: 'pi-model' }]);
      assert.equal(commands.length, 0);
    } else {
      await select('codex', 'pi-model');
      assert.deepEqual(JSON.parse(JSON.stringify(commands)), Array.from({ length: 2 }, () => ({ id: 'pi-session', type: 'set_model', provider: 'codex', modelId: 'pi-model' })));
      assert.deepEqual(reloads, ['pi-session', 'pi-session']);
    }
  }
});

test('model callbacks from a previous backend cannot change the current backend', async () => {
  for (const [origin, current] of [['codex', 'pi'], ['pi', 'codex']]) {
    await callback('handleModelChange', { backend: origin, backendRef: { current } })('codex', 'native-model');
  }
});

test('an existing native model switch uses authoritative effort, including unknown, rather than a creation draft', async () => {
  const changes = [];
  const context = {
    backend: 'codex', backendRef: { current: 'codex' }, codexModelChoices: [model], sessionIdRef: { current: 'codex:existing' },
    codexSettingsRef: { current: { backend: 'codex', model: 'old-model', modelProvider: 'provider', effort: null } },
    codexDraftRef: { current: { model: 'native-model', effort: 'ultra' } }, codexSelectionForModel,
    handleCodexSettingsChange: async pair => changes.push(pair),
  };
  await callback('handleModelChange', context)('codex', model.model);
  assert.deepEqual(changes, [{ model: model.model, effort: 'low' }]);
});
