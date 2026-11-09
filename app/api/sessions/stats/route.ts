import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { SESSION_ID_PATTERN } from "@/lib/session-ui-state-shared";

export const dynamic = "force-dynamic";

// The agent switcher's per-agent usage: the totals the stats popover shows,
// for the main session and each subagent at once. Reads like
// GET /api/sessions/[id] (a live wrapper's entries, else the cached file) and
// never starts an AgentSession. The switcher polls this while an agent runs,
// so a summary is reused until its session gains an entry.

const MAX_SESSION_STATS_IDS = 200;
const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

// POST /api/sessions/stats - body { ids: string[] } (at most MAX_SESSION_STATS_IDS).
// Answers { stats: { [id]: SessionUsageSummary } }; an id not found is left out.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "Content-Type must be application/json");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "Invalid JSON body");
  }
  const ids = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { ids?: unknown }).ids : undefined;
  if (!Array.isArray(ids) || ids.length === 0) return refusal(400, "ids must be a non-empty array");
  if (ids.length > MAX_SESSION_STATS_IDS) return refusal(400, `ids may hold at most ${MAX_SESSION_STATS_IDS} session ids`);
  if (!ids.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id))) return refusal(400, "ids must be session ids");
  const result = await sessions.stats({ ids: ids as string[] });
  if (!result.ok) {
    if (result.kind === "invalid") return NextResponse.json({ error: "Invalid session id", reason: result.reason }, { status: 400 });
    return NextResponse.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
  }
  return NextResponse.json(result.value, { headers: NO_STORE });
}
