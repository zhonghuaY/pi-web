import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { serializeByKey } from "@/lib/key-serializer";

type MutationKind = "create" | "prompt" | "handoff-create" | "handoff-prompt";
type MutationIdentity = { kind: MutationKind; requestId: string; scope: string; digest: string };
type MutationRecord = MutationIdentity & { version: 1 } & (
  | { stage: "pending" }
  | { stage: "accepted"; nativeId: string }
  | { stage: "rejected"; code: number }
);
export type CodexMutationResult =
  | { kind: "accepted"; nativeId: string }
  | { kind: "rejected"; code: number }
  | { kind: "outcome-unknown" }
  | { kind: "conflict" };
type DefinitiveResult = Extract<CodexMutationResult, { kind: "accepted" | "rejected" }>;

const QUEUE = Symbol.for("pi-web.codex-mutations");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

function parseRecord(value: unknown, kind: MutationKind, requestId: string): MutationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex mutation record");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== kind || record.requestId !== requestId || typeof record.scope !== "string" || !record.scope
    || typeof record.digest !== "string" || !DIGEST.test(record.digest)) throw new Error("Invalid Codex mutation record");
  const identity = { version: 1 as const, kind, requestId, scope: record.scope, digest: record.digest };
  if (record.stage === "pending") return { ...identity, stage: "pending" };
  if (record.stage === "accepted" && typeof record.nativeId === "string" && record.nativeId.length > 0 && record.nativeId.length <= 512) {
    return { ...identity, stage: "accepted", nativeId: record.nativeId };
  }
  if (record.stage === "rejected" && typeof record.code === "number" && Number.isSafeInteger(record.code)) {
    return { ...identity, stage: "rejected", code: record.code };
  }
  throw new Error("Invalid Codex mutation record");
}

export async function runCodexMutationOnce(
  input: MutationIdentity,
  execute: () => Promise<DefinitiveResult>,
  beforeSettlement?: () => void,
): Promise<CodexMutationResult> {
  if (!["create", "prompt", "handoff-create", "handoff-prompt"].includes(input.kind) || !UUID.test(input.requestId) || !input.scope || !DIGEST.test(input.digest)) throw new Error("Invalid Codex mutation identity");
  const requestId = input.requestId.toLowerCase();
  const identity = { ...input, version: 1 as const, requestId };
  const directory = join(getAgentDir(), "pi-web-codex-mutations", input.kind, requestId);
  return serializeByKey(QUEUE, directory, async () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, { realpath: false, stale: 60_000, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } });
    try {
      const path = join(directory, "record.json");
      let text: string | undefined;
      try { text = readFileSync(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (text !== undefined) {
        const record = parseRecord(JSON.parse(text), input.kind, requestId);
        if (record.scope !== input.scope || record.digest !== input.digest) return { kind: "conflict" };
        if (record.stage === "accepted") return { kind: "accepted", nativeId: record.nativeId };
        if (record.stage === "rejected") return { kind: "rejected", code: record.code };
        return { kind: "outcome-unknown" };
      }
      const save = (record: MutationRecord) => writePrivateFileAtomicSync(path, JSON.stringify(parseRecord(record, input.kind, requestId)));
      save({ ...identity, stage: "pending" });
      try {
        const result = await execute();
        beforeSettlement?.();
        save(result.kind === "accepted"
          ? { ...identity, stage: "accepted", nativeId: result.nativeId }
          : { ...identity, stage: "rejected", code: result.code });
        return result;
      } catch {
        return { kind: "outcome-unknown" };
      }
    } finally { await release(); }
  });
}
