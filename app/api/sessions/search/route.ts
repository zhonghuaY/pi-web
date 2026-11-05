import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { readClaudeCatalogue } from "@/lib/agent-catalog";
import { searchClaudeSessions } from "@/lib/claude-search";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same catalog used by the sidebar. `allowStale`
    // keeps the request off the catalogue rebuild path: agent activity
    // invalidates the scan constantly, and rebuilding it costs hundreds of
    // milliseconds because loadAllSessions() re-reads every forked and subagent
    // session. The trade-off is that a session created in the last couple of
    // seconds is not searched yet; the stale read schedules the rebuild, so the
    // next search sees it.
    const sessions = query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    // A side chat copies its parent's whole text and never opens as the main chat.
    const searchable = sessions.filter((session) => session.relation?.kind !== "side");
    const [pi, claude] = await Promise.all([
      searchSessionContents(searchable, query, request.signal),
      query && !request.signal.aborted
        ? readClaudeCatalogue().then(({ sessions }) => searchClaudeSessions(sessions, query, request.signal))
        : Promise.resolve({ results: [], truncated: false }),
    ]);
    const results = [...pi.results, ...claude.results].sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    return NextResponse.json({ results: results.slice(0, 30), truncated: pi.truncated || claude.truncated || results.length > 30 }, { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
