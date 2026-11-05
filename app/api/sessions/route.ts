import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
  withSubagentDisplayStatus,
} from "@/lib/rpc-manager";
import { startServerPerf } from "@/lib/perf";
import { readClaudeCatalogue, readClaudeRuntime } from "@/lib/agent-catalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions, claude, claudeRuntime] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
      readClaudeCatalogue(),
      readClaudeRuntime(),
    ]);
    perf?.span("scan+projects");
    const claudeSessions = await attachSessionProjectInfo(mergeSessionLists(claude.sessions, claudeRuntime.sessions));
    const sessions = mergeSessionLists(withSubagentDisplayStatus(mergeSessionLists(persistedSessions, runtimeSessions)), claudeSessions);
    const runningSessionIds = [...getRunningRpcSessionIds(), ...claudeRuntime.runningSessionIds];
    const awaitingInputSessionIds = [...getAwaitingInputRpcSessionIds(), ...claudeRuntime.awaitingInputSessionIds];
    const response = jsonResponse(req, {
      sessions, sessionListVersion, runningSessionIds, awaitingInputSessionIds,
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      ...(claude.error ? { backendErrors: { claude: claude.error } } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
    return perf?.attach(response) ?? response;
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
