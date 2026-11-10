import { realpath } from "node:fs/promises";
import type { CodexEffectiveSettings } from "@/lib/agent-session-choices";
import { codexWebSessionId } from "./identity";
import { codexPayloadValidators } from "./internal/payloads";
import { AUTONOMOUS_THREAD_PARAMS, SUPPORTED_CODEX_CLI_VERSION } from "./internal/protocol";
import { CodexTransportError, startCodexTransport } from "./internal/transport";

const inspection = codexPayloadValidators({ state: "supported", version: SUPPORTED_CODEX_CLI_VERSION });
if (inspection.state !== "supported") throw new Error("Codex schema unavailable");
const validators = inspection.validators;

// The actor reserves its source admission. This temporary process owns only the
// new fork; native thread/fork must never replace the live source's loaded thread.
export async function forkCodexThread(input: { threadId: string; cwd: string; settings: CodexEffectiveSettings; onSent: () => void; options: Parameters<typeof startCodexTransport>[0] }) {
  const transport = await startCodexTransport({ ...input.options, cwd: input.cwd, shutdownTimeoutMs: 500 });
  try {
    const params = { threadId: input.threadId, cwd: input.cwd, ...AUTONOMOUS_THREAD_PARAMS, model: input.settings.model, modelProvider: input.settings.modelProvider,
      ...(input.settings.effort === null ? {} : { config: { model_reasoning_effort: input.settings.effort } }) };
    if (validators.validate("thread/fork:request", params).state !== "valid") throw new CodexTransportError("protocol");
    input.onSent();
    const response = validators.validate("thread/fork:response", await transport.request("thread/fork", params));
    if (response.state !== "valid") throw new CodexTransportError("protocol");
    const value = response.value;
    codexWebSessionId(value.thread.id);
    if (value.thread.id.toLowerCase() === input.threadId.toLowerCase() || await realpath(value.thread.cwd) !== await realpath(input.cwd) || value.model !== input.settings.model || value.modelProvider !== input.settings.modelProvider || (value.reasoningEffort ?? null) !== input.settings.effort) throw new CodexTransportError("protocol");
    return value.thread;
  } finally { await transport.shutdown(); }
}
