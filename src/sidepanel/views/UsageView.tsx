import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { iconArrowLeft, iconDownload, iconChevronDown } from '../../shared/icons'
import { loadSessionIndex, SESSION_INDEX_KEY } from '../../shared/storage'
import {
  formatCacheHitRate, formatUsageValue, localUsageDay, sumUsage, usageCsv, usageDays,
  USAGE_FIELDS, USAGE_ENABLED_KEY, USAGE_STORAGE_KEY, type UsageField, type UsageRow, type UsageStore,
} from '../../shared/token-usage'

const labels: Record<UsageField, string> = {
  input: '输入', output: '输出', read: '缓存读取', write: '缓存写入', reasoning: '推理',
}
const english: Record<UsageField, string> = {
  input: 'Input', output: 'Output', read: 'Cache read', write: 'Cache write', reasoning: 'Reasoning',
}

function valueTitle(total: ReturnType<typeof sumUsage>, field: UsageField) {
  if (!total.calls) return undefined
  return `${labels[field]}：${total.tokens[field].toLocaleString()} tokens${total.missing[field] ? `；${total.missing[field]} 次请求未返回此项` : ''}`
}

function UsageDetails({ rows }: { rows: UsageRow[] }) {
  const total = sumUsage(rows)
  return <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-secondary">
    {USAGE_FIELDS.filter(field => field !== 'reasoning' || total.missing.reasoning < total.calls).map(field => (
      <span key={field} title={valueTitle(total, field)}>{labels[field]} <span className="tabular-nums">{formatUsageValue(total, field)}</span></span>
    ))}
    <span title="缓存读取 token ÷ 输入 token">缓存命中率 <span className="tabular-nums">{formatCacheHitRate(total)}</span></span>
  </div>
}

export default function UsageView({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<UsageRow[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [days, setDays] = useState(7)
  const [provider, setProvider] = useState('')
  const [dimension, setDimension] = useState<'provider' | 'session'>('provider')
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toggleError, setToggleError] = useState('')
  const [error, setError] = useState('')
  const [today, setToday] = useState(() => localUsageDay())

  useEffect(() => {
    let active = true
    let revision = 0
    let enabledRevision = 0
    const loadNames = async () => {
      const sessions = await loadSessionIndex()
      if (active) setNames(Object.fromEntries(sessions.map(s => [s.id, s.title || '未命名会话'])))
    }
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return
      if (changes[USAGE_ENABLED_KEY]) {
        enabledRevision++
        setEnabled(changes[USAGE_ENABLED_KEY].newValue !== false)
      }
      if (changes[USAGE_STORAGE_KEY]) {
        revision++
        setRows((changes[USAGE_STORAGE_KEY].newValue as UsageStore | undefined)?.rows ?? [])
      }
      if (changes[SESSION_INDEX_KEY]) void loadNames().catch(() => {})
    }
    chrome.storage.onChanged.addListener(changed)
    const initialRevision = revision
    Promise.all([chrome.storage.local.get([USAGE_STORAGE_KEY, USAGE_ENABLED_KEY]), loadNames()]).then(([stored]) => {
      if (active && initialRevision === revision) setRows((stored[USAGE_STORAGE_KEY] as UsageStore | undefined)?.rows ?? [])
      if (active && enabledRevision === 0) setEnabled(stored[USAGE_ENABLED_KEY] !== false)
    }).catch(() => {
      if (active) setError('用量读取失败，请返回后重试。')
    }).finally(() => { if (active) setLoading(false) })
    const timer = setInterval(() => setToday(localUsageDay()), 60_000)
    return () => { active = false; clearInterval(timer); chrome.storage.onChanged.removeListener(changed) }
  }, [])

  const dates = useMemo(() => usageDays(days, new Date(`${today}T12:00:00`)), [days, today])
  const retainedRows = useMemo(() => {
    const cutoff = usageDays(90, new Date(`${today}T12:00:00`))[0]
    return rows.filter(row => row.day >= cutoff && row.day <= today)
  }, [rows, today])
  const providers = useMemo(() => [...new Map(retainedRows.map(row => [row.provider, row.name])).entries()], [retainedRows])
  const filtered = useMemo(() => retainedRows.filter(row => row.day >= dates[0] && (!provider || row.provider === provider)), [retainedRows, dates, provider])
  const total = useMemo(() => sumUsage(filtered), [filtered])
  const daily = useMemo(() => dates.map(day => ({ day, ...sumUsage(filtered.filter(row => row.day === day)) })), [dates, filtered])
  const maxDaily = Math.max(1, ...daily.map(day => day.tokens.input + day.tokens.output))
  const groups = useMemo(() => {
    const grouped = new Map<string, UsageRow[]>()
    for (const row of filtered) {
      const key = dimension === 'provider' ? JSON.stringify([row.provider, row.model]) : row.session
      grouped.set(key, [...(grouped.get(key) ?? []), row])
    }
    return [...grouped.entries()].map(([key, entries]) => ({ key, rows: entries, total: sumUsage(entries) }))
      .sort((a, b) => b.total.tokens.input + b.total.tokens.output - a.total.tokens.input - a.total.tokens.output)
  }, [filtered, dimension])
  const largest = Math.max(1, ...groups.map(group => group.total.tokens.input + group.total.tokens.output))

  const toggleRecording = async () => {
    if (saving) return
    const next = !enabled
    setSaving(true)
    setToggleError('')
    try {
      // Reason: share the writer lock so disabling waits for pending records and blocks subsequent ones.
      await navigator.locks.request(USAGE_STORAGE_KEY, () => chrome.storage.local.set({ [USAGE_ENABLED_KEY]: next }))
      setEnabled(next)
    } catch { setToggleError('保存失败，请重试。') }
    finally { setSaving(false) }
  }

  const exportCsv = () => {
    try {
      const blob = new Blob([usageCsv(filtered, names)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `sidekick-usage-${dates[0]}-${today}.csv`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setError('导出失败，请重试。') }
  }

  return <div className="flex min-h-full flex-col bg-surface">
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface px-4 pt-3 pb-2">
      <button onClick={onBack} aria-label="返回设置" className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"><Icon icon={iconArrowLeft} className="text-base" /></button>
      <h2 className="text-sm font-semibold text-text-primary">用量统计</h2>
      <button onClick={exportCsv} disabled={!filtered.length || loading} className="ml-auto flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay disabled:opacity-40"><Icon icon={iconDownload} className="text-xs" />导出 CSV</button>
    </div>
    <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
      <button type="button" role="switch" aria-checked={enabled} disabled={loading || saving} onClick={toggleRecording} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-overlay/40 disabled:opacity-50">
        <span className={`flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-surface-overlay'}`} aria-hidden="true">
          <span className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </span>
        <span className="text-[12px] text-text-primary">记录用量</span>
      </button>
      {toggleError && <p role="alert" className="text-[11px] text-error">{toggleError}</p>}
      <div className="flex gap-2.5">
        <div className="relative min-w-0 flex-1">
          <select className="input-base appearance-none pr-8 !text-[12px]" aria-label="时间范围" value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={1}>今天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option>
          </select>
          <Icon icon={iconChevronDown} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-text-muted" />
        </div>
        <div className="relative min-w-0 flex-1">
          <select className="input-base appearance-none pr-8 !text-[12px]" aria-label="Provider" value={provider} onChange={e => setProvider(e.target.value)}>
            <option value="">全部 Provider</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <Icon icon={iconChevronDown} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-text-muted" />
        </div>
      </div>
      {error && <p role="alert" className="text-[11px] text-error">{error}</p>}
      {loading ? <p className="py-8 text-center text-[12px] text-text-muted">加载中…</p> : <>
        <section className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
          <div className="flex items-center justify-between gap-2"><h3 className="text-[11px] font-semibold tracking-wide text-text-muted">Token 用量</h3><span className="text-[11px] tabular-nums text-text-muted">{total.calls.toLocaleString()} 次请求</span></div>
          <div className="mt-2.5 grid grid-cols-2 gap-x-5 gap-y-3" aria-live="polite">
            {(['input', 'output', 'read', 'write'] as const).map(field => <div key={field}>
              <div className="text-[11px] text-text-secondary">{labels[field]} {english[field]}</div>
              <div className="text-xl leading-relaxed font-medium tracking-tight tabular-nums text-text-primary" title={valueTitle(total, field)}>{formatUsageValue(total, field)}</div>
            </div>)}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border-muted pt-2 text-[11px]" aria-live="polite" title="缓存读取 token ÷ 输入 token">
            <span className="text-text-secondary">缓存命中率</span>
            <span className="font-medium tabular-nums text-text-primary">{formatCacheHitRate(total)}</span>
          </div>
        </section>
        {!filtered.length ? <p className="py-8 text-center text-[12px] text-text-muted">暂无用量记录</p> : <>
          <section className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
            <div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold tracking-wide text-text-muted">每日消耗</h3><span className="text-[10px] text-text-muted">tokens</span></div>
            <div className="mt-2.5 mb-2 flex gap-3 text-[10px] text-text-secondary"><span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-xs bg-text-muted/60" />输入（含缓存）</span><span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-xs bg-accent" />输出</span></div>
            <div className="relative pl-8">
              <span className="absolute top-0 left-0 text-[10px] tabular-nums text-text-muted">{maxDaily >= 1000 ? `${Math.ceil(maxDaily / 1000)}K` : maxDaily}</span>
              <span className="absolute bottom-4 left-0 text-[10px] text-text-muted">0</span>
              <div className="flex h-28 items-end gap-px border-b border-border-muted" role="img" aria-label={`每日输入与输出用量，${dates[0]} 至 ${today}`}>
                {daily.map(day => <div key={day.day} className="flex h-full min-w-0 flex-1 items-end justify-center" title={`${day.day}\n输入 ${formatUsageValue(day, 'input')}\n输出 ${formatUsageValue(day, 'output')}`}>
                  <div className="flex w-full max-w-6 flex-col-reverse overflow-hidden rounded-t-xs" style={{ height: `${(day.tokens.input + day.tokens.output) / maxDaily * 100}%` }}>
                    <div className="bg-text-muted/60" style={{ height: `${day.tokens.input / Math.max(1, day.tokens.input + day.tokens.output) * 100}%` }} />
                    <div className="bg-accent" style={{ height: `${day.tokens.output / Math.max(1, day.tokens.input + day.tokens.output) * 100}%` }} />
                  </div>
                </div>)}
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-text-muted"><span>{dates[0].slice(5).replace('-', '/')}</span>{days > 1 && <span>{today.slice(5).replace('-', '/')}</span>}</div>
            </div>
          </section>
          <section className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
            <div className="mb-1 flex w-fit rounded-md bg-surface-overlay p-0.5" aria-label="统计维度">
              {(['provider', 'session'] as const).map(value => <button key={value} aria-pressed={dimension === value} onClick={() => setDimension(value)} className={`rounded-sm px-2.5 py-1 text-[11px] transition-colors ${dimension === value ? 'bg-surface-raised text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}>{value === 'provider' ? 'Provider' : 'Session'}</button>)}
            </div>
            {groups.map(group => {
              const first = group.rows[0]
              const title = dimension === 'provider' ? first.name : first.session ? names[first.session] ?? `已删除会话 · ${first.session.slice(0, 8)}` : '后台任务'
              const subtitle = dimension === 'provider' ? first.model : [...new Set(group.rows.map(row => `${row.name} · ${row.model}`))].join(' / ')
              const n = group.total.tokens.input + group.total.tokens.output
              const incomplete = group.total.missing.input > 0 || group.total.missing.output > 0
              const known = group.total.missing.input < group.total.calls || group.total.missing.output < group.total.calls
              return <div key={group.key} className="border-b border-border-muted py-2.5 last:border-0 last:pb-0">
                <div className="flex items-center gap-2"><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-medium text-text-primary" title={title}>{title}</div><div className="truncate text-[10px] text-text-muted" title={subtitle}>{subtitle}</div></div><div className="shrink-0 text-right"><div className="font-mono text-[13px] text-text-primary">{!known ? '—' : `${incomplete ? '≥ ' : ''}${n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n}`}</div><div className="text-[10px] text-text-muted">{group.total.calls} 次</div></div></div>
                <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-surface-overlay"><div className="h-full bg-accent/75" style={{ width: `${n / largest * 100}%` }} /></div>
                <UsageDetails rows={group.rows} />
                {dimension === 'session' && new Set(group.rows.map(row => `${row.provider}\0${row.model}`)).size > 1 && <details className="group mt-2"><summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-text-muted"><Icon icon={iconChevronDown} className="-rotate-90 transition-transform group-open:rotate-0" />模型明细</summary>{[...new Set(group.rows.map(row => JSON.stringify([row.provider, row.model])))].map(key => {
                  const entries = group.rows.filter(row => JSON.stringify([row.provider, row.model]) === key)
                  return <div key={key} className="mt-2 pl-3"><div className="text-[10px] text-text-secondary">{entries[0].name} · {entries[0].model}</div><UsageDetails rows={entries} /></div>
                })}</details>}
              </div>
            })}
          </section>
        </>}
      </>}
    </div>
  </div>
}
