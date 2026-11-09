import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome } from "../claude-test-home.mjs";

const nativeHome = await isolateClaudeHome();
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-service-export-")));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
const previousTemp = Object.fromEntries(["TMPDIR", "TEMP", "TMP"].map((name) => [name, process.env[name]]));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
for (const name of Object.keys(previousTemp)) process.env[name] = root;
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  for (const [name, value] of Object.entries(previousTemp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { GET } = await jiti.import("../../app/api/sessions/[id]/export/route.ts");
const get = (id, query = "") => GET(new Request(`http://localhost/export${query}`), { params: Promise.resolve({ id }) });
const outputFiles = async () => readdir(join(root, "pi-web-export"));

function noRuntimes(t) {
  const priorPi = globalThis.__piSessions;
  const key = Symbol.for("pi-web.claude-backend.registry");
  const priorClaude = globalThis[key];
  const pi = new Map();
  const claude = new Map();
  globalThis.__piSessions = pi;
  globalThis[key] = { sessions: claude, createRequests: new Map(), cleanupInstalled: true };
  t.after(() => { globalThis.__piSessions = priorPi; globalThis[key] = priorClaude; });
  return () => { assert.equal(pi.size, 0); assert.equal(claude.size, 0); };
}

test("Pi export returns HTML and filename, cleans its output, and starts no runtime", async (t) => {
  const checkRuntimes = noRuntimes(t);
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: "Pi export fixture", timestamp: Date.now() });
  const id = manager.getSessionId();
  const path = manager.getSessionFile();
  cacheSessionPath(id, path);
  t.after(() => invalidateSessionPathCache(id));
  const result = await sessions.exportSession({ id });
  assert.equal(result.ok, true);
  assert.equal(result.value.backend, "pi");
  assert.equal(result.value.fileName, `pi-session-${basename(path, ".jsonl")}.html`);
  const encoded = result.value.html.match(/<script[^>]*id="session-data"[^>]*>([^<]+)<\/script>/);
  assert.ok(encoded, "export contains session data");
  assert.match(Buffer.from(encoded[1], "base64").toString(), /Pi export fixture/);
  assert.deepEqual(await outputFiles(), []);
  const response = await get(id, "?inline=1");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^inline;/);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.deepEqual(await outputFiles(), []);
  checkRuntimes();
});

test("Pi export failure cleans its output and reports a backend error", async (t) => {
  const checkRuntimes = noRuntimes(t);
  const path = join(root, "invalid.jsonl");
  await writeFile(path, "invalid json\n");
  const exporter = join(root, "failing-exporter.cjs");
  const marker = join(root, "partial-written");
  await writeFile(exporter, `const fs = require("node:fs");\nfs.writeFileSync(process.argv[4], "partial");\nfs.writeFileSync(${JSON.stringify(marker)}, "written");\nprocess.exit(1);\n`);
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(exporter)}`;
  t.after(() => {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  });
  cacheSessionPath("bad-export", path);
  t.after(() => invalidateSessionPathCache("bad-export"));
  const result = await sessions.exportSession({ id: "bad-export" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "error");
  assert.equal(result.backend, "pi");
  assert.equal(await readFile(marker, "utf8"), "written");
  assert.deepEqual(await outputFiles(), []);
  checkRuntimes();
});

test("Claude export uses display messages without starting a runtime", async (t) => {
  const checkRuntimes = noRuntimes(t);
  const nativeId = "123e4567-e89b-42d3-a456-426614174010";
  const id = `claude:${nativeId}`;
  const project = join(nativeHome, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${nativeId}.jsonl`), JSON.stringify({
    type: "user", sessionId: nativeId, uuid: "123e4567-e89b-42d3-a456-426614174011", parentUuid: null,
    cwd: root, timestamp: new Date().toISOString(), isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "Claude export fixture" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
  }) + "\n");
  const result = await sessions.exportSession({ id });
  assert.equal(result.ok, true);
  assert.equal(result.value.backend, "claude");
  assert.equal(result.value.fileName, `claude-session-${nativeId}.html`);
  assert.match(result.value.html, /Claude export fixture/);
  assert.match(result.value.html, /src="data:image\/png;base64,aGVsbG8="/);
  const response = await get(id);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  checkRuntimes();
});

test("missing sessions and unsupported identities retain typed outcomes and HTTP mappings", async (t) => {
  const checkRuntimes = noRuntimes(t);
  assert.deepEqual(await sessions.exportSession({ id: "missing-export" }), { ok: false, kind: "not-found" });
  assert.equal((await get("missing-export")).status, 404);
  assert.deepEqual(await sessions.exportSession({ id: "future:123" }), { ok: false, kind: "invalid", reason: "unknown-namespace" });
  assert.deepEqual(await sessions.exportSession({ id: "bad/id" }), { ok: false, kind: "invalid", reason: "invalid-id" });
  assert.deepEqual(await sessions.exportSession({ id: "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a" }), { ok: false, kind: "unsupported" });
  const missingClaude = "claude:123e4567-e89b-42d3-a456-426614174019";
  const result = await sessions.exportSession({ id: missingClaude });
  assert.equal(result.kind, "error");
  assert.equal(result.backend, "claude");
  const response = await get(missingClaude);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: String(result.error) });
  checkRuntimes();
});
