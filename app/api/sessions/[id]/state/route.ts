import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await sessions.state({ id, missingPi: "not-found", includeSystemPrompt: true });
  if (!result.ok) {
    if (result.kind === "invalid") return NextResponse.json({ error: "Invalid session id", reason: result.reason }, { status: 400 });
    if (result.kind === "unsupported") return NextResponse.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
    if (result.kind === "not-found") return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (result.backend === "claude") {
      const error = result.error;
      const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
      return NextResponse.json({ error: error instanceof Error ? error.message : "Claude operation failed" }, { status });
    }
    return NextResponse.json({ error: String(result.error) }, { status: 500 });
  }
  return NextResponse.json(result.value);
}
