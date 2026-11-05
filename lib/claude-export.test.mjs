import test from "node:test";
import assert from "node:assert/strict";
import { exportClaudeHtml } from "./claude-export.ts";
import { projectSdkUser } from "./agent-backends/claude-projection.ts";

test("Claude display export preserves tool/thinking text and escapes executable markup", () => {
  const html = exportClaudeHtml("</title><script>bad()</script>", [
    { role: "user", content: '<img src=x onerror="bad()">' },
    { role: "assistant", content: [{ type: "thinking", thinking: "reason <private>" }, { type: "toolCall", name: "Read", arguments: { file_path: "/tmp/a" } }] },
    { role: "toolResult", content: [{ type: "text", text: "result & value" }] },
  ]);
  assert.doesNotMatch(html, /<script>|onerror="bad/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<summary>Thinking/);
  assert.match(html, /file_path/);
  assert.match(html, /result &amp; value/);
});
test("export embeds only safe image MIME types and base64", () => {
  const messages = projectSdkUser({ type: "user", message: { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "aGVsbG8=" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: 'x" onerror="bad()' } },
    { type: "image", source: { type: "url", url: "https://example.invalid/image.png" } },
  ] } });
  const html = exportClaudeHtml("Images", messages);
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.equal(html.includes("image/svg"), false);
  assert.doesNotMatch(html, /onerror/);
});
