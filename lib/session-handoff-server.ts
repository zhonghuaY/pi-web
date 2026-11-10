import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBackend, claudeEnabled, readClaudeCatalogue, readClaudeRuntime, readCodexCatalogue } from "./agent-catalog";
import { isBackendId, isHandoffEdge, parseSessionKey, type BackendId } from "./session-identity";
import { allowFileRoot } from "./file-access";
import { getRpcSession, getRpcSessionInfos, PiHandoffCaptureError, startRpcSession, withPiHandoffSnapshot } from "./rpc-manager";
import {
  attachSessionProjectInfo,
  buildSessionContext,
  getSessionEntries,
  listAllSessions,
  readSessionInfo,
  resolveSessionPath,
} from "./session-reader";
import { withHandoffRecord, type HandoffRecord } from "./session-handoff-store";
import { buildSessionHandoff, sessionHandoffRelation } from "./session-handoff";
import { CodexHandoffCaptureError, codexSessionInfo, createCodexHandoffSession, getCodexSessionInfos, parseCodexRequestId, promptCodexHandoffSession, withCodexHandoffSnapshot, type Result } from "./agent-backends/codex";
import { codexEnabled } from "./agent-backends/codex/descriptor";
import { readCodexThread } from "./agent-backends/codex/catalogue";
import type { CodexThread } from "./agent-backends/codex/catalogue";
import { projectCodexHandoffMessages, projectCodexHistory } from "./agent-backends/codex/history";
import { nativeCodexSessionId } from "./agent-backends/codex/identity";
import { codexUserEnvelopeEquals, codexUserText } from "./agent-backends/codex/user-envelope";
import type { AgentMessage, SessionInfo } from "./types";

const HANDOFF_RESULTS = Symbol.for("pi-web.session-handoff.results");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REMEMBERED_RESULTS = 100;

type HandoffResultStore = Map<string, SessionInfo>;
type HandoffStoreGlobal = typeof globalThis & { [HANDOFF_RESULTS]?: HandoffResultStore };

export interface SessionHandoffRequest {
  targetBackend: BackendId;
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
  backend: BackendId;
  info: SessionInfo;
  leafId: string | null;
  revision?: string;
  messages: AgentMessage[];
};

export class SessionHandoffError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string, readonly operationId?: string) {
    super(message);
  }
}

function parseHandoffIdentity(id: string) {
  const result = parseSessionKey(id);
  if (!result.ok) throw new SessionHandoffError("Invalid session id", 400, result.reason);
  return result.key;
}

function handoffBackend(id: string): BackendId {
  return parseHandoffIdentity(id).backend;
}

function admitHandoffEdge(source: BackendId, target: BackendId): { sourceBackend: BackendId; targetBackend: BackendId } {
  if (!isHandoffEdge(source, target)) {
    throw new SessionHandoffError("Target backend must be different from the source backend", 400);
  }
  if ((source === "codex" || target === "codex") && !codexEnabled()) {
    throw new SessionHandoffError("Codex sessions are not available", 409, "backend-unavailable");
  }
  return { sourceBackend: source, targetBackend: target };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSessionHandoffRequest(value: unknown): SessionHandoffRequest | null {
  if (!isRecord(value)
    || !isBackendId(value.targetBackend)
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

async function readPiSource(sessionId: string, afterCapture?: () => void | Promise<void>): Promise<SourceSnapshot> {
  try {
    return await withPiHandoffSnapshot(sessionId, async () => {
      const live = getRpcSession(sessionId);
      const filePath = await resolveSessionPath(sessionId);
      if (!filePath) throw new SessionHandoffError("Source session not found", 404);
      const bytes = await readFile(filePath);
      const directory = await mkdtemp(join(tmpdir(), "pi-web-handoff-"));
      try {
        const copy = join(directory, "source.jsonl");
        await writeFile(copy, bytes, { mode: 0o600 });
        const entries = getSessionEntries(copy);
        const contextLeafId = live ? live.inner.sessionManager.getLeafId() : entries.at(-1)?.id ?? null;
        const header: unknown = JSON.parse(bytes.toString("utf8").split(/\r?\n/, 1)[0]);
        const legacyWithoutEntryIds = !live && isRecord(header) && header.type === "session"
          && (header.version === undefined || (typeof header.version === "number" && header.version < 2));
        // SDK v1 migration invents random entry IDs (pi-coding-agent/dist/core/session-manager.js:31-43).
        const leafId = legacyWithoutEntryIds && contextLeafId
          ? "legacy-" + createHash("sha256").update(bytes).digest("hex")
          : contextLeafId;
        if (contextLeafId && !entries.some((entry) => entry.id === contextLeafId)) {
          throw new SessionHandoffError("Source tip is not present in the saved session", 409);
        }
        const liveInfo = getRpcSessionInfos({ includeTransient: true }).find((session) => session.id === sessionId);
        const info = liveInfo ?? await readSessionInfo(filePath);
        if (!info) throw new SessionHandoffError("Source session metadata is unavailable", 404);
        assertTransferableSource(info);
        const context = buildSessionContext(entries, contextLeafId, {
          tail: 100,
          deferThinking: true,
          deferToolResultImages: true,
          sessionId,
        });
        await afterCapture?.();
        if (!bytes.equals(await readFile(filePath))) {
          throw new SessionHandoffError("Source session changed during capture", 409, "source-changed");
        }
        return { backend: "pi", info, leafId, messages: context.messages };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (error instanceof PiHandoffCaptureError) throw new SessionHandoffError(error.message, 409, error.reason);
    throw error;
  }
}

async function readClaudeSource(sessionId: string): Promise<SourceSnapshot> {
  if (!claudeEnabled()) throw new SessionHandoffError("Claude runtime is unavailable", 409);
  const backend = await claudeBackend();
  if (backend.getClaudeSession(sessionId)?.isRunning()) {
    throw new SessionHandoffError("Wait for the source session to finish before continuing it", 409);
  }
  try {
    const owner = await backend.ensureClaudeSession(sessionId);
    return await owner.withExclusiveMutation(async () => {
      const snapshot = await backend.readClaudeSession(sessionId, { tail: 100 });
      assertTransferableSource(snapshot.info);
      const verified = await backend.readClaudeSession(sessionId, { tail: 1 });
      if (snapshot.snapshotRevision !== verified.snapshotRevision) {
        throw new SessionHandoffError("Source session changed during capture", 409, "source-changed");
      }
      return { backend: "claude", info: snapshot.info, leafId: snapshot.leafId, messages: snapshot.context.messages };
    });
  } catch (error) {
    if (error instanceof SessionHandoffError) throw error;
    if (error instanceof Error && "status" in error && error.status === 409) throw new SessionHandoffError(error.message, 409);
    if (error instanceof Error && /not found/i.test(error.message)) throw new SessionHandoffError("Source session not found", 404);
    throw error;
  }
}

function assertTransferableCodexThread(thread: CodexThread): void {
  if (thread.parentThreadId || (isRecord(thread.source) && "subAgent" in thread.source)) {
    throw new SessionHandoffError("Only main sessions can be continued in another backend", 409, "not-main-session");
  }
  if (!isRecord(thread.status) || !["idle", "notLoaded"].includes(String(thread.status.type))
    || thread.turns.some(turn => turn.status === "inProgress")) {
    throw new SessionHandoffError("Wait for the source session to finish before continuing it", 409, "source-busy");
  }
}

async function readCodexSource(sessionId: string, afterCapture?: () => void | Promise<void>): Promise<SourceSnapshot> {
  if (!codexEnabled()) throw new SessionHandoffError("Codex runtime is unavailable", 409, "backend-unavailable");
  try {
    return await withCodexHandoffSnapshot(sessionId, async () => {
      const nativeId = nativeCodexSessionId(sessionId);
      const thread = await readCodexThread(nativeId);
      assertTransferableCodexThread(thread);
      const snapshot = projectCodexHistory(thread, { tail: 100 });
      assertTransferableSource(snapshot.info);
      await afterCapture?.();
      const verifiedThread = await readCodexThread(nativeId);
      assertTransferableCodexThread(verifiedThread);
      const verified = projectCodexHistory(verifiedThread, { tail: 1 });
      if (snapshot.snapshotRevision !== verified.snapshotRevision) {
        throw new SessionHandoffError("Source session changed during capture", 409, "source-changed");
      }
      return {
        backend: "codex",
        info: snapshot.info,
        leafId: snapshot.leafId,
        revision: snapshot.snapshotRevision,
        messages: projectCodexHandoffMessages(thread).slice(-100),
      };
    });
  } catch (error) {
    if (error instanceof SessionHandoffError) throw error;
    if (error instanceof CodexHandoffCaptureError) {
      throw new SessionHandoffError(error.message, 409, error.reason === "source-changed" ? "source-changed" : "source-busy");
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === -32600) {
      throw new SessionHandoffError("Source session not found", 404);
    }
    throw new SessionHandoffError("Codex session history is unavailable", 503, "backend-unavailable");
  }
}

async function readSource(sessionId: string, afterCapture?: () => void | Promise<void>): Promise<SourceSnapshot> {
  switch (handoffBackend(sessionId)) {
    case "pi": return readPiSource(sessionId, afterCapture);
    case "claude": return readClaudeSource(sessionId);
    case "codex": return readCodexSource(sessionId, afterCapture);
  }
}

function matchesRequest(session: SessionInfo, sourceSessionId: string, targetBackend: BackendId, requestId: string): boolean {
  const relation = session.relation;
  return handoffBackend(session.id) === targetBackend
    && relation?.kind === "handoff"
    && relation.requestId === requestId
    && relation.sourceSessionId === sourceSessionId;
}

export function resolveExistingHandoffTarget(
  sessions: readonly SessionInfo[],
  sourceSessionId: string,
  targetBackend: BackendId,
  requestId: string,
): SessionInfo | null {
  const sameId = sessions.find((session) => session.relation?.kind === "handoff" && session.relation.requestId === requestId);
  if (!sameId) return null;
  if (!matchesRequest(sameId, sourceSessionId, targetBackend, requestId)) {
    throw new SessionHandoffError("Handoff requestId was already used for another transfer", 409);
  }
  return sameId;
}

async function findExistingTarget(sourceSessionId: string, targetBackend: BackendId, requestId: string): Promise<SessionInfo | null> {
  const remembered = resultStore().get(requestId);
  if (remembered) {
    if (!matchesRequest(remembered, sourceSessionId, targetBackend, requestId)) {
      throw new SessionHandoffError("Handoff requestId was already used for another transfer", 409);
    }
    return remembered;
  }

  let live: SessionInfo[];
  let persisted: SessionInfo[];
  if (targetBackend === "claude") {
    live = (await readClaudeRuntime()).sessions;
    const catalogue = await readClaudeCatalogue();
    const liveMatch = resolveExistingHandoffTarget(live, sourceSessionId, targetBackend, requestId);
    if (liveMatch) {
      rememberResult(requestId, liveMatch);
      return liveMatch;
    }
    if (catalogue.error) throw new SessionHandoffError(catalogue.error, 503);
    persisted = catalogue.sessions;
  } else if (targetBackend === "codex") {
    live = getCodexSessionInfos();
    const catalogue = await readCodexCatalogue();
    const liveMatch = resolveExistingHandoffTarget(live, sourceSessionId, targetBackend, requestId);
    if (liveMatch) {
      rememberResult(requestId, liveMatch);
      return liveMatch;
    }
    if (catalogue.error) throw new SessionHandoffError(catalogue.error, 503);
    persisted = catalogue.sessions;
  } else {
    live = getRpcSessionInfos({ includeTransient: true });
    persisted = await listAllSessions({ force: true });
  }
  const existing = resolveExistingHandoffTarget([...live, ...persisted], sourceSessionId, targetBackend, requestId);
  if (existing) rememberResult(requestId, existing);
  return existing;
}

async function createPiTarget(source: SourceSnapshot, built: ReturnType<typeof buildSessionHandoff>, requestId: string) {
  const started = await startRpcSession("__handoff__" + requestId, "", source.info.cwd);
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
  return {
    info: (await attachSessionProjectInfo([info]))[0],
    send: () => started.session.send({ type: "prompt", message: built.prompt }),
  };
}

async function createClaudeTarget(source: SourceSnapshot, built: ReturnType<typeof buildSessionHandoff>, request: SessionHandoffRequest) {
  const backend = await claudeBackend();
  const wrapper = backend.createClaudeSession(source.info.cwd, {
    requestId: request.requestId,
    trustProject: true,
    handoff: built.relation,
    handoffTitle: built.title,
  });
  return {
    info: (await attachSessionProjectInfo([{ ...wrapper.getInfo(), firstMessage: built.title, relation: built.relation }]))[0],
    send: async () => {
      await backend.recordClaudeHandoff(wrapper.nativeSessionId, {
        sourceSessionId: built.relation.sourceSessionId,
        sourceBackend: source.backend,
        ...(built.relation.sourceEntryId ? { sourceEntryId: built.relation.sourceEntryId } : {}),
        requestId: built.relation.requestId,
        title: built.title,
      });
      return wrapper.send({ type: "prompt", requestId: request.requestId, message: built.prompt, trustProject: true });
    },
  };
}

async function createCodexTarget(source: SourceSnapshot, built: ReturnType<typeof buildSessionHandoff>, request: SessionHandoffRequest) {
  const requestId = parseCodexRequestId(request.requestId);
  if (!requestId) throw new SessionHandoffError("Invalid Codex handoff request id", 400);
  const created = await createCodexHandoffSession({ cwd: source.info.cwd, requestId });
  const actor = codexValue(created);
  const info = (await attachSessionProjectInfo([{
    ...codexSessionInfo(actor),
    firstMessage: built.title,
    relation: built.relation,
  }]))[0];
  return {
    info,
    send: async () => codexValue(await promptCodexHandoffSession(actor, { requestId, message: built.prompt })),
  };
}

function codexValue<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const failure = result.error;
  if (failure.kind === "outcome-unknown") throw new Error("Codex operation outcome is unknown");
  throw new Error(failure.message);
}

function handoffText(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "user") return null;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content) || value.content.length !== 1) return null;
  const part: unknown = value.content[0];
  return isRecord(part) && part.type === "text" && typeof part.text === "string"
    && Object.keys(part).every(key => key === "type" || key === "text") ? part.text : null;
}

type HandoffPromptProof = Pick<HandoffRecord, "requestId" | "sourceSessionId" | "envelopeDigest">;

function matchesHandoffEnvelope(text: string, proof: HandoffPromptProof): boolean {
  const relation = sessionHandoffRelation(text);
  return createHash("sha256").update(text).digest("hex") === proof.envelopeDigest
    && relation?.requestId === proof.requestId && relation.sourceSessionId === proof.sourceSessionId;
}

async function hasDurableHandoffPrompt(target: SessionInfo, proof: HandoffPromptProof): Promise<boolean> {
  const key = parseHandoffIdentity(target.id);
  let messages: unknown[];
  if (key.backend === "claude") {
    const backend = await claudeBackend();
    const rows = await backend.readClaudeHandoffTranscript(target.id, target.cwd);
    messages = rows.filter((row) => row.type === "user" && !row.parent_tool_use_id).map((row) => row.message);
  } else if (key.backend === "codex") {
    const thread = await readCodexThread(nativeCodexSessionId(target.id));
    return thread.turns.some(turn => turn.items.some(item => {
      const text = codexUserText(item);
      return text !== null && codexUserEnvelopeEquals(item, text) && matchesHandoffEnvelope(text, proof);
    }));
  } else {
    try {
      const text = await readFile(target.path, "utf8");
      messages = text.split("\n").filter(Boolean).map((line) => {
        const entry: unknown = JSON.parse(line);
        return isRecord(entry) && entry.type === "message" ? entry.message : null;
      });
    } catch {
      return false;
    }
  }
  return messages.some((message) => {
    const text = handoffText(message);
    return text !== null && matchesHandoffEnvelope(text, proof);
  });
}

async function waitForDurablePrompt(target: SessionInfo, proof: HandoffPromptProof, check: typeof hasDurableHandoffPrompt): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  do {
    try {
      if (await check(target, proof)) return true;
    } catch {
      // The target transcript may not exist until the native runtime writes its first message.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

type HandoffSeam = "after-source-capture" | "before-intent" | "after-intent" | "before-target-creation" | "after-target-creation"
  | "before-target-id" | "after-target-id" | "before-prompt" | "after-prompt" | "before-receipt" | "after-receipt";

type HandoffTarget = { info: SessionInfo; send: () => Promise<unknown> };

interface HandoffTestHooks {
  seam?: (seam: HandoffSeam) => void | Promise<void>;
  readSource?: (sessionId: string) => Promise<SourceSnapshot>;
  createTarget?: (source: SourceSnapshot, built: ReturnType<typeof buildSessionHandoff>, request: SessionHandoffRequest) => Promise<HandoffTarget>;
  findExistingTarget?: (sourceSessionId: string, targetBackend: BackendId, requestId: string) => Promise<SessionInfo | null>;
  hasDurablePrompt?: typeof hasDurableHandoffPrompt;
}

function handoffReceipt(record: { target: SessionInfo; targetBackend: BackendId; transfer: SessionHandoffResult["transfer"] }): SessionHandoffResult {
  return { session: { ...record.target, backend: record.targetBackend }, transfer: record.transfer };
}

export async function createSessionHandoff(sourceSessionId: string, request: SessionHandoffRequest, hooks: HandoffTestHooks = {}): Promise<SessionHandoffResult> {
  const sourceKey = parseHandoffIdentity(sourceSessionId);
  const { targetBackend } = admitHandoffEdge(sourceKey.backend, request.targetBackend);
  let mayHaveMutated = false;
  try {
    return await withHandoffRecord(request.requestId, async (previous, save) => {
      if (previous && (previous.sourceSessionId !== sourceSessionId || previous.targetBackend !== targetBackend)) {
        throw new SessionHandoffError("Handoff requestId was already used for another transfer", 409, "request-conflict");
      }
      mayHaveMutated = previous !== null && previous.stage !== "intent" && previous.stage !== "complete";
      if (previous?.stage === "complete") return handoffReceipt(previous);
      if (previous?.stage === "admitting") {
        let admitted = false;
        try { admitted = await (hooks.hasDurablePrompt ?? hasDurableHandoffPrompt)(previous.target, previous); } catch { /* unconfirmed */ }
        if (admitted) {
          save({ ...previous, stage: "complete" });
          return handoffReceipt(previous);
        }
      }
      if (previous && previous.stage !== "intent") {
        throw new SessionHandoffError("The previous handoff cannot be confirmed", 503, "outcome-unknown", request.requestId);
      }
      if (!previous) {
        const existing = await (hooks.findExistingTarget ?? findExistingTarget)(sourceSessionId, targetBackend, request.requestId);
        if (existing) throw new SessionHandoffError("The previous handoff cannot be confirmed", 503, "outcome-unknown", request.requestId);
      }
      const source = hooks.readSource
        ? await hooks.readSource(sourceSessionId)
        : await readSource(sourceSessionId, () => hooks.seam?.("after-source-capture"));
      if (source.backend !== sourceKey.backend) throw new SessionHandoffError("Source backend does not match its session id", 409);
      assertTransferableSource(source.info);
      if (!existsSync(source.info.cwd)) throw new SessionHandoffError("Source project directory no longer exists", 409, "cwd-missing");
      if (targetBackend === "claude") {
        if (!claudeEnabled()) throw new SessionHandoffError("Claude runtime is unavailable", 409);
        if (!request.trustProject) throw new SessionHandoffError("Project trust is required before creating a Claude handoff", 409);
      }
      let built: ReturnType<typeof buildSessionHandoff>;
      try {
        built = buildSessionHandoff({
          requestId: request.requestId, sourceSessionId, sourceBackend: source.backend,
          sourceEntryId: source.leafId, sourceTitle: sourceTitle(source.info), targetBackend, messages: source.messages,
        });
      } catch (error) {
        throw new SessionHandoffError(error instanceof Error ? error.message : String(error), 409);
      }
      const envelopeDigest = createHash("sha256").update(built.prompt).digest("hex");
      if (previous && (previous.sourceEntryId !== source.leafId || previous.envelopeDigest !== envelopeDigest
        || (previous.sourceRevision !== undefined && previous.sourceRevision !== source.revision))) {
        throw new SessionHandoffError("Handoff source changed before any target was created. Select the destination again to start a new operation.", 409, "source-conflict", request.requestId);
      }
      const transfer = {
        sourceSessionId, sourceEntryId: source.leafId, transferredMessages: built.transferredMessages,
        omittedMessages: built.omittedMessages, truncated: built.truncated,
      };
      const intent: HandoffRecord = {
        version: 1, requestId: request.requestId, sourceSessionId, targetBackend,
        sourceEntryId: source.leafId, envelopeDigest, transfer, stage: "intent",
        ...(source.revision ? { sourceRevision: source.revision } : {}),
      };
      const seam = async (name: HandoffSeam) => { await hooks.seam?.(name); };
      if (!previous) {
        await seam("before-intent");
        save(intent);
        await seam("after-intent");
      }
      await seam("before-target-creation");
      save({ ...intent, stage: "creating" });
      mayHaveMutated = true;
      try {
        allowFileRoot(source.info.cwd);
        const createdTarget = hooks.createTarget
          ? await hooks.createTarget(source, built, request)
          : targetBackend === "claude"
            ? await createClaudeTarget(source, built, request)
            : targetBackend === "codex"
              ? await createCodexTarget(source, built, request)
              : await createPiTarget(source, built, request.requestId);
        const target = { ...createdTarget, info: { ...createdTarget.info, backend: targetBackend } };
        await seam("after-target-creation");
        await seam("before-target-id");
        save({ ...intent, stage: "created", target: target.info });
        await seam("after-target-id");
        await seam("before-prompt");
        save({ ...intent, stage: "admitting", target: target.info });
        await target.send();
        await seam("after-prompt");
        if (!await waitForDurablePrompt(target.info, intent, hooks.hasDurablePrompt ?? hasDurableHandoffPrompt)) {
          throw new Error("Target prompt admission could not be confirmed in its transcript");
        }
        await seam("before-receipt");
        const completed = save({ ...intent, stage: "complete", target: target.info });
        if (completed.stage !== "complete") throw new Error("Invalid handoff receipt");
        await seam("after-receipt");
        return handoffReceipt(completed);
      } catch (error) {
        throw new SessionHandoffError(error instanceof Error ? error.message : String(error), 503, "outcome-unknown", request.requestId);
      }
    });
  } catch (error) {
    if (mayHaveMutated) {
      if (error instanceof SessionHandoffError && error.reason === "outcome-unknown") throw error;
      throw new SessionHandoffError("The previous handoff cannot be confirmed", 503, "outcome-unknown", request.requestId);
    }
    throw error;
  }
}
