import { NextResponse } from "next/server";
import { sessions, type SessionHistoryFailure } from "@/lib/backend-service";
import { cwdMissingBody, missingCwdFromBody } from "@/lib/missing-cwd";

function historyFailure(result: SessionHistoryFailure) {
  if (result.kind === "invalid") return NextResponse.json({ error: "Invalid session id", reason: result.reason }, { status: 400 });
  if (result.kind === "unsupported") return NextResponse.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
  if (result.kind === "not-found") return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const { backend, error } = result;
  if (backend === "pi") return NextResponse.json({ error: String(error) }, { status: 500 });
  if (backend === "codex") {
    const cwd = missingCwdFromBody(error);
    if (cwd) return NextResponse.json(cwdMissingBody(cwd), { status: 409 });
    const kind = typeof error === "object" && error !== null && "kind" in error ? error.kind : undefined;
    const reason = kind === "unavailable" || kind === "version" || kind === "spawn" ? "backend-unavailable" : kind === "invalid-payload" ? "invalid-payload" : "history-unavailable";
    return NextResponse.json({ error: "Codex session history is unavailable", reason }, { status: kind === "invalid-payload" ? 502 : 503 });
  }
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Claude operation failed" }, { status });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const result = await sessions.context(id, {
    tail: Number(query.get("tail")), before: query.get("before") ?? undefined,
    leafId: query.get("leafId") ?? undefined,
    deferThinking: query.has("deferThinking"), deferToolResultImages: query.has("deferMedia"),
  });
  if (!result.ok) return historyFailure(result);
  return NextResponse.json(result.value, result.backend !== "pi" ? { headers: { "Cache-Control": "no-store" } } : undefined);
}
