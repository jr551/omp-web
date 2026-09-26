"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
}

interface CreateDirectoryResponse {
  path?: string;
  parentPath?: string;
  name?: string;
  error?: string;
}

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

function DriveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, busy = false, error }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo();
  }, [navigateTo]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const cancelFolderCreation = () => {
    setCreatingFolder(false);
    setFolderName("");
    setCreateError(null);
  };
  const handleCreateFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) {
      setCreateError(t("directoryPicker.folderNameRequired"));
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/cwd/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentPath: currentPath, name }),
      });
      const data = await response.json() as CreateDirectoryResponse;
      if (!response.ok || !data.path) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      await navigateTo(data.path);
      setCreatingFolder(false);
      setFolderName("");
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const interactionBusy = busy || creating;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !interactionBusy;
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop viewport-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("directoryPicker.selectDirectory")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !interactionBusy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !interactionBusy) {
          if (creatingFolder) {
            event.stopPropagation();
            setCreatingFolder(false);
            setFolderName("");
            setCreateError(null);
          } else {
            onCancel();
          }
        }
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div className="directory-picker-panel viewport-dialog" style={{ width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("directoryPicker.selectDirectory")}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={interactionBusy}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: interactionBusy ? "default" : "pointer", opacity: interactionBusy ? 0.5 : 1 }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={loading || interactionBusy || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: canNavigateUp && !interactionBusy ? "pointer" : "default", opacity: canNavigateUp && !interactionBusy ? 1 : 0.45 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button
            className="directory-picker-action"
            type="button"
            onClick={() => {
              setCreatingFolder(true);
              setFolderName("");
              setCreateError(null);
            }}
            disabled={loading || interactionBusy || !currentPath || drives !== null}
            title={t("directoryPicker.newFolder")}
            aria-label={t("directoryPicker.newFolder")}
            style={{ height: 36, padding: "0 10px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || interactionBusy || !currentPath || drives !== null ? "default" : "pointer", opacity: loading || interactionBusy || !currentPath || drives !== null ? 0.5 : 1, fontSize: 12 }}
          >
            <FolderIcon />
            <span>{t("directoryPicker.newFolder")}</span>
          </button>
          <label htmlFor="directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
            {t("directoryPicker.directoryPath")}
          </label>
          <input
            className="directory-picker-path"
            id="directory-path"
            type="text"
            value={pathInput}
            placeholder="/path/to/project or ~/project"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPathInput(event.target.value);
              setLoadError(null);
            }}
            disabled={interactionBusy}
            style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button
            className="directory-picker-action"
            type="submit"
            disabled={loading || interactionBusy || !pathInput.trim()}
            title={t("directoryPicker.goToDirectory")}
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || interactionBusy || !pathInput.trim() ? "default" : "pointer", opacity: loading || interactionBusy || !pathInput.trim() ? 0.6 : 1 }}
          >
            {t("directoryPicker.go")}
          </button>
        </form>

        <div className="directory-picker-list" aria-busy={loading || creating} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
          {creatingFolder && (
            <form onSubmit={handleCreateFolder} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: 8, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
              <label htmlFor="directory-folder-name" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
                {t("directoryPicker.folderName")}
              </label>
              <input
                id="directory-folder-name"
                type="text"
                value={folderName}
                autoFocus
                autoComplete="off"
                placeholder={t("directoryPicker.folderName")}
                disabled={creating}
                onChange={(event) => {
                  setFolderName(event.target.value);
                  setCreateError(null);
                }}
                style={{ minWidth: 0, flex: 1, height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <button className="directory-picker-action" type="submit" disabled={creating || !folderName.trim()} style={{ height: 34, padding: "0 12px", border: 0, borderRadius: 5, background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600, opacity: creating || !folderName.trim() ? 0.6 : 1, cursor: creating || !folderName.trim() ? "default" : "pointer" }}>
                {creating ? t("directoryPicker.creating") : t("directoryPicker.create")}
              </button>
              <button className="directory-picker-action" type="button" onClick={cancelFolderCreation} disabled={creating} style={{ height: 34, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", fontSize: 12, cursor: creating ? "default" : "pointer" }}>
                {t("i18n.cancel")}
              </button>
            </form>
          )}
          {createError && <div role="alert" style={{ padding: "8px", color: "#dc2626", fontSize: 11 }}>{createError}</div>}
          {loading ? (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.loadingDirectories")}</div>
          ) : drives !== null ? (
            <>
              {drives.length > 0 ? (
                drives.map((drive) => (
                  <button
                    key={drive.path}
                    className="directory-picker-entry"
                    type="button"
                    onClick={() => void navigateTo(drive.path)}
                    disabled={interactionBusy}
                    title={drive.path}
                    style={{ width: "100%", minHeight: 34, display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
                  >
                    <DriveIcon />
                    <span>{drive.name}</span>
                  </button>
                ))
              ) : (
                <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noDrives")}</div>
              )}
            </>
          ) : directories.length > 0 ? (
            directories.map((entry) => (
              <button
                key={entry.path}
                className="directory-picker-entry"
                type="button"
                onClick={() => void navigateTo(entry.path)}
                disabled={interactionBusy}
                title={entry.path}
                style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
              >
                <FolderIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          ) : (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
          )}
          {(loadError || error) && <div role="alert" style={{ padding: "8px", color: "#dc2626", fontSize: 11 }}>{loadError ?? error}</div>}
        </div>

        <div className="directory-picker-footer" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button className="directory-picker-action" type="button" onClick={onCancel} disabled={interactionBusy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: interactionBusy ? "default" : "pointer", fontSize: 13 }}>{t("i18n.cancel")}</button>
          <button
            className="directory-picker-action"
            type="button"
            onClick={() => onSelect(currentPath)}
            disabled={!canSelect}
            title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
            style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
          >
            {busy ? t("i18n.checking") : t("directoryPicker.selectThisFolder")}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
