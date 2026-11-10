import { createHash } from "node:crypto";
import type { AgentMessage, SessionContext } from "@/lib/types";
import type { CodexThread } from "./catalogue";
import { projectSessionHandoffMessage } from "@/lib/session-handoff";
import { codexBatchMessages } from "./batch";
import { codexUserText } from "./user-envelope";
import { projectCodexSessionInfo, CODEX_CAPABILITIES } from "./projection";

type Item = CodexThread["turns"][number]["items"][number];
type Entry = { id: string; message: AgentMessage };

export function assembleCodexReasoning(summary: readonly string[], content: readonly string[]): string {
  return [...summary, ...content].join("\n");
}

export function projectItem(item: Item, thread: CodexThread): Entry {
  if (item.type === "userMessage") {
    const inputs = item.content as Array<{ type: string; text?: string; path?: string }>;
    const content = inputs.map((input) => input.type === "text" ? input.text ?? "" : `[${input.type}${input.path ? `: ${input.path}` : ""}]`).join("\n");
    const message = { role: "user" as const, content };
    return { id: item.id, message: projectSessionHandoffMessage(message) ?? message };
  }
  if (item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning") {
    const content = item.type === "reasoning"
      ? [{ type: "thinking" as const, thinking: assembleCodexReasoning(item.summary as string[] ?? [], item.content as string[] ?? []) }]
      : [{ type: "text" as const, text: item.text as string }];
    return { id: item.id, message: { role: "assistant", content, provider: thread.modelProvider, model: thread.model ?? "" } };
  }
  if (item.type === "commandExecution") {
    return { id: item.id, message: {
      role: "bashExecution", command: item.command as string, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
      ...(item.status === "inProgress" || item.status === "completed" || item.status === "failed" || item.status === "declined" ? { codexStatus: item.status } : {}),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    } };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.flatMap((change: unknown) => {
      if (!change || typeof change !== "object" || !("path" in change) || typeof change.path !== "string") return [];
      const entry = change as { path: string; diff?: unknown; kind?: { type?: unknown; move_path?: unknown } };
      return [{ path: entry.path, ...(typeof entry.diff === "string" ? { diff: entry.diff } : {}),
        ...(typeof entry.kind?.type === "string" ? { kind: entry.kind.type } : {}),
        ...(typeof entry.kind?.move_path === "string" ? { movePath: entry.kind.move_path } : {}) }];
    }) : [];
    return { id: item.id, message: { role: "custom", customType: item.type, content: changes.map(change => change.path).join("\n"), display: true,
      details: { changes, ...(typeof item.status === "string" ? { status: item.status } : {}) } } };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const output = item.type === "mcpToolCall" && item.result && typeof item.result === "object" && "content" in item.result
      ? item.result.content : item.contentItems;
    const text = Array.isArray(output) ? output.flatMap((part: unknown) =>
      part && typeof part === "object" && "type" in part && (part.type === "text" || part.type === "inputText") && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
    return { id: item.id, message: { role: "custom", customType: item.type, content: text, display: true,
      details: { ...(typeof item.server === "string" ? { server: item.server } : {}), ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}) } } };
  }
  return { id: item.id, message: { role: "custom", customType: item.type, content: "", display: true } };
}

export function projectUserItems(item: Item, thread: CodexThread): Entry[] {
  const batch = item.type === "userMessage" ? codexBatchMessages(item) : null;
  return batch ? batch.map(({ id, text }) => ({ id, message: { role: "user", content: text } })) : [projectItem(item, thread)];
}

export function projectCodexHandoffMessages(thread: CodexThread): AgentMessage[] {
  return thread.turns.flatMap((turn) => turn.items.flatMap((item) => {
    if (item.type !== "userMessage") return [projectItem(item, thread).message];
    const batch = codexBatchMessages(item);
    if (batch) return batch.map(({ text }) => ({ role: "user" as const, content: text }));
    const message = { role: "user" as const, content: codexUserText(item) ?? "" };
    return [projectSessionHandoffMessage(message) ?? message];
  }));
}

export function projectCodexHistory(thread: CodexThread, options: { tail: number; before?: string }) {
  const projection = projectCodexSessionInfo(thread);
  if (projection.state !== "projected") throw new Error(`Codex session metadata ${projection.reason}`);
  const entries = thread.turns.flatMap((turn) => turn.items.flatMap((item) => projectUserItems(item, thread)));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate Codex history item id");
  let end = entries.length;
  if (options.before !== undefined) {
    end = entries.findIndex((entry) => entry.id === options.before);
    if (end < 0) throw new Error("Codex history cursor not found");
  }
  const tail = Number.isFinite(options.tail) && options.tail > 0 ? Math.min(1000, Math.floor(options.tail)) : 50;
  const start = Math.max(0, end - tail);
  const selected = entries.slice(start, end);
  const leafId = entries.at(-1)?.id ?? null;
  const context: SessionContext = {
    messages: selected.map((entry) => entry.message), entryIds: selected.map((entry) => entry.id),
    oldestEntryId: selected[0]?.id ?? null, hasMore: start > 0,
    turnsBefore: entries.slice(0, start).filter((entry) => entry.message.role === "user").length,
    thinkingLevel: "native", model: thread.model ? { provider: thread.modelProvider, modelId: thread.model } : null,
  };
  return {
    sessionId: projection.info.id, filePath: null,
    info: { ...projection.info, messageCount: entries.length, detailsPending: false },
    leafId, tree: [], context, capabilities: CODEX_CAPABILITIES,
    snapshotRevision: createHash("sha256").update(JSON.stringify(thread)).digest("hex"),
  };
}
