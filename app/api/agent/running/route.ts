import { NextResponse } from "next/server";
import { readClaudeRuntime } from "@/lib/agent-catalog";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getSessionUiStateRevision } from "@/lib/session-ui-state";
import { getSessionIdsWithUnsettledSubagentRuns } from "@/lib/subagent-runtime";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
// subagentsActiveSessionIds: sessions whose subagents can still start a run
// there, so the sidebar announces their completion only after the last one.
export async function GET() {
  const claude = await readClaudeRuntime();
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: [...getRunningRpcSessionIds(), ...claude.runningSessionIds],
      awaitingInputSessionIds: [...getAwaitingInputRpcSessionIds(), ...claude.awaitingInputSessionIds],
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      subagentsActiveSessionIds: [...getSessionIdsWithUnsettledSubagentRuns(), ...claude.subagentsActiveSessionIds],
      sessionUiStateRevision: getSessionUiStateRevision(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
