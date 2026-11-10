import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv, { type ValidateFunction } from "ajv";
import { inspectCodexSchema, type VersionInspection } from "./version";

type Item = Record<string, unknown> & { type: string; id: string };
type Turn = { id: string; items: Item[]; status: "completed" | "interrupted" | "failed" | "inProgress" };
type Thread = {
  id: string; sessionId: string; preview: string; ephemeral: boolean; projectId: string | null;
  modelProvider: string; createdAt: number; updatedAt: number; cwd: string; cliVersion: string;
  source: unknown; status: unknown; turns: Turn[];
  name?: string | null; path?: string | null; model?: string | null; parentThreadId?: string | null;
};
type TurnEvent = { threadId: string; turn: Turn };
type ItemEvent = { threadId: string; turnId: string; item: Item };
type DeltaEvent = { threadId: string; turnId: string; itemId: string; delta: string };
type Interaction = { threadId: string; turnId: string; itemId: string };
type Account = { type: "apiKey" } | { type: "amazonBedrock"; usesCodexManagedCredentials?: boolean } |
  { type: "chatgpt"; email: string | null; planType: string };
type Question = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] | null };
type ProtocolRecord = Record<string, unknown>;
// Native model catalogs advertise nonempty effort strings, including max and ultra.
type ReasoningEffort = string;
type ThreadResponse = ProtocolRecord & {
  thread: Thread; model: string; modelProvider: string; cwd: string;
  reasoningEffort?: ReasoningEffort | null;
};
type ThreadSettings = ProtocolRecord & {
  model: string; modelProvider: string; cwd: string; effort?: ReasoningEffort | null;
};
type Model = ProtocolRecord & {
  id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean;
  supportedReasoningEfforts: (ProtocolRecord & { reasoningEffort: ReasoningEffort; description: string })[];
  defaultReasoningEffort: ReasoningEffort;
};
type Skill = ProtocolRecord & {
  name: string; description: string; enabled: boolean; path: string; scope: "user" | "repo" | "system" | "admin";
  shortDescription?: string | null; pluginId?: string | null;
  interface?: (ProtocolRecord & { displayName?: string | null; shortDescription?: string | null }) | null;
  dependencies?: ProtocolRecord | null;
};
type McpTool = ProtocolRecord & { name: string; inputSchema: unknown; description?: string | null; title?: string | null };
type McpResource = ProtocolRecord & { name: string; uri: string; description?: string | null; mimeType?: string | null };
type McpResourceTemplate = ProtocolRecord & { name: string; uriTemplate: string; description?: string | null; mimeType?: string | null };
type McpServerStatus = ProtocolRecord & {
  name: string; authStatus: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  tools: Record<string, McpTool>; resources: McpResource[]; resourceTemplates: McpResourceTemplate[];
  pluginId?: string | null;
  runtimeStatus?: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | null;
  serverInfo?: (ProtocolRecord & { name: string; version: string; description?: string | null; title?: string | null; websiteUrl?: string | null }) | null;
};

// The JSON Schema permits omitted nullable fields that the CLI's generated TypeScript requires.
export type CodexPayloads = {
  "thread/list": { data: Thread[]; nextCursor?: string | null; backwardsCursor?: string | null };
  "thread/read": { thread: Thread };
  "account/read": { account?: Account | null; requiresOpenaiAuth: boolean };
  "model/list:request": ProtocolRecord & { cursor?: string | null; includeHidden?: boolean | null; limit?: number | null };
  "model/list:response": ProtocolRecord & { data: Model[]; nextCursor?: string | null };
  "thread/settings/update:request": ProtocolRecord & { threadId: string; model?: string | null; cwd?: string | null; effort?: ReasoningEffort | null };
  "thread/settings/update:response": ProtocolRecord;
  "thread/settings/updated": ProtocolRecord & { threadId: string; threadSettings: ThreadSettings };
  "skills/list:request": ProtocolRecord & { cwds?: string[]; forceReload?: boolean };
  "skills/list:response": ProtocolRecord & { data: (ProtocolRecord & { cwd: string; errors: (ProtocolRecord & { path: string; message: string })[]; skills: Skill[] })[] };
  "mcpServerStatus/list:request": ProtocolRecord & { cursor?: string | null; limit?: number | null; threadId?: string | null; detail?: "full" | "toolsAndAuthOnly" | null };
  "mcpServerStatus/list:response": ProtocolRecord & { data: McpServerStatus[]; nextCursor?: string | null };
  "thread/fork:request": ProtocolRecord & { threadId: string; model?: string | null; modelProvider?: string | null; cwd?: string | null; excludeTurns?: boolean };
  "thread/fork:response": ThreadResponse;
  "thread/compact/start:request": ProtocolRecord & { threadId: string };
  "thread/compact/start:response": ProtocolRecord;
  "thread/start:request": Record<string, unknown>;
  "thread/start:response": ThreadResponse;
  "thread/resume:request": { threadId: string };
  "thread/resume:response": ThreadResponse;
  "turn/start:request": { threadId: string; input: unknown[]; clientUserMessageId?: string | null };
  "turn/start:response": { turn: Turn };
  "turn/steer:request": { threadId: string; expectedTurnId: string; input: unknown[]; clientUserMessageId?: string | null };
  "turn/steer:response": { turnId: string };
  "turn/interrupt:request": { threadId: string; turnId: string };
  "turn/interrupt:response": Record<string, unknown>;
  "item/commandExecution/requestApproval:response": { decision: unknown };
  "item/fileChange/requestApproval:response": { decision: unknown };
  "item/tool/requestUserInput:response": { answers: Record<string, unknown> };
  "thread/tokenUsage/updated": { threadId: string; turnId: string; tokenUsage: unknown };
  "thread/started": { thread: Thread };
  "remoteControl/status/changed": Record<string, unknown>;
  "error": { threadId: string; turnId: string; error: unknown; willRetry: boolean };
  "turn/started": TurnEvent;
  "turn/completed": TurnEvent;
  "item/started": ItemEvent & { startedAtMs: number };
  "item/completed": ItemEvent & { completedAtMs: number };
  "item/agentMessage/delta": DeltaEvent;
  "item/reasoning/textDelta": DeltaEvent & { contentIndex: number };
  "item/reasoning/summaryTextDelta": DeltaEvent & { summaryIndex: number };
  "serverRequest/resolved": { threadId: string; requestId: string | number };
  "item/commandExecution/requestApproval": Interaction & { startedAtMs: number; command?: string | null; cwd?: string | null; reason?: string | null };
  "item/fileChange/requestApproval": Interaction & { startedAtMs: number; reason?: string | null; grantRoot?: string | null };
  "item/permissions/requestApproval": Interaction & { startedAtMs: number; cwd: string; permissions: unknown };
  "item/tool/requestUserInput": Interaction & { isBlocking: boolean; questions: Question[] };
  "mcpServer/elicitation/request": { threadId: string; serverName: string; turnId?: string | null };
  "execCommandApproval": { callId: string; conversationId: string; command: string[]; cwd: string; parsedCmd: unknown[] };
  "applyPatchApproval": { callId: string; conversationId: string; fileChanges: unknown };
};

export type CodexPayloadMethod = keyof CodexPayloads;
export type PayloadResult<K extends CodexPayloadMethod> =
  | { state: "valid"; value: CodexPayloads[K] }
  | { state: "invalid" };
export type PayloadValidators = { validate<K extends CodexPayloadMethod>(method: K, value: unknown): PayloadResult<K> };
export type PayloadValidatorInspection =
  | { state: "supported"; validators: PayloadValidators }
  | { state: "unsupported"; reason: "version" | "schema" };

const methods: readonly CodexPayloadMethod[] = [
  "model/list:request", "model/list:response", "thread/settings/update:request", "thread/settings/update:response",
  "thread/settings/updated", "skills/list:request", "skills/list:response", "mcpServerStatus/list:request", "mcpServerStatus/list:response",
  "thread/fork:request", "thread/fork:response", "thread/compact/start:request", "thread/compact/start:response",
  "thread/list", "thread/read", "account/read", "thread/start:request", "thread/start:response",
  "thread/resume:request", "thread/resume:response", "turn/start:request", "turn/start:response",
  "turn/steer:request", "turn/steer:response", "turn/interrupt:request", "turn/interrupt:response",
  "item/commandExecution/requestApproval:response", "item/fileChange/requestApproval:response",
  "item/tool/requestUserInput:response", "thread/tokenUsage/updated", "thread/started", "remoteControl/status/changed", "error",
  "turn/started", "turn/completed", "item/started", "item/completed",
  "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "serverRequest/resolved",
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request", "execCommandApproval", "applyPatchApproval",
];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function loadPinnedSchemas(): unknown {
  const load = createRequire(import.meta.url);
  try { return load("./schemas.json"); } catch { return undefined; }
}

function compileSchemas(bundle: unknown): { version: unknown; digest: string; validators: Map<CodexPayloadMethod, ValidateFunction> } | undefined {
  if (!record(bundle) || !record(bundle.schemas)) return undefined;
  const ajv = new Ajv({ strict: true, allowUnionTypes: true });
  for (const format of ["uint", "uint16", "uint32", "uint64", "int32", "int64", "double"]) ajv.addFormat(format, true);
  const validators = new Map<CodexPayloadMethod, ValidateFunction>();
  try {
    for (const method of methods) {
      const schema = bundle.schemas[method];
      if (!record(schema)) return undefined;
      validators.set(method, ajv.compile(schema));
    }
  } catch { return undefined; }
  return { version: bundle.version, digest: createHash("sha256").update(`${JSON.stringify(bundle)}\n`).digest("hex"), validators };
}

const pinned = compileSchemas(loadPinnedSchemas());

export function codexPayloadValidators(version: VersionInspection): PayloadValidatorInspection {
  const inspection = inspectCodexSchema(version, pinned?.version, pinned?.digest);
  if (inspection.state !== "supported") return inspection;
  if (!pinned) return { state: "unsupported", reason: "schema" };
  const validators = pinned.validators;
  return {
    state: "supported",
    validators: {
      validate<K extends CodexPayloadMethod>(method: K, value: unknown): PayloadResult<K> {
        const validate = validators.get(method);
        return validate?.(value) ? { state: "valid", value: value as CodexPayloads[K] } : { state: "invalid" };
      },
    },
  };
}
