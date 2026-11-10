// Readonly, backend-scoped metadata. Paths and resource references confer no file access.
export type CodexSkillsInventory = {
  backend: "codex";
  cwd: string;
  skills: {
    name: string; description: string; path: string; enabled: boolean;
    scope: "user" | "repo" | "system" | "admin";
    shortDescription: string | null; pluginId: string | null; displayName: string | null;
  }[];
  diagnostics: { path: string; message: string }[];
};

export type CodexMcpInventory = {
  backend: "codex";
  sessionId: string;
  servers: {
    name: string;
    status: "absent" | "starting" | "connected" | "auth-required" | "failed" | "unknown";
    runtimeStatus: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | null;
    authStatus: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
    pluginId: string | null;
    tools: { name: string; title: string | null; description: string | null }[];
    resources: { name: string; description: string | null; mimeType: string | null }[];
    resourceTemplates: { name: string; description: string | null; mimeType: string | null }[];
  }[];
};
