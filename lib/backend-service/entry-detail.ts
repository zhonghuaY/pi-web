import { parseSessionKey } from "@/lib/session-identity";
import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "@/lib/tool-result-images";

export interface EntryDetailRequest { id: string; entryId: string; blockIndex: number }
type IdentityFailure =
  | { ok: false; kind: "invalid"; reason: "invalid-id" | "unknown-namespace" }
  | { ok: false; kind: "unsupported" }
  | { ok: false; kind: "not-found" };
type EntryFailure = IdentityFailure | { ok: false; kind: "entry-not-found" | "block-not-found" };
export type ThinkingResult = { ok: true; value: { thinking: string } } | EntryFailure;
export type ToolResultImageResult = { ok: true; value: { mime: string; bytes: Uint8Array } }
  | EntryFailure | { ok: false; kind: "unsupported-mime" | "invalid-image" };

async function findEntry({ id, entryId }: EntryDetailRequest) {
  const identity = parseSessionKey(id);
  if (!identity.ok) return { ok: false, kind: "invalid", reason: identity.reason } as const;
  if (identity.key.backend === "codex") return { ok: false, kind: "unsupported" } as const;
  const filePath = await resolveSessionPath(id);
  if (!filePath) return { ok: false, kind: "not-found" } as const;
  // SessionManager-backed parsing preserves the SDK's malformed-line tolerance.
  return { ok: true, entry: getSessionEntries(filePath).find((candidate) => candidate.id === entryId) } as const;
}

export async function thinking(request: EntryDetailRequest): Promise<ThinkingResult> {
  const result = await findEntry(request);
  if (!result.ok) return result;
  const entry = result.entry;
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return { ok: false, kind: "entry-not-found" };
  const block = entry.message.content[request.blockIndex];
  if (!block || block.type !== "thinking") return { ok: false, kind: "block-not-found" };
  return { ok: true, value: { thinking: block.thinking } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBase64Image(block: unknown): { data: string; mime: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;
  if (typeof block.data === "string" && typeof block.mimeType === "string") return { data: block.data, mime: block.mimeType };
  if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string" && typeof block.source.media_type === "string") {
    return { data: block.source.data, mime: block.source.media_type };
  }
  return null;
}

function decodeBoundedBase64(data: string): Uint8Array | null {
  // Reject malformed and obviously oversized payloads before allocating.
  if (data.length === 0 || data.length > Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) + 4 ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_TOOL_RESULT_IMAGE_BYTES) return null;
  return new Uint8Array(bytes);
}

export async function toolResultImage(request: EntryDetailRequest): Promise<ToolResultImageResult> {
  const result = await findEntry(request);
  if (!result.ok) return result;
  const entry = result.entry;
  if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") return { ok: false, kind: "entry-not-found" };
  const image = readBase64Image(entry.message.content[request.blockIndex]);
  if (!image) return { ok: false, kind: "block-not-found" };
  if (!TOOL_RESULT_IMAGE_MIMES.has(image.mime)) return { ok: false, kind: "unsupported-mime" };
  const bytes = decodeBoundedBase64(image.data);
  if (!bytes) return { ok: false, kind: "invalid-image" };
  return { ok: true, value: { mime: image.mime, bytes } };
}
