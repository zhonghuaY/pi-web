import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export async function isolateClaudeHome() {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-test-claude-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
