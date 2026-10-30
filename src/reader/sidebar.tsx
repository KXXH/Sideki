import { useMemo, useState } from 'react'
import type { PdfNote } from '../shared/pdf-note-store'

interface SidebarProps {
  notes: PdfNote[]
  documentVersion: string
  activeNoteId: string | null
  noTextLayer: boolean
  onJump: (note: PdfNote) => void
  onRemove: (ids: string[]) => void
  onEdit: (id: string, note: string) => void
}

const AUTHOR_BADGE: Record<PdfNote['author'], string> = {
  ai: 'bg-accent-wash text-accent',
  user: 'bg-surface-overlay text-text-secondary',
}

const COLOR_DOT: Record<PdfNote['color'], string> = {
  yellow: '#facc15',
  green: '#34d399',
  blue: '#60a5fa',
  pink: '#f472b6',
}

function IconTrash({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}

function IconPencil({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function NoteEntry({
  note,
  documentVersion,
  active,
  checked,
  onToggle,
  onJump,
  onDelete,
  onEdit,
}: {
  note: PdfNote
  documentVersion: string
  active: boolean
  checked: boolean
  onToggle: () => void
  onJump: () => void
  onDelete: () => void
  onEdit: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.note ?? '')
  const readonlyLabel = note.documentVersion === documentVersion ? null
    : note.documentVersion ? '其他文档版本 · 只读' : '未记录文档版本 · 只读'

  const startEdit = () => {
    setText(note.note ?? '')
    setEditing(true)
  }

  return (
    <div
      id={`note-entry-${note.id}`}
      className={`rounded-lg border p-2.5 transition-colors ${
        active ? 'border-accent bg-accent-wash' : 'border-border-muted bg-surface-raised'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={checked}
          disabled={!!readonlyLabel}
          onChange={onToggle}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
        />
        <span className={`rounded-sm px-1 py-px text-[9px] font-medium ${AUTHOR_BADGE[note.author]}`}>
          {note.author === 'ai' ? 'AI' : '我'}
        </span>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: COLOR_DOT[note.color] }}
        />
        <span className="ml-auto text-[10px] text-text-muted">
          {new Date(note.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
        <button
          title="编辑评论"
          disabled={!!readonlyLabel}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-secondary disabled:opacity-30"
          onClick={startEdit}
        >
          <IconPencil className="h-3 w-3" />
        </button>
        <button
          title="删除"
          disabled={!!readonlyLabel}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-error disabled:opacity-30"
          onClick={onDelete}
        >
          <IconTrash className="h-3 w-3" />
        </button>
      </div>
      {readonlyLabel && <div className="mt-1 text-[10px] text-text-muted">{readonlyLabel}</div>}
      <button className="mt-1 block w-full text-left" disabled={!!readonlyLabel} onClick={onJump}>
        <div className="line-clamp-2 text-[11px] italic leading-snug text-text-secondary">
          “{note.quote}”
        </div>
      </button>
      {editing ? (
        <div className="mt-1.5">
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={e => setText(e.target.value)}
            className="input-base resize-none text-xs"
            placeholder="写下你的评论…"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              className="rounded-md px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
            <button
              className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-85"
              onClick={() => {
                onEdit(text)
                setEditing(false)
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 cursor-pointer text-xs leading-snug text-text-primary" onClick={onJump}>
          {note.note || <span className="text-text-muted">未填写评论</span>}
        </div>
      )}
    </div>
  )
}

export function Sidebar({ notes, documentVersion, activeNoteId, noTextLayer, onJump, onRemove, onEdit }: SidebarProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const grouped = useMemo(() => {
    const sorted = [...notes].sort((a, b) => a.page - b.page || a.ts - b.ts)
    const groups: Array<{ page: number; notes: PdfNote[] }> = []
    for (const n of sorted) {
      const last = groups[groups.length - 1]
      if (last && last.page === n.page) last.notes.push(n)
      else groups.push({ page: n.page, notes: [n] })
    }
    return groups
  }, [notes])

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const removeIds = (ids: string[]) => {
    onRemove(ids)
    setSelected(new Set())
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border-muted bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-muted px-3">
        <span className="text-[13px] font-medium text-text-primary">批注</span>
        <span className="rounded-full bg-surface-raised px-1.5 text-[10px] text-text-secondary">
          {notes.length}
        </span>
        {selected.size > 0 && (
          <button
            className="ml-auto rounded-md px-2 py-1 text-[11px] text-error transition-colors hover:bg-surface-overlay"
            onClick={() => removeIds([...selected])}
          >
            删除所选 ({selected.size})
          </button>
        )}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {noTextLayer && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] leading-snug text-warning">
            此 PDF 没有文本层（可能是扫描件），无法进行选词高亮。
          </div>
        )}
        {grouped.length === 0 && !noTextLayer && (
          <div className="mt-8 px-4 text-center text-xs leading-relaxed text-text-muted">
            暂无批注
            <br />
            选中文本后即可添加
          </div>
        )}
        {grouped.map(group => (
          <div key={group.page} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
                第 {group.page} 页
              </span>
              <span className="h-px flex-1 bg-border-muted" />
            </div>
            {group.notes.map(note => (
              <NoteEntry
                key={note.id}
                note={note}
                documentVersion={documentVersion}
                active={note.id === activeNoteId}
                checked={selected.has(note.id)}
                onToggle={() => toggle(note.id)}
                onJump={() => onJump(note)}
                onDelete={() => removeIds([note.id])}
                onEdit={text => onEdit(note.id, text)}
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
