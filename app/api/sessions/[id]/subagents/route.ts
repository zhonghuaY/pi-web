import { sessions } from "@/lib/backend-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const agentId = new URL(req.url).searchParams.get("agentId") ?? undefined;
    const result = await sessions.subagents({ id, agentId });
    if (result.ok) return Response.json(result.value, { headers: { "Cache-Control": "no-store" } });
    if (result.kind === "invalid") return Response.json({ error: "Invalid session id", reason: result.reason }, { status: 400 });
    if (result.kind === "unsupported") return Response.json({ error: "Codex sessions are not available", reason: "backend-unavailable" }, { status: 400 });
    if (result.kind === "wrong-backend") return Response.json({ error: "This endpoint reads native Claude subagents" }, { status: 400 });
    return Response.json({ error: result.error }, { status: result.status });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status : 400;
    return Response.json({ error: error instanceof Error ? error.message : "Claude operation failed" }, { status });
  }
}
