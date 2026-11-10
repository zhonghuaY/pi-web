import type { CodexThread } from "./catalogue";

type NativeItem = CodexThread["turns"][number]["items"][number];
type NativeUserInput = { type: string; text?: string; text_elements?: unknown[] };

function userInputs(item: NativeItem): NativeUserInput[] | null {
  return item.type === "userMessage" && Array.isArray(item.content)
    ? item.content as NativeUserInput[]
    : null;
}

export function codexUserText(item: NativeItem): string | null {
  const inputs = userInputs(item);
  if (!inputs) return null;
  return inputs.flatMap((input) => input.type === "text" && typeof input.text === "string" ? [input.text] : []).join("\n");
}

export function codexUserEnvelopeEquals(item: NativeItem, expected: string): boolean {
  const inputs = userInputs(item);
  if (inputs?.length !== 1) return false;
  const input = inputs[0];
  return input.type === "text" && input.text === expected
    && (input.text_elements === undefined || (Array.isArray(input.text_elements) && input.text_elements.length === 0))
    && Object.keys(input).every(key => key === "type" || key === "text" || key === "text_elements");
}

export function firstCodexUserText(thread: CodexThread): string | null {
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const text = codexUserText(item);
      if (text !== null) return text;
    }
  }
  return null;
}

export function codexThreadHasUserEnvelope(thread: CodexThread, expected: string): boolean {
  return thread.turns.some((turn) => turn.items.some((item) => codexUserEnvelopeEquals(item, expected)));
}
