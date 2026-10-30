import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { iconCheck, iconProDatabase, iconRefresh, iconShieldAlert } from '../../shared/icons'
import { loadSessionIndex, SESSION_MIGRATION_KEY, type SessionMigrationStatus } from '../../shared/storage'

export default function StorageMigrationGate({ children }: { children: ReactNode }) {
  const [migration, setMigration] = useState<SessionMigrationStatus | null>(null)
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState<{ message: string; operation: 'initialize' | 'acknowledge' } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [acknowledging, setAcknowledging] = useState(false)

  useEffect(() => {
    let disposed = false
    let revision = 0
    const readStatus = async (allowEmpty: boolean) => {
      const before = revision
      const stored = await chrome.storage.local.get(SESSION_MIGRATION_KEY)
      if (disposed || before !== revision) return
      const next = (stored[SESSION_MIGRATION_KEY] ?? null) as SessionMigrationStatus | null
      if (next || allowEmpty) setMigration(next)
    }
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[SESSION_MIGRATION_KEY] || disposed) return
      ++revision
      const next = (changes[SESSION_MIGRATION_KEY].newValue ?? null) as SessionMigrationStatus | null
      setMigration(next)
      setFailure(null)
    }
    chrome.storage.onChanged.addListener(onChange)
    void (async () => {
      try {
        await readStatus(false)
        // Reason: the worker may already own migration; the shared lock also resumes interrupted work.
        await loadSessionIndex()
        await readStatus(true)
      } catch (error) {
        if (!disposed) setFailure({ message: error instanceof Error ? error.message : String(error), operation: 'initialize' })
      } finally {
        if (!disposed) setReady(true)
      }
    })()
    return () => {
      disposed = true
      chrome.storage.onChanged.removeListener(onChange)
    }
  }, [attempt])

  const retry = () => {
    setFailure(null)
    setMigration(null)
    setReady(false)
    setAttempt(value => value + 1)
  }
  const continueToApp = async () => {
    setAcknowledging(true)
    try {
      await chrome.storage.local.remove(SESSION_MIGRATION_KEY)
      setMigration(null)
      setFailure(null)
    } catch (error) {
      setFailure({ message: error instanceof Error ? error.message : String(error), operation: 'acknowledge' })
    } finally {
      setAcknowledging(false)
    }
  }

  if (ready && !migration && !failure) return children
  if (!migration && !failure) return <div className="h-dvh bg-surface" aria-label="正在检查存储" aria-busy="true" />

  const migrated = migration?.status === 'complete'
  const initializationFailed = failure?.operation === 'initialize'
  const complete = migrated && !initializationFailed
  const failed = migration?.status === 'error' || initializationFailed
  const total = migration?.total ?? 0
  const completed = migration?.completed ?? 0
  const title = migrated && initializationFailed ? '暂时无法读取存储'
    : complete ? '存储优化完成' : failed ? '存储优化未完成' : '正在优化存储'
  const detail = migrated && initializationFailed ? '存储已优化，但当前读取失败，请重试。'
    : complete ? '历史消息已保留，会话现已独立存储。'
      : failed ? '暂时无法完成优化，请重试，无需清空数据。'
        : '正在整理历史会话，完成后即可继续使用。'

  return (
    <div className="flex h-dvh flex-col overflow-y-auto bg-surface px-7 py-7 text-text-primary">
      <header className="flex items-center gap-2.5 text-[13px] font-semibold tracking-tight">
        <span className="h-2 w-2 rounded-sm bg-text-primary" aria-hidden="true" />
        Sideki
        <span className="ml-auto text-[10px] font-normal tracking-[0.15em] text-text-secondary">存储更新</span>
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
        <div className="relative mb-9 flex h-24 w-24 items-center justify-center" aria-hidden="true">
          <div className="absolute inset-0 rounded-full border border-border-muted" />
          <div className={`absolute inset-0 rounded-full border border-transparent ${!complete && !failed ? 'border-t-accent motion-safe:animate-spin' : ''}`} />
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border-subtle bg-surface-raised">
            <Icon icon={iconProDatabase} className="text-[30px] text-text-secondary" />
          </div>
          {(complete || failed) && (
            <span className={`absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-4 border-surface ${complete ? 'bg-success text-white' : 'bg-warning text-surface'}`}>
              <Icon icon={complete ? iconCheck : iconShieldAlert} className="text-sm" />
            </span>
          )}
        </div>
        <div role="status" aria-live="polite">
          <h1 className="text-[25px] font-semibold tracking-tight">{title}</h1>
          <p className="mt-3 text-[12px] leading-6 text-text-secondary">{detail}</p>
        </div>
        {migration && <div className="mt-9 border-t border-border-muted pt-5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-text-secondary">{migrated ? '已优化会话' : '已写入会话'}</span>
            <span className="font-mono tabular-nums text-text-primary">
              {migrated ? total : `${completed} / ${total}`}
            </span>
          </div>
          {!migrated && (
            <>
              <div
                role="progressbar"
                aria-label="会话写入进度"
                aria-valuemin={0}
                aria-valuemax={Math.max(total, 1)}
                aria-valuenow={completed}
                className="mt-3 h-1 overflow-hidden rounded-full bg-surface-overlay"
              >
                <div
                  className={`h-full origin-left transition-transform duration-300 motion-reduce:transition-none ${failed ? 'bg-warning' : 'bg-accent'}`}
                  style={{ transform: `scaleX(${total ? completed / total : 0})` }}
                />
              </div>
              <p className="mt-3 text-[11px] text-text-secondary">
                {failed ? '优化已暂停' : completed === total ? '正在完成存储切换…' : '正在逐个保存会话…'}
              </p>
            </>
          )}
        </div>}
        {(failure || migration?.error) && (
          <p role="alert" className="mt-5 max-h-32 overflow-y-auto break-words rounded-lg border border-warning/25 bg-warning/5 p-3 text-[11px] leading-5 text-text-secondary">
            {failure?.message || migration?.error}
          </p>
        )}
        {(complete || failed) && (
          <button
            type="button"
            disabled={!ready || acknowledging}
            onClick={complete ? continueToApp : retry}
            className="mt-8 flex w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-4 py-3 text-[12px] font-medium text-surface transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-50"
          >
            {!complete && <Icon icon={iconRefresh} className="text-base" />}
            {complete ? '开始使用' : '重新尝试'}
          </button>
        )}
      </main>
      <footer className="border-t border-border-muted pt-4 text-[10px] leading-5 text-text-secondary">
        本地存储优化 · 不会向模型发送数据
      </footer>
    </div>
  )
}
