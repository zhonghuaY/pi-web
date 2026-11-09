import assert from "node:assert/strict";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { isolateClaudeHome, isolatePiHome } from "../../claude-test-home.mjs";

await isolateClaudeHome();
const agentDir = await isolatePiHome();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runCodexMutationOnce } = await jiti.import("./mutation-journal.ts");
const digest = "a".repeat(64);
const identity = (kind, suffix) => ({ kind, requestId: `123e4567-e89b-42d3-a456-${suffix.padStart(12, "0")}`, scope: "project", digest });

test("concurrent retries share one accepted native creation", async () => {
  const request = identity("create", "1");
  let calls = 0;
  const create = async () => { calls++; return { kind: "accepted", nativeId: "thread-1" }; };
  const results = await Promise.all([runCodexMutationOnce(request, create), runCodexMutationOnce(request, create)]);
  assert.deepEqual(results, [{ kind: "accepted", nativeId: "thread-1" }, { kind: "accepted", nativeId: "thread-1" }]);
  assert.equal(calls, 1);
  assert.deepEqual(await runCodexMutationOnce({ ...request, scope: "other" }, create), { kind: "conflict" });
  assert.equal(calls, 1);
});

test("a lost prompt result keeps the intent and never resends", async () => {
  const request = identity("prompt", "2");
  let calls = 0;
  const prompt = async () => { calls++; return { kind: "accepted", nativeId: "turn-1" }; };
  assert.deepEqual(await runCodexMutationOnce(request, prompt, () => { throw new Error("lost result"); }), { kind: "outcome-unknown" });
  assert.deepEqual(await runCodexMutationOnce(request, prompt), { kind: "outcome-unknown" });
  assert.equal(calls, 1);
});

test("a definitive native rejection is replayed without retry", async () => {
  const request = identity("create", "3");
  let calls = 0;
  const create = async () => { calls++; return { kind: "rejected", code: -32600 }; };
  assert.deepEqual(await runCodexMutationOnce(request, create), { kind: "rejected", code: -32600 });
  assert.deepEqual(await runCodexMutationOnce(request, create), { kind: "rejected", code: -32600 });
  assert.equal(calls, 1);
});

test("ordinary and handoff ownership domains cannot replay one another's mutations", async () => {
  const calls = new Map();
  for (const kind of ["create", "prompt", "handoff-create", "handoff-prompt"]) {
    const request = identity(kind, "6");
    const execute = async () => {
      calls.set(kind, (calls.get(kind) ?? 0) + 1);
      return { kind: "accepted", nativeId: `owned-${kind}` };
    };
    const first = await runCodexMutationOnce(request, execute);
    const retry = await runCodexMutationOnce(request, execute);
    assert.deepEqual(first, { kind: "accepted", nativeId: `owned-${kind}` });
    assert.deepEqual(retry, first);
  }
  assert.deepEqual([...calls.values()], [1, 1, 1, 1]);
});

test("invalid retained records fail closed", async () => {
  const request = identity("create", "5");
  const uncertain = async () => { throw new Error("disconnected"); };
  assert.deepEqual(await runCodexMutationOnce(request, uncertain), { kind: "outcome-unknown" });
  const path = join(agentDir, "pi-web-codex-mutations", "create", request.requestId, "record.json");
  await writeFile(path, '{"stage":"accepted","nativeId":"wrong"}');
  let calls = 0;
  await assert.rejects(runCodexMutationOnce(request, async () => { calls++; return { kind: "accepted", nativeId: "new" }; }));
  assert.equal(calls, 0);
});

test("a fresh process refuses to repeat creation after a crash", async () => {
  const request = identity("create", "4");
  const marker = join(agentDir, "native-creates");
  const modulePath = fileURLToPath(new URL("./mutation-journal.ts", import.meta.url));
  const script = `
    const { createJiti } = require("jiti");
    const fs = require("node:fs");
    (async () => {
      const { runCodexMutationOnce } = await createJiti(process.cwd() + "/entry.mjs", { tsconfigPaths: true }).import(process.argv[1]);
      const request = JSON.parse(process.argv[3]);
      const result = await runCodexMutationOnce(request, async () => {
        fs.appendFileSync(process.argv[2], "created\\n");
        if (process.argv[4] === "crash") process.exit(77);
        return { kind: "accepted", nativeId: "second-thread" };
      });
      process.stdout.write(JSON.stringify(result));
    })().catch(() => process.exit(1));
  `;
  const args = ["-e", script, modulePath, marker, JSON.stringify(request)];
  const first = spawnSync(process.execPath, [...args, "crash"], { encoding: "utf8", env: process.env });
  assert.equal(first.status, 77, first.stderr);
  const lock = join(agentDir, "pi-web-codex-mutations", "create", request.requestId + ".lock");
  try { await stat(lock); await utimes(lock, new Date(0), new Date(0)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const second = spawnSync(process.execPath, [...args, "retry"], { encoding: "utf8", env: process.env });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: "outcome-unknown" });
  assert.equal(await readFile(marker, "utf8"), "created\n");
});
