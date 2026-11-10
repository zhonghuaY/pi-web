export type CodexQueuedText = { requestId: string; message: string };

const batchPrefix = "pi-web-batch-v1:";
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function codexBatchInput(messages: readonly CodexQueuedText[]) {
  if (messages.length < 2 || messages.some((message) => !requestIdPattern.test(message.requestId) || !message.message.trim())
    || new Set(messages.map((message) => message.requestId)).size !== messages.length) throw new Error("Invalid Codex queued batch");
  return {
    clientUserMessageId: batchPrefix + JSON.stringify(messages.map((message) => message.requestId)),
    input: messages.map((message) => ({ type: "text", text: message.message, text_elements: [] })),
  };
}

export function codexBatchMessages(item: { id: string; [key: string]: unknown }): Array<{ id: string; requestId: string; text: string }> | null {
  if (typeof item.clientId !== "string" || !item.clientId.startsWith(batchPrefix) || !Array.isArray(item.content)) return null;
  let ids: unknown;
  try { ids = JSON.parse(item.clientId.slice(batchPrefix.length)); } catch { return null; }
  if (!Array.isArray(ids) || ids.length < 2 || ids.length !== item.content.length
    || ids.some((id) => typeof id !== "string" || !requestIdPattern.test(id)) || new Set(ids).size !== ids.length) return null;
  const messages: Array<{ id: string; requestId: string; text: string }> = [];
  for (const [index, block] of item.content.entries()) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return null;
    messages.push({ id: `${item.id}-batch-${index + 1}`, requestId: ids[index], text: block.text });
  }
  return messages;
}
