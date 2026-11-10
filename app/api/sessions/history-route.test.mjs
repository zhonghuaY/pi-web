import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../../../lib/claude-test-home.mjs";

const claudeHome = await isolateClaudeHome();
const agentHome = await mkdtemp(join(tmpdir(), "pi-web-history-agent-"));
const oldAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentHome;
test.after(async () => {
  if (oldAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentHome;
  await rm(agentHome, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET: read } = await jiti.import("./[id]/route.ts");
const { GET: context } = await jiti.import("./[id]/context/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
const { getRpcSession } = await jiti.import("../../../lib/rpc-manager.ts");
const claude = await jiti.import("../../../lib/agent-backends/claude.ts");

const call = (handler, id, query = "") => handler(new Request(`http://localhost/api/sessions/test${query}`), { params: Promise.resolve({ id }) });

test("Pi history and pages read a persisted session without starting a wrapper", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-history-pi-"));
  const sm = SessionManager.create(cwd, cwd);
  sm.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
  sm.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
  const id = sm.getSessionId();
  cacheSessionPath(id, sm.getSessionFile());
  t.after(async () => { invalidateSessionPathCache(id); await rm(cwd, { recursive: true, force: true }); });
  assert.equal(getRpcSession(id), undefined);
  const response = await call(read, id, "?tail=1&tree=summary");
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.sessionId, id);
  assert.equal(snapshot.treeFormat, "summary");
  assert.equal(snapshot.context.messages.length, 1);
  assert.equal(snapshot.context.messages[0].content, "second");
  const page = await call(context, id, `?tail=1&before=${snapshot.context.oldestEntryId}`);
  assert.equal(page.status, 200);
  const result = await page.json();
  assert.equal(result.tail, 1);
  assert.equal(result.before, snapshot.context.oldestEntryId);
  assert.equal(result.context.messages[0].content, "first");
  assert.equal(getRpcSession(id), undefined);
});

test("unknown keys and disabled Codex history fail without starting runtimes", async () => {
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  const before = claude.getClaudeRuntimeSnapshot();
  const previous = process.env.PI_WEB_CODEX;
  process.env.PI_WEB_CODEX = "0";
  try {
    for (const handler of [read, context]) {
      const invalid = await call(handler, "future:123");
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).reason, "unknown-namespace");
      const unavailable = await call(handler, codex);
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).reason, "backend-unavailable");
    }
    assert.equal(getRpcSession(codex), undefined);
    assert.deepEqual(claude.getClaudeRuntimeSnapshot(), before);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_CODEX;
    else process.env.PI_WEB_CODEX = previous;
  }
});

test("Claude reads project history without creating a runtime", async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-web-history-claude-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const nativeId = "123e4567-e89b-42d3-a456-426614174000";
  const id = `claude:${nativeId}`;
  const project = join(claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  const rows = Array.from({ length: 510 }, (_, index) => ({
    type: "user", uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    parentUuid: index ? `00000000-0000-4000-8000-${String(index - 1).padStart(12, "0")}` : null,
    sessionId: nativeId, cwd, timestamp: new Date(1700000000000 + index).toISOString(),
    message: { role: "user", content: `message ${index}` },
  }));
  await writeFile(join(project, `${nativeId}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(claude.getClaudeSession(id), undefined);
  const response = await call(read, id, "?tail=1000");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const snapshot = await response.json();
  assert.equal(snapshot.sessionId, id);
  assert.equal(snapshot.context.messages.length, 500);
  assert.equal(snapshot.context.hasMore, true);
  const page = await call(context, id, `?tail=2&before=${snapshot.context.oldestEntryId}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const result = await page.json();
  assert.equal(result.tail, 2);
  assert.equal(result.before, snapshot.context.oldestEntryId);
  assert.equal(result.context.messages.length, 2);
  assert.equal(claude.getClaudeSession(id), undefined);
});
