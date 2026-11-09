import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { StableRequestId } = await jiti.import("../lib/agent-backends.ts");
const sourceText = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useAgentSession.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "ensureNewSession") callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
const javascript = ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.trim().replace(/;$/, "");
const compile = new Function("scope", `with (scope) { return ${javascript}; }`);

test("ambiguous dormant creation retries retain the composer's creation requestId", async () => {
  const bodies = []; let calls = 0; let idCreates = 0;
  const scope = {
    sessionIdRef: { current: null }, isNew: true, newSessionCwd: "/project", ensuringNewSessionRef: { current: null },
    backendRef: { current: "claude" }, newSessionModelOverrideRef: { current: null }, thinkingLevelOverrideRef: { current: null },
    codexDraftRef: { current: null },
    claudeProjectTrustConfirmedRef: { current: false },
    setPendingModel() {}, getToolNamesForPreset() { throw new Error("Claude must not resolve Pi tools"); },
    toolPreset: "configured", sessionToolsPinnedRef: { current: false },
    creationRequestIdRef: { current: new StableRequestId(() => `creation-${++idCreates}`) },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (++calls === 1) throw new TypeError("response lost");
      return Response.json({ success: true, sessionId: "claude:native-uuid", backend: "claude" });
    },
    missingCwdFromBody: () => null, AgentCommandError: Error,
    setNewSessionDefaultModel() {}, setLiveThinkingLevel() {}, setNewSessionDefaultThinkingLevel() {},
    asConcreteThinkingLevel: (value) => value,
  };
  scope.ensureNewSession = compile(scope);
  await assert.rejects(() => scope.ensureNewSession(), /response lost/);
  assert.equal(scope.ensuringNewSessionRef.current, null);
  assert.equal(await scope.ensureNewSession(), "claude:native-uuid");
  assert.deepEqual(bodies.map((body) => body.requestId), ["creation-1", "creation-1"]);
  assert.deepEqual(bodies.map((body) => Object.keys(body).sort()), [
    ["backend", "cwd", "requestId", "type"], ["backend", "cwd", "requestId", "type"],
  ]);
  assert.equal(idCreates, 1);
});
