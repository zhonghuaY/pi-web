"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentInteractionAnswer, PendingAgentInteraction } from "@/lib/agent-backends";

export function AgentInteractionDialog({ request, waitingCount, onRespond }: {
  request: PendingAgentInteraction;
  waitingCount: number;
  onRespond: (id: string, answer: AgentInteractionAnswer) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  const questions = request.questions ?? [];
  const submitQuestions = () => {
    const answers: Record<string, string> = {};
    for (const question of questions) {
      answers[question.question] = [...(selected[question.question] ?? []), ...(written[question.question]?.trim() ? [written[question.question].trim()] : [])].join(", ");
    }
    onRespond(request.id, { answers });
  };
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={request.title}>
      <div className="max-h-[min(80vh,680px)] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-bg-panel p-5 shadow-2xl">
        <div className="mb-1 text-base font-semibold text-text">{request.title}</div>
        {request.toolName && <div className="mb-3 font-mono text-xs text-text-muted">{request.toolName}</div>}
        {waitingCount > 0 && <div className="mb-3 text-xs text-text-muted">{t("claudeInteraction.waiting", { count: waitingCount })}</div>}
        {request.kind === "permission" ? (
          <>
            {request.input !== undefined && <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg px-3 py-2 text-xs text-text-muted">{typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)}</pre>}
            {request.approvalOptions && !request.approvalOptions.accept && <p className="mt-3 text-sm text-text-muted">{t("claudeInteraction.unsupportedApproval")}</p>}
            <div className="mt-4 flex justify-end gap-2">
              {request.approvalOptions && <button type="button" disabled={request.submitting} onClick={() => onRespond(request.id, { cancelled: true })} className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted disabled:opacity-50">{t("i18n.cancel")}</button>}
              {request.approvalOptions?.decline !== false && <button type="button" disabled={request.submitting} onClick={() => onRespond(request.id, { approved: false })} className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted disabled:opacity-50">{t("claudeInteraction.deny")}</button>}
              {request.approvalOptions?.accept !== false && <button type="button" disabled={request.submitting} onClick={() => onRespond(request.id, { approved: true })} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{t("claudeInteraction.allow")}</button>}
            </div>
          </>
        ) : (
          <>
            <div className="space-y-5 py-3">
              {questions.map((question) => (
                <fieldset key={question.question} disabled={request.submitting} className="space-y-2">
                  <legend className="text-sm font-medium text-text">{question.header ? question.header + ": " : ""}{question.question}</legend>
                  {question.options.map((option) => {
                    const values = selected[question.question] ?? [];
                    const checked = values.includes(option.label);
                    return <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-hover">
                      <input type={question.multiSelect ? "checkbox" : "radio"} name={question.question} checked={checked} onChange={() => setSelected((current) => ({ ...current, [question.question]: question.multiSelect ? (checked ? values.filter((value) => value !== option.label) : [...values, option.label]) : [option.label] }))} />
                      <span><span className="block text-sm text-text">{option.label}</span>{option.description && <span className="block text-xs text-text-muted">{option.description}</span>}</span>
                    </label>;
                  })}
                  <input type={question.isSecret ? "password" : "text"} value={written[question.question] ?? ""} onChange={(event) => setWritten((current) => ({ ...current, [question.question]: event.target.value }))} placeholder={t("claudeInteraction.otherAnswer")} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                </fieldset>
              ))}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={request.submitting} onClick={() => onRespond(request.id, { cancelled: true })} className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted disabled:opacity-50">{t("i18n.cancel")}</button>
              <button type="button" disabled={request.submitting} onClick={submitQuestions} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{request.submitting ? t("claudeInteraction.sending") : t("claudeInteraction.submit")}</button>
            </div>
          </>
        )}
        {request.error && <div role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">{request.error} · {t("claudeInteraction.retryHint")}</div>}
      </div>
    </div>
  );
}

export function ClaudeProjectTrustDialog({ cwd, existingSession, onConfirm, onCancel }: { cwd: string; existingSession: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  return <div className="absolute inset-0 z-[55] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={t("claudeTrust.title")}>
    <div className="w-full max-w-md rounded-xl border border-border bg-bg-panel p-5 shadow-2xl">
      <div className="text-base font-semibold text-text">{t("claudeTrust.title")}</div>
      <p className="mt-2 text-sm leading-6 text-text-muted">{t("claudeTrust.description")}</p>
      <div className="mt-3 break-all rounded-lg bg-bg px-3 py-2 font-mono text-xs text-text-muted">{cwd}</div>
      <p className="mt-3 text-xs leading-5 text-text-muted">{t("claudeTrust.resources")}</p>
      {existingSession && <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700">{t("claudeTrust.serialHandoff")}</p>}
      {existingSession && <p className="mt-2 text-xs leading-5 text-text-muted">{t("claudeTrust.forkAlternative")}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted">{t("i18n.cancel")}</button>
        <button type="button" onClick={onConfirm} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">{t("claudeTrust.confirm")}</button>
      </div>
    </div>
  </div>;
}
