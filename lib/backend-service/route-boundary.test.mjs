import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { isolateClaudeHome } from "../claude-test-home.mjs";

await isolateClaudeHome();

const routes = [
  "app/api/agent/new/route.ts",
  "app/api/agent/[id]/route.ts",
  "app/api/agent/[id]/events/route.ts",
  "app/api/agent/[id]/bash-output/route.ts",
  "app/api/agent/backends/route.ts",
  "app/api/agent/inventory/route.ts",
  "app/api/sessions/route.ts",
  "app/api/sessions/search/route.ts",
  "app/api/agent/running/route.ts",
  "app/api/sessions/stats/route.ts",
  "app/api/agent/[id]/lease/route.ts",
  "app/api/sessions/[id]/state/route.ts",
];

const backendImplementationImports = [
  "@/lib/agent-catalog",
  "@/lib/claude-routes",
  "@/lib/rpc-manager",
  "@/lib/agent-backends/claude",
  "@/lib/session-reader",
  "@/lib/session-stats",
  "@/lib/session-timing",
  "@/lib/side-session",
  "@/lib/subagent-runtime",
  "./agent-catalog",
  "./claude-routes",
  "./rpc-manager",
  "./agent-backends/claude",
];

test("runtime starters are confined to the runtime module", async () => {
  const files = await readdir(new URL(".", import.meta.url), { recursive: true });
  for (const file of files.filter((name) => name.endsWith(".ts") && name !== "runtime.ts" && name !== "index.ts")) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:startRpcSession|ensureClaudeSession|claudeCreate|claudeFork|createCodexSession|ensureCodexSession)\b/u, file);
  }
});

test("service modules use the session entry type boundary", async () => {
  const files = await readdir(new URL(".", import.meta.url), { recursive: true });
  for (const file of files.filter((name) => name.endsWith(".ts"))) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bas\s+unknown\s+as\s+SessionEntry\s*\[\s*\]/u, file);
  }
});

test("aggregate session routes delegate backend work to the operation service", async () => {
  for (const route of routes) {
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    assert.match(source, /from "@\/lib\/backend-service"/u, `${route} must import the operation service`);
    for (const implementation of backendImplementationImports) {
      assert.doesNotMatch(source, new RegExp(`from ["']${implementation.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}["']`, "u"), `${route} must not import ${implementation}`);
    }
  }
});

test("runtime routes call their service operations", async () => {
  for (const [route, operation] of [
    ["app/api/agent/new/route.ts", "createRuntime"],
    ["app/api/agent/[id]/route.ts", "commandRuntime"],
    ["app/api/agent/[id]/events/route.ts", "runtimeEvents"],
    ["app/api/agent/[id]/bash-output/route.ts", "bashOutput"],
    ["app/api/sessions/[id]/handoff/route.ts", "handoff"],
    ["app/api/sessions/[id]/auto-name/route.ts", "autoName"],
  ]) {
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`sessions\\.${operation}\\(`, "u"), route);
    if (operation === "bashOutput") assert.doesNotMatch(source, /@\/lib\/(?:bash-output|session-file-references)/u, route);
  }
});

test("state GET handlers delegate backend work to the service", async () => {
  for (const route of ["app/api/sessions/[id]/state/route.ts", "app/api/agent/[id]/route.ts"]) {
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    const get = source.slice(source.indexOf("export async function GET("));
    assert.match(source, /from "@\/lib\/backend-service"/u, route);
    assert.match(get, /sessions\.state\(/u, route);
    assert.doesNotMatch(get, /(?:claudeState|isClaudeKey|claudeBackend|getRpcSession|resolveSessionPath|startRpcSession)/u, route);
  }
});

test("rename PATCH delegates backend work to the service", async () => {
  for (const [route, operation] of [["app/api/sessions/[id]/route.ts", "rename"]]) {
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    const patch = source.slice(source.indexOf("export async function PATCH("), source.indexOf("// DELETE"));
    assert.match(source, /from "@\/lib\/backend-service"/u, route);
    assert.match(patch, new RegExp(`sessions\\.${operation}\\(`, "u"), route);
    assert.doesNotMatch(patch, /(?:claudeRename|isClaudeKey|claudeBackend|renameRpcSession|resolveSessionPath|openSessionManager|invalidateSessionManagerCache|invalidateSessionListCache)/u, route);
    assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:claudeRename|renameRpcSession|openSessionManager|resolveSessionPath|invalidateSessionManagerCache|invalidateSessionListCache)\b[^}]*\}\s*from/u, route);
  }
});

test("single-session DELETE delegates backend work to the service", async () => {
  const source = await readFile(new URL("../../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("export async function DELETE("));
  assert.match(handler, /sessions\.delete\(/u);
  assert.doesNotMatch(handler, /\b(?:deleteSessions|claudeDelete|resolveSessionPath|forgetSessionUiState|invalidateSessionListCache)\b/u);
  assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:deleteSessions|claudeDelete|resolveSessionPath|forgetSessionUiState|invalidateSessionListCache)\b[^}]*\}\s*from/u);
});

test("bulk delete POST delegates backend work to the service", async () => {
  const source = await readFile(new URL("../../app/api/sessions/delete/route.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("export async function POST("));
  assert.match(source, /from "@\/lib\/backend-service"/u);
  assert.match(handler, /sessions\.deleteBulk\(/u);
  assert.doesNotMatch(handler, /\b(?:deleteSessions|claudeBackend|claudeEnabled|forgetSessionUiState|invalidateSessionListCache)\b/u);
  assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:deleteSessions|claudeBackend|claudeEnabled|forgetSessionUiState|invalidateSessionListCache)\b[^}]*\}\s*from/u);
});

test("fork POST delegates backend work to the service", async () => {
  const source = await readFile(new URL("../../app/api/sessions/[id]/fork/route.ts", import.meta.url), "utf8");
  assert.match(source, /from "@\/lib\/backend-service"/u);
  assert.match(source, /sessions\.fork\(/u);
  assert.doesNotMatch(source, /claudeFork\(|@\/lib\/claude-routes/u);
  assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:getRpcSession|forkSessionBranch|createSideSession|readForkSourceTitle|resolveSessionPath|cacheSessionPath|readSessionInfo|readLatestSessionEntryId|invalidateSessionListCache|invalidateSessionPathCache|SessionForkError)\b[^}]*\}\s*from/u);
});

test("history GET handlers delegate backend work to the service", async () => {
  for (const route of ["app/api/sessions/[id]/route.ts", "app/api/sessions/[id]/context/route.ts"]) {
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    const get = source.slice(source.indexOf("export async function GET("), source.indexOf("// PATCH") < 0 ? undefined : source.indexOf("// PATCH"));
    assert.match(source, /from "@\/lib\/backend-service"/u);
    assert.match(get, /sessions\.(?:read|context)\(/u);
    assert.doesNotMatch(get, /(?:claudeSession|isClaudeKey|claudeBackend|getRpcSession|readClaudeSession|openSessionManager|resolveSessionPath|buildSessionContext)/u);
    if (route.includes("/context/")) {
      for (const implementation of [...backendImplementationImports, "@/lib/session-reader"]) {
        assert.equal(source.includes(`from "${implementation}"`), false, `${route} must not import ${implementation}`);
      }
    }
  }
});

test("entry detail GET handlers delegate backend work to the service", async () => {
  for (const [part, operation] of [["thinking", "thinking"], ["tool-result-image", "toolResultImage"]]) {
    const route = `app/api/sessions/[id]/entries/[entryId]/${part}/route.ts`;
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    assert.match(source, /from "@\/lib\/backend-service"/u, route);
    assert.match(source, new RegExp(`sessions\\.${operation}\\(`, "u"), route);
    assert.doesNotMatch(source, /\b(?:resolveSessionPath|getSessionEntries)\b/u, route);
  }
});

test("subagents GET delegates backend work to the service", async () => {
  const source = await readFile(new URL("../../app/api/sessions/[id]/subagents/route.ts", import.meta.url), "utf8");
  assert.match(source, /from "@\/lib\/backend-service"/u);
  assert.match(source, /sessions\.subagents\(/u);
  assert.doesNotMatch(source, /\b(?:isClaudeKey|claudeFailure|readClaudeSubagents)\b/u);
});

test("export GET delegates backend work to the service", async () => {
  const source = await readFile(new URL("../../app/api/sessions/[id]/export/route.ts", import.meta.url), "utf8");
  assert.match(source, /sessions\.exportSession\(/u);
  assert.doesNotMatch(source, /\b(?:resolveSessionPath|isClaudeKey|claudeBackend|exportClaudeHtml)\b/u);
});

test("codex admission is explicit for implemented runtime and whole-thread fork routes", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { sessionRouteRefusal } = await jiti.import("../session-route-identity.ts");
  const id = "codex:01900000-0000-7000-8000-000000000001";
  assert.equal(sessionRouteRefusal(id).status, 400);
  assert.equal(sessionRouteRefusal(id, { allowCodex: true }), null);
  assert.equal(sessionRouteRefusal("codex:invalid", { allowCodex: true }).status, 400);
  for (const route of ["app/api/agent/[id]/route.ts", "app/api/agent/[id]/events/route.ts", "app/api/sessions/[id]/fork/route.ts"]) {
    const source = await readFile(new URL(`../../${route}`, import.meta.url), "utf8");
    assert.match(source, /sessionRouteRefusal\(id, \{ allowCodex: true \}\)/u);
  }
});
