import {
  query as sdkQuery,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantContentBlock, AssistantMessage } from "../types";
import { acquireClaudeWriterLock, type ReleaseClaudeWriterLock } from "./claude-lock";
import { resolveClaudeExecutable, sanitizeClaudeEnvironment } from "./claude-executable";
import {
  buildClaudeUserMessage,
  claudeModelRow,
  parseClaudeEffort,
  parseClaudePermissionMode,
  parseClaudeQuestions,
  stringField,
} from "./claude-input";
export { sanitizeClaudeEnvironment } from "./claude-executable";
import { readClaudeConfiguration } from "./claude-config";
import { isRecord, projectSdkAssistant, projectSdkUser } from "./claude-projection";
import {
  CLAUDE_CAPABILITIES,
  type AgentInteractionRequest,
  type ClaudeConfigurationSummary,
  type ClaudeSessionInfo,
} from "./types";

export interface ClaudeAgentEvent {
  type: string;
  [key: string]: unknown;
}

function projectClaudeCommands(values: unknown[], terminalOnlyNames: readonly string[] = []): Record<string, unknown>[] {
  const terminalOnly = new Set(terminalOnlyNames);
  const byName = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    if (!isRecord(value) || typeof value.name !== "string" || terminalOnly.has(value.name)) continue;
    const row = {
      name: value.name,
      description: typeof value.description === "string" ? value.description : "",
      argumentHint: typeof value.argumentHint === "string" ? value.argumentHint : "",
      source: value.builtin === true ? "extension" : "skill",
    };
    const existing = byName.get(value.name);
    if (!existing || value.builtin === true) byName.set(value.name, row);
  }
  return [...byName.values()];
}

type EventListener = (event: ClaudeAgentEvent) => void;
type Lifecycle = "dormant" | "idle" | "running" | "awaiting-input" | "closing" | "closed";

class AsyncInputQueue implements AsyncIterable<SDKUserMessage> {
  private rows: SDKUserMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.rows.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const row = this.rows.shift();
        if (row) return Promise.resolve({ done: false, value: row });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingInteraction {
  request: AgentInteractionRequest;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export class ClaudeConflictError extends Error {
  readonly status = 409;
}

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<{ still_queued: string[] } | undefined>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  initializationResult(): Promise<unknown>;
  supportedCommands(): Promise<unknown[]>;
  supportedModels(): Promise<ModelInfo[]>;
  close(): void;
}

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

export interface ClaudeRuntimeDependencies {
  query: ClaudeQueryFactory;
  acquireLock: (nativeSessionId: string) => Promise<ReleaseClaudeWriterLock>;
  getConfiguration: (cwd: string) => Promise<ClaudeConfigurationSummary>;
  resolveExecutable?: (env: NodeJS.ProcessEnv) => Promise<string>;
  executablePath?: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  idleTimeoutMs: number;
  interruptTimeoutMs: number;
}

const DEFAULT_DEPENDENCIES: ClaudeRuntimeDependencies = {
  query: (params) => sdkQuery(params),
  acquireLock: acquireClaudeWriterLock,
  getConfiguration: readClaudeConfiguration,
  resolveExecutable: resolveClaudeExecutable,
  env: process.env,
  now: Date.now,
  idleTimeoutMs: 30 * 60_000,
  interruptTimeoutMs: 5_000,
};

export interface ClaudeSessionCreateOptions {
  modelId?: string;
  effort?: string;
  permissionMode?: string;
  requestId?: string;
  trustProject?: boolean;
}

export interface ClaudeRuntimeOptions extends ClaudeSessionCreateOptions {
  existing: boolean;
  side?: boolean;
}

export class ClaudeSessionWrapper {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionFile: null = null;
  readonly nativeSessionId: string;
  private lifecycle: Lifecycle = "dormant";
  private readonly listeners = new Set<EventListener>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly acceptedRequests = new Map<string, Promise<unknown>>();
  private readonly backgroundTasks = new Map<string, { ambient: boolean }>();
  private readonly toolNames = new Map<string, string>();
  private queryInstance: ClaudeQuery | null = null;
  private inputQueue: AsyncInputQueue | null = null;
  private abortController: AbortController | null = null;
  private releaseLock: ReleaseClaudeWriterLock | null = null;
  private pump: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private startupCancellation: "stop" | "close" | null = null;
  private mutationReserved = false;
  private resumeOnNextStart: boolean;
  private trusted: boolean;
  private promptAccepted = false;
  private initialized: SDKSystemMessage | null = null;
  private assistantId: string | null = null;
  private currentAssistant: AssistantMessage | null = null;
  private queuedFollowUps: Array<{ id: string; text: string }> = [];
  private lastTurnAborted = false;
  private activeStartedAt: number | null = null;
  private accumulatedActiveMs = 0;
  private latestResultUsage: Record<string, unknown> | undefined;
  private selectedModel: string | undefined;
  private selectedEffort: EffortLevel | undefined;
  private lastEventAt: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    nativeSessionId: string,
    cwd: string,
    private readonly options: ClaudeRuntimeOptions,
    private readonly dependencies: ClaudeRuntimeDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.nativeSessionId = nativeSessionId;
    this.sessionId = "claude:" + nativeSessionId;
    this.cwd = cwd;
    this.trusted = options.trustProject === true;
    this.selectedModel = options.modelId;
    this.selectedEffort = parseClaudeEffort(options.effort);
    if (options.effort !== undefined && !this.selectedEffort) throw new Error("Unsupported Claude effort level");
    this.resumeOnNextStart = options.existing;
    this.lastEventAt = dependencies.now();
  }

  get isStreaming(): boolean {
    return this.lifecycle === "running" || this.lifecycle === "awaiting-input";
  }

  get streamingMessage(): AssistantMessage | null {
    return this.currentAssistant;
  }

  isAlive(): boolean {
    return this.lifecycle !== "closed";
  }

  isRunning(): boolean {
    return this.lifecycle === "running";
  }

  isAwaitingInput(): boolean {
    return this.lifecycle === "awaiting-input";
  }

  isSideSession(): boolean {
    return this.options.side === true;
  }

  isProvisionalUnaccepted(): boolean {
    return !this.options.existing && !this.promptAccepted;
  }

  hasActiveSubagents(): boolean {
    for (const task of this.backgroundTasks.values()) if (!task.ambient) return true;
    return false;
  }

  hasDeletionConflict(): boolean {
    return this.startPromise !== null || this.isRunning() || this.isAwaitingInput() || this.hasActiveSubagents() || this.lifecycle === "closing";
  }

  renewIdleTimer(): void {
    this.lastEventAt = this.dependencies.now();
    this.armIdleTimer();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    if (this.currentAssistant) listener({ type: "message_start", message: this.currentAssistant, nativeMessageId: this.assistantId });
    for (const pending of this.pendingInteractions.values()) listener({ ...pending.request });
    return () => this.listeners.delete(listener);
  }

  getInfo(): ClaudeSessionInfo {
    const instant = new Date(this.lastEventAt).toISOString();
    return {
      path: this.sessionId,
      id: this.sessionId,
      cwd: this.cwd,
      created: instant,
      modified: instant,
      messageCount: 0,
      firstMessage: "",
      transient: !this.options.existing,
      backend: "claude",
      nativeSessionId: this.nativeSessionId,
      capabilities: CLAUDE_CAPABILITIES,
    };
  }

  getTotalActiveMs(): number {
    return this.accumulatedActiveMs + (this.activeStartedAt === null ? 0 : this.dependencies.now() - this.activeStartedAt);
  }

  async withExclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutationReserved || this.hasDeletionConflict()) {
      throw new ClaudeConflictError("Claude session is busy");
    }
    this.mutationReserved = true;
    try {
      return await operation();
    } finally {
      this.mutationReserved = false;
    }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (this.mutationReserved) throw new ClaudeConflictError("Claude session metadata is being changed");
    const deduplicated = command.type === "prompt" || command.type === "follow_up";
    const requestKey = deduplicated && typeof command.requestId === "string" && command.requestId ? command.requestId : undefined;
    if (requestKey) {
      const previous = this.acceptedRequests.get(requestKey);
      if (previous) return previous;
    }
    const result = this.sendOnce(command);
    if (!requestKey) return result;
    const tracked = result.catch((error) => {
      if (this.acceptedRequests.get(requestKey) === tracked) this.acceptedRequests.delete(requestKey);
      throw error;
    });
    this.acceptedRequests.set(requestKey, tracked);
    if (this.acceptedRequests.size > 100) {
      const oldest = this.acceptedRequests.keys().next().value;
      if (oldest) this.acceptedRequests.delete(oldest);
    }
    return tracked;
  }

  private async sendOnce(command: Record<string, unknown>): Promise<unknown> {
    const type = stringField(command, "type");
    switch (type) {
      case "ensure_session":
        if (command.trustProject !== true && !this.trusted) throw new ClaudeConflictError("Claude project trust is required before startup");
        this.trusted = true;
        await this.start();
        return this.state();
      case "prompt":
        return this.prompt(command);
      case "answer_interaction":
        return this.answerInteraction(command);
      case "stop":
      case "abort":
        return this.stop();
      case "get_state":
        return this.state();
      case "get_tools":
        return this.tools();
      case "get_commands":
        return this.commands();
      case "get_models":
        return this.models();
      case "get_config":
        return this.dependencies.getConfiguration(this.cwd);
      case "set_model":
        return this.setModel(command);
      case "effort":
      case "set_effort":
        return this.setEffort(command);
      case "permission_mode":
      case "set_permission_mode":
        return this.setPermissionMode(command);
      case "compact":
        throw new ClaudeConflictError("Claude compaction is unavailable until advertised by the initialized runtime");
      case "steer":
        throw new ClaudeConflictError("Claude does not support Pi steer semantics; use follow_up");
      case "follow_up":
        return this.prompt({ ...command, type: "prompt", streamingBehavior: "followUp" });
      default:
        throw new Error("Unsupported Claude command: " + (type ?? "missing type"));
    }
  }

  private state(): Record<string, unknown> {
    const activeModel = this.initialized?.model ?? this.selectedModel;
    return {
      sessionId: this.sessionId,
      backend: "claude",
      lifecycle: this.lifecycle,
      isStreaming: this.isStreaming,
      running: this.isRunning(),
      awaitingInput: this.isAwaitingInput(),
      subagentsActive: this.hasActiveSubagents(),
      model: activeModel ? { provider: "claude", id: activeModel } : null,
      thinkingLevel: this.initialized?.effort ?? this.selectedEffort ?? "native",
      permissionMode: this.options.side ? "plan-locked-no-tools" : this.initialized?.permissionMode ?? this.options.permissionMode ?? "bypassPermissions",
      queuedMessages: { steering: [], followUp: this.queuedFollowUps.map((row) => row.text) },
      pendingInteractions: [...this.pendingInteractions.values()].map((row) => row.request),
      backgroundTasks: [...this.backgroundTasks].map(([id, task]) => ({ id, ...task })),
      resources: this.initialized ? {
        tools: [...this.initialized.tools],
        commands: [...(this.initialized.slash_commands ?? [])],
        agents: [...(this.initialized.agents ?? [])],
        skills: [...(this.initialized.skills ?? [])],
        mcp: [...(this.initialized.mcp_servers ?? [])],
        plugins: (this.initialized.plugins ?? []).map((plugin) => ({ name: plugin.name, version: plugin.version })),
      } : { status: "session-not-started" },
      capabilities: CLAUDE_CAPABILITIES,
      totalActiveMs: this.getTotalActiveMs(),
      latestResultUsage: this.latestResultUsage,
      usageScope: this.latestResultUsage ? "latest-result-metrics-with-cumulative-query-or-resumed-session-usage" : "unavailable",
      requiresProjectTrust: !this.trusted,
    };
  }

  private async tools(): Promise<Record<string, unknown>> {
    if (!this.initialized) return { tools: [], available: false, reason: "session-not-started" };
    return { tools: [...this.initialized.tools], available: true };
  }

  private async commands(): Promise<Record<string, unknown>> {
    if (!this.queryInstance) {
      if (!this.trusted) return { commands: [], available: false, reason: "project-trust-required" };
      await this.start();
    }
    try {
      const commands = projectClaudeCommands(
        await this.queryInstance!.supportedCommands(),
        this.initialized?.terminal_slash_commands,
      );
      return { commands, available: true };
    } catch {
      throw new Error("Claude command catalogue is unavailable");
    }
  }

  private async models(): Promise<Record<string, unknown>> {
    if (!this.queryInstance && this.trusted) await this.start();
    if (this.queryInstance) {
      try {
        const models = await this.queryInstance.supportedModels();
        return { models: models.map(claudeModelRow), effectiveModel: this.initialized?.model ?? this.selectedModel ?? null, source: "live", complete: true };
      } catch {
        throw new Error("Claude model catalogue is unavailable");
      }
    }
    const config = await this.dependencies.getConfiguration(this.cwd);
    const models = config.model ? [{ value: config.model, displayName: config.model }] : [];
    return { models, effectiveModel: this.selectedModel ?? config.model, source: "settings", complete: false };
  }

  private async prompt(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (command.streamingBehavior === "steer") throw new ClaudeConflictError("Claude does not support Pi steer semantics; use follow_up");
    const promptText = stringField(command, "message")?.trim().toLowerCase() ?? "";
    if (this.options.side && /^\/(?:permissions|allowed-tools|mcp|hooks)(?:\s|$)/.test(promptText)) {
      throw new ClaudeConflictError("Claude side-session security settings cannot be changed");
    }
    if (!this.trusted && command.trustProject !== true) throw new ClaudeConflictError("Claude project trust is required before startup");
    const built = buildClaudeUserMessage(command);
    if (command.trustProject === true) this.trusted = true;
    const running = this.lifecycle === "running" || this.lifecycle === "awaiting-input";
    if (running && command.streamingBehavior !== "followUp") {
      throw new ClaudeConflictError("Claude is running; queue this message with follow_up");
    }
    await this.start();
    if (command.streamingBehavior !== "followUp" && (this.lifecycle === "running" || this.lifecycle === "awaiting-input")) {
      throw new ClaudeConflictError("Claude is running; queue this message with follow_up");
    }
    if (command.streamingBehavior === "followUp") {
      this.queuedFollowUps.push({ id: built.message.uuid ?? "", text: built.text });
      this.emitQueue();
    } else {
      this.markRunning();
      this.emit({ type: "agent_start" });
    }
    const inputQueue = this.inputQueue;
    if (!inputQueue) throw new ClaudeConflictError("Claude startup was cancelled");
    inputQueue.push(built.message);
    this.promptAccepted = true;
    return { accepted: true, requestId: built.message.uuid, queued: command.streamingBehavior === "followUp" };
  }

  private start(): Promise<void> {
    if (this.lifecycle === "closed" || this.lifecycle === "closing") return Promise.reject(new Error("Claude session is closed"));
    if (this.queryInstance) return Promise.resolve();
    if (!this.trusted) return Promise.reject(new ClaudeConflictError("Claude project trust is required before startup"));
    if (this.startPromise) return this.startPromise;
    this.startupCancellation = null;
    const pending = this.startRuntime();
    this.startPromise = pending;
    void pending.finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    }).catch(() => undefined);
    return pending;
  }

  private async startRuntime(): Promise<void> {
    try {
      if (this.dependencies.env.PI_WEB_CLAUDE === "0") {
        throw new ClaudeConflictError("Claude runtime is disabled");
      }
      this.releaseLock = await this.dependencies.acquireLock(this.nativeSessionId);
      this.assertStartupActive();
      this.abortController = new AbortController();
      this.inputQueue = new AsyncInputQueue();
      const executablePath = this.dependencies.resolveExecutable
        ? await this.dependencies.resolveExecutable(this.dependencies.env)
        : this.dependencies.executablePath ?? await resolveClaudeExecutable(this.dependencies.env);
      this.assertStartupActive();
      const configuredEffort = this.selectedEffort;
      const configuredPermission = this.options.side ? "plan" : parseClaudePermissionMode(this.options.permissionMode) ?? "bypassPermissions";
      const sideCanUseTool: CanUseTool = (_toolName, _input, options) => Promise.resolve({
        behavior: "deny",
        message: "Side sessions cannot use tools",
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
      this.assertStartupActive();
      const query = this.dependencies.query({
        prompt: this.inputQueue,
        options: {
          abortController: this.abortController,
          cwd: this.cwd,
          env: sanitizeClaudeEnvironment(this.dependencies.env),
          includePartialMessages: true,
          forwardSubagentText: false,
          pathToClaudeCodeExecutable: executablePath,
          persistSession: true,
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          ...(this.resumeOnNextStart ? { resume: this.nativeSessionId } : { sessionId: this.nativeSessionId }),
          ...(this.selectedModel ? { model: this.selectedModel } : {}),
          ...(configuredEffort ? { effort: configuredEffort } : {}),
          permissionMode: configuredPermission,
          ...(configuredPermission === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          ...(this.options.side ? {
            tools: [],
            strictMcpConfig: true,
            mcpServers: {},
            settings: { disableAllHooks: true },
          } : {}),
          canUseTool: this.options.side
            ? sideCanUseTool
            : (toolName, input, options) => this.requestInteraction(toolName, input, options),
        },
      });
      this.queryInstance = query;
      this.assertStartupActive();
      this.lifecycle = "idle";
      this.pump = this.consume(query);
      await query.initializationResult();
      this.assertStartupActive();
      this.resumeOnNextStart = true;
      this.armIdleTimer();
    } catch (error) {
      this.inputQueue?.close();
      this.abortController?.abort();
      this.queryInstance?.close();
      await this.finishClosedRuntime();
      if (this.startupCancellation) throw new ClaudeConflictError("Claude startup was cancelled");
      if (error instanceof ClaudeConflictError) throw error;
      throw new Error("Claude runtime could not be started");
    }
  }

  private assertStartupActive(): void {
    if (this.startupCancellation || this.lifecycle === "closing" || this.lifecycle === "closed") {
      throw new ClaudeConflictError("Claude startup was cancelled");
    }
  }

  private requestInteraction(toolName: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const questions = toolName === "AskUserQuestion" ? parseClaudeQuestions(input) : undefined;
    const id = this.sessionId + ":" + options.requestId;
    const request: AgentInteractionRequest = {
      type: "agent_interaction_request",
      id,
      kind: questions ? "question" : "permission",
      title: options.title || options.displayName || (questions ? "Claude has a question" : "Allow " + toolName + "?"),
      toolName,
      input,
      ...(questions ? { questions } : {}),
    };
    if (options.signal.aborted) {
      return Promise.resolve({
        behavior: "deny",
        message: "Interaction aborted",
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
    }
    return new Promise((resolve) => {
      const onAbort = () => this.closeInteraction(id, "aborted", {
        behavior: "deny",
        message: "Interaction aborted",
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject",
      });
      this.pendingInteractions.set(id, { request, input, resolve, signal: options.signal, onAbort });
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.lifecycle = "awaiting-input";
      this.emit({ ...request });
    });
  }

  private answerInteraction(command: Record<string, unknown>): Record<string, unknown> {
    const id = stringField(command, "id");
    if (!id) throw new Error("Interaction id is required");
    const pending = this.pendingInteractions.get(id);
    if (!pending) throw new ClaudeConflictError("Interaction is no longer pending");
    if (command.cancelled === true || command.approved === false) {
      this.closeInteraction(id, "cancelled", {
        behavior: "deny",
        message: "The user declined this request",
        decisionClassification: "user_reject",
      });
      return { accepted: true };
    }
    if (pending.request.kind === "question") {
      const rawAnswers = command.answers;
      if (!isRecord(rawAnswers)) throw new Error("Question answers are required");
      const answers: Record<string, string> = {};
      for (const [question, answer] of Object.entries(rawAnswers)) if (typeof answer === "string") answers[question] = answer;
      this.closeInteraction(id, "answered", {
        behavior: "allow",
        updatedInput: { ...pending.input, answers },
        decisionClassification: "user_temporary",
      });
      return { accepted: true };
    }
    if (command.approved !== true) throw new Error("Permission response must approve, deny, or cancel");
    this.closeInteraction(id, "answered", {
      behavior: "allow",
      updatedInput: pending.input,
      decisionClassification: "user_temporary",
    });
    return { accepted: true };
  }

  private closeInteraction(id: string, reason: "answered" | "cancelled" | "aborted" | "session_closed", result: PermissionResult): void {
    const pending = this.pendingInteractions.get(id);
    if (!pending) return;
    this.pendingInteractions.delete(id);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(result);
    if (!this.pendingInteractions.size && this.lifecycle === "awaiting-input") this.lifecycle = "running";
    this.emit({ type: "agent_interaction_closed", id, reason });
  }

  private async stop(): Promise<Record<string, unknown>> {
    const starting = this.startPromise;
    if (starting) {
      this.startupCancellation = "stop";
      this.inputQueue?.close();
      this.abortController?.abort();
      this.queryInstance?.close();
      await starting.catch(() => undefined);
      return { stopped: true, cancelledStartup: true, stillQueued: [] };
    }
    if (!this.queryInstance) return { stopped: false, reason: "session-not-started" };
    for (const id of [...this.pendingInteractions.keys()]) {
      this.closeInteraction(id, "cancelled", { behavior: "deny", message: "Session stopped", decisionClassification: "user_reject" });
    }
    const query = this.queryInstance;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.dependencies.interruptTimeoutMs ?? 5_000);
      timer.unref?.();
    });
    let result: Awaited<ReturnType<ClaudeQuery["interrupt"]>> | "timeout";
    try {
      result = await Promise.race([query.interrupt(), timeout]);
    } catch {
      this.inputQueue?.close();
      this.abortController?.abort();
      query.close();
      await this.finishClosedRuntime();
      throw new Error("Claude runtime could not be interrupted");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === "timeout") {
      this.inputQueue?.close();
      this.abortController?.abort();
      query.close();
      await this.finishClosedRuntime();
      return { stopped: true, forced: true, stillQueued: [] };
    }
    return { stopped: true, stillQueued: result?.still_queued ?? [] };
  }

  private async setModel(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.options.side) throw new ClaudeConflictError("Claude side-session model is locked");
    const value = stringField(command, "modelId") ?? stringField(command, "model");
    if (!value) throw new Error("Claude model is required");
    if (this.queryInstance) {
      try {
        await this.queryInstance.setModel(value);
      } catch {
        throw new Error("Claude model could not be changed");
      }
    }
    this.selectedModel = value;
    if (this.initialized) this.initialized = { ...this.initialized, model: value };
    return { provider: "claude", id: value };
  }

  private async setEffort(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (command.effort === null || command.level === null) {
      if (this.queryInstance) await this.queryInstance.applyFlagSettings({ effortLevel: null });
      this.selectedEffort = undefined;
      if (this.initialized) this.initialized = { ...this.initialized, effort: null };
      return { effort: null };
    }
    const value = parseClaudeEffort(command.effort ?? command.level);
    if (!value) throw new Error("Unsupported Claude effort level");
    if (!this.queryInstance) {
      this.selectedEffort = value;
      return { effort: value };
    }
    try {
      await this.queryInstance.applyFlagSettings({ effortLevel: value });
      this.selectedEffort = value;
      if (this.initialized) this.initialized = { ...this.initialized, effort: value };
      return { effort: value };
    } catch {
      throw new Error("Claude effort could not be changed");
    }
  }

  private async setPermissionMode(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.queryInstance) throw new ClaudeConflictError("Start the Claude session before changing permission mode");
    const value = parseClaudePermissionMode(command.permissionMode ?? command.mode);
    if (!value) throw new Error("Unsupported Claude permission mode");
    if (this.options.side) throw new ClaudeConflictError("Claude side-session permissions are locked to the no-tool policy");
    try {
      await this.queryInstance.setPermissionMode(value);
      return { permissionMode: value };
    } catch {
      throw new Error("Claude permission mode could not be changed");
    }
  }

  private async consume(query: ClaudeQuery): Promise<void> {
    let failed = false;
    try {
      for await (const message of query) this.consumeMessage(message);
    } catch {
      failed = true;
      this.emit({ type: "prompt_error", errorMessage: "Claude runtime ended unexpectedly" });
    } finally {
      if (this.lifecycle !== "closing" && this.lifecycle !== "closed") {
        if (!failed && this.isStreaming) {
          this.emit({ type: "prompt_error", errorMessage: "Claude runtime ended unexpectedly" });
        }
        if (this.isStreaming) {
          this.finishAssistantMessage();
          this.lastTurnAborted = true;
          this.emit({ type: "agent_end" });
          this.emit({ type: "prompt_done", aborted: true, subagentsActive: false });
        }
        await this.finishClosedRuntime();
      }
    }
  }

  private consumeMessage(message: SDKMessage): void {
    this.lastEventAt = this.dependencies.now();
    switch (message.type) {
      case "system":
        this.consumeSystem(message);
        break;
      case "stream_event":
        if (message.parent_tool_use_id) {
          this.emit({ type: "claude_subagent_message", parentToolUseId: message.parent_tool_use_id, event: message.event });
        } else {
          this.consumeStreamEvent(message.event);
        }
        break;
      case "assistant":
        this.consumeAssistant(message);
        break;
      case "user":
        if (!message.parent_tool_use_id) this.consumeUser(message);
        break;
      case "result":
        this.consumeResult(message);
        break;
    }
  }

  private consumeSystem(message: Extract<SDKMessage, { type: "system" }>): void {
    if (message.subtype === "init") {
      this.initialized = message;
      this.selectedModel = message.model;
      this.selectedEffort = parseClaudeEffort(message.effort) ?? this.selectedEffort;
      this.emit({ type: "claude_initialized", model: message.model, permissionMode: message.permissionMode, effort: message.effort });
    } else if (message.subtype === "commands_changed") {
      this.emit({
        type: "claude_commands_changed",
        commands: projectClaudeCommands(message.commands, this.initialized?.terminal_slash_commands),
      });
    } else if (message.subtype === "session_state_changed") {
      if (message.state === "idle") {
        if (this.isStreaming) this.settleTurn(this.lastTurnAborted);
        else this.armIdleTimer();
      } else if (message.state === "requires_action" && this.isStreaming) {
        this.lifecycle = "awaiting-input";
      } else if (message.state === "running" && this.isStreaming) {
        this.markRunning();
      }
    } else if (message.subtype === "status") {
      if (message.status === "compacting") this.emit({ type: "compaction_start" });
      if (message.compact_result) this.emit({ type: "compaction_end", result: message.compact_result });
    } else if (message.subtype === "background_tasks_changed") {
      this.backgroundTasks.clear();
      for (const task of message.tasks) this.backgroundTasks.set(task.task_id, { ambient: task.ambient === true });
      this.emit({ type: "claude_background_tasks", tasks: message.tasks });
      if (!this.backgroundTasks.size) this.armIdleTimer();
    } else if (message.subtype === "task_started" || message.subtype === "task_progress" || message.subtype === "task_updated" || message.subtype === "task_notification") {
      this.emit({ type: "claude_subagent_update", event: message });
    } else if (message.subtype === "api_retry") {
      this.emit({ type: "auto_retry_start", attempt: message.attempt, maxAttempts: message.max_retries, errorMessage: "Claude request will be retried" });
    }
  }

  private consumeAssistant(source: SDKAssistantMessage): void {
    if (source.parent_tool_use_id) {
      this.emit({ type: "claude_subagent_message", parentToolUseId: source.parent_tool_use_id, message: projectSdkAssistant(source) });
    }
  }

  private consumeUser(source: SDKUserMessage): void {
    const projected = projectSdkUser(source);
    for (const message of projected) {
      this.emit({ type: "message_start", message });
      this.emit({ type: "message_end", message });
      if (message.role === "toolResult") {
        this.emit({
          type: "tool_execution_end",
          toolCallId: message.toolCallId,
          toolName: this.toolNames.get(message.toolCallId) ?? message.toolName ?? "tool",
          isError: message.isError === true,
        });
      }
    }
    if (!source.isSynthetic && source.uuid) {
      const queued = this.queuedFollowUps.findIndex((row) => row.id === source.uuid);
      if (queued >= 0) {
        this.queuedFollowUps.splice(queued, 1);
        this.markRunning();
        this.emit({ type: "agent_start" });
        this.emitQueue();
      }
    }
  }

  private consumeStreamEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") return;
    if (event.type === "message_start" && isRecord(event.message)) {
      this.assistantId = typeof event.message.id === "string" ? event.message.id : null;
      this.currentAssistant = {
        role: "assistant",
        content: [],
        model: typeof event.message.model === "string" ? event.message.model : this.initialized?.model ?? "unknown",
        provider: "claude",
      };
      this.emit({ type: "message_start", message: this.currentAssistant, nativeMessageId: this.assistantId });
      return;
    }
    if (!this.currentAssistant) return;
    if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
      const block = this.startedBlock(event.content_block);
      if (!block) return;
      this.setStreamingBlock(event.index, block);
      if (block.type === "text") this.emitUpdate({ type: "text_start", contentIndex: event.index });
      if (block.type === "thinking") this.emitUpdate({ type: "thinking_start", contentIndex: event.index });
      if (block.type === "toolCall") this.emitUpdate({
        type: "toolcall_start",
        contentIndex: event.index,
        id: block.toolCallId,
        toolName: block.toolName,
      });
      return;
    }
    if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
      this.applyStreamingDelta(event.index, event.delta);
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        this.emitUpdate({ type: "text_delta", contentIndex: event.index, delta: event.delta.text });
      } else if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
        this.emitUpdate({ type: "thinking_delta", contentIndex: event.index, delta: event.delta.thinking });
      } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        const block = this.currentAssistant.content[event.index];
        this.emitUpdate({
          type: "toolcall_delta",
          contentIndex: event.index,
          delta: event.delta.partial_json,
          ...(block?.type === "toolCall" ? { id: block.toolCallId, toolName: block.toolName } : {}),
        });
      }
      return;
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const block = this.currentAssistant.content[event.index];
      if (block?.type === "text") {
        this.emitUpdate({ type: "text_end", contentIndex: event.index, content: block.text });
      } else if (block?.type === "thinking") {
        this.emitUpdate({ type: "thinking_end", contentIndex: event.index, content: block.thinking });
      } else if (block?.type === "toolCall") {
        const input = block.rawInput ? this.parseToolInput(block.rawInput) : block.input;
        const complete = { ...block, input, rawInput: undefined };
        this.setStreamingBlock(event.index, complete);
        this.emitUpdate({
          type: "toolcall_end",
          contentIndex: event.index,
          toolCall: { type: "toolCall", id: block.toolCallId, name: block.toolName, arguments: input },
        });
        if (!this.toolNames.has(block.toolCallId)) {
          this.toolNames.set(block.toolCallId, block.toolName);
          this.emit({ type: "tool_execution_start", toolCallId: block.toolCallId, toolName: block.toolName });
        }
      }
      return;
    }
    if (event.type === "message_stop") this.finishAssistantMessage();
  }

  private emitUpdate(assistantMessageEvent: Record<string, unknown>): void {
    this.emit({
      type: "message_update",
      assistantMessageEvent: { ...assistantMessageEvent, nativeMessageId: this.assistantId },
      nativeMessageId: this.assistantId,
    });
  }

  private finishAssistantMessage(): void {
    if (!this.currentAssistant) return;
    this.emit({ type: "message_end", message: this.currentAssistant, nativeMessageId: this.assistantId });
    this.currentAssistant = null;
    this.assistantId = null;
  }

  private startedBlock(block: Record<string, unknown>): AssistantContentBlock | null {
    if (block.type === "text") return { type: "text", text: typeof block.text === "string" ? block.text : "" };
    if (block.type === "thinking") return { type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "" };
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      return { type: "toolCall", toolCallId: block.id, toolName: block.name, input: {}, rawInput: "" };
    }
    return null;
  }

  private setStreamingBlock(index: number, block: AssistantContentBlock): void {
    if (!this.currentAssistant || index < 0 || !Number.isInteger(index)) return;
    const content = [...this.currentAssistant.content];
    content[index] = block;
    this.currentAssistant = { ...this.currentAssistant, content };
  }

  private applyStreamingDelta(index: number, delta: Record<string, unknown>): void {
    const current = this.currentAssistant?.content[index];
    if (!current) return;
    if (delta.type === "text_delta" && typeof delta.text === "string" && current.type === "text") {
      this.setStreamingBlock(index, { ...current, text: current.text + delta.text });
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && current.type === "thinking") {
      this.setStreamingBlock(index, { ...current, thinking: current.thinking + delta.thinking });
    } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && current.type === "toolCall") {
      this.setStreamingBlock(index, { ...current, rawInput: (current.rawInput ?? "") + delta.partial_json });
    }
  }

  private parseToolInput(raw: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  }

  private consumeResult(result: Extract<SDKMessage, { type: "result" }>): void {
    this.finishAssistantMessage();
    this.latestResultUsage = {
      durationMs: result.duration_ms,
      durationApiMs: result.duration_api_ms,
      turns: result.num_turns,
      cumulativeTotalCostUsd: result.total_cost_usd,
      cumulativeModelUsage: result.modelUsage,
    };
    this.lastTurnAborted = result.subtype !== "success" || result.is_error;
    this.emit({ type: "agent_end" });
    this.emit({ type: "prompt_done", aborted: this.lastTurnAborted, subagentsActive: this.hasActiveSubagents() });
    this.settleTurn(this.lastTurnAborted);
  }

  private settleTurn(aborted: boolean): void {
    this.lifecycle = this.queuedFollowUps.length ? "running" : "idle";
    this.finishActiveClock();
    this.armIdleTimer();
    if (!this.queuedFollowUps.length) this.emit({ type: "agent_settled", aborted, subagentsActive: this.hasActiveSubagents() });
    this.lastTurnAborted = false;
  }

  private markRunning(): void {
    this.clearIdleTimer();
    this.lifecycle = this.pendingInteractions.size ? "awaiting-input" : "running";
    if (this.activeStartedAt === null) this.activeStartedAt = this.dependencies.now();
  }

  private finishActiveClock(): void {
    if (this.activeStartedAt === null) return;
    this.accumulatedActiveMs += Math.max(0, this.dependencies.now() - this.activeStartedAt);
    this.activeStartedAt = null;
  }

  private emitQueue(): void {
    this.emit({ type: "queue_update", steering: [], followUp: this.queuedFollowUps.map((row) => row.text) });
  }

  private emit(event: ClaudeAgentEvent): void {
    this.lastEventAt = this.dependencies.now();
    for (const listener of this.listeners) listener(event);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.queryInstance || this.lifecycle !== "idle" || this.backgroundTasks.size || this.pendingInteractions.size) return;
    this.idleTimer = setTimeout(() => void this.reapIdleRuntime(), this.dependencies.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async reapIdleRuntime(): Promise<void> {
    if (!this.queryInstance || this.lifecycle !== "idle" || this.backgroundTasks.size || this.pendingInteractions.size) return;
    this.lifecycle = "closing";
    this.inputQueue?.close();
    this.abortController?.abort();
    this.queryInstance.close();
    if (this.pump) await this.pump.catch(() => undefined);
    await this.finishClosedRuntime();
  }

  private async finishClosedRuntime(): Promise<void> {
    this.clearIdleTimer();
    for (const id of [...this.pendingInteractions.keys()]) {
      this.closeInteraction(id, "session_closed", {
        behavior: "deny",
        message: "Claude runtime closed",
        decisionClassification: "user_reject",
      });
    }
    if (this.queuedFollowUps.length) {
      this.queuedFollowUps = [];
      this.emitQueue();
    }
    this.inputQueue?.close();
    this.inputQueue = null;
    this.backgroundTasks.clear();
    this.queryInstance = null;
    this.abortController = null;
    this.pump = null;
    this.finishActiveClock();
    const release = this.releaseLock;
    this.releaseLock = null;
    if (release) await release().catch(() => undefined);
    if (this.lifecycle !== "closed") this.lifecycle = "dormant";
  }

  async close(): Promise<void> {
    if (this.lifecycle === "closed") return;
    this.clearIdleTimer();
    this.lifecycle = "closing";
    const starting = this.startPromise;
    if (starting) this.startupCancellation = "close";
    for (const id of [...this.pendingInteractions.keys()]) {
      this.closeInteraction(id, "session_closed", { behavior: "deny", message: "Session closed", decisionClassification: "user_reject" });
    }
    this.inputQueue?.close();
    this.abortController?.abort();
    this.queryInstance?.close();
    if (starting) await starting.catch(() => undefined);
    this.lifecycle = "closing";
    if (this.pump) await this.pump.catch(() => undefined);
    await this.finishClosedRuntime();
    this.lifecycle = "closed";
    this.listeners.clear();
  }
}
