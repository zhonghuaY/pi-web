import type { CodexPayloads } from "./internal/payloads";

export type CompactionProgress = {
  sent: boolean;
  baseline: Set<string>;
  lifecycle: { kind: "waiting" } | { kind: "running"; turnId: string; itemIds: Set<string> };
  resolve: (completion: { turnId: string; itemIds: Set<string>; status: string } | null) => void;
};
type Method = "turn/started" | "turn/completed" | "item/started" | "item/completed" | "error";
export type CompactionNotification = { [M in Method]: { method: M; params: CodexPayloads[M] } }[Method];

// An ack has no turn identity. Only a fresh started turn with its own completed
// contextCompaction item can establish a lifecycle for the blocking operation.
export function observeCompaction(progress: CompactionProgress, event: CompactionNotification, threadId: string) {
  if (!progress.sent || event.params.threadId.toLowerCase() !== threadId.toLowerCase()) return;
  if (event.method === "turn/started") {
    if (progress.lifecycle.kind === "waiting" && !progress.baseline.has(event.params.turn.id)) {
      progress.lifecycle = { kind: "running", turnId: event.params.turn.id, itemIds: new Set() };
    }
    return;
  }
  const lifecycle = progress.lifecycle;
  if (lifecycle.kind !== "running") return;
  const turnId = event.method === "turn/completed" ? event.params.turn.id : event.params.turnId;
  if (turnId !== lifecycle.turnId) return;
  if (event.method === "item/completed" && event.params.item.type === "contextCompaction") lifecycle.itemIds.add(event.params.item.id);
  if (event.method === "turn/completed") {
    const status = event.params.turn.status;
    if (status !== "completed" || lifecycle.itemIds.size) progress.resolve({ ...lifecycle, status });
  }
}

export function compactionPersisted(thread: CodexPayloads["thread/read"]["thread"], completion: { turnId: string; itemIds: Set<string> }) {
  const turn = thread.turns.find(row => row.id === completion.turnId && row.status === "completed");
  return Boolean(turn && [...completion.itemIds].every(id => turn.items.some(item => item.id === id && item.type === "contextCompaction")));
}
