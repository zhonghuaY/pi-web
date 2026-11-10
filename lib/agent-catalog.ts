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

export async function readCodexCatalogue(): Promise<{ sessions: SessionInfo[]; error?: string }> {
  const { codexEnabled } = await import("./agent-backends/codex/descriptor");
  if (!codexEnabled()) return { sessions: [] };
  try {
    const [{ mapCodexThreadsWithHistory }, { mergeCodexCatalogue, projectCodexSessionInfo }] = await Promise.all([
      import("./agent-backends/codex/catalogue"), import("./agent-backends/codex/projection"),
    ]);
    const { rows, incomplete } = await mapCodexThreadsWithHistory((thread) => {
      const projection = projectCodexSessionInfo(thread);
      return projection.state === "projected" ? projection.info : null;
    });
    return {
      sessions: mergeCodexCatalogue(rows),
      ...(incomplete ? { error: "Codex session history is unavailable" } : {}),
    };
  } catch {
    return { sessions: [], error: "Codex session history is unavailable" };
  }
}

export async function readClaudeRuntime() {
  if (!claudeEnabled()) return { sessions: [], runningSessionIds: [], awaitingInputSessionIds: [], subagentsActiveSessionIds: [] };
  const { getClaudeRuntimeSnapshot } = await claudeBackend();
  return getClaudeRuntimeSnapshot();
}
