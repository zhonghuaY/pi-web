import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import ts from "typescript";
import { isolateClaudeHome } from "../lib/claude-test-home.mjs";

await isolateClaudeHome();

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { handoffSessionFromResponse, createRequestId, requestSessionHandoff, pendingHandoffRequestId, clearPendingHandoffRequestId, useAgentSession } = await jiti.import("./useAgentSession.ts");
const { getDraft, setDraft } = await jiti.import("@/lib/draft-store");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("../lib/i18n/messages/zh-TW.ts");

test("request IDs remain UUID v4 on HTTP without crypto.randomUUID", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
    else delete globalThis.crypto.randomUUID;
  });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  const ids = Array.from({ length: 100 }, () => createRequestId());
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
});

test("HTTP handoff reaches project trust and retains its request ID on retry", async () => {
  const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let handler;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleSessionHandoff") handler = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler);
  const pending = [];
  const context = {
    crypto: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) },
    session: { id: "source" }, sessionIdRef: { current: "source" },
    backendRef: { current: "pi" }, handoffSwitching: false,
    backends: { claude: { available: true } }, handoffRequestRef: { current: null },
    claudeProjectTrustConfirmedRef: { current: false },
    pendingHandoffRequestId,
    setPendingClaudeTrustSubmission: (value) => pending.push(value),
  };
  context.createRequestId = new Script(`(${createRequestId.toString()})`).runInNewContext(context);
  const callback = new Script(ts.transpileModule(`(${handler.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText).runInNewContext(context);
  callback("claude");
  callback("claude");
  assert.equal(pending.length, 2);
  assert.equal(pending[0].kind, "handoff");
  assert.match(pending[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(pending[1].requestId, pending[0].requestId);
});

const target = {
  id: "target-id",
  cwd: "/project",
  path: "/session.jsonl",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:01:00.000Z",
  firstMessage: "Continue in Pi · Source",
  messageCount: 1,
  backend: "pi",
  relation: {
    kind: "handoff",
    sourceSessionId: "claude:123e4567-e89b-42d3-a456-426614174000",
    sourceBackend: "claude",
    sourceEntryId: "tip-id",
    requestId: "123e4567-e89b-42d3-a456-426614174001",
  },
};

test("keeps the server handoff provenance before the target is reloaded", () => {
  const identity = { sourceSessionId: target.relation.sourceSessionId, targetBackend: "pi", requestId: target.relation.requestId };
  assert.deepEqual(handoffSessionFromResponse({ success: true, data: { session: target } }, identity)?.relation, target.relation);
});

test("keeps Codex target and source provenance before native history reload", () => {
  const codex = {
    ...target,
    id: "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a",
    path: "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a",
    backend: "codex",
    relation: { ...target.relation, sourceSessionId: "source-session", sourceBackend: "pi" },
  };
  const identity = { sourceSessionId: codex.relation.sourceSessionId, targetBackend: "codex", requestId: codex.relation.requestId };
  const parsed = handoffSessionFromResponse({ success: true, data: { session: codex } }, identity);
  assert.equal(parsed?.backend, "codex");
  assert.deepEqual(parsed?.relation, codex.relation);
});

test("accepts matching receipts for every cross-backend edge", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const ids = {
    pi: "pi-session",
    claude: "claude:123e4567-e89b-42d3-a456-426614174000",
    codex: "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a",
  };
  const requestId = "123e4567-e89b-42d3-a456-426614174001";
  for (const sourceBackend of Object.keys(ids)) {
    for (const targetBackend of Object.keys(ids)) {
      if (sourceBackend === targetBackend) continue;
      const relation = { kind: "handoff", sourceSessionId: ids[sourceBackend], sourceBackend, requestId };
      globalThis.fetch = async (url, init) => {
        assert.equal(url, `/api/sessions/${encodeURIComponent(ids[sourceBackend])}/handoff`);
        assert.equal(JSON.parse(init.body).requestId, requestId);
        return Response.json({ success: true, data: { session: { ...target, id: ids[targetBackend], backend: targetBackend, relation } } });
      };
      const result = await requestSessionHandoff(ids[sourceBackend], targetBackend, requestId, false);
      assert.equal(result.id, ids[targetBackend]);
      assert.equal(result.backend, targetBackend);
      assert.deepEqual(result.relation, relation);
    }
  }
});

test("handoff response loss and invalid success remain unconfirmed with the stable operation id", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requestId = "123e4567-e89b-42d3-a456-426614174009";
  for (const response of [
    () => Promise.reject(new TypeError("response lost")),
    () => Promise.resolve(new Response("upstream unavailable", { status: 502 })),
    () => Promise.resolve(Response.json({ success: true, data: {} })),
    () => Promise.resolve(Response.json({ error: "proxy failure" }, { status: 503 })),
  ]) {
    globalThis.fetch = response;
    await assert.rejects(requestSessionHandoff("source", "codex", requestId, false), error =>
      error.reason === "outcome-unknown" && error.operationId === requestId);
  }
  globalThis.fetch = async () => Response.json({ error: "source is busy", reason: "source-busy" }, { status: 409 });
  await assert.rejects(requestSessionHandoff("source", "codex", requestId, false), error => error.reason === "source-busy");
});

test("an unresolved handoff id survives hook remounts until accepted", t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const data = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  });
  let creates = 0;
  const next = () => `123e4567-e89b-42d3-a456-${String(++creates).padStart(12, "0")}`;
  const first = pendingHandoffRequestId("source", "codex", next);
  assert.equal(pendingHandoffRequestId("source", "codex", next), first);
  assert.notEqual(pendingHandoffRequestId("source", "claude", next), first);
  clearPendingHandoffRequestId("source", "codex", "wrong id");
  assert.equal(pendingHandoffRequestId("source", "codex", next), first);
  clearPendingHandoffRequestId("source", "codex", first);
  assert.notEqual(pendingHandoffRequestId("source", "codex", next), first);
});

test("does not trust a malformed handoff relation from the response", () => {
  const identity = { sourceSessionId: target.relation.sourceSessionId, targetBackend: "pi", requestId: target.relation.requestId };
  const parsed = handoffSessionFromResponse({
    success: true,
    data: { session: { ...target, relation: { ...target.relation, sourceBackend: "other" } } },
  }, identity);
  assert.equal(parsed, null);
});

const sourceId = "source-session";
const codexId = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function validReceipt(requestId) {
  return {
    success: true,
    data: { session: {
      ...target,
      id: codexId,
      path: codexId,
      backend: "codex",
      relation: { kind: "handoff", sourceSessionId: sourceId, sourceBackend: "pi", sourceEntryId: "tip", requestId },
    } },
  };
}

async function handoffHook(t, respond) {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const storage = new Map();
  replace("sessionStorage", {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  });
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("EventSource", class {
    readyState = 0;
    close() { this.readyState = 2; }
  });
  const requests = [];
  const handoffs = [];
  replace("fetch", async (url, init = {}) => {
    if (url === `/api/sessions/${sourceId}/handoff`) {
      const request = JSON.parse(init.body);
      requests.push(request);
      return respond(request, requests.length);
    }
    if (url.startsWith("/api/agent/backends")) return Response.json({ backends: { pi: { available: true }, codex: { available: true } } });
    if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
    if (url.startsWith(`/api/sessions/${sourceId}?`)) return Response.json({
      sessionId: sourceId, filePath: "", totalActiveMs: 0, tree: [], leafId: null,
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: null },
    });
    if (url.startsWith(`/api/sessions/${sourceId}/state`) || url.startsWith(`/api/agent/${sourceId}`)) {
      return Response.json({ success: true, data: [], running: false, state: { isStreaming: false } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const props = {
    session: { id: sourceId, backend: "pi", name: "Source", cwd: "/project" },
    newSessionCwd: null,
    newSessionDraftKey: null,
    t: (key, params) => (enLocale.messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params?.[name] ?? ""),
    onSessionHandoff: (source, session) => handoffs.push({ source, session }),
  };
  setDraft(sourceId, { value: "unsent draft", images: [] });
  let hook;
  const mount = async () => {
    hook = renderHook(useAgentSession, props);
    await settle();
    hook.flush();
    assert.equal(hook.result.backends.codex.available, true);
  };
  t.after(() => {
    hook?.unmount();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await mount();
  return {
    requests, handoffs, storage,
    get hook() { return hook; },
    async select() { hook.result.handleSessionHandoff("codex"); await settle(); hook.flush(); },
    async reload() { hook.unmount(); await mount(); },
  };
}

test("only a matching canonical success receipt navigates and clears the pending id", async t => {
  const h = await handoffHook(t, request => Response.json(validReceipt(request.requestId)));
  await h.select();
  assert.equal(h.requests.length, 1);
  assert.equal(h.handoffs.length, 1);
  assert.equal(h.handoffs[0].source, sourceId);
  assert.deepEqual(h.handoffs[0].session.relation, validReceipt(h.requests[0].requestId).data.session.relation);
  assert.equal(h.handoffs[0].session.id, codexId);
  assert.equal(h.handoffs[0].session.backend, "codex");
  assert.equal(h.storage.size, 0);
});

test("invalid success receipts stay unconfirmed and keep the same id across reload", async t => {
  const cases = {
    "missing success": receipt => { delete receipt.success; },
    "false success": receipt => { receipt.success = false; },
    "non-boolean success": receipt => { receipt.success = "true"; },
    "missing session backend": receipt => { delete receipt.data.session.backend; },
    "wrong session backend": receipt => { receipt.data.session.backend = "pi"; },
    "invalid target id": receipt => { receipt.data.session.id = "codex:not-a-uuid"; },
    "target namespace mismatch": receipt => { receipt.data.session.id = "pi-target"; },
    "noncanonical target id": receipt => { receipt.data.session.id = codexId.toUpperCase().replace("CODEX:", "codex:"); },
    "missing relation": receipt => { delete receipt.data.session.relation; },
    "wrong relation kind": receipt => { receipt.data.session.relation.kind = "fork"; },
    "missing source id": receipt => { delete receipt.data.session.relation.sourceSessionId; },
    "wrong source id": receipt => { receipt.data.session.relation.sourceSessionId = "other-source"; },
    "missing source backend": receipt => { delete receipt.data.session.relation.sourceBackend; },
    "wrong source backend": receipt => { receipt.data.session.relation.sourceBackend = "claude"; },
    "missing request id": receipt => { delete receipt.data.session.relation.requestId; },
    "wrong request id": receipt => { receipt.data.session.relation.requestId = "123e4567-e89b-42d3-a456-426614174999"; },
    "invalid source entry": receipt => { receipt.data.session.relation.sourceEntryId = 42; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async t => {
      const h = await handoffHook(t, request => {
        const receipt = validReceipt(request.requestId);
        mutate(receipt);
        return Response.json(receipt);
      });
      await h.select();
      const first = h.requests[0].requestId;
      assert.equal(h.handoffs.length, 0);
      assert.equal(h.storage.size, 1);
      assert.match(h.hook.result.notices[0].message, /unconfirmed/);
      assert.match(h.hook.result.notices[0].message, new RegExp(first));
      assert.equal(h.hook.result.sessionIdRef.current, sourceId);
      assert.equal(getDraft(sourceId)?.value, "unsent draft");
      await h.reload();
      await h.select();
      assert.equal(h.requests[1].requestId, first);
      assert.equal(h.handoffs.length, 0);
    });
  }
});

test("a lost response recovers the same operation from a valid receipt after reload", async t => {
  const h = await handoffHook(t, (request, count) => {
    if (count === 1) throw new TypeError("response lost");
    return Response.json(validReceipt(request.requestId));
  });
  await h.select();
  const first = h.requests[0].requestId;
  assert.equal(h.storage.size, 1);
  assert.equal(h.handoffs.length, 0);
  await h.reload();
  await h.select();
  assert.equal(h.requests[1].requestId, first);
  assert.equal(h.handoffs.length, 1);
  assert.deepEqual(h.handoffs[0].session.relation, validReceipt(first).data.session.relation);
  assert.equal(h.storage.size, 0);
});

test("a matching source conflict clears the operation without retrying or changing the source draft", async t => {
  const h = await handoffHook(t, (request, count) => count === 1
    ? Response.json({ error: "No target was created", reason: "source-conflict", operationId: request.requestId }, { status: 409 })
    : Response.json(validReceipt(request.requestId)));
  await h.select();
  const first = h.requests[0].requestId;
  assert.equal(h.requests.length, 1);
  assert.equal(h.handoffs.length, 0);
  assert.equal(h.storage.size, 0);
  assert.match(h.hook.result.notices[0].message, /source session changed.*No target was created.*Select Codex again to start a new operation/);
  assert.equal(h.hook.result.sessionIdRef.current, sourceId);
  assert.equal(getDraft(sourceId)?.value, "unsent draft");
  await h.select();
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[1].requestId, first);
  assert.equal(h.handoffs.length, 1);
});

test("a definitive conflict received after unmount clears storage for the next explicit selection", async t => {
  const response = Promise.withResolvers();
  const h = await handoffHook(t, (request, count) => count === 1
    ? response.promise
    : Response.json(validReceipt(request.requestId)));
  h.hook.result.handleSessionHandoff("codex");
  await settle();
  h.hook.flush();
  const first = h.requests[0].requestId;
  assert.equal(h.storage.size, 1);
  await h.reload();
  response.resolve(Response.json({ error: "No target was created", reason: "source-conflict", operationId: first }, { status: 409 }));
  await settle();
  h.hook.flush();
  assert.equal(h.storage.size, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.handoffs.length, 0);
  await h.select();
  assert.notEqual(h.requests[1].requestId, first);
  assert.equal(h.handoffs.length, 1);
});

test("source-conflict notice is present in each supported locale", () => {
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    assert.equal(typeof locale.messages["chat.handoffSourceChanged"], "string");
    assert.match(locale.messages["chat.handoffSourceChanged"], /\{backend\}/);
  }
});

test("unconfirmed and other conflicts keep the original operation across reload", async t => {
  const cases = {
    "response lost": () => { throw new TypeError("response lost"); },
    "outcome unknown": request => Response.json({ error: "unconfirmed", reason: "outcome-unknown", operationId: request.requestId }, { status: 503 }),
    "outcome unknown with wrong id": () => Response.json({ error: "unconfirmed", reason: "outcome-unknown", operationId: "wrong" }, { status: 503 }),
    "request conflict": request => Response.json({ error: "conflict", reason: "request-conflict", operationId: request.requestId }, { status: 409 }),
    "source conflict missing id": () => Response.json({ error: "conflict", reason: "source-conflict" }, { status: 409 }),
    "source conflict wrong id": () => Response.json({ error: "conflict", reason: "source-conflict", operationId: "wrong" }, { status: 409 }),
    "source conflict without explanation": request => Response.json({ reason: "source-conflict", operationId: request.requestId }, { status: 409 }),
    "source conflict wrong status": request => Response.json({ error: "conflict", reason: "source-conflict", operationId: request.requestId }, { status: 503 }),
  };
  for (const [name, respond] of Object.entries(cases)) {
    await t.test(name, async t => {
      const h = await handoffHook(t, respond);
      await h.select();
      const first = h.requests[0].requestId;
      assert.equal(h.handoffs.length, 0);
      assert.equal(h.storage.size, 1);
      assert.equal(getDraft(sourceId)?.value, "unsent draft");
      if (name !== "request conflict") {
        assert.match(h.hook.result.notices[0].message, /unconfirmed/);
        assert.match(h.hook.result.notices[0].message, new RegExp(first));
      }
      await h.reload();
      await h.select();
      assert.equal(h.requests[1].requestId, first);
      assert.equal(h.handoffs.length, 0);
    });
  }
});
