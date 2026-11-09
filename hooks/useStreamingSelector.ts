"use client";

import { useLayoutEffect, useState } from "react";
import type { StreamingState, StreamingStore } from "@/lib/streaming-message";

/**
 * One value of the streaming store; the component re-renders only when that
 * value changes. Keep `select` stable with a module-level function or useCallback.
 *
 * A plain state update rather than useSyncExternalStore: that one renders every
 * chunk on its own, while state updates let React batch the chunks that land
 * before it renders, and each render parses the reply's last block again.
 */
export function useStreamingSelector<T>(store: StreamingStore, select: (state: StreamingState) => T, key?: string): T {
  const [value, setValue] = useState(() => select(store.getState()));
  useLayoutEffect(() => {
    const update = () => setValue(select(store.getState()));
    update();
    return key === undefined ? store.subscribe(update) : store.subscribeKey(key, update);
  }, [store, select, key]);
  return value;
}

export const selectIsStreaming = (state: StreamingState) => state.isStreaming;
export const selectHasStreamingContent = (state: StreamingState) => [...state.streams.values()].some(message => message.content.length > 0);
export const selectStreamingKeys = (state: StreamingState) => state.order;
