import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { claudeBackend, claudeEnabled, claudeFailure } from "@/lib/claude-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? process.cwd();
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
      return Response.json({ error: "An existing absolute directory is required" }, { status: 400 });
    }
    const backend = await claudeBackend();
    const nativeConfiguration = await backend.getClaudeConfiguration(cwd);
    const configuration = claudeEnabled() ? nativeConfiguration : { ...nativeConfiguration, available: false, reason: "disabled" };
    return Response.json({
      defaultBackend: "pi",
      backends: [
        { backend: "pi", available: true },
        { backend: "claude", available: configuration.available, configuration, capabilities: backend.CLAUDE_CAPABILITIES },
      ],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return claudeFailure(error); }
}
