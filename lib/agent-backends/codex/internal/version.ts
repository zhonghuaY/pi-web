import { SUPPORTED_CODEX_CLI_VERSION } from "./protocol";

export type VersionInspection =
  | { state: "supported"; version: string }
  | { state: "unsupported"; version: string }
  | { state: "invalid" };

const SUPPORTED_CODEX_SCHEMA_SHA256 = "b95bc0b2b6ee03287b9bfdcaa4a2c3a9b0ebe590bab0f98ddf98c265f618f91e";

export type SchemaInspection =
  | { state: "supported" }
  | { state: "unsupported"; reason: "version" | "schema" };

export function inspectCodexSchema(version: VersionInspection, schemaVersion: unknown, schemaDigest: string | undefined): SchemaInspection {
  if (version.state !== "supported" || version.version !== SUPPORTED_CODEX_CLI_VERSION) return { state: "unsupported", reason: "version" };
  if (schemaDigest !== SUPPORTED_CODEX_SCHEMA_SHA256 || schemaVersion !== SUPPORTED_CODEX_CLI_VERSION) return { state: "unsupported", reason: "schema" };
  return { state: "supported" };
}

export function inspectCodexVersion(output: string): VersionInspection {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/.exec(output);
  if (!match) return { state: "invalid" };
  const version = match[1];
  return version === SUPPORTED_CODEX_CLI_VERSION ? { state: "supported", version } : { state: "unsupported", version };
}
