import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeConfigurationSummary } from "./types";

const SCOPES = ["user", "project", "local"] as const;
export type ResolveClaudeSettings = typeof resolveSettings;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Pinned SDK exception: resolveSettings is alpha in 0.3.318, but it is the only native, process-free settings cascade.
export async function readClaudeConfiguration(
  cwd: string,
  resolver: ResolveClaudeSettings = resolveSettings,
): Promise<ClaudeConfigurationSummary> {
  const defaults = {
    user: join(homedir(), ".claude", "settings.json"),
    project: join(cwd, ".claude", "settings.json"),
    local: join(cwd, ".claude", "settings.local.json"),
  };
  try {
    const resolved = await resolver({ cwd, settingSources: [...SCOPES] });
    const paths = { ...defaults };
    for (const source of resolved.sources) {
      if ((source.source === "user" || source.source === "project" || source.source === "local") && source.path) {
        paths[source.source] = source.path;
      }
    }
    const settingSources = await Promise.all(SCOPES.map(async (scope) => ({
      scope,
      path: paths[scope],
      exists: await exists(paths[scope]),
    })));
    const model = typeof resolved.effective.model === "string" && resolved.effective.model.trim()
      ? resolved.effective.model
      : null;
    const effective = resolved.effective as typeof resolved.effective & {
      hooks?: Record<string, unknown[]>;
      enabledPlugins?: Record<string, boolean>;
    };
    const hookCount = Object.values(effective.hooks ?? {}).reduce((total, rows) => total + rows.length, 0);
    const pluginCount = Object.values(effective.enabledPlugins ?? {}).filter(Boolean).length;
    return {
      available: true,
      model,
      settingSources,
      requiresProjectTrust: true,
      resources: {
        skills: { status: "native-discovery-on-start" },
        agents: { status: "native-discovery-on-start" },
        mcp: { status: "native-discovery-on-start" },
        hooks: { status: "settings-loaded", count: hookCount },
        plugins: { status: "settings-loaded", count: pluginCount },
      },
    };
  } catch {
    const settingSources = await Promise.all(SCOPES.map(async (scope) => ({
      scope,
      path: defaults[scope],
      exists: await exists(defaults[scope]),
    })));
    return {
      available: false,
      reason: "Claude settings could not be loaded",
      model: null,
      settingSources,
      requiresProjectTrust: true,
    };
  }
}
