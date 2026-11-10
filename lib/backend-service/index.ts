import { inventory, models, createRuntime, commandRuntime, runtimeEvents, handoff, autoName, fork } from "./runtime";
import { bashOutput } from "./bash-output";
import { parseSessionKey } from "@/lib/session-identity";
import { claudeDelete } from "@/lib/claude-routes";
import { deleteSessions, type SessionDeleteResult as BulkDeleteValue } from "@/lib/session-delete";
import { computeSessionStats, type SessionUsageSummary } from "@/lib/session-stats";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { sideOwnEntries } from "@/lib/side-session";
import type { ServerPerf } from "@/lib/perf";
import { readPiSession, readPiContext } from "./history";
import { exportSession, type SessionExportRequest, type SessionExportResult } from "./export";
import { thinking, toolResultImage, type EntryDetailRequest, type ThinkingResult, type ToolResultImageResult } from "./entry-detail";
import { subagents, type SessionSubagentsRequest, type SessionSubagentsResult } from "./subagents";
import { claudeBackend, claudeEnabled, readClaudeCatalogue, readClaudeRuntime, readCodexCatalogue } from "@/lib/agent-catalog";
import { searchClaudeSessions, searchProjectedSessions, type ProjectedSearchProgress } from "@/lib/claude-search";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRpcSession,
  renameRpcSession,
  getRunningRpcSessionIds,
  withSubagentDisplayStatus,
} from "@/lib/rpc-manager";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  getSessionSettings,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  openSessionManager,
  resolveSessionPath,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
  toSessionEntries,
} from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { forgetSessionUiState, getSessionUiStateRevision } from "@/lib/session-ui-state";
import { getSessionIdsWithUnsettledSubagentRuns, hasUnsettledSubagentRun } from "@/lib/subagent-runtime";
import { getCodexSession, getCodexSessionInfos, codexLeaseState, codexSessionState } from "@/lib/agent-backends/codex";
import { codexEnabled } from "@/lib/agent-backends/codex/descriptor";
import { CODEX_CAPABILITIES } from "@/lib/agent-backends/codex/projection";

export interface SessionListQuery {
  force: boolean;
  summary: boolean;
}

export interface SessionHistoryQuery {
  tail: number;
  before?: string;
  leafId?: string;
  deferThinking: boolean;
  deferToolResultImages: boolean;
}

export interface SessionReadQuery extends SessionHistoryQuery {
  force: boolean;
  summaryTree: boolean;
}

type HistoryFailure =
  | { ok: false; kind: "invalid"; reason: "invalid-id" | "unknown-namespace" }
  | { ok: false; kind: "unsupported" }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "error"; backend: "pi" | "claude" | "codex"; error: unknown };

export interface SessionStatsRequest { ids: readonly string[] }
export type SessionStatsResult =
  | { ok: true; value: { stats: Record<string, SessionUsageSummary> } }
  | Extract<HistoryFailure, { kind: "invalid" | "unsupported" }>;

export interface SessionStateRequest {
  id: string;
  missingPi: "idle" | "not-found";
  includeSystemPrompt: boolean;
}
export type SessionStateResult =
  | { ok: true; value: { running: boolean; state?: unknown } }
  | HistoryFailure;

export interface SessionLeaseRequest { id: string }
export type SessionLeaseResult =
  | { ok: true; value: { success: true; running: boolean; awaitingInput: boolean; subagentsActive: boolean } }
  | Extract<HistoryFailure, { kind: "invalid" | "unsupported" }>;

export interface SessionRenameRequest { id: string; name: string }
export type SessionRenameResult =
  | { ok: true; value: { ok: true } }
  | HistoryFailure
  | { ok: false; kind: "disabled" }
  | { ok: false; kind: "empty-name" };

export interface SessionDeleteRequest { id: string }
export type SessionDeleteResult =
  | { ok: true; value: { ok: true } }
  | Extract<HistoryFailure, { kind: "invalid" | "unsupported" | "not-found" }>
  | { ok: false; kind: "claude-error"; status: number; error: string };

export interface SessionBulkDeleteRequest { ids: readonly string[] }
export type SessionBulkDeleteResult =
  | { ok: true; value: BulkDeleteValue }
  | Extract<HistoryFailure, { kind: "invalid" | "unsupported" }>
  | { ok: false; kind: "disabled" };

export interface SessionsService {
  inventory: typeof inventory;
  models: typeof models;
  createRuntime: typeof createRuntime;
  commandRuntime: typeof commandRuntime;
  runtimeEvents: typeof runtimeEvents;
  bashOutput: typeof bashOutput;
  subagents(request: SessionSubagentsRequest): Promise<SessionSubagentsResult>;
  thinking(request: EntryDetailRequest): Promise<ThinkingResult>;
  toolResultImage(request: EntryDetailRequest): Promise<ToolResultImageResult>;
  exportSession(request: SessionExportRequest): Promise<SessionExportResult>;
  handoff: typeof handoff;
  autoName: typeof autoName;
  fork: typeof fork;
  deleteBulk(request: SessionBulkDeleteRequest): Promise<SessionBulkDeleteResult>;
  delete(request: SessionDeleteRequest): Promise<SessionDeleteResult>;
  rename(request: SessionRenameRequest): Promise<SessionRenameResult>;
  state(request: SessionStateRequest): Promise<SessionStateResult>;
  lease(request: SessionLeaseRequest): Promise<SessionLeaseResult>;
  stats(request: SessionStatsRequest): Promise<SessionStatsResult>;
  read(id: string, query: SessionReadQuery, perf?: ServerPerf): ReturnType<typeof read>;
  context(id: string, query: SessionHistoryQuery): ReturnType<typeof context>;
  describe(cwd: string): ReturnType<typeof describe>;
  list(query: SessionListQuery): ReturnType<typeof list>;
  search(query: string, signal: AbortSignal): ReturnType<typeof search>;
  running(): ReturnType<typeof running>;
}

async function describe(cwd: string) {
  const backend = await claudeBackend();
  const nativeConfiguration = await backend.getClaudeConfiguration(cwd);
  const configuration = claudeEnabled() ? nativeConfiguration : { ...nativeConfiguration, available: false, reason: "disabled" };
  const codex = await (await import("@/lib/agent-backends/codex/descriptor")).describeCodex({ cwd });
  return {
    defaultBackend: "pi" as const,
    backends: [
      { backend: "pi", available: true },
      { backend: "claude", available: configuration.available, configuration, capabilities: backend.CLAUDE_CAPABILITIES },
      { backend: "codex", available: codex.availability.state === "available", ...(codex.availability.state !== "available" ? { reason: codex.availability.reason } : {}), browsingAvailable: codex.capabilities.history, descriptor: codex, capabilities: codex.capabilities },
    ],
  };
}

type CodexCatalogue = Awaited<ReturnType<typeof readCodexCatalogue>>;
type CodexSearch = Awaited<ReturnType<typeof searchProjectedSessions>> & { error?: string; pending?: true };
type CodexSearchTask = {
  query: string;
  catalogue: CodexCatalogue;
  candidates: CodexCatalogue["sessions"];
  progress: ProjectedSearchProgress;
  promise: Promise<CodexSearch>;
  controller: AbortController;
  waiters: number;
  background: boolean;
  discarded?: boolean;
  completed?: { value: CodexSearch; at: number; expiry: ReturnType<typeof setTimeout>; claimedThrough?: number };
};
type CodexBrowseState = {
  membership?: string;
  catalogue?: { value: CodexCatalogue; at: number };
  scan?: { promise: Promise<CodexCatalogue>; timedOut: boolean };
  search?: CodexSearchTask;
  nextSearchId?: number;
  searchRequests?: Map<number, string>;
};

declare global {
  var __piCodexBrowseState: CodexBrowseState | undefined;
}

const codexBrowse = globalThis.__piCodexBrowseState ??= {};
const CODEX_BROWSE_BUDGET_MS = 400;
const CODEX_CATALOGUE_TTL_MS = 30_000;
const CODEX_SEARCH_RESULT_TTL_MS = 5_000;
const CODEX_SEARCH_LIFETIME_MS = 15_000;
const CODEX_BROWSE_ERROR = "Codex session history is unavailable";

function codexRuntimeSnapshot() {
  const sessions = getCodexSessionInfos();
  const membership = JSON.stringify(sessions.map(session => session.id).sort());
  if (membership !== (codexBrowse.membership ?? "[]")) invalidateSessionListCache();
  codexBrowse.membership = membership;
  const runningSessionIds: string[] = [];
  const awaitingInputSessionIds: string[] = [];
  for (const { id } of sessions) {
    const actor = getCodexSession(id);
    if (!actor) continue;
    const state = codexLeaseState(actor);
    if (state.running) runningSessionIds.push(id);
    if (state.awaitingInput) awaitingInputSessionIds.push(id);
  }
  return { sessions, runningSessionIds, awaitingInputSessionIds };
}

async function withinCodexBudget<T>(promise: Promise<T>, fallback: () => T, budgetMs = CODEX_BROWSE_BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback()), Math.max(0, budgetMs)); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function browseCodexCatalogue(force = false, budgetMs = CODEX_BROWSE_BUDGET_MS): Promise<CodexCatalogue> {
  if (!codexEnabled()) return { sessions: [] };
  let scan = codexBrowse.scan;
  if (!scan && !force && codexBrowse.catalogue && Date.now() - codexBrowse.catalogue.at < CODEX_CATALOGUE_TTL_MS) return codexBrowse.catalogue.value;
  if (!scan) {
    scan = { promise: Promise.resolve({ sessions: [] }), timedOut: false };
    const current = scan;
    current.promise = readCodexCatalogue().catch(() => ({ sessions: [], error: CODEX_BROWSE_ERROR })).then(value => {
      codexBrowse.catalogue = { value, at: Date.now() };
      if (current.timedOut) invalidateSessionListCache();
      return value;
    }).finally(() => { if (codexBrowse.scan === current) codexBrowse.scan = undefined; });
    codexBrowse.scan = current;
  }
  const current = scan;
  const result = await withinCodexBudget(current.promise, () => {
    current.timedOut = true;
    return { sessions: codexBrowse.catalogue?.value.sessions ?? [], error: CODEX_BROWSE_ERROR };
  }, budgetMs);
  return codexEnabled() ? result : { sessions: [] };
}

function clearCompletedCodexSearch(search: CodexSearchTask) {
  if (search.completed) clearTimeout(search.completed.expiry);
  if (codexBrowse.search === search) codexBrowse.search = undefined;
}

function sameCodexSearchCatalogue(search: CodexSearchTask, catalogue: CodexCatalogue) {
  if (search.catalogue.sessions === catalogue.sessions) return true;
  const candidates = catalogue.sessions.filter(session => session.relation?.kind !== "side");
  const ids = new Set(candidates.map(session => session.id));
  return candidates.length === search.candidates.length && ids.size === candidates.length && search.candidates.every(session => ids.has(session.id));
}

async function searchCodex(query: string, signal: AbortSignal, requestId: number): Promise<CodexSearch> {
  const empty: CodexSearch = { results: [], truncated: false };
  const incomplete: CodexSearch = { results: [], truncated: true, error: CODEX_BROWSE_ERROR };
  if (!codexEnabled()) {
    if (codexBrowse.search) codexBrowse.search.discarded = true;
    codexBrowse.search?.controller.abort();
    if (codexBrowse.search?.completed) clearCompletedCodexSearch(codexBrowse.search);
    return empty;
  }
  if (!query.trim() || signal.aborted) return empty;
  const deadline = Date.now() + CODEX_BROWSE_BUDGET_MS;
  const catalogue = await browseCodexCatalogue(false, deadline - Date.now());
  if (signal.aborted || !codexEnabled()) {
    if (!codexEnabled() && codexBrowse.search) {
      codexBrowse.search.discarded = true;
      codexBrowse.search.controller.abort();
    }
    return empty;
  }
  if (!catalogue.sessions.length) return { ...empty, error: catalogue.error, ...(catalogue.error && codexBrowse.scan ? { pending: true } : {}) };
  const currentSessions = new Map(catalogue.sessions.map(session => [session.id, session]));
  const rebind = (results: CodexSearch["results"]) => results.flatMap(hit => {
    const session = currentSessions.get(hit.session.id) ?? hit.session;
    if (!hit.titleMatch) return [{ ...hit, session }];
    const title = session.name || session.firstMessage || "";
    const index = title.toLowerCase().indexOf(query.toLowerCase());
    return index < 0 ? [] : [{ ...hit, session, before: title.slice(Math.max(0, index - 80), index), match: title.slice(index, index + query.length), after: title.slice(index + query.length, index + query.length + 80) }];
  });
  const withCatalogue = (value: CodexSearch): CodexSearch => ({
    ...value,
    results: rebind(value.results),
    ...(value.progress ? { progress: { ...value.progress, results: rebind(value.progress.results) } } : {}),
    error: value.error ?? catalogue.error,
    ...(catalogue.error && codexBrowse.scan ? { pending: true } : {}),
  });
  let progress: ProjectedSearchProgress | undefined;
  let candidates: CodexCatalogue["sessions"] | undefined;
  let search = codexBrowse.search;
  const sameCatalogue = search ? sameCodexSearchCatalogue(search, catalogue) : false;
  // A timed-out search owns one short-lived result for its query and catalogue.
  if (search?.completed) {
    const completed = search.completed;
    const fresh = Date.now() - completed.at < CODEX_SEARCH_RESULT_TTL_MS;
    if (fresh && search.query === query && sameCatalogue &&
        (completed.claimedThrough === undefined || requestId <= completed.claimedThrough)) {
      completed.claimedThrough ??= codexBrowse.nextSearchId;
      return withCatalogue(completed.value);
    }
    const claimedThrough = completed.claimedThrough;
    let awaitingSharedResult = false;
    if (fresh && claimedThrough !== undefined) {
      for (const [id, activeQuery] of codexBrowse.searchRequests ?? []) {
        if (id !== requestId && id <= claimedThrough && activeQuery === search.query) {
          awaitingSharedResult = true;
          break;
        }
      }
    }
    if (awaitingSharedResult) return { ...incomplete, pending: true };
    if (fresh && search.query === query && sameCatalogue) {
      progress = completed.value.progress ? { ...completed.value.progress, results: rebind(completed.value.progress.results) } : undefined;
      candidates = search.candidates.map(session => currentSessions.get(session.id) ?? session);
    }
    clearCompletedCodexSearch(search);
    search = undefined;
  }
  if (search && (search.query !== query || !sameCatalogue || search.controller.signal.aborted)) return { ...incomplete, pending: true };
  if (!search) {
    const controller = new AbortController();
    let historyFailed = false;
    const current: CodexSearchTask = {
      query, catalogue, controller, waiters: 0, background: false, promise: Promise.resolve(empty),
      candidates: candidates ?? catalogue.sessions.filter(session => session.relation?.kind !== "side").sort((a, b) => b.modified.localeCompare(a.modified)),
      progress: progress ?? { nextIndex: 0, results: [], truncated: false },
    };
    let lifetimeExpired = false;
    const lifetime = setTimeout(() => {
      if (!controller.signal.aborted) {
        lifetimeExpired = true;
        controller.abort();
      }
    }, CODEX_SEARCH_LIFETIME_MS);
    lifetime.unref();
    current.promise = searchProjectedSessions(current.candidates, query, controller.signal, async id => {
      try { return await readCodexHistory(id, 1000); }
      catch (error) { historyFailed = true; throw error; }
    }, current.progress).then(result => {
      if (historyFailed || lifetimeExpired) return { ...result, progress: undefined, error: CODEX_BROWSE_ERROR };
      return result.progress ? { ...result, error: CODEX_BROWSE_ERROR, pending: true as const } : result;
    })
      .catch(() => incomplete)
      .then(value => {
        if (current.background && (!controller.signal.aborted || lifetimeExpired) && !current.discarded && codexEnabled() && codexBrowse.search === current) {
          const expiry = setTimeout(() => clearCompletedCodexSearch(current), CODEX_SEARCH_RESULT_TTL_MS);
          expiry.unref();
          current.completed = { value, at: Date.now(), expiry };
        }
        return value;
      }).finally(() => {
        clearTimeout(lifetime);
        if (!current.completed && codexBrowse.search === current) codexBrowse.search = undefined;
      });
    codexBrowse.search = current;
    search = current;
  }
  const current = search;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  current.waiters++;
  try {
    const result = await Promise.race([
      current.promise,
      new Promise<CodexSearch>(resolve => {
        timer = setTimeout(() => { current.background = true; resolve({ ...incomplete, results: current.progress.results, pending: true }); }, Math.max(0, deadline - Date.now()));
      }),
      new Promise<CodexSearch>(resolve => {
        onAbort = () => resolve(empty);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    if (signal.aborted || !codexEnabled()) return empty;
    if (result === current.completed?.value) current.completed.claimedThrough ??= codexBrowse.nextSearchId;
    return withCatalogue(result);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    current.waiters--;
    // A timeout transfers ownership to the background; an abandoned live request does not.
    if (!codexEnabled()) current.discarded = true;
    if ((signal.aborted && current.waiters === 0 && !current.background) || !codexEnabled()) current.controller.abort();
  }
}

async function list({ force, summary }: SessionListQuery) {
  const persistedSessionsPromise = summary ? listSessionSummaries() : listAllSessions({ force });
  const codexRuntime = codexRuntimeSnapshot();
  // Capture before awaiting: mutations during the scan still require a later refresh.
  const sessionListVersion = getSessionListVersion();
  const [persistedSessions, runtimeSessions, claude, claudeRuntime, codex] = await Promise.all([
    persistedSessionsPromise,
    attachSessionProjectInfo(getRpcSessionInfos()),
    readClaudeCatalogue(),
    readClaudeRuntime(),
    browseCodexCatalogue(force),
  ]);
  const claudeSessions = await attachSessionProjectInfo(mergeSessionLists(claude.sessions, claudeRuntime.sessions));
  const codexSessions = await attachSessionProjectInfo(mergeSessionLists(codex.sessions, codexRuntime.sessions));
  return {
    sessions: mergeSessionLists(mergeSessionLists(withSubagentDisplayStatus(mergeSessionLists(persistedSessions, runtimeSessions)), claudeSessions), codexSessions),
    sessionListVersion,
    runningSessionIds: [...getRunningRpcSessionIds(), ...claudeRuntime.runningSessionIds, ...codexRuntime.runningSessionIds],
    awaitingInputSessionIds: [...getAwaitingInputRpcSessionIds(), ...claudeRuntime.awaitingInputSessionIds, ...codexRuntime.awaitingInputSessionIds],
    completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    ...(claude.error || codex.error ? { backendErrors: { ...(claude.error ? { claude: claude.error } : {}), ...(codex.error ? { codex: codex.error } : {}) } } : {}),
  };
}

async function search(query: string, signal: AbortSignal) {
  const requestId = codexBrowse.nextSearchId = (codexBrowse.nextSearchId ?? 0) + 1;
  const requests = codexBrowse.searchRequests ??= new Map();
  requests.set(requestId, query);
  try {
    // A stale catalogue keeps search off the expensive rebuild path; the next
    // search sees sessions added while that background rebuild was pending.
    const sessions = query && !signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    const searchable = sessions.filter((session) => session.relation?.kind !== "side");
    const [pi, claude, codex] = await Promise.all([
      searchSessionContents(searchable, query, signal),
      query && !signal.aborted
        ? readClaudeCatalogue().then(async ({ sessions, error }) => ({
            ...(await searchClaudeSessions(sessions, query, signal)),
            error,
          }))
        : Promise.resolve({ results: [], truncated: false, error: undefined }),
      searchCodex(query, signal, requestId),
    ]);
    const results = [...pi.results, ...claude.results, ...codex.results].sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    return {
      results: results.slice(0, 30),
      truncated: pi.truncated || claude.truncated || codex.truncated || results.length > 30,
      ...(codex.pending ? { pending: true } : {}),
      ...(claude.error || codex.error ? { backendErrors: { ...(claude.error ? { claude: claude.error } : {}), ...(codex.error ? { codex: codex.error } : {}) } } : {}),
    };
  } finally {
    requests.delete(requestId);
  }
}

async function running() {
  const claude = await readClaudeRuntime();
  const codex = codexRuntimeSnapshot();
  return {
    sessionListVersion: getSessionListVersion(),
    runningSessionIds: [...getRunningRpcSessionIds(), ...claude.runningSessionIds, ...codex.runningSessionIds],
    awaitingInputSessionIds: [...getAwaitingInputRpcSessionIds(), ...claude.awaitingInputSessionIds, ...codex.awaitingInputSessionIds],
    completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    subagentsActiveSessionIds: [...getSessionIdsWithUnsettledSubagentRuns(), ...claude.subagentsActiveSessionIds],
    sessionUiStateRevision: getSessionUiStateRevision(),
  };
}


function browsingIdentity(id: string) {
  const parsed = parseSessionKey(id);
  if (!parsed.ok) return { ok: false, kind: "invalid", reason: parsed.reason } as const;
  return { ok: true, backend: parsed.key.backend } as const;
}

function historyIdentity(id: string) {
  const parsed = browsingIdentity(id);
  if (!parsed.ok) return parsed;
  if (parsed.backend === "codex") return { ok: false, kind: "unsupported" } as const;
  return { ok: true, backend: parsed.backend } as const;
}

async function deleteBulk({ ids }: SessionBulkDeleteRequest): Promise<SessionBulkDeleteResult> {
  const piIds: string[] = [];
  const claudeIds: string[] = [];
  for (const id of ids) {
    const identity = historyIdentity(id);
    if (!identity.ok) return identity;
    (identity.backend === "claude" ? claudeIds : piIds).push(id);
  }
  if (claudeIds.length && !claudeEnabled()) return { ok: false, kind: "disabled" };

  const result = await deleteSessions(piIds, { keepRunning: true });
  if (claudeIds.length) {
    const backend = await claudeBackend();
    const deletedClaudeIds: string[] = [];
    for (const id of new Set(claudeIds)) {
      try {
        await backend.deleteClaudeSession(id);
        result.deleted.push(id);
        deletedClaudeIds.push(id);
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
        if (status === 409) result.running.push(id);
        else if (status === 404) result.missing.push(id);
        else throw error;
      }
    }
    await forgetSessionUiState(deletedClaudeIds);
    invalidateSessionListCache();
  }
  return { ok: true, value: result };
}

async function deleteSession({ id }: SessionDeleteRequest): Promise<SessionDeleteResult> {
  const identity = historyIdentity(id);
  if (!identity.ok) return identity;
  if (identity.backend === "claude") {
    const response = await claudeDelete(id);
    if (!response.ok) {
      const body = await response.json() as { error: string };
      return { ok: false, kind: "claude-error", status: response.status, error: body.error };
    }
    return { ok: true, value: { ok: true } };
  }
  const { missing } = await deleteSessions([id]);
  if (missing.length) return { ok: false, kind: "not-found" };
  return { ok: true, value: { ok: true } };
}

async function rename({ id, name }: SessionRenameRequest): Promise<SessionRenameResult> {
  const identity = historyIdentity(id);
  if (!identity.ok) return identity;
  const { backend } = identity;
  try {
    if (backend === "claude") {
      if (!claudeEnabled()) return { ok: false, kind: "disabled" };
      if (!name.trim()) return { ok: false, kind: "empty-name" };
      await (await claudeBackend()).renameClaudeSession(id, name.trim());
      invalidateSessionListCache();
    } else {
      const filePath = await resolveSessionPath(id);
      const trimmed = name.trim();
      const renamed = await renameRpcSession(id, trimmed, () => {
        if (!filePath) return false;
        const sm = openSessionManager(filePath, { mutable: true });
        sm.appendSessionInfo(trimmed);
        invalidateSessionManagerCache(filePath);
        invalidateSessionListCache();
        return true;
      });
      if (!renamed) return { ok: false, kind: "not-found" };
    }
    return { ok: true, value: { ok: true } };
  } catch (error) {
    return { ok: false, kind: "error", backend, error };
  }
}

async function state({ id, missingPi, includeSystemPrompt }: SessionStateRequest): Promise<SessionStateResult> {
  const identity = browsingIdentity(id);
  if (!identity.ok) return identity;
  const { backend } = identity;
  try {
    if (backend === "codex") {
      const actor = getCodexSession(id);
      if (actor?.state.kind === "ready") return { ok: true, value: { running: true, state: codexSessionState(actor) } };
      if (!(await import("@/lib/agent-backends/codex/descriptor")).codexEnabled()) return { ok: false, kind: "unsupported" };
      await readCodexHistory(id, 1);
      return { ok: true, value: { running: false, state: { backend: "codex", capabilities: CODEX_CAPABILITIES } } };
    }
    if (backend === "claude") {
      const claude = await claudeBackend();
      const session = claude.getClaudeSession(id);
      if (session?.isAlive()) return { ok: true, value: { running: true, state: await session.send({ type: "get_state" }) } };
      await claude.readClaudeSession(id);
      return { ok: true, value: { running: false, state: { backend: "claude", requiresProjectTrust: true, capabilities: claude.CLAUDE_CAPABILITIES } } };
    }
    const session = getRpcSession(id);
    if (session?.isAlive()) {
      const state = await session.send({ type: "get_state" }) as Record<string, unknown>;
      if (!includeSystemPrompt) delete state.systemPrompt;
      return { ok: true, value: { running: true, state } };
    }
    if (missingPi === "not-found" && !await resolveSessionPath(id)) return { ok: false, kind: "not-found" };
    return { ok: true, value: { running: false } };
  } catch (error) {
    return { ok: false, kind: "error", backend, error };
  }
}

async function lease({ id }: SessionLeaseRequest): Promise<SessionLeaseResult> {
  const identity = browsingIdentity(id);
  if (!identity.ok) return identity;
  if (identity.backend === "codex") {
    const actor = getCodexSession(id);
    const state = actor ? codexLeaseState(actor) : { alive: false, running: false, awaitingInput: false };
    return {
      ok: true,
      value: {
        success: true,
        running: state.running,
        awaitingInput: state.awaitingInput,
        subagentsActive: false,
      },
    };
  }
  const session = identity.backend === "claude"
    ? (await claudeBackend()).getClaudeSession(id)
    : getRpcSession(id);
  const alive = Boolean(session?.isAlive());
  // A wrapper from before a hot reload may lack this method.
  if (alive && typeof session!.renewIdleTimer === "function") session!.renewIdleTimer();
  return {
    ok: true,
    value: {
      success: true,
      running: alive && session!.isRunning(),
      awaitingInput: alive && session!.isAwaitingInput(),
      subagentsActive: identity.backend === "claude"
        ? Boolean(alive && session && "hasActiveSubagents" in session && session.hasActiveSubagents())
        : hasUnsettledSubagentRun(id),
    },
  };
}

function historyTail(value: number, backend: "pi" | "claude" | "codex") {
  return (backend === "claude" ? Number.isInteger(value) : Number.isFinite(value)) && value > 0
    ? Math.min(value, 1000) : 50;
}

async function readClaudeHistory(id: string, tail: number, before?: string) {
  const snapshot = await (await claudeBackend()).readClaudeSession(id, { tail, before });
  const info = (await attachSessionProjectInfo([snapshot.info]))[0];
  return { ...snapshot, info };
}

async function readCodexHistory(id: string, tail: number, before?: string) {
  const [{ codexEnabled }, { nativeCodexSessionId }, { readCodexThread, CodexCatalogueError }, { projectCodexHistory }] = await Promise.all([
    import("@/lib/agent-backends/codex/descriptor"), import("@/lib/agent-backends/codex/identity"),
    import("@/lib/agent-backends/codex/catalogue"), import("@/lib/agent-backends/codex/history"),
  ]);
  if (!codexEnabled()) throw new CodexCatalogueError("unavailable");
  const thread = await readCodexThread(nativeCodexSessionId(id));
  const snapshot = projectCodexHistory(thread, { tail, before });
  const info = (await attachSessionProjectInfo([snapshot.info]))[0];
  return { ...snapshot, info };
}

async function read(id: string, query: SessionReadQuery, perf?: ServerPerf) {
  const identity = browsingIdentity(id);
  if (!identity.ok) return identity;
  const { backend } = identity;
  const tail = historyTail(query.tail, backend);
  try {
    const value = backend === "pi"
      ? await readPiSession(id, { ...query, tail }, perf)
      : backend === "claude" ? await readClaudeHistory(id, tail, query.before) : await readCodexHistory(id, tail, query.before);
    if (!value) return { ok: false, kind: "not-found" } as const;
    return { ok: true, backend, value } as const;
  } catch (error) {
    return { ok: false, kind: "error", backend, error } as const;
  }
}

async function context(id: string, query: SessionHistoryQuery) {
  const identity = browsingIdentity(id);
  if (!identity.ok) return identity;
  const { backend } = identity;
  const tail = historyTail(query.tail, backend);
  try {
    const value = backend === "pi"
      ? await readPiContext(id, { ...query, tail })
      : { context: (backend === "claude" ? await readClaudeHistory(id, tail, query.before) : await readCodexHistory(id, tail, query.before)).context, tail, before: query.before ?? null };
    if (!value) return { ok: false, kind: "not-found" } as const;
    return { ok: true, backend, value } as const;
  } catch (error) {
    return { ok: false, kind: "error", backend, error } as const;
  }
}

type SessionManagerLike = ReturnType<typeof openSessionManager>;

interface CachedSummary {
  entryCount: number;
  lastEntryId: string | undefined;
  leafId: string | null;
  summary: SessionUsageSummary;
}

const summaries = new WeakMap<SessionManagerLike, CachedSummary>();

async function readSummary(id: string, backend: "pi" | "claude"): Promise<SessionUsageSummary | null> {
  if (backend === "claude") {
    const snapshot = await (await claudeBackend()).readClaudeSession(id);
    if (!snapshot.stats) return null;
    return {
      tokens: snapshot.stats.tokens, cost: snapshot.stats.cost,
      toolCalls: snapshot.stats.toolCalls, totalActiveMs: snapshot.totalActiveMs ?? 0,
      ...(snapshot.context.model ? { model: snapshot.context.model } : {}),
    };
  }
  const rpc = getRpcSession(id);
  let sm: SessionManagerLike;
  if (rpc?.isAlive()) {
    sm = rpc.inner.sessionManager as SessionManagerLike;
  } else {
    const path = await resolveSessionPath(id);
    if (!path) return null;
    sm = openSessionManager(path);
  }
  const entries = sm.getEntries();
  const lastEntryId = (entries[entries.length - 1] as { id?: string } | undefined)?.id;
  const leafId = sm.getLeafId();
  const cached = summaries.get(sm);
  if (cached && cached.entryCount === entries.length && cached.lastEntryId === lastEntryId && cached.leafId === leafId) return cached.summary;

  const ownEntries = sideOwnEntries(entries) as typeof entries;
  const stats = computeSessionStats(toSessionEntries(ownEntries));
  const summary: SessionUsageSummary = {
    tokens: stats.tokens,
    cost: stats.cost,
    toolCalls: stats.toolCalls,
    totalActiveMs: computeSessionTotalActiveMs(ownEntries),
    ...getSessionSettings(toSessionEntries(entries), leafId),
  };
  summaries.set(sm, { entryCount: entries.length, lastEntryId, leafId, summary });
  return summary;
}

async function stats({ ids }: SessionStatsRequest): Promise<SessionStatsResult> {
  const identified: { id: string; backend: "pi" | "claude" }[] = [];
  for (const id of new Set(ids)) {
    const identity = historyIdentity(id);
    if (!identity.ok) return identity;
    identified.push({ id, backend: identity.backend });
  }
  const result: Record<string, SessionUsageSummary> = {};
  for (const { id, backend } of identified) {
    try {
      const summary = await readSummary(id, backend);
      if (summary) result[id] = summary;
    } catch {
      // Malformed or concurrently removed session: leave it out.
    }
  }
  return { ok: true, value: { stats: result } };
}

export type SessionHistoryFailure = HistoryFailure;

export const sessions: SessionsService = { inventory, models, createRuntime, commandRuntime, runtimeEvents, handoff, autoName, bashOutput, describe, list, search, running, read, context, stats, lease, state, rename, delete: deleteSession, deleteBulk, fork, exportSession, thinking, toolResultImage, subagents };
