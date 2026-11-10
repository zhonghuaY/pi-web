import type { AgentMessage, CustomMessage } from "./types";
import { userMessageKey } from "./prompt-recovery";

// Native ids and history arrive separately; row keys must survive both.
const liveKey = (anchor: string | undefined, offset: number) => `live:${anchor ?? ""}:${offset}`;

export function messageRenderKeys(entryIds: readonly string[], count: number, aliases: ReadonlyMap<string, string>, sticky?: { messages: readonly AgentMessage[]; keys: WeakMap<AgentMessage, string> }): string[] {
  const anchor = entryIds[entryIds.length - 1];
  const keys: string[] = [];
  const reserved = new Set(entryIds.map(id => aliases.get(id) ?? id));
  if (sticky) for (const message of sticky.messages.slice(entryIds.length)) {
    const key = sticky.keys.get(message);
    if (key) reserved.add(key);
  }
  for (let i = 0; i < count; i++) {
    const id = entryIds[i];
    const message = sticky?.messages[i];
    let key = id === undefined && message ? sticky?.keys.get(message) : undefined;
    if (key === undefined && id === undefined) {
      let offset = i - entryIds.length;
      key = liveKey(anchor, offset);
      while (reserved.has(key)) key = liveKey(anchor, ++offset);
      reserved.add(key);
    }
    key ??= aliases.get(id!) ?? id!;
    if (id === undefined && message) sticky?.keys.set(message, key);
    keys.push(key);
  }
  return keys;
}

// The file holds pi's own message, except for the prompt, sent with the
// browser's timestamp, and a custom message, stamped when its entry was written.
function sameMessage(live: AgentMessage, loaded: AgentMessage): boolean {
  if (live.role !== loaded.role) return false;
  if (live.role === "user") return userMessageKey(live) === userMessageKey(loaded);
  if (live.role === "custom") return live.customType === (loaded as CustomMessage).customType;
  return live.timestamp === loaded.timestamp;
}

export function carryMessageKeys(
  previous: { messages: readonly AgentMessage[]; entryIds: readonly string[]; aliases: ReadonlyMap<string, string>; liveIds?: readonly (string | null)[]; stickyKeys?: WeakMap<AgentMessage, string> },
  next: { messages: readonly AgentMessage[]; entryIds: readonly string[] },
): Map<string, string> {
  const loaded = new Set(next.entryIds);
  const aliases = new Map([...previous.aliases].filter(([id]) => loaded.has(id)));
  const liveStart = previous.entryIds.length;
  const anchor = previous.entryIds[liveStart - 1];
  const start = anchor === undefined ? 0 : next.entryIds.indexOf(anchor) + 1;
  // The window starts after the anchor (a run longer than the first page).
  if (start === 0 && anchor !== undefined) return aliases;
  for (let offset = 0; liveStart + offset < previous.messages.length; offset++) {
    const id = next.entryIds[start + offset];
    const liveId = previous.liveIds?.[liveStart + offset];
    if (id === undefined || (liveId ? liveId !== id : !sameMessage(previous.messages[liveStart + offset], next.messages[start + offset]))) break;
    aliases.set(id, previous.stickyKeys?.get(previous.messages[liveStart + offset]) ?? liveKey(anchor, offset));
  }
  return aliases;
}
