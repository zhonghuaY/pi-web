import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";

// POST /api/agent/[id]/lease renews the selected session without starting a wrapper.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await sessions.lease({ id });
  if (!result.ok) {
    if (result.kind === "invalid") return NextResponse.json({ error: "Invalid session id", reason: result.reason }, { status: 400 });
    return NextResponse.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
  }
  return NextResponse.json(result.value, { headers: { "Cache-Control": "no-store" } });
}
