export const CODEX_PROTOCOL_VERSION = "v2";
export const SUPPORTED_CODEX_CLI_VERSION = "0.153.4";

export const ClientMethod = {
  initialize: "initialize", initialized: "initialized", accountRead: "account/read",
  modelList: "model/list", skillsList: "skills/list", mcpStatusList: "mcpServerStatus/list",
  threadStart: "thread/start", threadResume: "thread/resume", threadRead: "thread/read",
  threadList: "thread/list", threadFork: "thread/fork", threadCompact: "thread/compact/start",
  threadSettingsUpdate: "thread/settings/update",
  threadTurnsList: "thread/turns/list", threadItemsList: "thread/items/list",
  turnStart: "turn/start", turnSteer: "turn/steer", turnInterrupt: "turn/interrupt",
} as const;

export const ServerRequestMethod = {
  commandApproval: "item/commandExecution/requestApproval", fileApproval: "item/fileChange/requestApproval",
  userInput: "item/tool/requestUserInput", permissions: "item/permissions/requestApproval",
  elicitation: "mcpServer/elicitation/request", toolCall: "item/tool/call",
  tokenRefresh: "account/chatgptAuthTokens/refresh", attestation: "attestation/generate",
  applyPatchApproval: "applyPatchApproval", execCommandApproval: "execCommandApproval",
} as const;

export const NotificationMethod = {
  itemStarted: "item/started", itemCompleted: "item/completed", turnStarted: "turn/started",
  turnCompleted: "turn/completed", agentMessageDelta: "item/agentMessage/delta",
  reasoningTextDelta: "item/reasoning/textDelta", reasoningSummaryDelta: "item/reasoning/summaryTextDelta",
  serverRequestResolved: "serverRequest/resolved", threadSettingsUpdated: "thread/settings/updated",
} as const;

export type RpcId = string | number;
export type RpcRequest = { id: RpcId; method: string; params?: unknown };
export type RpcNotification = { method: string; params?: unknown };
export type RpcError = { code: number; message: string; data?: unknown };
export type RpcResponse = { id: RpcId; result: unknown; error?: never } | { id: RpcId; error: RpcError; result?: never };
export type RpcEnvelope = RpcRequest | RpcNotification | RpcResponse;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
export function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  if (!record(value) || (has(value, "jsonrpc") && value.jsonrpc !== "2.0")) return false;
  if (has(value, "method")) {
    return typeof value.method === "string" && value.method.length > 0 &&
      (!has(value, "id") || isRpcId(value.id)) && !has(value, "result") && !has(value, "error");
  }
  if (!isRpcId(value.id) || has(value, "params") || has(value, "result") === has(value, "error")) return false;
  return !has(value, "error") || (record(value.error) && Number.isInteger(value.error.code) && typeof value.error.message === "string");
}
export function isRpcRequest(value: RpcEnvelope): value is RpcRequest { return "method" in value && "id" in value; }
export function isRpcNotification(value: RpcEnvelope): value is RpcNotification { return "method" in value && !("id" in value); }
export function isInitializeResponse(value: unknown): value is { userAgent: string; codexHome: string; platformFamily: string; platformOs: string } {
  return record(value) && typeof value.userAgent === "string" && typeof value.codexHome === "string" && typeof value.platformFamily === "string" && typeof value.platformOs === "string";
}
