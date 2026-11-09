import { randomUUID } from "node:crypto";
import { claudeCreate, claudeCommand, claudeFork } from "@/lib/claude-routes";
import { createSessionHandoff, SessionHandoffError, type SessionHandoffRequest } from "@/lib/session-handoff-server";
import { generateSessionTitle } from "@/lib/session-title";
import { cwdMissingBody } from "@/lib/missing-cwd";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fork as forkPi, type SessionForkRequest, type SessionForkResult } from "./fork";
import { claudeBackend } from "@/lib/agent-catalog";
import { parseSessionKey } from "@/lib/session-identity";
import { allowFileRoot } from "@/lib/file-access";
import { attachSessionProjectInfo, invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, setRpcSessionTools, startRpcSession } from "@/lib/rpc-manager";
import { createAgentEventStream } from "@/lib/agent-event-stream";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { StreamClient } from "@/lib/stream-client";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { codexEnabled } from "@/lib/agent-backends/codex/descriptor";
import { isAbsolute, normalize } from "node:path";
import { projectCodexSessionInfo } from "@/lib/agent-backends/codex/projection";
import { codexSkills, codexMcp, forkCodexSession, compactCodexSession, answerCodexInteraction, codexModels, getCodexSession, updateCodexSettings, createCodexSession, ensureCodexSession, promptCodexSession, steerCodexSession, stopCodexSession, subscribeCodexSession, codexSessionState, codexTurnSnapshot, parseCodexRequestId, parseCodexWebId, type Result } from "@/lib/agent-backends/codex";

function codexFailure(result: Extract<Result<never>, { ok: false }>, sessionId?: string) {
  const failure = result.error;
  switch (failure.kind) {
    case "cwd-missing": return { status: 409, body: { ...cwdMissingBody(failure.cwd), accepted: false } };
    case "invalid": return { status: 400, body: { error: failure.message, code: "invalid_request", accepted: false } };
    case "conflict": return { status: 409, body: { error: failure.message, code: "conflict", accepted: false } };
    case "resume-refused": case "thread-unavailable": return { status: 409, body: { error: failure.message, code: failure.kind === "resume-refused" ? "resume_refused" : "thread_unavailable", nativeCode: failure.code, sessionId: failure.sessionId ?? sessionId } };
    case "native-rejected": return { status: 400, body: { error: failure.message, code: "native_rejected", nativeCode: failure.code, accepted: false } };
    case "outcome-unknown": return { status: 409, body: { error: "Codex operation outcome is unknown", code: "outcome_unknown", operation: failure.operation, ...(failure.operation === "steer" ? { turnId: failure.turnId } : "requestId" in failure ? { requestId: failure.requestId } : {}) } };
    case "transport-fatal": return { status: 502, body: { error: failure.message, code: "transport_fatal" } };
    case "closed": return { status: 409, body: { error: failure.message, code: "session_closed" } };
  }
}
function invalidCodex(message: string) { return { status: 400, body: { error: message, code: "invalid_request", accepted: false } }; }
function disabledCodex() { return { status: 503, body: { error: "Codex is disabled" } }; }
function onlyFields(body: Record<string, unknown>, fields: readonly string[]) { return Object.keys(body).every(key => fields.includes(key)); }
async function createCodexRuntime(body: Record<string, unknown>) {
  const requestId = parseCodexRequestId(body.requestId);
  if (!requestId || typeof body.cwd !== "string" || !isAbsolute(body.cwd) || (body.type !== "prompt" && body.type !== "ensure_session") || !onlyFields(body, ["backend", "cwd", "type", "requestId", "model", "effort", "message"]) || (body.model !== undefined && (typeof body.model !== "string" || !body.model)) || (body.effort !== undefined && (typeof body.effort !== "string" || !body.effort || !body.model)) || (body.type === "prompt" && (typeof body.message !== "string" || !body.message.trim())) || (body.type === "ensure_session" && body.message !== undefined)) return invalidCodex("Invalid Codex create request");
  const created = await createCodexSession({ cwd: normalize(body.cwd), requestId, ...(typeof body.model === "string" ? { model: body.model } : {}), ...(typeof body.effort === "string" ? { effort: body.effort } : {}) });
  if (!created.ok) return codexFailure(created);
  allowFileRoot(created.value.cwd);
  if (body.type === "prompt") {
    const prompted = await promptCodexSession(created.value, { requestId, message: body.message as string });
    if (!prompted.ok) return codexFailure(prompted, created.value.sessionId);
    return { status: 200, body: { success: true, sessionId: created.value.sessionId, state: codexSessionState(created.value), data: { turnId: prompted.value.turnId } } };
  }
  return { status: 200, body: { success: true, sessionId: created.value.sessionId, state: codexSessionState(created.value), data: null } };
}
async function commandCodexRuntime(id: string, body: { type: string; [key: string]: unknown }) {
  const webId = parseCodexWebId(id);
  if (!webId) return invalidCodex("Invalid Codex session id");
  if (typeof body.type !== "string" || !body.type) return invalidCodex("Invalid Codex command");
  if (body.type !== "prompt" && body.type !== "abort" && body.type !== "get_state" && body.type !== "answer_interaction" && body.type !== "set_settings" && body.type !== "compact") return { status: 400, body: { error: "Unsupported Codex command", code: "unsupported" } };
  const requestId = parseCodexRequestId(body.requestId);
  if (body.type === "compact" && (!onlyFields(body, ["type", "requestId"]) || (body.requestId !== undefined && !requestId))) return invalidCodex("Native compaction does not support custom instructions or options");
  if (body.type === "set_settings" ? (!onlyFields(body, ["type", "model", "effort"]) || typeof body.model !== "string" || !body.model || typeof body.effort !== "string" || !body.effort) : body.type === "prompt" ? (!requestId || typeof body.message !== "string" || !body.message.trim() || !onlyFields(body, ["type", "requestId", "message", "streamingBehavior"]) || (body.streamingBehavior !== undefined && body.streamingBehavior !== "steer")) : body.type === "answer_interaction" ? (!onlyFields(body, ["type", "id", "approved", "answers", "cancelled"]) || typeof body.id !== "string" || [body.approved !== undefined, body.answers !== undefined, body.cancelled !== undefined].filter(Boolean).length !== 1 || (body.cancelled !== undefined && body.cancelled !== true)) : body.type === "compact" ? false : !onlyFields(body, ["type"])) return invalidCodex("Invalid Codex command");
  const ensured = await ensureCodexSession(webId);
  if (!ensured.ok) return codexFailure(ensured, webId);
  if (body.type === "set_settings" && typeof body.model === "string" && typeof body.effort === "string") {
    const updated = await updateCodexSettings(ensured.value, { model: body.model, effort: body.effort });
    return updated.ok ? { status: 200, body: { success: true, data: updated.value } } : codexFailure(updated, webId);
  }
  if (body.type === "compact") {
    const compacted = await compactCodexSession(ensured.value);
    return compacted.ok ? { status: 200, body: { success: true, data: compacted.value } } : codexFailure(compacted, webId);
  }
  if (body.type === "get_state") return { status: 200, body: { success: true, data: codexSessionState(ensured.value) } };
  if (body.type === "answer_interaction") {
    const answered = answerCodexInteraction(ensured.value, body);
    return answered.ok ? { status: 200, body: { success: true, data: answered.value } } : codexFailure(answered, webId);
  }
  if (body.type === "abort") {
    const stopped = await stopCodexSession(ensured.value);
    return stopped.ok ? { status: 200, body: { success: true, data: stopped.value } } : codexFailure(stopped, webId);
  }
  const input = { requestId: requestId!, message: body.message as string };
  const prompted = body.streamingBehavior === "steer" ? await steerCodexSession(ensured.value, input) : await promptCodexSession(ensured.value, input);
  return prompted.ok ? { status: 200, body: { success: true, data: { turnId: prompted.value.turnId } } } : codexFailure(prompted, webId);
}

export async function models(query: { backend: "codex"; cwd: string; sessionId?: string }) {
  if (!codexEnabled()) return { status: 503, body: { error: "Codex is disabled" } };
  if (!isAbsolute(query.cwd) || normalize(query.cwd) !== query.cwd) return invalidCodex("Invalid Codex catalogue scope");
  if (!isExistingFilePathAllowed(query.cwd, await getAllowedFileRoots())) return { status: 403, body: { error: "Access denied" } };
  const actor = query.sessionId ? getCodexSession(query.sessionId) : undefined;
  if (query.sessionId && !parseCodexWebId(query.sessionId)) return invalidCodex("Invalid Codex session id");
  const result = await codexModels(query.cwd, actor);
  return result.ok ? { status: 200, body: { backend: "codex", models: result.value } } : codexFailure(result);
}

export async function inventory(query: { backend: "codex"; kind: "skills"; cwd: string; sessionId?: string } | { backend: "codex"; kind: "mcp"; sessionId: string }) {
  if (!codexEnabled()) return { status: 503, body: { error: "Codex is disabled" } };
  if (query.kind === "skills") {
    if (!isAbsolute(query.cwd) || normalize(query.cwd) !== query.cwd) return invalidCodex("Invalid native skills scope");
    if (!isExistingFilePathAllowed(query.cwd, await getAllowedFileRoots())) return { status: 403, body: { error: "Access denied" } };
    if (query.sessionId && !parseCodexWebId(query.sessionId)) return invalidCodex("Invalid Codex session id");
    const result = await codexSkills(query.cwd, query.sessionId ? getCodexSession(query.sessionId) : undefined);
    return result.ok ? { status: 200, body: result.value } : codexFailure(result);
  }
  const webId = parseCodexWebId(query.sessionId);
  if (!webId) return invalidCodex("Invalid Codex session id");
  // Status belongs to the existing native process. A readonly refresh never resumes a thread.
  const actor = getCodexSession(webId);
  if (!actor) return { status: 409, body: { error: "Open the native session before refreshing its MCP status", code: "session_closed" } };
  const result = await codexMcp(actor);
  return result.ok ? { status: 200, body: result.value } : codexFailure(result);
}

async function jsonResult(response: Response) {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export async function handoff(id: string, request: SessionHandoffRequest) {
  try {
    return { ok: true as const, value: await createSessionHandoff(id, request) };
  } catch (error) {
    return {
      ok: false as const,
      status: error instanceof SessionHandoffError ? error.status : 500,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof SessionHandoffError && error.reason ? { reason: error.reason } : {}),
      ...(error instanceof SessionHandoffError && error.operationId ? { operationId: error.operationId } : {}),
    };
  }
}

export async function autoName(id: string) {
  const identity = parseSessionKey(id);
  if (!identity.ok) return { status: 400, body: { error: "Invalid session id", reason: identity.reason } };
  if (identity.key.backend !== "pi") return { status: 400, body: { error: "Auto-naming is unavailable for this backend", reason: "backend-unavailable" } };
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return { status: 404, body: { error: "Session not found" } };
    const existing = getRpcSession(id);
    const { session } = existing?.isAlive() ? { session: existing } : await startRpcSession(id, filePath, undefined);
    // Wrappers surviving hot reload may predate waitUntilReady and have already started.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as AgentSession);
    if (!session.isAlive()) {
      return { status: 409, body: { error: "The session was closed while its title was being generated. Please try again." } };
    }
    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return { status: 200, body: { title: result.title, usage: result.usage ?? null } };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function fork(request: SessionForkRequest & { body?: Record<string, unknown> | null }): Promise<SessionForkResult | { kind: "native"; status: number; body: Record<string, unknown> }> {
  const identity = parseSessionKey(request.id);
  if (!identity.ok) return { kind: "native", status: 400, body: { error: "Invalid session id", reason: identity.reason } };
  if (identity.key.backend === "codex") {
    const native = (result: { status: number; body: Record<string, unknown> }) => ({ kind: "native" as const, ...result });
    if (!codexEnabled()) return native({ status: 503, body: { error: "Codex is disabled" } });
    const webId = parseCodexWebId(request.id);
    if (!webId) return native(invalidCodex("Invalid Codex session id"));
    const body = request.body ?? {};
    if (request.body === null || request.side || request.sideName !== undefined || typeof body !== "object" || Array.isArray(body) || !onlyFields(body, ["side"]) || (body.side !== undefined && body.side !== false)) return native({ status: 400, body: { error: "Codex supports only a whole-thread fork without custom options", code: "unsupported" } });
    const ensured = await ensureCodexSession(webId);
    if (!ensured.ok) return native(codexFailure(ensured, request.id));
    const forked = await forkCodexSession(ensured.value);
    if (!forked.ok) return native(codexFailure(forked, request.id));
    const projected = projectCodexSessionInfo(forked.value);
    if (projected.state !== "projected") return native({ status: 409, body: { error: "Native fork outcome is unknown", code: "outcome_unknown", operation: "fork" } });
    const [session] = await attachSessionProjectInfo([projected.info]);
    invalidateSessionListCache();
    return native({ status: 200, body: { sessionId: session.id, session: { ...session, parentSessionId: request.id, relation: { kind: "fork", originSessionId: request.id } } } });
  }
  if (identity.key.backend === "claude") {
    return { kind: "native", ...await jsonResult(await claudeFork(request.id, request.body ?? {})) };
  }
  return forkPi(request);
}

export async function createRuntime(body: Record<string, unknown>, thinkingLevel?: ThinkingLevel) {
  if (body.backend === "claude") return jsonResult(await claudeCreate(body));
  if (body.backend === "codex") return codexEnabled() ? createCodexRuntime(body) : disabledCodex();
  if (body.backend !== undefined && body.backend !== "pi") return invalidCodex("Unknown agent backend");
  const { cwd, provider, modelId, toolNames, thinkingLevel: _thinkingLevel, ...command } = body as {
    cwd: string; provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown;
  };
  void _thinkingLevel;
  const { session, realSessionId } = await startRpcSession(`__new__${randomUUID()}`, "", cwd, {
    ...(toolNames ? { toolNames } : {}),
    ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  allowFileRoot(cwd);
  invalidateSessionListCache();
  const state = await session.send({ type: "get_state" }) as { model?: { id: string; provider: string }; thinkingLevel?: string };
  const data = command.type === "ensure_session" ? null : await session.send(command);
  return { status: 200, body: { success: true, sessionId: realSessionId, data, model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null, thinkingLevel: state.thinkingLevel } };
}

export async function commandRuntime(id: string, body: { type: string; [key: string]: unknown }) {
  const identity = parseSessionKey(id);
  if (!identity.ok) return invalidCodex("Invalid session id");
  if (identity.key.backend === "codex") return codexEnabled() ? commandCodexRuntime(id, body) : disabledCodex();
  if (identity.key.backend === "claude") return jsonResult(await claudeCommand(id, body));
  const requestedToolNames = body.toolNames;
  if (requestedToolNames !== undefined && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))) {
    throw new Error("toolNames must be an array of strings");
  }
  const toolNames = requestedToolNames as string[] | undefined;
  const existing = getRpcSession(id);
  if (body.type === "set_tools") {
    const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
    if (!existing?.isAlive() && !filePath) return { status: 404, body: { error: "Session not found" } };
    const changed = await setRpcSessionTools(id, filePath, toolNames);
    return { status: 200, body: { success: true, data: { sessionId: changed.sessionId, recreated: changed.recreated } } };
  }
  if (existing?.isAlive()) return { status: 200, body: { success: true, data: await existing.send(body) } };
  const filePath = await resolveSessionPath(id);
  if (!filePath) return { status: 404, body: { error: "Session not found", ...(body.type === "prompt" ? { code: "prompt_rejected", accepted: false } : {}) } };
  const { session } = await startRpcSession(id, filePath, undefined, { ...(toolNames !== undefined ? { toolNames } : {}) });
  return { status: 200, body: { success: true, data: await session.send(body) } };
}

export async function runtimeEvents(id: string, signal: AbortSignal, meta: StreamClient & { holder: string | null }) {
  const identity = parseSessionKey(id);
  if (!identity.ok) return { kind: "error" as const, ...invalidCodex("Invalid session id") };
  if (identity.key.backend === "codex") {
    if (!codexEnabled()) return { kind: "error" as const, ...disabledCodex() };
    if (signal.aborted) return { kind: "aborted" as const };
    const webId = parseCodexWebId(id)!;
    const ensured = await ensureCodexSession(webId);
    if (!ensured.ok) return { kind: "error" as const, ...codexFailure(ensured, webId) };
    if (signal.aborted) return { kind: "aborted" as const };
    const actor = ensured.value;
    const session = {
      get isStreaming() { return codexSessionState(actor).isStreaming; },
      streamingMessage: undefined,
      get turnSnapshot() { return codexTurnSnapshot(actor); },
      isAlive: () => actor.state.kind === "ready",
      onEvent: (listener: Parameters<typeof subscribeCodexSession>[1]) => {
        let active = codexSessionState(actor).isStreaming;
        return subscribeCodexSession(actor, event => {
          if (event.type === "agent_start") active = true;
          if (event.type === "session_shutdown" && active) {
            active = false;
            listener({ type: "agent_settled", aborted: true, subagentsActive: false });
          }
          listener(event);
          if (event.type === "prompt_done" && active) {
            active = false;
            listener({ type: "agent_settled", aborted: event.aborted === true, subagentsActive: false });
          }
        });
      },
    };
    return { kind: "stream" as const, stream: createAgentEventStream({ signal }, id, Promise.resolve(session), meta), claude: false };
  }
  if (identity.key.backend === "claude") {
    try {
      const session = await (await claudeBackend()).ensureClaudeSession(id);
      return { kind: "stream" as const, stream: createAgentEventStream({ signal }, id, Promise.resolve(session), meta), claude: true };
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
      return { kind: "error" as const, status, body: { error: error instanceof Error ? error.message : "Claude operation failed" } };
    }
  }
  if (signal.aborted) return { kind: "aborted" as const };
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) sessionPromise = Promise.resolve(session);
  else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return { kind: "not-found" as const };
    if (signal.aborted) return { kind: "aborted" as const };
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }
  return { kind: "stream" as const, stream: createAgentEventStream({ signal }, id, sessionPromise, meta), claude: false };
}
