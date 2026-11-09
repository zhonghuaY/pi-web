import { formatSessionKey, parseSessionKey } from "@/lib/session-identity";

export function codexWebSessionId(nativeId: string): string {
  const result = parseSessionKey(`codex:${nativeId}`);
  if (!result.ok || result.key.backend !== "codex") throw new Error("Invalid Codex thread id");
  return formatSessionKey(result.key);
}

export function nativeCodexSessionId(webId: string): string {
  const result = parseSessionKey(webId);
  if (!result.ok || result.key.backend !== "codex") throw new Error("Invalid Codex session id");
  return result.key.nativeId.toLowerCase();
}
