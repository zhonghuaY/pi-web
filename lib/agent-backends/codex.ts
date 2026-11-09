import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { AgentMessage } from "@/lib/types";
import { cwdMissingMessage } from "@/lib/missing-cwd";
import { SESSION_IDLE_TIMEOUT_MS, type AgentEvent } from "@/lib/rpc-manager";
import { codexPayloadValidators, type CodexPayloads, type CodexPayloadMethod } from "./codex/internal/payloads";
import { ClientMethod, ServerRequestMethod, SUPPORTED_CODEX_CLI_VERSION, type RpcRequest } from "./codex/internal/protocol";
import type { AgentInteractionRequest } from "./types";
import { CodexTransportError, startCodexTransport, type CodexTransport } from "./codex/internal/transport";
import { runCodexMutationOnce } from "./codex/mutation-journal";
import { codexWebSessionId, nativeCodexSessionId } from "./codex/identity";
import { assembleCodexReasoning, projectItem } from "./codex/history";
import type { CodexThread } from "./codex/catalogue";
import { parseCodexModels, type CodexModelChoice, type CodexEffectiveSettings, type CodexSelection } from "@/lib/agent-session-choices";
import { CODEX_CAPABILITIES, projectCodexSessionInfo } from "./codex/projection";
import { readCodexSkills, readCodexMcp } from "./codex/inventory";
import { observeCompaction, compactionPersisted, type CompactionProgress } from "./codex/compact";
import { forkCodexThread } from "./codex/fork";
import type { CodexSkillsInventory, CodexMcpInventory } from "@/lib/agent-session-inventory";

type Brand<T, B extends string> = T & { readonly __brand: B };
export type RequestId = Brand<string, "RequestId">;
export type WebId = Brand<string, "CodexWebId">;
type ThreadId = Brand<string, "CodexThreadId">;
type TurnId = Brand<string, "CodexTurnId">;
type ItemId = Brand<string, "CodexItemId">;
type Failure =
  | { kind: "invalid" | "conflict" | "transport-fatal" | "closed"; message: string }
  | { kind: "resume-refused" | "thread-unavailable"; code: -32600; message: string; sessionId?: WebId }
  | { kind: "cwd-missing"; cwd: string; message: string }
  | { kind: "native-rejected"; code: number; message: string }
  | { kind: "outcome-unknown"; operation: "create" | "prompt"; requestId: RequestId }
  | { kind: "outcome-unknown"; operation: "steer"; turnId: TurnId }
  | { kind: "outcome-unknown"; operation: "settings" | "fork" | "compact" };
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
type TurnEnd = { kind: "completed" | "interrupted" | "failed" | "stopped" | "transport-fatal" };
type Waiter = (result: TurnEnd) => void;
type ItemBuffer = { id: ItemId; kind: "reasoning" | "agentMessage"; text: string; segments: Map<string, { kind: "summary" | "text"; index: number; text: string }> | null; completed: boolean; started: boolean };
type ActivityBuffer = { id: ItemId; kind: "activity"; nativeType: string; toolName: string; message: AgentMessage; completed: boolean; started: boolean };
type LiveItem = ItemBuffer | ActivityBuffer;
type NativeMethod = "turn/started" | "turn/completed" | "item/started" | "item/completed" | "item/agentMessage/delta" | "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" | "item/commandExecution/outputDelta" | "item/mcpToolCall/progress" | "error";
type ValidatedNativeMethod = Exclude<NativeMethod, "item/commandExecution/outputDelta" | "item/mcpToolCall/progress">;
type NativeNotification = { [M in ValidatedNativeMethod]: { method: M; params: CodexPayloads[M] } }[ValidatedNativeMethod]
  | { method: "item/commandExecution/outputDelta" | "item/mcpToolCall/progress"; params: CodexPayloads["item/agentMessage/delta"] };
type TurnState =
  | { kind: "idle" }
  | { kind: "starting"; requestId: RequestId; stopRequested: boolean; early: NativeNotification[]; waiters: Set<Waiter> }
  | { kind: "running"; requestId: RequestId; turnId: TurnId; stopRequested: boolean; items: Map<ItemId, LiveItem>; waiters: Set<Waiter>; errorReported: boolean }
  | { kind: "stopping"; requestId: RequestId; turnId: TurnId; items: Map<ItemId, LiveItem>; waiters: Set<Waiter>; errorReported: boolean };
type ActorState = { kind: "opening"; transport: CodexTransport | null } | { kind: "ready"; transport: CodexTransport; threadId: ThreadId; turn: TurnState } | { kind: "closing" } | { kind: "closed" } | { kind: "error"; failure: Failure };
type SessionEvent = AgentEvent;
export type Actor = { readonly sessionId: WebId; readonly cwd: string; state: ActorState; listeners: Set<(event: SessionEvent) => void> };
type CreateInput = { cwd: string; requestId: RequestId; model?: string; effort?: string };
type PromptInput = { requestId: RequestId; message: string };
type ActorOptions = { binary?: string; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number };
type PromptAccepted = { kind: "live"; turnId: TurnId; completion: Promise<TurnEnd> } | { kind: "replayed"; turnId: TurnId };
type StopResult = { stopped: boolean; completion: TurnEnd | null };
type CodexAdmission = { captures: Set<WebId>; mutations: Map<WebId, number>; deferred: Map<WebId, Array<() => void>> };
type Registry = { actors: Map<WebId, Actor>; ensuring: Map<WebId, Promise<Result<Actor>>>; admission: CodexAdmission; installed: boolean };
type SteerState = { kind: "pending"; turnId: TurnId; requestId: RequestId; digest: string; promise: Promise<Result<{ turnId: TurnId }>> } | { kind: "ambiguous"; turnId: TurnId };
type InteractionMethod = "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/tool/requestUserInput";
type InteractionGroup = { method: InteractionMethod; turnId: string; requests: Map<string, { event: AgentInteractionRequest; questionId?: string }>; answers: Record<string, { answers: string[] }>; cancelAllowed: boolean; resolve: (value: unknown) => void; signal: AbortSignal; onAbort: () => void; announced: boolean };
type SettingsPending = { sent: boolean; transport: CodexTransport; resolve: (settings: CodexEffectiveSettings | null) => void };
type Operation = { kind: "fork" } | { kind: "compact"; progress: CompactionProgress };
type ActorExtra = { options: ActorOptions; operation?: Operation; settings: CodexEffectiveSettings; settingsPending?: SettingsPending; settingsUncertain?: boolean; requestTimeoutMs: number; thread: CodexThread; timer?: ReturnType<typeof setTimeout>; idleTimer?: ReturnType<typeof setTimeout>; work?: number; active?: { requestId: RequestId; digest: string; promise: Promise<Result<PromptAccepted>>; completion: Promise<TurnEnd> }; steer?: SteerState; interactions: Set<InteractionGroup>; shutdown?: Promise<void> };
const key = Symbol.for("pi-web.codex-backend.registry");
const registryRoot = globalThis as Record<symbol, Registry>;
const registry = registryRoot[key] ??= { actors: new Map(), ensuring: new Map(), admission: { captures: new Set(), mutations: new Map(), deferred: new Map() }, installed: false };
registry.admission ??= { captures: new Set(), mutations: new Map(), deferred: new Map() };
registry.admission.deferred ??= new Map();
const extrasKey = Symbol.for("pi-web.codex-backend.actor-extras");
const extras = ((globalThis as Record<symbol, WeakMap<Actor, ActorExtra>>)[extrasKey] ??= new WeakMap());
const inspection = codexPayloadValidators({ state: "supported", version: SUPPORTED_CODEX_CLI_VERSION });
if (inspection.state !== "supported") throw new Error("Codex schema unavailable");
const validators = inspection.validators;
const methods = new Set<NativeMethod>(["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta", "item/mcpToolCall/progress", "error"]);
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T = never>(error: Failure): Result<T> => ({ ok: false, error });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const generic = (kind: "invalid" | "conflict" | "transport-fatal" | "closed", message: string): Failure => ({ kind, message });

async function projectDirectoryFailure(cwd: string): Promise<Failure | null> {
  const missing: Failure = { kind: "cwd-missing", cwd, message: cwdMissingMessage(cwd) };
  try { return (await stat(cwd)).isDirectory() ? null : missing; }
  catch (error) {
    return error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
      ? missing : generic("invalid", "Cannot access project directory");
  }
}

export class CodexHandoffCaptureError extends Error {
  constructor(readonly reason: "capture-active" | "source-busy" | "source-changed", message: string) {
    super(message);
    this.name = "CodexHandoffCaptureError";
  }
}

function releaseMutation(id: WebId): void {
  const remaining = (registry.admission.mutations.get(id) ?? 1) - 1;
  if (remaining === 0) {
    registry.admission.mutations.delete(id);
    const actor = registry.actors.get(id);
    if (actor) scheduleIdle(actor);
  } else registry.admission.mutations.set(id, remaining);
}

/** Every Codex operation that can change a thread or its owner must enter here. */
export function withCodexMutationAdmission<T>(sessionId: string, operation: () => T): T {
  const id = parseCodexWebId(sessionId);
  if (!id) throw new CodexHandoffCaptureError("source-changed", "Invalid Codex session id");
  if (registry.admission.captures.has(id)) {
    throw new CodexHandoffCaptureError("capture-active", "Codex handoff capture is in progress");
  }
  registry.admission.mutations.set(id, (registry.admission.mutations.get(id) ?? 0) + 1);
  clearIdle(registry.actors.get(id));
  try {
    const value = operation();
    if (typeof (value as { then?: unknown } | null)?.then === "function") {
      return Promise.resolve(value).finally(() => releaseMutation(id)) as T;
    }
    releaseMutation(id);
    return value;
  } catch (error) {
    releaseMutation(id);
    throw error;
  }
}

function actorCanBeCaptured(actor: Actor): boolean {
  if (actor.state.kind !== "ready" || !actor.state.transport.isOpen || actor.state.turn.kind !== "idle") return false;
  const extra = extras.get(actor);
  return Boolean(extra && !extra.settingsPending && !extra.settingsUncertain && !extra.operation && !extra.steer && !extra.shutdown && extra.interactions.size === 0);
}

function deferCodexNativeMutation(actor: Actor, operation: () => void): boolean {
  if (!registry.admission.captures.has(actor.sessionId)) return false;
  const deferred = registry.admission.deferred.get(actor.sessionId) ?? [];
  deferred.push(operation);
  registry.admission.deferred.set(actor.sessionId, deferred);
  return true;
}

function releaseCapture(id: WebId): void {
  registry.admission.captures.delete(id);
  const deferred = registry.admission.deferred.get(id) ?? [];
  registry.admission.deferred.delete(id);
  for (const operation of deferred) {
    try { operation(); } catch { /* native notification handling owns failure state */ }
  }
}

export async function withCodexHandoffSnapshot<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const id = parseCodexWebId(sessionId);
  if (!id) throw new CodexHandoffCaptureError("source-changed", "Invalid Codex session id");
  const actor = registry.actors.get(id);
  if (registry.admission.captures.has(id)) {
    throw new CodexHandoffCaptureError("capture-active", "Codex handoff capture is already in progress");
  }
  if ((registry.admission.mutations.get(id) ?? 0) > 0 || registry.ensuring.has(id)
    || (actor !== undefined && !actorCanBeCaptured(actor))) {
    throw new CodexHandoffCaptureError("source-busy", "Wait for the source session to finish before continuing it");
  }
  registry.admission.captures.add(id);
  try {
    const value = await operation();
    if (registry.actors.get(id) !== actor || (actor !== undefined && !actorCanBeCaptured(actor))) {
      throw new CodexHandoffCaptureError("source-changed", "Source session changed during capture");
    }
    return value;
  } finally {
    releaseCapture(id);
  }
}

function captureConflict<T>(error: unknown): Result<T> {
  if (error instanceof CodexHandoffCaptureError) return fail(generic("conflict", error.message));
  throw error;
}

export function parseCodexRequestId(value: unknown): RequestId | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() as RequestId : null;
}
export function parseCodexWebId(value: unknown): WebId | null {
  if (typeof value !== "string") return null;
  try { return codexWebSessionId(nativeCodexSessionId(value)) as WebId; } catch { return null; }
}
function validNativeId(value: string): boolean { return value.length > 0 && value.length <= 512; }
function validate<K extends CodexPayloadMethod>(method: K, value: unknown): CodexPayloads[K] {
  const result = validators.validate(method, value);
  if (result.state !== "valid") throw new CodexTransportError("protocol");
  return result.value;
}
function emit(actor: Actor, event: SessionEvent) { for (const listener of actor.listeners) { try { listener(event); } catch { /* listener owns its errors */ } } }
function finishInteraction(actor: Actor, group: InteractionGroup, result: unknown, reason: "answered" | "cancelled" | "aborted" | "session_closed") {
  if (result !== undefined) {
    if (group.method === "item/tool/requestUserInput") validate("item/tool/requestUserInput:response", result);
    else if (group.method === "item/commandExecution/requestApproval") validate("item/commandExecution/requestApproval:response", result);
    else validate("item/fileChange/requestApproval:response", result);
  }
  if (!extras.get(actor)!.interactions.delete(group)) return;
  group.signal.removeEventListener("abort", group.onAbort);
  for (const id of group.requests.keys()) if (group.announced) emit(actor, { type: "agent_interaction_closed", id, reason });
  group.requests.clear();
  group.resolve(result);
}
function cancelInteraction(actor: Actor, group: InteractionGroup, reason: "cancelled" | "aborted" | "session_closed") {
  finishInteraction(actor, group, group.method === "item/tool/requestUserInput" ? { answers: {} } : group.cancelAllowed ? { decision: "cancel" } : undefined, reason);
}
function cancelInteractions(actor: Actor, reason: "cancelled" | "aborted" | "session_closed") {
  for (const group of [...extras.get(actor)!.interactions]) cancelInteraction(actor, group, reason);
}
function announceInteractions(actor: Actor, turnId: string) {
  for (const group of extras.get(actor)!.interactions) {
    if (group.announced) continue;
    if (group.turnId !== turnId) { cancelInteraction(actor, group, "aborted"); continue; }
    group.announced = true;
    for (const request of group.requests.values()) emit(actor, { ...request.event });
  }
}
function interactionHandler(getActor: () => Actor | undefined, method: InteractionMethod) {
  return (raw: RpcRequest, signal: AbortSignal): Promise<unknown> => {
    const actor = getActor();
    if (!actor || actor.state.kind !== "ready") return Promise.reject(new CodexTransportError("protocol"));
    const state = actor.state;
    const turn = state.turn;
    if (turn.kind === "idle") return Promise.reject(new CodexTransportError("protocol"));
    const params = validate(method, raw.params);
    const choices = method === ServerRequestMethod.commandApproval && "availableDecisions" in params
      ? params.availableDecisions
      : undefined;
    const approvalOptions = method === ServerRequestMethod.fileApproval ? { accept: true, decline: true } : { accept: Array.isArray(choices) && choices.includes("accept"), decline: Array.isArray(choices) && choices.includes("decline") };
    if (params.threadId.toLowerCase() !== state.threadId.toLowerCase() || (turn.kind !== "starting" && params.turnId !== turn.turnId)) return Promise.reject(new CodexTransportError("protocol"));
    const requests: InteractionGroup["requests"] = new Map();
    if (method === ServerRequestMethod.userInput) {
      const ids = new Set<string>();
      for (const question of validate("item/tool/requestUserInput", raw.params).questions) {
        if (!question.id || ids.has(question.id)) return Promise.reject(new CodexTransportError("protocol"));
        ids.add(question.id);
        const id = randomUUID();
        requests.set(id, { questionId: question.id, event: { type: "agent_interaction_request", id, kind: "question", title: "Codex", questions: [{ question: question.question, header: question.header, options: question.options ?? [], isSecret: question.isSecret, isOther: question.isOther }] } });
      }
    } else {
      const id = randomUUID();
      const input = method === ServerRequestMethod.commandApproval
        ? { ...("command" in params && typeof params.command === "string" ? { command: params.command } : {}), ...("cwd" in params && typeof params.cwd === "string" ? { cwd: params.cwd } : {}), ...("reason" in params && typeof params.reason === "string" ? { reason: params.reason } : {}) }
        : { ...("reason" in params && typeof params.reason === "string" ? { reason: params.reason } : {}), ...("grantRoot" in params && typeof params.grantRoot === "string" ? { grantRoot: params.grantRoot } : {}) };
      requests.set(id, { event: { type: "agent_interaction_request", id, kind: "permission", title: "Codex", toolName: method === ServerRequestMethod.commandApproval ? "commandExecution" : "fileChange", input, approvalOptions } });
    }
    if (!requests.size) return Promise.resolve({ answers: {} });
    return new Promise(resolve => {
      const group: InteractionGroup = { method, turnId: params.turnId, requests, answers: Object.create(null) as InteractionGroup["answers"], cancelAllowed: method !== ServerRequestMethod.commandApproval || (Array.isArray(choices) && choices.includes("cancel")), resolve, signal, announced: false, onAbort: () => cancelInteraction(actor, group, "aborted") };
      extras.get(actor)!.interactions.add(group);
      signal.addEventListener("abort", group.onAbort, { once: true });
      if (turn.kind !== "starting") announceInteractions(actor, turn.turnId);
    });
  };
}
function interactionHandlers(getActor: () => Actor | undefined) {
  return {
    [ServerRequestMethod.commandApproval]: interactionHandler(getActor, ServerRequestMethod.commandApproval),
    [ServerRequestMethod.fileApproval]: interactionHandler(getActor, ServerRequestMethod.fileApproval),
    [ServerRequestMethod.userInput]: interactionHandler(getActor, ServerRequestMethod.userInput),
  };
}
function answerCodexInteractionImpl(actor: Actor, command: Record<string, unknown>): Result<{ accepted: true }> {
  if (actor.state.kind !== "ready" || typeof command.id !== "string") return fail(generic("invalid", "Invalid interaction response"));
  for (const group of extras.get(actor)!.interactions) {
    const request = group.requests.get(command.id);
    if (!request || !group.announced) continue;
    const turn = actor.state.turn;
    if (turn.kind !== "running" || turn.turnId !== group.turnId) return fail(generic("conflict", "Interaction is no longer pending"));
    if (command.cancelled === true) { cancelInteraction(actor, group, "cancelled"); return ok({ accepted: true }); }
    if (request.questionId !== undefined) {
      const answers = command.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return fail(generic("invalid", "Invalid question answer"));
      const value = (answers as Record<string, unknown>)[request.event.questions![0].question];
      if (typeof value !== "string") return fail(generic("invalid", "Invalid question answer"));
      group.answers[request.questionId] = { answers: [value] };
      group.requests.delete(command.id);
      emit(actor, { type: "agent_interaction_closed", id: command.id, reason: "answered" });
      if (!group.requests.size) finishInteraction(actor, group, { answers: group.answers }, "answered");
      return ok({ accepted: true });
    }
    if (typeof command.approved !== "boolean") return fail(generic("invalid", "Invalid approval answer"));
    if (command.approved ? !request.event.approvalOptions?.accept : !request.event.approvalOptions?.decline) return fail(generic("conflict", "Approval decision is unavailable"));
    finishInteraction(actor, group, { decision: command.approved ? "accept" : "decline" }, "answered");
    return ok({ accepted: true });
  }
  return fail(generic("conflict", "Interaction is no longer pending"));
}
export function answerCodexInteraction(actor: Actor, command: Record<string, unknown>): Result<{ accepted: true }> {
  try { return withCodexMutationAdmission(actor.sessionId, () => answerCodexInteractionImpl(actor, command)); }
  catch (error) { return captureConflict(error); }
}
function settle(turn: TurnState, result: TurnEnd) {
  if (turn.kind === "idle") return;
  for (const waiter of turn.waiters) waiter(result);
  turn.waiters.clear();
}
function clearHealth(actor: Actor) { const extra = extras.get(actor); if (extra?.timer) clearTimeout(extra.timer); if (extra) extra.timer = undefined; }
function clearIdle(actor: Actor | undefined) {
  const extra = actor && extras.get(actor);
  if (extra?.idleTimer) clearTimeout(extra.idleTimer);
  if (extra) extra.idleTimer = undefined;
}
function idleForReaping(actor: Actor): boolean {
  const extra = extras.get(actor);
  return actor.state.kind === "ready" && actor.state.turn.kind === "idle" && actor.listeners.size === 0 && Boolean(extra)
    && !extra!.operation && !extra!.settingsPending && !extra!.active && !extra!.shutdown && !extra!.work
    && extra!.interactions.size === 0 && !registry.admission.mutations.get(actor.sessionId);
}
function reapIdle(actor: Actor): void {
  if (!idleForReaping(actor) || registry.actors.get(actor.sessionId) !== actor) return;
  if (deferCodexNativeMutation(actor, () => reapIdle(actor))) return;
  void shutdownCodexSession(actor).catch(() => {});
}
function scheduleIdle(actor: Actor): void {
  clearIdle(actor);
  if (!SESSION_IDLE_TIMEOUT_MS || !idleForReaping(actor) || registry.actors.get(actor.sessionId) !== actor) return;
  const extra = extras.get(actor)!;
  extra.idleTimer = setTimeout(() => { extra.idleTimer = undefined; reapIdle(actor); }, SESSION_IDLE_TIMEOUT_MS);
  extra.idleTimer.unref();
}
async function withActorWork<T>(actor: Actor | undefined, operation: () => Promise<T>): Promise<T> {
  const extra = actor && extras.get(actor);
  if (!actor || !extra || actor.state.kind !== "ready") return operation();
  clearIdle(actor);
  extra.work = (extra.work ?? 0) + 1;
  try { return await operation(); }
  finally { extra.work--; scheduleIdle(actor); }
}
function evict(actor: Actor) { if (registry.actors.get(actor.sessionId) === actor) registry.actors.delete(actor.sessionId); }
function fatal(actor: Actor) {
  if (actor.state.kind !== "ready" && actor.state.kind !== "opening") return;
  const previous = actor.state;
  if (extras.get(actor)) cancelInteractions(actor, "session_closed");
  const failure = generic("transport-fatal", "Codex transport failed");
  actor.state = { kind: "error", failure };
  const extra = extras.get(actor);
  if (extra) {
    extra.steer = undefined;
    extra.settingsPending?.resolve(null);
    if (extra.operation?.kind === "compact") {
      extra.operation.progress.resolve(null);
      emit(actor, { type: "compaction_end", errorMessage: "Native compaction was interrupted. Reload to inspect native history." });
    }
  }
  clearHealth(actor);
  clearIdle(actor);
  if (previous.kind === "ready") settle(previous.turn, { kind: "transport-fatal" });
  emit(actor, { type: "prompt_error", errorMessage: "Codex transport failed. Reconnect to continue." });
  emit(actor, { type: "error", error: "Codex transport failed", code: "transport_fatal" });
  emit(actor, { type: "session_shutdown" });
  evict(actor);
  if (previous.transport) void previous.transport.shutdown();
}
function onTransportFailure(actor: Actor | undefined): void {
  if (!actor) return;
  if (deferCodexNativeMutation(actor, () => onTransportFailure(actor))) return;
  fatal(actor);
}
function shutdownForProcessExit(actor: Actor): void {
  if (deferCodexNativeMutation(actor, () => shutdownForProcessExit(actor))) return;
  void shutdownCodexSession(actor).catch(() => {});
}
function installCleanup() {
  if (registry.installed) return;
  registry.installed = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { for (const actor of registry.actors.values()) shutdownForProcessExit(actor); });
}
function messageFor(actor: Actor, item: LiveItem): AgentMessage {
  if (item.kind === "activity") return item.message;
  const thread = extras.get(actor)!.thread;
  return { role: "assistant", provider: thread.modelProvider, model: thread.model ?? "", content: item.kind === "reasoning" ? [{ type: "thinking", thinking: item.text }] : [{ type: "text", text: item.text }] };
}
function itemFor(items: Map<ItemId, LiveItem>, rawId: string, kind: ItemBuffer["kind"]): ItemBuffer | null {
  if (!validNativeId(rawId)) return null;
  const id = rawId as ItemId;
  let item = items.get(id);
  if (!item) { item = { id, kind, text: "", segments: kind === "reasoning" ? new Map() : null, completed: false, started: false }; items.set(id, item); }
  return item.kind === kind ? item : null;
}
function startItem(actor: Actor, item: ItemBuffer) { if (!item.started) { item.started = true; emit(actor, { type: "message_start", entryId: item.id, message: messageFor(actor, item) }); } }
function activityText(message: AgentMessage): string {
  return message.role === "bashExecution" ? message.output : message.role === "custom" && typeof message.content === "string" ? message.content : "";
}
function startActivity(actor: Actor, item: ActivityBuffer) {
  if (item.started) return;
  item.started = true;
  emit(actor, { type: "message_end", entryId: item.id, message: item.message });
  emit(actor, { type: "tool_execution_start", toolCallId: item.id, toolName: item.toolName });
}
function finishActivity(actor: Actor, item: ActivityBuffer) {
  if (item.completed) return;
  startActivity(actor, item);
  item.completed = true;
  emit(actor, { type: "message_end", entryId: item.id, message: item.message });
  emit(actor, { type: "tool_execution_end", toolCallId: item.id, toolName: item.toolName, result: { content: [{ type: "text", text: activityText(item.message) }] } });
}
function finishItem(actor: Actor, item: LiveItem, message = messageFor(actor, item)) {
  if (item.kind === "activity") { finishActivity(actor, item); return; }
  if (item.completed) return;
  startItem(actor, item);
  item.completed = true;
  emit(actor, { type: "message_end", entryId: item.id, message });
}
function assembled(item: ItemBuffer): string {
  const summary: string[] = [], content: string[] = [];
  for (const segment of item.segments!.values()) (segment.kind === "summary" ? summary : content)[segment.index] = segment.text;
  return assembleCodexReasoning(summary, content);
}
function handleNotification(actor: Actor, notification: NativeNotification) {
  if (actor.state.kind !== "ready") return;
  const state = actor.state;
  const turn = state.turn;
  if (turn.kind === "idle") return;
  if (turn.kind === "starting") {
    if (turn.early.length >= 1024) { fatal(actor); return; }
    turn.early.push(notification);
    return;
  }
  const params = notification.params;
  if (params.threadId.toLowerCase() !== state.threadId.toLowerCase()) return;
  const turnId = "turn" in params ? params.turn.id : params.turnId;
  if (turnId !== turn.turnId) return;
  if (notification.method === "error") {
    if (!turn.errorReported || !notification.params.willRetry) {
      emit(actor, { type: "prompt_error", errorMessage: notification.params.willRetry ? "Codex encountered an error and is retrying." : "Codex could not complete the turn." });
      turn.errorReported = true;
    }
    if (notification.params.willRetry) return;
  }
  if (notification.method === "turn/completed" || notification.method === "error") {
    cancelInteractions(actor, "aborted");
    for (const item of turn.items.values()) if (!item.completed) finishItem(actor, item);
    const status = notification.method === "error" ? "failed" : notification.params.turn.status;
    const end: TurnEnd = { kind: status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed" };
    if (end.kind === "failed" && notification.method === "turn/completed") emit(actor, { type: "prompt_error", errorMessage: "Codex could not complete the turn." });
    state.turn = { kind: "idle" };
    extras.get(actor)!.steer = undefined;
    clearHealth(actor);
    settle(turn, end);
    const messages = [...turn.items.values()].map(item => messageFor(actor, item));
    emit(actor, { type: "turn_end", message: messages.at(-1) ?? { role: "assistant", provider: "", model: "", content: [] }, toolResults: [] });
    emit(actor, { type: "agent_end", messages });
    emit(actor, { type: "prompt_done", ...(end.kind === "interrupted" ? { aborted: true } : {}) });
    return;
  }
  if (notification.method === "item/commandExecution/outputDelta" || notification.method === "item/mcpToolCall/progress") {
    const nativeType = notification.method === "item/commandExecution/outputDelta" ? "commandExecution" : "mcpToolCall";
    if (!validNativeId(notification.params.itemId)) return;
    const id = notification.params.itemId as ItemId;
    let item = turn.items.get(id);
    if (item && (item.kind !== "activity" || item.nativeType !== nativeType)) { fatal(actor); return; }
    if (!item) {
      const message: AgentMessage = nativeType === "commandExecution"
        ? { role: "bashExecution", command: "", output: "" }
        : { role: "custom", customType: nativeType, content: "", display: true };
      item = { id, kind: "activity", nativeType, toolName: nativeType === "commandExecution" ? "bash" : nativeType, message, completed: false, started: false };
      turn.items.set(id, item);
    }
    if (item.kind !== "activity" || item.completed) return;
    if (item.message.role === "bashExecution") item.message = { ...item.message, output: item.message.output + notification.params.delta };
    else if (item.message.role === "custom" && typeof item.message.content === "string") item.message = { ...item.message, content: [item.message.content, notification.params.delta].filter(Boolean).join("\n") };
    startActivity(actor, item);
    emit(actor, { type: "message_end", entryId: id, message: item.message });
    emit(actor, { type: "tool_execution_update", toolCallId: id, toolName: item.toolName, partialResult: { content: [{ type: "text", text: activityText(item.message) }] } });
    return;
  }
  if (notification.method === "item/started" || notification.method === "item/completed") {
    const native = notification.params.item;
    if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(native.type)) {
      if (!validNativeId(native.id)) return;
      const id = native.id as ItemId;
      let item = turn.items.get(id);
      if (item && (item.kind !== "activity" || item.nativeType !== native.type)) { fatal(actor); return; }
      const message = projectItem(native, extras.get(actor)!.thread).message;
      if (!item) {
        item = { id, kind: "activity", nativeType: native.type, toolName: native.type === "commandExecution" ? "bash" : native.type, message, completed: false, started: false };
        turn.items.set(id, item);
      }
      if (item.kind !== "activity" || item.completed) return;
      if (notification.method === "item/started" && message.role === "bashExecution" && item.message.role === "bashExecution" && !message.output) message.output = item.message.output;
      if (notification.method === "item/started" && message.role === "custom" && item.message.role === "custom" && !message.content && typeof item.message.content === "string") message.content = item.message.content;
      item.message = message;
      if (notification.method === "item/completed") finishActivity(actor, item);
      else if (!item.started) startActivity(actor, item);
      else {
        emit(actor, { type: "message_end", entryId: id, message });
        emit(actor, { type: "tool_execution_update", toolCallId: id, toolName: item.toolName, partialResult: { content: [{ type: "text", text: activityText(message) }] } });
      }
      return;
    }
    if (native.type !== "reasoning" && native.type !== "agentMessage") return;
    const item = itemFor(turn.items, native.id, native.type);
    if (!item || item.completed) return;
    if (notification.method === "item/completed") {
      const projected = projectItem(native, extras.get(actor)!.thread).message;
      if (projected.role === "assistant") {
        const block = projected.content[0];
        item.text = block?.type === "thinking" ? block.thinking : block?.type === "text" ? block.text : "";
        finishItem(actor, item, projected);
      }
    }
    return;
  }
  if (notification.method !== "item/agentMessage/delta" && notification.method !== "item/reasoning/textDelta" && notification.method !== "item/reasoning/summaryTextDelta") return;
  const kind = notification.method === "item/agentMessage/delta" ? "agentMessage" : "reasoning";
  const item = itemFor(turn.items, notification.params.itemId, kind);
  if (!item || item.completed) return;
  startItem(actor, item);
  if (notification.method === "item/agentMessage/delta") item.text += notification.params.delta;
  else {
    const segmentKind = notification.method === "item/reasoning/textDelta" ? "text" : "summary";
    const index = notification.method === "item/reasoning/textDelta" ? notification.params.contentIndex : notification.params.summaryIndex;
    if (!Number.isSafeInteger(index) || index < 0) { fatal(actor); return; }
    const segmentKey = `${segmentKind}:${index}`;
    const segment = item.segments!.get(segmentKey) ?? { kind: segmentKind, index, text: "" };
    segment.text += notification.params.delta;
    item.segments!.set(segmentKey, segment);
    item.text = assembled(item);
  }
  const message = messageFor(actor, item);
  emit(actor, { type: "message_update", entryId: item.id, message, assistantMessageEvent: { type: kind === "reasoning" ? "thinking_delta" : "text_delta", contentIndex: 0, delta: notification.params.delta, partial: message } });
}
function onNotification(getActor: () => Actor | undefined, raw: { method: string; params?: unknown }) {
  const actor = getActor();
  if (actor && (raw.method === "thread/settings/updated" || methods.has(raw.method as NativeMethod))
    && deferCodexNativeMutation(actor, () => onNotification(() => actor, raw))) return;
  if (raw.method === "thread/settings/updated") {
    if (!actor || actor.state.kind !== "ready") return;
    const result = validators.validate("thread/settings/updated", raw.params);
    if (result.state !== "valid") { fatal(actor); return; }
    if (result.value.threadId.toLowerCase() !== actor.state.threadId.toLowerCase()) return;
    const settings = result.value.threadSettings;
    if (settings.cwd !== actor.cwd || !settings.model || !settings.modelProvider) { fatal(actor); return; }
    const extra = extras.get(actor)!;
    extra.settings = { backend: "codex", model: settings.model, modelProvider: settings.modelProvider, effort: settings.effort ?? null };
    extra.thread = { ...extra.thread, model: settings.model, modelProvider: settings.modelProvider };
    extra.settingsUncertain = false;
    emit(actor, { type: "session_settings", settings: extra.settings });
    if (extra.settingsPending?.sent && extra.settingsPending.transport === actor.state.transport) extra.settingsPending.resolve(extra.settings);
    return;
  }
  if (!methods.has(raw.method as NativeMethod)) return;
  if (!actor) return;
  const method = raw.method as NativeMethod;
  const params = method === "item/mcpToolCall/progress" && raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
    ? { ...(raw.params as Record<string, unknown>), delta: (raw.params as Record<string, unknown>).message }
    : raw.params;
  // The pinned CLI's command-output and MCP-progress schemas have the same four string fields as this validator.
  const result = validators.validate(method === "item/commandExecution/outputDelta" || method === "item/mcpToolCall/progress" ? "item/agentMessage/delta" : method, params);
  if (result.state !== "valid") { fatal(actor); return; }
  const notification = { method, params: result.value } as NativeNotification;
  const compact = extras.get(actor)?.operation;
  if (compact?.kind === "compact") {
    if (notification.method === "turn/started" || notification.method === "turn/completed" || notification.method === "item/started" || notification.method === "item/completed" || notification.method === "error") {
      observeCompaction(compact.progress, notification, actor.state.kind === "ready" ? actor.state.threadId : "");
    }
    return;
  }
  handleNotification(actor, notification);
}
function scheduleHealth(actor: Actor) {
  const extra = extras.get(actor)!;
  clearHealth(actor);
  extra.timer = setTimeout(async () => {
    if (actor.state.kind !== "ready" || (actor.state.turn.kind === "idle" && extra.operation?.kind !== "compact")) return;
    const state = actor.state;
    try {
      const payload = validate("thread/read", await state.transport.request(ClientMethod.threadRead, { threadId: state.threadId, includeTurns: false }, { timeoutMs: 5000 }));
      if (payload.thread.id.toLowerCase() !== state.threadId.toLowerCase()) throw new CodexTransportError("protocol");
      if (actor.state === state && (state.turn.kind !== "idle" || extra.operation?.kind === "compact")) scheduleHealth(actor);
    } catch { fatal(actor); }
  }, 10000);
  extra.timer.unref();
}
function actorFor(thread: CodexThread, transport: CodexTransport, settings: CodexEffectiveSettings, options: ActorOptions): Actor {
  const sessionId = codexWebSessionId(thread.id) as WebId;
  const actor: Actor = { sessionId, cwd: thread.cwd, state: { kind: "ready", transport, threadId: thread.id as ThreadId, turn: { kind: "idle" } }, listeners: new Set() };
  extras.set(actor, { options, thread: { ...thread, model: settings.model, modelProvider: settings.modelProvider }, settings, requestTimeoutMs: options.requestTimeoutMs ?? 10000, interactions: new Set() });
  installCleanup();
  return actor;
}
function nativeFailure(error: unknown): Failure {
  if (error instanceof CodexTransportError && error.kind === "rpc" && typeof error.code === "number") return { kind: "native-rejected", code: error.code, message: "Codex rejected the request" };
  return generic("transport-fatal", "Codex transport failed");
}
function definite(error: unknown): number | null {
  return error instanceof CodexTransportError && error.kind === "rpc" && (error.code === -32600 || error.code === -32601 || error.code === -32602) ? error.code : null;
}

function settingsFromResponse(response: CodexPayloads["thread/start:response"]): CodexEffectiveSettings {
  if (!response.model || !response.modelProvider) throw new CodexTransportError("protocol");
  return { backend: "codex", model: response.model, modelProvider: response.modelProvider, effort: response.reasoningEffort ?? null };
}

async function modelsFromTransport(transport: CodexTransport): Promise<CodexModelChoice[]> {
  const rows: CodexModelChoice[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const signal = AbortSignal.timeout(30000);
  for (let page = 0; page < 100; page++) {
    const params = { limit: 100, ...(cursor === undefined ? {} : { cursor }) };
    validate("model/list:request", params);
    const response = validate("model/list:response", await transport.request(ClientMethod.modelList, params, { signal, timeoutMs: 10000 }));
    for (const entry of response.data) {
      rows.push({ id: entry.id, model: entry.model, label: entry.displayName, isDefault: entry.isDefault,
        efforts: entry.supportedReasoningEfforts.map(row => ({ value: row.reasoningEffort, description: row.description })), defaultEffort: entry.defaultReasoningEffort });
    }
    if (rows.length > 10000) throw new CodexTransportError("protocol");
    if (response.nextCursor == null) return parseCodexModels(rows);
    cursor = response.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new CodexTransportError("protocol");
    cursors.add(cursor);
  }
  throw new CodexTransportError("protocol");
}

export async function codexModels(cwd: string, actor?: Actor, options: ActorOptions = {}): Promise<Result<CodexModelChoice[]>> {
  return withActorWork(actor, async () => {
    if (!isAbsolute(cwd) || normalize(cwd) !== cwd || (actor && actor.cwd !== cwd)) return fail(generic("invalid", "Invalid Codex catalogue scope"));
    let transport: CodexTransport | undefined;
    try {
      if (!(await stat(cwd)).isDirectory()) return fail(generic("invalid", "Invalid project directory"));
      if (actor) {
        if (actor.state.kind !== "ready") return fail(generic("closed", "Codex session is closed"));
        return ok(await modelsFromTransport(actor.state.transport));
      }
      transport = await startCodexTransport({ ...options, cwd, requestTimeoutMs: 10000, shutdownTimeoutMs: 500 });
      return ok(await modelsFromTransport(transport));
    } catch { return fail(generic("transport-fatal", "Codex catalogue is unavailable")); }
    finally { await transport?.shutdown(); }
  });
}

export async function codexSkills(cwd: string, actor?: Actor, options: ActorOptions = {}): Promise<Result<CodexSkillsInventory>> {
  return withActorWork(actor, async () => {
    if (!isAbsolute(cwd) || normalize(cwd) !== cwd) return fail(generic("invalid", "Invalid Codex skills scope"));
    try {
      if (!(await stat(cwd)).isDirectory() || (actor && await realpath(actor.cwd) !== await realpath(cwd))) return fail(generic("invalid", "Invalid Codex skills scope"));
    } catch { return fail(generic("invalid", "Invalid project directory")); }
    let transport: CodexTransport | undefined;
    try {
      if (actor) {
        if (actor.state.kind !== "ready") return fail(generic("closed", "Codex session is closed"));
        return ok(await readCodexSkills(actor.state.transport, cwd));
      }
      transport = await startCodexTransport({ ...options, cwd, shutdownTimeoutMs: 500 });
      return ok(await readCodexSkills(transport, cwd));
    } catch { return fail(generic("transport-fatal", "Native skills inventory is unavailable")); }
    finally { await transport?.shutdown(); }
  });
}

export async function codexMcp(actor: Actor): Promise<Result<CodexMcpInventory>> {
  return withActorWork(actor, async () => {
    if (actor.state.kind !== "ready") return fail(generic("closed", "Codex session is closed"));
    try { return ok(await readCodexMcp(actor.state.transport, actor.state.threadId, actor.sessionId)); }
    catch { return fail(generic("transport-fatal", "Native MCP inventory is unavailable")); }
  });
}

export async function forkCodexSession(actor: Actor): Promise<Result<CodexThread>> {
  try { return await withCodexMutationAdmission(actor.sessionId, () => forkCodexSessionImpl(actor)); }
  catch (error) { return captureConflict(error); }
}

async function forkCodexSessionImpl(actor: Actor): Promise<Result<CodexThread>> {
  if (actor.state.kind !== "ready") return fail(generic("closed", "Codex session is closed"));
  const state = actor.state;
  const extra = extras.get(actor)!;
  if (state.turn.kind !== "idle" || extra.settingsPending || extra.operation) return fail(generic("conflict", "Codex session is busy"));
  if (extra.settingsUncertain) return fail({ kind: "outcome-unknown", operation: "settings" });
  const operation: Operation = { kind: "fork" };
  extra.operation = operation;
  let sent = false;
  try {
    const directoryFailure = await projectDirectoryFailure(actor.cwd);
    if (directoryFailure) return fail(directoryFailure);
    if (actor.state !== state) return fail(generic("closed", "Codex session is closed"));
    const thread = await forkCodexThread({ threadId: state.threadId, cwd: actor.cwd, settings: extra.settings, options: extra.options,
      onSent: () => { if (actor.state !== state) throw new CodexTransportError("closed"); sent = true; } });
    return ok(thread);
  } catch (error) {
    return sent && !(error instanceof CodexTransportError && error.kind === "rpc") ? fail({ kind: "outcome-unknown", operation: "fork" }) : fail(nativeFailure(error));
  } finally { if (extra.operation === operation) extra.operation = undefined; }
}

export async function compactCodexSession(actor: Actor): Promise<Result<{ turnId: string }>> {
  try { return await withCodexMutationAdmission(actor.sessionId, () => compactCodexSessionImpl(actor)); }
  catch (error) { return captureConflict(error); }
}

async function compactCodexSessionImpl(actor: Actor): Promise<Result<{ turnId: string }>> {
  if (actor.state.kind !== "ready") return fail(generic("closed", "Codex session is closed"));
  const state = actor.state;
  const extra = extras.get(actor)!;
  if (state.turn.kind !== "idle" || extra.settingsPending || extra.operation) return fail(generic("conflict", "Codex session is busy"));
  if (extra.settingsUncertain) return fail({ kind: "outcome-unknown", operation: "settings" });
  let resolve!: CompactionProgress["resolve"];
  const completion = new Promise<Parameters<CompactionProgress["resolve"]>[0]>(done => { resolve = done; });
  const progress: CompactionProgress = { sent: false, baseline: new Set(), lifecycle: { kind: "waiting" }, resolve };
  const operation: Operation = { kind: "compact", progress };
  extra.operation = operation;
  emit(actor, { type: "compaction_start" });
  scheduleHealth(actor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errorMessage: string | undefined;
  try {
    const directoryFailure = await projectDirectoryFailure(actor.cwd);
    if (directoryFailure) { errorMessage = "Native compaction could not start"; return fail(directoryFailure); }
    if (actor.state !== state) return fail(generic("closed", "Codex session is closed"));
    const before = validate("thread/read", await state.transport.request(ClientMethod.threadRead, { threadId: state.threadId, includeTurns: true }));
    if (before.thread.id.toLowerCase() !== state.threadId.toLowerCase() || actor.state !== state) throw new CodexTransportError("closed");
    progress.baseline = new Set(before.thread.turns.map(turn => turn.id));
    const params = { threadId: state.threadId };
    validate("thread/compact/start:request", params);
    timer = setTimeout(() => resolve(null), extra.options.requestTimeoutMs ?? 180000);
    progress.sent = true;
    validate("thread/compact/start:response", await state.transport.request(ClientMethod.threadCompact, params));
    const settled = await completion;
    if (!settled || actor.state !== state) throw new CodexTransportError("closed");
    if (settled.status !== "completed") {
      errorMessage = "Native compaction failed";
      return fail(generic("conflict", errorMessage));
    }
    const after = validate("thread/read", await state.transport.request(ClientMethod.threadRead, { threadId: state.threadId, includeTurns: true }));
    if (after.thread.id.toLowerCase() !== state.threadId.toLowerCase() || !compactionPersisted(after.thread, settled)) throw new CodexTransportError("protocol");
    return ok({ turnId: settled.turnId });
  } catch (error) {
    errorMessage = progress.sent ? "Native compaction outcome is unknown. Reload to inspect native history." : "Native compaction could not start";
    if (progress.sent && !(error instanceof CodexTransportError && error.kind === "rpc")) {
      await shutdownCodexSession(actor);
      return fail({ kind: "outcome-unknown", operation: "compact" });
    }
    return fail(nativeFailure(error));
  } finally {
    if (timer) clearTimeout(timer);
    if (extra.operation === operation) extra.operation = undefined;
    clearHealth(actor);
    if (actor.state === state) emit(actor, { type: "compaction_end", ...(errorMessage ? { errorMessage } : {}) });
  }
}

async function updateCodexSettingsImpl(actor: Actor, selection: CodexSelection): Promise<Result<CodexEffectiveSettings>> {
  if (!selection.model || !selection.effort) return fail(generic("invalid", "A complete Codex selection is required"));
  if (actor.state.kind !== "ready") return fail(generic("closed", "Codex session is closed"));
  const state = actor.state;
  const extra = extras.get(actor)!;
  if (state.turn.kind !== "idle" || extra.settingsPending || extra.operation) return fail(generic("conflict", "Codex session is busy"));
  if (extra.settingsUncertain) return fail({ kind: "outcome-unknown", operation: "settings" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveNotification!: SettingsPending["resolve"];
  const notification = new Promise<CodexEffectiveSettings | null>(resolve => { resolveNotification = resolve; });
  const pending: SettingsPending = { sent: false, transport: state.transport, resolve: resolveNotification };
  extra.settingsPending = pending;
  let sent = false;
  const uncertain = async (): Promise<Result<CodexEffectiveSettings>> => {
    extra.settingsUncertain = true;
    await shutdownCodexSession(actor);
    return fail({ kind: "outcome-unknown", operation: "settings" });
  };
  try {
    const directoryFailure = await projectDirectoryFailure(actor.cwd);
    if (directoryFailure) return fail(directoryFailure);
    if (actor.state !== state) return fail(generic("closed", "Codex session is closed"));
    const catalogue = await modelsFromTransport(state.transport);
    const model = catalogue.find(row => row.model === selection.model);
    if (!model || !model.efforts.some(row => row.value === selection.effort)) return fail(generic("invalid", "Codex selection is not in the current catalogue"));
    if (actor.state !== state) return fail(generic("closed", "Codex session is closed"));
    const params = { threadId: state.threadId, ...selection };
    validate("thread/settings/update:request", params);
    sent = true;
    pending.sent = true;
    timer = setTimeout(() => pending.resolve(null), extra.requestTimeoutMs);
    validate("thread/settings/update:response", await state.transport.request(ClientMethod.threadSettingsUpdate, params, { timeoutMs: extra.requestTimeoutMs }));
    const settings = await notification;
    if (!settings || actor.state !== state) {
      return uncertain();
    }
    return ok(settings);
  } catch (error) {
    if (!sent || (error instanceof CodexTransportError && error.kind === "rpc")) return fail(nativeFailure(error));
    return uncertain();
  } finally {
    if (timer) clearTimeout(timer);
    if (extra.settingsPending === pending) extra.settingsPending = undefined;
  }
}

export async function updateCodexSettings(actor: Actor, selection: CodexSelection): Promise<Result<CodexEffectiveSettings>> {
  try { return await withCodexMutationAdmission(actor.sessionId, () => updateCodexSettingsImpl(actor, selection)); }
  catch (error) { return captureConflict(error); }
}

async function createCodexSessionImpl(input: CreateInput, options: ActorOptions = {}, kind: "create" | "handoff-create" = "create"): Promise<Result<Actor>> {
  if (!parseCodexRequestId(input.requestId) || !isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd || (input.model !== undefined && (typeof input.model !== "string" || !input.model)) || (input.effort !== undefined && (!input.model || typeof input.effort !== "string" || !input.effort))) return fail(generic("invalid", "Invalid create request"));
  const directoryFailure = await projectDirectoryFailure(input.cwd);
  if (directoryFailure) return fail(directoryFailure);
  const params = { cwd: input.cwd, ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { config: { model_reasoning_effort: input.effort } } : {}) };
  try { validate("thread/start:request", params); } catch { return fail(generic("invalid", "Invalid create request")); }
  let transport: CodexTransport | undefined;
  const holder: { actor?: Actor } = {};
  let thread: CodexThread | undefined;
  let settings: CodexEffectiveSettings | undefined;
  const result = await runCodexMutationOnce({ kind, requestId: input.requestId, scope: input.cwd, digest: input.effort === undefined ? digest(["codex-create-v1", input.cwd, input.model ?? null]) : digest(["codex-create-v2", input.cwd, input.model ?? null, input.effort]) }, async () => {
    transport = await startCodexTransport({ ...options, cwd: input.cwd, interactionTimeoutMs: 86_400_000, serverRequests: interactionHandlers(() => holder.actor), onNotification: raw => onNotification(() => holder.actor, raw), onFailure: () => onTransportFailure(holder.actor) });
    try {
      if (input.model !== undefined) {
        const catalogue = await modelsFromTransport(transport);
        const model = catalogue.find(entry => entry.model === input.model);
        if (!model || (input.effort !== undefined && !model.efforts.some(row => row.value === input.effort))) return { kind: "rejected", code: -32602 };
      }
      const response = validate("thread/start:response", await transport.request(ClientMethod.threadStart, params));
      codexWebSessionId(response.thread.id);
      if (response.thread.cwd !== input.cwd) throw new CodexTransportError("protocol");
      thread = response.thread;
      settings = settingsFromResponse(response);
      return { kind: "accepted", nativeId: thread.id };
    } catch (error) {
      const code = definite(error);
      if (code !== null) return { kind: "rejected", code };
      throw error;
    }
  }).catch(() => ({ kind: "outcome-unknown" as const }));
  if (result.kind !== "accepted") {
    if (transport) await transport.shutdown();
    return result.kind === "conflict" ? fail(generic("conflict", "Request conflicts with an earlier request")) : result.kind === "rejected" ? fail({ kind: "native-rejected", code: result.code, message: "Codex rejected the request" }) : fail({ kind: "outcome-unknown", operation: "create", requestId: input.requestId });
  }
  let id: WebId;
  try { id = codexWebSessionId(result.nativeId) as WebId; } catch { if (transport) await transport.shutdown(); return fail(generic("transport-fatal", "Invalid Codex thread id")); }
  try {
    return await withCodexMutationAdmission(id, async () => {
      const existing = registry.actors.get(id);
      const flight = registry.ensuring.get(id);
      if (existing) { if (transport) await transport.shutdown(); return ok(existing); }
      if (flight) {
        const ensured = await flight;
        if (ensured.ok || !thread || !transport) {
          if (transport) await transport.shutdown();
          if (!ensured.ok && (ensured.error.kind === "resume-refused" || ensured.error.kind === "thread-unavailable")) return fail({ ...ensured.error, sessionId: id });
          return ensured;
        }
      }
      if (!thread || !transport) {
        const ensured = await ensureCodexSession(id, options);
        if (!ensured.ok && (ensured.error.kind === "resume-refused" || ensured.error.kind === "thread-unavailable")) return fail({ ...ensured.error, sessionId: id });
        return ensured;
      }
      if (!transport.isOpen) { await transport.shutdown(); return fail(generic("transport-fatal", "Codex transport failed")); }
      const actor = actorFor(thread, transport, settings!, options);
      holder.actor = actor;
      registry.actors.set(id, actor);
      return ok(actor);
    });
  } catch (error) {
    if (transport) await transport.shutdown();
    return captureConflict(error);
  }
}

export async function createCodexSession(input: CreateInput, options: ActorOptions = {}): Promise<Result<Actor>> {
  return createCodexSessionImpl(input, options);
}

export async function createCodexHandoffSession(input: CreateInput, options: ActorOptions = {}): Promise<Result<Actor>> {
  return createCodexSessionImpl(input, options, "handoff-create");
}

async function ensureCodexSessionImpl(id: WebId, options: ActorOptions = {}): Promise<Result<Actor>> {
  const normalized = parseCodexWebId(id);
  if (!normalized) return fail(generic("invalid", "Invalid Codex session id"));
  const existing = registry.actors.get(normalized);
  if (existing && existing.state.kind === "ready") {
    if (existing.state.transport.isOpen) return ok(existing);
    fatal(existing);
  }
  const flight = registry.ensuring.get(normalized);
  if (flight) return flight;
  const promise = (async (): Promise<Result<Actor>> => {
    let transport: CodexTransport | undefined;
    let actor: Actor | undefined;
    try {
      transport = await startCodexTransport({ ...options, interactionTimeoutMs: 86_400_000, serverRequests: interactionHandlers(() => actor), onNotification: raw => onNotification(() => actor, raw), onFailure: () => onTransportFailure(actor) });
      const threadId = nativeCodexSessionId(normalized);
      let read: CodexPayloads["thread/read"];
      try { read = validate("thread/read", await transport.request(ClientMethod.threadRead, { threadId, includeTurns: false })); }
      catch (error) {
        if (error instanceof CodexTransportError && error.kind === "rpc" && error.code === -32600) return fail({ kind: "thread-unavailable", code: -32600, message: "Codex thread is unavailable" });
        return fail(nativeFailure(error));
      }
      if (read.thread.id.toLowerCase() !== threadId || !isAbsolute(read.thread.cwd)) return fail(generic("transport-fatal", "Invalid Codex thread"));
      const directoryFailure = await projectDirectoryFailure(read.thread.cwd);
      if (directoryFailure) return fail(directoryFailure);
      await transport.shutdown();
      transport = await startCodexTransport({ ...options, cwd: read.thread.cwd, interactionTimeoutMs: 86_400_000, serverRequests: interactionHandlers(() => actor), onNotification: raw => onNotification(() => actor, raw), onFailure: () => onTransportFailure(actor) });
      let resumed: CodexPayloads["thread/resume:response"];
      try { resumed = validate("thread/resume:response", await transport.request(ClientMethod.threadResume, { threadId })); }
      catch (error) {
        if (error instanceof CodexTransportError && error.kind === "rpc" && error.code === -32600) return fail({ kind: "resume-refused", code: -32600, message: "Codex refused to resume the thread" });
        return fail(nativeFailure(error));
      }
      if (resumed.thread.id.toLowerCase() !== threadId || resumed.thread.cwd !== read.thread.cwd) return fail(generic("transport-fatal", "Invalid Codex thread"));
      if (!transport.isOpen) return fail(generic("transport-fatal", "Codex transport failed"));
      actor = actorFor(resumed.thread, transport, settingsFromResponse(resumed), options);
      registry.actors.set(normalized, actor);
      transport = undefined;
      return ok(actor);
    } catch (error) { return fail(nativeFailure(error)); }
    finally { if (transport) await transport.shutdown(); }
  })();
  registry.ensuring.set(normalized, promise);
  try { return await promise; } finally { if (registry.ensuring.get(normalized) === promise) registry.ensuring.delete(normalized); }
}

export async function ensureCodexSession(id: WebId, options: ActorOptions = {}): Promise<Result<Actor>> {
  try { return await withCodexMutationAdmission(id, () => ensureCodexSessionImpl(id, options)); }
  catch (error) { return captureConflict(error); }
}

async function promptCodexSessionImpl(actor: Actor, input: PromptInput, kind: "prompt" | "handoff-prompt" = "prompt"): Promise<Result<PromptAccepted>> {
  if (!parseCodexRequestId(input.requestId) || typeof input.message !== "string" || !input.message.trim()) return fail(generic("invalid", "Invalid prompt request"));
  if (actor.state.kind !== "ready") return fail(actor.state.kind === "error" ? actor.state.failure : generic("closed", "Codex session is closed"));
  const state = actor.state;
  if (!state.transport.isOpen) { fatal(actor); return fail(generic("transport-fatal", "Codex transport failed")); }
  const extra = extras.get(actor)!;
  if (extra.settingsPending || extra.operation) return fail(generic("conflict", "Codex session is busy"));
  if (extra.settingsUncertain) return fail({ kind: "outcome-unknown", operation: "settings" });
  const requestDigest = digest([kind === "prompt" ? "codex-prompt-v1" : "codex-handoff-prompt-v1", actor.sessionId, input.message]);
  if (state.turn.kind !== "idle") {
    if (extra.active?.requestId === input.requestId && extra.active.digest === requestDigest) return extra.active.promise;
    return fail(generic("conflict", "Codex session is busy"));
  }
  const params = { threadId: state.threadId, input: [{ type: "text", text: input.message, text_elements: [] }] };
  try { validate("turn/start:request", params); } catch { return fail(generic("invalid", "Invalid prompt request")); }
  let resolveCompletion!: Waiter;
  const completion = new Promise<TurnEnd>(resolve => { resolveCompletion = resolve; });
  const starting: Extract<TurnState, { kind: "starting" }> = { kind: "starting", requestId: input.requestId, stopRequested: false, early: [], waiters: new Set([resolveCompletion]) };
  state.turn = starting;
  scheduleHealth(actor);
  const promise = (async (): Promise<Result<PromptAccepted>> => {
    const directoryFailure = await projectDirectoryFailure(actor.cwd);
    if (directoryFailure || actor.state !== state || !state.transport.isOpen) {
      if (actor.state === state && state.turn === starting) { state.turn = { kind: "idle" }; clearHealth(actor); }
      settle(starting, { kind: "failed" });
      return fail(directoryFailure ?? generic("closed", "Codex session is closed"));
    }
    let executed = false;
    const result = await runCodexMutationOnce({ kind, requestId: input.requestId, scope: actor.sessionId, digest: requestDigest }, async () => {
      executed = true;
      try {
        const response = validate("turn/start:response", await state.transport.request(ClientMethod.turnStart, params));
        if (!validNativeId(response.turn.id)) throw new CodexTransportError("protocol");
        return { kind: "accepted", nativeId: response.turn.id };
      } catch (error) {
        const code = definite(error);
        if (code !== null) return { kind: "rejected", code };
        throw error;
      }
    }).catch(() => ({ kind: "outcome-unknown" as const }));
    if (result.kind !== "accepted") {
      cancelInteractions(actor, "aborted");
      if (actor.state === state && state.turn === starting) { state.turn = { kind: "idle" }; clearHealth(actor); }
      settle(starting, { kind: result.kind === "outcome-unknown" ? "transport-fatal" : "failed" });
      if (result.kind === "outcome-unknown") { fatal(actor); return fail({ kind: "outcome-unknown", operation: "prompt", requestId: input.requestId }); }
      if (result.kind === "conflict") return fail(generic("conflict", "Request conflicts with an earlier request"));
      return fail({ kind: "native-rejected", code: result.code, message: "Codex rejected the request" });
    }
    if (!validNativeId(result.nativeId)) { fatal(actor); return fail(generic("transport-fatal", "Invalid Codex turn id")); }
    const turnId = result.nativeId as TurnId;
    if (!executed) {
      if (actor.state === state && state.turn === starting) { state.turn = { kind: "idle" }; clearHealth(actor); }
      settle(starting, { kind: "completed" });
      return ok({ kind: "replayed", turnId });
    }
    if (actor.state !== state || state.turn !== starting) return fail(generic("closed", "Codex session is closed"));
    state.turn = starting.stopRequested
      ? { kind: "stopping", requestId: input.requestId, turnId, items: new Map(), waiters: starting.waiters, errorReported: false }
      : { kind: "running", requestId: input.requestId, turnId, stopRequested: false, items: new Map(), waiters: starting.waiters, errorReported: false };
    emit(actor, { type: "agent_start" });
    emit(actor, { type: "turn_start" });
    if (state.turn.kind === "running") announceInteractions(actor, turnId);
    else cancelInteractions(actor, "cancelled");
    scheduleHealth(actor);
    if (starting.stopRequested && state.turn.kind === "stopping") void interrupt(actor, state, turnId);
    for (const event of starting.early) handleNotification(actor, event);
    return ok({ kind: "live", turnId, completion });
  })();
  extra.active = { requestId: input.requestId, digest: requestDigest, promise, completion };
  void completion.then(() => { if (extra.active?.completion === completion) { extra.active = undefined; scheduleIdle(actor); } });
  return promise;
}

export async function promptCodexSession(actor: Actor, input: PromptInput): Promise<Result<PromptAccepted>> {
  try { return await withCodexMutationAdmission(actor.sessionId, () => promptCodexSessionImpl(actor, input)); }
  catch (error) { return captureConflict(error); }
}

export async function promptCodexHandoffSession(actor: Actor, input: PromptInput): Promise<Result<PromptAccepted>> {
  try { return await withCodexMutationAdmission(actor.sessionId, () => promptCodexSessionImpl(actor, input, "handoff-prompt")); }
  catch (error) { return captureConflict(error); }
}

function steerCodexSessionImpl(actor: Actor, input: PromptInput): Promise<Result<{ turnId: TurnId }>> {
  if (!parseCodexRequestId(input.requestId) || typeof input.message !== "string" || !input.message.trim()) return Promise.resolve(fail(generic("invalid", "Invalid steer request")));
  if (actor.state.kind !== "ready") return Promise.resolve(fail(actor.state.kind === "error" ? actor.state.failure : generic("closed", "Codex session is closed")));
  const state = actor.state;
  const turn = state.turn;
  if (turn.kind !== "running") return Promise.resolve(fail(generic("conflict", "Codex turn is not running")));
  const extra = extras.get(actor)!;
  const previous = extra.steer;
  if (previous && previous.turnId !== turn.turnId) extra.steer = undefined;
  const current = extra.steer;
  if (current?.kind === "ambiguous") return Promise.resolve(fail({ kind: "outcome-unknown", operation: "steer", turnId: turn.turnId }));
  const requestDigest = digest([input.message]);
  if (current?.kind === "pending") return current.requestId === input.requestId && current.digest === requestDigest ? current.promise : Promise.resolve(fail(generic("conflict", "Codex steer is busy")));
  const params = { threadId: state.threadId, expectedTurnId: turn.turnId, input: [{ type: "text", text: input.message, text_elements: [] }] };
  try { validate("turn/steer:request", params); } catch { return Promise.resolve(fail(generic("invalid", "Invalid steer request"))); }
  const pending: Extract<SteerState, { kind: "pending" }> = { kind: "pending", turnId: turn.turnId, requestId: input.requestId, digest: requestDigest, promise: undefined! };
  extra.steer = pending;
  pending.promise = (async () => {
    try {
      const directoryFailure = await projectDirectoryFailure(actor.cwd);
      if (directoryFailure || actor.state !== state || state.turn !== turn) {
        if (extra.steer === pending) extra.steer = undefined;
        return fail<{ turnId: TurnId }>(directoryFailure ?? generic("conflict", "Codex turn is not running"));
      }
      const response = validate("turn/steer:response", await state.transport.request(ClientMethod.turnSteer, params));
      if (response.turnId !== turn.turnId) throw new CodexTransportError("protocol");
      if (extra.steer === pending) extra.steer = undefined;
      return ok({ turnId: turn.turnId });
    } catch (error) {
      if (error instanceof CodexTransportError && error.kind === "rpc") {
        if (extra.steer === pending) extra.steer = undefined;
        return fail<{ turnId: TurnId }>(nativeFailure(error));
      }
      if (extra.steer === pending) {
        extra.steer = { kind: "ambiguous", turnId: turn.turnId };
        emit(actor, { type: "error", error: "Codex steer outcome is unknown", code: "outcome_unknown" });
      }
      return fail<{ turnId: TurnId }>({ kind: "outcome-unknown", operation: "steer", turnId: turn.turnId });
    }
  })();
  return pending.promise;
}

export function steerCodexSession(actor: Actor, input: PromptInput): Promise<Result<{ turnId: TurnId }>> {
  try { return withCodexMutationAdmission(actor.sessionId, () => steerCodexSessionImpl(actor, input)); }
  catch (error) { return Promise.resolve(captureConflict(error)); }
}

async function interrupt(actor: Actor, state: Extract<ActorState, { kind: "ready" }>, turnId: TurnId) {
  try {
    const params = { threadId: state.threadId, turnId };
    validate("turn/interrupt:request", params);
    validate("turn/interrupt:response", await state.transport.request(ClientMethod.turnInterrupt, params));
  } catch { fatal(actor); }
}

async function stopCodexSessionImpl(actor: Actor): Promise<Result<StopResult>> {
  if (actor.state.kind !== "ready") return fail(actor.state.kind === "error" ? actor.state.failure : generic("closed", "Codex session is closed"));
  const state = actor.state;
  if (extras.get(actor)!.operation?.kind === "compact") return fail(generic("conflict", "Native compaction cancellation is not supported"));
  const turn = state.turn;
  if (turn.kind === "idle") return ok({ stopped: false, completion: null });
  cancelInteractions(actor, "cancelled");
  const completion = new Promise<TurnEnd>(resolve => turn.waiters.add(resolve));
  if (turn.kind === "starting") turn.stopRequested = true;
  else if (turn.kind === "running") {
    state.turn = { kind: "stopping", requestId: turn.requestId, turnId: turn.turnId, items: turn.items, waiters: turn.waiters, errorReported: turn.errorReported };
    void interrupt(actor, state, turn.turnId);
  }
  if (turn.kind === "starting") await extras.get(actor)!.active?.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([completion, new Promise<TurnEnd>(resolve => { timer = setTimeout(() => resolve({ kind: "stopped" }), 30000); })]);
  if (timer) clearTimeout(timer);
  if (result.kind === "stopped") await shutdownCodexSession(actor);
  return ok({ stopped: true, completion: result });
}

export async function stopCodexSession(actor: Actor): Promise<Result<StopResult>> {
  try { return await withCodexMutationAdmission(actor.sessionId, () => stopCodexSessionImpl(actor)); }
  catch (error) { return captureConflict(error); }
}

async function shutdownCodexSessionImpl(actor: Actor): Promise<void> {
  const extra = extras.get(actor);
  if (extra?.shutdown) return extra.shutdown;
  if (actor.state.kind === "closed" || actor.state.kind === "error") return;
  const previous = actor.state;
  if (extra) cancelInteractions(actor, "session_closed");
  actor.state = { kind: "closing" };
  if (extra) {
    extra.steer = undefined;
    extra.settingsPending?.resolve(null);
    if (extra.operation?.kind === "compact") {
      extra.operation.progress.resolve(null);
      emit(actor, { type: "compaction_end", errorMessage: "Native compaction was interrupted. Reload to inspect native history." });
    }
  }
  clearHealth(actor);
  clearIdle(actor);
  if (previous.kind === "ready") settle(previous.turn, { kind: "stopped" });
  emit(actor, { type: "session_shutdown" });
  evict(actor);
  const shutdown = (async () => { if (previous.kind === "ready" || previous.kind === "opening") await previous.transport?.shutdown(); actor.state = { kind: "closed" }; })();
  if (extra) extra.shutdown = shutdown;
  return shutdown;
}
export async function shutdownCodexSession(actor: Actor): Promise<void> {
  return withCodexMutationAdmission(actor.sessionId, () => shutdownCodexSessionImpl(actor));
}
export function subscribeCodexSession(actor: Actor, listener: (event: SessionEvent) => void): () => void {
  clearIdle(actor);
  actor.listeners.add(listener);
  listener({ type: "session_settings", settings: extras.get(actor)!.settings });
  if (extras.get(actor)!.operation?.kind === "compact") listener({ type: "compaction_start" });
  for (const group of extras.get(actor)!.interactions) if (group.announced) for (const request of group.requests.values()) listener({ ...request.event });
  return () => { actor.listeners.delete(listener); scheduleIdle(actor); };
}
export function getCodexSession(id: string): Actor | undefined { const key = parseCodexWebId(id); return key ? registry.actors.get(key) : undefined; }
export function codexSessionInfo(actor: Actor) {
  const projected = projectCodexSessionInfo(extras.get(actor)!.thread);
  if (projected.state !== "projected") throw new Error(`Codex session metadata ${projected.reason}`);
  return projected.info;
}
export function getCodexSessionInfos() {
  return [...registry.actors.values()].filter((actor) => actor.state.kind === "ready").map(codexSessionInfo);
}
export function codexTurnSnapshot(actor: Actor) {
  const turn = actor.state.kind === "ready" ? actor.state.turn : undefined;
  if (!turn || (turn.kind !== "running" && turn.kind !== "stopping")) return undefined;
  return { turnId: turn.turnId, items: [...turn.items.values()].filter(item => item.started).map(item => ({ id: item.id, message: messageFor(actor, item), completed: item.completed })) };
}
export function codexSessionState(actor: Actor) {
  const active = actor.state.kind === "ready" && actor.state.turn.kind !== "idle";
  const isCompacting = extras.get(actor)!.operation?.kind === "compact";
  return { backend: "codex", isCompacting, capabilities: CODEX_CAPABILITIES, settings: extras.get(actor)!.settings, settingsPending: Boolean(extras.get(actor)!.settingsPending), settingsUncertain: Boolean(extras.get(actor)!.settingsUncertain), isStreaming: active, isPromptRunning: active };
}
export function codexLeaseState(actor: Actor) {
  const extra = extras.get(actor);
  const alive = actor.state.kind === "ready" && Boolean(extra);
  return {
    alive,
    running: Boolean(alive && (actor.state.kind === "ready" && actor.state.turn.kind !== "idle" || extra!.operation || extra!.settingsPending)),
    awaitingInput: Boolean(alive && [...extra!.interactions].some(group => group.announced && group.requests.size > 0)),
  };
}
