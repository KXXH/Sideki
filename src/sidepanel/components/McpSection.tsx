import { useState, useEffect, useRef } from 'react'
import { Icon } from '@iconify/react'
import { iconPlug, iconPlus, iconDelete, iconClose, iconCheck, iconLoading, iconLock } from '../../shared/icons'
import { t } from '../../shared/i18n'
import type { McpProbeResult } from '../../shared/mcp-client'
import type { McpServerConfig } from '../../shared/types'

function Section({ id, title, hint, children }: {
  id?: string
  title: string
  hint?: string
  children: React.ReactNode
}) {
  const [showHint, setShowHint] = useState(false)
  return (
    <section id={id} className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3 scroll-mt-4">
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
  )
}

type AuthType = 'none' | 'oauth'

interface ServerStatus {
  phase: 'probing' | 'authing' | 'done'
  result?: McpProbeResult
}

interface McpSectionProps {
  servers: McpServerConfig[]
  onChange: (servers: McpServerConfig[]) => void
}

async function probeServer(server: McpServerConfig): Promise<McpProbeResult> {
  return chrome.runtime.sendMessage({ type: 'mcp:probe', server })
}

async function authorizeServer(server: McpServerConfig): Promise<McpProbeResult> {
  return chrome.runtime.sendMessage({ type: 'mcp:auth', server })
}

export default function McpSection({ servers, onChange }: McpSectionProps) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<AuthType>('none')
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({})
  const probedRef = useRef<Set<string>>(new Set())

  // Reason: auto-probe servers that haven't been probed yet. Runs on mount
  // and whenever servers change (e.g. after add/edit). Non-interactive —
  // for OAuth servers without tokens this instantly returns 'needs_auth'.
  useEffect(() => {
    for (const server of servers) {
      if (probedRef.current.has(server.id)) continue
      probedRef.current.add(server.id)
      setStatuses(prev => ({ ...prev, [server.id]: { phase: 'probing' } }))
      probeServer(server).then(result => {
        setStatuses(prev => ({ ...prev, [server.id]: { phase: 'done', result } }))
      })
    }
  }, [servers])

  function resetForm() {
    setName('')
    setUrl('')
    setAuth('none')
    setAdding(false)
    setEditingId(null)
  }

  function handleAdd() {
    if (!name.trim() || !url.trim()) return
    const server: McpServerConfig = {
      id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      url: url.trim(),
      auth: { type: auth },
      enabled: true,
    }
    onChange([...servers, server])
    resetForm()
  }

  function handleUpdate() {
    if (!editingId || !name.trim() || !url.trim()) return
    onChange(servers.map(s =>
      s.id === editingId ? { ...s, name: name.trim(), url: url.trim(), auth: { type: auth } as McpServerConfig['auth'] } : s
    ))
    // Re-probe after edit since URL or auth type may have changed
    probedRef.current.delete(editingId)
    setStatuses(prev => { const next = { ...prev }; delete next[editingId]; return next })
    resetForm()
  }

  function handleDelete(id: string) {
    onChange(servers.filter(s => s.id !== id))
    probedRef.current.delete(id)
    setStatuses(prev => { const next = { ...prev }; delete next[id]; return next })
    if (editingId === id) resetForm()
  }

  function handleToggle(id: string) {
    onChange(servers.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s))
  }

  function startEdit(server: McpServerConfig) {
    setEditingId(server.id)
    setName(server.name)
    setUrl(server.url)
    setAuth(server.auth.type)
    setAdding(false)
  }

  async function handleAuthorize(server: McpServerConfig) {
    setStatuses(prev => ({ ...prev, [server.id]: { phase: 'authing' } }))
    const result = await authorizeServer(server)
    setStatuses(prev => ({ ...prev, [server.id]: { phase: 'done', result } }))
  }

  async function handleRetry(server: McpServerConfig) {
    probedRef.current.delete(server.id)
    setStatuses(prev => ({ ...prev, [server.id]: { phase: 'probing' } }))
    const result = await probeServer(server)
    setStatuses(prev => ({ ...prev, [server.id]: { phase: 'done', result } }))
  }

  const showForm = adding || editingId !== null

  return (
    <Section id="s-mcp" title={t.mcpServers} hint={t.mcpHint}>
      {servers.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {servers.map(server => {
            const st = statuses[server.id]
            const busy = st?.phase === 'probing' || st?.phase === 'authing'
            const probeStatus = st?.result?.status
            return (
              <div
                key={server.id}
                className="group rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 transition-colors hover:bg-white/[0.04]"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleToggle(server.id)}
                    className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${server.enabled ? 'bg-accent' : 'bg-surface-overlay'}`}
                  >
                    <div className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${server.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Icon icon={iconPlug} className="shrink-0 text-[13px] text-text-muted" />
                      <span className="truncate text-xs font-medium text-text-primary">{server.name}</span>
                      {server.auth.type === 'oauth' && (
                        <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent">OAuth</span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-text-muted">{server.url}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => startEdit(server)}
                      className="rounded-md p-1 text-[11px] text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-secondary"
                    >
                      {t.edit}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(server.id)}
                      className="rounded-md p-1 text-text-muted transition-colors hover:bg-error/10 hover:text-error"
                    >
                      <Icon icon={iconDelete} className="text-[13px]" />
                    </button>
                  </div>
                </div>

                {/* Status row */}
                <div className="mt-1.5 flex items-center gap-2 pl-9">
                  {busy && (
                    <span className="flex items-center gap-1 text-[10px] text-text-muted">
                      <Icon icon={iconLoading} className="animate-spin text-[11px]" />
                      {st.phase === 'authing' ? t.mcpConnecting : t.mcpConnecting}
                    </span>
                  )}
                  {!busy && probeStatus === 'connected' && (
                    <span className="flex items-center gap-1 text-[10px] text-success">
                      <Icon icon={iconCheck} className="text-[11px]" />
                      {t.mcpConnected} · {t.mcpTools(st!.result!.toolCount)}
                    </span>
                  )}
                  {!busy && probeStatus === 'needs_auth' && (
                    <>
                      <span className="flex items-center gap-1 text-[10px] text-warning">
                        <Icon icon={iconLock} className="text-[11px]" />
                        {t.mcpNeedsAuth}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleAuthorize(server)}
                        className="rounded-sm bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/25"
                      >
                        {t.mcpAuthorize}
                      </button>
                    </>
                  )}
                  {!busy && probeStatus === 'error' && (
                    <>
                      <span className="text-[10px] text-error" title={st!.result!.error}>
                        {t.mcpConnectFailed}{st!.result!.error ? `: ${st!.result!.error.slice(0, 50)}` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRetry(server)}
                        className="text-[10px] text-accent/70 transition-colors hover:text-accent"
                      >
                        {t.mcpTestConnection}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <div className="mb-3 rounded-lg border border-accent/20 bg-accent/[0.03] px-3 py-3">
          <div className="space-y-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-secondary">{t.mcpName}</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Sentry"
                className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-text-primary outline-none transition-colors focus:border-accent/50"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-secondary">{t.mcpUrl}</span>
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/sse"
                className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-text-primary outline-none transition-colors focus:border-accent/50"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-secondary">{t.mcpAuth}</span>
              <select
                value={auth}
                onChange={e => setAuth(e.target.value as AuthType)}
                className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-text-primary outline-none transition-colors focus:border-accent/50"
              >
                <option value="none">{t.mcpAuthNone}</option>
                <option value="oauth">{t.mcpAuthOAuth}</option>
              </select>
            </label>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-white/[0.04]"
            >
              <Icon icon={iconClose} className="text-[12px]" />
              {t.cancel}
            </button>
            <button
              type="button"
              onClick={editingId ? handleUpdate : handleAdd}
              disabled={!name.trim() || !url.trim()}
              className="flex items-center gap-1 rounded-md bg-accent/90 px-2.5 py-1 text-[11px] font-medium text-on-accent transition-colors hover:bg-accent disabled:opacity-40"
            >
              <Icon icon={iconCheck} className="text-[12px]" />
              {t.save}
            </button>
          </div>
        </div>
      )}

      {!showForm && (
        <button
          type="button"
          onClick={() => { setAdding(true); setEditingId(null) }}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-subtle py-2 text-[11px] text-text-muted transition-colors hover:border-accent/40 hover:text-accent"
        >
          <Icon icon={iconPlus} className="text-[13px]" />
          {t.mcpAdd}
        </button>
      )}
    </Section>
  )
}
