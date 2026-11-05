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
