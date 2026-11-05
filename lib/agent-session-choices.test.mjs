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
