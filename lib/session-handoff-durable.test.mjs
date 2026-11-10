import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "./claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const home = await realpath(await mkdtemp(join(tmpdir(), "pi-web-handoff-durable-")));
process.env.PI_CODING_AGENT_DIR = home;
process.env.PI_WEB_CLAUDE = "1";
process.env.PI_WEB_CODEX = "1";
test.after(async () => { await rm(home, { recursive: true, force: true }); });
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSessionHandoff, SessionHandoffError } = await jiti.import("./session-handoff-server.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { getRpcSession } = await jiti.import("./rpc-manager.ts");
const { ClaudeSessionWrapper } = await jiti.import("./agent-backends/claude-runtime.ts");

function codexId() {
  return `codex:019c1bed-f24e-7f5f-a7f2-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function fixture(backend = "pi", targetBackend = backend === "pi" ? "claude" : "pi") {
  const sourceId = backend === "pi" ? `source-${randomUUID()}` : backend === "claude" ? `claude:${randomUUID()}` : codexId();
  const request = { requestId: randomUUID(), targetBackend, trustProject: true };
  const info = { id: sourceId, path: "source", cwd: home, created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: "source", backend };
  const source = { backend, info, leafId: "tip-1", messages: [{ role: "user", content: "question", timestamp: 1 }] };
  let creates = 0;
  let sends = 0;
  let durable = false;
  const hooks = {
    findExistingTarget: async () => null,
    readSource: async () => source,
    createTarget: async (_source, built) => {
      creates += 1;
      const id = request.targetBackend === "claude" ? `claude:${randomUUID()}` : request.targetBackend === "codex" ? codexId() : randomUUID();
      return {
        info: { id, path: id, cwd: home, created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: built.title, backend: request.targetBackend, relation: built.relation },
        send: async () => { sends += 1; durable = true; },
      };
    },
    hasDurablePrompt: async () => durable,
  };
  return { sourceId, request, source, hooks, counts: () => ({ creates, sends }) };
}

test("all six directed handoffs converge concurrently and retain their transfer receipt", async () => {
  for (const [backend, targetBackend] of [
    ["pi", "claude"], ["claude", "pi"], ["pi", "codex"],
    ["claude", "codex"], ["codex", "pi"], ["codex", "claude"],
  ]) {
    const f = fixture(backend, targetBackend);
    const [first, second] = await Promise.all([
      createSessionHandoff(f.sourceId, f.request, f.hooks),
      createSessionHandoff(f.sourceId, f.request, f.hooks),
    ]);
    assert.deepEqual(second, first);
    assert.deepEqual(first.transfer, { sourceSessionId: f.sourceId, sourceEntryId: "tip-1", transferredMessages: 1, omittedMessages: 0, truncated: false });
    assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
  }
});

test("a native revision change conflicts with the saved intent even when transferable text and leaf are unchanged", async () => {
  const f = fixture("codex", "pi");
  f.source.revision = "a".repeat(64);
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, {
    ...f.hooks,
    seam: (point) => { if (point === "after-intent") throw new Error("stop after intent"); },
  }), /stop after intent/);
  const saved = JSON.parse(await readFile(join(home, "pi-web-handoffs", f.request.requestId, "record.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.sourceRevision, "a".repeat(64));
  f.source.revision = "b".repeat(64);
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, f.hooks), error => error.reason === "source-conflict" && error.operationId === f.request.requestId);
  assert.deepEqual(f.counts(), { creates: 0, sends: 0 });
});

test("a Pi v2 source stays byte-for-byte unchanged when its context is captured", async () => {
  const manager = SessionManager.create(home, home);
  manager.appendMessage({ role: "user", content: "real source", timestamp: 1 });
  const sourceId = manager.getSessionId();
  const path = manager.getSessionFile();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  lines[0].version = 2;
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const before = await readFile(path);
  cacheSessionPath(sourceId, path);
  const f = fixture();
  const result = await createSessionHandoff(sourceId, f.request, { createTarget: f.hooks.createTarget, hasDurablePrompt: f.hooks.hasDurablePrompt });
  assert.equal(result.transfer.transferredMessages, 1);
  assert.deepEqual(await readFile(path), before);
});

test("a Pi v1 source has a stable retry tip without rewriting its bytes", async () => {
  const manager = SessionManager.create(home, home);
  manager.appendMessage({ role: "user", content: "v1 source", timestamp: 1 });
  const sourceId = manager.getSessionId();
  const path = manager.getSessionFile();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  lines[0].version = 1;
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const before = await readFile(path);
  cacheSessionPath(sourceId, path);
  const f = fixture();
  const hooks = { createTarget: f.hooks.createTarget, hasDurablePrompt: f.hooks.hasDurablePrompt };
  const first = await createSessionHandoff(sourceId, f.request, hooks);
  const retry = await createSessionHandoff(sourceId, f.request, hooks);
  assert.match(first.transfer.sourceEntryId, /^legacy-[0-9a-f]{64}$/);
  assert.deepEqual(retry, first);
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
  assert.deepEqual(await readFile(path), before);
});

test("an external source write during capture is refused before target creation", async () => {
  const manager = SessionManager.create(home, home);
  manager.appendMessage({ role: "user", content: "first tip", timestamp: 1 });
  const sourceId = manager.getSessionId();
  const path = manager.getSessionFile();
  cacheSessionPath(sourceId, path);
  const f = fixture();
  await assert.rejects(createSessionHandoff(sourceId, f.request, {
    createTarget: f.hooks.createTarget,
    seam: async (point) => { if (point === "after-source-capture") await appendFile(path, "\n"); },
  }), (error) => error instanceof SessionHandoffError && error.reason === "source-changed");
  assert.deepEqual(f.counts(), { creates: 0, sends: 0 });
});

test("a Pi transcript hands off through the Claude runtime without changing the source", async (t) => {
  const manager = SessionManager.create(home, home);
  manager.appendMessage({ role: "user", content: "Pi source", timestamp: 1 });
  const sourceId = manager.getSessionId();
  const tip = manager.getLeafId();
  const path = manager.getSessionFile();
  const before = await readFile(path);
  cacheSessionPath(sourceId, path);
  const request = { requestId: randomUUID(), targetBackend: "claude", trustProject: true };
  const targetId = randomUUID();
  const relation = { kind: "handoff", requestId: request.requestId, sourceSessionId: sourceId, sourceBackend: "pi", sourceEntryId: tip };
  let admitted;
  let finish;
  const query = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise((resolve) => { finish = resolve; }),
    initializationResult: async () => ({}),
    close: () => { finish?.({ done: true }); },
  };
  const wrapper = new ClaudeSessionWrapper(targetId, home, { existing: false, requestId: request.requestId, trustProject: true, handoff: relation }, {
    query: (options) => {
      void (async () => {
        admitted = (await options.prompt[Symbol.asyncIterator]().next()).value;
        const project = join(nativeHome, "projects", home.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        await writeFile(join(project, `${targetId}.jsonl`), JSON.stringify({ ...admitted, sessionId: targetId, cwd: home, timestamp: new Date().toISOString(), isSidechain: false, parentUuid: null }) + "\n");
      })();
      return query;
    },
    acquireLock: async () => async () => {},
    getConfiguration: async () => ({ available: true, settingSources: [], requiresProjectTrust: true }),
    executablePath: "/fake/claude", env: { PATH: "/bin" }, now: () => 1000, idleTimeoutMs: 0, interruptTimeoutMs: 50,
  });
  const key = Symbol.for("pi-web.claude-backend.registry");
  const previous = globalThis[key];
  t.after(async () => { await wrapper.close(); globalThis[key] = previous; });
  const result = await createSessionHandoff(sourceId, request, {
    seam: (point) => {
      if (point === "before-target-creation") {
        globalThis[key] = { sessions: new Map([[wrapper.sessionId, wrapper]]), createRequests: new Map([[request.requestId, { sessionId: wrapper.sessionId, cwd: home }]]), cleanupInstalled: true };
      }
    },
  });
  assert.equal(result.session.id, wrapper.sessionId);
  assert.equal(result.transfer.transferredMessages, 1);
  assert.match(JSON.stringify(admitted), /Pi source/);
  assert.deepEqual(await readFile(path), before);
  const retry = await createSessionHandoff(sourceId, request);
  assert.deepEqual(retry.transfer, result.transfer);
  assert.equal(retry.session.id, result.session.id);
});

test("a native Claude transcript hands off into a Pi session without changing the source", async (t) => {
  const server = createServer((_request, response) => { response.writeHead(503); response.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "test", api: "openai-completions", models: [{ id: "local-model", name: "Local", reasoning: false, contextWindow: 10000, maxTokens: 100 }] } } }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "local-model" }));
  const nativeId = randomUUID();
  const sourceId = `claude:${nativeId}`;
  const project = join(nativeHome, "projects", home.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  const path = join(project, `${nativeId}.jsonl`);
  const user = { type: "user", sessionId: nativeId, uuid: randomUUID(), parentUuid: null, cwd: home, timestamp: new Date().toISOString(), isSidechain: false, message: { role: "user", content: [{ type: "text", text: "Claude source" }] } };
  const assistant = { ...user, type: "assistant", uuid: randomUUID(), parentUuid: user.uuid, message: { role: "assistant", model: "test-model", content: [{ type: "text", text: "Claude reply" }] } };
  await writeFile(path, [user, assistant].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const before = await readFile(path);
  const backend = await jiti.import("./agent-backends/claude.ts");
  const snapshot = await backend.readClaudeSession(sourceId, { tail: 100 });
  assert.ok(snapshot.context.messages.length > 0, JSON.stringify(snapshot));
  const request = { requestId: randomUUID(), targetBackend: "pi", trustProject: false };
  const result = await createSessionHandoff(sourceId, request);
  t.after(async () => { await getRpcSession(result.session.id)?.shutdown(); });
  assert.equal(result.session.backend, "pi");
  assert.equal(result.transfer.transferredMessages, 2);
  assert.deepEqual(await readFile(path), before);
  const retry = await createSessionHandoff(sourceId, request);
  assert.deepEqual(retry.transfer, result.transfer);
  assert.equal(retry.session.id, result.session.id);
});

test("a new process returns the original Claude or Codex target and receipt", async () => {
  for (const targetBackend of ["claude", "codex"]) {
    const f = fixture("pi", targetBackend);
    const first = await createSessionHandoff(f.sourceId, f.request, f.hooks);
    const script = `import { createJiti } from "jiti";
      const { createSessionHandoff } = await createJiti(process.cwd() + "/lib/session-handoff-durable.test.mjs", { tsconfigPaths: true }).import("./session-handoff-server.ts");
      const { sourceId, request, source } = JSON.parse(process.argv[1]);
      const result = await createSessionHandoff(sourceId, request, { readSource: async () => source, createTarget: async () => { throw new Error("duplicate target"); } });
      process.stdout.write(JSON.stringify(result));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ sourceId: f.sourceId, request: f.request, source: f.source })]);
    assert.deepEqual(JSON.parse(stdout), first);
  }
});

test("a prompt acknowledgement without transcript evidence remains unknown and is never resent", async () => {
  const f = fixture();
  let observed = false;
  const hooks = { ...f.hooks, hasDurablePrompt: async () => observed };
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, { ...hooks, seam: (point) => { if (point === "after-prompt") throw new Error("crash after acknowledgement"); } }));
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, hooks), (error) => error instanceof SessionHandoffError && error.reason === "outcome-unknown");
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, { ...hooks, readSource: async () => { throw new SessionHandoffError("Source session not found", 404); } }),
    (error) => error instanceof SessionHandoffError && error.status === 503 && error.reason === "outcome-unknown");
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
  observed = true;
  const result = await createSessionHandoff(f.sourceId, f.request, hooks);
  assert.equal(result.transfer.transferredMessages, 1);
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
});

for (const mode of ["plain", "extra-input", "annotated", "split-text"]) {
  test(`Pi admission proof validates the complete saved envelope: ${mode}`, async () => {
    const f = fixture("codex", "pi");
    let creates = 0, sends = 0;
    const hooks = {
      readSource: async () => f.source,
      findExistingTarget: async () => null,
      createTarget: async (_source, built) => {
        creates++;
        const manager = SessionManager.create(home, home);
        const text = { type: "text", text: built.prompt };
        const split = built.prompt.indexOf("\n");
        const content = mode === "extra-input" ? [text, { type: "image", data: "AA==", mimeType: "image/png" }]
          : mode === "annotated" ? [{ ...text, annotations: ["unselected"] }]
            : mode === "split-text" ? [{ type: "text", text: built.prompt.slice(0, split) }, { type: "text", text: built.prompt.slice(split + 1) }]
              : [text];
        return {
          info: { ...f.source.info, id: manager.getSessionId(), path: manager.getSessionFile(), backend: "pi", relation: built.relation },
          send: async () => { sends++; manager.appendMessage({ role: "user", content, timestamp: 1 }); },
        };
      },
    };
    await assert.rejects(createSessionHandoff(f.sourceId, f.request, {
      ...hooks, seam: point => { if (point === "after-prompt") throw new Error("lost response"); },
    }), error => error.reason === "outcome-unknown");
    const recovered = await createSessionHandoff(f.sourceId, f.request, {
      ...hooks, readSource: async () => { throw new Error("Recovery must not reread the source"); },
    }).catch(error => error);
    if (mode === "plain") assert.equal(recovered.session.backend, "pi");
    else {
      assert.equal(recovered.reason, "outcome-unknown");
      assert.equal(recovered.operationId, f.request.requestId);
    }
    assert.deepEqual({ creates, sends }, { creates: 1, sends: 1 });
  });
}

test("receipt persistence follows transcript evidence", async () => {
  const f = fixture();
  let evidenceRead = false;
  const hooks = { ...f.hooks, hasDurablePrompt: async () => { evidenceRead = true; return true; } };
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, { ...hooks, seam: (point) => {
    if (point === "after-receipt") {
      assert.equal(evidenceRead, true);
      throw new Error("crash after receipt");
    }
  } }));
  const retry = await createSessionHandoff(f.sourceId, f.request, hooks);
  assert.equal(retry.transfer.transferredMessages, 1);
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
});

test("side and subagent sources, missing folders, and untrusted targets are refused", async () => {
  for (const kind of ["side", "subagent"]) {
    const f = fixture();
    f.source.info.relation = kind === "side" ? { kind, parentSessionId: "parent" } : { kind, parentSessionId: "parent", profile: "test", description: "test", status: "done" };
    await assert.rejects(createSessionHandoff(f.sourceId, f.request, f.hooks), (error) => error instanceof SessionHandoffError && error.status === 409);
    assert.deepEqual(f.counts(), { creates: 0, sends: 0 });
  }
  const missing = fixture();
  missing.source.info.cwd = join(home, "missing-folder");
  await assert.rejects(createSessionHandoff(missing.sourceId, missing.request, missing.hooks), (error) => error instanceof SessionHandoffError && error.reason === "cwd-missing");
  assert.deepEqual(missing.counts(), { creates: 0, sends: 0 });
  const untrusted = fixture();
  untrusted.request.trustProject = false;
  await assert.rejects(createSessionHandoff(untrusted.sourceId, untrusted.request, untrusted.hooks), (error) => error instanceof SessionHandoffError && error.status === 409);
  assert.deepEqual(untrusted.counts(), { creates: 0, sends: 0 });
});

test("a completed receipt survives a changed or unreadable source without new mutation", async () => {
  const f = fixture();
  const first = await createSessionHandoff(f.sourceId, f.request, f.hooks);
  await assert.rejects(createSessionHandoff("another-source", f.request, f.hooks), (error) => error instanceof SessionHandoffError && error.status === 409);
  f.source.leafId = "tip-2";
  f.source.messages.push({ role: "user", content: "Later source conversation", timestamp: 2 });
  const result = await createSessionHandoff(f.sourceId, f.request, {
    ...f.hooks, readSource: async () => { throw new Error("A completed receipt must not recapture its source"); },
  });
  assert.deepEqual(result, first);
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
});

test("an uncertain target stays identifiable after a source tip change", async () => {
  const f = fixture();
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, {
    ...f.hooks, seam: point => { if (point === "after-target-id") throw new Error("lost before prompt"); },
  }), error => error.reason === "outcome-unknown");
  f.source.leafId = "tip-2";
  await assert.rejects(createSessionHandoff(f.sourceId, f.request, f.hooks), error => error.reason === "outcome-unknown" && error.operationId === f.request.requestId);
  assert.deepEqual(f.counts(), { creates: 1, sends: 0 });
});

for (const seam of ["before-intent", "after-intent", "before-target-creation", "after-target-creation", "before-target-id", "after-target-id", "before-prompt", "after-prompt", "before-receipt", "after-receipt"]) {
  test(`a crash at ${seam} never duplicates a Pi or Codex target or prompt`, async () => {
    for (const targetBackend of ["claude", "codex"]) {
      const f = fixture("pi", targetBackend);
      await assert.rejects(createSessionHandoff(f.sourceId, f.request, { ...f.hooks, seam: (current) => { if (current === seam) throw new Error("injected crash"); } }));
      const result = await createSessionHandoff(f.sourceId, f.request, f.hooks).catch((error) => error);
      if (["after-target-creation", "before-target-id", "after-target-id", "before-prompt"].includes(seam)) {
        assert.ok(result instanceof SessionHandoffError);
        assert.equal(result.reason, "outcome-unknown");
        assert.equal(result.operationId, f.request.requestId);
      } else {
        assert.equal(result.transfer.transferredMessages, 1);
      }
      const { creates, sends } = f.counts();
      assert.equal(creates, 1);
      assert.ok(sends <= 1);
    }
  });
}
