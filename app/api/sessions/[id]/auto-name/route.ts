import { NextResponse } from "next/server";
import { sessionRouteRefusal } from "@/lib/session-route-identity";
import { sessions } from "@/lib/backend-service";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const invalidSession = sessionRouteRefusal(id);
  if (invalidSession) return invalidSession;

  const result = await sessions.autoName(id);
  return NextResponse.json(result.body, { status: result.status });
}
