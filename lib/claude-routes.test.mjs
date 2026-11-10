import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { claudeCreate, claudeFailure, claudeCommand, claudeFork, claudeRename, claudeDelete } = await jiti.import("./claude-routes.ts");
const base = { cwd: tmpdir(), type: "ensure_session", requestId: "123e4567-e89b-42d3-a456-426614174000" };

test("Claude creation accepts native model and effort but rejects Pi overrides", async () => {
  const accepted = await claudeCreate({ ...base, modelId: "opus", effort: "high" });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  await claudeDelete(acceptedBody.sessionId);
  for (const field of ["provider", "thinkingLevel", "toolNames"]) {
    const response = await claudeCreate({ ...base, requestId: crypto.randomUUID(), [field]: field === "toolNames" ? [] : "pi-value" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Pi/);
  }
});
test("Claude creation requires an existing absolute directory and stable request id", async () => {
  for (const change of [{ cwd: "relative/path" }, { requestId: undefined }, { requestId: "new-id" }, { type: "set_model" }]) {
    const response = await claudeCreate({ ...base, ...change });
    assert.equal(response.status, 400);
  }
});
test("disabled Claude refuses creation without importing or starting the native backend", async () => {
  const previous = process.env.PI_WEB_CLAUDE;
  process.env.PI_WEB_CLAUDE = "0";
  try {
    const id = "claude:" + base.requestId;
    for (const response of await Promise.all([claudeCreate(base), claudeCommand(id, { type: "prompt", message: "no" }), claudeFork(id, {}), claudeRename(id, "no"), claudeDelete(id)])) {
      assert.equal(response.status, 409);
    }
  }
  finally {
    if (previous === undefined) delete process.env.PI_WEB_CLAUDE;
    else process.env.PI_WEB_CLAUDE = previous;
  }
});
test("expired or duplicated interaction responses preserve conflict status", async () => {
  const error = Object.assign(new Error("Interaction is no longer pending"), { status: 409 });
  const response = claudeFailure(error);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: error.message });
});
