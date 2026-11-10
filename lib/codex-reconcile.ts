import type { AgentMessage } from "./types";
import { userMessageKey } from "./prompt-recovery";
import { parseSessionKey } from "./session-identity";

export function isCodexSessionId(id: unknown): boolean {
  const parsed = parseSessionKey(id);
  return parsed.ok && parsed.key.backend === "codex";
}

export type CodexSnapshotItem = { id: string; message: AgentMessage; completed: boolean };

export function isTerminalCodexActivity(message: AgentMessage): boolean {
  if (message.role === "bashExecution") {
    return message.exitCode !== undefined || message.cancelled === true
      || (message.codexStatus !== undefined && message.codexStatus !== "inProgress");
  }
  if (message.role !== "custom" || !["fileChange", "mcpToolCall", "dynamicToolCall"].includes(message.customType)) return false;
  const details = message.details;
  if (!details || typeof details !== "object" || !("status" in details)) return false;
  return details.status === "completed" || details.status === "failed" || details.status === "declined";
}

export function reconcileCodexSnapshot(
  messages: readonly AgentMessage[], entryIds: readonly string[], liveIds: WeakMap<AgentMessage, string>, stickyKeys: WeakMap<AgentMessage, string>, items: readonly CodexSnapshotItem[],
): AgentMessage[] {
  const loaded = new Set(entryIds);
  const byId = new Map(items.map(item => [item.id, item]));
  const present = new Set<string>();
  const result = messages.filter((message, index) => {
    if (index < entryIds.length) return true;
    const id = liveIds.get(message);
    if (!id) return true;
    const item = byId.get(id);
    if (!item) return true;
    if (loaded.has(id) || present.has(id)) return false;
    present.add(id);
    return true;
  }).map((message, index) => {
    if (index < entryIds.length) {
      const item = byId.get(entryIds[index]);
      const sameActivity = item && (message.role === "bashExecution" && item.message.role === "bashExecution"
        || message.role === "custom" && item.message.role === "custom" && message.customType === item.message.customType);
      return sameActivity && !isTerminalCodexActivity(message) ? item.message : message;
    }
    const id = liveIds.get(message);
    const item = id === undefined ? undefined : byId.get(id);
    if (!item || isTerminalCodexActivity(message)) return message;
    liveIds.set(item.message, item.id);
    const key = stickyKeys.get(message);
    if (key) stickyKeys.set(item.message, key);
    return item.message;
  });
  for (const item of items) {
    if (loaded.has(item.id) || present.has(item.id)) continue;
    liveIds.set(item.message, item.id);
    result.push(item.message);
    present.add(item.id);
  }
  return result;
}

export function mergeCodexHistory(
  previous: { messages: readonly AgentMessage[]; entryIds: readonly string[] },
  next: { messages: readonly AgentMessage[]; entryIds: readonly string[] },
  liveIds: WeakMap<AgentMessage, string>,
): AgentMessage[] {
  const loaded = new Set(next.entryIds);
  const anchor = previous.entryIds.at(-1);
  const anchorIndex = anchor === undefined ? -1 : next.entryIds.indexOf(anchor);
  const newUsers = new Map<string, number>();
  if (anchor === undefined || anchorIndex >= 0) {
    for (const message of next.messages.slice(anchorIndex + 1)) {
      if (message.role !== "user") continue;
      const key = userMessageKey(message);
      newUsers.set(key, (newUsers.get(key) ?? 0) + 1);
    }
  }
  const suffix = previous.messages.slice(previous.entryIds.length).filter(message => {
    const id = liveIds.get(message);
    if (id) return !loaded.has(id);
    if (message.role !== "user") return true;
    const key = userMessageKey(message);
    const count = newUsers.get(key) ?? 0;
    if (!count) return true;
    newUsers.set(key, count - 1);
    return false;
  });
  return [...next.messages, ...suffix];
}
