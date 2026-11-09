import { sessionRouteRefusal } from "@/lib/session-route-identity";
import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { cwdMissingBody, missingCwdFromBody } from "@/lib/missing-cwd";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id, { allowCodex: true });
  if (invalidSession) return invalidSession;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    let body: { type: string; [key: string]: unknown };
    try { body = await req.json() as typeof body; }
    catch (error) {
      if (id.startsWith("codex:")) return NextResponse.json({ error: "Invalid Codex command", code: "invalid_request", accepted: false }, { status: 400 });
      throw error;
    }
    if (id.startsWith("codex:") && (body === null || typeof body !== "object" || Array.isArray(body))) return NextResponse.json({ error: "Invalid Codex command", code: "invalid_request", accepted: false }, { status: 400 });
    commandType = typeof body.type === "string" && !id.startsWith("claude:") && !id.startsWith("codex:") ? body.type : undefined;
    const result = await sessions.commandRuntime(id, body);
    promptAccepted = body.type === "prompt" && result.status === 200;
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Read by its fields: the wrapper that threw may come from another route's bundle.
    const missingCwd = missingCwdFromBody(error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(missingCwd ? cwdMissingBody(missingCwd) : {}),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await sessions.state({
    id,
    missingPi: "idle",
    includeSystemPrompt: new URL(req.url).searchParams.get("systemPrompt") !== "0",
  });
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
