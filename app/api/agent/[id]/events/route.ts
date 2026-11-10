import { sessionRouteRefusal } from "@/lib/session-route-identity";
import { sessions } from "@/lib/backend-service";
import { isValidLivenessHolder } from "@/lib/session-liveness";
import { describeStreamClient } from "@/lib/stream-client";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id, { allowCodex: true });
  if (invalidSession) return invalidSession;
  const holderParam = new URL(req.url).searchParams.get("holder");
  const holder = isValidLivenessHolder(holderParam) ? holderParam : null;
  const result = await sessions.runtimeEvents(id, req.signal, { holder, ...describeStreamClient(req.headers) });
  if (result.kind === "error") return Response.json(result.body, { status: result.status });
  if (result.kind === "aborted") return new Response(null, { status: 204 });
  if (result.kind === "not-found") return new Response("Session not found", { status: 404 });
  return new Response(result.stream, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    ...(result.claude ? {} : { Connection: "keep-alive" }),
    "X-Accel-Buffering": "no",
  } });
}
