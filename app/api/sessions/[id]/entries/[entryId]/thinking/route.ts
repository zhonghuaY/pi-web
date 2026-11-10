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
    const result = await sessions.thinking({ id, entryId, blockIndex });
    if (result.ok) return NextResponse.json(result.value);
    if (result.kind === "invalid" || result.kind === "unsupported") return sessionRouteRefusal(id)!;
    const error = result.kind === "not-found" ? "Session not found"
      : result.kind === "entry-not-found" ? "Assistant message not found" : "Thinking block not found";
    return NextResponse.json({ error }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
