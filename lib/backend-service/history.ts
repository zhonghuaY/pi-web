import { existsSync, statSync } from "fs";
import { attachSessionProjectInfo, openSessionManager, resolveSessionPath, resolveSessionIdByPath, buildSessionContext, toSessionEntries } from "@/lib/session-reader";
import { getRpcSession, subagentDisplayStatus } from "@/lib/rpc-manager";
import { projectTreeForResponse, toSummaryTree } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import type { ServerPerf } from "@/lib/perf";
import { computeSessionRevision } from "@/lib/session-revision";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSideRelation, sideOwnEntries } from "@/lib/side-session";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { attachTranscriptNotices, readSessionTranscriptNotices } from "@/lib/transcript-notices-server";
import { sessionHandoffRelation, sessionHandoffTitle } from "@/lib/session-handoff";

export interface PiHistoryOptions {
  tail: number;
  before?: string;
  leafId?: string;
  deferThinking: boolean;
  deferToolResultImages: boolean;
}

export interface PiReadOptions extends PiHistoryOptions {
  force: boolean;
  summaryTree: boolean;
}

export async function readPiSession(id: string, options: PiReadOptions, perf?: ServerPerf) {
  perf?.span("resolve");
  const rpc = getRpcSession(id);
  const { force, summaryTree, deferThinking, deferToolResultImages, tail } = options;

  // A live wrapper only reflects the appends pi-web itself made. When another
  // pi process (the TUI) writes the same session file, the in-memory index
  // stays stale. Only probe on ?force=1 (session mount / page refresh): two
  // processes writing one JSONL is unsupported, so post-turn reads must not
  // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
  let liveWrapper = rpc?.isAlive() ? rpc : undefined;
  let wrapperRebuilt = false;
  if (force && liveWrapper?.evictIfDiskAhead()) {
    wrapperRebuilt = true;
    liveWrapper = undefined;
  }
  const liveRpc = liveWrapper;
  const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
  if (!liveRpc && !resolvedPath) {
    return null;
  }

  const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
  perf?.span("open");
  const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
  const entries = sm.getEntries();
  const leafId = sm.getLeafId();
  const tree = summaryTree
    ? toSummaryTree(projectTreeForResponse(sm.getTree()))
    : projectTreeForResponse(sm.getTree());
  perf?.span("tree");
  // pi's showCacheMissNotices (#1265): cache, cost and provider notices on the messages they follow.
  const transcriptNotices = readSessionTranscriptNotices({
    entries: toSessionEntries(entries),
    cwd: sm.getHeader()?.cwd ?? "",
    leafId: leafId,
    models: liveRpc?.inner.modelRuntime,
  });
  const context = attachTranscriptNotices(buildSessionContext(entries as never, leafId, {
    deferThinking,
    deferToolResultImages,
    tail,
    sessionId: id, // local: lazy URLs for historical tool-result images
  }), transcriptNotices);
  perf?.span("context");
  const ownEntries = sideOwnEntries(entries) as typeof entries;
  const totalActiveMs = computeSessionTotalActiveMs(ownEntries);
  // Cumulative usage over ALL entries, including history compacted away —
  // the same aggregation the SDK's getSessionStats() uses. Lets the client
  // keep monotonic token/cost counters across compaction and page reloads.
  const stats = computeSessionStats(toSessionEntries(ownEntries));
  perf?.span("stats");
  // Opaque freshness token for the session view cache. Derived from the
  // disk fingerprint and the actual read source; null tells the client the
  // snapshot is unstable and must not be cached as fresh.
  const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
  const snapshotRevision = computeSessionRevision({
    filePath,
    // The notices switch changes the messages without touching the file.
    sourceId: `${liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : "disk"}${transcriptNotices ? "+notices" : ""}`,
    entryCount: entries.length,
    latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
    leafId: leafId ?? null,
  });
  const sessionName = sm.getSessionName();
  const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
  const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

  const header = sm.getHeader();
  let modified = header?.timestamp ?? new Date().toISOString();
  try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
  const parentSessionId = header?.parentSession
    ? await resolveSessionIdByPath(header.parentSession)
    : undefined;
  const subagent = header
    ? readSubagentRun(entries as never, header.id, filePath)
    : null;
  const side = !subagent && header ? readSideRelation(entries as never) : null;
  const toolNames = readSubagentSessionResources(entries as never)?.tools
    ?? readSessionToolSelection(entries as never);
  const firstUserText = firstUserMessage
    ? (() => {
        const content = (firstUserMessage as { content: unknown }).content;
        return typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content.find((block: { type: string }) => block.type === "text") as { text: string } | undefined)?.text ?? ""
            : "";
      })()
    : "";
  const handoff = sessionHandoffRelation(firstUserText);
  const info = header ? (await attachSessionProjectInfo([{
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    name: sessionName,
    created: header.timestamp,
    modified,
    messageCount: stats.totalMessages,
    firstMessage: (sessionHandoffTitle(firstUserText, "pi") ?? firstUserText) || "(no messages)",
    parentSessionId,
    ...(subagent
      ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagentDisplayStatus(header.id, subagent.status) } }
      : side
        ? { relation: { kind: "side" as const, ...side } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : handoff
            ? { relation: handoff }
            : {}),
    transient: !filePath || !existsSync(filePath),
  }]))[0] : null;


  return {
      sessionId: id,
    filePath,
    info,
    leafId,
    tree,
    ...(summaryTree ? { treeFormat: "summary" as const } : {}),
    snapshotRevision,
    context,
    stats,
    totalActiveMs,
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
  };
}

export async function readPiContext(id: string, options: PiHistoryOptions) {
  const { leafId, before, tail, deferThinking, deferToolResultImages } = options;
  const rpc = getRpcSession(id);
  const liveRpc = rpc?.isAlive() ? rpc : undefined;
  const filePath = liveRpc ? null : await resolveSessionPath(id);
  if (!liveRpc && !filePath) {
    return null;
  }

  const sm = liveRpc?.inner.sessionManager ?? openSessionManager(filePath!);
  // `before` is the oldest entry already on the client; fetch its ancestors
  // only (excludeLeaf) so prepending the page does not duplicate `before`.
  const entries = sm.getEntries();
  const transcriptNotices = readSessionTranscriptNotices({
    entries: toSessionEntries(entries),
    cwd: sm.getHeader()?.cwd ?? "",
    leafId: leafId ?? sm.getLeafId(),
    models: liveRpc?.inner.modelRuntime,
  });
  const context = attachTranscriptNotices(buildSessionContext(entries as never, before ?? leafId, {
    deferThinking,
    deferToolResultImages,
    tail,
    excludeLeaf: Boolean(before),
    sessionId: id,
  }), transcriptNotices);

  return { context, tail, before: before ?? null };
}
