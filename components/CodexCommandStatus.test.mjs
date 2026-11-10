import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolateClaudeHome, isolatePiHome } from '../lib/claude-test-home.mjs';
import { createJiti } from 'jiti';

const root = fileURLToPath(new URL('..', import.meta.url));
const ownHome = await mkdtemp(join(tmpdir(), 'codex-renderer-'));
Object.assign(process.env, { HOME: ownHome, CODEX_HOME: join(ownHome, 'codex'), CLAUDE_CONFIG_DIR: join(ownHome, 'claude') });
await mkdir(process.env.CODEX_HOME); await mkdir(process.env.CLAUDE_CONFIG_DIR);
await isolateClaudeHome(); await isolatePiHome();
for (const name of ['JITI_ALIAS','PI_PACKAGE_DIR','PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT','PI_PROVIDER','PI_MODEL']) delete process.env[name];
after(() => rm(ownHome, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true, alias: { '@': root } });
const React = await jiti.import('react');
const { renderToStaticMarkup } = await jiti.import('react-dom/server');
const { MessageView } = await jiti.import(`${root}/components/MessageView.tsx`);
const { I18nProvider } = await jiti.import('@/hooks/useI18n');
const { setToolCallExpanded } = await jiti.import('@/lib/tool-call-expansion');
const { projectItem } = await jiti.import('@/lib/agent-backends/codex/history');
const { isTerminalCodexActivity } = await jiti.import('@/lib/codex-reconcile');
const { codexPayloadValidators } = await jiti.import('@/lib/agent-backends/codex/internal/payloads');

const id = '019c1bed-f24e-7f5f-a7f2-496c101e4e7a';
const thread = { id, sessionId: id, preview: '', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: '/tmp', cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [] };
const validators = codexPayloadValidators({ state: 'supported', version: '0.153.4' });
assert.equal(validators.state, 'supported');
setToolCallExpanded('bash-', true);

function render(status, output = null, exitCode = null) {
  const item = { id: 'item', type: 'commandExecution', command: 'test command', commandActions: [], cwd: '/tmp', status, aggregatedOutput: output, exitCode };
  const payload = { thread: { ...thread, turns: [{ id: 'turn', status: 'completed', items: [item] }] } };
  assert.equal(validators.validators.validate('thread/read', payload).state, 'valid', 'fixture passes pinned native schema');
  const message = projectItem(item, thread).message;
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MessageView, { message })));
  const observation = { status, output, exitCode, projectedStatus: message.codexStatus, terminal: isTerminalCodexActivity(message), red: html.includes('rgba(248,113,113'), green: html.includes('rgba(34,197,94'), noOutput: html.includes('(no output)') };
  console.log(JSON.stringify(observation));
  return observation;
}

test('running and failed exit-code controls render distinct states', () => {
  const running = render('inProgress');
  const failed = render('failed', null, 7);
  assert.equal(running.terminal, false);
  assert.equal(running.red, false);
  assert.equal(running.noOutput, false);
  assert.equal(failed.terminal, true);
  assert.equal(failed.red, true);
  assert.equal(failed.noOutput, true);
});

for (const status of ['failed', 'declined']) {
  test(`${status} without output or an exit code renders as terminal error`, () => {
    const observed = render(status);
    assert.equal(observed.terminal, true);
    assert.equal(observed.red, true, 'terminal failure must not use the running/success color');
    assert.equal(observed.noOutput, true, 'terminal empty output should be represented as a result');
  });
}

test('completed command without output or exit code renders a finished result', () => {
  const observed = render('completed');
  assert.equal(observed.terminal, true);
  assert.equal(observed.red, false);
  assert.equal(observed.noOutput, true, 'terminal empty output should be represented as a result');
});

test('failed command with text but no exit code uses error styling', () => {
  const observed = render('failed', 'native error text');
  assert.equal(observed.terminal, true);
  assert.equal(observed.red, true, 'terminal failure with output must not look successful');
});

test('ordinary Pi bash keeps pending, cancellation and exit-code behavior', () => {
  const view = message => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MessageView, { message: { role:'bashExecution', command:'test command', ...message } })));
  assert.equal(view({output:''}).includes('(no output)'),false);
  assert.equal(view({output:'',exitCode:0}).includes('(no output)'),true);
  assert.equal(view({output:'',cancelled:true}).includes('rgba(248,113,113'),true);
  assert.equal(view({output:'partial'}).includes('partial'),true);
});
