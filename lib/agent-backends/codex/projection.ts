import { sessionHandoffRelation, sessionHandoffTitle } from "@/lib/session-handoff";
import type { SessionInfo } from "@/lib/types";
import type { AgentBackendCapabilities } from "@/lib/agent-backends/types";
import type { CodexThread } from "./catalogue";
import { codexWebSessionId } from "./identity";
import { firstCodexUserText } from "./user-envelope";

export const CODEX_CAPABILITIES: Readonly<AgentBackendCapabilities> = Object.freeze({
  backend: "codex", history: true, prompt: true, stop: true, followUp: true, steer: true,
  fork: true, treeBranch: false, export: false, compact: true, mcp: true, skills: true, side: false,
  toolPresets: false, forkAtEntry: false, sideChat: false, rename: false, delete: false,
  tools: false, commands: false, models: true, setModel: true, effort: true,
  permissionMode: false, subagents: "none", nativeConfig: "none", requiresExplicitProjectTrust: false,
});

export type CodexInfoProjection =
  | { state: "projected"; info: SessionInfo }
  | { state: "filtered"; reason: "invalid-id" | "missing-cwd" | "invalid-timestamp" };

export function projectCodexSessionInfo(thread: CodexThread): CodexInfoProjection {
  let id: string;
  try { id = codexWebSessionId(thread.id); }
  catch { return { state: "filtered", reason: "invalid-id" }; }
  if (!thread.cwd) return { state: "filtered", reason: "missing-cwd" };
  let forkOrigin: string | undefined;
  if ("forkedFromId" in thread && typeof thread.forkedFromId === "string") {
    try { forkOrigin = codexWebSessionId(thread.forkedFromId); } catch { /* Invalid optional ancestry does not hide readable history. */ }
  }
  const created = new Date(thread.createdAt * 1000);
  const modified = new Date(thread.updatedAt * 1000);
  if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) return { state: "filtered", reason: "invalid-timestamp" };
  const firstUserText = firstCodexUserText(thread) ?? "";
  const handoff = sessionHandoffRelation(firstUserText);
  return {
    state: "projected",
    info: {
      backend: "codex", capabilities: CODEX_CAPABILITIES, id, path: id, cwd: thread.cwd,
      ...(thread.name ? { name: thread.name } : {}),
      ...(forkOrigin ? { parentSessionId: forkOrigin, relation: { kind: "fork", originSessionId: forkOrigin } } : {}),
      created: created.toISOString(), modified: modified.toISOString(),
      messageCount: 0, firstMessage: sessionHandoffTitle(firstUserText, "codex") ?? thread.preview,
      ...(handoff && !forkOrigin ? { relation: handoff } : {}),
      detailsPending: true, transient: thread.ephemeral,
    },
  };
}

export function mergeCodexCatalogue(infos: readonly SessionInfo[]): SessionInfo[] {
  const sessions = new Map<string, SessionInfo>();
  for (const info of infos) {
    const previous = sessions.get(info.id);
    if (!previous || previous.modified < info.modified) sessions.set(info.id, info);
  }
  return [...sessions.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

export function projectCodexCatalogue(threads: readonly CodexThread[]): SessionInfo[] {
  return mergeCodexCatalogue(threads.flatMap((thread) => {
    const projected = projectCodexSessionInfo(thread);
    return projected.state === "projected" ? [projected.info] : [];
  }));
}
