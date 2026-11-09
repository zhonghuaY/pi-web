import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sessions } from "@/lib/backend-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? process.cwd();
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
      return Response.json({ error: "An existing absolute directory is required" }, { status: 400 });
    }
    return Response.json(await sessions.describe(cwd), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status : 400;
    return Response.json({ error: error instanceof Error ? error.message : "Claude operation failed" }, { status });
  }
}
