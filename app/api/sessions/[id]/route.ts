import { sessionRouteRefusal } from "@/lib/session-route-identity";
import { NextResponse } from "next/server";
import { sessions, type SessionHistoryFailure } from "@/lib/backend-service";
import { startServerPerf } from "@/lib/perf";
import { jsonResponse } from "@/lib/json-response";
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
  const perf = startServerPerf("GET /api/sessions/[id]");
  const result = await sessions.read(id, {
    tail: Number(query.get("tail")), before: query.get("before") ?? undefined,
    force: query.get("force") === "1", summaryTree: query.get("tree") === "summary",
    deferThinking: query.has("deferThinking"), deferToolResultImages: query.has("deferMedia"),
  }, perf);
  if (!result.ok) return historyFailure(result);
  if (result.backend !== "pi") return NextResponse.json(result.value, { headers: { "Cache-Control": "no-store" } });
  const response = jsonResponse(req, result.value);
  return perf?.attach(response) ?? response;
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id);
  if (invalidSession) return invalidSession;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const result = await sessions.rename({ id, name });
    if (!result.ok) {
      if (result.kind === "disabled") return NextResponse.json({ error: "Claude is disabled" }, { status: 409 });
      if (result.kind === "empty-name") return NextResponse.json({ error: "Name is required" }, { status: 400 });
      return historyFailure(result);
    }
    return NextResponse.json(result.value);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id] - the session and the subagent sessions below it (lib/session-delete.ts).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id);
  if (invalidSession) return invalidSession;
  try {
    const result = await sessions.delete({ id });
    if (!result.ok) {
      if (result.kind === "claude-error") return NextResponse.json({ error: result.error }, { status: result.status });
      return historyFailure(result);
    }
    return NextResponse.json(result.value);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
