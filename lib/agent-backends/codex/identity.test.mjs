import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const { codexWebSessionId, nativeCodexSessionId } = await createJiti(import.meta.url, { tsconfigPaths: true }).import('./identity.ts');
const id = '019a1234-abcd-7abc-8abc-123456789abc';

test('Codex keys round-trip canonical UUIDv7 thread identities', () => {
  assert.equal(codexWebSessionId(id.toUpperCase()), `codex:${id}`);
  assert.equal(nativeCodexSessionId(`codex:${id.toUpperCase()}`), id);
});

test('Codex keys reject other namespaces and malformed thread identities', () => {
  for (const value of ['', 'x', '019a1234-abcd-4abc-8abc-123456789abc', '../' + id]) {
    assert.throws(() => codexWebSessionId(value));
  }
  for (const value of [id, `claude:${id}`, `codex:${id}:extra`, 'codex:bad']) {
    assert.throws(() => nativeCodexSessionId(value));
  }
});
