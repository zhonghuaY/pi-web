import { isClaudeEffort } from "@/lib/agent-session-choices";
import type { EffortLevel, ModelInfo, PermissionMode, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "./claude-projection";
import { isNativeClaudeSessionId, type AgentInteractionQuestion } from "./types";

type SupportedMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

export function claudeModelRow(model: ModelInfo): Record<string, unknown> {
  return { value: model.value, resolvedModel: model.resolvedModel, displayName: model.displayName, description: model.description, supportsEffort: model.supportsEffort, supportedEffortLevels: model.supportedEffortLevels };
}

export function parseClaudePermissionMode(value: unknown): PermissionMode | undefined {
  return value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan"
    || value === "dontAsk" || value === "auto" ? value : undefined;
}

export function parseClaudeEffort(value: unknown): EffortLevel | undefined {
  return isClaudeEffort(value) ? value : undefined;
}

function supportedMime(value: string): value is SupportedMime {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

export function parseClaudeQuestions(input: Record<string, unknown>): AgentInteractionQuestion[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const questions: AgentInteractionQuestion[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.question !== "string" || !Array.isArray(raw.options)) continue;
    const options = raw.options.flatMap((option) => {
      if (!isRecord(option) || typeof option.label !== "string") return [];
      return [{ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }];
    });
    if (!options.length) continue;
    questions.push({
      question: raw.question,
      ...(typeof raw.header === "string" ? { header: raw.header } : {}),
      ...(typeof raw.multiSelect === "boolean" ? { multiSelect: raw.multiSelect } : {}),
      options,
    });
  }
  return questions.length ? questions : undefined;
}

export function buildClaudeUserMessage(command: Record<string, unknown>): { message: SDKUserMessage; text: string } {
  const text = typeof command.message === "string" ? command.message : "";
  const content: SDKUserMessage["message"]["content"] = [];
  if (text) content.push({ type: "text", text });
  if (Array.isArray(command.images)) {
    for (const image of command.images) {
      if (!isRecord(image) || typeof image.data !== "string" || typeof image.mimeType !== "string" || !supportedMime(image.mimeType)) {
        throw new Error("Unsupported Claude image attachment");
      }
      content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
  }
  if (!content.length) throw new Error("Claude prompt is empty");
  const requestId = typeof command.requestId === "string" ? command.requestId : undefined;
  if (!requestId || !isNativeClaudeSessionId(requestId)) throw new Error("Claude prompt requestId must be a UUID");
  const uuid = requestId as `${string}-${string}-${string}-${string}-${string}`;
  return {
    text,
    message: {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid,
      priority: command.streamingBehavior === "followUp" ? "next" : "now",
    },
  };
}
