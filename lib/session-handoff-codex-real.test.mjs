import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "./claude-test-home.mjs";

await isolateClaudeHome();

test("owned Codex CLI persists the exact coordinator envelope through a loopback turn", async t => {
  const binary = process.env.TEST_OWNED_CODEX_BINARY;
  if (!binary) { t.skip("owned copied Codex CLI not configured"); return; }
  const info = await lstat(binary).catch(() => null);
  if (!info?.isFile()) { t.skip("owned copied Codex CLI unavailable"); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-handoff-codex-real-")));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  await mkdir(home); await mkdir(agentDir); await mkdir(work);
  const previous = Object.fromEntries(["HOME", "PATH", "PI_CODING_AGENT_DIR", "CODEX_HOME", "PI_WEB_CODEX"].map(key => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CODEX_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEB_CODEX = "1";
  process.env.PATH = `${dirname(binary)}:${previous.PATH ?? "/usr/bin:/bin"}`;
  for (const key of ["JITI_ALIAS", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", "PI_WEB_CODEX_BINARY"]) delete process.env[key];
  const requests = [];
  const provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      const nativeResponse = { id: "resp_handoff", object: "response", created_at: 1, status: "in_progress", model: "mock", output: [] };
      const item = { id: "msg_handoff", type: "message", role: "assistant", status: "in_progress", content: [] };
      emit("response.created", { response: nativeResponse });
      emit("response.output_item.added", { output_index: 0, item });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "Imported." });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "Imported." });
      emit("response.output_item.done", { output_index: 0, item: { ...item, status: "completed", content: [{ type: "output_text", text: "Imported.", annotations: [] }] } });
      emit("response.completed", { response: { ...nativeResponse, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    });
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const port = provider.address().port;
    await writeFile(join(home, "config.toml"), `model = "gpt-6-astra"\nmodel_provider = "localmock"\n[model_providers.localmock]\nname = "Local Mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
    const { createSessionHandoff } = await jiti.import("./session-handoff-server.ts");
    const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
    const { cacheSessionPath } = await jiti.import("./session-reader.ts");
    const { getCodexSession, shutdownCodexSession } = await jiti.import("./agent-backends/codex.ts");
    const { readCodexThread } = await jiti.import("./agent-backends/codex/catalogue.ts");
    const { nativeCodexSessionId } = await jiti.import("./agent-backends/codex/identity.ts");
    const { codexThreadHasUserEnvelope } = await jiti.import("./agent-backends/codex/user-envelope.ts");
    const manager = SessionManager.create(work, work);
    manager.appendMessage({ role: "user", content: "Copied CLI source", timestamp: 1 });
    const sourcePath = manager.getSessionFile();
    const before = await readFile(sourcePath);
    cacheSessionPath(manager.getSessionId(), sourcePath);
    const result = await createSessionHandoff(manager.getSessionId(), { requestId: randomUUID(), targetBackend: "codex", trustProject: false });
    const requestDeadline = Date.now() + 10_000;
    while (requests.length === 0 && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    const actor = getCodexSession(result.session.id);
    if (actor) await shutdownCodexSession(actor);
    const thread = await readCodexThread(nativeCodexSessionId(result.session.id));
    const nativePrompt = thread.turns.flatMap(turn => turn.items).find(item => item.type === "userMessage").content[0].text;
    assert.equal(codexThreadHasUserEnvelope(thread, nativePrompt), true);
    assert.match(nativePrompt, /Copied CLI source/);
    assert.equal(requests.length, 1);
    assert.deepEqual(await readFile(sourcePath), before);
    const retry = await createSessionHandoff(manager.getSessionId(), { requestId: result.session.relation.requestId, targetBackend: "codex", trustProject: false });
    assert.equal(retry.session.id, result.session.id);
    assert.equal(requests.length, 1);
  } finally {
    await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
