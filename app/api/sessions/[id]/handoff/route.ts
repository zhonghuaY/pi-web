import { NextResponse } from "next/server";
import {
  createSessionHandoff,
  parseSessionHandoffRequest,
  SessionHandoffError,
} from "@/lib/session-handoff-server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  try {
    return NextResponse.json({ success: true, data: await createSessionHandoff(id, parsed) });
  } catch (error) {
    const status = error instanceof SessionHandoffError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status });
  }
}
