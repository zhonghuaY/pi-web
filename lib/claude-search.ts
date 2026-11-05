import type { SessionInfo } from "./types";
import type { SessionSearchResponse, SessionSearchResult } from "./session-search";

function snippet(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return null;
  return {
    before: text.slice(Math.max(0, index - 80), index),
    match: text.slice(index, index + query.length),
    after: text.slice(index + query.length, index + query.length + 80),
  };
}

export async function searchClaudeSessions(sessions: SessionInfo[], query: string, signal: AbortSignal): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  if (!query.trim() || !sessions.length || signal.aborted) return response;
  const { readClaudeSession } = await import("./agent-backends/claude");
  const deadline = Date.now() + 3000;
  const candidates = sessions.filter((s) => s.relation?.kind !== "side").sort((a, b) => b.modified.localeCompare(a.modified));
  for (const session of candidates) {
    if (signal.aborted || Date.now() >= deadline || response.results.length >= 30) {
      response.truncated = true;
      break;
    }
    let hit: SessionSearchResult | undefined;
    try {
      const { context } = await readClaudeSession(session.id, { tail: 1000 });
      response.truncated ||= context.hasMore;
      for (const [index, message] of context.messages.entries()) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        for (const [blockIndex, block] of blocks.entries()) {
          if (block.type !== "text") continue;
          const match = snippet(block.text, query);
          if (match) { hit = { session, entryId: context.entryIds[index], blockIndex, ...match }; break; }
        }
        if (hit) break;
      }
    } catch { response.truncated = true; }
    if (!hit) {
      const match = snippet(session.name || session.firstMessage || "", query);
      if (match) hit = { session, blockIndex: 0, titleMatch: true, ...match };
    }
    if (hit) response.results.push(hit);
  }
  return response;
}
