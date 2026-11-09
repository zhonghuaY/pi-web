import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { sessionRouteRefusal } from "@/lib/session-route-identity";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id);
  if (invalidSession) return invalidSession;
  let path: string | null;
  let download: boolean;
  try {
    const url = new URL(req.url);
    path = url.searchParams.get("path");
    download = url.searchParams.get("download") === "1";
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  const result = await sessions.bashOutput(id, path, download);
  if (result.kind === "invalid-id") return NextResponse.json({ error: "Invalid session id", reason: result.reason }, { status: 400 });
  if (result.kind === "unsupported") return NextResponse.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
  if (result.kind === "invalid-path") return NextResponse.json({ error: "invalid path" }, { status: 400 });
  if (result.kind === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (result.kind === "unavailable") return NextResponse.json({ error: "full output unavailable" }, { status: 404 });
  if (result.kind === "too-large") return NextResponse.json({ error: `Full output is too large to display (limit ${result.maxBytes} bytes)`, data: { size: result.size, maxBytes: result.maxBytes } }, { status: 413 });
  if (result.kind === "download") return new Response(result.stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=\"bash-output.log\"", "Cache-Control": "no-store" } });
  return NextResponse.json({ success: true, data: { output: result.output } });
}
