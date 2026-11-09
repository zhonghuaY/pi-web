import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { sessions } from "@/lib/backend-service";
import { cwdMissingBody } from "@/lib/missing-cwd";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    if (body.backend === "claude" || body.backend === "codex") {
      const result = await sessions.createRuntime(body);
      return NextResponse.json(result.body, { status: result.status });
    }
    if (body.backend !== undefined && body.backend !== "pi") return NextResponse.json({ error: "Unknown agent backend" }, { status: 400 });
    const { cwd, provider, modelId, thinkingLevel } = body;
    commandType = typeof body.type === "string" ? body.type : undefined;
    if (!cwd || typeof cwd !== "string") return NextResponse.json({ error: "cwd is required", ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}) }, { status: 400 });
    if (!existsSync(cwd)) return NextResponse.json({ ...cwdMissingBody(cwd), ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}) }, { status: 400 });
    if ((provider && !modelId) || (!provider && modelId)) throw new Error("provider and modelId must be provided together");
    const result = await sessions.createRuntime(body, parseThinkingLevel(thinkingLevel));
    promptAccepted = commandType === "prompt";
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), ...(commandType === "prompt" && !promptAccepted ? { code: "prompt_rejected", accepted: false } : {}) }, { status: 500 });
  }
}
