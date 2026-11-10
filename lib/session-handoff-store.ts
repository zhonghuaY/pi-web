import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import { isBackendId, parseSessionKey } from "./session-identity";
import type { AgentBackend } from "./agent-backends/types";
import type { SessionInfo } from "./types";

export interface HandoffReceipt {
  sourceSessionId: string;
  sourceEntryId: string | null;
  transferredMessages: number;
  omittedMessages: number;
  truncated: boolean;
}

interface HandoffRecordBase {
  version: 1;
  requestId: string;
  sourceSessionId: string;
  targetBackend: AgentBackend;
  sourceEntryId: string | null;
  sourceRevision?: string;
  envelopeDigest: string;
  transfer: HandoffReceipt;
}

export type HandoffRecord = HandoffRecordBase & (
  | { stage: "intent" | "creating" }
  | { stage: "created" | "admitting" | "complete"; target: SessionInfo }
);

const QUEUE = Symbol.for("pi-web.handoff-records");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown): SessionInfo | null {
  if (!object(value) || typeof value.id !== "string" || typeof value.path !== "string"
    || typeof value.cwd !== "string" || typeof value.created !== "string" || typeof value.modified !== "string"
    || typeof value.messageCount !== "number" || typeof value.firstMessage !== "string"
    || !isBackendId(value.backend)) return null;
  const relation = value.relation;
  if (!object(relation) || relation.kind !== "handoff" || typeof relation.requestId !== "string"
    || typeof relation.sourceSessionId !== "string" || !isBackendId(relation.sourceBackend)
    || (relation.sourceEntryId !== undefined && typeof relation.sourceEntryId !== "string")) return null;
  return {
    id: value.id, path: value.path, cwd: value.cwd, created: value.created, modified: value.modified,
    messageCount: value.messageCount, firstMessage: value.firstMessage, backend: value.backend,
    relation: {
      kind: "handoff", sourceSessionId: relation.sourceSessionId, sourceBackend: relation.sourceBackend,
      requestId: relation.requestId, ...(relation.sourceEntryId !== undefined ? { sourceEntryId: relation.sourceEntryId } : {}),
    },
    ...(typeof value.projectRoot === "string" ? { projectRoot: value.projectRoot } : {}),
    ...(typeof value.projectKey === "string" ? { projectKey: value.projectKey } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.isWorktree === "boolean" ? { isWorktree: value.isWorktree } : {}),
    ...(typeof value.transient === "boolean" ? { transient: value.transient } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

function parseRecord(value: unknown, requestId: string): HandoffRecord {
  if (!object(value) || value.version !== 1 || value.requestId !== requestId
    || typeof value.sourceSessionId !== "string" || !isBackendId(value.targetBackend)
    || (value.sourceEntryId !== null && typeof value.sourceEntryId !== "string")
    || (value.sourceRevision !== undefined && (typeof value.sourceRevision !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceRevision)))
    || typeof value.envelopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.envelopeDigest)
    || !object(value.transfer) || value.transfer.sourceSessionId !== value.sourceSessionId
    || value.transfer.sourceEntryId !== value.sourceEntryId
    || typeof value.transfer.transferredMessages !== "number" || !Number.isSafeInteger(value.transfer.transferredMessages) || value.transfer.transferredMessages < 0
    || typeof value.transfer.omittedMessages !== "number" || !Number.isSafeInteger(value.transfer.omittedMessages) || value.transfer.omittedMessages < 0
    || typeof value.transfer.truncated !== "boolean") throw new Error("Invalid handoff record");
  const common: HandoffRecordBase = {
    version: 1, requestId, sourceSessionId: value.sourceSessionId, targetBackend: value.targetBackend,
    sourceEntryId: value.sourceEntryId, envelopeDigest: value.envelopeDigest,
    ...(typeof value.sourceRevision === "string" ? { sourceRevision: value.sourceRevision } : {}),
    transfer: {
      sourceSessionId: value.sourceSessionId, sourceEntryId: value.sourceEntryId,
      transferredMessages: value.transfer.transferredMessages, omittedMessages: value.transfer.omittedMessages,
      truncated: value.transfer.truncated,
    },
  };
  if (value.stage === "intent" || value.stage === "creating") return { ...common, stage: value.stage };
  if (value.stage === "created" || value.stage === "admitting" || value.stage === "complete") {
    const target = parseTarget(value.target);
    const sourceKey = parseSessionKey(value.sourceSessionId);
    const targetKey = target ? parseSessionKey(target.id) : null;
    if (target && target.backend === value.targetBackend && targetKey?.ok && targetKey.key.backend === value.targetBackend
      && sourceKey.ok && target.relation?.kind === "handoff" && target.relation.sourceBackend === sourceKey.key.backend
      && (target.relation.sourceEntryId ?? null) === value.sourceEntryId
      && target.relation.requestId === requestId && target.relation.sourceSessionId === value.sourceSessionId) {
      return { ...common, stage: value.stage, target };
    }
  }
  throw new Error("Invalid handoff record");
}

export async function withHandoffRecord<T>(requestId: string, operation: (record: HandoffRecord | null, save: (record: HandoffRecord) => HandoffRecord) => Promise<T>): Promise<T> {
  if (!UUID.test(requestId)) throw new Error("Invalid handoff request id");
  const directory = join(getAgentDir(), "pi-web-handoffs", requestId.toLowerCase());
  return serializeByKey(QUEUE, directory, async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, { realpath: false, stale: 60_000, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } });
    try {
      const path = join(directory, "record.json");
      let text: string | undefined;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const record = text === undefined ? null : parseRecord(JSON.parse(text), requestId);
      return await operation(record, (next) => {
        const checked = parseRecord(next, requestId);
        writePrivateFileAtomicSync(path, JSON.stringify(checked));
        return checked;
      });
    } finally {
      await release();
    }
  });
}
