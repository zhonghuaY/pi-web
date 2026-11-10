import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { createJiti } from 'jiti';
import ts from 'typescript';

const home = await mkdtemp(join(tmpdir(), 'pi-web-search-catalogue-'));
const isolated = {
  HOME: join(home, 'home'), PI_CODING_AGENT_DIR: join(home, 'pi'),
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
};
await Promise.all(Object.values(isolated).map(path => mkdir(path)));
const keys = [...Object.keys(isolated), 'JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
Object.assign(process.env, isolated);
for (const key of ['JITI_ALIAS', 'PI_PACKAGE_DIR', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT']) delete process.env[key];
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const jsx = await jiti.import('react/jsx-runtime');
const { renderToStaticMarkup } = await jiti.import('react-dom/server');
const { sessionBackend } = await jiti.import('@/lib/agent-backends');
const source = await readFile(new URL('./SessionSearch.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function makeHarness() {
  const slots = [];
  const effects = [];
  const timers = new Map();
  const replies = [];
  const requests = [];
  let cursor = 0;
  let nextTimer = 0;
  let props = { open: true, query: 'alpha', children: 'tree', selectedSessionId: null, onSelectSession() {} };
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
    AbortController, URLSearchParams,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, signal: options.signal });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      assert.ok(reply, 'a search response was queued');
      return { ok: true, json: async () => reply };
    },
  });
  const Search = moduleRecord.exports.SessionSearch;
  return {
    setProps(next) { props = { ...props, ...next }; },
    queue(reply) { replies.push(reply); },
    requests,
    pendingTimers() { return timers.size; },
    render() { cursor = 0; return renderToStaticMarkup(Search(props)); },
    async flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) await timer();
    },
  };
}

const ids = {
  pi: 'pi-source',
  codex: 'codex:019a1234-abcd-7abc-8abc-123456789abc',
  oldCodex: 'codex:019a1234-abcd-7abc-8abc-123456789abd',
};
function hit(id, backend, title, query = 'alpha') {
  const session = { id, backend, path: id, cwd: '/project', created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z', messageCount: 1, firstMessage: title };
  return { session, blockIndex: 0, before: '', match: query, after: '' };
}
const partial = results => ({ results, truncated: false, backendErrors: { codex: 'Codex session history is unavailable' } });
const complete = results => ({ results, truncated: false });

test('an empty partial search shows the backend error instead of claiming no matches', async () => {
  const ui = makeHarness();
  ui.queue(partial([]));
  ui.render();
  await ui.flush();
  const html = ui.render();
  assert.match(html, /Codex session history is unavailable/);
  assert.doesNotMatch(html, /sidebar\.sessionSearchEmpty/);
});

test('search preserves only same-query failed-backend hits, prefers fresh data, and clears stale hits on recovery', async () => {
  const ui = makeHarness();
  ui.queue(complete([hit(ids.pi, 'pi', 'Pi prior'), hit(ids.codex, 'codex', 'Codex prior'), hit(ids.oldCodex, 'codex', 'Codex retained')]));
  ui.render();
  await ui.flush();
  assert.match(ui.render(), /Codex retained/);

  ui.setProps({ open: false }); ui.render();
  ui.queue(partial([hit(ids.pi, 'pi', 'Pi fresh'), hit(ids.codex, 'codex', 'Codex fresh')]));
  ui.setProps({ open: true }); ui.render();
  await ui.flush();
  let html = ui.render();
  assert.match(html, /Codex session history is unavailable/);
  assert.match(html, /Codex fresh/);
  assert.match(html, /Codex retained/);
  assert.doesNotMatch(html, /Codex prior/);
  assert.equal((html.match(/Codex fresh/g) ?? []).length, 1);

  ui.queue(partial([]));
  ui.setProps({ query: 'beta' }); ui.render();
  await ui.flush();
  html = ui.render();
  assert.doesNotMatch(html, /Codex fresh|Codex retained|Pi fresh/);
  assert.match(html, /Codex session history is unavailable/);

  ui.queue(partial([]));
  ui.setProps({ query: 'alpha' }); ui.render();
  await ui.flush();
  html = ui.render();
  assert.match(html, /Codex fresh/);
  assert.match(html, /Codex retained/);
  assert.doesNotMatch(html, /Pi fresh/);

  ui.setProps({ open: false }); ui.render();
  ui.queue(complete([hit(ids.pi, 'pi', 'Pi recovered'), hit(ids.codex, 'codex', 'Codex recovered')]));
  ui.setProps({ open: true }); ui.render();
  await ui.flush();
  html = ui.render();
  assert.match(html, /Codex recovered/);
  assert.doesNotMatch(html, /Codex retained|Codex fresh|history is unavailable/);
  assert.equal((html.match(/Codex recovered/g) ?? []).length, 1);

  ui.setProps({ open: false }); ui.render();
  ui.queue(new Error('temporary fetch failure'));
  ui.setProps({ open: true }); ui.render();
  await ui.flush();
  html = ui.render();
  assert.match(html, /sidebar\.sessionSearchFailed/);
  assert.match(html, /Codex recovered/);
});

test('query changes discard a late response and close cancels scheduled collection', async () => {
  const ui = makeHarness();
  let finishOld;
  ui.queue(new Promise(resolve => { finishOld = resolve; }));
  ui.render();
  const oldRequest = ui.flush();
  await Promise.resolve();
  ui.setProps({ query: 'beta' }); ui.render();
  assert.equal(ui.requests[0].signal.aborted, true);
  finishOld(complete([hit(ids.codex, 'codex', 'Stale alpha')]));
  await oldRequest;
  ui.queue({ ...partial([hit(ids.pi, 'pi', 'Beta fresh', 'beta')]), pending: true });
  await ui.flush();
  let html = ui.render();
  assert.match(html, /Beta fresh/);
  assert.doesNotMatch(html, /Stale alpha/);
  assert.equal(ui.pendingTimers(), 1);
  const requests = ui.requests.length;
  ui.setProps({ open: false });
  html = ui.render();
  assert.match(html, /tree/);
  assert.equal(ui.pendingTimers(), 0);
  assert.equal(ui.requests.at(-1).signal.aborted, true);
  await ui.flush();
  assert.equal(ui.requests.length, requests);
});

test('completed failures and fetch errors do not schedule retries', async () => {
  const ui = makeHarness();
  ui.queue(partial([]));
  ui.render();
  await ui.flush();
  assert.match(ui.render(), /Codex session history is unavailable/);
  assert.equal(ui.pendingTimers(), 0);
  ui.setProps({ open: false }); ui.render();
  ui.queue(new Error('permanent failure'));
  ui.setProps({ open: true }); ui.render();
  await ui.flush();
  assert.match(ui.render(), /sidebar\.sessionSearchFailed/);
  assert.equal(ui.pendingTimers(), 0);
});

test('pending collection stops after 100 retries and unrelated renders do not refetch', async () => {
  const ui = makeHarness();
  for (let i = 0; i < 101; i++) ui.queue({ ...partial([]), pending: true });
  ui.render();
  for (let i = 0; i < 101; i++) await ui.flush();
  assert.equal(ui.requests.length, 101);
  assert.equal(ui.pendingTimers(), 0);
  ui.setProps({ selectedSessionId: ids.pi }); ui.render();
  await ui.flush();
  assert.equal(ui.requests.length, 101);
});

test('collection keeps existing rows in place when activity changes their timestamps', async () => {
  const ui = makeHarness();
  const first = hit(ids.pi, 'pi', 'First original');
  const second = hit(ids.codex, 'codex', 'Second original');
  first.session.modified = '2026-03-01T00:00:00Z';
  second.session.modified = '2026-01-01T00:00:00Z';
  ui.queue({ ...complete([first, second]), pending: true });
  ui.render();
  await ui.flush();
  const freshFirst = hit(ids.pi, 'pi', 'First fresh');
  const freshSecond = hit(ids.codex, 'codex', 'Second fresh');
  freshFirst.session.modified = first.session.modified;
  freshSecond.session.modified = '2026-06-01T00:00:00Z';
  ui.queue(complete([freshSecond, freshFirst]));
  await ui.flush();
  const html = ui.render();
  assert.match(html, /First fresh/);
  assert.match(html, /Second fresh/);
  assert.ok(html.indexOf('First fresh') < html.indexOf('Second fresh'), 'activity did not reorder existing rows');
  assert.equal(ui.pendingTimers(), 0);
});
