import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../claude-test-home.mjs';

await isolateClaudeHome();

const { codexEnabled, describeCodex } = await createJiti(import.meta.url, { tsconfigPaths: true }).import('./descriptor.ts');

test('Codex browsing defaults on and can be disabled explicitly', async () => {
  assert.equal(codexEnabled({}), true);
  for (const value of ['0', 'false']) {
    const result = await describeCodex({ binary: '/nonexistent', env: { PI_WEB_CODEX: value } });
    assert.deepEqual(result.availability, { state: 'unavailable', reason: 'disabled' });
    assert.equal(result.capabilities.history, false);
  }
});

test('a supported binary advertises the verified runtime capabilities', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-web-codex-descriptor-'));
  const binary = join(home, 'codex');
  try {
    await writeFile(binary, '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n');
    await chmod(binary, 0o700);
    const result = await describeCodex({ binary, cwd: home, env: { HOME: home, CODEX_HOME: home } });
    assert.deepEqual(result.availability, { state: 'available' });
    assert.deepEqual(Object.entries(result.capabilities).filter(([, value]) => value).map(([name]) => name), ['history', 'prompt', 'stop', 'steer', 'fork', 'compact', 'models', 'setModel', 'effort', 'questions', 'mcp', 'skills']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a missing binary does not advertise browsing', async () => {
  const result = await describeCodex({ binary: '/nonexistent', env: {} });
  assert.equal(result.availability.state, 'unavailable');
  assert.equal(result.capabilities.history, false);
});
