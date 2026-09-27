"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DirectoryPicker } from "./DirectoryPicker";
import { SearchableSelect } from "./SearchableSelect";
import { useI18n } from "@/hooks/useI18n";
import { describeCron, isValidCron } from "@/lib/cron";
import {
  DEFAULT_EXECUTION_MS,
  DEFAULT_GUARD_INTERVAL_MS,
  DEFAULT_GUARD_TIMEOUT_MS,
  type Routine,
  type RoutineRun,
  type RoutineTrigger,
  type RoutineWithStatus,
} from "@/lib/routine-types";
import styles from "./RoutinesConfig.module.css";

interface RoutinesConfigProps {
  initialCwd?: string | null;
  initialRoutineId?: string | null;
  onClose: () => void;
}

interface SessionInfoLite { cwd?: string; projectRoot?: string }

interface ModelOption { id: string; name: string; provider: string }
interface ModelsResponse {
  modelList?: ModelOption[];
  defaultModel?: { provider: string; modelId: string } | null;
  error?: string;
}

type TriggerType = "cron" | "guard" | "webhook";

interface Draft {
  name: string;
  cwd: string;
  triggerType: TriggerType;
  schedule: string;
  intervalMs: number;
  command: string;
  expectOutputMatches: string;
  guardTimeoutMs: number;
  prompt: string;
  model: string; // "provider:modelId" or "" for project default
  maxExecutionMs: number;
  enabled: boolean;
  askWebhookUrl: string;
}

const EXECUTION_PRESETS_MIN = [5, 15, 30, 60, 120];
const INTERVAL_PRESETS_MIN = [1, 5, 15, 30, 60];

function blankDraft(cwd: string): Draft {
  return {
    name: "",
    cwd,
    triggerType: "cron",
    schedule: "0 9 * * *",
    intervalMs: DEFAULT_GUARD_INTERVAL_MS,
    command: "",
    expectOutputMatches: "",
    guardTimeoutMs: DEFAULT_GUARD_TIMEOUT_MS,
    prompt: "",
    model: "",
    maxExecutionMs: DEFAULT_EXECUTION_MS,
    enabled: true,
    askWebhookUrl: "",
  };
}

function draftFromRoutine(routine: Routine): Draft {
  const base = blankDraft(routine.cwd);
  const model = routine.provider && routine.modelId ? `${routine.provider}:${routine.modelId}` : "";
  const common = {
    ...base,
    name: routine.name,
    prompt: routine.prompt,
    model,
    maxExecutionMs: routine.maxExecutionMs,
    enabled: routine.enabled,
    askWebhookUrl: routine.askWebhookUrl ?? "",
  };
  if (routine.trigger.type === "cron") {
    return { ...common, triggerType: "cron", schedule: routine.trigger.schedule };
  }
  if (routine.trigger.type === "guard") {
    return {
      ...common,
      triggerType: "guard",
      intervalMs: routine.trigger.intervalMs,
      command: routine.trigger.command,
      expectOutputMatches: routine.trigger.expectOutputMatches ?? "",
      guardTimeoutMs: routine.trigger.guardTimeoutMs,
    };
  }
  return { ...common, triggerType: "webhook" };
}

function draftToBody(draft: Draft): Record<string, unknown> {
  const trigger: RoutineTrigger = draft.triggerType === "cron"
    ? { type: "cron", schedule: draft.schedule.trim() }
    : draft.triggerType === "guard"
      ? {
          type: "guard",
          intervalMs: draft.intervalMs,
          command: draft.command,
          guardTimeoutMs: draft.guardTimeoutMs,
          ...(draft.expectOutputMatches.trim() ? { expectOutputMatches: draft.expectOutputMatches.trim() } : {}),
        }
      : { type: "webhook", token: "" };
  const [provider, modelId] = draft.model ? draft.model.split(":") : [undefined, undefined];
  return {
    name: draft.name.trim(),
    cwd: draft.cwd,
    trigger,
    prompt: draft.prompt,
    maxExecutionMs: draft.maxExecutionMs,
    enabled: draft.enabled,
    ...(provider && modelId ? { provider, modelId } : {}),
    ...(draft.askWebhookUrl.trim() ? { askWebhookUrl: draft.askWebhookUrl.trim() } : {}),
  };
}

export function RoutinesConfig({ initialCwd, initialRoutineId, onClose }: RoutinesConfigProps) {
  const { t, locale } = useI18n();
  const [routines, setRoutines] = useState<RoutineWithStatus[]>([]);
  const [knownCwds, setKnownCwds] = useState<string[]>(initialCwd ? [initialCwd] : []);
  const appliedInitialRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState("");
  const [resolvedBaseUrl, setResolvedBaseUrl] = useState("");
  const [externalUrlSaving, setExternalUrlSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRoutines = useCallback(async () => {
    try {
      const response = await fetch("/api/routines", { cache: "no-store" });
      const data = await response.json() as { routines?: RoutineWithStatus[]; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setRoutines(data.routines ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => { void loadRoutines(); }, [loadRoutines]);

  // Build the list of known project directories from existing sessions.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/sessions", { cache: "no-store" });
        const data = await response.json() as { sessions?: SessionInfoLite[] } | SessionInfoLite[];
        const sessions = Array.isArray(data) ? data : data.sessions ?? [];
        const dirs = new Set<string>();
        if (initialCwd) dirs.add(initialCwd);
        for (const session of sessions) {
          const dir = session.projectRoot ?? session.cwd;
          if (dir) dirs.add(dir);
        }
        if (!cancelled) setKnownCwds([...dirs].sort());
      } catch {
        // Keep whatever seed we have; the DirectoryPicker still works.
      }
    })();
    return () => { cancelled = true; };
  }, [initialCwd]);

  // Poll while any routine is running so the sidebar/history reflect progress.
  useEffect(() => {
    const anyRunning = routines.some((routine) => routine.running);
    if (!anyRunning) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void loadRoutines(), 3000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [routines, loadRoutines]);

  const loadModels = useCallback(async (cwd: string) => {
    if (!cwd) { setModels([]); return; }
    try {
      const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json() as ModelsResponse;
      setModels(data.modelList ?? []);
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => { if (draft?.cwd) void loadModels(draft.cwd); }, [draft?.cwd, loadModels]);

  const selectRoutine = useCallback((routine: RoutineWithStatus) => {
    setError(null);
    setSelectedId(routine.id);
    setDraft(draftFromRoutine(routine));
  }, []);

  // Pre-select a routine when opened from a sidebar "Edit" action.
  useEffect(() => {
    if (appliedInitialRef.current || !initialRoutineId || routines.length === 0) return;
    const match = routines.find((routine) => routine.id === initialRoutineId);
    if (match) { appliedInitialRef.current = true; selectRoutine(match); }
  }, [initialRoutineId, routines, selectRoutine]);

  const startNew = useCallback(() => {
    setError(null);
    setSelectedId("new");
    setDraft(blankDraft(initialCwd ?? knownCwds[0] ?? ""));
  }, [initialCwd, knownCwds]);

  const patchDraft = useCallback((patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const isNew = selectedId === "new";
      const url = isNew ? "/api/routines" : `/api/routines/${selectedId}`;
      const method = isNew ? "POST" : "PUT";
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToBody(draft)),
      });
      const data = await response.json() as { routine?: RoutineWithStatus; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadRoutines();
      if (data.routine) selectRoutine(data.routine);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [draft, selectedId, loadRoutines, selectRoutine]);

  const remove = useCallback(async () => {
    if (selectedId === "new" || !selectedId) { setSelectedId(null); setDraft(null); return; }
    if (!window.confirm(t("routines.confirmDelete"))) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/routines/${selectedId}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSelectedId(null);
      setDraft(null);
      await loadRoutines();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [selectedId, loadRoutines, t]);

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/omp-web-config", { cache: "no-store" });
      const data = await response.json() as { externalBaseUrl?: string; resolvedBaseUrl?: string };
      setExternalUrl(data.externalBaseUrl ?? "");
      setResolvedBaseUrl(data.resolvedBaseUrl ?? "");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const saveExternalUrl = useCallback(async (value: string) => {
    setExternalUrlSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/omp-web-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalBaseUrl: value }),
      });
      const data = await response.json() as { externalBaseUrl?: string; resolvedBaseUrl?: string; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setExternalUrl(data.externalBaseUrl ?? "");
      setResolvedBaseUrl(data.resolvedBaseUrl ?? "");
      await loadRoutines();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExternalUrlSaving(false);
    }
  }, [loadRoutines]);

  const regenerateToken = useCallback(async () => {
    if (selectedId === "new" || !selectedId) return;
    try {
      const response = await fetch(`/api/routines/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerateToken: true }),
      });
      const data = await response.json() as { routine?: RoutineWithStatus; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadRoutines();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selectedId, loadRoutines]);

  const runNow = useCallback(async () => {
    if (selectedId === "new" || !selectedId) return;
    try {
      await fetch(`/api/routines/${selectedId}/run`, { method: "POST" });
      await loadRoutines();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selectedId, loadRoutines]);

  const modelOptions = useMemo(() => {
    const options = [{ value: "", label: t("routines.modelDefault"), searchText: "default" }];
    for (const model of models) {
      options.push({ value: `${model.provider}:${model.id}`, label: `${model.name}`, searchText: model.provider });
    }
    return options;
  }, [models, t]);

  const cronValid = draft?.triggerType === "cron" ? isValidCron(draft.schedule) : true;
  const cronSummary = draft?.triggerType === "cron" ? describeCron(draft.schedule) : "";

  const triggerValid = !draft
    ? false
    : draft.triggerType === "cron"
      ? cronValid
      : draft.triggerType === "guard"
        ? Boolean(draft.command.trim())
        : true;
  const canSave = Boolean(draft && draft.name.trim() && draft.cwd && draft.prompt.trim() && triggerValid && !saving);
  const selectedRoutine = selectedId && selectedId !== "new" ? routines.find((routine) => routine.id === selectedId) : undefined;

  return (
    <div className={`${styles.backdrop} viewport-dialog-backdrop`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`${styles.window} viewport-dialog`} role="dialog" aria-modal="true" aria-label={t("routines.title")}>
        <aside className={styles.listPane}>
          <div className={styles.brand}>
            <div className={styles.eyebrow}>omp-web</div>
            <h1 className={styles.title}>{t("routines.title")}</h1>
            <p className={styles.subtitle}>{t("routines.subtitle")}</p>
            <div className={styles.field} style={{ marginTop: 12 }}>
              <label className={styles.fieldLabel}>{t("routines.externalUrl")}</label>
              <input
                className={styles.textInput}
                value={externalUrl}
                placeholder={resolvedBaseUrl || "https://omp.example.com"}
                spellCheck={false}
                disabled={externalUrlSaving}
                onChange={(event) => setExternalUrl(event.target.value)}
                onBlur={(event) => void saveExternalUrl(event.target.value)}
              />
              <span className={styles.fieldHint}>{t("routines.externalUrlHint")}</span>
            </div>
          </div>
          <div className={styles.list}>
            {routines.length === 0 && <div className={styles.listEmpty}>{t("routines.empty")}</div>}
            {routines.map((routine) => (
              <button
                key={routine.id}
                type="button"
                className={styles.routineRow}
                data-active={selectedId === routine.id}
                onClick={() => selectRoutine(routine)}
              >
                <ClockIcon className={styles.routineIcon} disabled={!routine.enabled} />
                <span className={styles.routineMeta}>
                  <span className={styles.routineName}>{routine.name}</span>
                  <span className={styles.routineTrigger}>{triggerSummary(routine.trigger, t)}</span>
                </span>
                <span className={styles.routineState}>
                  {routine.running
                    ? <span className={styles.spinner} aria-label={t("routines.running")} />
                    : <span className={styles.statusDot} data-status={dotStatus(routine)} />}
                </span>
              </button>
            ))}
          </div>
          <div className={styles.listFooter}>
            <button type="button" className={styles.newButton} onClick={startNew}>
              <PlusIcon /> {t("routines.new")}
            </button>
          </div>
        </aside>

        <main className={styles.content}>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label={t("common.ok")}>×</button>
          {!draft ? (
            <div className={styles.empty}>{t("routines.selectPrompt")}</div>
          ) : (
            <div className={styles.scrollContent}>
              <div className={styles.editorHeader}>
                <div>
                  <h2 className={styles.editorTitle}>{selectedId === "new" ? t("routines.new") : draft.name || t("routines.title")}</h2>
                  <p className={styles.editorSubtitle}>
                    {selectedId === "new"
                      ? t("routines.subtitle")
                      : (draft.enabled ? t("routines.running") : t("routines.paused"))}
                  </p>
                </div>
                {selectedId !== "new" && (
                  <div className={styles.headerActions}>
                    <button type="button" className={styles.secondaryButton} onClick={() => void runNow()}>{t("routines.runNow")}</button>
                  </div>
                )}
              </div>

              <div className={styles.form}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t("routines.name")}</label>
                  <input className={styles.textInput} value={draft.name} placeholder={t("routines.namePlaceholder")} onChange={(event) => patchDraft({ name: event.target.value })} />
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t("routines.project")}</label>
                  <div className={styles.cwdRow}>
                    {knownCwds.length > 0 ? (
                      <select className={styles.select} value={knownCwds.includes(draft.cwd) ? draft.cwd : ""} onChange={(event) => patchDraft({ cwd: event.target.value })}>
                        {!knownCwds.includes(draft.cwd) && <option value="">{draft.cwd || t("routines.pickProject")}</option>}
                        {knownCwds.map((cwd) => <option key={cwd} value={cwd}>{cwd}</option>)}
                      </select>
                    ) : (
                      <span className={styles.cwdValue} title={draft.cwd}>{draft.cwd || t("routines.pickProject")}</span>
                    )}
                    <button type="button" className={styles.secondaryButton} onClick={() => setDirPickerOpen(true)}>{t("routines.changeDir")}</button>
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t("routines.trigger")}</label>
                  <div className={styles.toggleGroup}>
                    <button type="button" className={styles.toggleButton} data-active={draft.triggerType === "cron"} onClick={() => patchDraft({ triggerType: "cron" })}>{t("routines.triggerCron")}</button>
                    <button type="button" className={styles.toggleButton} data-active={draft.triggerType === "guard"} onClick={() => patchDraft({ triggerType: "guard" })}>{t("routines.triggerCondition")}</button>
                    <button type="button" className={styles.toggleButton} data-active={draft.triggerType === "webhook"} onClick={() => patchDraft({ triggerType: "webhook" })}>{t("routines.triggerWebhook")}</button>
                  </div>
                </div>

                {draft.triggerType === "cron" ? (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>{t("routines.schedule")}</label>
                    <input className={styles.textInput} value={draft.schedule} placeholder={t("routines.schedulePlaceholder")} spellCheck={false} onChange={(event) => patchDraft({ schedule: event.target.value })} />
                    <div className={styles.cronPreview} data-error={!cronValid}>{cronSummary}</div>
                  </div>
                ) : draft.triggerType === "guard" ? (
                  <>
                    <div className={styles.fieldRow}>
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>{t("routines.interval")}</label>
                        <select className={styles.select} value={String(draft.intervalMs)} onChange={(event) => patchDraft({ intervalMs: Number(event.target.value) })}>
                          {INTERVAL_PRESETS_MIN.map((min) => <option key={min} value={min * 60_000}>{t("routines.minutes", { count: min })}</option>)}
                        </select>
                      </div>
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>{t("routines.guardTimeout")}</label>
                        <select className={styles.select} value={String(draft.guardTimeoutMs)} onChange={(event) => patchDraft({ guardTimeoutMs: Number(event.target.value) })}>
                          {[10, 30, 60, 120, 300].map((sec) => <option key={sec} value={sec * 1000}>{t("routines.seconds", { count: sec })}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>{t("routines.command")}</label>
                      <textarea className={`${styles.textArea} ${styles.commandArea}`} value={draft.command} spellCheck={false} placeholder="curl -fsS https://example.com/health" onChange={(event) => patchDraft({ command: event.target.value })} />
                      <span className={styles.fieldHint}>{t("routines.commandHint")}</span>
                    </div>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>{t("routines.expectOutput")}</label>
                      <input className={styles.textInput} value={draft.expectOutputMatches} spellCheck={false} placeholder="\bOK\b" onChange={(event) => patchDraft({ expectOutputMatches: event.target.value })} />
                    </div>
                  </>
                ) : (
                  <div className={styles.webhookBox}>
                    <span className={styles.fieldHint}>{t("routines.webhookHint")}</span>
                    {selectedRoutine?.webhookUrl ? (
                      <>
                        <div className={styles.webhookUrl}>
                          <code title={selectedRoutine.webhookUrl}>{selectedRoutine.webhookUrl}</code>
                          <button type="button" className={styles.secondaryButton} onClick={() => void navigator.clipboard?.writeText(selectedRoutine.webhookUrl ?? "")}>{t("routines.copy")}</button>
                        </div>
                        <button type="button" className={styles.secondaryButton} style={{ alignSelf: "flex-start" }} onClick={() => void regenerateToken()}>{t("routines.regenerate")}</button>
                      </>
                    ) : (
                      <span className={styles.fieldHint}>{t("routines.webhookAfterSave")}</span>
                    )}
                  </div>
                )}

                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t("routines.prompt")}</label>
                  <textarea className={styles.textArea} value={draft.prompt} placeholder={t("routines.promptPlaceholder")} onChange={(event) => patchDraft({ prompt: event.target.value })} />
                </div>

                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>{t("routines.model")}</label>
                    <SearchableSelect
                      value={modelOptions.some((option) => option.value === draft.model) ? draft.model : ""}
                      options={modelOptions}
                      onChange={(value) => patchDraft({ model: value })}
                      ariaLabel={t("routines.model")}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>{t("routines.maxExecution")}</label>
                    <select className={styles.select} value={String(draft.maxExecutionMs)} onChange={(event) => patchDraft({ maxExecutionMs: Number(event.target.value) })}>
                      {EXECUTION_PRESETS_MIN.map((min) => <option key={min} value={min * 60_000}>{min < 60 ? t("routines.minutes", { count: min }) : t("routines.hours", { count: min / 60 })}</option>)}
                    </select>
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t("routines.askWebhook")}</label>
                  <input className={styles.textInput} value={draft.askWebhookUrl} spellCheck={false} placeholder="https://hooks.example.com/ask" onChange={(event) => patchDraft({ askWebhookUrl: event.target.value })} />
                  <span className={styles.fieldHint}>{t("routines.askWebhookHint")}</span>
                </div>

                <div className={styles.switchRow}>
                  <div>
                    <div className={styles.fieldLabel}>{t("routines.enabled")}</div>
                    <div className={styles.fieldHint}>{t("routines.enabledHint")}</div>
                  </div>
                  <button type="button" className={styles.switch} data-on={draft.enabled} aria-pressed={draft.enabled} onClick={() => patchDraft({ enabled: !draft.enabled })} />
                </div>

                {error && <div className={styles.error}>{error}</div>}

                <div className={styles.actions}>
                  <button type="button" className={styles.primaryButton} disabled={!canSave} onClick={() => void save()}>
                    {saving ? t("common.ok") : selectedId === "new" ? t("routines.create") : t("routines.save")}
                  </button>
                  <div className={styles.spacer} />
                  {selectedId !== "new" && <button type="button" className={styles.dangerButton} disabled={saving} onClick={() => void remove()}>{t("routines.delete")}</button>}
                </div>
              </div>

              {selectedId !== "new" && (
                <div className={styles.history}>
                  <h3 className={styles.historyTitle}>{t("routines.history")}</h3>
                  <RunHistory runs={selectedRoutineRuns(routines, selectedId)} locale={locale} t={t} />
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {dirPickerOpen && (
        <DirectoryPicker
          onCancel={() => setDirPickerOpen(false)}
          onSelect={(path) => { patchDraft({ cwd: path }); setDirPickerOpen(false); }}
        />
      )}
    </div>
  );
}

function selectedRoutineRuns(routines: RoutineWithStatus[], id: string | "new" | null): RoutineRun[] {
  if (!id || id === "new") return [];
  const routine = routines.find((entry) => entry.id === id);
  if (!routine?.history) return [];
  return [...routine.history].reverse();
}

function RunHistory({ runs, locale, t }: { runs: RoutineRun[]; locale: string; t: (key: string, params?: Record<string, string | number>) => string }) {
  if (runs.length === 0) return <div className={styles.historyEmpty}>{t("routines.historyEmpty")}</div>;
  return (
    <>
      {runs.map((run) => (
        <div key={run.id + run.startedAt} className={styles.historyRow}>
          <span className={styles.historyBadge} data-status={run.status}>{t(`routines.status.${run.status}`)}</span>
          <div className={styles.historyBody}>
            <div className={styles.historySummary}>{run.summary || t("routines.noSummary")}</div>
            <div className={styles.historyTime}>{formatTimestamp(run.finishedAt ?? run.startedAt, locale)}</div>
          </div>
        </div>
      ))}
    </>
  );
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

function triggerSummary(trigger: RoutineTrigger, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (trigger.type === "cron") return describeCron(trigger.schedule);
  if (trigger.type === "guard") return t("routines.conditionSummary", { minutes: Math.round(trigger.intervalMs / 60_000) });
  return t("routines.webhookSummary");
}

function dotStatus(routine: RoutineWithStatus): string {
  if (!routine.enabled) return "paused";
  const status = routine.lastRun?.status;
  if (status === "error") return "error";
  if (status === "timeout") return "timeout";
  if (status === "skipped") return "skipped";
  return "active";
}

function ClockIcon({ className, disabled }: { className?: string; disabled?: boolean }) {
  return (
    <svg className={className} data-disabled={disabled} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <line x1="6" y1="1.5" x2="6" y2="10.5" /><line x1="1.5" y1="6" x2="10.5" y2="6" />
    </svg>
  );
}
