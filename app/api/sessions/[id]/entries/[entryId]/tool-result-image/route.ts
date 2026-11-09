import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { sessionRouteRefusal } from "@/lib/session-route-identity";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const refusal = sessionRouteRefusal(id);
  if (refusal) return refusal;
  const blockIndexParam = new URL(req.url).searchParams.get("blockIndex");
  const blockIndex = blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return NextResponse.json({ error: "Valid blockIndex is required" }, { status: 400 });
  }

  try {
    const result = await sessions.toolResultImage({ id, entryId, blockIndex });
    if (!result.ok) {
      if (result.kind === "invalid" || result.kind === "unsupported") return sessionRouteRefusal(id)!;
      const error = result.kind === "not-found" ? "Session not found"
        : result.kind === "entry-not-found" ? "Tool result not found"
        : result.kind === "block-not-found" ? "Tool result image not found"
        : result.kind === "unsupported-mime" ? "Unsupported image type" : "Invalid or oversized image data";
      const status = result.kind === "unsupported-mime" ? 415 : result.kind === "invalid-image" ? 413 : 404;
      return NextResponse.json({ error }, { status });
    }
    const { mime, bytes } = result.value;
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new Response(body, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.byteLength),
        // A session's entry id and block index name these bytes for good: pi
        // only appends, a migration's rewrite keeps every entry, and a context
        // edit leaves raw history alone. Revalidating re-sent multi-MB images
        // and decoded their base64 again on each view.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
