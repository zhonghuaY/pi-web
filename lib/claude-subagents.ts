import { getSessionInfo, listSubagents, getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import { nativeClaudeSessionId } from "./agent-backends/types";
import { projectClaudeHistoryMessage } from "./agent-backends/claude-projection";

const historyApi = { getSessionInfo, listSubagents, getSubagentMessages };

export async function readClaudeSubagents(webId: string, agentId?: string, api = historyApi) {
  const nativeId = nativeClaudeSessionId(webId);
  const session = await api.getSessionInfo(nativeId);
  if (!session?.cwd) throw Object.assign(new Error("Claude session not found"), { status: 404 });
  const ids = await api.listSubagents(nativeId, { dir: session.cwd });
  if (agentId === undefined) return { parentSessionId: webId, agents: ids.map((id) => ({ id })) };
  if (!ids.includes(agentId)) throw Object.assign(new Error("Subagent not found in this session"), { status: 404 });
  const source = await api.getSubagentMessages(nativeId, agentId, { dir: session.cwd });
  const entries = source.flatMap(projectClaudeHistoryMessage);
  return {
    parentSessionId: webId, agentId, cwd: session.cwd, readonly: true,
    messages: entries.map((entry) => entry.message),
    entryIds: entries.map((entry) => entry.entryId),
  };
}
