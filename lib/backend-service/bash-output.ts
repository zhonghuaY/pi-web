import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { MAX_INLINE_BASH_OUTPUT_BYTES, openRegularFileNoFollow, readUtf8FileWithinLimit, resolveBashOutputPath } from "@/lib/bash-output";
import { isBashOutputPathReferencedBySession } from "@/lib/session-file-references";
import { parseSessionKey } from "@/lib/session-identity";

export async function bashOutput(id: string, path: string, download: boolean) {
  const identity = parseSessionKey(id);
  if (!identity.ok) return { kind: "invalid-id" as const, reason: identity.reason };
  if (identity.key.backend === "codex") return { kind: "unsupported" as const };
  const resolved = resolveBashOutputPath(path, tmpdir());
  if (!resolved) return { kind: "invalid-path" as const };
  if (!await isBashOutputPathReferencedBySession(resolved, id)) return { kind: "forbidden" as const };
  try {
    if (download) {
      const { handle } = await openRegularFileNoFollow(resolved);
      return { kind: "download" as const, stream: Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array> };
    }
    const result = await readUtf8FileWithinLimit(resolved);
    if (result.tooLarge) return { kind: "too-large" as const, size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES };
    return { kind: "inline" as const, output: result.content };
  } catch {
    return { kind: "unavailable" as const };
  }
}
