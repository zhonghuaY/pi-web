"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { MessageView } from "./MessageView";

interface Transcript { messages: AgentMessage[]; entryIds: string[] }

export function ClaudeSubagentHistory({ sessionId, cwd, onOpenFile }: {
  sessionId: string;
  cwd?: string;
  onOpenFile?: (path: string, page?: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string }> | null>(null);
  const [selected, setSelected] = useState("");
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [transcriptFailed, setTranscriptFailed] = useState(false);
  const failed = listFailed || transcriptFailed;
  const endpoint = "/api/sessions/" + encodeURIComponent(sessionId) + "/subagents";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error("Subagent list unavailable");
        const data: { agents: Array<{ id: string }> } = await response.json();
        if (!controller.signal.aborted) { setAgents(data.agents); setListFailed(false); }
      } catch { if (!controller.signal.aborted) setListFailed(true); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [open, endpoint]);

  useEffect(() => {
    if (!open || !selected) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(endpoint + "?agentId=" + encodeURIComponent(selected), { signal: controller.signal });
        if (!response.ok) throw new Error("Subagent transcript unavailable");
        const data: Transcript = await response.json();
        if (!controller.signal.aborted) { setTranscript(data); setTranscriptFailed(false); }
      } catch { if (!controller.signal.aborted) setTranscriptFailed(true); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [open, selected, endpoint]);

  const toolResults = useMemo(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const message of transcript?.messages ?? []) if (message.role === "toolResult") results.set(message.toolCallId, message);
    return results;
  }, [transcript]);

  return (
    <details className="mx-3 my-2 rounded border border-[var(--border)] p-2 text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[var(--text-muted)]">{t("claudeSubagents.title")}</summary>
      {open && <div className="mt-2 space-y-2">
        <p className="text-xs text-[var(--text-muted)]">{t("claudeSubagents.readonly")}</p>
        {failed && <p role="alert">{t("claudeSubagents.error")}</p>}
        {!agents && !failed && <p>{t("claudeSubagents.loading")}</p>}
        {agents?.length === 0 && <p>{t("claudeSubagents.empty")}</p>}
        {Boolean(agents?.length) && <select aria-label={t("claudeSubagents.select")} value={selected}
          className="max-w-full rounded border border-[var(--border)] bg-[var(--bg-panel)] p-1"
          onChange={(event) => { setSelected(event.target.value); setTranscript(null); setTranscriptFailed(false); }}>
          <option value="">{t("claudeSubagents.select")}</option>
          {agents?.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
        </select>}
        {selected && !transcript && !failed && <p>{t("claudeSubagents.loading")}</p>}
        {transcript && <div className="max-h-[60vh] space-y-3 overflow-auto">
          {transcript.messages.map((message, index) => <MessageView key={(transcript.entryIds[index] ?? "message") + ":" + index}
            message={message} toolResults={toolResults} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} />)}
        </div>}
      </div>}
    </details>
  );
}
