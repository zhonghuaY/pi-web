import vm from 'node:vm';
import ts from 'typescript';
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
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
const ids = Array.from({ length: 18 }, (_, i) => '019c1bed-f24e-7f5f-a7f2-496c101e4e' + (0x7a + i).toString(16));
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
    const listedIds = fs.existsSync(path.join(process.env.TEST_CTL, 'drop-first')) ? ids.slice(1) : ids;
    const reversed = fs.existsSync(path.join(process.env.TEST_CTL, 'reverse-order'));
    const reply = () => send({ id: q.id, result: { data: listedIds.map(id => ({ ...thread, id, sessionId: id, preview: 'ordinary title ' + ids.indexOf(id), ...(reversed ? { name: 'fresh title ' + ids.indexOf(id) } : {}), updatedAt: reversed ? ids.indexOf(id) + 100 : 30 - ids.indexOf(id), turns: [] })), nextCursor: null } });
    if (fs.existsSync(path.join(process.env.TEST_CTL, 'hold-list'))) {
      const timer = setInterval(() => { if (!fs.existsSync(path.join(process.env.TEST_CTL, 'hold-list'))) { clearInterval(timer); reply(); } }, 10);
      return;
    }
    if (fs.existsSync(path.join(process.env.TEST_CTL, 'slow-list'))) return setTimeout(reply, 250);
    return reply();
  }
  if (q.method === 'thread/read') {
    fs.appendFileSync(process.env.TEST_LOG, 'read\\n');
    fs.appendFileSync(process.env.TEST_LOG, 'read-id:' + q.params.threadId + '\\n');
    if (fs.existsSync(path.join(process.env.TEST_CTL, 'failure'))) return send({ id: q.id, error: { code: -32603, message: 'temporary failure' } });
    const reply = () => {
      let resultThread = fs.existsSync(path.join(process.env.TEST_CTL, 'has-more'))
        ? { ...thread, turns: [{ ...thread.turns[0], items: [...Array.from({ length: 1000 }, (_, i) => ({ id: 'old-' + i, type: 'userMessage', content: [{ type: 'text', text: 'old', text_elements: [] }] })), ...thread.turns[0].items] }] }
        : thread;
      if (fs.existsSync(path.join(process.env.TEST_CTL, 'wrong-id'))) resultThread = { ...resultThread, id: '019c1bed-f24e-7f5f-a7f2-496c101e4e7b' };
      resultThread = { ...resultThread, id: q.params.threadId, sessionId: q.params.threadId, updatedAt: 30 - ids.indexOf(q.params.threadId), turns: [{ id: 'turn1', status: 'completed', items: [{ id: 'item1', type: 'userMessage', content: [{ type: 'text', text: (q.params.threadId === ids[4] || q.params.threadId === ids[8] || q.params.threadId === ids[17]) ? 'rare-needle-term' : 'no matching content', text_elements: [] }] }] }] };
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
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot }, interopDefault: true });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const piDir = join(process.env.PI_CODING_AGENT_DIR, "sessions", "--fixture--");
await mkdir(piDir, { recursive: true });
const pi = SessionManager.create(process.env.TEST_PROJECT, piDir);
pi.appendMessage({ role: "user", content: "pi needle", timestamp: Date.now() });
pi.appendMessage({ role: "assistant", content: [{ type: "text", text: "response" }], timestamp: Date.now() });
const claudeNativeId = "123e4567-e89b-42d3-a456-426614174010";
const claudeProject = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.env.TEST_PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
await mkdir(claudeProject, { recursive: true });
await writeFile(join(claudeProject, `${claudeNativeId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: claudeNativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null, cwd: process.env.TEST_PROJECT, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: [{ type: "text", text: "claude needle" }] } })}\n`);
const { sessions } = await jiti.import(join(projectRoot, "lib/backend-service/index.ts"));
const codexId = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
const search = (query = "needle", signal = new AbortController().signal) => sessions.search(query, signal);
const waitFor = async predicate => {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(20); }
  throw new Error("fixture did not settle");
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


const jsx = await jiti.import('react/jsx-runtime');
const { renderToStaticMarkup } = await jiti.import('react-dom/server');
const { sessionBackend } = await jiti.import('@/lib/agent-backends');
const source = await readFile(join(projectRoot, 'components/SessionSearch.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function makeHarness() {
  const slots = [];
  const effects = [];
  const timers = new Map();
  const replies = [];
  let cursor = 0;
  let nextTimer = 0;
  let props = { open: true, query: 'rare', children: 'tree', selectedSessionId: null, onSelectSession() {} };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const current = effects[index];
      if (current && deps.length === current.deps.length && deps.every((value, position) => Object.is(value, current.deps[position]))) return;
      current?.cleanup?.();
      effects[index] = { deps, cleanup: effect() };
    },
  };
  const imports = {
    react: hooks,
    'react/jsx-runtime': jsx,
    '@/hooks/useI18n': { useI18n: () => ({ t: key => key, locale: 'en' }) },
    '@/lib/i18n/format': { formatRelativeTime: () => 'now' },
    '@/lib/agent-backends': { sessionBackend },
  };
  const moduleRecord = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleRecord, exports: moduleRecord.exports,
    require: name => { assert.ok(name in imports, `unexpected import ${name}`); return imports[name]; },
    AbortController, URL, URLSearchParams,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requestCount++;
      const q = new URL(url, 'http://localhost').searchParams.get('q');
      const reply = await sessions.search(q, options.signal);
      responses.push(reply);
      return { ok: true, json: async () => reply };
    },
  });
  const Search = moduleRecord.exports.SessionSearch;
  return {
    pendingTimers() { return timers.size; },
    setProps(next) { props = { ...props, ...next }; },
    queue(reply) { replies.push(reply); },
    render() { cursor = 0; return renderToStaticMarkup(Search(props)); },
    async flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) await timer();
    },
  };
}


const target = suffix => 'codex:019c1bed-f24e-7f5f-a7f2-496c101e4e' + suffix;
const fifth = target('7e');
const ninth = target('82');
const eighteenth = target('8b');
let requestCount = 0;
const responses = [];

test('bounded search windows preserve progress beyond a 15 second lifetime', async () => {
  const initialLog = await readFile(process.env.TEST_LOG, 'utf8');
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const start = performance.now();
  const completed = [];
  for (let window = 0; window < 9; window++) {
    const partial = await search('needle');
    assert.equal(partial.truncated, true);
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    const result = await search('needle');
    completed.push(result);
    if (result.results.some(row => row.session.id === eighteenth)) break;
  }
  const allIds = completed.at(-1).results.map(row => row.session.id);
  assert.ok(allIds.includes(fifth), 'fifth native history is reachable');
  assert.ok(allIds.includes(ninth), 'ninth native history is reachable after another window');
  assert.ok(allIds.includes(eighteenth), 'progress survives more than 15 seconds of bounded windows');
  assert.ok(performance.now() - start > 15_000);
  assert.equal(completed.at(-1).backendErrors?.codex, undefined);
  const log = await readFile(process.env.TEST_LOG, 'utf8');
  const scanned = log.slice(initialLog.length).split('\n').filter(line => line.startsWith('read-id:'));
  console.log(JSON.stringify({ windowResults: completed.map(result => result.results.filter(row => row.session.id.startsWith('codex:')).map(row => row.session.id)), scanned }));
  assert.equal(scanned.filter(line => line.endsWith('7a')).length, 1, 'completed history is not rescanned');
});

test('an unchanged open component collects native hits across bounded windows and clears its warning', async () => {
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const component = makeHarness();
  component.render();
  await component.flush();
  let html = component.render();
  assert.equal(requestCount, 1);
  assert.equal(responses[0].results.some(row => row.session.id === fifth), false);
  assert.match(html, /Codex session history is unavailable/);
  assert.ok(component.pendingTimers() > 0, 'a pending native search schedules collection');
  for (let i = 0; i < 90 && component.pendingTimers(); i++) {
    await delay(225);
    await component.flush();
    html = component.render();
    if (responses.at(-1)?.results.some(row => row.session.id === eighteenth) && !responses.at(-1)?.pending) break;
  }
  assert.ok(responses.some(result => result.results.some(row => row.session.id === fifth) && !result.results.some(row => row.session.id === ninth)), 'fifth hit appeared in an intermediate window');
  assert.ok(responses.some(result => result.results.some(row => row.session.id === ninth) && !result.results.some(row => row.session.id === eighteenth)), 'ninth hit appeared in a later window');
  assert.ok(responses.at(-1).results.some(row => row.session.id === eighteenth), 'eighteenth hit arrived while query remained unchanged');
  assert.match(html, /ordinary title 4/);
  assert.match(html, /ordinary title 8/);
  assert.match(html, /ordinary title 17/);
  assert.doesNotMatch(html, /Codex session history is unavailable/);
  assert.equal(component.pendingTimers(), 0);
  console.log(JSON.stringify({ requests: requestCount, finalNativeHits: responses.at(-1).results.filter(row => row.session.id.startsWith('codex:')).map(row => row.session.id), pendingTimers: component.pendingTimers() }));
});

test('concurrent consumers share continuation without repeating completed histories', async () => {
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const before = await readFile(process.env.TEST_LOG, 'utf8');
  assert.equal((await search('needle')).pending, true);
  await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
  const [first, second] = await Promise.all([search('needle'), search('needle')]);
  assert.equal(first.pending, true);
  assert.equal(second.pending, true);
  assert.deepEqual(first.results.map(row => row.session.id), second.results.map(row => row.session.id));
  await Promise.all([search('needle'), search('needle')]);
  await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
  const [third, fourth] = await Promise.all([search('needle'), search('needle')]);
  assert.ok(third.results.some(row => row.session.id === fifth));
  assert.deepEqual(third.results.map(row => row.session.id), fourth.results.map(row => row.session.id));
  const scanned = (await readFile(process.env.TEST_LOG, 'utf8')).slice(before.length).split('\n');
  assert.equal(scanned.filter(line => line === 'read-id:' + target('7a').slice('codex:'.length)).length, 1);
});

test('an expired search lifetime finishes with a retained error instead of restarting', async () => {
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 15_000 ? 500 : ms, ...args);
  try {
    assert.equal((await search('lifetime')).pending, true);
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    const failed = await search('lifetime');
    assert.equal(failed.pending, undefined);
    assert.equal(failed.truncated, true);
    assert.match(failed.backendErrors?.codex ?? '', /Codex/i);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await rm(join(process.env.TEST_CTL, 'slow'), { force: true });
  }
});

test('disabling after a lifetime expires prevents late results from being cached', async () => {
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 15_000 ? 500 : ms, ...args);
  try {
    assert.equal((await search('disable-expired')).pending, true);
    await delay(175);
    process.env.PI_WEB_CODEX = '0';
    assert.equal((await search('disable-expired')).pending, undefined);
    process.env.PI_WEB_CODEX = '1';
    await waitFor(() => !globalThis.__piCodexBrowseState.search);
    await rm(join(process.env.TEST_CTL, 'slow'), { force: true });
    await writeFile(join(process.env.TEST_CTL, 'failure'), '');
    let failed = await search('disable-expired');
    if (failed.pending) {
      await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
      failed = await search('disable-expired');
    }
    assert.match(failed.backendErrors?.codex ?? '', /Codex/i);
    assert.equal(failed.pending, undefined);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    process.env.PI_WEB_CODEX = '1';
    await rm(join(process.env.TEST_CTL, 'slow'), { force: true });
    await rm(join(process.env.TEST_CTL, 'failure'), { force: true });
  }
});

test('catalogue refresh preserves stable progress, changed membership and disable discard it, and errors stop collection', async () => {
  const query = 'not-present';
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const oldCatalogue = globalThis.__piCodexBrowseState.catalogue.value.sessions;
  try {
    assert.equal((await search(query)).pending, true);
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    const nextIndex = globalThis.__piCodexBrowseState.search.completed.value.progress.nextIndex;
    assert.equal((await search(query)).pending, true);
    await writeFile(join(process.env.TEST_CTL, 'reverse-order'), '');
    await sessions.list({ force: true, summary: true });
    await waitFor(() => !globalThis.__piCodexBrowseState.scan && globalThis.__piCodexBrowseState.catalogue.value.sessions !== oldCatalogue);
    let before = await readFile(process.env.TEST_LOG, 'utf8');
    assert.equal((await search(query)).pending, true);
    await waitFor(async () => (await readFile(process.env.TEST_LOG, 'utf8')).slice(before.length).split('\n').some(line => line.startsWith('read-id:')));
    let after = (await readFile(process.env.TEST_LOG, 'utf8')).slice(before.length);
    assert.equal(after.split('\n').find(line => line.startsWith('read-id:')), 'read-id:' + target((0x7a + nextIndex).toString(16)).slice('codex:'.length));
    await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
    const stableCatalogue = globalThis.__piCodexBrowseState.catalogue.value.sessions;
    await rm(join(process.env.TEST_CTL, 'reverse-order'), { force: true });
    await writeFile(join(process.env.TEST_CTL, 'drop-first'), '');
    await sessions.list({ force: true, summary: true });
    await waitFor(() => !globalThis.__piCodexBrowseState.scan && globalThis.__piCodexBrowseState.catalogue.value.sessions !== stableCatalogue);
    before = await readFile(process.env.TEST_LOG, 'utf8');
    assert.equal((await search(query)).pending, true);
    await waitFor(async () => (await readFile(process.env.TEST_LOG, 'utf8')).slice(before.length).split('\n').some(line => line.startsWith('read-id:')));
    after = (await readFile(process.env.TEST_LOG, 'utf8')).slice(before.length);
    assert.equal(after.split('\n').find(line => line.startsWith('read-id:')), 'read-id:' + target('7b').slice('codex:'.length));
    process.env.PI_WEB_CODEX = '0';
    const disabled = await search(query);
    assert.equal(disabled.pending, undefined);
    assert.equal(disabled.backendErrors?.codex, undefined);
    await waitFor(() => !globalThis.__piCodexBrowseState.search);
    process.env.PI_WEB_CODEX = '1';
    await rm(join(process.env.TEST_CTL, 'slow'), { force: true });
    await writeFile(join(process.env.TEST_CTL, 'failure'), '');
    let failed = await search(query);
    if (failed.pending) {
      await waitFor(() => Boolean(globalThis.__piCodexBrowseState.search?.completed));
      failed = await search(query);
    }
    assert.match(failed.backendErrors?.codex ?? '', /Codex/i);
    assert.equal(failed.pending, undefined);
  } finally {
    process.env.PI_WEB_CODEX = '1';
    await rm(join(process.env.TEST_CTL, 'failure'), { force: true });
    await rm(join(process.env.TEST_CTL, 'slow'), { force: true });
    await rm(join(process.env.TEST_CTL, 'drop-first'), { force: true });
    await rm(join(process.env.TEST_CTL, 'reverse-order'), { force: true });
  }
});

test('same-membership refresh supplies fresh row metadata during continuation', async () => {
  await sessions.list({ force: true, summary: true });
  await waitFor(() => !globalThis.__piCodexBrowseState.scan);
  await writeFile(join(process.env.TEST_CTL, 'slow'), '');
  const component = makeHarness();
  try {
    component.render();
    await component.flush();
    let html = component.render();
    for (let i = 0; i < 60 && component.pendingTimers() && !responses.at(-1)?.results.some(row => row.session.id === fifth); i++) {
      await delay(225);
      await component.flush();
      html = component.render();
    }
    const priorRow = responses.at(-1)?.results.find(row => row.session.id === fifth);
    assert.ok(priorRow, 'the component collected the fifth native hit');
    assert.match(html, /ordinary title 4/);
    assert.ok(component.pendingTimers(), 'the unchanged query still has work');
    const oldCatalogue = globalThis.__piCodexBrowseState.catalogue.value.sessions;
    await writeFile(join(process.env.TEST_CTL, 'reverse-order'), '');
    await sessions.list({ force: true, summary: true });
    await waitFor(() => !globalThis.__piCodexBrowseState.scan && globalThis.__piCodexBrowseState.catalogue.value.sessions !== oldCatalogue);
    const currentRow = globalThis.__piCodexBrowseState.catalogue.value.sessions.find(row => row.id === fifth);
    assert.ok(currentRow);
    assert.ok(currentRow.modified > priorRow.session.modified, 'positive control: timestamp moved forward');
    assert.equal(currentRow.name, 'fresh title 4', 'positive control: title was refreshed');
    await component.flush();
    html = component.render();
    const intermediate = responses.at(-1)?.results.find(row => row.session.id === fifth);
    assert.ok(intermediate);
    for (let i = 0; i < 90 && responses.at(-1)?.pending && component.pendingTimers(); i++) {
      await delay(225);
      await component.flush();
      html = component.render();
    }
    const finalResponse = responses.at(-1);
    assert.equal(finalResponse.pending, undefined, 'all windows completed');
    assert.equal(finalResponse.backendErrors?.codex, undefined, 'completion has no native backend error');
    const actualRow = finalResponse.results.find(row => row.session.id === fifth);
    assert.ok(actualRow);
    console.log(JSON.stringify({ id: fifth, originalTime: priorRow.session.modified, catalogueTime: currentRow.modified, intermediateTime: intermediate.session.modified, finalTime: actualRow.session.modified, catalogueTitle: currentRow.name, finalTitle: actualRow.session.name ?? null, htmlHasFreshTitle: html.includes(currentRow.name), pending: finalResponse.pending ?? false, scheduledPolls: component.pendingTimers() }));
    assert.match(html, /fresh title 4/, 'the component should show refreshed values while keeping its order');
    assert.equal(actualRow.session.name, currentRow.name);
    assert.equal(actualRow.session.modified, currentRow.modified);
    assert.equal(component.pendingTimers(), 0);
  } finally {
    await rm(join(process.env.TEST_CTL, 'slow'), { force: true });
    await rm(join(process.env.TEST_CTL, 'reverse-order'), { force: true });
  }
});
