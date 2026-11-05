import lockfile from "proper-lockfile";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isNativeClaudeSessionId } from "./types";

export type ReleaseClaudeWriterLock = () => Promise<void>;

export async function acquireClaudeWriterLock(nativeSessionId: string): Promise<ReleaseClaudeWriterLock> {
  if (!isNativeClaudeSessionId(nativeSessionId)) throw new Error("Invalid native Claude session id");
  const root = join(tmpdir(), "pi-web-claude-session-locks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, nativeSessionId);
  const handle = await open(target, "a", 0o600);
  await handle.close();
  try {
    return await lockfile.lock(target, { realpath: false, stale: 60_000, retries: 0 });
  } catch (error) {
    throw new Error("Claude session already has a Pi Web writer", { cause: error });
  }
}
