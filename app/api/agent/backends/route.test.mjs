import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const { GET } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");

test("discovery keeps Pi available and reports disabled Claude", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-discovery-"));
  const original = process.env.PI_WEB_CLAUDE;
  const originalCodex = process.env.PI_WEB_CODEX;
  process.env.PI_WEB_CLAUDE = "0";
  process.env.PI_WEB_CODEX = "0";
  t.after(async () => {
    if (original === undefined) delete process.env.PI_WEB_CLAUDE;
    else process.env.PI_WEB_CLAUDE = original;
    if (originalCodex === undefined) delete process.env.PI_WEB_CODEX;
    else process.env.PI_WEB_CODEX = originalCodex;
    await rm(cwd, { recursive: true, force: true });
  });
  const response = await GET(new Request(`http://localhost/api/agent/backends?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.defaultBackend, "pi");
  assert.deepEqual(result.backends.map(({ backend }) => backend), ["pi", "claude", "codex"]);
  assert.equal(result.backends[2].available, false);
  assert.equal(result.backends[2].browsingAvailable, false);
  assert.equal(result.backends[0].available, true);
  assert.equal(result.backends[1].available, false);
  assert.equal(result.backends[1].configuration.reason, "disabled");
});

test("discovery rejects a relative directory", async () => {
  const response = await GET(new Request("http://localhost/api/agent/backends?cwd=relative"));
  assert.equal(response.status, 400);
});
