import { getSessionEntries, resolveSessionPath } from "./session-reader";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isFilePathReferencedByClaudeMessages,
  isValidSessionId,
} from "./session-file-references-core";

export async function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    if (sessionId.startsWith("claude:")) {
      const { getClaudeDisplayMessages } = await import("./agent-backends/claude");
      return isFilePathReferencedByClaudeMessages(filePath, await getClaudeDisplayMessages(sessionId));
    }
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isFilePathReferencedByEntries(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}

export async function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isBashOutputPathReferencedByEntries(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}
