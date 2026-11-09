"use client";

import { useEffect, useState } from "react";
import type { CodexSkillsInventory, CodexMcpInventory } from "@/lib/agent-session-inventory";
import { ConfigButton, ConfigNotice, ConfigScopeTag } from "./SettingsUi";

type Inventory = CodexSkillsInventory | CodexMcpInventory;
export function CodexInventory({ kind, cwd, sessionId }: { kind: "skills" | "mcp"; cwd?: string; sessionId: string | null }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; value: Inventory }>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    if ((kind === "skills" && !cwd) || (kind === "mcp" && !sessionId)) {
      setState({ kind: "error", message: kind === "mcp" ? "Open a Codex session to inspect its native MCP connections." : "Select a project directory to inspect native skills." });
      return () => controller.abort();
    }
    const query = new URLSearchParams({ backend: "codex", kind });
    if (kind === "skills" && cwd) query.set("cwd", cwd);
    if (sessionId) query.set("sessionId", sessionId);
    void fetch(`/api/agent/inventory?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Native inventory is unavailable");
        if (!controller.signal.aborted) setState({ kind: "loaded", value });
      }).catch(error => { if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "Native inventory is unavailable" }); });
    return () => controller.abort();
  }, [cwd, kind, revision, sessionId]);

  return <div className="settings-section-content" style={{ maxWidth: 760 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 17 }}>Codex {kind === "skills" ? "skills" : "MCP"}</h2>
      <ConfigButton disabled={state.kind === "loading"} onClick={() => setRevision(value => value + 1)}>Refresh</ConfigButton>
    </div>
    <ConfigNotice>{kind === "skills" ? "Native skill metadata for this project. Read only." : "Native connection status for this open session. Read only. Configuration and sign-in are managed by Codex."}</ConfigNotice>
    {state.kind === "loading" && <p role="status">Loading native inventory…</p>}
    {state.kind === "error" && <p role="alert">{state.message}</p>}
    {state.kind === "loaded" && "skills" in state.value && <>
      <p><code style={{ overflowWrap: "anywhere" }}>{state.value.cwd}</code></p>
      {!state.value.skills.length && <p>No native skills reported.</p>}
      {state.value.skills.map(skill => <details key={`${skill.scope}:${skill.path}`} className="config-row" style={{ display: "block", marginBottom: 10 }}>
        <summary>{skill.displayName ?? skill.name} <ConfigScopeTag scope={skill.scope}>{skill.scope}</ConfigScopeTag> · {skill.enabled ? "Enabled" : "Disabled"}</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{skill.description}</p>
        {skill.shortDescription && <p>{skill.shortDescription}</p>}
        <code style={{ overflowWrap: "anywhere" }}>{skill.path}</code>
        {skill.pluginId && <p>Plugin: {skill.pluginId}</p>}
      </details>)}
      {!!state.value.diagnostics.length && <div role="status"><h3>Discovery diagnostics</h3>{state.value.diagnostics.map((diagnostic, index) => <p key={index} style={{ overflowWrap: "anywhere" }}>{diagnostic.path}: {diagnostic.message}</p>)}</div>}
    </>}
    {state.kind === "loaded" && "servers" in state.value && <>
      {!state.value.servers.length && <p>No native MCP servers reported.</p>}
      {state.value.servers.map(server => <details key={server.name} className="config-row" style={{ display: "block", marginBottom: 10 }}>
        <summary>{server.name} · {server.status}</summary>
        <p>Native status: {server.runtimeStatus ?? "unknown"} · Authentication: {server.authStatus}</p>
        {server.pluginId && <p>Plugin: {server.pluginId}</p>}
        <h3>Tools ({server.tools.length})</h3>
        {server.tools.map(tool => <p key={tool.name}><strong>{tool.title ?? tool.name}</strong>{tool.description ? ` · ${tool.description}` : ""}</p>)}
        <h3>Resources ({server.resources.length})</h3>
        {server.resources.map((resource, index) => <p key={index}>{resource.name}{resource.description ? ` · ${resource.description}` : ""}{resource.mimeType ? ` (${resource.mimeType})` : ""}</p>)}
        <h3>Resource templates ({server.resourceTemplates.length})</h3>
        {server.resourceTemplates.map((resource, index) => <p key={index}>{resource.name}{resource.description ? ` · ${resource.description}` : ""}</p>)}
      </details>)}
    </>}
  </div>;
}
