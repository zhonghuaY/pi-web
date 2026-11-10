import { getRpcSession } from "@/lib/rpc-manager";
import { createSideSession, forkSessionBranch, readForkSourceTitle, SessionForkError } from "@/lib/session-fork";
import type { SessionForkRefusal } from "@/lib/session-fork";
import {
  cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache,
  readLatestSessionEntryId, readSessionInfo, resolveSessionPath,
} from "@/lib/session-reader";
import type { SessionInfo } from "@/lib/types";

export interface SessionForkRequest { id: string; side: boolean; sideName?: string }
export type SessionForkResult =
  | { ok: true; value: { sessionId: string; session: SessionInfo } }
  | { ok: false; kind: "refusal"; code: SessionForkRefusal; error: string }
  | { ok: false; kind: "failed"; error: string };

export async function fork({ id, side, sideName }: SessionForkRequest): Promise<SessionForkResult> {
  try {
    const opened = getRpcSession(id);
    const sourcePath = (opened?.isAlive() ? opened.sessionFile : "") || await resolveSessionPath(id);
    if (!sourcePath) {
      invalidateSessionListCache();
      return { ok: false, kind: "refusal", code: "not_found", error: "Session not found" };
    }
    // The title the sidebar shows for the source, which the copy's name
    // starts with (null: the source has none, the copy stays unnamed). Read
    // first: the copy below allows no await.
    const sourceTitle = side ? null : await readForkSourceTitle(sourcePath);

    // No await from here until the copy exists: pi appends finished entries
    // synchronously in this process, so the leaf read here and the file read
    // by forkSessionBranch() see the same entries. The leaf is the one
    // GET /api/sessions/[id] shows: the open wrapper's, else the file's.
    const wrapper = getRpcSession(id);
    let liveLeafId = wrapper?.isAlive() ? wrapper.inner.sessionManager.getLeafId() : undefined;
    if (wrapper && liveLeafId !== undefined && !wrapper.isRunning()) {
      // Another pi process appended to the file of an idle wrapper: a page
      // load (GET ?force=1) would drop the wrapper and show the file instead.
      const diskLatest = readLatestSessionEntryId(wrapper.sessionFile);
      if (diskLatest && !wrapper.inner.sessionManager.getEntry(diskLatest)) liveLeafId = undefined;
    }
    const copy = side ? createSideSession(sourcePath, liveLeafId, sideName) : forkSessionBranch(sourcePath, liveLeafId, sourceTitle);
    cacheSessionPath(copy.sessionId, copy.path);
    invalidateSessionListCache();

    // Read after the name was written: the row carries it.
    const info = await readSessionInfo(copy.path);
    if (!info) throw new Error("The forked session could not be read");
    // Only the copy was scanned, so its origin is added here.
    const session: SessionInfo = {
      ...info,
      parentSessionId: id,
      relation: side ? { kind: "side", parentSessionId: id } : { kind: "fork", originSessionId: id },
    };
    return { ok: true, value: { sessionId: copy.sessionId, session } };
  } catch (error) {
    if (error instanceof SessionForkError) {
      if (error.code === "not_found") {
        // Deleted behind the cached path (the pi CLI, another window): the
        // list drops it on the next load.
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
      }
      return { ok: false, kind: "refusal", code: error.code, error: error.message };
    }
    return { ok: false, kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
