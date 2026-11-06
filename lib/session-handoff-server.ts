import { claudeBackend, claudeEnabled, readClaudeCatalogue, readClaudeRuntime } from "./agent-catalog";
import { getSessionBackend, type AgentBackend } from "./agent-backends/types";
import { allowFileRoot } from "./file-access";
import { deleteSessions } from "./session-delete";
import { serializeByKey } from "./key-serializer";
import { getRpcSession, getRpcSessionInfos, startRpcSession } from "./rpc-manager";
import {
  attachSessionProjectInfo,
  buildSessionContext,
  listAllSessions,
  openSessionManager,
  readSessionInfo,
  resolveSessionPath,
} from "./session-reader";
import { buildSessionHandoff } from "./session-handoff";
import type { AgentMessage, SessionEntry, SessionInfo } from "./types";

const HANDOFF_SERIALIZER = Symbol.for("pi-web.session-handoff.serializer");
const HANDOFF_RESULTS = Symbol.for("pi-web.session-handoff.results");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REMEMBERED_RESULTS = 100;

type HandoffResultStore = Map<string, SessionInfo>;
type HandoffStoreGlobal = typeof globalThis & { [HANDOFF_RESULTS]?: HandoffResultStore };

export interface SessionHandoffRequest {
  targetBackend: AgentBackend;
  requestId: string;
  trustProject: boolean;
}

export interface SessionHandoffResult {
  session: SessionInfo;
  transfer: {
    sourceSessionId: string;
    sourceEntryId: string | null;
    transferredMessages: number;
    omittedMessages: number;
    truncated: boolean;
  };
}

type SourceSnapshot = {
  backend: AgentBackend;
  info: SessionInfo;
  leafId: string | null;
  messages: AgentMessage[];
};

export class SessionHandoffError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSessionHandoffRequest(value: unknown): SessionHandoffRequest | null {
  if (!isRecord(value)
    || (value.targetBackend !== "pi" && value.targetBackend !== "claude")
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || (value.trustProject !== undefined && typeof value.trustProject !== "boolean")) return null;
  return {
    targetBackend: value.targetBackend,
    requestId: value.requestId.toLowerCase(),
    trustProject: value.trustProject === true,
  };
}

function resultStore(): HandoffResultStore {
  const root = globalThis as HandoffStoreGlobal;
  return root[HANDOFF_RESULTS] ??= new Map();
}

function rememberResult(requestId: string, session: SessionInfo): void {
  const store = resultStore();
  store.set(requestId, session);
  while (store.size > MAX_REMEMBERED_RESULTS) {
    const oldest = store.keys().next().value;
    if (typeof oldest !== "string") break;
    store.delete(oldest);
  }
}

function sourceTitle(info: SessionInfo): string {
  return info.name?.trim() || info.firstMessage.trim() || info.id;
}

function assertTransferableSource(info: SessionInfo): void {
  if (info.relation?.kind === "side" || info.relation?.kind === "subagent") {
    throw new SessionHandoffError("Only main sessions can be continued in another backend", 409);
  }
}

async function readPiSource(sessionId: string): Promise<SourceSnapshot> {
  const live = getRpcSession(sessionId);
  if (live?.isRunning()) throw new SessionHandoffError("Wait for the source session to finish before continuing it", 409);
  const filePath = await resolveSessionPath(sessionId);
  const manager = live?.inner?.sessionManager ?? (filePath ? openSessionManager(filePath) : null);
  if (!manager) throw new SessionHandoffError("Source session not found", 404);
  const entries = manager.getEntries() as unknown as SessionEntry[];
  const leafId = manager.getLeafId();
  const liveInfo = getRpcSessionInfos({ includeTransient: true }).find((session) => session.id === sessionId);
  const info = liveInfo ?? (filePath ? await readSessionInfo(filePath) : null);
  if (!info) throw new SessionHandoffError("Source session metadata is unavailable", 404);
  assertTransferableSource(info);
  const context = buildSessionContext(entries, leafId, {
    tail: 100,
    deferThinking: true,
    deferToolResultImages: true,
    sessionId,
  });
  return { backend: "pi", info, leafId, messages: context.messages };
}

async function readClaudeSource(sessionId: string): Promise<SourceSnapshot> {
  if (!claudeEnabled()) throw new SessionHandoffError("Claude runtime is unavailable", 409);
  const backend = await claudeBackend();
  if (backend.getClaudeSession(sessionId)?.isRunning()) {
    throw new SessionHandoffError("Wait for the source session to finish before continuing it", 409);
  }
  try {
    const snapshot = await backend.readClaudeSession(sessionId, { tail: 100 });
    assertTransferableSource(snapshot.info);
    return { backend: "claude", info: snapshot.info, leafId: snapshot.leafId, messages: snapshot.context.messages };
  } catch (error) {
    if (error instanceof SessionHandoffError) throw error;
    if (error instanceof Error && /not found/i.test(error.message)) throw new SessionHandoffError("Source session not found", 404);
    throw error;
  }
}

async function readSource(sessionId: string): Promise<SourceSnapshot> {
  return getSessionBackend(sessionId) === "claude" ? readClaudeSource(sessionId) : readPiSource(sessionId);
}

function matchesRequest(session: SessionInfo, sourceSessionId: string, targetBackend: AgentBackend, requestId: string): boolean {
  const relation = session.relation;
  return getSessionBackend(session.id) === targetBackend
    && relation?.kind === "handoff"
    && relation.requestId === requestId
    && relation.sourceSessionId === sourceSessionId;
}

export function resolveExistingHandoffTarget(
  sessions: readonly SessionInfo[],
  sourceSessionId: string,
  targetBackend: AgentBackend,
  requestId: string,
): SessionInfo | null {
  const sameId = sessions.find((session) => session.relation?.kind === "handoff" && session.relation.requestId === requestId);
  if (!sameId) return null;
  if (!matchesRequest(sameId, sourceSessionId, targetBackend, requestId)) {
    throw new SessionHandoffError("Handoff requestId was already used for another transfer", 409);
  }
  return sameId;
}

async function findExistingTarget(sourceSessionId: string, targetBackend: AgentBackend, requestId: string): Promise<SessionInfo | null> {
  const remembered = resultStore().get(requestId);
  if (remembered) {
    if (!matchesRequest(remembered, sourceSessionId, targetBackend, requestId)) {
      throw new SessionHandoffError("Handoff requestId was already used for another transfer", 409);
    }
    return remembered;
  }

  const live = targetBackend === "claude"
    ? (await readClaudeRuntime()).sessions
    : getRpcSessionInfos({ includeTransient: true });
  let persisted: SessionInfo[];
  if (targetBackend === "claude") {
    const catalogue = await readClaudeCatalogue();
    const liveMatch = resolveExistingHandoffTarget(live, sourceSessionId, targetBackend, requestId);
    if (liveMatch) {
      rememberResult(requestId, liveMatch);
      return liveMatch;
    }
    if (catalogue.error) throw new SessionHandoffError(catalogue.error, 503);
    persisted = catalogue.sessions;
  } else {
    persisted = await listAllSessions({ force: true });
  }
  const existing = resolveExistingHandoffTarget([...live, ...persisted], sourceSessionId, targetBackend, requestId);
  if (existing) rememberResult(requestId, existing);
  return existing;
}

async function createPiTarget(source: SourceSnapshot, built: ReturnType<typeof buildSessionHandoff>, requestId: string): Promise<SessionInfo> {
  const temporaryId = "__handoff__" + requestId;
  const started = await startRpcSession(temporaryId, "", source.info.cwd);
  try {
    await started.session.send({ type: "prompt", message: built.prompt });
  } catch (error) {
    await started.session.shutdown().catch(() => undefined);
    await deleteSessions([started.realSessionId]).catch(() => undefined);
    throw error;
  }
  const now = new Date().toISOString();
  const live = getRpcSessionInfos({ includeTransient: true }).find((session) => session.id === started.realSessionId);
  const info: SessionInfo = {
    path: live?.path ?? started.session.sessionFile ?? "",
    id: started.realSessionId,
    cwd: source.info.cwd,
    created: live?.created ?? now,
    modified: live?.modified ?? now,
    messageCount: live?.messageCount ?? 1,
    firstMessage: built.title,
    ...live,
    relation: built.relation,
    backend: "pi",
  };
  return (await attachSessionProjectInfo([info]))[0];
}

async function createClaudeTarget(source: SourceSnapshot, built: ReturnType<typeof buildSessionHandoff>, request: SessionHandoffRequest): Promise<SessionInfo> {
  if (!claudeEnabled()) throw new SessionHandoffError("Claude runtime is unavailable", 409);
  if (!request.trustProject) throw new SessionHandoffError("Project trust is required before creating a Claude handoff", 409);
  const backend = await claudeBackend();
  const wrapper = backend.createClaudeSession(source.info.cwd, {
    requestId: request.requestId,
    trustProject: true,
    handoff: built.relation,
    handoffTitle: built.title,
  });
  try {
    await backend.recordClaudeHandoff(wrapper.nativeSessionId, {
      sourceSessionId: built.relation.sourceSessionId,
      sourceBackend: built.relation.sourceBackend,
      ...(built.relation.sourceEntryId ? { sourceEntryId: built.relation.sourceEntryId } : {}),
      requestId: built.relation.requestId,
      title: built.title,
    });
    await wrapper.send({
      type: "prompt",
      requestId: request.requestId,
      message: built.prompt,
      trustProject: true,
    });
  } catch (error) {
    await backend.discardRejectedClaudeCreation(wrapper.sessionId, request.requestId).catch(() => undefined);
    throw error;
  }
  return (await attachSessionProjectInfo([{ ...wrapper.getInfo(), firstMessage: built.title, relation: built.relation }]))[0];
}

export async function createSessionHandoff(sourceSessionId: string, request: SessionHandoffRequest): Promise<SessionHandoffResult> {
  return serializeByKey(HANDOFF_SERIALIZER, request.requestId, async () => {
    const sourceBackend = getSessionBackend(sourceSessionId);
    if (sourceBackend === request.targetBackend) {
      throw new SessionHandoffError("Target backend must be different from the source backend", 400);
    }
    const existing = await findExistingTarget(sourceSessionId, request.targetBackend, request.requestId);
    if (existing) {
      return {
        session: existing,
        transfer: {
          sourceSessionId,
          sourceEntryId: existing.relation?.kind === "handoff" ? existing.relation.sourceEntryId ?? null : null,
          transferredMessages: 0,
          omittedMessages: 0,
          truncated: false,
        },
      };
    }

    const source = await readSource(sourceSessionId);
    let built: ReturnType<typeof buildSessionHandoff>;
    try {
      built = buildSessionHandoff({
        requestId: request.requestId,
        sourceSessionId,
        sourceBackend: source.backend,
        sourceEntryId: source.leafId,
        sourceTitle: sourceTitle(source.info),
        targetBackend: request.targetBackend,
        messages: source.messages,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SessionHandoffError(message, 409);
    }
    allowFileRoot(source.info.cwd);
    const target = request.targetBackend === "claude"
      ? await createClaudeTarget(source, built, request)
      : await createPiTarget(source, built, request.requestId);
    rememberResult(request.requestId, target);
    return {
      session: target,
      transfer: {
        sourceSessionId,
        sourceEntryId: source.leafId,
        transferredMessages: built.transferredMessages,
        omittedMessages: built.omittedMessages,
        truncated: built.truncated,
      },
    };
  });
}
