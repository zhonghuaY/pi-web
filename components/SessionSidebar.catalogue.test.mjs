import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { createJiti } from 'jiti';
import ts from 'typescript';

const home = await mkdtemp(join(tmpdir(), 'pi-web-sidebar-catalogue-'));
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

const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' }, tsconfigPaths: true, fsCache: false });
const React = await jiti.import('react');
const { renderToStaticMarkup } = await jiti.import('react-dom/server');
const { I18nProvider } = await jiti.import('@/hooks/useI18n');
const { SessionTree } = await jiti.import('./SessionTree.tsx');
const { sessionBackend } = await jiti.import('@/lib/agent-backends');
const { parseSessionKey } = await jiti.import('@/lib/session-identity');

const source = await readFile(new URL('./SessionSidebar.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const loadSessions = useCallback(');
const end = source.indexOf('\n\n  const initialLoadDone', start);
assert.ok(start >= 0 && end > start, 'sidebar load callback exists');
const callback = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const noop = () => {};
const project = { key: '/project', root: '/project', name: 'project', pinned: false, current: true };
const time = new Date('2026-01-01T00:00:00Z').toISOString();
const ids = { pi: 'pi-id', claude: 'claude:123e4567-e89b-42d3-a456-426614174000', codex: 'codex:019a1234-abcd-7abc-8abc-123456789abc', codexOld: 'codex:019a1234-abcd-7abc-8abc-123456789abd' };
const session = (id, backend) => ({ id, backend, path: id, cwd: project.root, created: time, modified: time, messageCount: 0, firstMessage: `${backend} session` });
const row = root => ({
  kind: 'session', key: `session:group:${root.id}`,
  family: { root, subagents: [], latestModified: root.modified }, context: 'group', project,
  status: { running: false, awaiting: false, unread: false, selected: false, transient: false },
});

test('sidebar keeps all backend rows visible alongside partial catalogue warnings', async () => {
  const sessions = [session(ids.pi, 'pi'), session(ids.claude, 'claude'), session(ids.codex, 'codex')];
  let response = { sessions, sessionListVersion: 1, backendErrors: { claude: 'Claude session history is unavailable', codex: 'Codex session history is unavailable' } };
  let displayedSessions;
  let displayedError;
  const loadSessions = vm.runInNewContext(`${callback}\nloadSessions`, {
    useCallback: fn => fn,
    fetch: async () => ({ ok: true, json: async () => response }),
    sessionListUrl: () => '/api/sessions',
    sessionLoadIdRef: { current: 0 }, sessionListVersionRef: { current: null },
    runningPollAuthoritativeRef: { current: false }, currentSuppressedCompletionSessionIdsRef: { current: new Set() },
    setLoading: noop, setAllSessions: value => { displayedSessions = typeof value === 'function' ? value(displayedSessions ?? []) : value; }, setSessionDetailsLoaded: noop,
    setRunningSessionIds: noop, setAwaitingInputSessionIds: noop, setUnreadSessionIds: noop,
    isHiddenRelation: () => false, sameIdsOr: noop, sessionBackend, parseSessionKey,
    setError: value => { displayedError = value; },
  });
  await loadSessions();
  assert.equal(displayedSessions, sessions);
  assert.match(displayedError, /Claude session history is unavailable/);
  assert.match(displayedError, /Codex session history is unavailable/);

  const h = React.createElement;
  const html = renderToStaticMarkup(h(I18nProvider, null, h(SessionTree, {
    rows: displayedSessions.map(row), layout: 'desktop', emptyLabel: 'No sessions', loading: false, error: displayedError,
    renamingRootId: null, renamingProjectKey: null, confirmDeleteRootId: null, activeMenuRowKey: null,
    onSelectFamily: noop, onToggleGroup: noop, onShowMore: noop, onShowLess: noop, onTogglePinned: noop,
    onArchiveFamily: noop, onRestoreFamily: noop, onOpenRowMenu: noop, onRowContextMenu: noop,
    onRenameCommit: noop, onRenameCancel: noop, onDeleteConfirm: noop, onDeleteCancel: noop,
    onGroupNew: noop, onGroupMenu: noop, onPinEmptyGroup: noop, onOpenOtherProject: noop, onOpenArchive: noop,
  })));
  assert.match(html, /session-tree-message is-error/);
  assert.match(html, /Claude session history is unavailable/);
  assert.match(html, /Codex session history is unavailable/);
  for (const backend of ['pi', 'claude', 'codex']) assert.match(html, new RegExp(`${backend} session`));

  response = { sessions, sessionListVersion: 2 };
  await loadSessions();
  assert.equal(displayedError, null, 'a later complete response clears the warning');
});

test('sidebar retains only failed backends and replaces old rows with fresh partial results', async () => {
  const pi = session(ids.pi, 'pi');
  const claude = session(ids.claude, 'claude');
  const oldCodex = session(ids.codex, 'codex');
  const missingCodex = session(ids.codexOld, 'codex');
  let response = { sessions: [pi, claude, oldCodex, missingCodex], sessionListVersion: 1 };
  let failFetch = false;
  let displayedSessions = [];
  let displayedError = null;
  let unread = new Set([ids.codexOld]);
  const loadSessions = vm.runInNewContext(`${callback}\nloadSessions`, {
    useCallback: fn => fn,
    fetch: async () => {
      if (failFetch) throw new Error('temporary fetch failure');
      return { ok: true, json: async () => response };
    }, sessionListUrl: () => '/api/sessions',
    sessionLoadIdRef: { current: 0 }, sessionListVersionRef: { current: null },
    runningPollAuthoritativeRef: { current: false }, currentSuppressedCompletionSessionIdsRef: { current: new Set() },
    setLoading: noop, setAllSessions: update => { displayedSessions = typeof update === 'function' ? update(displayedSessions) : update; }, setSessionDetailsLoaded: noop,
    setRunningSessionIds: noop, setAwaitingInputSessionIds: noop, setUnreadSessionIds: update => { unread = update(unread); },
    isHiddenRelation: () => false, sameIdsOr: noop, sessionBackend, parseSessionKey,
    setError: value => { displayedError = value; },
  });
  await loadSessions();

  failFetch = true;
  await loadSessions();
  assert.deepEqual(Array.from(displayedSessions, item => item.id).sort(), [ids.pi, ids.claude, ids.codex, ids.codexOld].sort());
  assert.match(displayedError, /temporary fetch failure/);
  failFetch = false;

  response = { sessions: [pi, claude], sessionListVersion: 2, backendErrors: { codex: 'Codex session history is unavailable' } };
  await loadSessions();
  assert.deepEqual(Array.from(displayedSessions, item => item.id).sort(), [ids.pi, ids.claude, ids.codex, ids.codexOld].sort());
  assert.equal(displayedError, 'Codex session history is unavailable');

  const freshCodex = { ...oldCodex, firstMessage: 'fresh codex title' };
  response = { sessions: [pi, freshCodex], sessionListVersion: 3, backendErrors: { codex: 'Codex session history is unavailable' } };
  await loadSessions();
  assert.deepEqual(Array.from(displayedSessions, item => item.id).sort(), [ids.pi, ids.codex, ids.codexOld].sort());
  assert.equal(displayedSessions.find(item => item.id === ids.codex).firstMessage, 'fresh codex title');
  assert.ok(unread.has(ids.codexOld), 'unread marker survives along with its retained row');
  assert.equal(displayedError, 'Codex session history is unavailable');

  response = { sessions: [pi, freshCodex, missingCodex], sessionListVersion: 4, backendErrors: { codex: 'Codex session history is unavailable' } };
  await loadSessions();
  assert.equal(displayedSessions.filter(item => item.id === ids.codexOld).length, 1, 'fresh and retained copies are not duplicated');

  response = { sessions: [pi, freshCodex], sessionListVersion: 5 };
  await loadSessions();
  assert.deepEqual(Array.from(displayedSessions, item => item.id).sort(), [ids.pi, ids.codex].sort());
  assert.equal(unread.has(ids.codexOld), false, 'recovery prunes a row absent from the complete response');
  assert.equal(displayedError, null);
});
