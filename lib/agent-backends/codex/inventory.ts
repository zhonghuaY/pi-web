import { realpath } from "node:fs/promises";
import type { CodexSkillsInventory, CodexMcpInventory } from "@/lib/agent-session-inventory";
import { codexPayloadValidators, type CodexPayloadMethod, type CodexPayloads } from "./internal/payloads";
import { SUPPORTED_CODEX_CLI_VERSION } from "./internal/protocol";
import { CodexTransportError, type CodexTransport } from "./internal/transport";

const inspection = codexPayloadValidators({ state: "supported", version: SUPPORTED_CODEX_CLI_VERSION });
if (inspection.state !== "supported") throw new Error("Codex schema unavailable");
const validators = inspection.validators;
function validate<K extends CodexPayloadMethod>(method: K, value: unknown): CodexPayloads[K] {
  const result = validators.validate(method, value);
  if (result.state !== "valid") throw new CodexTransportError("protocol");
  return result.value;
}

export async function readCodexSkills(transport: CodexTransport, cwd: string): Promise<CodexSkillsInventory> {
  const params = { cwds: [cwd], forceReload: true };
  validate("skills/list:request", params);
  const result = validate("skills/list:response", await transport.request("skills/list", params));
  const canonical = await realpath(cwd);
  const groups = [];
  for (const group of result.data) {
    // Native macOS discovery can return /private/tmp for a requested /tmp cwd.
    if (await realpath(group.cwd).catch(() => null) === canonical) groups.push(group);
  }
  if (groups.length !== 1 || groups[0].skills.length > 10000 || groups[0].errors.length > 1000) throw new CodexTransportError("protocol");
  const group = groups[0];
  return { backend: "codex", cwd: group.cwd,
    skills: group.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.path,
      enabled: skill.enabled, scope: skill.scope, shortDescription: skill.shortDescription ?? skill.interface?.shortDescription ?? null,
      pluginId: skill.pluginId ?? null, displayName: skill.interface?.displayName ?? null })),
    diagnostics: group.errors.map(error => ({ path: error.path, message: error.message })),
  };
}

export async function readCodexMcp(transport: CodexTransport, threadId: string, sessionId: string): Promise<CodexMcpInventory> {
  const servers: CodexMcpInventory["servers"] = [];
  const cursors = new Set<string>();
  const names = new Set<string>();
  const signal = AbortSignal.timeout(30000);
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const params = { threadId, detail: "full", limit: 100, ...(cursor === undefined ? {} : { cursor }) };
    validate("mcpServerStatus/list:request", params);
    const result = validate("mcpServerStatus/list:response", await transport.request("mcpServerStatus/list", params, { signal, timeoutMs: 10000 }));
    for (const server of result.data) {
      if (!server.name || names.has(server.name)) throw new CodexTransportError("protocol");
      names.add(server.name);
      const runtimeStatus = server.runtimeStatus ?? null;
      const status = runtimeStatus === "connected" ? "connected" : runtimeStatus === "starting" ? "starting" : runtimeStatus === "authenticationRequired" ? "auth-required" : runtimeStatus === "failed" ? "failed" : runtimeStatus === "notStarted" || runtimeStatus === "disabled" || runtimeStatus === "cancelled" ? "absent" : "unknown";
      const tools = Object.values(server.tools);
      if (tools.length + server.resources.length + server.resourceTemplates.length > 10000) throw new CodexTransportError("protocol");
      const resource = (row: CodexPayloads["mcpServerStatus/list:response"]["data"][number]["resources"][number]) => ({ name: row.name, description: row.description ?? null, mimeType: row.mimeType ?? null });
      servers.push({ name: server.name, status, runtimeStatus, authStatus: server.authStatus, pluginId: server.pluginId ?? null,
        tools: tools.map(tool => ({ name: tool.name, title: tool.title ?? null, description: tool.description ?? null })),
        resources: server.resources.map(resource), resourceTemplates: server.resourceTemplates.map(row => ({ name: row.name, description: row.description ?? null, mimeType: row.mimeType ?? null })),
      });
    }
    if (servers.length > 10000) throw new CodexTransportError("protocol");
    if (result.nextCursor == null) return { backend: "codex", sessionId, servers };
    cursor = result.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new CodexTransportError("protocol");
    cursors.add(cursor);
  }
  throw new CodexTransportError("protocol");
}
