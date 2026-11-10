import { NextResponse } from "next/server";
import { sessions } from "@/lib/backend-service";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  let query: URLSearchParams;
  try {
    query = new URL(req.url).searchParams;
  } catch {
    return NextResponse.json({ error: "Invalid native inventory scope" }, { status: 400, headers });
  }
  const backend = query.get("backend"), kind = query.get("kind"), cwd = query.get("cwd"), sessionId = query.get("sessionId");
  if (backend !== "codex" || ![...query.keys()].every(key => ["backend", "kind", "cwd", "sessionId"].includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1)) return NextResponse.json({ error: "Invalid native inventory scope" }, { status: 400, headers });
  let result;
  if (kind === "skills" && cwd) {
    result = sessionId
      ? await sessions.inventory({ backend, kind, cwd, sessionId })
      : await sessions.inventory({ backend, kind, cwd });
  } else if (kind === "mcp" && sessionId && cwd === null) {
    result = await sessions.inventory({ backend, kind, sessionId });
  } else {
    return NextResponse.json({ error: "A native cwd or active session is required" }, { status: 400, headers });
  }
  return NextResponse.json(result.body, { status: result.status, headers });
}
