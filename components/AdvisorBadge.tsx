"use client";
import type { AdvisorStatusInfo } from "@/lib/omp-types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

type AdvisorTone = "error" | "warning" | "active" | "idle";

/**
 * Same precedence as the TUI status-line badge: the worst status in the
 * roster wins, and "running" only reads as active until every advisor has
 * yielded the current turn.
 */
export function getAdvisorTone(status: AdvisorStatusInfo): AdvisorTone {
  const statuses = status.advisors.map((advisor) => advisor.status);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("quota_exhausted")) return "warning";
  if (status.advisors.some((advisor) => advisor.status === "running" && !advisor.yielded)) return "active";
  return "idle";
}

function describeAdvisor(status: string, yielded: boolean, t: Translate): string {
  switch (status) {
    case "running": return yielded ? t("chat.advisorIdle") : t("chat.advisorReviewing");
    case "paused": return t("chat.advisorPaused");
    case "quota_exhausted": return t("chat.advisorQuota");
    case "error": return t("chat.advisorError");
    case "no_model": return t("chat.advisorNoModel");
    default: return status;
  }
}

const TONE_LABELS: Record<AdvisorTone, string> = {
  error: "chat.advisorError",
  warning: "chat.advisorQuota",
  active: "chat.advisorReviewing",
  idle: "chat.advisorIdle",
};

const TONE_COLORS: Record<AdvisorTone, string> = {
  error: "var(--danger)",
  warning: "var(--warning)",
  active: "var(--success)",
  idle: "var(--text-dim)",
};

/** Compact advisor roster indicator (upstream issue #55); hidden when none is configured. */
export function AdvisorBadge({ status, t }: { status: AdvisorStatusInfo | null; t: Translate }) {
  if (!status || status.advisors.length === 0) return null;
  const tone = getAdvisorTone(status);
  const detail = status.advisors
    .map((advisor) => `${advisor.name}: ${describeAdvisor(advisor.status, advisor.yielded, t)}`)
    .join("\n");
  const summary = status.advisors.length === 1
    ? describeAdvisor(status.advisors[0].status, status.advisors[0].yielded, t)
    : `${status.advisors.length} · ${t(TONE_LABELS[tone])}`;
  return (
    <span
      role="status"
      aria-live="polite"
      title={detail}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        border: "1px solid var(--border)",
        borderRadius: 999,
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        className={tone === "active" ? "omp-advisor-pulse" : undefined}
        style={{ width: 7, height: 7, borderRadius: "50%", background: TONE_COLORS[tone], flexShrink: 0 }}
      />
      <span style={{ color: "var(--text-dim)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {t("chat.advisorLabel")}
      </span>
      <span>{summary}</span>
    </span>
  );
}
