import type { SDKAssistantMessage, SDKUserMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "../types";

export interface ProjectedClaudeMessage {
  entryId: string;
  message: AgentMessage;
}

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function imageBlock(value: JsonRecord): ImageContent | null {
  if (value.type !== "image" || !isRecord(value.source)) return null;
  const source = value.source;
  if (source.type === "base64" && typeof source.data === "string") {
    return {
      type: "image",
      source: {
        type: "base64",
        data: source.data,
        media_type: typeof source.media_type === "string" ? source.media_type : undefined,
      },
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image", source: { type: "url", url: source.url } };
  }
  return null;
}

function textAndImages(content: unknown): Array<TextContent | ImageContent> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Array<TextContent | ImageContent> = [];
  for (const value of content) {
    if (!isRecord(value)) continue;
    if (value.type === "text" && typeof value.text === "string") {
      blocks.push({ type: "text", text: value.text });
      continue;
    }
    const image = imageBlock(value);
    if (image) blocks.push(image);
  }
  return blocks;
}

function assistantBlocks(content: unknown): AssistantContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: AssistantContentBlock[] = [];
  for (const value of content) {
    if (!isRecord(value) || typeof value.type !== "string") continue;
    if (value.type === "text" && typeof value.text === "string") {
      blocks.push({ type: "text", text: value.text });
    } else if (value.type === "thinking" && typeof value.thinking === "string") {
      blocks.push({ type: "thinking", thinking: value.thinking });
    } else if (
      value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string" && isRecord(value.input)
    ) {
      blocks.push({ type: "toolCall", toolCallId: value.id, toolName: value.name, input: value.input });
    } else {
      const image = imageBlock(value);
      if (image) blocks.push(image);
    }
  }
  return blocks;
}

function assistantFromMessage(message: { content?: unknown; model?: unknown; stop_reason?: unknown }, at?: number): AssistantMessage {
  return {
    role: "assistant",
    content: assistantBlocks(message.content),
    model: typeof message.model === "string" ? message.model : "unknown",
    provider: "claude",
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : undefined,
    timestamp: at,
  };
}

function toolResult(value: JsonRecord, at?: number): ToolResultMessage | null {
  if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") return null;
  const content = textAndImages(value.content);
  return {
    role: "toolResult",
    toolCallId: value.tool_use_id,
    content: content.length ? content : [{ type: "text", text: "" }],
    isError: value.is_error === true,
    timestamp: at,
  };
}

function userMessages(message: JsonRecord, at?: number): AgentMessage[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [{ role: "user", content, timestamp: at }] : [];
  }
  const results: ToolResultMessage[] = [];
  const visible: Array<TextContent | ImageContent> = [];
  for (const value of content) {
    if (!isRecord(value)) continue;
    const result = toolResult(value, at);
    if (result) {
      results.push(result);
      continue;
    }
    if (value.type === "text" && typeof value.text === "string") visible.push({ type: "text", text: value.text });
    else {
      const image = imageBlock(value);
      if (image) visible.push(image);
    }
  }
  const user: UserMessage[] = visible.length ? [{ role: "user", content: visible, timestamp: at }] : [];
  return [...user, ...results];
}

export function projectClaudeHistoryMessage(source: SessionMessage): ProjectedClaudeMessage[] {
  if (!isRecord(source.message)) return [];
  if (source.type === "assistant") {
    return [{ entryId: source.uuid, message: assistantFromMessage(source.message) }];
  }
  if (source.type === "user") {
    return userMessages(source.message).map((message) => ({ entryId: source.uuid, message }));
  }
  const subtype = source.message.subtype;
  if (subtype === "compact_boundary") {
    return [{
      entryId: source.uuid,
      message: {
        role: "custom",
        customType: "compaction",
        content: typeof source.message.content === "string" ? source.message.content : "Conversation compacted",
        display: true,
      },
    }];
  }
  return [];
}

export function projectSdkAssistant(source: SDKAssistantMessage): AssistantMessage {
  const projected = assistantFromMessage(source.message, timestamp(source.timestamp));
  return source.error ? { ...projected, errorMessage: source.error } : projected;
}

export function projectSdkUser(source: SDKUserMessage): AgentMessage[] {
  if (!isRecord(source.message)) return [];
  return userMessages(source.message, timestamp(source.timestamp));
}

export function extractToolCalls(message: AssistantMessage): Array<{ id: string; name: string }> {
  return message.content.flatMap((block) => block.type === "toolCall"
    ? [{ id: block.toolCallId, name: block.toolName }]
    : []);
}

export function extractText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
  }
  if (message.role === "assistant" || message.role === "toolResult") {
    return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  }
  if (message.role === "custom") return typeof message.content === "string" ? message.content : "";
  return "";
}
