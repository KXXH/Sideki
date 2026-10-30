import { useState, useRef, useEffect, useId, type ComponentPropsWithRef } from 'react'
import AnimatedPopover from './AnimatedPopover'
import { Icon } from '@iconify/react'
import { iconCheck, iconChevronDown, iconCog } from '../../shared/icons'
import { saveConfig, applyProfile } from '../../shared/storage'
import { REASONING_LABELS, reasoningOptions } from '../../shared/model-services'
import type { ApiConfig, ReasoningEffort } from '../../shared/types'
import { usePopoverHeight } from '../hooks/use-popover-height'

interface Props {
  config: ApiConfig | null
  disabled: boolean
  onOpenSettings: () => void
  direction?: 'up' | 'down'
}

export function ModelSwitcherTrigger({ label, open = false, ...props }: ComponentPropsWithRef<'button'> & { label: string; open?: boolean }) {
  return <button {...props} type="button" className={`flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-[11px] transition-colors ${open ? 'bg-accent-wash text-accent' : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary'} disabled:opacity-50`}>
    <span className="max-w-[120px] truncate">{label}</span>
    <Icon icon={iconChevronDown} className={`shrink-0 text-[10px] transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
  </button>
}

function formatWindow(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`
  return `${Math.round(v / 1000)}K`
}

function providerLabel(endpoint: string): string {
  try { return new URL(endpoint).host } catch { return endpoint }
}

export default function ModelSwitcher({ config, disabled, onOpenSettings, direction = 'down' }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const anchor = `--model-${id.replace(/[^a-zA-Z0-9-]/g, '')}`
  const maxHeight = usePopoverHeight(open, btnRef, direction)

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    if ((config?.profiles?.length ?? 0) > 6) searchRef.current?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, config?.profiles?.length])

  async function persist(next: ApiConfig, close: boolean) {
    if (disabled || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await saveConfig(next)
      if (close) { setOpen(false); btnRef.current?.focus() }
    } catch {
      setError('保存失败，请重试')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (!config?.model) return null
  const profiles = config.profiles ?? []
  const active = profiles.find(p => p.id === config.activeProfileId)
  const contextWindow = active?.contextWindow ?? config.contextWindow
  const needle = query.trim().toLocaleLowerCase()
  const filtered = profiles.filter(p => `${p.name} ${p.serviceName || ''} ${p.model} ${p.endpoint}`.toLocaleLowerCase().includes(needle))

  return <>
    <ModelSwitcherTrigger ref={btnRef} label={active?.name || config.model} open={open} onClick={() => { setOpen(v => !v); setQuery(''); setError('') }}
      disabled={disabled || saving} aria-label={`切换模型：${active?.name || config.model}`} aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      style={{ anchorName: anchor } as React.CSSProperties}
      title={disabled ? '当前回复或压缩结束后可切换模型' : `${active?.name || config.model} · ${config.model}`} />
    <AnimatedPopover open={open} direction={direction} ref={popRef} role="dialog" id={id} aria-label="选择模型"
      style={{ positionAnchor: anchor, maxHeight, ...(direction === 'up' ? { bottom: 'anchor(top)' } : { top: 'anchor(bottom)' }), left: 'clamp(8px, anchor(left), calc(100vw - 304px))' } as React.CSSProperties}
      className={`theme-overlay fixed z-50 flex max-h-[min(440px,70vh)] w-72 max-w-[calc(100vw_-_16px)] flex-col rounded-lg p-1 ${direction === 'up' ? 'mb-2' : 'mt-1.5'}`}>
      <div className="flex shrink-0 items-center justify-between px-2.5 py-2 text-[11px] text-text-muted"><span>切换模型</span><span>{profiles.length || 1} 个配置</span></div>
      {profiles.length > 6 && <input ref={searchRef} aria-label="搜索模型" placeholder="搜索名称、模型或服务地址" value={query} onChange={e => setQuery(e.target.value)} className="mx-1 mb-1 shrink-0 rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent/40" />}
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {filtered.map(p => <button key={p.id} type="button" aria-pressed={p.id === config.activeProfileId} disabled={disabled || saving}
          onClick={() => { if (p.id === config.activeProfileId) { setOpen(false); btnRef.current?.focus() } else void persist(applyProfile(config, p.id), true) }}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${p.id === config.activeProfileId ? 'bg-accent-wash text-accent' : 'text-text-secondary hover:bg-surface-overlay'}`}>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs" title={p.model}>{p.name || p.model}</span><span className="block truncate text-[10px] text-text-muted" title={p.endpoint}>{p.serviceName || providerLabel(p.endpoint)}</span></span>
          {(p.contextWindow ?? config.contextWindow) > 0 && <span className="shrink-0 text-[10px] tabular-nums text-text-muted">{formatWindow(p.contextWindow ?? config.contextWindow)}</span>}
          <span className="w-3 shrink-0">{p.id === config.activeProfileId && <Icon icon={iconCheck} className="text-xs" />}</span>
        </button>)}
        {!profiles.length && <div className="px-2.5 py-2 text-xs text-text-primary">{config.model}<div className="mt-1 truncate text-[10px] text-text-muted">{providerLabel(config.endpoint)}</div></div>}
        {profiles.length > 0 && !filtered.length && <p className="px-2.5 py-3 text-xs text-text-muted">没有匹配的模型</p>}
      </div>
      <label className="mt-1 flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle px-2.5 py-2 text-[11px] text-text-secondary">
        <span>思考强度</span>
        <span className="relative min-w-0">
          <select aria-label="当前模型的思考强度" disabled={disabled || saving} value={config.reasoningEffort || ''}
            onChange={event => { const value = event.target.value as ReasoningEffort; void persist({ ...config, reasoningEffort: value, profiles: config.profiles?.map(p => p.id === config.activeProfileId ? { ...p, reasoningEffort: value } : p) }, false) }}
            className="appearance-none rounded-md border border-border-subtle bg-surface-raised py-1.5 pl-2.5 pr-8 text-[11px] text-text-primary transition-colors hover:border-accent/40 disabled:opacity-50">
            {!config.reasoningEffort && <option value="" disabled hidden>选择强度</option>}
            {reasoningOptions(config.model, config.apiProtocol).map(value => <option key={value} value={value}>{REASONING_LABELS[value].split(' · ')[0]}</option>)}
          </select>
          <Icon icon={iconChevronDown} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-text-muted" />
        </span>
      </label>
      {error && <p role="alert" className="px-2.5 pb-2 text-xs text-error">{error}</p>}
      <div className="flex shrink-0 items-center border-t border-border-subtle px-1 pt-1"><button type="button" disabled={saving} onClick={() => { setOpen(false); onOpenSettings() }} className="flex flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] text-text-secondary hover:bg-surface-overlay hover:text-accent"><Icon icon={iconCog} className="text-xs" />管理模型…</button>{contextWindow > 0 && <span className="pr-1.5 text-[10px] text-text-muted">当前 {formatWindow(contextWindow)}</span>}</div>
    </AnimatedPopover>
  </>
}
