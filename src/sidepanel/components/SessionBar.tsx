import { useState, useRef, useEffect, useMemo, memo } from 'react'
import AnimatedPopover from './AnimatedPopover'
import { Icon } from '@iconify/react'
import { iconClose, iconChevronDown, iconPencil, iconCheck } from '../../shared/icons'

interface SessionItem {
  id: string
  title: string
  updatedAt: number
  pageUrl?: string
  messages: unknown[]
  messageCount?: number
}

interface Props {
  sessions: SessionItem[]
  activeId: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function hostname(url?: string): string {
  if (!url) return ''
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// Reason: memoized — props are reference-stable across patch frames, so the
// session dropdown (600+ entries) never re-renders during streaming.
export default memo(function SessionBar({ sessions, activeId, onSelect, onDelete, onRename }: Props) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      // Reason: dropdown is portaled to body — check both trigger and popover refs
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus()
  }, [editingId])

  const commitRename = () => {
    if (!editingId) return
    const trimmed = editValue.trim()
    if (trimmed) onRename(editingId, trimmed)
    setEditingId(null)
  }

  const active = useMemo(() => sessions.find(s => s.id === activeId), [sessions, activeId])
  const sorted = useMemo(() => [...sessions]
    // Reason: mirror-mode entries carry stripped bodies + messageCount —
    // fall back to messages.length for panel-mode full sessions.
    .filter(s => s.id === activeId || (s.messageCount ?? s.messages.length) > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt), [sessions, activeId])

  return (
    <div ref={ref} className="relative min-w-0">
      <div
        className="flex min-w-0 items-center"
        style={{ anchorName: '--session-bar' } as React.CSSProperties}
      >
        <button
          onClick={() => setOpen(v => !v)}
          className="-ml-1 flex w-[calc(100%_+_4px)] min-w-0 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-text-primary transition-colors hover:bg-surface-raised"
        >
          <span className="min-w-0 truncate">{active?.title || 'New Chat'}</span>
          <Icon
            icon={iconChevronDown}
            className={`shrink-0 text-[10px] text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      <AnimatedPopover open={open}
          ref={popRef}
          style={{
            positionAnchor: '--session-bar',
            top: 'anchor(bottom)',
          } as React.CSSProperties}
          className="session-dropdown theme-overlay fixed z-50 mt-1.5 max-h-72 overflow-y-auto rounded-lg p-1"
        >
          {sorted.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-text-muted">No sessions</p>
          ) : (
            sorted.map(s => (
              <div
                key={s.id}
                className={`group flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                  s.id === activeId
                    ? 'bg-accent/12 text-accent'
                    : 'text-text-secondary hover:bg-surface-overlay'
                }`}
              >
                {editingId === s.id ? (
                  <>
                    <input
                      ref={editRef}
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={commitRename}
                      className="min-w-0 flex-1 rounded-md border border-accent/30 bg-surface px-1.5 py-0.5 text-xs text-text-primary outline-none focus:border-accent/50"
                    />
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={commitRename}
                      className="shrink-0 rounded-md p-0.5 text-accent transition-colors hover:bg-accent-wash"
                      title="确认"
                    >
                      <Icon icon={iconCheck} className="text-xs" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => { onSelect(s.id); setOpen(false) }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate">{s.title}</span>
                      {hostname(s.pageUrl) && (
                        <span className="block truncate font-mono text-[9px] text-text-muted">{hostname(s.pageUrl)}</span>
                      )}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setEditingId(s.id); setEditValue(s.title) }}
                      className="shrink-0 rounded-md p-0.5 text-text-muted opacity-0 transition-all hover:text-accent group-hover:opacity-100"
                      title="重命名"
                    >
                      <Icon icon={iconPencil} className="text-xs" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); onDelete(s.id) }}
                      className="shrink-0 rounded-md p-0.5 text-text-muted opacity-0 transition-all hover:text-error group-hover:opacity-100"
                      title="Delete session"
                    >
                      <Icon icon={iconClose} className="text-xs" />
                    </button>
                    <span className="shrink-0 tabular-nums text-[10px] text-text-muted">{timeAgo(s.updatedAt)}</span>
                  </>
                )}
              </div>
            ))
          )}
        </AnimatedPopover>
    </div>
  )
})
