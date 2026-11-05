import type { AgentMessage, SessionContext, SessionInfo } from "../types";

export type AgentBackend = "pi" | "claude";

const CLAUDE_SESSION_ID = /^claude:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const NATIVE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(id: string): boolean {
  return CLAUDE_SESSION_ID.test(id);
}

export function isNativeClaudeSessionId(id: string): boolean {
  return NATIVE_SESSION_ID.test(id);
}

export function nativeClaudeSessionId(id: string): string {
  const match = CLAUDE_SESSION_ID.exec(id);
  if (!match) throw new Error("Invalid Claude session id");
  return match[1].toLowerCase();
}

export function claudeWebSessionId(nativeId: string): string {
  if (!isNativeClaudeSessionId(nativeId)) throw new Error("Invalid native Claude session id");
  return `claude:${nativeId.toLowerCase()}`;
}

export function getSessionBackend(id: string): AgentBackend {
  return isClaudeSessionId(id) ? "claude" : "pi";
}

export interface AgentBackendCapabilities {
  backend: AgentBackend;
  history: boolean;
  prompt: boolean;
  stop: boolean;
  followUp: boolean;
  steer: boolean;
  fork: boolean;
  treeBranch: boolean;
  export: boolean;
  compact: boolean;
  mcp: boolean;
  side: boolean;
  toolPresets: boolean;
  forkAtEntry: boolean;
  sideChat: boolean;
  rename: boolean;
  delete: boolean;
  tools: boolean;
  commands: boolean;
  models: boolean;
  setModel: boolean;
  effort: boolean;
  permissionMode: boolean;
  subagents: "none" | "display" | "control";
  nativeConfig: "none" | "read-only" | "read-write";
  requiresExplicitProjectTrust: boolean;
}

export const CLAUDE_CAPABILITIES: Readonly<AgentBackendCapabilities> = Object.freeze({
  backend: "claude",
  history: true,
  prompt: true,
  stop: true,
  followUp: true,
  steer: false,
  fork: true,
  treeBranch: false,
  export: true,
  compact: false,
  mcp: false,
  side: true,
  toolPresets: false,
  forkAtEntry: true,
  sideChat: true,
  rename: true,
  delete: true,
  tools: true,
  commands: true,
  models: true,
  setModel: true,
  effort: true,
  permissionMode: true,
  subagents: "display",
  nativeConfig: "read-only",
  requiresExplicitProjectTrust: true,
});

export interface AgentInteractionOption {
  label: string;
  description?: string;
}

export interface AgentInteractionQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AgentInteractionOption[];
}

export interface AgentInteractionRequest {
  type: "agent_interaction_request";
  id: string;
  kind: "permission" | "question";
  title: string;
  toolName?: string;
  input?: Record<string, unknown>;
  questions?: AgentInteractionQuestion[];
}

export interface AgentInteractionClosed {
  type: "agent_interaction_closed";
  id: string;
  reason: "answered" | "cancelled" | "aborted" | "session_closed";
}

export interface AnswerInteractionCommand {
  type: "answer_interaction";
  id: string;
  approved?: boolean;
  answers?: Record<string, string>;
  cancelled?: boolean;
}

export type ClaudeSessionInfo = SessionInfo & {
  backend: "claude";
  nativeSessionId: string;
  capabilities: AgentBackendCapabilities;
};

export interface ClaudeConfigurationSummary {
  available: boolean;
  reason?: string;
  model: string | null;
  settingSources: Array<{
    scope: "user" | "project" | "local";
    path: string;
    exists: boolean;
  }>;
  requiresProjectTrust: true;
  resources?: {
    skills?: { status: string; count?: number };
    agents?: { status: string; count?: number };
    mcp?: { status: string; count?: number };
    hooks?: { status: string; count?: number };
    plugins?: { status: string; count?: number };
  };
}

export interface ClaudeSessionContext extends SessionContext {
  messages: AgentMessage[];
}

export interface ClaudeSessionSnapshot {
  sessionId: string;
  filePath: null;
  info: ClaudeSessionInfo;
  leafId: string | null;
  tree: [];
  context: ClaudeSessionContext;
  stats?: import("../session-stats").SessionFileStats;
  totalActiveMs?: number;
  snapshotRevision: string;
  capabilities: AgentBackendCapabilities;
  subagents?: Array<{ id: string }>;
}
