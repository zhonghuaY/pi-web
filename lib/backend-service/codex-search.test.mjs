import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const root = await mkdtemp(join(process.env.HOME, "codex-search-"));
for (const key of ["JITI_ALIAS", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"]) delete process.env[key];
Object.assign(process.env, {
  HOME: root, PI_CODING_AGENT_DIR: join(root, "pi"), CODEX_HOME: join(root, "codex-home"),
  CLAUDE_CONFIG_DIR: join(root, "claude"), PI_WEB_CODEX: "1", PI_WEB_CLAUDE: "1",
  TEST_PROJECT: join(root, "project"), TEST_CTL: join(root, "control"), TEST_LOG: join(root, "native.log"),
});
await Promise.all([process.env.PI_CODING_AGENT_DIR, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.TEST_PROJECT, process.env.TEST_CTL].map(path => mkdir(path, { recursive: true })));
const binary = join(root, "codex");
await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(0); }
const id = '019c1bed-f24e-7f5f-a7f2-496c101e4e7a';
const thread = { id, sessionId: id, preview: 'ordinary title', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd: process.env.TEST_PROJECT, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [{ id: 'turn1', status: 'completed', items: [{ id: 'item1', type: 'userMessage', content: [{ type: 'text', text: 'rare-needle-term', text_elements: [] }] }] }] };
const send = value => console.log(JSON.stringify(value));
let listed = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line);
  if (!('id' in q) || !q.method) return;
  if (q.method === 'initialize') return send({ id: q.id, result: { userAgent: 'test', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'test' } });
  if (q.method === 'thread/list') {
    listed = true;
    fs.appendFileSync(process.env.TEST_LOG, 'list\\n');
    const reply = () => send({ id: q.id, result: { data: [{ ...thread, turns: [] }], nextCursor: null } });
    if (fs.existsSync(path.join(process.env.TEST_CTL, 'hold-list'))) {
      const timer = setInterval(() => { if (!fs.existsSync(path.join(process.env.TEST_CTL, 'hold-list'))) { clearInterval(timer); reply(); } }, 10);
      return;
    }
    if (fs.existsSync(path.join(process.env.TEST_CTL, 'slow-list'))) return setTimeout(reply, 250);
    return reply();
  }
  if (q.method === 'thread/read') {
    fs.appendFileSync(process.env.TEST_LOG, 'read\\n');
    if (fs.existsSync(path.join(process.env.TEST_CTL, 'failure'))) return send({ id: q.id, error: { code: -32603, message: 'temporary failure' } });
    const reply = () => {
      let resultThread = fs.existsSync(path.join(process.env.TEST_CTL, 'has-more'))
        ? { ...thread, turns: [{ ...thread.turns[0], items: [...Array.from({ length: 1000 }, (_, i) => ({ id: 'old-' + i, type: 'userMessage', content: [{ type: 'text', text: 'old', text_elements: [] }] })), ...thread.turns[0].items] }] }
        : thread;
      if (fs.existsSync(path.join(process.env.TEST_CTL, 'wrong-id'))) resultThread = { ...resultThread, id: '019c1bed-f24e-7f5f-a7f2-496c101e4e7b' };
      send({ id: q.id, result: { thread: resultThread } });
    };
    if (!listed && fs.existsSync(path.join(process.env.TEST_CTL, 'slow'))) return setTimeout(reply, 900);
    return reply();
  }
  send({ id: q.id, error: { code: -32601, message: 'unsupported' } });
});
`);
await chmod(binary, 0o700);
process.env.PATH = `${root}:/usr/bin:/bin`;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const piDir = join(process.env.PI_CODING_AGENT_DIR, "sessions", "--fixture--");
await mkdir(piDir, { recursive: true });
const pi = SessionManager.create(process.env.TEST_PROJECT, piDir);
pi.appendMessage({ role: "user", content: "pi needle", timestamp: Date.now() });
pi.appendMessage({ role: "assistant", content: [{ type: "text", text: "response" }], timestamp: Date.now() });
const piId = pi.getSessionId();
const claudeNativeId = "123e4567-e89b-42d3-a456-426614174010";
const claudeId = `claude:${claudeNativeId}`;
const claudeProject = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.env.TEST_PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
await mkdir(claudeProject, { recursive: true });
await writeFile(join(claudeProject, `${claudeNativeId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: claudeNativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null, cwd: process.env.TEST_PROJECT, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: [{ type: "text", text: "claude needle" }] } })}\n`);
const { sessions } = await jiti.import("./index.ts");
const codexId = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
const search = (query = "needle", signal = new AbortController().signal) => sessions.search(query, signal);
const hits = result => result.results.filter(row => row.session.id === codexId);
const countMethod = async method => (await readFile(process.env.TEST_LOG, "utf8").catch(() => "")).split("\n").filter(line => line === method).length;
const countReads = () => countMethod("read");
const waitFor = async predicate => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error("fixture did not settle");
};
const settledSearch = async (query = "needle") => {
  let result;
  await waitFor(async () => { result = await search(query); return result.pending !== true; });
  return result;
};

test.before(async () => {
  for (let i = 0; i < 20; i++) {
    const list = await sessions.list({ force: false, summary: true });
    if (list.sessions.some(row => row.id === codexId) && !list.backendErrors?.codex) return;
    await delay(100);
  }
  throw new Error("fixture catalogue did not load");
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });
test.afterEach(async () => {
  const pending = globalThis.__piCodexBrowseState.search;
  const enabled = process.env.PI_WEB_CODEX;
  process.env.PI_WEB_CODEX = "0";
  try { await search(); await pending?.promise; }
  finally { process.env.PI_WEB_CODEX = enabled; }
});

test("history failure identifies Codex so same-query results can be retained", async () => {
  const baseline = await settledSearch();
  assert.equal(hits(baseline).length, 1);
  assert.equal(hits(baseline)[0].titleMatch, undefined);
  await writeFile(join(process.env.TEST_CTL, "failure"), "");
  try {
    const failed = await settledSearch();
    assert.equal(hits(failed).length, 0);
    assert.equal(failed.truncated, true);
    assert.match(failed.backendErrors?.codex ?? "", /Codex/i);
  } finally { await rm(join(process.env.TEST_CTL, "failure"), { force: true }); }
});

test("a mismatched native history identity remains a backend failure", async () => {
  await writeFile(join(process.env.TEST_CTL, "wrong-id"), "");
  try {
    const result = await settledSearch();
    assert.equal(hits(result).length, 0);
    assert.match(result.backendErrors?.codex ?? "", /Codex/i);
    assert.equal(result.truncated, true);
  } finally { await rm(join(process.env.TEST_CTL, "wrong-id"), { force: true }); }
});

test("slow successful search converges on a later same-query request", async t => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countReads();
    const start = performance.now();
    const first = await search();
    const elapsed = performance.now() - start;
    t.diagnostic(`first response ${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed < 650, `search took ${elapsed}ms`);
    assert.equal(hits(first).length, 0);
    assert.ok(first.results.some(row => row.session.id === piId), "Pi result remains available");
    assert.ok(first.results.some(row => row.session.id === claudeId), "Claude result remains available");
    assert.equal(first.backendErrors?.claude, undefined);
    assert.equal(first.truncated, true);
    await delay(1100);
    const second = await settledSearch();
    assert.equal(hits(second).length, 1);
    assert.equal(second.backendErrors?.codex, undefined);
    assert.equal((await countReads()) - before, 1);
  } finally { await rm(join(process.env.TEST_CTL, "slow"), { force: true }); }
});

test("concurrent same-query callers share a completed background result", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countReads();
    assert.equal(hits(await search()).length, 0);
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    const [first, second] = await Promise.all([search(), search()]);
    assert.equal(hits(first).length, 1);
    assert.equal(hits(second).length, 1);
    assert.equal((await countReads()) - before, 1);
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await writeFile(join(process.env.TEST_CTL, "failure"), "");
    const failed = await settledSearch();
    assert.equal(hits(failed).length, 0);
    assert.match(failed.backendErrors?.codex ?? "", /Codex/i);
    await waitFor(async () => (await countReads()) - before >= 2);
    assert.equal((await countReads()) - before, 2);
  } finally {
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await rm(join(process.env.TEST_CTL, "failure"), { force: true });
  }
});

test("a late waiting caller consumes completion without hiding a subsequent failure", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countReads();
    assert.equal(hits(await search()).length, 0);
    await waitFor(async () => (await countReads()) > before);
    await delay(450);
    const completed = await settledSearch();
    assert.equal(hits(completed).length, 1);
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await writeFile(join(process.env.TEST_CTL, "failure"), "");
    const failed = await settledSearch();
    assert.equal(hits(failed).length, 0);
    assert.match(failed.backendErrors?.codex ?? "", /Codex/i);
    await waitFor(async () => (await countReads()) - before >= 2);
    assert.equal((await countReads()) - before, 2);
  } finally {
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await rm(join(process.env.TEST_CTL, "failure"), { force: true });
  }
});

test("a query never consumes a different query's completed result", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    assert.equal(hits(await search("needle")).length, 0);
    await delay(1100);
    const other = await search("absent-word");
    assert.equal(hits(other).length, 0);
    assert.equal(other.truncated, true);
    await delay(1100);
    const completed = await settledSearch("absent-word");
    assert.equal(hits(completed).length, 0);
    assert.equal(completed.backendErrors?.codex, undefined);
  } finally { await rm(join(process.env.TEST_CTL, "slow"), { force: true }); }
});

test("shared callers survive one caller cancelling", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countReads();
    const controller = new AbortController();
    const cancelled = search("needle", controller.signal);
    const remaining = search("needle");
    await waitFor(async () => (await countReads()) > before);
    controller.abort();
    const [first, second] = await Promise.all([cancelled, remaining]);
    assert.equal(hits(first).length, 0);
    assert.equal(hits(second).length, 0);
    assert.match(second.backendErrors?.codex ?? "", /Codex/i);
    await delay(1100);
    const recovered = await settledSearch();
    assert.equal(hits(recovered).length, 1);
    assert.equal(recovered.backendErrors?.codex, undefined);
    assert.equal((await countReads()) - before, 1);
  } finally { await rm(join(process.env.TEST_CTL, "slow"), { force: true }); }
});

test("cancelling the only caller does not cache its unfinished read", async t => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countReads();
    const controller = new AbortController();
    const subscribe = controller.signal.addEventListener.bind(controller.signal);
    t.mock.method(controller.signal, "addEventListener", (...args) => {
      subscribe(...args);
      // Cancel the foreground waiter before its deadline can transfer ownership.
      if (args[0] === "abort") queueMicrotask(() => controller.abort());
    });
    const pending = search("needle", controller.signal);
    await waitFor(async () => (await countReads()) > before);
    assert.equal(hits(await pending).length, 0);
    await delay(1100);
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    const next = await settledSearch();
    assert.equal(hits(next).length, 1);
    assert.equal((await countReads()) - before, 2);
  } finally { await rm(join(process.env.TEST_CTL, "slow"), { force: true }); }
});

test("disabling Codex discards pending and completed background results", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    assert.equal(hits(await search()).length, 0);
    await delay(1100);
    process.env.PI_WEB_CODEX = "0";
    const disabled = await search();
    assert.equal(hits(disabled).length, 0);
    assert.equal(disabled.backendErrors?.codex, undefined);
    process.env.PI_WEB_CODEX = "1";
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await writeFile(join(process.env.TEST_CTL, "failure"), "");
    const failed = await settledSearch();
    assert.equal(hits(failed).length, 0);
    assert.match(failed.backendErrors?.codex ?? "", /Codex/i);
  } finally {
    process.env.PI_WEB_CODEX = "1";
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await rm(join(process.env.TEST_CTL, "failure"), { force: true });
  }
});

test("disabling Codex while background work is pending prevents its reuse", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    assert.equal(hits(await search()).length, 0);
    process.env.PI_WEB_CODEX = "0";
    const disabled = await search();
    assert.equal(hits(disabled).length, 0);
    assert.equal(disabled.backendErrors?.codex, undefined);
    await delay(1100);
    process.env.PI_WEB_CODEX = "1";
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await writeFile(join(process.env.TEST_CTL, "failure"), "");
    const failed = await settledSearch();
    assert.equal(hits(failed).length, 0);
    assert.match(failed.backendErrors?.codex ?? "", /Codex/i);
  } finally {
    process.env.PI_WEB_CODEX = "1";
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await rm(join(process.env.TEST_CTL, "failure"), { force: true });
  }
});

test("catalogue and native content share one 400ms response budget", async t => {
  await writeFile(join(process.env.TEST_CTL, "slow-list"), "");
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countMethod("list");
    const refresh = sessions.list({ force: true, summary: true });
    await waitFor(async () => (await countMethod("list")) > before);
    const start = performance.now();
    const result = await search();
    const elapsed = performance.now() - start;
    t.diagnostic(`catalogue plus content response ${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed < 650, `catalogue plus content took ${elapsed}ms`);
    assert.ok(result.results.some(row => row.session.id === piId));
    assert.ok(result.results.some(row => row.session.id === claudeId));
    assert.equal(hits(result).length, 0);
    assert.match(result.backendErrors?.codex ?? "", /Codex/i);
    await refresh;
    await delay(1100);
    const recovered = await settledSearch();
    assert.equal(hits(recovered).length, 1);
    assert.equal(recovered.backendErrors?.codex, undefined);
  } finally {
    await rm(join(process.env.TEST_CTL, "slow-list"), { force: true });
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
  }
});

test("a stable stale catalogue can reuse a completed search while refresh remains pending", async () => {
  await writeFile(join(process.env.TEST_CTL, "hold-list"), "");
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    const before = await countMethod("list");
    const refresh = sessions.list({ force: true, summary: true });
    await waitFor(async () => (await countMethod("list")) > before);
    const first = await search();
    assert.equal(hits(first).length, 0);
    assert.match(first.backendErrors?.codex ?? "", /Codex/i);
    await refresh;
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    const second = await search();
    assert.equal(hits(second).length, 1);
    assert.match(second.backendErrors?.codex ?? "", /Codex/i);
  } finally {
    await rm(join(process.env.TEST_CTL, "hold-list"), { force: true });
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await waitFor(() => !globalThis.__piCodexBrowseState.scan);
  }
});

test("unclaimed background results expire without another request", async () => {
  await writeFile(join(process.env.TEST_CTL, "slow"), "");
  try {
    assert.equal(hits(await search()).length, 0);
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    await delay(5200);
    assert.equal(globalThis.__piCodexBrowseState.search, undefined);
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await writeFile(join(process.env.TEST_CTL, "failure"), "");
    assert.match((await settledSearch()).backendErrors?.codex ?? "", /Codex/i);
  } finally {
    await rm(join(process.env.TEST_CTL, "slow"), { force: true });
    await rm(join(process.env.TEST_CTL, "failure"), { force: true });
  }
});

test("a normal history limit is partial without a backend failure", async () => {
  await writeFile(join(process.env.TEST_CTL, "has-more"), "");
  try {
    const result = await settledSearch();
    assert.equal(hits(result).length, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.backendErrors?.codex, undefined);
  } finally { await rm(join(process.env.TEST_CTL, "has-more"), { force: true }); }
});
