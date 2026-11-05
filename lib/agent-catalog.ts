import type { SessionInfo } from "./types";

let backendPromise: Promise<typeof import("./agent-backends/claude")> | undefined;

export function claudeBackend() {
  return backendPromise ??= import("./agent-backends/claude");
}

export function claudeEnabled(): boolean {
  return process.env.PI_WEB_CLAUDE !== "0" && process.env.PI_WEB_CLAUDE !== "false";
}

export async function readClaudeCatalogue(): Promise<{ sessions: SessionInfo[]; error?: string }> {
  try {
    const { listClaudeSessions } = await claudeBackend();
    return { sessions: await listClaudeSessions() };
  } catch {
    return { sessions: [], error: "Claude session history is unavailable" };
  }
}

export async function readClaudeRuntime() {
  if (!claudeEnabled()) return { sessions: [], runningSessionIds: [], awaitingInputSessionIds: [], subagentsActiveSessionIds: [] };
  const { getClaudeRuntimeSnapshot } = await claudeBackend();
  return getClaudeRuntimeSnapshot();
}
