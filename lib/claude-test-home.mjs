import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export async function isolatePiHome() {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-test-pi-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

export async function isolateClaudeHome() {
  // This helper is the test boundary for native-backend homes.
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexEnabled = process.env.PI_WEB_CODEX;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-test-claude-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.PI_WEB_CODEX = "0";
  after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCodexEnabled === undefined) delete process.env.PI_WEB_CODEX;
    else process.env.PI_WEB_CODEX = previousCodexEnabled;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
