import type { AgentMessage } from "./types";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return "<pre>" + escapeHtml(content) + "</pre>";
  if (!Array.isArray(content)) return "<pre>" + escapeHtml(JSON.stringify(content) ?? "") + "</pre>";
  return content.map((block: unknown) => {
    if (typeof block !== "object" || block === null) return "";
    if ("type" in block && block.type === "image") {
      const source = "source" in block && typeof block.source === "object" && block.source !== null ? block.source : null;
      if (source && "type" in source && source.type === "base64"
        && "media_type" in source && typeof source.media_type === "string" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)
        && "data" in source && typeof source.data === "string" && /^[A-Za-z0-9+/=\r\n]+$/.test(source.data)) {
        return '<img alt="Session image" src="data:' + source.media_type + ';base64,' + source.data + '">';
      }
      return "<p>[Image unavailable in export]</p>";
    }
    if ("text" in block && typeof block.text === "string") return "<pre>" + escapeHtml(block.text) + "</pre>";
    if ("thinking" in block && typeof block.thinking === "string") return "<details><summary>Thinking</summary><pre>" + escapeHtml(block.thinking) + "</pre></details>";
    return "<pre>" + escapeHtml(JSON.stringify(block, null, 2)) + "</pre>";
  }).join("");
}

export function exportClaudeHtml(title: string, messages: AgentMessage[]): string {
  const body = messages.map((message) => '<article><h2>' + escapeHtml(message.role) + '</h2>'
    + renderContent("content" in message ? message.content : message) + '</article>').join("");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
    + escapeHtml(title) + '</title><style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:64rem;color:#202124;background:#fff}article{border-top:1px solid #ccc;padding:1rem 0}h2{font-size:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}img{max-width:100%;height:auto}details{color:#555}@media(prefers-color-scheme:dark){body{color:#ddd;background:#181818}details{color:#aaa}}</style></head><body><h1>'
    + escapeHtml(title) + '</h1><p>Claude Code · conversation display export</p>' + body + '</body></html>';
}
