import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { missingCwdFromBody } = await jiti.import("../lib/missing-cwd.ts");
const { parseCodexModels, isClaudeEffort, codexSelectionForModel, validatePiSessionChoices } = await jiti.import("../lib/agent-session-choices.ts");

const source = ts.createSourceFile(
  "useAgentSession.ts",
  await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
const loader = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "loadModels");
const pickerLoader = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "loadModelsForPicker");
const schedule = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_RETRY_DELAYS_MS");
const effect = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[loadModels, modelsRefreshKey]");
const retry = effect.arguments[0].body.statements.find(ts.isExpressionStatement).expression;
function script(text) {
  return new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
const loadScript = script(`(${loader.initializer.arguments[0].getText(source)})`);
const pickerLoadScript = script(`(${pickerLoader.initializer.arguments[0].getText(source)})`);
const retryScript = script(retry.getText(source));
const thinkingParser = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.getText(source) === "asConcreteThinkingLevel");
const parseConcreteThinkingLevel = script(`(${thinkingParser.getText(source)})`).runInNewContext({
  CONCRETE_THINKING_LEVELS: new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
const historyThinkingSync = nodes.find((node) => ts.isIfStatement(node)
  && node.expression.getText(source) === "!includeState"
  && node.thenStatement.getText(source).includes("loadedThinkingLevel"));
const historyThinkingSyncScript = script(historyThinkingSync.getText(source));

function setup(fetchImpl) {
  const writes = [];
  const delays = [];
  const context = {
    Error, DOMException,
    modelsGenerationRef: { current: 0 },
    codexDraftRef: { current: null },
    parseCodexModels, isClaudeEffort, codexSelectionForModel,
    controller: new AbortController(),
    newSessionCwd: "/project", session: null, isNew: true, backend: "pi", backendRef: { current: "pi" },
    sessionIdRef: { current: null }, thinkingLevelOverrideRef: { current: null }, newSessionModelOverrideRef: { current: null },
    thinkingLevelPinsRef: { current: {} }, defaultThinkingLevelRef: { current: null }, allModelsLoadRef: { current: null },
    claudeProjectTrustConfirmedRef: { current: false },
    backends: { claude: { claude: { model: "sonnet" } } },
    CLAUDE_EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"],
    CLAUDE_FALLBACK_MODELS: [{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }, { id: "haiku", name: "Haiku" }],
    sendAgentCommand() { throw new Error("untrusted Claude model discovery must stay dormant"); },
    asConcreteThinkingLevel: parseConcreteThinkingLevel,
    fetch: fetchImpl,
    missingCwdFromBody, validatePiSessionChoices,
    MODELS_RETRY_DELAYS_MS: script(schedule.initializer.getText(source)).runInNewContext(),
    delay: async (ms) => { delays.push(ms); },
  };
  for (const name of ["ModelError", "ModelsMissingCwd", "ModelNames", "ModelScopeWarnings", "IsModelScopeActive", "AllModelList", "ModelThinkingLevels", "ModelThinkingLevelMaps", "ModelList", "NewSessionDefaultModel", "NewSessionDefaultThinkingLevel", "SavedDefaultThinkingLevel", "NewSessionModel", "NewSessionThinkingLevel", "EffectiveNativeModel", "CodexModelChoices", "CodexDraft"]) {
    context[`set${name}`] = (value) => writes.push([name, value]);
  }
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes, delays, run: () => retryScript.runInNewContext(context) };
}

test("history placeholders do not erase a live Claude effort selection", () => {
  assert.equal(parseConcreteThinkingLevel("native"), null);
  assert.equal(parseConcreteThinkingLevel("auto"), null);
  assert.equal(parseConcreteThinkingLevel("low"), "low");

  const writes = [];
  const context = {
    includeState: false,
    d: { context: { thinkingLevel: "native" } },
    asConcreteThinkingLevel: parseConcreteThinkingLevel,
    setLiveThinkingLevel: (value) => writes.push(value),
  };

  historyThinkingSyncScript.runInNewContext(context);
  assert.deepEqual(writes, []);
  context.d.context.thinkingLevel = "low";
  historyThinkingSyncScript.runInNewContext(context);
  assert.deepEqual(writes, ["low"]);
});

test("model-load failures stay visible through bounded retries and clear on recovery", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("Failed to fetch"); }, "Failed to fetch"],
    [async () => Response.json({ error: "Access denied" }, { status: 403 }), "Access denied"],
    [async () => new Response("Unavailable", { status: 503 }), "Failed to load models (HTTP 503)"],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }), "Invalid JSON"],
  ]) {
    const state = setup(fetchImpl);
    await state.run();
    assert.deepEqual(state.delays, [2_000, 5_000, 10_000]);
    assert.deepEqual(state.writes.filter(([name]) => name === "ModelError"), Array.from({ length: 4 }, () => ["ModelError", expected]));
    assert.deepEqual(state.writes.filter(([name]) => name === "ModelsMissingCwd"), Array.from({ length: 4 }, () => ["ModelsMissingCwd", null]));
  }

  let attempts = 0;
  const recovered = setup(async () => {
    if (++attempts === 1) throw new TypeError("Failed to fetch");
    return Response.json({
      models: { "custom:test": "Test" },
      modelList: [{ provider: "custom", id: "test", name: "Test" }],
      defaultModel: { provider: "custom", modelId: "test" },
      thinkingLevelPins: { "custom/test": "high" },
    });
  });
  await recovered.run();
  assert.equal(attempts, 2);
  assert.deepEqual(recovered.delays, [2_000]);
  assert.deepEqual(recovered.writes.filter(([name]) => name === "ModelError"), [["ModelError", "Failed to fetch"], ["ModelError", null]]);
  assert.ok(recovered.writes.some(([name, value]) => name === "ModelList" && value[0].id === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value.modelId === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));
});

test("a folder that no longer exists is reported as such, not as a model error (#1422)", async () => {
  let attempts = 0;
  const state = setup(async () => {
    if (++attempts <= 2) {
      return Response.json({ error: "Directory does not exist: /old/app", reason: "cwd-missing", cwd: "/old/app" }, { status: 400 });
    }
    return Response.json({ models: {}, modelList: [] });
  });
  await state.run();
  assert.equal(attempts, 3);
  assert.deepEqual(state.writes.filter(([name]) => name === "ModelsMissingCwd" || name === "ModelError"), [
    ["ModelsMissingCwd", "/old/app"], ["ModelError", null],
    ["ModelsMissingCwd", "/old/app"], ["ModelError", null],
    ["ModelsMissingCwd", null], ["ModelError", null],
  ]);
  // A load answered from a removed worktree's main repo succeeds while the folder
  // is still gone: it never clears what a refused prompt reported.
  assert.equal(loader.getText(source).includes("setPromptMissingCwd"), false);
});

test("cancelling model loads prevents state writes and further retries", async () => {
  for (const status of [200, 403]) {
    const reading = Promise.withResolvers();
    const state = setup(async (_url, { signal }) => ({
      ok: status === 200, status,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        reading.resolve();
      }),
    }));
    const completed = state.run();
    await reading.promise;
    state.context.controller.abort();
    await completed;
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.delays, []);
  }

  const late = setup(async (_url, { signal }) => ({
    ok: true,
    json: async () => {
      late.context.controller.abort();
      assert.equal(signal.aborted, true);
      return { models: {}, modelList: [] };
    },
  }));
  await late.run();
  assert.deepEqual(late.writes, []);

  let attempts = 0;
  const waiting = setup(async () => { attempts++; throw new TypeError("Failed to fetch"); });
  waiting.context.delay = async () => waiting.context.controller.abort();
  await waiting.run();
  assert.equal(attempts, 1);
});

test("a picked model the folder offers keeps its pinned reasoning level; one it does not list goes back to automatic", async () => {
  const catalog = {
    models: { "custom:test": "Test", "custom:fast": "Fast" },
    modelList: [{ provider: "custom", id: "test", name: "Test" }, { provider: "custom", id: "fast", name: "Fast" }],
    defaultModel: { provider: "custom", modelId: "test" },
    thinkingLevelPins: { "custom/test": "high", "custom/fast": "low" },
  };
  // Carried over from the composer this one replaced, and offered here.
  const offered = setup(async () => Response.json(catalog));
  const fast = { provider: "custom", modelId: "fast" };
  offered.context.newSessionModelOverrideRef.current = fast;
  await offered.run();
  assert.equal(offered.context.newSessionModelOverrideRef.current, fast);
  assert.ok(!offered.writes.some(([name]) => name === "NewSessionModel"));
  assert.ok(offered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "low"));

  // A model another project scoped in that this one does not list.
  const missing = setup(async () => Response.json(catalog));
  missing.context.newSessionModelOverrideRef.current = { provider: "other", modelId: "gone" };
  await missing.run();
  assert.equal(missing.context.newSessionModelOverrideRef.current, null);
  assert.ok(missing.writes.some(([name, value]) => name === "NewSessionModel" && value === null));
  assert.ok(missing.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));

  // A failed load answers 200 with no models (withSafeModelLoadFailure): nothing to compare with, the pick stays.
  const failed = setup(async () => Response.json({ models: {}, modelList: [], defaultModel: null, modelError: "Models could not be loaded" }));
  failed.context.newSessionModelOverrideRef.current = fast;
  await failed.run();
  assert.equal(failed.context.newSessionModelOverrideRef.current, fast);
  assert.ok(!failed.writes.some(([name]) => name === "NewSessionModel"));

  // Once the session exists it keeps whatever it was started with.
  const started = setup(async () => Response.json(catalog));
  started.context.sessionIdRef.current = "live";
  started.context.newSessionModelOverrideRef.current = { provider: "other", modelId: "gone" };
  await started.run();
  assert.deepEqual(started.context.newSessionModelOverrideRef.current, { provider: "other", modelId: "gone" });
});

test("trusted Claude discovery keeps every native model once and honors effort capability", async () => {
  const state = setup(async () => { throw new Error("Claude must not read the Pi model route"); });
  state.context.backend = "claude";
  state.context.backendRef.current = "claude";
  state.context.sessionIdRef.current = "claude:session";
  state.context.claudeProjectTrustConfirmedRef.current = true;
  state.context.sendAgentCommand = async () => ({
    effectiveModel: "custom-current",
    models: [
      { value: "fast", displayName: "Fast", supportsEffort: false, supportedEffortLevels: [] },
      { value: "deep", displayName: "Deep", supportsEffort: true, supportedEffortLevels: ["high", "max"] },
      { value: "deep", displayName: "Duplicate", supportsEffort: true, supportedEffortLevels: ["low"] },
    ],
  });

  await state.context.loadModels();
  const list = state.writes.findLast(([name]) => name === "ModelList")[1];
  const levels = state.writes.findLast(([name]) => name === "ModelThinkingLevels")[1];
  assert.deepEqual(Array.from(list, (model) => model.id), ["custom-current", "fast", "deep"]);
  assert.deepEqual(Array.from(levels["claude:fast"]), []);
  assert.deepEqual(Array.from(levels["claude:deep"]), ["high", "max"]);
  assert.ok(state.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value.modelId === "custom-current"));
});

test("a server-trusted Claude session can load the live catalogue after a page reload", async () => {
  const state = setup(async () => { throw new Error("Claude must not read the Pi model route"); });
  state.context.backend = "claude";
  state.context.backendRef.current = "claude";
  state.context.sessionIdRef.current = "claude:session";
  state.context.claudeProjectTrustConfirmedRef.current = false;
  state.context.runtimeRequiresProjectTrust = false;
  state.context.sendAgentCommand = async () => ({
    effectiveModel: "gateway/current",
    models: [{ value: "gateway/current", displayName: "Gateway Current", supportsEffort: true, supportedEffortLevels: ["high"] }],
  });

  await state.context.loadModels();
  assert.deepEqual(
    Array.from(state.writes.findLast(([name]) => name === "ModelList")[1], (model) => model.id),
    ["gateway/current"],
  );
});

test("fresh Claude model discovery creates its native session before loading the catalogue", async () => {
  const calls = [];
  const context = {
    backendRef: { current: "claude" },
    sessionIdRef: { current: null },
    claudeProjectTrustConfirmedRef: { current: true },
    isNew: true,
    runtimeRequiresProjectTrust: null,
    backends: { claude: { claude: { requiresProjectTrust: false } } },
    requiresClaudeProjectTrust: () => false,
    setPendingClaudeTrustSubmission() {},
    ensureNewSession: async () => {
      calls.push("ensure:start");
      await Promise.resolve();
      context.sessionIdRef.current = "claude:session";
      calls.push("ensure:ready");
      return context.sessionIdRef.current;
    },
    loadModels: async () => {
      calls.push(`models:${context.sessionIdRef.current}`);
    },
  };

  const loadModelsForPicker = pickerLoadScript.runInNewContext(context);
  await loadModelsForPicker();
  assert.deepEqual(calls, [
    "ensure:start",
    "ensure:ready",
    "models:claude:session",
  ]);
});

test("returning from Claude to Pi reloads the cwd catalogue and rejects stale carried choices", async () => {
  let requests = 0;
  const state = setup(async () => {
    requests += 1;
    return Response.json({
      models: { "new:valid": "Valid" },
      modelList: [{ provider: "new", id: "valid", name: "Valid" }],
      defaultModel: { provider: "new", modelId: "valid" },
      thinkingLevels: { "new:valid": ["low"] },
    });
  });
  state.context.newSessionModelOverrideRef.current = { provider: "old", modelId: "stale" };
  state.context.thinkingLevelOverrideRef.current = "high";

  state.context.backend = "claude";
  state.context.backendRef.current = "claude";
  await state.context.loadModels();
  assert.equal(requests, 0, "Claude never reads the Pi model catalogue");

  state.context.backend = "pi";
  state.context.backendRef.current = "pi";
  await state.context.loadModels();
  assert.equal(requests, 1);
  assert.equal(state.context.newSessionModelOverrideRef.current, null);
  assert.equal(state.context.thinkingLevelOverrideRef.current, null);
  assert.ok(state.writes.some(([name, value]) => name === "NewSessionModel" && value === null));
  assert.ok(state.writes.some(([name, value]) => name === "NewSessionThinkingLevel" && value === null));
});

test('Codex discovery uses native model identifier and never Pi fallback', async () => {
  const urls = [];
  const rows = [{ id: 'catalogue-id', model: 'native-model', label: 'Native', isDefault: true, defaultEffort: 'low', efforts: [{ value: 'low', description: 'Low' }, { value: 'ultra', description: 'Ultra' }] }];
  const { context, writes } = setup(async url => { urls.push(url); return { ok: true, json: async () => ({ backend: 'codex', models: rows }) }; });
  context.backend = 'codex'; context.backendRef.current = 'codex';
  context.codexDraftRef.current = { model: 'native-model', effort: 'ultra' };
  await context.loadModels();
  assert.deepEqual(urls, ['/api/models?backend=codex&cwd=%2Fproject']);
  const list = writes.find(([key]) => key === 'ModelList')[1];
  assert.equal(list[0].id, 'native-model'); assert.equal(list[0].provider, 'codex');
  assert.equal(context.codexDraftRef.current.effort, 'ultra');
  assert.equal(writes.some(([key, val]) => key === 'NewSessionDefaultModel' && val !== null), false);
});

test('Codex catalogue failure remains native and stale responses cannot write a new scope', async () => {
  let settle;
  const { context, writes } = setup(() => new Promise(resolve => { settle = resolve; }));
  context.backend = 'codex'; context.backendRef.current = 'codex';
  const loading = context.loadModels();
  context.backendRef.current = 'pi';
  settle({ ok: false, json: async () => ({ error: 'native unavailable' }) });
  await loading;
  assert.equal(writes.some(([key]) => key === 'ModelError'), false);
  context.backendRef.current = 'codex';
  const failed = context.loadModels();
  settle({ ok: false, json: async () => ({ error: 'native unavailable' }) });
  await assert.rejects(failed, /native unavailable/);
  assert.equal(writes.some(([key, value]) => key === 'ModelError' && value === 'native unavailable'), true);
});
