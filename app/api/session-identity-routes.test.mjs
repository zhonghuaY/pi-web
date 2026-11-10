import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateClaudeHome, isolatePiHome } from "../../lib/claude-test-home.mjs";

await isolateClaudeHome();
process.env.HOME = await isolatePiHome();
for (const key of ["JITI_ALIAS", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"]) delete process.env[key];

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const routes = [
  ["agent/[id]/route.ts", "GET"], ["agent/[id]/route.ts", "POST"],
  ["agent/[id]/events/route.ts", "GET"], ["agent/[id]/lease/route.ts", "POST"],
  ["sessions/[id]/route.ts", "GET"], ["sessions/[id]/route.ts", "PATCH"], ["sessions/[id]/route.ts", "DELETE"],
  ["sessions/[id]/context/route.ts", "GET"], ["sessions/[id]/state/route.ts", "GET"],
  ["sessions/[id]/export/route.ts", "GET"], ["sessions/[id]/fork/route.ts", "POST"],
  ["sessions/[id]/auto-name/route.ts", "POST"],
];

test("session routes preserve namespace contracts without unintended dispatch", async (t) => {
  const oldCodex = process.env.PI_WEB_CODEX;
  const oldPath = process.env.PATH;
  const oldLog = process.env.TEST_IDENTITY_LOG;
  const dir = await mkdtemp(join(tmpdir(), "pi-web-identity-codex-"));
  const log = join(dir, "requests");
  await writeFile(join(dir, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.4"); process.exit(0); }
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.TEST_IDENTITY_LOG, request.method + "\\n");
  if (!("id" in request)) return;
  if (request.method === "initialize") return console.log(JSON.stringify({ id: request.id, result: { userAgent: "test", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "test" } }));
  if (request.method === "thread/read") return console.log(JSON.stringify({ id: request.id, error: { code: -32600, message: "unavailable" } }));
  console.log(JSON.stringify({ id: request.id, error: { code: -32601, message: "unsupported" } }));
});
`);
  await chmod(join(dir, "codex"), 0o700);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  process.env.TEST_IDENTITY_LOG = log;
  process.env.PI_WEB_CODEX = "0";
  t.after(async () => {
    if (oldCodex === undefined) delete process.env.PI_WEB_CODEX; else process.env.PI_WEB_CODEX = oldCodex;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.TEST_IDENTITY_LOG; else process.env.TEST_IDENTITY_LOG = oldLog;
    await rm(dir, { recursive: true, force: true });
  });
  for (const [path, method] of routes) {
    const handler = (await jiti.import(`./${path}`))[method];
    for (const id of ["future:123", "claude:not-a-uuid", "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a"]) {
      const req = new Request("http://localhost/api/test", {
        method,
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      const response = await handler(req, { params: Promise.resolve({ id }) });
      if (id.startsWith("codex:") && ((path === "agent/[id]/route.ts" && method === "POST") || path === "agent/[id]/events/route.ts")) {
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "Codex is disabled" });
        assert.equal(existsSync(log), false);
        continue;
      }
      if (id.startsWith("codex:") && path === "agent/[id]/lease/route.ts") {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, running: false, awaitingInput: false, subagentsActive: false });
        assert.equal(existsSync(log), false, "lease does not start or resume Codex");
        continue;
      }
      if (id.startsWith("codex:") && path === "sessions/[id]/fork/route.ts") {
        assert.equal(response.status, 503);
        assert.equal(typeof (await response.json()).error, "string");
        assert.equal(existsSync(log), false, "disabled fork does not start or resume Codex");
        continue;
      }
      const browsing = method === "GET" && (path === "sessions/[id]/route.ts" || path === "sessions/[id]/context/route.ts");
      assert.equal(response.status, browsing && id.startsWith("codex:") ? 503 : 400, `${path} ${method} ${id}`);
      assert.equal(typeof (await response.json()).reason, "string", `${path} ${method} ${id}`);
    }
  }
});

test("handoff rejects malformed source identities before reading the body", async () => {
  const handler = (await jiti.import("./sessions/[id]/handoff/route.ts")).POST;
  for (const id of ["future:123", "claude:not-a-uuid"]) {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
      body: "not-json",
    });
    const response = await handler(req, { params: Promise.resolve({ id }) });
    assert.equal(response.status, 400, id);
    assert.equal(typeof (await response.json()).reason, "string", id);
  }
});

test("handoff returns typed unavailable for every declared Codex edge", async () => {
  const handler = (await jiti.import("./sessions/[id]/handoff/route.ts")).POST;
  const codex = "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a";
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  for (const [id, targetBackend] of [
    ["pi-source", "codex"],
    ["claude:123e4567-e89b-42d3-a456-426614174001", "codex"],
    [codex, "pi"],
    [codex, "claude"],
  ]) {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
      body: JSON.stringify({ targetBackend, requestId, trustProject: false }),
    });
    const response = await handler(req, { params: Promise.resolve({ id }) });
    assert.equal(response.status, 409, `${id} -> ${targetBackend}`);
    assert.deepEqual(await response.json(), { error: "Codex sessions are not available", reason: "backend-unavailable" });
  }
});
