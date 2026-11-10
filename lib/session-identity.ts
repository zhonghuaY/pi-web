export type BackendId = "pi" | "claude" | "codex";

export const capabilityNames = [
  "history", "prompt", "stop", "followUp", "steer", "fork", "forkAtEntry", "treeBranch", "export", "compact",
  "side", "tools", "toolPresets", "commands", "models", "setModel", "effort", "permission", "questions", "mcp",
  "skills", "rename", "delete", "images",
] as const;
export type Capability = typeof capabilityNames[number];
export type BackendDescriptor = {
  id: BackendId;
  label: string;
  availability: { state: "available" } | { state: "history-only" | "unavailable"; reason: string };
  capabilities: Readonly<Record<Capability, boolean>>;
  trust: "required" | "not-required" | "unknown";
};

export const backendLabels: Readonly<Record<BackendId, string>> = { pi: "Pi", claude: "Claude", codex: "Codex" };
export function isBackendId(value: unknown): value is BackendId {
  return value === "pi" || value === "claude" || value === "codex";
}

declare const sessionIdBrand: unique symbol;
type NativeId<B extends BackendId> = string & { readonly [sessionIdBrand]: B };
export type SessionKey = { [B in BackendId]: { backend: B; nativeId: NativeId<B> } }[BackendId];
export type SessionKeyResult = { ok: true; key: SessionKey } | { ok: false; reason: "invalid-id" | "unknown-namespace" };

const PI_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CLAUDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_CLAUDE_ID = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSessionKey(value: unknown): SessionKeyResult {
  if (typeof value !== "string" || !value) return { ok: false, reason: "invalid-id" };
  const separator = value.indexOf(":");
  if (separator === -1) return PI_ID.test(value)
    ? { ok: true, key: { backend: "pi", nativeId: value as NativeId<"pi"> } }
    : { ok: false, reason: "invalid-id" };
  const namespace = value.slice(0, separator);
  const nativeId = value.slice(separator + 1);
  if (namespace === "claude" && CLAUDE_ID.test(nativeId)) return { ok: true, key: { backend: "claude", nativeId: nativeId as NativeId<"claude"> } };
  if (namespace === "codex" && CODEX_ID.test(nativeId)) return { ok: true, key: { backend: "codex", nativeId: nativeId as NativeId<"codex"> } };
  return { ok: false, reason: namespace === "claude" || namespace === "codex" ? "invalid-id" : "unknown-namespace" };
}
export function formatSessionKey(key: SessionKey): string {
  return key.backend === "pi" ? key.nativeId : `${key.backend}:${key.nativeId.toLowerCase()}`;
}
export function backendOfSessionKey(key: SessionKey): BackendId { return key.backend; }
export function validateSessionKeyString(value: unknown): value is string {
  return typeof value === "string" && (parseSessionKey(value).ok || LEGACY_CLAUDE_ID.test(value));
}

export type HandoffEdge = { source: BackendId; target: BackendId };
export const handoffEdges: readonly HandoffEdge[] = [
  { source: "pi", target: "claude" }, { source: "pi", target: "codex" },
  { source: "claude", target: "pi" }, { source: "claude", target: "codex" },
  { source: "codex", target: "pi" }, { source: "codex", target: "claude" },
];
export function isHandoffEdge(source: unknown, target: unknown): boolean {
  return handoffEdges.some((edge) => edge.source === source && edge.target === target);
}
