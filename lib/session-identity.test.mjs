import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createJiti } from "jiti";
const { parseSessionKey, formatSessionKey, handoffEdges, isHandoffEdge } = await createJiti(import.meta.url).import("./session-identity.ts");

test("session keys round-trip and reject malformed namespaces and IDs", () => {
  const valid = [
    ["pi", "session-1"], ["pi", "76dd1bed-f24e-4f5f-a7f2-496c101e4e7a"],
    ...[1, 2, 3, 4, 5].map((v) => ["claude", `claude:76dd1bed-f24e-${v}f5f-a7f2-496c101e4e7a`]),
    ["codex", "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a"],
  ];
  for (const [backend, value] of valid) {
    const result = parseSessionKey(value);
    assert.equal(result.ok, true, value);
    assert.equal(result.key.backend, backend);
    assert.equal(formatSessionKey(result.key), value);
  }
  for (const [value, expected] of [
    ["claude:76DD1BED-F24E-4F5F-A7F2-496C101E4E7A", "claude:76dd1bed-f24e-4f5f-a7f2-496c101e4e7a"],
    ["codex:019C1BED-F24E-7F5F-A7F2-496C101E4E7A", "codex:019c1bed-f24e-7f5f-a7f2-496c101e4e7a"],
    ["Mixed.Pi-Id", "Mixed.Pi-Id"],
  ]) {
    const result = parseSessionKey(value);
    assert.equal(result.ok, true, value);
    assert.equal(formatSessionKey(result.key), expected);
  }
  for (const value of ["", "claude:", "CLAUDE:76dd1bed-f24e-4f5f-a7f2-496c101e4e7a", "other:123", "claude:not-a-uuid", "codex:76dd1bed-f24e-4f5f-a7f2-496c101e4e7a", "codex:../x", "claude:a:b", "a/b", "a\n", "codex:%252e%252e"]) {
    const result = parseSessionKey(value);
    assert.equal(result.ok, false, value);
    assert.equal(typeof result.reason, "string");
  }
});

test("only the six directed cross-backend handoff edges exist", () => {
  assert.equal(handoffEdges.length, 6);
  for (const source of ["pi", "claude", "codex"]) for (const target of ["pi", "claude", "codex", "unknown"]) {
    assert.equal(isHandoffEdge(source, target), source !== target && target !== "unknown", `${source} -> ${target}`);
  }
  assert.equal(isHandoffEdge("unknown", "pi"), false);
});

test("identity consumers share the client-safe module", async () => {
  for (const file of ["agent-backends/types.ts", "agent-backends.ts", "session-ui-state-shared.ts", "session-handoff.ts", "session-file-references-core.ts"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /from ["'][^"']*session-identity(?:\.ts)?["']/u, file);
  }
});

test("identity and its transitive runtime imports are browser-safe", async () => {
  const pending = [fileURLToPath(new URL("./session-identity.ts", import.meta.url))];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let specifier;
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) specifier = node.moduleSpecifier;
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
      if (specifier) {
        assert.ok(ts.isStringLiteral(specifier), `${file} uses a dynamic import`);
        const name = specifier.text;
        assert.ok(name.startsWith("."), `${file} imports ${name}`);
        assert.doesNotMatch(name, /(?:server-only|agent-backends|backend-service)/);
        pending.push(resolve(dirname(file), name.endsWith(".ts") ? name : name + ".ts"));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});
