import test from "node:test";
import assert from "node:assert/strict";
import { validatePiSessionChoices } from "./agent-session-choices.ts";

test("revalidates carried Pi model and thinking choices after returning from Claude", () => {
  const models = [{ provider: "openai", id: "new-project-model" }];
  assert.deepEqual(
    validatePiSessionChoices(
      { provider: "old-project", modelId: "stale" },
      "high",
      models,
      { "openai:new-project-model": ["low"] },
      { provider: "openai", modelId: "new-project-model" },
    ),
    { model: null, thinking: null },
  );
  assert.deepEqual(
    validatePiSessionChoices(
      { provider: "openai", modelId: "new-project-model" },
      "high",
      models,
      { "openai:new-project-model": ["low"] },
    ),
    { model: { provider: "openai", modelId: "new-project-model" }, thinking: null },
  );
  assert.deepEqual(
    validatePiSessionChoices(
      null,
      "high",
      models,
      { "openai:new-project-model": ["low"] },
      { provider: "openai", modelId: "new-project-model" },
    ),
    { model: null, thinking: null },
  );
  assert.deepEqual(
    validatePiSessionChoices(
      { provider: "openai", modelId: "new-project-model" },
      "low",
      models,
      { "openai:new-project-model": ["low"] },
    ),
    { model: { provider: "openai", modelId: "new-project-model" }, thinking: "low" },
  );
});

test('native catalogue rejects incomplete metadata and preserves both identities and future effort strings', async () => {
  const { parseCodexModels, parseCodexSettings, isClaudeEffort } = await import('./agent-session-choices.ts');
  const row = { id: 'row-id', model: 'native-model', label: 'Native model', isDefault: true, defaultEffort: 'ultra', efforts: [{ value: 'ultra', description: 'Native ultra' }, { value: 'future', description: 'Native future' }] };
  assert.deepEqual(parseCodexModels([row]), [row]);
  for (const input of [[], [{ ...row, defaultEffort: 'missing' }], [row, row], [{ ...row, efforts: [] }], [{ ...row, model: '' }]]) assert.throws(() => parseCodexModels(input));
  assert.equal(isClaudeEffort('ultra'), false);
  const settings = { backend: 'codex', model: 'unknown', modelProvider: 'native', effort: 'future' };
  assert.deepEqual(parseCodexSettings(settings), settings);
  assert.equal(parseCodexSettings({ ...settings, effort: '' }), null);
  assert.deepEqual(parseCodexSettings({ ...settings, effort: null }), { ...settings, effort: null });
});
