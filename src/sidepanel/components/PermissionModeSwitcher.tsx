import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { iconCheck, iconPermissionAsk, iconPermissionAuto, iconPermissionAllow } from '../../shared/icons'
import type { PermissionMode } from '../../shared/types'
import { PERMISSION_MODES, PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_LABELS } from '../../shared/permission-mode'
import AnimatedPopover from './AnimatedPopover'
import { ModelSwitcherTrigger } from './ModelSwitcher'

interface Props {
  value: PermissionMode
  onChange(mode: PermissionMode): Promise<void> | void
  disabled?: boolean
}

const permissionIcons = { ask: iconPermissionAsk, auto: iconPermissionAuto, allow: iconPermissionAllow }

export default function PermissionModeSwitcher({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const anchor = `--permission-${id.replace(/[^a-zA-Z0-9-]/g, '')}`

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const outside = (event: MouseEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  async function choose(mode: PermissionMode) {
    if (saving) return
    if (mode === value) { setOpen(false); trigger.current?.focus(); return }
    setSaving(true)
    setError('')
    try {
      await onChange(mode)
      setOpen(false)
      trigger.current?.focus()
    } catch {
      setError('权限保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return <div className="shrink-0">
    <ModelSwitcherTrigger ref={trigger} label={value === 'auto' ? '自动审批' : PERMISSION_MODE_LABELS[value]} open={open} tone={value === 'allow' ? 'warning' : 'default'}
      disabled={disabled || saving} aria-label={`当前对话权限：${PERMISSION_MODE_LABELS[value]}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      style={{ anchorName: anchor } as React.CSSProperties}
      onClick={() => { setOpen(current => !current); setError('') }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
      <Icon icon={permissionIcons[value]} aria-hidden="true" className="shrink-0 text-xs" />
    </ModelSwitcherTrigger>
    <AnimatedPopover open={open} direction="up" ref={menu} role="menu" id={id} aria-label="当前对话权限"
      style={{ positionAnchor: anchor, bottom: 'anchor(top)', left: 'clamp(8px, anchor(left), calc(100vw - 280px))' } as React.CSSProperties}
      className="theme-overlay fixed z-50 mb-2 w-[264px] max-w-[calc(100vw_-_16px)] rounded-lg p-1"
      onKeyDown={event => {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        let next: number
        if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
        else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = buttons.length - 1
        else if (event.key === 'Tab') { setOpen(false); return }
        else return
        event.preventDefault()
        buttons[next]?.focus()
      }}>
      <p className="px-2.5 py-2 text-[10px] text-text-muted">当前对话权限</p>
      {PERMISSION_MODES.map(mode => <button key={mode} type="button" role="menuitemradio" aria-checked={mode === value}
        tabIndex={mode === value ? 0 : -1} disabled={saving} onClick={() => { void choose(mode) }}
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50 ${mode === 'allow' ? `text-warning ${mode === value ? 'bg-warning/10' : 'hover:bg-warning/5'}` : mode === value ? 'bg-accent-wash text-accent' : 'text-text-secondary hover:bg-surface-overlay'}`}>
        <Icon icon={permissionIcons[mode]} aria-hidden="true" className="shrink-0 self-start mt-0.5 text-sm" />
        <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{PERMISSION_MODE_LABELS[mode]}</span><span className="mt-0.5 block text-[10px] leading-relaxed text-text-muted">{PERMISSION_MODE_DESCRIPTIONS[mode]}</span></span>
        <span className="w-3 shrink-0">{mode === value && <Icon icon={iconCheck} className="text-xs" />}</span>
      </button>)}
      {error && <p role="alert" className="px-2.5 py-2 text-[11px] text-error">{error}</p>}
    </AnimatedPopover>
  </div>
}
