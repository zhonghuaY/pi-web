import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "./claude-test-home.mjs";

await isolateClaudeHome();
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-handoff-codex-")));
const agentDir = join(root, "agent");
const codexHome = join(root, "codex-home");
const binary = join(root, "codex");
const statePath = join(root, "state.json");
const modePath = join(root, "mode");
const logPath = join(root, "requests.log");
await mkdir(agentDir); await mkdir(codexHome); await mkdir(join(root, "home"));
await writeFile(statePath, JSON.stringify({ threads: [], next: 1 }));
await writeFile(modePath, "exact");
await writeFile(binary, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.4"); process.exit(0); }
const statePath = process.env.TEST_STATE;
const logPath = process.env.TEST_LOG;
const modePath = process.env.TEST_MODE;
const load = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = state => fs.writeFileSync(statePath, JSON.stringify(state));
const send = value => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on("line", line => {
  const q = JSON.parse(line);
  if (!q.method) return;
  fs.appendFileSync(logPath, q.method + "\\n");
  if (!("id" in q)) return;
  if (q.method === "initialize") return send({ id: q.id, result: { userAgent: "test", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "test" } });
  if (q.method === "thread/list") return send({ id: q.id, result: { data: load().threads, nextCursor: null } });
  if (q.method === "thread/start") {
    const state = load();
    const suffix = String(state.next++).padStart(12, "0");
    const id = "019c1bed-f24e-7f5f-a7f2-" + suffix;
    const thread = { id, sessionId: id, preview: "", ephemeral: false, projectId: null, modelProvider: "local", model: "mock", createdAt: 1, updatedAt: 1, cwd: q.params.cwd, cliVersion: "0.153.4", source: "cli", status: { type: "idle" }, turns: [] };
    state.threads.push(thread); save(state);
    return send({ id: q.id, result: { thread, approvalPolicy: "never", approvalsReviewer: "user", cwd: thread.cwd, model: "mock", modelProvider: "local", reasoningEffort: null, sandbox: { type: "readOnly" } } });
  }
  if (q.method === "turn/start") {
    const state = load();
    const thread = state.threads.find(row => row.id === q.params.threadId);
    const full = q.params.input[0].text;
    const mode = fs.readFileSync(modePath, "utf8").trim();
    const text = mode === "partial" ? full.slice(0, -1) : full;
    const turn = { id: "turn-" + thread.id.slice(-4), status: "inProgress", items: [{ id: "user-" + thread.id.slice(-4), type: "userMessage", content: mode === "extra" ? [...q.params.input, { type: "image", url: "file:///hidden" }] : [{ ...q.params.input[0], text }] }] };
    thread.turns.push(turn); thread.preview = text; thread.updatedAt++; thread.lastPrompt = full; save(state);
    return send({ id: q.id, result: { turn } });
  }
  if (q.method === "thread/read") {
    const thread = load().threads.find(row => row.id === q.params.threadId);
    if (!thread) return send({ id: q.id, error: { code: -32600, message: "missing" } });
    const { lastPrompt, ...wire } = thread;
    return send({ id: q.id, result: { thread: wire } });
  }
});
`);
await chmod(binary, 0o700);

const previous = Object.fromEntries(["HOME", "PATH", "PI_CODING_AGENT_DIR", "CODEX_HOME", "PI_WEB_CODEX", "PI_WEB_CODEX_BINARY", "TEST_STATE", "TEST_LOG", "TEST_MODE"].map(key => [key, process.env[key]]));
process.env.HOME = join(root, "home");
process.env.PATH = `${root}:${previous.PATH ?? "/usr/bin:/bin"}`;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODEX_HOME = codexHome;
process.env.PI_WEB_CODEX = "1";
process.env.PI_WEB_CODEX_BINARY = binary;
process.env.TEST_STATE = statePath;
process.env.TEST_LOG = logPath;
process.env.TEST_MODE = modePath;
for (const key of ["JITI_ALIAS", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"]) delete process.env[key];

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { createSessionHandoff, SessionHandoffError } = await jiti.import("./session-handoff-server.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { getRpcSession } = await jiti.import("./rpc-manager.ts");
const { getCodexSession, shutdownCodexSession, createCodexSession, promptCodexSession } = await jiti.import("./agent-backends/codex.ts");
const { projectCodexCatalogue } = await jiti.import("./agent-backends/codex/projection.ts");
const { listCodexThreads } = await jiti.import("./agent-backends/codex/catalogue.ts");

test.after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function piSource(text) {
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: text, timestamp: 1 });
  const path = manager.getSessionFile();
  cacheSessionPath(manager.getSessionId(), path);
  return { id: manager.getSessionId(), path, bytes: await readFile(path) };
}

async function closeTarget(id) {
  const live = getCodexSession(id);
  if (live) await shutdownCodexSession(live);
}

function calls(method) {
  return readFile(logPath, "utf8").then(text => text.trim().split("\n").filter(row => row === method).length).catch(() => 0);
}

test("Pi to Codex uses native create, exact prompt proof, one receipt, and immutable source", async t => {
  await writeFile(modePath, "exact");
  const source = await piSource("Pi source for native Codex");
  const request = { requestId: randomUUID(), targetBackend: "codex", trustProject: false };
  assert.deepEqual(await listCodexThreads(), []);
  const startsBefore = await calls("thread/start");
  const promptsBefore = await calls("turn/start");
  const result = await createSessionHandoff(source.id, request);
  t.after(() => closeTarget(result.session.id));
  assert.equal(result.session.backend, "codex");
  assert.equal(result.session.relation.sourceSessionId, source.id);
  assert.deepEqual(await readFile(source.path), source.bytes);
  const retry = await createSessionHandoff(source.id, request);
  assert.deepEqual(retry, result);
  assert.equal(await calls("thread/start") - startsBefore, 1);
  assert.equal(await calls("turn/start") - promptsBefore, 1);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const target = state.threads.find(row => `codex:${row.id}` === result.session.id);
  assert.equal(target.turns[0].items[0].content.length, 1);
  assert.match(target.turns[0].items[0].content[0].text, /Pi source for native Codex/);
  const projected = projectCodexCatalogue(state.threads).find(row => row.id === result.session.id);
  assert.equal(projected.firstMessage, result.session.firstMessage);
  assert.deepEqual(projected.relation, result.session.relation);
});

test("a handoff UUID reused from ordinary native creation cannot adopt or prompt that thread", async t => {
  await writeFile(modePath, "exact");
  const requestId = randomUUID();
  const created = await createCodexSession({ cwd: root, requestId });
  assert.equal(created.ok, true);
  const ordinary = created.value;
  t.after(() => closeTarget(ordinary.sessionId));
  assert.equal((await promptCodexSession(ordinary, { requestId: randomUUID(), message: "Ordinary native conversation" })).ok, true);
  const before = JSON.parse(await readFile(statePath, "utf8")).threads.find(row => `codex:${row.id}` === ordinary.sessionId);
  const source = await piSource("Distinct handoff owner");
  const result = await createSessionHandoff(source.id, { requestId, targetBackend: "codex", trustProject: false });
  t.after(() => closeTarget(result.session.id));
  assert.notEqual(result.session.id, ordinary.sessionId);
  const after = JSON.parse(await readFile(statePath, "utf8")).threads.find(row => `codex:${row.id}` === ordinary.sessionId);
  assert.deepEqual(after, before);
  const retry = await createSessionHandoff(source.id, { requestId, targetBackend: "codex", trustProject: false });
  assert.equal(retry.session.id, result.session.id);
});

test("a computed handoff create UUID cannot adopt or prompt an ordinary native thread", async t => {
  await writeFile(modePath, "exact");
  const source = await piSource("Computed UUID ownership collision");
  const requestId = randomUUID();
  const bytes = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(JSON.stringify(["pi-web/codex/handoff", "create", source.id, requestId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const derivedId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const ordinary = await createCodexSession({ cwd: root, requestId: derivedId });
  assert.equal(ordinary.ok, true);
  t.after(() => closeTarget(ordinary.value.sessionId));
  const before = JSON.parse(await readFile(statePath, "utf8")).threads.find(row => `codex:${row.id}` === ordinary.value.sessionId);
  const result = await createSessionHandoff(source.id, { requestId, targetBackend: "codex", trustProject: false });
  t.after(() => closeTarget(result.session.id));
  assert.notEqual(result.session.id, ordinary.value.sessionId);
  const after = JSON.parse(await readFile(statePath, "utf8")).threads.find(row => `codex:${row.id}` === ordinary.value.sessionId);
  assert.deepEqual(after, before);
  assert.deepEqual(await readFile(source.path), source.bytes);
});

test("native admission reconciles the original envelope after source changes without replay", async t => {
  for (const mode of ["exact", "partial", "extra"]) {
    await writeFile(modePath, mode);
    const source = await piSource(`Original envelope ${mode}`);
    const request = { requestId: randomUUID(), targetBackend: "codex", trustProject: false };
    const starts = await calls("thread/start"), prompts = await calls("turn/start");
    await assert.rejects(createSessionHandoff(source.id, request, {
      seam: point => { if (point === "after-prompt") throw new Error("lost after native admission"); },
    }), error => error.reason === "outcome-unknown" && error.operationId === request.requestId);
    const record = JSON.parse(await readFile(join(agentDir, "pi-web-handoffs", request.requestId, "record.json"), "utf8"));
    t.after(() => closeTarget(record.target.id));
    await appendFile(source.path, "\n");
    const recovered = await createSessionHandoff(source.id, request, {
      readSource: async () => { throw new Error("Recovery must use the saved envelope proof, not the mutable source"); },
    }).catch(error => error);
    if (mode === "exact") {
      assert.equal(recovered.session?.id, record.target.id);
      assert.deepEqual(recovered.transfer, record.transfer);
    } else {
      assert.equal(recovered.reason, "outcome-unknown");
      assert.equal(recovered.operationId, request.requestId);
    }
    assert.equal(await calls("thread/start") - starts, 1);
    assert.equal(await calls("turn/start") - prompts, 1);
  }
  await writeFile(modePath, "exact");
});

test("native child and history-only active sources are refused before any target mutation", async () => {
  for (const [overrides, reason] of [
    [{ parentThreadId: "019c1bed-f24e-7f5f-a7f2-999999999999" }, "not-main-session"],
    [{ source: { subAgent: "review" } }, "not-main-session"],
    [{ status: { type: "active", activeFlags: [] } }, "source-busy"],
    [{ status: { type: "active", activeFlags: ["waitingOnApproval"] } }, "source-busy"],
    [{ status: { type: "active", activeFlags: ["waitingOnUserInput"] } }, "source-busy"],
    [{ inProgress: true }, "source-busy"],
  ]) {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const id = `019c1bed-f24e-7f5f-a7f2-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const { inProgress, ...fields } = overrides;
    state.threads.push({ id, sessionId: id, preview: "Native source", ephemeral: false, projectId: null, modelProvider: "local", model: "mock", createdAt: 1, updatedAt: 2, cwd: root, cliVersion: "0.153.4", source: "cli", status: { type: "notLoaded" }, turns: [
      { id: "source-turn", status: inProgress ? "inProgress" : "completed", items: [{ id: "native-user", type: "userMessage", content: [{ type: "text", text: "Visible native text" }] }] },
    ], ...fields });
    await writeFile(statePath, JSON.stringify(state));
    let creates = 0;
    await assert.rejects(createSessionHandoff(`codex:${id}`, { requestId: randomUUID(), targetBackend: "pi", trustProject: false }, {
      findExistingTarget: async () => null,
      createTarget: async () => { creates++; throw new Error("must not create a target"); },
    }), error => error.reason === reason);
    assert.equal(creates, 0);
  }
});

test("Codex to Pi captures authoritative native text without changing source history", async t => {
  await writeFile(modePath, "exact");
  const nativeId = "019c1bed-f24e-7f5f-a7f2-999999999999";
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.threads.push({
    id: nativeId, sessionId: nativeId, preview: "native source", ephemeral: false, projectId: null,
    modelProvider: "local", model: "mock", createdAt: 1, updatedAt: 2, cwd: root,
    cliVersion: "0.153.4", source: "cli", status: { type: "idle" }, turns: [{ id: "source-turn", status: "completed", items: [
      { id: "source-user", type: "userMessage", content: [{ type: "text", text: "Native source text" }, { type: "localImage", path: "/hidden/image.png" }] },
      { id: "source-answer", type: "agentMessage", text: "Native source answer" },
    ] }],
  });
  await writeFile(statePath, JSON.stringify(state));
  const sourceBefore = await readFile(statePath);
  const provider = createServer((_request, response) => { response.writeHead(503); response.end(); });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const port = provider.address().port;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "test", api: "openai-completions", models: [{ id: "local-model", name: "Local", reasoning: false, contextWindow: 10000, maxTokens: 100 }] } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "local-model" }));
  const request = { requestId: randomUUID(), targetBackend: "pi", trustProject: false };
  const result = await createSessionHandoff(`codex:${nativeId}`, request);
  t.after(async () => { await getRpcSession(result.session.id)?.shutdown(); });
  assert.equal(result.session.backend, "pi");
  assert.equal(result.transfer.sourceEntryId, "source-answer");
  assert.equal(result.transfer.transferredMessages, 2);
  assert.deepEqual(await readFile(statePath), sourceBefore);
  const targetText = await readFile(result.session.path, "utf8");
  assert.match(targetText, /Native source text/);
  assert.match(targetText, /Native source answer/);
  assert.doesNotMatch(targetText, /hidden\/image/);
});

test("late exact native evidence completes the same operation without resending", async t => {
  await writeFile(modePath, "partial");
  const source = await piSource("Late native proof");
  const request = { requestId: randomUUID(), targetBackend: "codex", trustProject: false };
  const promptsBefore = await calls("turn/start");
  await assert.rejects(
    createSessionHandoff(source.id, request),
    error => error instanceof SessionHandoffError && error.reason === "outcome-unknown" && error.operationId === request.requestId,
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const target = state.threads.at(-1);
  t.after(() => closeTarget(`codex:${target.id}`));
  target.turns[0].items[0].content = [{ type: "text", text: target.lastPrompt, text_elements: [] }];
  await writeFile(statePath, JSON.stringify(state));
  const recovered = await createSessionHandoff(source.id, request);
  assert.equal(recovered.session.id, `codex:${target.id}`);
  assert.equal(await calls("turn/start") - promptsBefore, 1);
  assert.deepEqual(await readFile(source.path), source.bytes);
});
