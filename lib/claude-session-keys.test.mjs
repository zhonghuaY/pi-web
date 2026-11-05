import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_ID_PATTERN, parseSessionUiStateRequest } from "./session-ui-state-shared.ts";

const native = "76dd1bed-f24e-4f5f-a7f2-496c101e4e7a";
test("Claude session keys are distinct from Pi and preserve pin/archive operations", () => {
  assert.equal(SESSION_ID_PATTERN.test(native), true);
  assert.equal(SESSION_ID_PATTERN.test("claude:" + native), true);
  assert.notEqual(native, "claude:" + native);
  for (const flag of ["pinned", "archived"]) {
    const request = { action: "set", ids: [native, "claude:" + native], [flag]: true };
    assert.deepEqual(parseSessionUiStateRequest(request), { ok: true, request });
  }
});
test("namespacing cannot authorize paths or malformed native ids", () => {
  for (const value of ["claude:../secret", "claude:/tmp/session", "claude:", "claude:not-a-uuid", "claude:" + native + "/../x", "claude:" + native + ":other", "claude:%2e%2e"]) {
    assert.equal(SESSION_ID_PATTERN.test(value), false, value);
  }
});
