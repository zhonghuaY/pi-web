import { readClaudeSubagents } from "@/lib/claude-subagents";
import { parseSessionKey } from "@/lib/session-identity";

export interface SessionSubagentsRequest { id: string; agentId?: string }
export type SessionSubagentsResult =
  | { ok: true; value: Awaited<ReturnType<typeof readClaudeSubagents>> }
  | { ok: false; kind: "invalid"; reason: "invalid-id" | "unknown-namespace" }
  | { ok: false; kind: "unsupported" }
  | { ok: false; kind: "wrong-backend" }
  | { ok: false; kind: "claude-error"; status: number; error: string };

export async function subagents({ id, agentId }: SessionSubagentsRequest): Promise<SessionSubagentsResult> {
  const identity = parseSessionKey(id);
  if (!identity.ok) return { ok: false, kind: "invalid", reason: identity.reason };
  if (identity.key.backend === "codex") return { ok: false, kind: "unsupported" };
  if (identity.key.backend === "pi") return { ok: false, kind: "wrong-backend" };
  try {
    return { ok: true, value: await readClaudeSubagents(id, agentId) };
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status : 400;
    return { ok: false, kind: "claude-error", status, error: error instanceof Error ? error.message : "Claude operation failed" };
  }
}
