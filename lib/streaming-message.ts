import type { ClientAssistantMessageEvent } from "./agent-event-wire";
import { normalizeStreamingToolCalls } from "./normalize";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
} from "./types";

export type { ClientAssistantMessageEvent } from "./agent-event-wire";

export const DEFAULT_STREAM_KEY = "";
export interface StreamingState {
  isStreaming: boolean;
  streams: ReadonlyMap<string, AssistantMessage>;
  order: readonly string[];
}

type SingleState = { isStreaming: boolean; streamingMessage: AssistantMessage | null };
export type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "snapshot"; message: AgentMessage; key?: string }
  | { type: "delta"; event: ClientAssistantMessageEvent; key?: string }
  | { type: "close"; key?: string }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streams: new Map(),
  order: [],
};

function updateContentBlock(
  state: SingleState,
  contentIndex: number,
  update: (current: AssistantContentBlock | undefined) => AssistantContentBlock | null,
): SingleState {
  const message = state.streamingMessage;
  if (!message || !Number.isInteger(contentIndex) || contentIndex < 0) return state;

  const content = [...message.content];
  const nextBlock = update(content[contentIndex]);
  if (!nextBlock) return state;
  content[contentIndex] = nextBlock;
  return {
    isStreaming: true,
    streamingMessage: { ...message, content },
  };
}

function applyDelta(
  state: SingleState,
  event: ClientAssistantMessageEvent,
): SingleState {
  switch (event.type) {
    case "text_start":
      // pi-ai documents `partial` as a shared live response-so-far helper, not
      // an event-time snapshot, and blocks as empty at their `*_start` and
      // grown only by `*_delta` until the authoritative `*_end`. By the time
      // this start is consumed the helper may already carry the block's first
      // delta, so a start must reset the block instead of keeping snapshot
      // text: otherwise that chunk renders twice until `text_end` arrives.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "text", text: "" }));
    case "text_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "text"
          ? { ...current, text: current.text + event.delta }
          : null
      ));
    case "text_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "text" ? current : {}),
        type: "text",
        text: event.content,
      }));
    case "thinking_start":
      // Same snapshot leak as text_start: reset, or the first thinking chunk
      // renders twice until `thinking_end` replaces the block.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "thinking", thinking: "" }));
    case "thinking_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "thinking"
          ? { ...current, thinking: current.thinking + event.delta }
          : null
      ));
    case "thinking_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "thinking" ? current : {}),
        type: "thinking",
        thinking: event.content,
      }));
    case "toolcall_start":
      return updateContentBlock(state, event.contentIndex, (current) => {
        if (current?.type === "toolCall") {
          return {
            ...current,
            toolCallId: event.id ?? current.toolCallId,
            toolName: event.toolName ?? current.toolName,
            // Same snapshot leak as text_start: the deltas rebuild rawInput.
            rawInput: "",
          };
        }
        if (typeof event.toolName !== "string") return null;
        return {
          type: "toolCall",
          toolCallId: event.id ?? "",
          toolName: event.toolName,
          input: {},
          rawInput: "",
        };
      });
    case "toolcall_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "toolCall"
          ? {
            ...current,
            toolCallId: event.id || current.toolCallId,
            toolName: event.toolName || current.toolName,
            rawInput: (current.rawInput ?? "") + event.delta,
          }
          : null
      ));
    case "toolcall_end":
      return updateContentBlock(state, event.contentIndex, () => ({
        type: "toolCall",
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        input: event.toolCall.arguments,
      }));
    default:
      return state;
  }
}

export function streamReducer(
  state: StreamingState,
  action: StreamAction,
): StreamingState {
  switch (action.type) {
    case "start":
      return { ...INITIAL_STREAMING_STATE, isStreaming: true };
    case "resume":
      return state.isStreaming ? state : { ...state, isStreaming: true };
    case "snapshot": {
      const message = normalizeStreamingToolCalls(action.message);
      if (message.role !== "assistant") return state;
      const key = action.key ?? DEFAULT_STREAM_KEY;
      const streams = new Map(state.streams);
      const exists = streams.has(key);
      streams.set(key, message);
      return { isStreaming: true, streams, order: exists ? state.order : [...state.order, key] };
    }
    case "delta": {
      const key = action.key ?? DEFAULT_STREAM_KEY;
      const message = state.streams.get(key);
      if (!message) return state;
      const next = applyDelta({ isStreaming: true, streamingMessage: message }, action.event);
      if (next.streamingMessage === message || !next.streamingMessage) return state;
      const streams = new Map(state.streams);
      streams.set(key, next.streamingMessage);
      return { ...state, streams };
    }
    case "close": {
      const key = action.key ?? DEFAULT_STREAM_KEY;
      if (!state.streams.has(key)) return state;
      const streams = new Map(state.streams);
      streams.delete(key);
      const order = state.order.filter(id => id !== key);
      return order.length ? { isStreaming: true, streams, order } : INITIAL_STREAMING_STATE;
    }
    case "end":
      return state === INITIAL_STREAMING_STATE ? state : INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}

/**
 * The streaming state outside React: a chunk re-renders only the components
 * that subscribe to the part of it they show, not everything around the reply.
 * Listeners run synchronously in `dispatch`, so their state updates batch with
 * the ones the same event makes (message_end appends the reply and ends the
 * stream in one render).
 */
export interface StreamingStore {
  getState(): StreamingState;
  dispatch(action: StreamAction): void;
  subscribe(listener: () => void): () => void;
  subscribeKey(key: string, listener: () => void): () => void;
}

export function createStreamingStore(): StreamingStore {
  let state = INITIAL_STREAMING_STATE;
  const listeners = new Set<() => void>();
  const keyed = new Map<string, Set<() => void>>();
  const hasContent = (value: StreamingState) => [...value.streams.values()].some(message => message.content.length > 0);
  return {
    getState: () => state,
    dispatch(action) {
      const previous = state;
      const next = streamReducer(previous, action);
      if (next === previous) return;
      state = next;
      if (next.isStreaming !== previous.isStreaming || next.order !== previous.order || hasContent(next) !== hasContent(previous)) for (const listener of listeners) listener();
      for (const [key, subscribers] of keyed) if (next.streams.get(key) !== previous.streams.get(key)) for (const listener of subscribers) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeKey(key, listener) {
      const subscribers = keyed.get(key) ?? new Set();
      subscribers.add(listener);
      keyed.set(key, subscribers);
      return () => { subscribers.delete(listener); if (!subscribers.size) keyed.delete(key); };
    },
  };
}
