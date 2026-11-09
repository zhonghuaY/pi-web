import { capabilityNames, type BackendDescriptor, type Capability } from "@/lib/session-identity";
import { codexPayloadValidators } from "./internal/payloads";
import { codexEnvironment, inspectInstalledCodex } from "./internal/transport";

export function codexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_WEB_CODEX !== "0" && env.PI_WEB_CODEX !== "false";
}

export async function describeCodex(options: { binary?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<BackendDescriptor> {
  let reason = "disabled";
  if (codexEnabled(options.env)) {
    try {
      const version = await inspectInstalledCodex(options.binary, codexEnvironment(options.env), options.cwd);
      reason = codexPayloadValidators(version).state === "supported" ? "" : "unsupported-version";
    } catch {
      reason = "not-installed";
    }
  }
  const available = reason === "";
  const supported = new Set<Capability>(["history", "prompt", "stop", "steer", "questions", "models", "setModel", "effort", "skills", "mcp", "fork", "compact"]);
  const capabilities = Object.fromEntries(capabilityNames.map((name) => [name, available && supported.has(name)])) as Record<Capability, boolean>;
  return {
    id: "codex",
    label: "Codex",
    availability: available ? { state: "available" } : { state: "unavailable", reason },
    capabilities,
    trust: "unknown",
  };
}
