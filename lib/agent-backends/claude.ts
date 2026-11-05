import {
  deleteSession as sdkDeleteSession,
  forkSession as sdkForkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions as sdkListSessions,
  listSubagents,
  renameSession as sdkRenameSession,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AgentMessage, SessionInfo } from "../types";
import { readClaudeConfiguration } from "./claude-config";
import { extractText, projectClaudeHistoryMessage } from "./claude-projection";
import {
  abortClaudeSideFork,
  beginClaudeSideFork,
  claudeSidePolicy,
  completeClaudeSideFork,
  deleteClaudeWebMetadata,
  readClaudeWebMetadata,
  type ClaudeWebMetadataFile,
} from "./claude-metadata";
import {
  ClaudeConflictError,
  ClaudeSessionWrapper,
  type ClaudeSessionCreateOptions,
} from "./claude-runtime";
import {
  CLAUDE_CAPABILITIES,
  claudeWebSessionId,
  isNativeClaudeSessionId,
  nativeClaudeSessionId,
  type ClaudeConfigurationSummary,
  type ClaudeSessionInfo,
  type ClaudeSessionSnapshot,
} from "./types";

export type { ClaudeSessionCreateOptions } from "./claude-runtime";
export type {
  AgentBackend,
  AgentBackendCapabilities,
  AgentInteractionClosed,
  AgentInteractionQuestion,
  AgentInteractionRequest,
  AnswerInteractionCommand,
  ClaudeConfigurationSummary,
  ClaudeSessionInfo,
  ClaudeSessionSnapshot,
} from "./types";
export {
  CLAUDE_CAPABILITIES,
  claudeWebSessionId,
  getSessionBackend,
  isClaudeSessionId,
  nativeClaudeSessionId,
} from "./types";

interface ClaudeRegistry {
  sessions: Map<string, ClaudeSessionWrapper>;
  createRequests: Map<string, { sessionId: string; cwd: string }>;
  cleanupInstalled: boolean;
}

const REGISTRY_KEY = Symbol.for("pi-web.claude-backend.registry");
const MAX_CREATE_REQUESTS = 256;

type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: ClaudeRegistry };

function registry(): ClaudeRegistry {
  const root = globalThis as RegistryGlobal;
  root[REGISTRY_KEY] ??= {
    sessions: new Map(),
    createRequests: new Map(),
    cleanupInstalled: false,
  };
  return root[REGISTRY_KEY];
}

function installProcessCleanup(): void {
  const state = registry();
  if (state.cleanupInstalled) return;
  state.cleanupInstalled = true;
  const shutdown = () => {
    void closeAllClaudeSessions();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function iso(value: number | undefined, fallback: number): string {
  return new Date(value ?? fallback).toISOString();
}

function sessionInfo(
  source: SDKSessionInfo,
  metadata: ClaudeWebMetadataFile,
): ClaudeSessionInfo | null {
  if (!isNativeClaudeSessionId(source.sessionId) || !source.cwd) return null;
  const webId = claudeWebSessionId(source.sessionId);
  const modified = source.lastModified || Date.now();
  const sideParent = claudeSidePolicy(source.sessionId, source.cwd, metadata)?.parentSessionId;
  return {
    path: webId,
    id: webId,
    cwd: source.cwd,
    name: source.customTitle || source.summary || undefined,
    created: iso(source.createdAt, modified),
    modified: iso(modified, modified),
    messageCount: 0,
    firstMessage: source.firstPrompt || "",
    detailsPending: true,
    branch: source.gitBranch,
    transient: false,
    backend: "claude",
    nativeSessionId: source.sessionId.toLowerCase(),
    capabilities: CLAUDE_CAPABILITIES,
    ...(sideParent ? {
      parentSessionId: sideParent,
      relation: { kind: "side" as const, parentSessionId: sideParent },
    } : {}),
  };
}

function wrapperFor(nativeId: string, cwd: string, options: ClaudeSessionCreateOptions & { existing: boolean; side?: boolean }): ClaudeSessionWrapper {
  const webId = claudeWebSessionId(nativeId);
  const existing = registry().sessions.get(webId);
  if (existing?.isAlive()) {
    if (existing.cwd !== cwd || existing.isSideSession() !== (options.side === true)) {
      throw new ClaudeConflictError("Claude wrapper policy does not match persisted session metadata");
    }
    return existing;
  }
  if (existing) registry().sessions.delete(webId);
  installProcessCleanup();
  const wrapper = new ClaudeSessionWrapper(nativeId, cwd, options);
  registry().sessions.set(webId, wrapper);
  return wrapper;
}

export function createClaudeSession(cwd: string, options: ClaudeSessionCreateOptions = {}): ClaudeSessionWrapper {
  if (process.env.PI_WEB_CLAUDE === "0") throw new ClaudeConflictError("Claude runtime is disabled");
  if (!isAbsolute(cwd)) throw new Error("Claude session cwd must be absolute");
  if (!options.requestId || !isNativeClaudeSessionId(options.requestId)) throw new Error("Claude creation requestId must be a UUID");
  if (options.modelId) throw new Error("Claude model is resolved by native settings; modelId is not accepted at session creation");
  const requestId = options.requestId.toLowerCase();
  const priorRequest = registry().createRequests.get(requestId);
  if (priorRequest) {
    if (priorRequest.cwd !== cwd) throw new ClaudeConflictError("Claude creation requestId was already used for another cwd");
    const prior = registry().sessions.get(priorRequest.sessionId);
    if (prior?.isAlive()) return prior;
    if (prior) registry().sessions.delete(priorRequest.sessionId);
  }
  const nativeId = randomUUID();
  const wrapper = wrapperFor(nativeId, cwd, { ...options, requestId, existing: false });
  registry().createRequests.set(requestId, { sessionId: wrapper.sessionId, cwd });
  while (registry().createRequests.size > MAX_CREATE_REQUESTS) {
    const oldest = registry().createRequests.keys().next().value;
    if (!oldest) break;
    const evicted = registry().createRequests.get(oldest);
    registry().createRequests.delete(oldest);
    const stale = evicted ? registry().sessions.get(evicted.sessionId) : undefined;
    if (stale?.isProvisionalUnaccepted()) {
      registry().sessions.delete(stale.sessionId);
      void stale.close();
    }
  }
  return wrapper;
}

export async function discardRejectedClaudeCreation(webId: string, requestId: string): Promise<boolean> {
  nativeClaudeSessionId(webId);
  if (!isNativeClaudeSessionId(requestId)) throw new Error("Claude creation requestId must be a UUID");
  const normalizedRequestId = requestId.toLowerCase();
  const created = registry().createRequests.get(normalizedRequestId);
  if (!created || created.sessionId !== webId.toLowerCase()) return false;
  const wrapper = registry().sessions.get(webId.toLowerCase());
  if (!wrapper?.isProvisionalUnaccepted()) return false;
  registry().createRequests.delete(normalizedRequestId);
  registry().sessions.delete(webId.toLowerCase());
  await wrapper.close();
  await Promise.allSettled([
    sdkDeleteSession(nativeClaudeSessionId(webId), { dir: wrapper.cwd }),
    deleteClaudeWebMetadata(nativeClaudeSessionId(webId)),
  ]);
  return true;
}

export function getClaudeSession(webId: string): ClaudeSessionWrapper | undefined {
  nativeClaudeSessionId(webId);
  const wrapper = registry().sessions.get(webId.toLowerCase());
  if (wrapper && !wrapper.isAlive()) {
    registry().sessions.delete(webId.toLowerCase());
    return undefined;
  }
  return wrapper;
}

export async function ensureClaudeSession(webId: string): Promise<ClaudeSessionWrapper> {
  const nativeId = nativeClaudeSessionId(webId);
  const current = getClaudeSession(webId);
  if (current) {
    const metadata = await readClaudeWebMetadata();
    const side = claudeSidePolicy(nativeId, current.cwd, metadata) !== undefined;
    if (current.isSideSession() !== side) throw new ClaudeConflictError("Claude wrapper policy does not match persisted session metadata");
    return current;
  }
  const info = await getSessionInfo(nativeId);
  if (!info?.cwd) throw new Error("Claude session not found");
  const metadata = await readClaudeWebMetadata();
  const side = claudeSidePolicy(nativeId, info.cwd, metadata) !== undefined;
  return wrapperFor(nativeId, info.cwd, { existing: true, side });
}

export async function listClaudeSessions(): Promise<SessionInfo[]> {
  const listed = await sdkListSessions();
  const metadata = await readClaudeWebMetadata();
  const byId = new Map<string, ClaudeSessionInfo>();
  for (const source of listed) {
    const info = sessionInfo(source, metadata);
    if (info) byId.set(info.id, info);
  }
  for (const wrapper of registry().sessions.values()) {
    if (!byId.has(wrapper.sessionId)) byId.set(wrapper.sessionId, wrapper.getInfo());
  }
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

interface ReadClaudeSessionOptions {
  tail?: number;
  before?: string;
}

async function history(webId: string): Promise<{
  info: ClaudeSessionInfo;
  source: SessionMessage[];
  projected: ReturnType<typeof projectClaudeHistoryMessage>;
}> {
  const nativeId = nativeClaudeSessionId(webId);
  const nativeInfo = await getSessionInfo(nativeId);
  if (!nativeInfo?.cwd) throw new Error("Claude session not found");
  const metadata = await readClaudeWebMetadata();
  const info = sessionInfo(nativeInfo, metadata);
  if (!info) throw new Error("Claude session metadata is incomplete");
  const source = await getSessionMessages(nativeId, { dir: nativeInfo.cwd, includeSystemMessages: true });
  return { info, source, projected: source.flatMap(projectClaudeHistoryMessage) };
}

export async function readClaudeSession(
  webId: string,
  options: ReadClaudeSessionOptions = {},
): Promise<ClaudeSessionSnapshot> {
  const all = await history(webId);
  if (options.tail !== undefined && (!Number.isFinite(options.tail) || options.tail <= 0)) throw new Error("Invalid Claude history tail");
  const tail = options.tail === undefined ? 50 : Math.min(500, Math.floor(options.tail));
  let end = all.source.length;
  if (options.before !== undefined) {
    if (!isNativeClaudeSessionId(options.before)) throw new Error("Invalid Claude history cursor");
    const found = all.source.findIndex((message) => message.uuid === options.before);
    if (found < 0) throw new Error("Claude history cursor not found");
    end = found;
  }
  const start = Math.max(0, end - tail);
  const selectedIds = new Set(all.source.slice(start, end).map((message) => message.uuid));
  const selected = all.projected.filter((entry) => selectedIds.has(entry.entryId));
  const model = [...all.projected].reverse().find((entry) => entry.message.role === "assistant")?.message;
  const modelId = model?.role === "assistant" ? model.model : null;
  const leafId = all.source.at(-1)?.uuid ?? null;
  const subagents = await listSubagents(all.info.nativeSessionId, { dir: all.info.cwd });
  const firstVisible = all.projected[0]?.message;
  const info = {
    ...all.info,
    messageCount: all.projected.length,
    firstMessage: firstVisible ? extractText(firstVisible) : all.info.firstMessage,
    detailsPending: false,
  };
  return {
    sessionId: webId,
    filePath: null,
    info,
    leafId,
    tree: [],
    context: {
      messages: selected.map((entry) => entry.message),
      entryIds: selected.map((entry) => entry.entryId),
      oldestEntryId: selected[0]?.entryId ?? null,
      hasMore: start > 0,
      turnsBefore: all.source.slice(0, start).filter((message) => message.type === "user").length,
      thinkingLevel: "native",
      model: modelId ? { provider: "claude", modelId } : null,
    },
    snapshotRevision: [all.info.modified, all.source.length, leafId ?? "empty"].join(":"),
    capabilities: CLAUDE_CAPABILITIES,
    ...(subagents.length ? { subagents: subagents.map((id) => ({ id })) } : {}),
  };
}

export async function getClaudeDisplayMessages(webId: string): Promise<AgentMessage[]> {
  const all = await history(webId);
  return all.projected.map((entry) => entry.message);
}

export async function forkClaudeSession(
  webId: string,
  options: { entryId?: string; side?: boolean; name?: string } = {},
): Promise<SessionInfo> {
  const nativeId = nativeClaudeSessionId(webId);
  if (options.entryId && !isNativeClaudeSessionId(options.entryId)) throw new Error("Invalid Claude fork entry id");
  const sourceWrapper = await ensureClaudeSession(webId);
  return sourceWrapper.withExclusiveMutation(async () => {
    let operationId: string | undefined;
    let forkAttempted = false;
    let policyCompleted = false;
    let result: Awaited<ReturnType<typeof sdkForkSession>> | undefined;
    try {
      if (options.side) {
        const baseline = await sdkListSessions({ dir: sourceWrapper.cwd });
        operationId = await beginClaudeSideFork(webId, sourceWrapper.cwd, baseline.map((session) => session.sessionId));
      }
      forkAttempted = true;
      result = await sdkForkSession(nativeId, {
        dir: sourceWrapper.cwd,
        ...(options.entryId ? { upToMessageId: options.entryId } : {}),
        ...(options.name ? { title: options.name } : {}),
      });
      if (operationId) {
        await completeClaudeSideFork(operationId, result.sessionId);
        policyCompleted = true;
      }
      const [nativeInfo, metadata] = await Promise.all([
        getSessionInfo(result.sessionId, { dir: sourceWrapper.cwd }),
        readClaudeWebMetadata(),
      ]);
      if (!nativeInfo?.cwd) throw new Error("Claude fork metadata is unavailable");
      const info = sessionInfo(nativeInfo, metadata);
      if (!info) throw new Error("Claude fork metadata is incomplete");
      wrapperFor(result.sessionId, nativeInfo.cwd, { existing: true, side: options.side });
      return info;
    } catch (error) {
      let deleted = false;
      if (result) {
        try {
          await sdkDeleteSession(result.sessionId, { dir: sourceWrapper.cwd });
          deleted = true;
          await deleteClaudeWebMetadata(result.sessionId).catch(() => undefined);
        } catch {
          deleted = false;
        }
      }
      if (operationId && !policyCompleted && (!forkAttempted || deleted)) {
        await abortClaudeSideFork(operationId).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function renameClaudeSession(webId: string, name: string): Promise<void> {
  const nativeId = nativeClaudeSessionId(webId);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Claude session name is required");
  const wrapper = await ensureClaudeSession(webId);
  await wrapper.withExclusiveMutation(() => sdkRenameSession(nativeId, trimmed, { dir: wrapper.cwd }));
}

export async function deleteClaudeSession(webId: string): Promise<void> {
  const nativeId = nativeClaudeSessionId(webId);
  const wrapper = await ensureClaudeSession(webId);
  await wrapper.withExclusiveMutation(async () => {
    await wrapper.close();
    try {
      await sdkDeleteSession(nativeId, { dir: wrapper.cwd });
    } catch (error) {
      registry().sessions.delete(webId.toLowerCase());
      throw error;
    }
    registry().sessions.delete(webId.toLowerCase());
    await deleteClaudeWebMetadata(nativeId).catch(() => undefined);
    for (const [requestId, created] of registry().createRequests) {
      if (created.sessionId === webId.toLowerCase()) registry().createRequests.delete(requestId);
    }
  });
}

export function getClaudeRuntimeSnapshot(): {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  awaitingInputSessionIds: string[];
  subagentsActiveSessionIds: string[];
} {
  const wrappers = [...registry().sessions.values()].filter((wrapper) => wrapper.isAlive());
  return {
    sessions: wrappers.map((wrapper) => wrapper.getInfo()),
    runningSessionIds: wrappers.filter((wrapper) => wrapper.isRunning()).map((wrapper) => wrapper.sessionId),
    awaitingInputSessionIds: wrappers.filter((wrapper) => wrapper.isAwaitingInput()).map((wrapper) => wrapper.sessionId),
    subagentsActiveSessionIds: wrappers.filter((wrapper) => wrapper.hasActiveSubagents()).map((wrapper) => wrapper.sessionId),
  };
}

export function getClaudeConfiguration(cwd: string): Promise<ClaudeConfigurationSummary> {
  return readClaudeConfiguration(cwd);
}

export async function closeAllClaudeSessions(): Promise<void> {
  const sessions = [...registry().sessions.values()];
  await Promise.allSettled(sessions.map((session) => session.close()));
  registry().sessions.clear();
}
