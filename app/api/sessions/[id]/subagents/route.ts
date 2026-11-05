import { isClaudeKey, claudeFailure } from "@/lib/claude-routes";
import { readClaudeSubagents } from "@/lib/claude-subagents";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isClaudeKey(id)) return Response.json({ error: "This endpoint reads native Claude subagents" }, { status: 400 });
    const agentId = new URL(req.url).searchParams.get("agentId") ?? undefined;
    return Response.json(await readClaudeSubagents(id, agentId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return claudeFailure(error); }
}
