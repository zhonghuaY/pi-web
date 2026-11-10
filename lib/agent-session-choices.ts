export interface PiModelChoice { provider: string; modelId: string }
export interface PiModelOption { provider: string; id: string }

export function validatePiSessionChoices<TThinking extends string>(
  model: PiModelChoice | null,
  thinking: TThinking | null,
  models: readonly PiModelOption[],
  thinkingLevels: Readonly<Record<string, readonly string[]>>,
  defaultModel: PiModelChoice | null = null,
): { model: PiModelChoice | null; thinking: TThinking | null } {
  const modelIsAvailable = !model || models.length === 0
    || models.some((option) => option.provider === model.provider && option.id === model.modelId);
  const nextModel = modelIsAvailable ? model : null;
  const thinkingModel = nextModel ?? defaultModel;
  if (!thinkingModel) return { model: nextModel, thinking };
  const allowedThinking = thinkingLevels[`${thinkingModel.provider}:${thinkingModel.modelId}`];
  return {
    model: nextModel,
    thinking: thinking && allowedThinking && !allowedThinking.includes(thinking) ? null : thinking,
  };
}

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];
export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return CLAUDE_EFFORTS.some(effort => effort === value);
}
export type CodexSelection = { model: string; effort: string };
export type NewSessionChoices =
  | { backend: "pi"; model: PiModelChoice | null; thinkingLevel: PiThinkingLevel | null }
  | { backend: "claude"; modelId: string | null; effort: ClaudeEffort | null }
  | { backend: "codex"; selection: CodexSelection | null };
export type ReasoningChoice =
  | { backend: "pi"; level: PiThinkingLevel | "auto" }
  | { backend: "claude"; effort: ClaudeEffort | null }
  | ({ backend: "codex" } & CodexSelection);
export interface CodexModelChoice {
  id: string;
  model: string;
  label: string;
  isDefault: boolean;
  efforts: readonly { value: string; description: string }[];
  defaultEffort: string;
}
export interface CodexEffectiveSettings {
  backend: "codex";
  model: string;
  modelProvider: string;
  effort: string | null;
}
export interface ReasoningRow {
  key: string;
  choice: ReasoningChoice;
  label: string;
  originalLabel?: string;
  description: string;
  selected: boolean;
  star?: { isDefault: boolean; saveLabel: string; defaultLabel: string; onSave(): void };
}
export interface ReasoningControl {
  label: string;
  rows: readonly ReasoningRow[];
  disabled: boolean;
  busy: boolean;
  onChange(choice: ReasoningChoice): void;
}

export function codexSelectionForModel(model: CodexModelChoice, effort: string | null): CodexSelection {
  return { model: model.model, effort: effort && model.efforts.some(row => row.value === effort) ? effort : model.defaultEffort };
}

export function parseCodexSettings(value: unknown): CodexEffectiveSettings | null {
  if (!value || typeof value !== "object" || !("backend" in value) || value.backend !== "codex"
    || !("model" in value) || typeof value.model !== "string" || !value.model
    || !("modelProvider" in value) || typeof value.modelProvider !== "string" || !value.modelProvider
    || !("effort" in value) || (value.effort !== null && (typeof value.effort !== "string" || !value.effort))) return null;
  return { backend: "codex", model: value.model, modelProvider: value.modelProvider, effort: value.effort };
}

export function parseCodexModels(value: unknown): CodexModelChoice[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Codex catalogue is unavailable");
  const ids = new Set<string>(), models = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object"
      || !("id" in entry) || typeof entry.id !== "string" || !entry.id
      || !("model" in entry) || typeof entry.model !== "string" || !entry.model
      || !("label" in entry) || typeof entry.label !== "string" || !entry.label
      || !("isDefault" in entry) || typeof entry.isDefault !== "boolean"
      || !("defaultEffort" in entry) || typeof entry.defaultEffort !== "string" || !entry.defaultEffort
      || !("efforts" in entry) || !Array.isArray(entry.efforts) || !entry.efforts.length
      || ids.has(entry.id) || models.has(entry.model)) throw new Error("Invalid Codex catalogue");
    ids.add(entry.id); models.add(entry.model);
    const values = new Set<string>();
    const efforts = entry.efforts.map((row: unknown) => {
      if (!row || typeof row !== "object" || !("value" in row) || typeof row.value !== "string" || !row.value
        || !("description" in row) || typeof row.description !== "string" || values.has(row.value)) throw new Error("Invalid Codex efforts");
      values.add(row.value);
      return { value: row.value, description: row.description };
    });
    if (!values.has(entry.defaultEffort)) throw new Error("Invalid Codex default effort");
    return { id: entry.id, model: entry.model, label: entry.label, isDefault: entry.isDefault, defaultEffort: entry.defaultEffort, efforts };
  });
}
