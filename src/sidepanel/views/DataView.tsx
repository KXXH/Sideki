import AppDialog, { DialogAction } from '../components/AppDialog'
import { useState, useRef, useEffect, useCallback } from 'react'
import { Icon } from '@iconify/react'
import {
  iconArrowLeft,
  iconDownload,
  iconUpload,
  iconCheck,
  iconAlertCircleOutline,
  iconLinkVariant,
  iconLinkOff,
  iconLoading,
} from '../../shared/icons'
import {
  exportAllData,
  importAllData,
  downloadBlob,
  formatBackupFilename,
} from '../../shared/data-transfer'
import type { ImportResult } from '../../shared/data-transfer'

interface Props {
  onBack: () => void
}

type ImportMode = 'replace' | 'merge'
type BackupStatus = 'connected' | 'connecting' | 'disconnected' | 'suspended'

interface SyncState {
  phase: 'idle' | 'preparing' | 'syncing' | 'done' | 'error'
  total: number
  done: number
  errors: number
  lastSyncAt: number
}

interface BackupState {
  status: BackupStatus
  paired: boolean
  sync?: SyncState
}

interface DiscoverResult {
  type: string
  sessionCount: number
  totalSize: number
  lastModified?: number
  error?: string
}

function useBackupStatus(existsCallbackRef: React.RefObject<((result: DiscoverResult) => void) | null>) {
  const [state, setState] = useState<BackupState>({ status: 'disconnected', paired: false })

  const poll = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'backup:status' }).then((res: BackupState) => {
      if (!res) return
      setState(prev => {
        if (prev.status === res.status && prev.paired === res.paired
          && prev.sync?.phase === res.sync?.phase
          && prev.sync?.done === res.sync?.done
          && prev.sync?.errors === res.sync?.errors
          && prev.sync?.lastSyncAt === res.sync?.lastSyncAt) return prev
        return res
      })
    }).catch(() => {})
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, 1000)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listener = (msg: any): undefined => {
      if (msg?.type === 'backup:sync-progress' && msg.sync) {
        setState(prev => ({ ...prev, sync: msg.sync as SyncState }))
      }
      if (msg?.type === 'backup:exists' || msg?.type === 'backup:update-available') {
        poll()
        if (msg?.type === 'backup:exists' && existsCallbackRef.current) {
          existsCallbackRef.current({
            type: 'discover:response',
            sessionCount: msg.sessionCount ?? 0,
            totalSize: msg.totalSize ?? 0,
            lastModified: msg.lastModified,
          })
        }
      }
      return undefined
    }
    chrome.runtime.onMessage.addListener(listener)

    return () => {
      clearInterval(id)
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [poll])

  return state
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

export default function DataView({ onBack }: Props) {
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const [exportError, setExportError] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [showModeDialog, setShowModeDialog] = useState(false)
  const pendingFileRef = useRef<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Backup service state
  const existsCallbackRef = useRef<((result: DiscoverResult) => void) | null>(null)
  const backupState = useBackupStatus(existsCallbackRef)
  const [pairing, setPairing] = useState(false)
  const [unpairing, setUnpairing] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoverResult, setDiscoverResult] = useState<DiscoverResult | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)

  // Reason: when daemon rejects our key (backup_exists), auto-show the discover dialog
  // so the user can choose to restore/merge/re-pair without manual clicks.
  // Guard: don't stack over an active import dialog.
  existsCallbackRef.current = (result: DiscoverResult) => {
    if (!showModeDialog && !importing) setDiscoverResult(result)
  }

  async function handleExport() {
    setExporting(true)
    setExportDone(false)
    setExportError(false)
    try {
      const blob = await exportAllData()
      downloadBlob(blob, formatBackupFilename())
      setExportDone(true)
      setTimeout(() => setExportDone(false), 3000)
    } catch (e) {
      console.error('[DataView] export failed:', e)
      setExportError(true)
      setTimeout(() => setExportError(false), 3000)
    }
    setExporting(false)
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    pendingFileRef.current = file
    setShowModeDialog(true)
    e.target.value = ''
  }

  async function executeImport(mode: ImportMode) {
    setShowModeDialog(false)
    const file = pendingFileRef.current
    if (!file) return

    setImporting(true)
    setImportResult(null)
    try {
      const result = await importAllData(file, mode)
      setImportResult(result)
      if (result.errors.length > 0) {
        setTimeout(() => setImportResult(null), 5000)
      } else {
        // Reason: a live offscreen kernel would checkpoint its pre-import
        // sessions over the restored data — kill it, then reload so every
        // host reads storage from scratch.
        await chrome.runtime.sendMessage({ type: 'kernel:reset' }).catch(() => {})
        location.reload()
      }
    } catch (e) {
      setImportResult({ sessionsImported: 0, sessionsKept: 0, errors: [String(e)] })
    }
    setImporting(false)
    pendingFileRef.current = null
  }

  async function handleConnect() {
    setBackupError(null)
    setDiscovering(true)

    // Ensure WS connection is live before discover
    try {
      const connRes = await chrome.runtime.sendMessage({ type: 'backup:connect' }) as { ok?: boolean; error?: string }
      if (connRes.error) {
        setBackupError('备份服务不可用。请先启动 daemon。')
        setDiscovering(false)
        return
      }
    } catch {
      setBackupError('备份服务不可用。请先启动 daemon。')
      setDiscovering(false)
      return
    }
    try {
      const result = await chrome.runtime.sendMessage({ type: 'backup:discover' }) as DiscoverResult
      if (result.error) {
        setBackupError(String(result.error))
        setDiscovering(false)
        return
      }
      if (result.sessionCount > 0) {
        setDiscoverResult(result)
        setDiscovering(false)
        return
      }
    } catch (e) {
      setBackupError(String(e))
      setDiscovering(false)
      return
    }

    // No existing data — pair directly
    setDiscovering(false)
    await doPair()
  }

  async function doPair() {
    setPairing(true)
    setBackupError(null)
    try {
      const res = await chrome.runtime.sendMessage({ type: 'backup:pair' }) as { ok?: boolean; error?: string }
      if (res.error) setBackupError(res.error)
    } catch (e) {
      setBackupError(String(e))
    }
    setPairing(false)
  }

  async function handleDiscoverRestore(mode: ImportMode) {
    setDiscoverResult(null)
    setImporting(true)
    try {
      const data = await chrome.runtime.sendMessage({ type: 'backup:restore' }) as Record<string, unknown>
      if (data.error) {
        setBackupError(String(data.error))
        setImporting(false)
        return
      }
      // Reconstruct blob-like data for importAllData
      const payload = {
        version: 1,
        exportedAt: Date.now(),
        extensionVersion: '',
        chromeStorage: data.chromeStorage ?? {},
        indexedDB: data.indexedDB ?? {},
      }
      const blob = new Blob([JSON.stringify(payload)])
      const gzBlob = new Blob(
        [await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob()]
      )
      const result = await importAllData(gzBlob, mode)
      setImportResult(result)
    } catch (e) {
      setBackupError(String(e))
    }
    setImporting(false)
    await doPair()
  }

  async function handleDiscoverIgnore() {
    setDiscoverResult(null)
    await doPair()
  }

  async function handleDisconnect() {
    setUnpairing(true)
    setBackupError(null)
    try {
      const res = await chrome.runtime.sendMessage({ type: 'backup:unpair' }) as { ok?: boolean; error?: string }
      if (res.error) setBackupError(res.error)
    } catch (e) {
      setBackupError(String(e))
    }
    setUnpairing(false)
  }

  const statusDot = backupState.paired
    ? backupState.status === 'connected'
      ? 'bg-success'
      : backupState.status === 'suspended'
        ? 'bg-error'
        : 'bg-warning animate-pulse'
    : 'bg-text-muted/30'

  const statusText = backupState.paired
    ? backupState.status === 'connected'
      ? '已连接'
      : backupState.status === 'suspended'
        ? '已挂起'
        : backupState.status === 'connecting'
          ? '重连中...'
          : '连接中断'
    : '未连接'

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface">
      <div className="flex flex-col gap-3 px-3 py-3">
        {/* Header */}
        <div className="flex items-center gap-2 px-1">
          <button
            onClick={onBack}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"
          >
            <Icon icon={iconArrowLeft} className="text-base" />
          </button>
          <h2 className="text-sm font-semibold text-text-primary">数据与备份</h2>
        </div>

        {/* Section 1: Manual Import/Export */}
        <section className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
          <h3 className="mb-3 text-[11px] font-semibold tracking-wide text-text-muted">
            手动导入 / 导出
          </h3>
          <div className="flex gap-2">
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-surface py-2.5 text-[12px] font-medium text-text-primary transition-all hover:bg-surface-overlay active:scale-[0.98] disabled:opacity-50"
            >
              <Icon icon={exportDone ? iconCheck : exportError ? iconAlertCircleOutline : iconDownload} className="text-sm" />
              {exporting ? '导出中...' : exportDone ? '已下载' : exportError ? '导出失败' : '导出数据'}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-surface py-2.5 text-[12px] font-medium text-text-primary transition-all hover:bg-surface-overlay active:scale-[0.98] disabled:opacity-50"
            >
              <Icon icon={iconUpload} className="text-sm" />
              {importing ? '导入中...' : '导入数据'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gz,.json.gz"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          {/* Import result */}
          {importResult && (
            <div className={`mt-3 rounded-lg px-3 py-2 text-[11px] ${importResult.errors.length > 0 ? 'border border-error/20 bg-error/5 text-error' : 'border border-success/20 bg-success/5 text-success'}`}>
              {importResult.errors.length > 0 ? (
                <div className="flex items-start gap-1.5">
                  <Icon icon={iconAlertCircleOutline} className="mt-0.5 shrink-0 text-sm" />
                  <div>
                    <p className="font-medium">导入失败</p>
                    {importResult.errors.map((err, i) => (
                      <p key={i} className="mt-0.5 opacity-80">{err}</p>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Icon icon={iconCheck} className="shrink-0 text-sm" />
                  <span>
                    导入成功：恢复 {importResult.sessionsImported} 个会话
                    {importResult.sessionsKept > 0 && `，保留 ${importResult.sessionsKept} 个已有会话`}
                    。正在刷新页面…
                  </span>
                </div>
              )}
            </div>
          )}

          <p className="mt-2.5 text-[10px] leading-relaxed text-text-muted">
            导出为 gzip 压缩文件，包含全部会话、VFS、记忆和设置。
          </p>
        </section>

        {/* Section 2: Backup service */}
        <section className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
          <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-text-muted">
            本地备份服务
          </h3>

          {/* Status row */}
          <div className="flex items-center justify-between rounded-lg bg-surface-overlay/50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${statusDot}`} />
              <span className="text-[11px] text-text-secondary">{statusText}</span>
            </div>
            {backupState.paired ? (
              <button
                onClick={handleDisconnect}
                disabled={unpairing}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:bg-surface hover:text-error"
              >
                <Icon icon={unpairing ? iconLoading : iconLinkOff} className={`text-xs ${unpairing ? 'animate-spin' : ''}`} />
                {unpairing ? '断开中...' : '断开备份'}
              </button>
            ) : (
              <button
                onClick={handleConnect}
                disabled={pairing || discovering}
                className="flex items-center gap-1 rounded-md bg-accent-wash px-2.5 py-1 text-[10px] font-medium text-accent transition-colors hover:bg-accent-wash/80 disabled:opacity-50"
              >
                <Icon icon={(pairing || discovering) ? iconLoading : iconLinkVariant} className={`text-xs ${(pairing || discovering) ? 'animate-spin' : ''}`} />
                {pairing ? '配对中...' : discovering ? '查询中...' : '连接备份服务'}
              </button>
            )}
          </div>

          {/* Sync status */}
          {backupState.paired && backupState.sync && backupState.sync.phase !== 'idle' && (
            <div className="mt-2 flex items-center gap-1.5 px-1 text-[10px]">
              {backupState.sync.phase === 'preparing' ? (
                <>
                  <Icon icon={iconLoading} className="animate-spin text-xs text-accent" />
                  <span className="text-text-muted">准备同步...</span>
                </>
              ) : backupState.sync.phase === 'syncing' ? (
                <>
                  <Icon icon={iconLoading} className="animate-spin text-xs text-accent" />
                  <span className="text-text-muted">
                    同步中（{backupState.sync.done}/{backupState.sync.total}）
                  </span>
                </>
              ) : backupState.sync.phase === 'error' ? (
                <>
                  <Icon icon={iconAlertCircleOutline} className="text-xs text-warning" />
                  <span className="text-warning">
                    同步异常：{backupState.sync.errors} 个失败，{backupState.sync.done} 个成功
                  </span>
                </>
              ) : (
                <>
                  <Icon icon={iconCheck} className="text-xs text-success" />
                  <span className="text-text-muted">
                    已是最新
                    {backupState.sync.lastSyncAt > 0 && ` · ${formatTimeAgo(backupState.sync.lastSyncAt)}`}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Error */}
          {backupError && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-[10px] text-error">
              <Icon icon={iconAlertCircleOutline} className="mt-0.5 shrink-0 text-xs" />
              <span className="flex-1">{backupError}</span>
              <button onClick={() => setBackupError(null)} className="shrink-0 text-error/50 transition-colors hover:text-error">✕</button>
            </div>
          )}

          {/* Suspended warning */}
          {backupState.status === 'suspended' && (
            <div className="mt-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-[10px] text-warning">
              Daemon 因崩溃过多已挂起。运行 <code className="rounded-sm bg-surface-overlay px-1 py-0.5 font-mono">node daemon.js reset</code> 恢复。
            </div>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-text-muted">
            {backupState.paired
              ? backupState.status === 'connected'
                ? '数据正在实时同步到本机。卸载重装后可自动恢复。'
                : backupState.status === 'suspended'
                  ? 'Daemon 已挂起，数据未同步。请排查后重置。'
                  : '备份服务连接已中断，数据暂未同步。'
              : '安装并启动 daemon 后，可实现会话数据实时备份到本机。'}
          </p>
        </section>

        {/* Section 3: Usage guide */}
        <section className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
          <h3 className="mb-3 text-[11px] font-semibold tracking-wide text-text-muted">
            使用指导
          </h3>
          <div className="space-y-3 text-[11px] leading-relaxed text-text-secondary">
            <div>
              <p className="mb-1 font-medium text-text-primary">更新插件的正确姿势</p>
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>
                  <strong className="text-text-primary">推荐：</strong>
                  在固定目录 clone 仓库，更新时 <code className="rounded-sm bg-surface-overlay px-1 py-0.5 font-mono text-[10px]">git pull && npm run build</code>，
                  然后 chrome://extensions 点"重新加载"。<strong className="text-success">不清理数据</strong>
                </li>
                <li>
                  <strong className="text-text-primary">如果重新加载不生效：</strong>
                  先在此页面手动导出 → 卸载旧扩展 → 重新加载 → 导入恢复
                </li>
                <li>
                  <strong className="text-text-primary">最省心：</strong>
                  配置无感备份服务，卸载重装后自动发现并恢复
                </li>
              </ol>
            </div>
            <div className="border-t border-border-muted pt-2.5">
              <p className="mb-1 font-medium text-text-primary">无感备份配置</p>
              <div className="space-y-1 text-text-muted">
                <p>安装并启动 daemon：</p>
                <pre className="cursor-text select-text whitespace-pre-wrap rounded-md bg-surface-overlay px-2 py-1.5 font-mono text-[10px] leading-relaxed">{`cd tools/sidekick-daemon\nnpm install\nnode scripts/daemon.js install`}</pre>
                <p className="mt-1">备份数据存储位置：<code className="cursor-text select-text rounded-sm bg-surface-overlay px-1 py-0.5 font-mono text-[10px]">~/.sidekick-backup/</code></p>
              </div>
            </div>
            <div className="border-t border-border-muted pt-2.5">
              <p className="mb-1 font-medium text-text-primary">数据安全</p>
              <ul className="list-disc space-y-1 pl-4 text-text-muted">
                <li>导出文件和本地备份均包含 API key，请妥善保管</li>
                <li>不要放在共享目录或云同步目录</li>
                <li>不要将导出文件发给他人</li>
                <li>备份服务一次只能绑定一个浏览器，如果在另一个浏览器中也连接了备份，当前浏览器会被取消配对，需要重新连接</li>
              </ul>
            </div>
          </div>
        </section>
      </div>

      <AppDialog open={showModeDialog} title="选择导入方式"
        onClose={() => { setShowModeDialog(false); pendingFileRef.current = null }}
        footer={<DialogAction onClick={() => { setShowModeDialog(false); pendingFileRef.current = null }}>取消</DialogAction>}>
        <p className="mb-4 text-xs text-text-muted">{pendingFileRef.current?.name}</p>
        <div className="flex flex-col gap-2">
          <button onClick={() => executeImport('replace')} className="rounded-lg border border-border-subtle bg-surface p-4 text-left transition-colors hover:bg-surface-overlay">
            <span className="block text-sm font-medium">仅恢复备份</span><span className="mt-1 block text-xs text-text-muted">清空当前数据，完全替换为备份内容</span>
          </button>
          <button onClick={() => executeImport('merge')} className="rounded-lg border border-border-subtle bg-surface p-4 text-left transition-colors hover:bg-surface-overlay">
            <span className="block text-sm font-medium">合并（保留两边）</span><span className="mt-1 block text-xs text-text-muted">保留当前会话和设置，仅补充缺失的数据</span>
          </button>
        </div>
      </AppDialog>
      <AppDialog open={!!discoverResult} title="发现已有备份" dismissible={!importing} onClose={() => setDiscoverResult(null)}
        footer={<DialogAction disabled={importing} onClick={() => setDiscoverResult(null)}>{importing ? '导入中...' : '取消'}</DialogAction>}>
        {discoverResult && <>
          <p className="mb-4 text-xs text-text-muted">{discoverResult.sessionCount} 个会话 · {formatBytes(discoverResult.totalSize)}{discoverResult.lastModified ? ` · 最近更新 ${formatTimeAgo(discoverResult.lastModified)}` : ''}</p>
          <div className="flex flex-col gap-2">
            {([
              ['replace', '恢复备份', '用备份内容替换当前数据'],
              ['merge', '合并', '保留当前数据，补充备份中缺失的部分'],
              ['ignore', '忽略旧备份', '从当前数据开始新的备份'],
            ] as const).map(([mode, title, description]) => <button key={mode} disabled={importing}
              onClick={() => mode === 'ignore' ? handleDiscoverIgnore() : handleDiscoverRestore(mode)}
              className="rounded-lg border border-border-subtle bg-surface p-4 text-left transition-colors hover:bg-surface-overlay disabled:opacity-50">
              <span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs text-text-muted">{description}</span>
            </button>)}
          </div>
        </>}
      </AppDialog>
    </div>
  )
}
