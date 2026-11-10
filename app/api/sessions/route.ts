import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import { startServerPerf } from "@/lib/perf";
import { sessions } from "@/lib/backend-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const result = await sessions.list({ force, summary });
    perf?.span("scan+projects");
    const response = jsonResponse(req, result, { headers: { "Cache-Control": "no-store" } });
    return perf?.attach(response) ?? response;
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
