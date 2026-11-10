import { parseSessionKey } from "./session-identity";

export function sessionRouteRefusal(id: string, options: { allowCodex?: boolean } = {}): Response | null {
  const result = parseSessionKey(id);
  if (!result.ok) return Response.json({ error: "Invalid session id", reason: result.reason, ...(options.allowCodex && id.startsWith("codex:") ? { code: "invalid_request", accepted: false } : {}) }, { status: 400 });
  if (result.key.backend === "codex" && !options.allowCodex) return Response.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
  return null;
}
