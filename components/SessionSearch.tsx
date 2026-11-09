"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sessionBackend } from "@/lib/agent-backends";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { SessionInfo } from "@/lib/types";
import type { SessionSearchResponse } from "@/lib/session-search";

type SearchResponse = SessionSearchResponse & { backendErrors?: Record<string, string>; pending?: boolean };

function retainFailedResults(response: SearchResponse, previous: SearchResponse | undefined): SearchResponse {
  if (!previous || !response.backendErrors) return response;
  const results = new Map(response.results.map((result) => [result.session.id, result]));
  for (const result of previous.results) {
    const backend = sessionBackend(result.session);
    if (backend && response.backendErrors[backend] && !results.has(result.session.id)) results.set(result.session.id, result);
  }
  return { ...response, results: [...results.values()].sort((a, b) => b.session.modified.localeCompare(a.session.modified)) };
}

function keepSearchOrder(response: SearchResponse, previous: SearchResponse | undefined): SearchResponse {
  if (!previous) return response;
  const remaining = new Map(response.results.map(result => [result.session.id, result]));
  const results: SessionSearchResponse["results"] = [];
  for (const old of previous.results) {
    const fresh = remaining.get(old.session.id);
    if (fresh) results.push(fresh);
    remaining.delete(old.session.id);
  }
  for (const result of remaining.values()) {
    const index = results.findIndex(existing => result.session.modified.localeCompare(existing.session.modified) > 0);
    results.splice(index < 0 ? results.length : index, 0, result);
  }
  return { ...response, results };
}

export function SessionSearch({ open, query, children, selectedSessionId, onSelectSession, archivedSessionIds }: {
  open: boolean;
  query: string;
  children: ReactNode;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  /** Ids of every session in an archived family: their results are tagged, not hidden. */
  archivedSessionIds?: ReadonlySet<string>;
}) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<{ query: string; response?: SearchResponse; loading?: boolean; failed?: boolean }>({ query: "" });
  const resultsByQuery = useRef(new Map<string, SearchResponse>());
  const search = query.trim();
  const response = state.query === search ? state.response : undefined;
  const failed = state.query === search && state.failed;
  const waiting = state.query !== search || state.loading === true || (!response && !failed);
  const backendErrors = Object.values(response?.backendErrors ?? {}).filter(Boolean);

  // Re-runs only when the query changes. It deliberately does not depend on the
  // session-list version: ordinary agent activity bumps that version every few
  // seconds, which used to refetch (and re-order) results while they were being
  // read.
  useEffect(() => {
    if (!open || !search) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    setState({ query: search, response: resultsByQuery.current.get(search), loading: true });
    const collect = async () => {
      try {
        const res = await fetch(`/api/sessions/search?${new URLSearchParams({ q: search })}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as SearchResponse;
        if (!controller.signal.aborted) {
          const previous = resultsByQuery.current.get(search);
          const merged = retainFailedResults(data, previous);
          const ordered = polls > 0 ? keepSearchOrder(merged, previous) : merged;
          resultsByQuery.current.delete(search);
          resultsByQuery.current.set(search, ordered);
          if (resultsByQuery.current.size > 10) {
            const oldest = resultsByQuery.current.keys().next().value;
            if (oldest !== undefined) resultsByQuery.current.delete(oldest);
          }
          setState({ query: search, response: ordered });
          if (data.pending && polls++ < 100) timer = setTimeout(collect, 400);
        }
      } catch {
        if (!controller.signal.aborted) setState({ query: search, response: resultsByQuery.current.get(search), failed: true });
      }
    };
    timer = setTimeout(collect, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search]);

  return !open || !search ? children : (
    <div className="min-h-20 flex-1 overflow-y-auto" aria-busy={waiting}>
      <div role="status" className="px-3 py-2 text-xs text-text-muted">
        {failed ? t("sidebar.sessionSearchFailed") : waiting || !response ? t("sidebar.sessionSearching")
          : response.results.length === 0 ? t(backendErrors.length > 0 ? "sidebar.sessionSearchFailed" : "sidebar.sessionSearchEmpty")
          : t("sidebar.sessionSearchCount", { count: response.results.length })}
      </div>
      {backendErrors.length > 0 && (
        <div role="status" className="px-3 pb-2 text-xs text-text-muted">{backendErrors.join(" · ")}</div>
      )}
      {response?.truncated && (
        <div role="status" className="px-3 pb-2 text-xs text-text-muted">{t("sidebar.sessionSearchPartial")}</div>
      )}
      {response?.results.map(({ session, entryId, blockIndex, titleMatch, before, match, after }) => (
        <button
          key={session.id}
          type="button"
          onClick={() => onSelectSession(session, entryId, blockIndex)}
          aria-current={session.id === selectedSessionId ? "true" : undefined}
          className={`block w-full cursor-pointer border-b border-border px-3 py-2 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent ${session.id === selectedSessionId ? "bg-bg-selected" : ""}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-text">
              {titleMatch ? <>{before}<mark className="rounded-sm bg-accent/20 text-text">{match}</mark>{after}</> : session.name || session.firstMessage}
            </span>
            {archivedSessionIds?.has(session.id) && (
              <span className="shrink-0 rounded-[4px] border border-border px-1 text-[10px] leading-[14px] text-text-dim">{t("sidebar.archived")}</span>
            )}
          </span>
          <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-text-dim">
            <span className="min-w-0 flex-1 truncate" title={session.cwd}>{session.cwd}</span>
            <span className="shrink-0">{formatRelativeTime(session.modified, locale)}</span>
          </span>
          {!titleMatch && (
            <span className="mt-1 block text-xs leading-relaxed wrap-anywhere text-text-muted">
              {before}<mark className="rounded-sm bg-accent/20 text-text">{match}</mark>{after}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
