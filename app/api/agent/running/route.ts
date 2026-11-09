import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
// subagentsActiveSessionIds: sessions whose subagents can still start a run
// there, so the sidebar announces their completion only after the last one.
export async function GET() {
  return NextResponse.json(await sessions.running(), { headers: { "Cache-Control": "no-store" } });
}
