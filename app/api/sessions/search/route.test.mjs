import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

test("search reports a failed Claude catalogue instead of a complete result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-search-failure-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "pi");
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(dir, { recursive: true, force: true });
  });
  const stub = join(dir, "catalogue.cjs");
  await writeFile(stub, 'exports.readClaudeCatalogue = async () => ({ sessions: [], error: "Claude session history is unavailable" });\nexports.readCodexCatalogue = async () => ({ sessions: [] });\n');
  const jiti = createJiti(import.meta.url, { alias: { "@/lib/agent-catalog": stub, "@": process.cwd() }, moduleCache: false });
  const { GET } = await jiti.import("./route.ts");
  const response = await GET(new Request("http://localhost/api/sessions/search?q=example"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.results, []);
  assert.deepEqual(body.backendErrors, { claude: "Claude session history is unavailable" });
});
