import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { promisify } from "util";
import { fileURLToPath, pathToFileURL } from "url";
import { claudeBackend } from "@/lib/agent-catalog";
import { exportClaudeHtml } from "@/lib/claude-export";
import { parseSessionKey } from "@/lib/session-identity";
import { resolveSessionPath } from "@/lib/session-reader";
import type { SessionHistoryFailure } from "./index";

export interface SessionExportRequest { id: string }
export type SessionExportResult =
  | { ok: true; value: { backend: "pi" | "claude"; html: string; fileName: string } }
  | SessionHistoryFailure;

const execFileAsync = promisify(execFile);

type PiCodingAgentModule = {
  getPackageDir: () => string;
};

type ExportHtmlModule = {
  exportFromFile: (inputPath: string, outputPath: string) => Promise<string>;
};

async function getPiPackageDir(): Promise<string | null> {
  try {
    const { getPackageDir } = (await import("@earendil-works/pi-coding-agent")) as PiCodingAgentModule;
    return getPackageDir();
  } catch {
    return null;
  }
}

async function getPiCliPath(): Promise<string | null> {
  const candidates = new Set<string>();
  const packageDir = await getPiPackageDir();
  if (packageDir) candidates.add(join(packageDir, "dist", "cli.js"));

  try {
    const resolver = (import.meta as ImportMeta & {
      resolve?: (specifier: string) => string | Promise<string>;
    }).resolve;
    if (typeof resolver === "function") {
      const indexUrl = await resolver("@earendil-works/pi-coding-agent");
      candidates.add(join(dirname(fileURLToPath(indexUrl)), "cli.js"));
    }
  } catch {
    // Next.js production bundles can strip import.meta.resolve.
  }

  candidates.add(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function exportPiFile(filePath: string, outputPath: string): Promise<void> {
  const cliPath = await getPiCliPath();
  if (cliPath) {
    await execFileAsync(process.execPath, [cliPath, "--export", filePath, outputPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      maxBuffer: 1024 * 1024,
    });
    return;
  }

  const packageDir = await getPiPackageDir();
  if (!packageDir) throw new Error("pi CLI not found");

  const exporterUrl = pathToFileURL(join(packageDir, "dist", "core", "export-html", "index.js")).href;
  const { exportFromFile } = (await import(exporterUrl)) as ExportHtmlModule;
  await exportFromFile(filePath, outputPath);
}

export async function exportSession({ id }: SessionExportRequest): Promise<SessionExportResult> {
  const identity = parseSessionKey(id);
  if (!identity.ok) return { ok: false, kind: "invalid", reason: identity.reason };
  const { backend } = identity.key;
  if (backend === "codex") return { ok: false, kind: "unsupported" };
  try {
    if (backend === "claude") {
      const claude = await claudeBackend();
      const snapshot = await claude.readClaudeSession(id);
      const messages = await claude.getClaudeDisplayMessages(id);
      return { ok: true, value: {
        backend, html: exportClaudeHtml(snapshot.info.name || "Claude Code session", messages),
        fileName: "claude-session-" + id.slice(7) + ".html",
      } };
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) return { ok: false, kind: "not-found" };
    const tempDir = join(tmpdir(), "pi-web-export");
    mkdirSync(tempDir, { recursive: true });
    const outputPath = join(tempDir, `${randomUUID()}.html`);
    try {
      await exportPiFile(filePath, outputPath);
      const html = readFileSync(outputPath, "utf8");
      return { ok: true, value: { backend, html, fileName: `pi-session-${basename(filePath, ".jsonl")}.html` } };
    } finally {
      rmSync(outputPath, { force: true });
    }
  } catch (error) {
    return { ok: false, kind: "error", backend, error };
  }
}
