import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-entry-detail-"));
const previousAgentHome = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
test.after(async () => {
  if (previousAgentHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentHome;
  await rm(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { sessions } = await jiti.import("./index.ts");
const { cacheSessionPath, invalidateSessionPathCache, resolveSessionPath } = await jiti.import("../session-reader.ts");
const { MAX_TOOL_RESULT_IMAGE_BYTES } = await jiti.import("../tool-result-images.ts");
const thinkingRoute = (await jiti.import("../../app/api/sessions/[id]/entries/[entryId]/thinking/route.ts")).GET;
const imageRoute = (await jiti.import("../../app/api/sessions/[id]/entries/[entryId]/tool-result-image/route.ts")).GET;
const id = "entry-detail-fixture";
const timestamp = "2026-01-01T00:00:00.000Z";
const path = join(root, "fixture.jsonl");
const image = (data, mimeType = "image/png") => ({ type: "image", data, mimeType });
const blocks = [
  { type: "text", text: "not an image" }, image("aGVsbG8="),
  { type: "image", source: { type: "base64", data: "d29ybGQ=", media_type: "image/jpeg" } },
  image("aGVsbG8=", "image/svg+xml"), image("a!AA"), image("A==="), image("AA=A"),
  image("A".repeat(Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) + 8)),
  image(Buffer.alloc(MAX_TOOL_RESULT_IMAGE_BYTES + 1).toString("base64")),
];
await writeFile(path, [
  { type: "session", version: 3, id, timestamp, cwd: root },
  { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "hello", timestamp: 1 } },
  { type: "message", id: "assistant", parentId: "user", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "reply" }], timestamp: 2 } },
  { type: "message", id: "tool", parentId: "assistant", timestamp, message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: blocks, timestamp: 3 } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
cacheSessionPath(id, path);
test.after(() => invalidateSessionPathCache(id));
const request = (entryId, blockIndex = 0, sessionId = id) => ({ id: sessionId, entryId, blockIndex });
const get = (handler, sessionId, entryId = "assistant", query = "?blockIndex=0") => handler(
  new Request(`http://localhost/detail${query}`), { params: Promise.resolve({ id: sessionId, entryId }) },
);

for (const [label, operation, entry] of [["thinking", sessions.thinking, "assistant"], ["image", sessions.toolResultImage, "tool"]]) {
  test(`${label} reports missing sessions and entries`, async () => {
    assert.deepEqual(await operation(request(entry, 0, "missing-entry-detail")), { ok: false, kind: "not-found" });
    assert.deepEqual(await operation(request("missing")), { ok: false, kind: "entry-not-found" });
    assert.deepEqual(await operation(request("user")), { ok: false, kind: "entry-not-found" });
  });
  test(`${label} reports invalid and unavailable session identities`, async () => {
    for (const [sessionId, expected] of [
      ["bad/id", { ok: false, kind: "invalid", reason: "invalid-id" }],
      ["future:123", { ok: false, kind: "invalid", reason: "unknown-namespace" }],
      ["codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a", { ok: false, kind: "unsupported" }],
      ["claude:123e4567-e89b-42d3-a456-426614174010", { ok: false, kind: "not-found" }],
    ]) assert.deepEqual(await operation(request(entry, 0, sessionId)), expected);
  });
}

test("thinking returns the requested block and rejects other blocks", async () => {
  assert.deepEqual(await sessions.thinking(request("assistant")), { ok: true, value: { thinking: "private reasoning" } });
  for (const index of [1, 99]) assert.deepEqual(await sessions.thinking(request("assistant", index)), { ok: false, kind: "block-not-found" });
});

test("image reads both stored forms and rejects other blocks", async () => {
  for (const [index, mime, text] of [[1, "image/png", "hello"], [2, "image/jpeg", "world"]]) {
    const result = await sessions.toolResultImage(request("tool", index));
    assert.equal(result.ok, true);
    assert.equal(result.value.mime, mime);
    assert.equal(Buffer.from(result.value.bytes).toString(), text);
  }
  for (const index of [0, 99]) assert.deepEqual(await sessions.toolResultImage(request("tool", index)), { ok: false, kind: "block-not-found" });
});

test("image refuses unsupported MIME and malformed, wrongly padded, or oversized data", async () => {
  assert.deepEqual(await sessions.toolResultImage(request("tool", 3)), { ok: false, kind: "unsupported-mime" });
  for (const index of [4, 5, 6, 7, 8]) assert.deepEqual(await sessions.toolResultImage(request("tool", index)), { ok: false, kind: "invalid-image" }, `block ${index}`);
});

test("entry routes preserve HTTP bodies, cache headers and error mappings", async () => {
  for (const [handler, entry, index, status, body] of [
    [thinkingRoute, "assistant", 0, 200, { thinking: "private reasoning" }],
    [thinkingRoute, "missing", 0, 404, { error: "Assistant message not found" }],
    [thinkingRoute, "assistant", 1, 404, { error: "Thinking block not found" }],
    [imageRoute, "missing", 0, 404, { error: "Tool result not found" }],
    [imageRoute, "tool", 0, 404, { error: "Tool result image not found" }],
    [imageRoute, "tool", 3, 415, { error: "Unsupported image type" }],
    [imageRoute, "tool", 4, 413, { error: "Invalid or oversized image data" }],
  ]) {
    const response = await get(handler, id, entry, `?blockIndex=${index}`);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assert.equal(response.headers.get("cache-control"), null);
  }
  const response = await get(imageRoute, id, "tool", "?blockIndex=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), "5");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "hello");
});

test("Claude-shaped IDs retain legacy Pi path-cache lookup behavior", async (t) => {
  const legacyId = "claude:123e4567-e89b-42d3-a456-426614174020";
  const legacyPath = join(root, "legacy.jsonl");
  await writeFile(legacyPath, [
    { type: "session", version: 3, id: legacyId, timestamp, cwd: root },
    { type: "message", id: "legacy", parentId: null, timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "legacy" }], timestamp: 1 } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  cacheSessionPath(legacyId, legacyPath);
  t.after(() => invalidateSessionPathCache(legacyId));
  const response = await get(thinkingRoute, legacyId, "legacy");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { thinking: "legacy" });
});

test("identity guards precede query validation and preserve Claude wire bytes", async () => {
  const claude = "claude:123e4567-e89b-42d3-a456-426614174010";
  assert.equal(await resolveSessionPath(claude), null);
  for (const handler of [thinkingRoute, imageRoute]) {
    for (const [sessionId, body] of [
      ["bad/id", '{"error":"Invalid session id","reason":"invalid-id"}'],
      ["future:123", '{"error":"Invalid session id","reason":"unknown-namespace"}'],
      ["codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a", '{"error":"Codex sessions are not available","reason":"backend-unavailable"}'],
    ]) for (const query of ["", "?blockIndex=0"]) {
      const response = await get(handler, sessionId, "missing", query);
      assert.equal(response.status, 400);
      assert.equal(await response.text(), body);
    }
    const valid = await get(handler, claude);
    assert.equal(valid.status, 404);
    assert.equal(await valid.text(), '{"error":"Session not found"}');
    for (const query of ["", "?blockIndex=-1", "?blockIndex=1.5", "?blockIndex=9007199254740992"]) {
      const response = await get(handler, claude, "missing", query);
      assert.equal(response.status, 400);
      assert.equal(await response.text(), '{"error":"Valid blockIndex is required"}');
    }
  }
});
