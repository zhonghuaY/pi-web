import { sessionRouteRefusal } from "@/lib/session-route-identity";
import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { sideChatNameFromText } from "@/lib/session-family";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

// POST /api/sessions/[id]/fork - body {}, or { side: true, name? } for a side
// chat (`/side`, ADR 0007); answers with the new session.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "request-denied", "Content-Type must be application/json");
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id, { allowCodex: true });
  if (invalidSession) {
    invalidSession.headers.set("Cache-Control", "no-store");
    return invalidSession;
  }

  try {
    const body = await req.json().catch(() => null) as { side?: unknown; name?: unknown; entryId?: unknown } | null;
    if (id.startsWith("codex:") && (!body || typeof body !== "object" || Array.isArray(body))) return refusal(400, "invalid_request", "A JSON object is required");
    const side = body?.side === true;
    const sideName = typeof body?.name === "string" ? sideChatNameFromText(body.name) ?? undefined : undefined;
    const result = await sessions.fork({ id, side, sideName, body: body ?? {} });
    if ("kind" in result && result.kind === "native") return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
    if (result.ok) return NextResponse.json(result.value, { headers: NO_STORE });
    if (result.kind === "refusal") return refusal(result.code === "not_found" ? 404 : 409, result.code, result.error);
    return refusal(500, "failed", result.error);
  } catch (error) {
    return refusal(500, "failed", error instanceof Error ? error.message : String(error));
  }
}
