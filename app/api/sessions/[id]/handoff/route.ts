import { NextResponse } from "next/server";
import { parseSessionKey } from "@/lib/session-identity";
import { parseSessionHandoffRequest } from "@/lib/session-handoff-server";
import { sessions } from "@/lib/backend-service";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const identity = parseSessionKey(id);
  if (!identity.ok) return NextResponse.json({ error: "Invalid session id", reason: identity.reason }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseSessionHandoffRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "targetBackend and a UUID requestId are required" }, { status: 400 });
  }
  const result = await sessions.handoff(id, parsed);
  if (result.ok) return NextResponse.json({ success: true, data: result.value });
  return NextResponse.json({ error: result.message, ...(result.reason ? { reason: result.reason } : {}), ...(result.operationId ? { operationId: result.operationId } : {}) }, { status: result.status });
}
