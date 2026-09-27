"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { describeCron } from "@/lib/cron";
import {
  formatRunDuration,
  runScrollTargetId,
  sortRunsNewestFirst,
} from "@/lib/routine-activity";
import type { RoutineRun, RoutineTrigger, RoutineWithStatus } from "@/lib/routine-types";

interface Props {
  routineId: string;
  /** Open the RoutinesConfig editor for this routine. */
  onEdit: (id: string) => void;
  /** Open a run's transcript by its session id (reuses the session-loading path). */
  onOpenSession: (sessionId: string) => void;
  /** Whether this routine currently has a pending smartwake (shows a 😎 badge). */
  pending?: boolean;
}

function triggerSummary(trigger: RoutineTrigger, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (trigger.type === "cron") return describeCron(trigger.schedule);
  if (trigger.type === "guard") return t("routines.conditionSummary", { minutes: Math.round(trigger.intervalMs / 60_000) });
  return t("routines.webhookSummary");
}

function statusColor(status: RoutineRun["status"]): string {
  switch (status) {
    case "success": return "var(--success)";
    case "error": return "var(--danger)";
    case "timeout": return "var(--warning)";
    case "running": return "var(--accent)";
    default: return "var(--text-dim)";
  }
}

function formatTimestamp(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function RoutineActivityView({ routineId, onEdit, onOpenSession, pending }: Props) {
  const { t, locale } = useI18n();
  const [routine, setRoutine] = useState<RoutineWithStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/routines/${routineId}`, { cache: "no-store" });
      const data = await response.json() as { routine?: RoutineWithStatus; error?: string };
      if (!response.ok || data.error || !data.routine) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRoutine(data.routine);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [routineId]);

  useEffect(() => { void load(); }, [load]);

  // Poll while a run is in flight so the activity list updates live.
  useEffect(() => {
    if (!routine?.running) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [routine?.running, load]);

  const runs = useMemo(() => sortRunsNewestFirst(routine?.history ?? []), [routine?.history]);

  const scrollToRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    const el = scrollRef.current?.querySelector(`#${CSS.escape(runScrollTargetId(runId))}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const runNow = useCallback(async () => {
    try {
      await fetch(`/api/routines/${routineId}/run`, { method: "POST" });
      await load();
    } catch { /* surfaced on next poll */ }
  }, [routineId, load]);

  if (error && !routine) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--danger)", fontSize: 13, padding: 24, textAlign: "center" }}>
        {error}
      </div>
    );
  }
  if (!routine) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        {t("routines.running")}…
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", padding: "14px 18px", background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "flex", color: routine.enabled ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
            </svg>
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{routine.name}</h1>
              {pending && (
                <span title={t("wakes.pending")} aria-label={t("wakes.pending")} style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>😎</span>
              )}
              {routine.running && (
                <span title={t("routines.running")} style={{ display: "flex", color: "var(--accent)", flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" style={{ animation: "spin 0.8s linear infinite" }}>
                    <path d="M12 3a9 9 0 1 0 9 9" />
                  </svg>
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {triggerSummary(routine.trigger, t)} · {routine.enabled ? t("routines.running") : t("routines.paused")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button type="button" onClick={() => void runNow()} style={headerButtonStyle}>{t("routines.runNow")}</button>
            <button type="button" onClick={() => onEdit(routineId)} style={headerButtonStyle}>{t("routines.edit")}</button>
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px 18px 24px" }}>
        <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-dim)", margin: "4px 0 10px" }}>
          {t("routines.history")}
        </h2>
        {runs.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "12px 0" }}>{t("routines.historyEmpty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {runs.map((run) => {
              const duration = formatRunDuration(run);
              const isSelected = selectedRunId === run.id;
              return (
                <div
                  key={run.id + run.startedAt}
                  id={runScrollTargetId(run.id)}
                  onClick={() => scrollToRun(run.id)}
                  style={{
                    border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                    borderRadius: 8,
                    padding: "10px 12px",
                    background: isSelected ? "var(--bg-selected)" : "var(--bg-panel)",
                    cursor: "pointer",
                    transition: "border-color 0.12s, background 0.12s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{
                      flexShrink: 0, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.02em",
                      textTransform: "uppercase", padding: "2px 7px", borderRadius: 5,
                      color: statusColor(run.status),
                      background: "color-mix(in srgb, currentColor 14%, transparent)",
                    }}>
                      {t(`routines.status.${run.status}`)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {formatTimestamp(run.finishedAt ?? run.startedAt, locale)}
                      {duration ? ` · ${duration}` : ""}
                    </span>
                    {run.sessionId && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenSession(run.sessionId!); }}
                        title={t("routines.openTranscript")}
                        style={{
                          flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
                          padding: "3px 9px", borderRadius: 6, border: "1px solid var(--border)",
                          background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer",
                          fontSize: 11, fontFamily: "var(--font-mono)",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        {t("routines.openTranscript")}
                      </button>
                    )}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--text)", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {run.summary || t("routines.noSummary")}
                  </div>
                  {run.error && run.status !== "success" && (
                    <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--danger)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                      {run.error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const headerButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "5px 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
};
