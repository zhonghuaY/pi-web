import lockfile from "proper-lockfile";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isClaudeSessionId, isNativeClaudeSessionId } from "./types";

export interface ClaudeWebMetadataEntry {
  parentSessionId: string;
  policy: "side-read-only";
  createdAt: string;
}

export interface PendingClaudeSideFork {
  parentSessionId: string;
  cwd: string;
  baselineSessionIds: string[];
  createdAt: string;
}

export interface ClaudeHandoffMetadataEntry {
  sourceSessionId: string;
  sourceBackend: "pi" | "claude";
  sourceEntryId?: string;
  requestId: string;
  title: string;
  createdAt: string;
}

export interface ClaudeWebMetadataFile {
  version: 1;
  sessions: Record<string, ClaudeWebMetadataEntry>;
  pendingSideForks: Record<string, PendingClaudeSideFork>;
  handoffs: Record<string, ClaudeHandoffMetadataEntry>;
}

let serializedWrite = Promise.resolve();

export function claudeMetadataPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(root, "pi-web", "claude-session-metadata.json");
}

function empty(): ClaudeWebMetadataFile {
  return { version: 1, sessions: {}, pendingSideForks: {}, handoffs: {} };
}

export async function readClaudeWebMetadata(path = claudeMetadataPath()): Promise<ClaudeWebMetadataFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      throw new Error("invalid metadata version");
    }
    const source = (parsed as { sessions?: unknown }).sessions;
    if (!source || typeof source !== "object") throw new Error("invalid metadata sessions");
    const sessions: Record<string, ClaudeWebMetadataEntry> = {};
    for (const [id, value] of Object.entries(source)) {
      if (!isNativeClaudeSessionId(id) || !value || typeof value !== "object") throw new Error("invalid metadata row");
      const row = value as Partial<ClaudeWebMetadataEntry>;
      if (row.policy !== "side-read-only" || !isClaudeSessionId(row.parentSessionId ?? "") || typeof row.createdAt !== "string") {
        throw new Error("invalid metadata row");
      }
      sessions[id.toLowerCase()] = { parentSessionId: row.parentSessionId!, policy: row.policy, createdAt: row.createdAt };
    }
    const handoffSource = (parsed as { handoffs?: unknown }).handoffs ?? {};
    if (!handoffSource || typeof handoffSource !== "object") throw new Error("invalid handoffs");
    const handoffs: Record<string, ClaudeHandoffMetadataEntry> = {};
    for (const [id, value] of Object.entries(handoffSource)) {
      if (!isNativeClaudeSessionId(id) || !value || typeof value !== "object") throw new Error("invalid handoff row");
      const row = value as Partial<ClaudeHandoffMetadataEntry>;
      if (typeof row.sourceSessionId !== "string" || row.sourceSessionId.length === 0 || row.sourceSessionId.length > 200
        || (row.sourceBackend !== "pi" && row.sourceBackend !== "claude")
        || (row.sourceEntryId !== undefined && (typeof row.sourceEntryId !== "string" || row.sourceEntryId.length > 200))
        || typeof row.requestId !== "string" || !isNativeClaudeSessionId(row.requestId)
        || typeof row.title !== "string" || row.title.length > 500
        || typeof row.createdAt !== "string") {
        throw new Error("invalid handoff row");
      }
      handoffs[id.toLowerCase()] = {
        sourceSessionId: row.sourceSessionId,
        sourceBackend: row.sourceBackend,
        ...(row.sourceEntryId ? { sourceEntryId: row.sourceEntryId } : {}),
        requestId: row.requestId.toLowerCase(),
        title: row.title,
        createdAt: row.createdAt,
      };
    }
    const pendingSource = (parsed as { pendingSideForks?: unknown }).pendingSideForks ?? {};
    if (!pendingSource || typeof pendingSource !== "object") throw new Error("invalid pending side forks");
    const pendingSideForks: Record<string, PendingClaudeSideFork> = {};
    for (const [id, value] of Object.entries(pendingSource)) {
      if (!isNativeClaudeSessionId(id) || !value || typeof value !== "object") throw new Error("invalid pending side fork");
      const row = value as Partial<PendingClaudeSideFork>;
      if (!isClaudeSessionId(row.parentSessionId ?? "") || typeof row.cwd !== "string" || !Array.isArray(row.baselineSessionIds)
        || !row.baselineSessionIds.every(isNativeClaudeSessionId) || typeof row.createdAt !== "string") {
        throw new Error("invalid pending side fork");
      }
      pendingSideForks[id] = {
        parentSessionId: row.parentSessionId!,
        cwd: row.cwd,
        baselineSessionIds: row.baselineSessionIds.map((sessionId) => sessionId.toLowerCase()),
        createdAt: row.createdAt,
      };
    }
    return { version: 1, sessions, pendingSideForks, handoffs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw new Error("Claude Web metadata could not be loaded");
  }
}

async function mutate(update: (file: ClaudeWebMetadataFile) => void, path: string): Promise<void> {
  const run = serializedWrite.then(async () => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 5, minTimeout: 10, maxTimeout: 100, randomize: true },
    });
    const temporary = join(directory, "." + randomUUID() + ".tmp");
    try {
      const file = await readClaudeWebMetadata(path);
      update(file);
      await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
      await release().catch(() => undefined);
    }
  });
  serializedWrite = run.catch(() => undefined);
  await run;
}

export async function beginClaudeSideFork(
  parentSessionId: string,
  cwd: string,
  baselineSessionIds: string[],
  path = claudeMetadataPath(),
): Promise<string> {
  if (!isClaudeSessionId(parentSessionId) || !baselineSessionIds.every(isNativeClaudeSessionId)) {
    throw new Error("Invalid Claude side fork metadata");
  }
  const operationId = randomUUID();
  await mutate((file) => {
    file.pendingSideForks[operationId] = {
      parentSessionId,
      cwd,
      baselineSessionIds: baselineSessionIds.map((id) => id.toLowerCase()),
      createdAt: new Date().toISOString(),
    };
  }, path);
  return operationId;
}

export function completeClaudeSideFork(
  operationId: string,
  nativeId: string,
  path = claudeMetadataPath(),
): Promise<void> {
  if (!isNativeClaudeSessionId(operationId) || !isNativeClaudeSessionId(nativeId)) throw new Error("Invalid Claude side fork metadata");
  return mutate((file) => {
    const pending = file.pendingSideForks[operationId];
    if (!pending) throw new Error("Claude side fork policy is unavailable");
    file.sessions[nativeId.toLowerCase()] = {
      parentSessionId: pending.parentSessionId,
      policy: "side-read-only",
      createdAt: pending.createdAt,
    };
    delete file.pendingSideForks[operationId];
  }, path);
}

export function abortClaudeSideFork(operationId: string, path = claudeMetadataPath()): Promise<void> {
  return mutate((file) => {
    delete file.pendingSideForks[operationId];
  }, path);
}

export function claudeSidePolicy(
  nativeId: string,
  cwd: string,
  metadata: ClaudeWebMetadataFile,
): ClaudeWebMetadataEntry | undefined {
  const exact = metadata.sessions[nativeId.toLowerCase()];
  if (exact) return exact;
  for (const pending of Object.values(metadata.pendingSideForks)) {
    if (pending.cwd === cwd && !pending.baselineSessionIds.includes(nativeId.toLowerCase())) {
      return { parentSessionId: pending.parentSessionId, policy: "side-read-only", createdAt: pending.createdAt };
    }
  }
  return undefined;
}

export function recordClaudeHandoff(
  nativeId: string,
  entry: Omit<ClaudeHandoffMetadataEntry, "createdAt">,
  path = claudeMetadataPath(),
): Promise<void> {
  if (!isNativeClaudeSessionId(nativeId)
    || typeof entry.sourceSessionId !== "string" || entry.sourceSessionId.length === 0 || entry.sourceSessionId.length > 200
    || (entry.sourceBackend !== "pi" && entry.sourceBackend !== "claude")
    || (entry.sourceEntryId !== undefined && (typeof entry.sourceEntryId !== "string" || entry.sourceEntryId.length > 200))
    || !isNativeClaudeSessionId(entry.requestId)
    || typeof entry.title !== "string" || entry.title.length > 500) {
    throw new Error("Invalid Claude handoff metadata");
  }
  return mutate((file) => {
    file.handoffs[nativeId.toLowerCase()] = {
      ...entry,
      requestId: entry.requestId.toLowerCase(),
      createdAt: new Date().toISOString(),
    };
  }, path);
}

export function claudeHandoffMetadata(
  nativeId: string,
  metadata: ClaudeWebMetadataFile,
): ClaudeHandoffMetadataEntry | undefined {
  return metadata.handoffs[nativeId.toLowerCase()];
}

export function deleteClaudeWebMetadata(nativeId: string, path = claudeMetadataPath()): Promise<void> {
  return mutate((file) => {
    delete file.sessions[nativeId.toLowerCase()];
    delete file.handoffs[nativeId.toLowerCase()];
  }, path);
}
