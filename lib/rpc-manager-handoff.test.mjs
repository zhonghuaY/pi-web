import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { AgentSessionWrapper, PiHandoffCaptureError, renameRpcSession, setRpcSessionTools, startRpcSession, withPiHandoffSnapshot } = await createJiti(import.meta.url).import("./rpc-manager.ts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a history-only capture excludes concurrent starts and nested captures", async () => {
  const entered = deferred();
  const release = deferred();
  const capture = withPiHandoffSnapshot("handoff-test-source", async () => {
    entered.resolve();
    await release.promise;
    return "snapshot";
  });
  await entered.promise;
  await assert.rejects(startRpcSession("handoff-test-source", "", undefined), (error) => error instanceof PiHandoffCaptureError && error.reason === "capturing");
  await assert.rejects(renameRpcSession("handoff-test-source", "name", () => true), (error) => error instanceof PiHandoffCaptureError && error.reason === "capturing");
  await assert.rejects(setRpcSessionTools("handoff-test-source", "unused", []), (error) => error instanceof PiHandoffCaptureError && error.reason === "capturing");
  await assert.rejects(withPiHandoffSnapshot("handoff-test-source", async () => null), (error) => error instanceof PiHandoffCaptureError && error.reason === "capturing");
  release.resolve();
  assert.equal(await capture, "snapshot");
  assert.equal(await withPiHandoffSnapshot("handoff-test-source", async () => "next"), "next");
});

test("a capture refuses a session whose startup is already in flight", async () => {
  const previous = globalThis.__piStartLocks;
  globalThis.__piStartLocks = new Map([["handoff-starting-source", new Promise(() => {})]]);
  try {
    await assert.rejects(withPiHandoffSnapshot("handoff-starting-source", async () => null), (error) => error instanceof PiHandoffCaptureError && error.reason === "starting");
  } finally {
    globalThis.__piStartLocks = previous;
  }
});

test("capture waits for a child to settle before accepting the source", async (t) => {
  const previous = globalThis.__piSubagentRuns;
  t.after(() => { globalThis.__piSubagentRuns = previous; });
  const source = "handoff-parent-source";
  globalThis.__piSubagentRuns = new Map([["handoff-child", { run: { sessionId: "handoff-child", parentSessionId: source } }]]);
  await assert.rejects(withPiHandoffSnapshot(source, async () => "snapshot"),
    (error) => error instanceof PiHandoffCaptureError && error.reason === "busy");
  globalThis.__piSubagentRuns.clear();
  assert.equal(await withPiHandoffSnapshot(source, async () => "snapshot"), "snapshot");
});

test("a live capture refuses a running source and excludes mutating commands", async () => {
  const previous = globalThis.__piSessions;
  const inner = { sessionId: "handoff-live-source", isStreaming: true, isBashRunning: false, isCompacting: false };
  const wrapper = new AgentSessionWrapper(inner);
  globalThis.__piSessions = new Map([[inner.sessionId, wrapper]]);
  try {
    await assert.rejects(withPiHandoffSnapshot(inner.sessionId, async () => null), (error) => error instanceof PiHandoffCaptureError && error.reason === "busy");
    inner.isStreaming = false;
    await withPiHandoffSnapshot(inner.sessionId, async () => {
      await assert.rejects(wrapper.send({ type: "prompt", message: "concurrent" }), /being copied/);
      await assert.rejects(wrapper.shutdown(), (error) => error instanceof PiHandoffCaptureError && error.reason === "capturing");
    });
  } finally {
    globalThis.__piSessions = previous;
  }
});
