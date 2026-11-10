import { backendLabels, isBackendId, type BackendId } from "./session-identity";
import type { AgentMessage, CustomMessage, SessionInfo, UserMessage } from "./types";

export const HANDOFF_CONTEXT_CUSTOM_TYPE = "Imported context";
export const DEFAULT_HANDOFF_MAX_MESSAGES = 24;
export const DEFAULT_HANDOFF_MAX_CHARACTERS = 18_000;

const MARKER_PREFIX = "<!-- pi-web-handoff:";
const MARKER_SUFFIX = " -->";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HandoffRelation = Extract<NonNullable<SessionInfo["relation"]>, { kind: "handoff" }>;

export interface SessionHandoffMetadata {
  version: 1;
  requestId: string;
  sourceSessionId: string;
  sourceBackend: BackendId;
  sourceEntryId: string | null;
  sourceTitle: string;
}

export interface BuildSessionHandoffInput {
  requestId: string;
  sourceSessionId: string;
  sourceBackend: BackendId;
  sourceEntryId: string | null;
  sourceTitle: string;
  targetBackend: BackendId;
  messages: readonly AgentMessage[];
  maxMessages?: number;
  maxCharacters?: number;
}

export interface BuiltSessionHandoff {
  prompt: string;
  relation: HandoffRelation;
  title: string;
  transferredMessages: number;
  omittedMessages: number;
  truncated: boolean;
}

type TransferSegment = { index: number; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTitle(value: string): string {
  const title = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return "Untitled session";
  const codePoints = [...title];
  return codePoints.length <= 80 ? title : codePoints.slice(0, 79).join("") + "…";
}

function textContent(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function customText(message: CustomMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function transferSegment(message: AgentMessage, index: number): TransferSegment | null {
  if (message.role === "user") {
    const text = textContent(message).trim();
    return text ? { index, text: "**User**\n" + text } : null;
  }
  if (message.role === "assistant") {
    const text = assistantText(message).trim();
    return text ? { index, text: "**Assistant**\n" + text } : null;
  }
  if (message.role === "custom" && message.display && (message.customType === "compaction" || message.customType === HANDOFF_CONTEXT_CUSTOM_TYPE)) {
    const text = customText(message).trim();
    const label = message.customType === "compaction" ? "Conversation summary" : "Earlier imported context";
    return text ? { index, text: "**" + label + "**\n" + text } : null;
  }
  return null;
}

function boundedSegments(messages: readonly AgentMessage[], maxMessages: number, maxCharacters: number) {
  const available = messages.map(transferSegment).filter((segment): segment is TransferSegment => segment !== null);
  const selected: TransferSegment[] = [];
  let characters = 0;
  let truncated = false;

  for (let index = available.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const segment = available[index];
    const separatorLength = selected.length === 0 ? 0 : 4;
    if (characters + separatorLength + segment.text.length <= maxCharacters) {
      selected.unshift(segment);
      characters += separatorLength + segment.text.length;
      continue;
    }
    if (selected.length === 0 && maxCharacters >= 64) {
      const suffix = segment.text.slice(-(maxCharacters - 16));
      selected.unshift({ ...segment, text: "[…truncated…]\n" + suffix });
    }
    truncated = true;
    break;
  }
  if (selected.length < available.length) truncated = true;
  return { selected, availableCount: available.length, truncated };
}

export function parseSessionHandoffMetadata(text: string): SessionHandoffMetadata | null {
  const newline = text.indexOf("\n");
  const line = newline === -1 ? text : text.slice(0, newline);
  if (!line.startsWith(MARKER_PREFIX) || !line.endsWith(MARKER_SUFFIX)) return null;
  try {
    const encoded = line.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
    const value: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!isRecord(value)
      || value.version !== 1
      || typeof value.requestId !== "string"
      || !UUID_PATTERN.test(value.requestId)
      || typeof value.sourceSessionId !== "string"
      || value.sourceSessionId.length === 0
      || value.sourceSessionId.length > 200
      || !isBackendId(value.sourceBackend)
      || (value.sourceEntryId !== null && typeof value.sourceEntryId !== "string")
      || typeof value.sourceTitle !== "string"
      || value.sourceTitle.length > 500) return null;
    return {
      version: 1,
      requestId: value.requestId,
      sourceSessionId: value.sourceSessionId,
      sourceBackend: value.sourceBackend,
      sourceEntryId: value.sourceEntryId,
      sourceTitle: normalizedTitle(value.sourceTitle),
    };
  } catch {
    return null;
  }
}

export function sessionHandoffRelation(text: string): HandoffRelation | null {
  const metadata = parseSessionHandoffMetadata(text);
  return metadata ? {
    kind: "handoff",
    sourceSessionId: metadata.sourceSessionId,
    sourceBackend: metadata.sourceBackend,
    sourceEntryId: metadata.sourceEntryId ?? undefined,
    requestId: metadata.requestId,
  } : null;
}

export function sessionHandoffTitle(text: string, targetBackend?: BackendId): string | null {
  const metadata = parseSessionHandoffMetadata(text);
  if (!metadata) return null;
  const backend = targetBackend === undefined ? "another backend" : backendLabels[targetBackend];
  return "Continue in " + backend + " · " + metadata.sourceTitle;
}

export function projectSessionHandoffMessage(message: UserMessage): CustomMessage | null {
  const text = textContent(message);
  const metadata = parseSessionHandoffMetadata(text);
  if (!metadata) return null;
  const newline = text.indexOf("\n");
  return {
    role: "custom",
    customType: HANDOFF_CONTEXT_CUSTOM_TYPE,
    content: newline === -1 ? "" : text.slice(newline + 1).trim(),
    display: true,
    details: {
      sourceSessionId: metadata.sourceSessionId,
      sourceBackend: metadata.sourceBackend,
      sourceEntryId: metadata.sourceEntryId,
    },
    timestamp: message.timestamp,
  };
}

export function buildSessionHandoff(input: BuildSessionHandoffInput): BuiltSessionHandoff {
  const maxMessages = Math.max(1, Math.min(input.maxMessages ?? DEFAULT_HANDOFF_MAX_MESSAGES, 100));
  const maxCharacters = Math.max(256, Math.min(input.maxCharacters ?? DEFAULT_HANDOFF_MAX_CHARACTERS, 100_000));
  const sourceTitle = normalizedTitle(input.sourceTitle);
  const metadata: SessionHandoffMetadata = {
    version: 1,
    requestId: input.requestId,
    sourceSessionId: input.sourceSessionId,
    sourceBackend: input.sourceBackend,
    sourceEntryId: input.sourceEntryId,
    sourceTitle,
  };
  const marker = MARKER_PREFIX + encodeURIComponent(JSON.stringify(metadata)) + MARKER_SUFFIX;
  const bounded = boundedSegments(input.messages, maxMessages, maxCharacters);
  if (bounded.selected.length === 0) throw new Error("The source session has no transferable visible context");

  const sourceName = backendLabels[input.sourceBackend];
  const targetName = backendLabels[input.targetBackend];
  const title = "Continue in " + targetName + " · " + sourceTitle;
  const omittedMessages = input.messages.length - bounded.selected.length;
  const prompt = [
    marker,
    "# Imported context from " + sourceName,
    "",
    "Source session: " + input.sourceSessionId,
    "Source tip: " + (input.sourceEntryId ?? "unknown"),
    "",
    "This context was copied by Pi Web into a new native session. Treat it as background, not as actions performed in this session.",
    "",
    "## Recent visible conversation",
    "",
    bounded.selected.map((segment) => segment.text).join("\n\n---\n\n"),
    "",
    "## Transfer limits",
    "",
    "Transferred " + bounded.selected.length + " of " + bounded.availableCount + " visible context messages" + (bounded.truncated ? " within a fixed size budget" : "") + ".",
    "Tool calls and result identities, thinking, images, permissions, MCP state, usage, branches, compaction boundaries, and subagent state were not transferred.",
    "",
    "Continue this work as a native " + targetName + " session. Briefly state what you understand, then take the next useful step. Do not claim that source-session tool work ran here.",
  ].join("\n");

  return {
    prompt,
    relation: {
      kind: "handoff",
      sourceSessionId: input.sourceSessionId,
      sourceBackend: input.sourceBackend,
      sourceEntryId: input.sourceEntryId ?? undefined,
      requestId: input.requestId,
    },
    title,
    transferredMessages: bounded.selected.length,
    omittedMessages,
    truncated: bounded.truncated,
  };
}
