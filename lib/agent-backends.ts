export type AgentBackend = "pi" | "claude";

export interface AgentCapabilities {
  fork: boolean; treeBranch: boolean; export: boolean; compact: boolean; mcp: boolean;
  side: boolean; steer: boolean; toolPresets: boolean; followUp: boolean;
  commands: boolean; models: boolean; setModel: boolean; effort: boolean;
}
export interface ClaudeSettingSource { scope: "user" | "project" | "local"; path: string; exists: boolean }
export interface ClaudeResourceStatus { status: string; count?: number }
export interface ClaudeBackendConfiguration {
  available: boolean; reason?: string; model: string | null; settingSources: ClaudeSettingSource[];
  requiresProjectTrust?: boolean;
  resources?: Partial<Record<"skills" | "agents" | "mcp" | "hooks" | "plugins", ClaudeResourceStatus>>;
}
export interface AgentBackendStatus {
  backend: AgentBackend; available: boolean; reason?: string; capabilities: AgentCapabilities;
  claude?: ClaudeBackendConfiguration;
}
export interface AgentBackends { pi: AgentBackendStatus; claude: AgentBackendStatus }
export interface AgentBackendScope { backend: AgentBackend; capabilities: AgentCapabilities; backends: AgentBackends }

const CAPABILITY_KEYS: ReadonlyArray<keyof AgentCapabilities> = ["fork", "treeBranch", "export", "compact", "mcp", "side", "steer", "toolPresets", "followUp", "commands", "models", "setModel", "effort"];

export function sameAgentCapabilities(left: AgentCapabilities, right: AgentCapabilities): boolean {
  return left === right || CAPABILITY_KEYS.every((key) => left[key] === right[key]);
}

export function mergeAgentBackendScope(current: AgentBackendScope, next: AgentBackendScope): AgentBackendScope {
  return current.backend === next.backend
    && current.backends === next.backends
    && sameAgentCapabilities(current.capabilities, next.capabilities)
    ? current
    : next;
}

export class StableRequestId {
  private value: string | null = null;
  private readonly create: () => string;
  constructor(create: () => string) {
    this.create = create;
  }
  get(): string {
    this.value ??= this.create();
    return this.value;
  }
}

export const PI_CAPABILITIES: AgentCapabilities = Object.freeze({ fork: true, treeBranch: true, export: true, compact: true, mcp: true, side: true, steer: true, toolPresets: true, followUp: true, commands: true, models: true, setModel: true, effort: true });
export const NO_CAPABILITIES: AgentCapabilities = Object.freeze({ fork: false, treeBranch: false, export: false, compact: false, mcp: false, side: false, steer: false, toolPresets: false, followUp: false, commands: false, models: false, setModel: false, effort: false });
export const DEFAULT_AGENT_BACKENDS: AgentBackends = {
  pi: { backend: "pi", available: true, capabilities: PI_CAPABILITIES },
  claude: { backend: "claude", available: false, reason: "Claude Code is not available", capabilities: NO_CAPABILITIES,
    claude: { available: false, reason: "Claude Code is not available", model: null, settingSources: [], requiresProjectTrust: false } },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function readCapabilities(value: unknown, fallback: AgentCapabilities): AgentCapabilities {
  const source = record(value);
  if (!source) return fallback;
  const yes = (key: keyof AgentCapabilities) => source[key] === true;
  return { fork: yes("fork"), treeBranch: yes("treeBranch"), export: yes("export"), compact: yes("compact"), mcp: yes("mcp"), side: yes("side"), steer: yes("steer"), toolPresets: yes("toolPresets"), followUp: yes("followUp"), commands: yes("commands"), models: yes("models"), setModel: yes("setModel"), effort: yes("effort") };
}
function parseClaudeConfiguration(value: unknown): ClaudeBackendConfiguration {
  const source = record(value) ?? {};
  const settingSources: ClaudeSettingSource[] = [];
  if (Array.isArray(source.settingSources)) {
    for (const item of source.settingSources) {
      const entry = record(item);
      if (!entry) continue;
      const scope = entry.scope;
      if (scope !== "user" && scope !== "project" && scope !== "local") continue;
      settingSources.push({ scope, path: typeof entry.path === "string" ? entry.path : "", exists: entry.exists === true });
    }
  }
  const resourceSource = record(source.resources); const resources: ClaudeBackendConfiguration["resources"] = {};
  for (const key of ["skills", "agents", "mcp", "hooks", "plugins"] as const) {
    const item = record(resourceSource?.[key]);
    if (item && typeof item.status === "string") resources[key] = { status: item.status, ...(typeof item.count === "number" ? { count: item.count } : {}) };
  }
  return { available: source.available === true, ...(typeof source.reason === "string" ? { reason: source.reason } : {}), model: typeof source.model === "string" ? source.model : null,
    settingSources, ...(typeof source.requiresProjectTrust === "boolean" ? { requiresProjectTrust: source.requiresProjectTrust } : {}),
    ...(Object.keys(resources).length ? { resources } : {}) };
}

/** Normalize the API envelope while keeping every unrecognized Claude capability disabled. */
export function parseAgentBackends(value: unknown): AgentBackends {
  const envelope = record(value); const root = record(envelope?.data) ?? envelope ?? {}; const collection = root.backends ?? root.engines;
  let piValue: unknown; let claudeValue: unknown;
  if (Array.isArray(collection)) {
    for (const item of collection) { const status = record(item); const id = status?.backend ?? status?.id ?? status?.name ?? status?.engine; if (id === "pi") piValue = item; if (id === "claude") claudeValue = item; }
  } else { const byName = record(collection) ?? root; piValue = byName.pi; claudeValue = byName.claude; }
  const pi = record(piValue); const claudeStatus = record(claudeValue);
  const claudeConfig = parseClaudeConfiguration(claudeStatus?.configuration ?? claudeStatus?.config ?? claudeStatus);
  const claudeAvailable = claudeStatus?.available === true || claudeConfig.available;
  return {
    pi: { backend: "pi", available: pi?.available !== false, ...(typeof pi?.reason === "string" ? { reason: pi.reason } : {}), capabilities: readCapabilities(pi?.capabilities, PI_CAPABILITIES) },
    claude: { backend: "claude", available: claudeAvailable, ...(typeof claudeStatus?.reason === "string" ? { reason: claudeStatus.reason } : claudeConfig.reason ? { reason: claudeConfig.reason } : {}), capabilities: readCapabilities(claudeStatus?.capabilities, NO_CAPABILITIES), claude: { ...claudeConfig, available: claudeAvailable } },
  };
}
export async function fetchAgentBackends(cwd: string | null, signal?: AbortSignal): Promise<AgentBackends> {
  const url = cwd ? "/api/agent/backends?cwd=" + encodeURIComponent(cwd) : "/api/agent/backends";
  const response = await fetch(url, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return parseAgentBackends(await response.json());
}
export function canLoadAgentSlashCommands(_backend: AgentBackend, _sessionId: string | null): boolean {
  return true;
}

export function shouldHandleWebSlashCommand(backend: AgentBackend, commandName: string): boolean {
  return backend === "pi" || commandName === "name" || commandName === "session" || commandName === "copy" || commandName === "side";
}

export function requiresClaudeProjectTrust(
  isNew: boolean,
  runtimeRequiresTrust: boolean | null,
  configuredRequiresTrust: boolean | undefined,
): boolean {
  return isNew
    ? configuredRequiresTrust === true
    : runtimeRequiresTrust ?? configuredRequiresTrust ?? true;
}

export function sessionBackend(session: { backend?: unknown } | null | undefined): AgentBackend { return session?.backend === "claude" ? "claude" : "pi"; }
export function sessionCapabilities(session: { backend?: unknown; capabilities?: unknown } | null | undefined): AgentCapabilities {
  return readCapabilities(session?.capabilities, sessionBackend(session) === "pi" ? PI_CAPABILITIES : NO_CAPABILITIES);
}

export interface AgentInteractionQuestion { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }
export interface AgentInteractionRequest { type: "agent_interaction_request"; id: string; kind: "permission" | "question"; title: string; toolName?: string; input?: unknown; questions?: AgentInteractionQuestion[] }
export interface PendingAgentInteraction extends AgentInteractionRequest { submitting: boolean; error: string | null }

export function upsertPendingAgentInteraction(
  queue: readonly PendingAgentInteraction[],
  request: AgentInteractionRequest,
): PendingAgentInteraction[] {
  const pending: PendingAgentInteraction = { ...request, submitting: false, error: null };
  const index = queue.findIndex((item) => item.id === request.id);
  return index === -1
    ? [...queue, pending]
    : queue.map((item, itemIndex) => itemIndex === index ? pending : item);
}

export function reconcilePendingAgentInteractions(
  queue: readonly PendingAgentInteraction[],
  pendingIds: readonly string[],
): PendingAgentInteraction[] {
  const pending = new Set(pendingIds);
  return queue.filter((item) => pending.has(item.id));
}

export type AgentInteractionAnswer = { approved: boolean } | { answers: Record<string, string> } | { cancelled: true };
export function isAgentInteractionRequest(value: unknown): value is AgentInteractionRequest {
  const item = record(value); return item?.type === "agent_interaction_request" && typeof item.id === "string" && (item.kind === "permission" || item.kind === "question") && typeof item.title === "string";
}
export async function answerAgentInteraction(sessionId: string, id: string, answer: AgentInteractionAnswer): Promise<void> {
  const response = await fetch("/api/agent/" + encodeURIComponent(sessionId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "answer_interaction", id, ...answer }) });
  const body = await response.json().catch(() => null) as { success?: boolean; data?: { accepted?: boolean }; error?: string } | null;
  if (!response.ok || body?.success !== true || body.data?.accepted !== true) throw new Error(body?.error ?? "HTTP " + response.status);
}
