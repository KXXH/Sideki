declare const __BUILD_HASH__: string;
declare const __AI_SDK_VERSION__: string;
declare const __JUST_BASH_VERSION__: string;
import { useState, useEffect, useCallback, useRef } from "react";
import { Icon } from "@iconify/react";
import {
  iconArrowLeft,
  iconCheck,
  iconPlus,
  iconClose,
  iconDelete,
  iconDownload,
  iconChevronDown,
  iconBackupRestore,
  iconChevronRight,
  iconFolderOpen,
  iconFileArchive,
  iconFileDocument,
  iconPuzzle,
  iconCloudUpload,
  iconAlertCircleOutline,
} from "../../shared/icons";
import DataView from "./DataView";
import { DEFAULT_CONFIG } from "../default-config";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, PERMISSION_MODE_DESCRIPTIONS, resolveDefaultPermissionMode } from "../../shared/permission-mode";
import UsageView from "./UsageView";
import ModelServices from "../components/ModelServices";
import iconChartBar from '@iconify-icons/mdi/chart-bar';
import {
  loadConfig,
  saveConfig,
  loadSessionIndex,
  deleteSession,
  deleteSessions,
  getSessionSize,
} from "../../shared/storage";
import { getShellFsSize, deleteShellFs } from "../../shared/shell-storage";
import {
  loadSitePermissions,
  revokeSitePermission,
  type SitePermissions,
} from "../../shared/site-permissions";
import {
  THEME_PRESETS,
  applyTheme,
  applyFont,
  applyColorMode,
  getResolvedThemeMode,
  normalizeThemeId,
  resolveThemeValues,
} from "../../shared/themes";
import { formatSize } from "../../shared/format";
import { t } from "../../shared/i18n";
import type {
  ApiConfig,
  ProviderProfile,
  McpServerConfig,
} from "../../shared/types";
import McpSection from "../components/McpSection";
import AppDialog, { DialogAction } from "../components/AppDialog";
import MemoryCurationSheet from "../components/MemoryCurationSheet";
import { skillRegistry, removeUserSkill, getExportableSkills, importSkillFromEntries, parseFrontmatter } from "../../shared/skills";
import { createTarGz, parseTarGz } from "../utils/tar";
import {
  getGlobalMemory,
  getAllSiteHostnames,
  getSiteMemory,
  deleteSiteMemory,
    updateNote,
  getNotes,
  removeNote,
  getCurationUndoTs,
  updateMemoryLine,
  removeMemoryLine,
  addMemoryLine,
  parseMemoryLines,
  GLOBAL_LIMIT,
  SITE_LIMIT,
  type MemoryEditResult,
} from "../../shared/memory-storage";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function createProfile(name: string): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    name,
    endpoint: "",
    apiKey: "",
    model: "",
    reasoningEffort: "",
  };
}


const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

interface Props {
  onBack?: () => void;
  onShowUpdateIntro?: () => void;
  onShowOnboarding?: () => void;
}

// Reason: global and site memory are the same line-entry model, so one editor
// serves both — same interaction range as the note editor (click row to expand,
// textarea + save/cancel). Writes go through the index+CAS storage API so an AI
// write landing mid-edit surfaces as a conflict instead of being overwritten.
function MemoryLines({
  target,
  hostname,
  text,
  onRefresh,
}: {
  target: "global" | "site";
  hostname?: string;
  text: string;
  onRefresh: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lines = parseMemoryLines(text);

  const messageFor = (r: MemoryEditResult): string | null => {
    switch (r.code) {
      case "stale": return t.memoryEditStale;
      case "rejected": return t.memoryEditRejected;
      case "over-limit": return t.memoryEditOverLimit;
      case "duplicate": return t.memoryEditDuplicate;
      default: return r.ok ? null : (r.error ?? null);
    }
  };

  const settle = async (r: MemoryEditResult) => {
    setErr(messageFor(r));
    // Reason: refresh on stale too — the point is to show the user current truth.
    if (r.ok || r.code === "stale") await onRefresh();
    return r.ok;
  };

  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, idx) => (
        <div key={`${idx}-${line.slice(0, 20)}`}>
          <div
            onClick={() => {
              setErr(null);
              if (editing === idx) { setEditing(null); return; }
              setDraft(line);
              setAdding(false);
              setEditing(idx);
            }}
            className="group flex cursor-pointer items-start gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-1 transition-colors hover:bg-surface-overlay"
          >
            <span className="min-w-0 flex-1 text-[10px] leading-snug text-text-muted [overflow-wrap:anywhere]">{line}</span>
            <button
              type="button"
              aria-label="删除记忆条目"
              onClick={async (e) => {
                e.stopPropagation();
                setErr(null);
                await settle(await removeMemoryLine(target, hostname, idx, line));
                if (editing === idx) setEditing(null);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted opacity-0 transition-opacity hover:text-error group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <Icon icon={iconClose} className="text-[9px]" />
            </button>
          </div>
          {editing === idx && (
            <div className="mx-1 mt-0.5 flex flex-col gap-1.5 rounded-lg bg-surface-overlay/30 p-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                autoFocus
                className="input-base min-h-[52px] resize-y !text-[11px] leading-relaxed"
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={async () => {
                    const next = draft.trim();
                    if (!next || next === line) { setEditing(null); return; }
                    if (await settle(await updateMemoryLine(target, hostname, idx, line, next))) {
                      setEditing(null);
                    }
                  }}
                  disabled={!draft.trim()}
                  className="rounded-md bg-accent/20 px-3 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent/30 disabled:opacity-40"
                >
                  {t.save}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(null); setErr(null); }}
                  className="rounded-md px-3 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-overlay"
                >
                  {t.cancel}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {adding ? (
        <div className="mx-1 mt-0.5 flex flex-col gap-1.5 rounded-lg bg-surface-overlay/30 p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
            className="input-base min-h-[52px] resize-y !text-[11px] leading-relaxed"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={async () => {
                const next = draft.trim();
                if (!next) { setAdding(false); return; }
                if (await settle(await addMemoryLine(target, hostname, next))) {
                  setAdding(false);
                  setDraft("");
                }
              }}
              disabled={!draft.trim()}
              className="rounded-md bg-accent/20 px-3 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent/30 disabled:opacity-40"
            >
              {t.save}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setErr(null); }}
              className="rounded-md px-3 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-overlay"
            >
              {t.cancel}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setErr(null); setEditing(null); setDraft(""); setAdding(true); }}
          className="mt-0.5 flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-secondary"
        >
          <Icon icon={iconPlus} className="text-[10px]" />
          {t.memoryAddEntry}
        </button>
      )}

      {err && (
        <p className="mt-0.5 px-1 text-[10px] leading-snug text-warning">{err}</p>
      )}
    </div>
  );
}

export default function SettingsView({ onBack, onShowUpdateIntro, onShowOnboarding }: Props) {
  const [subView, setSubView] = useState<'main' | 'data-backup' | 'usage'>('main');
  const [config, setConfig] = useState<ApiConfig>(DEFAULT_CONFIG);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sessionStats, setSessionStats] = useState<
    Array<{
      id: string;
      title: string;
      msgSize: number;
      fsSize: number;
      date: number;
      stale: boolean;
    }>
  >([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    items?: string[];
    confirmLabel: string;
    confirmColor?: "error" | "warning";
    onConfirm: () => void;
  } | null>(null);
  const [globalMem, setGlobalMem] = useState("");
  const [siteHosts, setSiteHosts] = useState<string[]>([]);
  const [expandedSite, setExpandedSite] = useState<string | null>(null);
  const [siteContent, setSiteContent] = useState("");
  const [sitePreview, setSitePreview] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<
    Array<{ id: string; content: string; ts: number }>
  >([]);
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [showCurate, setShowCurate] = useState(false);
  const [introSeen, setIntroSeen] = useState(true);
  const [undoTs, setUndoTs] = useState<number | null>(null);
  const [customActions, setCustomActions] = useState<Array<{ label: string; prompt: string }>>([]);
  const [newActionLabel, setNewActionLabel] = useState("");
  const [newActionPrompt, setNewActionPrompt] = useState("");
  const [addingAction, setAddingAction] = useState(false);
  const [showSkillImport, setShowSkillImport] = useState(false);
  const [importingSkill, setImportingSkill] = useState(false);
  const [importPreview, setImportPreview] = useState<{ name: string; description: string; files: string[] } | null>(null);
  const [importEntries, setImportEntries] = useState<{ path: string; content: string }[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  // Backup status for alert badge
  const [backupAlert, setBackupAlert] = useState(false);
  useEffect(() => {
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'backup:status' })
        .then((res: { status: string; paired: boolean }) => {
          setBackupAlert(res?.paired && res?.status !== 'connected')
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  // Reason: only the first load shows the loading placeholder — later
  // refreshes keep the current list rendered, otherwise every refresh
  // flashes "loading" over the stats section.
  const statsLoadedRef = useRef(false);
  const refreshStats = useCallback(async () => {
    if (!statsLoadedRef.current) setLoadingStats(true);
    try {
      const sessions = await loadSessionIndex();
      // Reason: staleness is decided once against the read timestamp — calling
      // Date.now() during render makes the derived counts unstable across
      // unrelated re-renders.
      const staleBefore = Date.now() - STALE_SESSION_MS;
      const stats = await Promise.all(
        sessions.map(async (s) => ({
          id: s.id,
          title: s.title || "Untitled",
          msgSize: await getSessionSize(s.id),
          fsSize: await getShellFsSize(s.id),
          date: s.updatedAt || s.createdAt,
          stale: (s.updatedAt || s.createdAt) < staleBefore,
        })),
      );
      stats.sort((a, b) => b.date - a.date);
      setSessionStats(stats);
      statsLoadedRef.current = true;
    } catch {
      /* ignore */
    }
    setLoadingStats(false);
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    loadConfig().then((c) => {
      if (!c) return;
      if (!c.profiles?.length) {
        const p = createProfile("Default");
        p.endpoint = c.endpoint;
        p.apiKey = c.apiKey;
        p.model = c.model;
        p.apiProtocol = c.apiProtocol;
        p.reasoningEffort = c.reasoningEffort;
        p.supportsImages = c.supportsImages;
        p.contextWindow = c.contextWindow;
        p.modelParams = c.modelParams;
        c.profiles = [p];
        c.activeProfileId = p.id;
      }
      applyColorMode(c.colorMode || "system");
      applyTheme(c.accentColor);
      applyFont(c.fontFamily || "sans", c.fontSize || "default");
      setConfig(c);
    });
  }, []);

  useEffect(() => {
    // Reason: replayed onboarding can save both model and theme; Settings must not overwrite those changes with a stale autosave.
    const changed = (changes: Record<string, chrome.storage.StorageChange>) => {
      const incoming = changes.sidekick_config?.newValue
      if (incoming && typeof incoming === "object") setConfig(current => ({ ...current, ...incoming }))
    }
    chrome.storage.local.onChanged.addListener(changed)
    return () => chrome.storage.local.onChanged.removeListener(changed)
  }, [])

  const refreshMemory = useCallback(() => {
    getGlobalMemory().then(setGlobalMem);
    getAllSiteHostnames().then(async (hosts) => {
      setSiteHosts(hosts);
      const previews: Record<string, string> = {};
      await Promise.all(hosts.map(async (h) => {
        const content = await getSiteMemory(h);
        previews[h] = content.replace(/\n/g, ' ').slice(0, 80);
      }));
      setSitePreview(previews);
    });
    getNotes().then(setNotes);
    getCurationUndoTs().then(setUndoTs).catch(() => {});
  }, []);

  // Reason: the expanded site editor needs its own content re-read after a write;
  // previews and the hostname list are refreshed too because deleting the last
  // entry of a site leaves an empty store that should drop out of the list.
  const refreshSiteMemory = useCallback(async (hostname: string) => {
    const content = await getSiteMemory(hostname);
    setSiteContent(content);
    setSitePreview((prev) => ({ ...prev, [hostname]: content.replace(/\n/g, ' ').slice(0, 80) }));
    const hosts = await getAllSiteHostnames();
    setSiteHosts(hosts);
  }, []);

  useEffect(() => {
    refreshMemory();
    chrome.storage.local.get('customActions').then(data => setCustomActions(data.customActions ?? []));
    chrome.storage.local.get('memoryIntroSeen').then(data => setIntroSeen(!!data.memoryIntroSeen));
  }, [refreshMemory]);

  const markIntroSeen = useCallback(() => {
    setIntroSeen(true);
    chrome.storage.local.set({ memoryIntroSeen: true }).catch(() => {});
  }, []);

  function autoSave(cfg: ApiConfig) {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveConfig(cfg), 300);
  }

  function updateField<K extends keyof ApiConfig>(key: K, value: ApiConfig[K]) {
    setConfig((prev) => {
      const next = { ...prev, [key]: value };
      const profileFields: (keyof ProviderProfile)[] = [
        "endpoint",
        "apiKey",
        "model",
        "reasoningEffort",
        "supportsImages",
        "contextWindow",
      ];
      if (
        profileFields.includes(key as keyof ProviderProfile) &&
        next.profiles?.length
      ) {
        next.profiles = next.profiles.map((p) =>
          p.id === next.activeProfileId ? { ...p, [key]: value } : p,
        );
      }
      autoSave(next);
      return next;
    });
  }

  function updateFields(patch: Partial<ApiConfig>) {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      autoSave(next);
      return next;
    });
  }

  async function handleDeleteSession(id: string) {
    await deleteSession(id);
    await deleteShellFs(id);
    await chrome.storage.local.remove(`history:${id}`);
    await refreshStats();
  }

  // Reason: batch deletion updates the index and refreshes the stats only once.
  async function handleCleanStale() {
    const staleIds = sessionStats
      .filter((s) => s.stale)
      .map((s) => s.id);
    if (staleIds.length === 0) return;
    await deleteSessions(staleIds);
    await Promise.all(staleIds.map(async (id) => {
      await deleteShellFs(id).catch(() => {});
      await chrome.storage.local.remove(`history:${id}`).catch(() => {});
    }));
    await refreshStats();
  }

  const totalBytes = sessionStats.reduce((s, r) => s + r.msgSize + r.fsSize, 0);
  const staleSessions = sessionStats.filter((s) => s.stale);
  const staleCount = staleSessions.length;
  const staleBytes = staleSessions.reduce((s, r) => s + r.msgSize + r.fsSize, 0);

  if (subView === 'data-backup') {
    return <DataView onBack={() => setSubView('main')} />
  }
  if (subView === 'usage') {
    return <UsageView onBack={() => setSubView('main')} />
  }

  return (
    <div className="flex min-h-full flex-col bg-surface">
      <div className="sticky top-0 z-10 shrink-0 bg-surface px-3 pt-3 pb-2">
        <div className="flex items-center gap-2 px-1">
          {onBack && (
            <button
              onClick={onBack}
              className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"
            >
              <Icon icon={iconArrowLeft} className="text-base" />
            </button>
          )}
          <h2 className="text-sm font-semibold text-text-primary">
            {t.settings}
          </h2>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
        <Section id="s-provider" title={t.provider}>
          <ModelServices config={config} onChange={async next => {
            clearTimeout(saveTimerRef.current);
            await saveConfig(next);
            setConfig(next);
          }} />
          <AdvancedSettings title={t.advancedProvider}>
            <Toggle on={config.requestIdentity?.enabled === true} label={t.requestIdentity} description={t.requestIdentityDesc} onChange={() => updateFields({ requestIdentity: { enabled: config.requestIdentity?.enabled !== true, userAgent: config.requestIdentity?.userAgent } })} />
            {config.requestIdentity?.enabled && <Field label={t.requestIdentityUa} hint={t.requestIdentityUaHint}><input type="text" value={config.requestIdentity?.userAgent ?? ""} onChange={e => updateFields({ requestIdentity: { enabled: true, userAgent: e.target.value } })} placeholder={t.requestIdentityUaPlaceholder} className="input-base font-mono !text-[11px]" /></Field>}
          </AdvancedSettings>
        </Section>

        {/* 外观 */}
        <Section id="s-appearance" title={t.appearance}>
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-2 text-[11px] text-text-secondary">
                {t.accentColor}
              </p>
              <div className="flex flex-wrap gap-3">
                {THEME_PRESETS.map((theme) => {
                  const mode = getResolvedThemeMode();
                  const values = resolveThemeValues(theme.id, mode);
                  const material =
                    theme.material[mode === "light" ? "light" : "dark"];
                  const selected =
                    normalizeThemeId(config.accentColor) === theme.id;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      title={`${theme.hint} · 圆角 ${theme.shape.radiusLg} · 玻璃 ${theme.shape.blur}`}
                      aria-label={theme.label}
                      aria-pressed={selected}
                      onClick={() => {
                        updateField("accentColor", theme.id);
                        applyTheme(theme.id);
                      }}
                      className="group flex flex-col items-center gap-1.5"
                    >
                      <span
                        className="relative flex h-8 w-11 items-center justify-center border transition-transform group-hover:scale-105 group-active:scale-95"
                        style={{
                          backgroundColor: values.surface,
                          borderColor: values.borderSubtle,
                          borderWidth: theme.shape.borderWidth,
                          borderRadius: theme.shape.radiusLg,
                          boxShadow: selected
                            ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${values.accent}`
                            : material.shadowRaised,
                        }}
                      >
                        <span
                          className="absolute inset-x-1.5 top-1.5 h-1"
                          style={{
                            backgroundColor: values.surfaceRaised,
                            borderRadius: theme.shape.radiusSm,
                          }}
                        />
                        <span className="mt-2 flex items-center gap-1">
                          <span
                            className="text-[10px] leading-none"
                            style={{ color: values.textPrimary }}
                          >
                            Aa
                          </span>
                          <span
                            className="h-2.5 w-2.5"
                            style={{
                              backgroundColor: values.accent,
                              borderRadius: theme.shape.radiusXs,
                            }}
                          />
                        </span>
                      </span>
                      <span
                        className={`flex items-center gap-0.5 text-[10px] leading-none ${selected ? "text-accent" : "text-text-muted"}`}
                      >
                        {theme.label}
                        {selected && <Icon icon={iconCheck} className="text-[9px]" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[11px] text-text-secondary">
                {t.colorMode}
              </p>
              <div className="flex gap-1.5">
                {(
                  [
                    ["system", t.colorModeSystem],
                    ["light", t.colorModeLight],
                    ["dark", t.colorModeDark],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => {
                      updateField("colorMode", id);
                      applyColorMode(id);
                    }}
                    className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${(config.colorMode || "system") === id ? "bg-accent-wash text-accent ring-1 ring-accent/30" : "bg-surface-overlay text-text-secondary hover:text-text-primary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <p className="mb-2 text-[11px] text-text-secondary">{t.font}</p>
                <div className="flex gap-1.5">
                  {(
                    [
                      ["sans", t.fontSans],
                      ["serif", t.fontSerif],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => {
                        updateField("fontFamily", id);
                        applyFont(id, config.fontSize || "default");
                      }}
                      className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${config.fontFamily === id ? "bg-accent-wash text-accent ring-1 ring-accent/30" : "bg-surface-overlay text-text-secondary hover:text-text-primary"}`}
                      style={{
                        fontFamily:
                          id === "serif"
                            ? "Georgia, serif"
                            : "var(--font-sans)",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1">
                <p className="mb-2 text-[11px] text-text-secondary">
                  {t.fontSize}
                </p>
                <div className="flex gap-1.5">
                  {(
                    [
                      ["compact", t.sizeCompact],
                      ["default", t.sizeDefault],
                      ["relaxed", t.sizeRelaxed],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => {
                        updateField("fontSize", id);
                        applyFont(config.fontFamily || "sans", id);
                      }}
                      className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${config.fontSize === id ? "bg-accent-wash text-accent ring-1 ring-accent/30" : "bg-surface-overlay text-text-secondary hover:text-text-primary"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <Toggle
              on={config.pageLockIndicator !== false}
              label={t.pageLockIndicator}
              description={t.pageLockIndicatorDesc}
              onChange={() =>
                updateField("pageLockIndicator", config.pageLockIndicator === false ? true : false)
              }
            />
            <Toggle
              on={config.aiPointer !== false}
              label={t.aiPointer}
              description={t.aiPointerDesc}
              onChange={() => updateField("aiPointer", config.aiPointer === false)}
            />
            <Toggle
              on={config.collapseSteps !== false}
              label={t.collapseSteps}
              description={t.collapseStepsDesc}
              onChange={() => updateField("collapseSteps", config.collapseSteps === false)}
            />
            <Toggle
              on={config.toolCallDisplay !== "raw"}
              label={t.toolCallDisplay}
              description={t.toolCallDisplayDesc}
              onChange={() => updateField("toolCallDisplay", config.toolCallDisplay === "raw" ? "description" : "raw")}
            />
            <Toggle
              on={!!config.labSingleDollarMath}
              label={t.singleDollarMath}
              description={t.singleDollarMathDesc}
              onChange={() => updateField("labSingleDollarMath", !config.labSingleDollarMath)}
            />
          </div>
        </Section>

        <Section id="s-conversation" title={t.conversation}>
          <div className="flex flex-col gap-3">
            <Field label={t.systemPrompt} hint={t.systemPromptHint}>
              <textarea
                value={config.systemPrompt}
                onChange={(e) => updateField("systemPrompt", e.target.value)}
                placeholder={t.systemPromptPlaceholder}
                rows={2}
                className="input-base min-h-[48px] resize-y !text-[12px] leading-relaxed"
              />
            </Field>
            <Toggle
              on={config.notifyOnComplete !== false}
              label={t.notifyOnComplete}
              description={t.notifyOnCompleteDesc}
              onChange={() =>
                updateField("notifyOnComplete", config.notifyOnComplete === false ? true : false)
              }
            />
            <AdvancedSettings title={t.advancedConversation}>
              <Field label={t.maxToolRounds} hint={t.roundsHint}>
                <input
                  type="number"
                  value={config.maxToolRounds || ""}
                  onChange={(e) => updateField("maxToolRounds", Number(e.target.value) || 0)}
                  min={0}
                  step={1}
                  placeholder={t.defaultToolRounds}
                  className="input-base"
                />
              </Field>
              <Toggle
                on={config.labAutoCompress !== false}
                label={t.autoCompress}
                description={t.autoCompressDesc}
                onChange={() => updateField("labAutoCompress", config.labAutoCompress === false)}
              />
            </AdvancedSettings>
          </div>
        </Section>

        <Section id="s-files" title={t.files}>
          <Toggle
            on={!!config.labImageFs}
            label={t.imageFs}
            description={t.imageFsDesc}
            onChange={() => updateField("labImageFs", !config.labImageFs)}
          />
          <Toggle
            on={config.largeFileUploads !== false}
            label={t.largeFileUploads}
            description={t.largeFileUploadsDesc}
            onChange={() => updateField("largeFileUploads", config.largeFileUploads === false)}
          />
        </Section>

        {/* 快捷指令 */}
        <Section id="s-actions" title={`${t.quickActions} (${customActions.length})`} hint={t.quickActionsHint}>
          <div className="flex flex-col gap-1">
            {customActions.map((action, idx) => (
              <div key={idx} className="group flex items-center gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-1">
                <span className="flex-1 truncate text-[10px] text-text-secondary">{action.label}</span>
                <button
                  type="button"
                  aria-label={`删除快捷指令：${action.label}`}
                  onClick={async () => {
                    const updated = customActions.filter((_, i) => i !== idx)
                    setCustomActions(updated)
                    await chrome.storage.local.set({ customActions: updated })
                  }}
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted opacity-0 transition-opacity hover:text-error group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Icon icon={iconClose} className="text-[9px]" />
                </button>
              </div>
            ))}
            {addingAction ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] bg-surface-overlay/30 p-2">
                <input
                  value={newActionLabel}
                  onChange={e => setNewActionLabel(e.target.value)}
                  placeholder="名称"
                  className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent/40"
                />
                <textarea
                  value={newActionPrompt}
                  onChange={e => setNewActionPrompt(e.target.value)}
                  placeholder="提示词"
                  rows={2}
                  className="resize-none rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent/40"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={async () => {
                      if (!newActionLabel.trim() || !newActionPrompt.trim()) return
                      const updated = [...customActions, { label: newActionLabel.trim(), prompt: newActionPrompt.trim() }]
                      setCustomActions(updated)
                      await chrome.storage.local.set({ customActions: updated })
                      setNewActionLabel(""); setNewActionPrompt(""); setAddingAction(false)
                    }}
                    disabled={!newActionLabel.trim() || !newActionPrompt.trim()}
                    className="rounded-md bg-accent/20 px-3 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent/30 disabled:opacity-40"
                  >
                    添加
                  </button>
                  <button
                    onClick={() => { setNewActionLabel(""); setNewActionPrompt(""); setAddingAction(false) }}
                    className="rounded-md px-3 py-1 text-[10px] text-text-muted transition-colors hover:bg-white/[0.04]"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingAction(true)}
                className="flex items-center gap-1 self-start rounded-md px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-white/[0.04] hover:text-text-secondary"
              >
                <Icon icon={iconPlus} className="text-xs" />
                添加快捷指令
              </button>
            )}
          </div>
        </Section>

        {/* 技能 */}
        <Section id="s-skills" title={t.skills} hint={t.skillsHint}>
          <div className="flex flex-col gap-1">
            {Array.from(skillRegistry.values()).map((skill) => {
              const disabled =
                config.disabledSkills?.includes(skill.name) ?? false;
              return (
                <div
                  key={skill.name}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.03]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      const current = config.disabledSkills ?? [];
                      updateField(
                        "disabledSkills",
                        disabled
                          ? current.filter((s) => s !== skill.name)
                          : [...current, skill.name],
                      );
                    }}
                    className={`flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${!disabled ? "bg-accent" : "bg-surface-overlay"}`}
                  >
                    <div
                      className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${!disabled ? "translate-x-3.5" : "translate-x-0.5"}`}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-text-primary">
                      {skill.name}
                      <span
                        className={`rounded-sm px-1 py-px text-[9px] font-medium leading-tight ${skill.mode === "pro" ? "bg-orange-500/15 text-orange-400" : skill.mode === "chat" ? "bg-blue-500/15 text-blue-400" : "bg-white/[0.08] text-text-muted"}`}
                      >
                        {skill.mode === "pro"
                          ? "Pro"
                          : skill.mode === "chat"
                            ? "Chat"
                            : "All"}
                      </span>
                      {skill.isUser && (
                        <span className="rounded-sm bg-green-500/15 px-1 py-px text-[9px] font-medium leading-tight text-green-400">
                          User
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[10px] text-text-muted">
                      {skill.description}
                    </p>
                  </div>
                  {skill.isUser && (
                    <button
                      type="button"
                      onClick={async () => {
                        const skills = getExportableSkills([skill.name]);
                        if (skills.length === 0) return;
                        const s = skills[0];
                        const md = `---\nname: ${s.name}\ndescription: ${s.description}\nmode: all\n---\n\n${s.content}\n`;
                        const entries = [{ path: `${s.name}/SKILL.md`, content: md }];
                        if (s.files) {
                          for (const [relPath, content] of Object.entries(s.files)) {
                            entries.push({ path: `${s.name}/${relPath}`, content });
                          }
                        }
                        const blob = await createTarGz(entries);
                        downloadBlob(blob, `${s.name}.tar.gz`);
                      }}
                      className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"
                      title="Export skill"
                    >
                      <Icon icon={iconDownload} className="text-xs" />
                    </button>
                  )}
                  {skill.isUser && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDialog({
                          title: t.deleteSkill,
                          message: `确认删除技能「${skill.name}」？删除后不可恢复。`,
                          confirmLabel: "删除",
                          confirmColor: "error",
                          onConfirm: async () => {
                            await removeUserSkill(skill.name);
                            setConfig({ ...config });
                          },
                        });
                      }}
                      className="shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
                      title={t.deleteSkill}
                    >
                      <Icon icon={iconDelete} className="text-xs" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-between px-2">
            <p className="text-[10px] text-text-muted">{t.skillsHint}</p>
            <button
              type="button"
              onClick={() => setShowSkillImport(true)}
              className="flex items-center gap-1 rounded-md border border-accent/20 bg-accent/[0.06] px-2 py-1 text-[10px] font-medium text-accent transition-all hover:border-accent/40 hover:bg-accent/[0.12] active:scale-[0.96]"
            >
              <Icon icon={iconCloudUpload} className="text-xs" />
              {t.importSkill}
            </button>
          </div>
        </Section>

        {/* 记忆 */}
        <Section id="s-memory" title={t.memory} hint={t.memoryHint}>
          <div className="flex flex-col gap-3">
            {!introSeen && (globalMem || siteHosts.length > 0 || notes.length > 0) && (
              <div className="flex items-center gap-2 rounded-lg border border-accent/20 bg-accent/[0.06] px-2.5 py-2">
                <p className="flex-1 text-[10px] leading-snug text-text-secondary">{t.memoryCurateBanner}</p>
                <button
                  type="button"
                  onClick={() => setShowCurate(true)}
                  className="shrink-0 rounded-md bg-accent/20 px-2 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent/30"
                >
                  {t.memoryCurate}
                </button>
                <button
                  type="button"
                  onClick={markIntroSeen}
                  className="shrink-0 rounded-md px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-overlay"
                >
                  {t.memoryCurateGotIt}
                </button>
              </div>
            )}
            <div>
              <p className="mb-1 flex items-center gap-2 text-[11px] font-medium text-text-secondary">
                {t.memoryGlobal}
                <span className="text-[9px] text-text-muted">
                  {globalMem.length}/{GLOBAL_LIMIT}
                </span>
              </p>
              <MemoryLines target="global" text={globalMem} onRefresh={refreshMemory} />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium text-text-secondary">
                {t.memorySites} ({siteHosts.length})
              </p>
              {siteHosts.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {siteHosts.map((h) => (
                    <div key={h}>
                      <div
                        onClick={async () => {
                          if (expandedSite === h) { setExpandedSite(null); return }
                          const content = await getSiteMemory(h)
                          setSiteContent(content)
                          setExpandedSite(h)
                        }}
                        className="group flex cursor-pointer items-center gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-1"
                      >
                        <span className="shrink-0 font-mono text-[9px] text-text-muted">{h}</span>
                        <span className="flex-1 truncate text-[10px] text-text-secondary">{sitePreview[h] || ''}</span>
                        <button
                          type="button"
                          aria-label={`删除站点记忆：${h}`}
                          onClick={async (e) => {
                            e.stopPropagation();
                            await deleteSiteMemory(h);
                            setSiteHosts((prev) => prev.filter((x) => x !== h));
                            if (expandedSite === h) setExpandedSite(null);
                          }}
                          className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted opacity-0 transition-opacity hover:text-error group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                        >
                          <Icon icon={iconClose} className="text-[9px]" />
                        </button>
                      </div>
                      {expandedSite === h && (
                        <div className="mx-1 mt-0.5 rounded-lg bg-surface-overlay/30 p-2">
                          <p className="mb-1 text-[9px] text-text-muted">
                            {siteContent.length}/{SITE_LIMIT}
                          </p>
                          <MemoryLines
                            target="site"
                            hostname={h}
                            text={siteContent}
                            onRefresh={() => refreshSiteMemory(h)}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-text-muted">{t.noSiteMemory}</p>
              )}
            </div>
            <div>
              <p className="mb-1 flex items-center gap-2 text-[11px] font-medium text-text-secondary">
                <span>{t.memoryNotes} ({notes.length})</span>
                <button
                  type="button"
                  onClick={() => setShowCurate(true)}
                  className="ml-auto flex items-center gap-1 rounded-md border border-accent/20 bg-accent/[0.06] px-2 py-0.5 text-[10px] font-medium text-accent transition-all hover:border-accent/40 hover:bg-accent/[0.12] active:scale-[0.96]"
                >
                  {t.memoryCurate}
                </button>
              </p>
              {notes.length > 0 ? (
                <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                  {notes.slice(0, 20).map((n) => (
                    <div key={n.id}>
                      <div
                        onClick={() => {
                          if (expandedNote === n.id) { setExpandedNote(null); return }
                          setNoteDraft(n.content)
                          setExpandedNote(n.id)
                        }}
                        className="group flex cursor-pointer items-center gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-1 transition-colors hover:bg-surface-overlay"
                      >
                        <span className="font-mono text-[9px] text-text-muted">
                          {n.id}
                        </span>
                        <span className="flex-1 truncate text-[10px] text-text-secondary">
                          {n.content}
                        </span>
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            await removeNote(n.id);
                            setNotes((prev) => prev.filter((x) => x.id !== n.id));
                            if (expandedNote === n.id) setExpandedNote(null);
                          }}
                          className="shrink-0 text-text-muted hover:text-red-400"
                        >
                          <Icon icon={iconClose} className="text-[9px]" />
                        </button>
                      </div>
                      {expandedNote === n.id && (
                        <div className="mx-1 mt-0.5 flex flex-col gap-1.5 rounded-lg bg-surface-overlay/30 p-2">
                          <textarea
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            rows={4}
                            autoFocus
                            className="input-base min-h-[64px] resize-y !text-[11px] leading-relaxed"
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={async () => {
                                const content = noteDraft.trim();
                                if (!content || content === n.content) { setExpandedNote(null); return }
                                const ok = await updateNote(n.id, content);
                                if (ok) {
                                  setNotes((prev) => prev.map((x) => x.id === n.id ? { ...x, content, ts: Date.now() } : x));
                                }
                                setExpandedNote(null);
                              }}
                              disabled={!noteDraft.trim()}
                              className="rounded-md bg-accent/20 px-3 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent/30 disabled:opacity-40"
                            >
                              {t.save}
                            </button>
                            <button
                              type="button"
                              onClick={() => setExpandedNote(null)}
                              className="rounded-md px-3 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-overlay"
                            >
                              {t.cancel}
                            </button>
                            <span className="ml-auto text-[9px] tabular-nums text-text-muted/60">
                              {new Date(n.ts).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-text-muted">{t.noNotes}</p>
              )}
            </div>
          </div>
          {undoTs !== null && (
            <button
              type="button"
              onClick={async () => {
                const res = await chrome.runtime.sendMessage({ type: "memory:undo-curation" }) as { ok: boolean };
                if (res?.ok) refreshMemory();
              }}
              className="mt-2 flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-text-primary"
            >
              <Icon icon={iconBackupRestore} className="text-[11px]" />
              {t.memoryCurateUndo} · {relativeTime(undoTs)}
            </button>
          )}
          <p className="mt-2 text-[10px] text-text-muted">{t.memoryHint}</p>
        </Section>

        {/* 权限 */}
        <Section id="s-permissions" title={t.permissions} hint={t.permissionsHint}>
          <fieldset className="mb-4">
            <legend className="text-xs font-medium text-text-primary">新对话默认权限</legend>
            <p className="mt-1 mb-2 text-[11px] leading-relaxed text-text-muted">仅用于新建对话；当前对话可在输入框旁切换权限。</p>
            <div className="flex flex-col gap-1">
              {PERMISSION_MODES.map(mode => (
                <label key={mode} className={`flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 transition-colors ${resolveDefaultPermissionMode(config) === mode ? "bg-accent-wash" : "hover:bg-surface-overlay"}`}>
                  <input type="radio" name="default-permission-mode" value={mode} checked={resolveDefaultPermissionMode(config) === mode}
                    onChange={() => updateField("defaultPermissionMode", mode)} className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-accent)]" />
                  <span className="min-w-0"><span className="block text-xs font-medium text-text-primary">{PERMISSION_MODE_LABELS[mode]}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">{PERMISSION_MODE_DESCRIPTIONS[mode]}{mode === "auto" && "；审批会额外调用模型，消耗 token，可能产生额外费用。"}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <Toggle
            on={!!config.labFetch}
            label={t.labFetch}
            description={config.labFetch ? t.labFetchOn : t.labFetchOff}
            color="error"
            onChange={() => {
              if (!config.labFetch) {
                setConfirmDialog({
                  title: t.labFetch,
                  message: t.labFetchWarn,
                  items: [...t.labFetchRisks],
                  confirmLabel: t.labFetchConfirm,
                  confirmColor: "error",
                  onConfirm: () => updateField("labFetch", true),
                });
              } else {
                updateField("labFetch", false);
              }
            }}
          />
          <SitePermissionList />
        </Section>

        <McpSection
          servers={config.mcpServers ?? []}
          onChange={(servers: McpServerConfig[]) => updateField('mcpServers', servers)}
        />

        <Section id="s-developer" title={t.developer} hint={t.developerHint}>
          <Toggle
            on={config.devMode}
            label={t.devTools}
            description={t.devToolsDesc}
            onChange={() => updateField("devMode", !config.devMode)}
          />
          <AdvancedSettings title={t.compatibility} hint={t.compatibilityHint}>
            <Toggle
              on={config.labKernelHost !== "panel"}
              label={t.kernelHost}
              description={t.kernelHostDesc}
              onChange={() => updateField("labKernelHost", config.labKernelHost === "panel" ? "offscreen" : "panel")}
            />
            <Toggle
              on={config.labInputEngine !== false}
              label={t.inputEngine}
              description={t.inputEngineDesc}
              onChange={() => updateField("labInputEngine", config.labInputEngine === false)}
            />
            <Toggle
              on={config.labAsyncScript !== false}
              label={t.asyncScript}
              description={t.asyncScriptDesc}
              onChange={() => updateField("labAsyncScript", config.labAsyncScript === false)}
            />
            <Toggle
              on={config.labBackendCompat !== false}
              label={t.backendCompat}
              description={t.backendCompatDesc}
              onChange={() => updateField("labBackendCompat", config.labBackendCompat === false)}
            />
          </AdvancedSettings>
        </Section>

        {/* 数据与备份 */}
        <Section title="数据与备份">
          <button
            onClick={() => setSubView('usage')}
            className="group -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-overlay/60"
          >
            <Icon icon={iconChartBar} className="text-base text-text-muted transition-colors group-hover:text-accent" />
            <span className="min-w-0 flex-1 text-[12px] font-medium text-text-primary">用量统计</span>
            <Icon icon={iconChevronRight} className="shrink-0 text-xs text-text-muted/50 transition-colors group-hover:text-text-muted" />
          </button>
          <button
            onClick={() => setSubView('data-backup')}
            className="group -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-overlay/60"
          >
            <div className="relative">
              <Icon icon={iconBackupRestore} className="text-base text-text-muted transition-colors group-hover:text-accent" />
              {backupAlert && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-warning" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-text-primary">导入导出、本地备份服务</p>
            </div>
            <Icon icon={iconChevronRight} className="shrink-0 text-xs text-text-muted/50 transition-colors group-hover:text-text-muted" />
          </button>
        </Section>

        {/* 数据 */}
        <Section id="s-data" title={t.data} hint={t.dataHint}>
          {loadingStats ? (
            <p className="text-[11px] text-text-muted">{t.loading}</p>
          ) : (
            <>
              {totalBytes > 8 * 1024 * 1024 && staleCount > 0 && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
                  <p className="flex-1 text-[11px] text-warning">
                    {t.storageWarn(formatSize(staleBytes), staleCount)}
                  </p>
                  <button
                    onClick={handleCleanStale}
                    className="shrink-0 rounded-md bg-warning/20 px-2 py-1 text-[10px] font-medium text-warning transition-colors hover:bg-warning/30"
                  >
                    {t.clean}
                  </button>
                </div>
              )}
              <div className="mb-2 flex items-baseline justify-between">
                <p className="text-[11px] text-text-secondary">
                  {sessionStats.length} {t.sessions}，{formatSize(totalBytes)}
                </p>
                {staleCount > 0 && (
                  <button
                    onClick={() => {
                      setConfirmDialog({
                        title: t.cleanOld,
                        message: t.cleanConfirm(staleCount),
                        confirmLabel: t.clean,
                        confirmColor: "warning",
                        onConfirm: handleCleanStale,
                      });
                    }}
                    className="text-[10px] text-text-muted transition-colors hover:text-error"
                  >
                    {t.cleanOld}
                  </button>
                )}
              </div>
              {sessionStats.length === 0 ? (
                <p className="text-[11px] text-text-muted">{t.noSessions}</p>
              ) : (
                <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto">
                  {sessionStats.map((s) => (
                    <div
                      key={s.id}
                      className="group flex items-center gap-2 rounded-lg bg-surface-overlay/50 px-2.5 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium text-text-primary">
                          {s.title}
                        </p>
                        <p className="text-[10px] text-text-muted">
                          {formatSize(s.msgSize + s.fsSize)} ·{" "}
                          {relativeTime(s.date)}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteSession(s.id)}
                        title={t.deleteSession}
                        className="shrink-0 rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-error/10 hover:text-error group-hover:opacity-100"
                      >
                        <Icon icon={iconDelete} className="text-sm" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Section>

        {(onShowOnboarding || onShowUpdateIntro) && <div className="flex flex-wrap items-center justify-center gap-2">
          {onShowOnboarding && <button type="button" onClick={onShowOnboarding} className="rounded-md px-3 py-2 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay hover:text-accent">查看新手引导</button>}
          {onShowUpdateIntro && <button type="button" onClick={onShowUpdateIntro} className="rounded-md px-3 py-2 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay hover:text-accent">查看本次更新</button>}
        </div>}
        <p className="select-all py-2 text-center text-[9px] text-text-muted/40">
          build {__BUILD_HASH__} · ai-sdk {__AI_SDK_VERSION__} · just-bash {__JUST_BASH_VERSION__}
        </p>
      </div>

      <AppDialog open={!!confirmDialog} title={confirmDialog?.title ?? '确认操作'} onClose={() => setConfirmDialog(null)} footer={<>
        <DialogAction onClick={() => setConfirmDialog(null)}>{t.cancel}</DialogAction>
        <DialogAction variant={confirmDialog?.confirmColor === 'error' ? 'danger' : 'primary'} onClick={() => { confirmDialog?.onConfirm(); setConfirmDialog(null) }}>{confirmDialog?.confirmLabel}</DialogAction>
      </>}>
        <p className="text-xs leading-relaxed text-text-secondary">{confirmDialog?.message}</p>
        {confirmDialog?.items && <ul className="mt-3 space-y-1 text-xs text-text-muted">{confirmDialog.items.map((item, i) => <li key={i}>• {item}</li>)}</ul>}
      </AppDialog>

      <MemoryCurationSheet
        open={showCurate}
        onClose={() => setShowCurate(false)}
        config={config}
        showIntro={!introSeen}
        onIntroSeen={markIntroSeen}
        onApplied={refreshMemory}
      />

      <AppDialog open={showSkillImport} placement="bottom" title={t.importSkillTitle} dismissible={!importingSkill} onClose={() => { setShowSkillImport(false); setImportPreview(null); setImportError(null) }} footer={<>
        <DialogAction disabled={importingSkill} onClick={() => { setShowSkillImport(false); setImportPreview(null); setImportError(null) }}>{t.cancel}</DialogAction>
        {importPreview && <DialogAction variant="primary" disabled={importingSkill} onClick={async () => {
          setImportingSkill(true)
          try {
            const result = await importSkillFromEntries(importEntries)
            if ('error' in result) { setImportError(result.error); setImportPreview(null) }
            else { setShowSkillImport(false); setImportPreview(null); setImportError(null); setConfig({ ...config }) }
          } catch { setImportError('导入失败，请重试。') }
          finally { setImportingSkill(false) }
        }}><Icon icon={iconDownload} />{importingSkill ? '正在导入…' : t.importConfirm}</DialogAction>}
      </>}>
          <p className="mb-4 text-xs text-text-muted">SKILL.md + 附属文件</p>
          {!importPreview && !importError && (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-white/[0.06] bg-surface/50 px-3 py-4 transition-all hover:border-accent/30 hover:bg-accent/[0.04]"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-overlay transition-colors group-hover:bg-accent/15">
                  <Icon icon={iconFolderOpen} className="text-xl text-text-muted transition-colors group-hover:text-accent" />
                </div>
                <span className="text-[11px] font-medium text-text-secondary">{t.selectFolder}</span>
              </button>
              <button
                type="button"
                onClick={() => archiveInputRef.current?.click()}
                className="group flex flex-1 flex-col items-center gap-2 rounded-xl border border-white/[0.06] bg-surface/50 px-3 py-4 transition-all hover:border-accent/30 hover:bg-accent/[0.04]"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-overlay transition-colors group-hover:bg-accent/15">
                  <Icon icon={iconFileArchive} className="text-xl text-text-muted transition-colors group-hover:text-accent" />
                </div>
                <span className="text-[11px] font-medium text-text-secondary">{t.selectArchive}</span>
              </button>
            </div>
          )}
          {importError && (
            <div className="flex items-start gap-2.5 rounded-lg bg-error/[0.08] px-3.5 py-3">
              <Icon icon={iconAlertCircleOutline} className="mt-px shrink-0 text-sm text-error/80" />
              <p className="text-[12px] leading-relaxed text-error/90">{importError}</p>
            </div>
          )}
          {importPreview && (
            <div className="rounded-lg border border-accent/20 bg-accent/[0.04] p-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15">
                  <Icon icon={iconPuzzle} className="text-base text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-text-primary">{importPreview.name}</p>
                  <p className="truncate text-[11px] text-text-muted">{importPreview.description}</p>
                </div>
              </div>
              {importPreview.files.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-white/[0.06] pt-2.5">
                  {importPreview.files.slice(0, 8).map(f => (
                    <div key={f} className="flex items-center gap-1.5">
                      <Icon icon={iconFileDocument} className="shrink-0 text-[11px] text-text-muted/60" />
                      <p className="truncate font-mono text-[10px] text-text-muted">{f.split('/').pop()}</p>
                    </div>
                  ))}
                  {importPreview.files.length > 8 && (
                    <p className="pl-5 text-[10px] text-text-muted/60">+{importPreview.files.length - 8} more</p>
                  )}
                </div>
              )}
            </div>
          )}
      </AppDialog>

      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
        onChange={async (e) => {
          const files = e.target.files
          if (!files || files.length === 0) return
          const entries: { path: string; content: string }[] = []
          for (let i = 0; i < files.length; i++) {
            const f = files[i]
            const text = await f.text()
            entries.push({ path: f.webkitRelativePath || f.name, content: text })
          }
          e.target.value = ''
          setImportEntries(entries)
          const skillEntry = entries.find(en => en.path.endsWith('SKILL.md'))
          if (!skillEntry) {
            setImportError('未找到 SKILL.md 文件')
            setImportPreview(null)
            return
          }
          const { name, description } = parseFrontmatter(skillEntry.content)
          if (!name) { setImportError('SKILL.md 缺少 name 字段'); setImportPreview(null); return }
          setImportPreview({ name, description, files: entries.filter(en => en !== skillEntry).map(en => en.path) })
          setImportError(null)
        }}
      />
      <input
        ref={archiveInputRef}
        type="file"
        accept=".tar.gz,.tgz,.md"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          e.target.value = ''
          let entries: { path: string; content: string }[]
          if (file.name.endsWith('.md')) {
            const text = await file.text()
            entries = [{ path: 'SKILL.md', content: text }]
          } else {
            entries = await parseTarGz(file)
          }
          setImportEntries(entries)
          const skillEntry = entries.find(en => en.path.endsWith('SKILL.md'))
          if (!skillEntry) {
            setImportError('未找到 SKILL.md 文件')
            setImportPreview(null)
            return
          }
          const { name, description } = parseFrontmatter(skillEntry.content)
          if (!name) { setImportError('SKILL.md 缺少 name 字段'); setImportPreview(null); return }
          setImportPreview({ name, description, files: entries.filter(en => en !== skillEntry).map(en => en.path) })
          setImportError(null)
        }}
      />
    </div>
  );
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id?: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const [showHint, setShowHint] = useState(false);
  return (
    <section id={id} className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3 scroll-mt-14">
      <h3 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-text-muted">
        {title}
        {hint && (
          <span className="relative">
            <span
              onMouseEnter={() => setShowHint(true)}
              onMouseLeave={() => setShowHint(false)}
              className="cursor-help text-[11px] text-text-muted/50 transition-colors hover:text-accent"
            >&#x24D8;</span>
            {showHint && (
              <span className="theme-raised absolute left-5 top-1/2 z-30 -translate-y-1/2 whitespace-nowrap rounded-md border border-white/[0.08] bg-surface-raised px-2.5 py-1.5 text-[10px] font-normal text-text-secondary">
                {hint}
              </span>
            )}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

function AdvancedSettings({ title, hint, children }: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/advanced rounded-lg border border-border-subtle bg-surface-overlay/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-[11px] font-medium text-text-secondary transition-colors marker:hidden hover:bg-surface-overlay/50 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        {title}
        <Icon icon={iconChevronDown} className="shrink-0 -rotate-90 text-xs text-text-muted transition-transform group-open/advanced:rotate-0" />
      </summary>
      <div className="flex flex-col gap-3 border-t border-border-subtle px-3 py-3">
        {hint && <p className="text-[11px] leading-relaxed text-text-muted">{hint}</p>}
        {children}
      </div>
    </details>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </label>
  );
}

function Toggle({
  on,
  label,
  description,
  color,
  onChange,
}: {
  on: boolean;
  label: string;
  description?: string;
  color?: "accent" | "error";
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.03]"
    >
      <div
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${on ? (color === "error" ? "bg-error" : "bg-accent") : "bg-surface-overlay"}`}
      >
        <div
          className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}`}
        />
      </div>
      <div>
        <p className="text-xs font-medium text-text-primary">{label}</p>
        {description && (
          <p className="mt-0.5 text-[11px] leading-snug text-text-muted">
            {description}
          </p>
        )}
      </div>
    </button>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

// Origins granted "always allow" — listed for audit, revocable per site
function SitePermissionList() {
  const [perms, setPerms] = useState<SitePermissions>({});

  const refresh = useCallback(() => {
    loadSitePermissions().then(setPerms).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Reason: grants happen in the consent dialog while settings may be open
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.sitePermissions) refresh();
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => chrome.storage.local.onChanged.removeListener(onChanged);
  }, [refresh]);

  const origins = Object.keys(perms).sort();
  if (origins.length === 0) return null;

  return (
    <div className="mt-1 border-t border-white/[0.06] pt-3">
      <p className="mb-2 text-[11px] font-medium text-text-secondary">
        已授权站点（免确认操作）
      </p>
      <div className="space-y-1">
        {origins.map((origin) => (
          <div
            key={origin}
            className="group flex items-center gap-2 rounded-lg border border-white/[0.06] bg-surface/50 px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-text-primary">
                {new URL(origin).hostname}
              </p>
              <p className="text-[10px] text-text-muted">
                {perms[origin].allowedTools.length} 项操作 · 授权于{" "}
                {relativeTime(perms[origin].grantedAt)}
                {perms[origin].lastUsedAt
                  ? ` · 最近使用 ${relativeTime(perms[origin].lastUsedAt!)}`
                  : ""}
              </p>
            </div>
            <button
              onClick={() => revokeSitePermission(origin).then(refresh)}
              title="撤销授权"
              className="shrink-0 rounded-md p-1 text-text-muted/60 transition-colors hover:bg-surface-overlay hover:text-error"
            >
              <Icon icon={iconDelete} className="text-sm" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
