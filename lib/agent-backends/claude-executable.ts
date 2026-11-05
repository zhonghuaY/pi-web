import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeClaudeEnvironment(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const blockedExact = new Set([
    "AUTH_SECRET", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "COOKIE_SECRET", "DATABASE_URL",
    "NEXTAUTH_SECRET", "NODE_OPTIONS", "NODE_PATH", "PI_WEB_PASSWORD", "REDIS_URL",
    "SESSION_SECRET", "VAPID_PRIVATE_KEY",
  ]);
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    const nativeProvider = /^(ANTHROPIC|CLAUDE_CODE|AWS|GOOGLE|VERTEX|BEDROCK)_/.test(key);
    const sensitive = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/.test(key);
    if (blockedExact.has(key) || key.startsWith("PI_") || key.startsWith("NEXTAUTH_") || (sensitive && !nativeProvider)) continue;
    result[key] = value;
  }
  result.CLAUDE_AGENT_SDK_CLIENT_APP = "pi-web-chat/0.15.0";
  return result;
}

export async function resolveClaudeExecutable(env: NodeJS.ProcessEnv): Promise<string> {
  const configured = env.PI_WEB_CLAUDE_EXECUTABLE;
  if (configured) {
    if (!isAbsolute(configured) || !(await executable(configured))) {
      throw new Error("PI_WEB_CLAUDE_EXECUTABLE must name an executable absolute path");
    }
    return configured;
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === "win32" ? "claude.exe" : "claude");
    if (await executable(candidate)) return candidate;
  }
  throw new Error("Claude Code executable was not found on PATH");
}
