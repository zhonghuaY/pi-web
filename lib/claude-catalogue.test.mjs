import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "./claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET: list } = await jiti.import("../app/api/sessions/route.ts");
const { POST: bulkDelete } = await jiti.import("../app/api/sessions/delete/route.ts");
const { claudeState, claudeBackend, claudeCreate } = await jiti.import("./claude-routes.ts");
const { GET: exportSession } = await jiti.import("../app/api/sessions/[id]/export/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

test("cold mixed catalogue, dormant native state and image export use native files without starting a runtime", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-mixed-catalogue-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  const nativeId = "123e4567-e89b-42d3-a456-426614174010";
  const key = "claude:" + nativeId;
  const project = join(nativeHome, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  try {
    const pi = SessionManager.create(dir);
    pi.appendMessage({ role: "user", content: "Pi fixture", timestamp: Date.now() });
    const user = { type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null, cwd: dir, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: [
      { type: "text", text: "Claude fixture" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ] } };
    await mkdir(project, { recursive: true });
    const assistant = { ...user, type: "assistant", uuid: "123e4567-e89b-42d3-a456-426614174012", parentUuid: user.uuid, message: { role: "assistant", model: "native-fixture-model", content: [{ type: "text", text: "Native reply" }] } };
    await writeFile(join(project, nativeId + ".jsonl"), [user, assistant].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const response = await list(new Request("http://localhost/api/sessions"));
    const catalogue = await response.json();
    assert.equal(response.status, 200, JSON.stringify(catalogue));
    assert.deepEqual(catalogue.sessions.map((row) => row.id).sort(), [pi.getSessionId(), key].sort());
    assert.equal(catalogue.sessions.find((row) => row.id === key).backend, "claude");
    const previousFlag = process.env.PI_WEB_CLAUDE;
    process.env.PI_WEB_CLAUDE = "0";
    try {
      const readOnly = await (await list(new Request("http://localhost/api/sessions"))).json();
      assert.equal(readOnly.sessions.length, 2, "disabled native runtime keeps both histories visible");
      const refused = await bulkDelete(new Request("http://localhost/api/sessions/delete", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ ids: [pi.getSessionId(), key] }) }));
      assert.equal(refused.status, 409);
      assert.equal((await (await list(new Request("http://localhost/api/sessions"))).json()).sessions.length, 2);
    } finally {
      if (previousFlag === undefined) delete process.env.PI_WEB_CLAUDE;
      else process.env.PI_WEB_CLAUDE = previousFlag;
    }
    const stateResponse = await claudeState(key);
    const state = await stateResponse.json();
    assert.equal(stateResponse.status, 200, JSON.stringify(state));
    assert.equal(state.running, false);
    assert.equal(state.state.requiresProjectTrust, true);
    const exported = await exportSession(new Request("http://localhost/api/sessions/" + key + "/export"), { params: Promise.resolve({ id: key }) });
    assert.equal(exported.status, 200);
    const html = await exported.text();
    assert.match(html, /Claude fixture/);
    assert.ok(html.includes('src="data:image/png;base64,aGVsbG8="'), html);
    assert.equal((await claudeBackend()).getClaudeSession(key), undefined);

    const rejected = await claudeCreate({ cwd: dir, type: "prompt", message: "Do not run", requestId: "123e4567-e89b-42d3-a456-426614174020" });
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json()).error, /trust/);
    const afterRejection = await (await list(new Request("http://localhost/api/sessions"))).json();
    assert.equal(afterRejection.sessions.length, 2, "rejected creation must leave no ghost row");

    const draftRequest = { cwd: dir, type: "ensure_session", requestId: "123e4567-e89b-42d3-a456-426614174021" };
    const created = await (await claudeCreate(draftRequest)).json();
    const retried = await (await claudeCreate(draftRequest)).json();
    assert.equal(created.success, true);
    assert.equal(created.state.lifecycle, "dormant");
    assert.equal(retried.sessionId, created.sessionId, "lost creation response retries must reuse the dormant session");
  } finally {
    await (await claudeBackend()).closeAllClaudeSessions();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  }
});
