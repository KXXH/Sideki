import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { iconArrowLeft, iconDownload, iconChevronDown } from '../../shared/icons'
import { loadSessionIndex, SESSION_INDEX_KEY } from '../../shared/storage'
import {
  formatCacheHitRate, formatUsageValue, localUsageDay, sumUsage, usageCsv, usageDays,
  isLegacyApprovalUsage, usageLastAt, usageSessionLabel, usageSource, USAGE_SOURCE_LABELS,
  USAGE_FIELDS, USAGE_ENABLED_KEY, USAGE_STORAGE_KEY, type UsageField, type UsageRow, type UsageStore,
  type UsageSource,
} from '../../shared/token-usage'

const labels: Record<UsageField, string> = {
  input: '输入', output: '输出', read: '缓存读取', write: '缓存写入', reasoning: '推理',
}
const english: Record<UsageField, string> = {
  input: 'Input', output: 'Output', read: 'Cache read', write: 'Cache write', reasoning: 'Reasoning',
}
const PAGE_SIZE = 10
const activityTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
type UsageSort = 'recent' | 'tokens' | 'calls'
interface UsageGroup {
  key: string
  rows: UsageRow[]
  total: ReturnType<typeof sumUsage>
  latest: UsageRow
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

function UsageAmount({ total, combined = false, compact = false }: { total: ReturnType<typeof sumUsage>; combined?: boolean; compact?: boolean }) {
  const n = total.tokens.input + total.tokens.output
  const incomplete = total.missing.input > 0 || total.missing.output > 0
  const known = total.missing.input < total.calls || total.missing.output < total.calls
  return <div className="shrink-0 text-right">
    <div className={`font-mono text-text-primary ${compact ? 'text-[11px]' : 'text-[13px]'}`}>{!known ? '—' : `${incomplete ? '≥ ' : ''}${n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n}`}</div>
    <div className="text-[10px] text-text-muted">{combined ? '合计 · ' : ''}{total.calls} 次</div>
  </div>
}

function ModelBreakdown({ rows }: { rows: UsageRow[] }) {
  const models = new Map<string, UsageRow[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.provider, row.model])
    const entries = models.get(key)
    if (entries) entries.push(row)
    else models.set(key, [row])
  }
  if (models.size <= 1) return null
  return <details className="group/model mt-2">
    <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-text-muted"><Icon icon={iconChevronDown} aria-hidden="true" className="-rotate-90 transition-transform group-open/model:rotate-0" />模型明细</summary>
    {[...models.entries()].map(([key, entries]) => <div key={key} className="mt-2 pl-3">
      <div className="text-[10px] text-text-secondary">{entries[0].name} · {entries[0].model}</div><UsageDetails rows={entries} />
    </div>)}
  </details>
}

function UsageGroupItem({ group, dimension, names, largest }: { group: UsageGroup; dimension: 'provider' | 'session'; names: Record<string, string>; largest: number }) {
  const first = group.rows[0]
  const title = dimension === 'provider' ? first.name : usageSessionLabel(first, names)
  const modelLabel = dimension === 'provider' ? first.model : [...new Set(group.rows.map(row => `${row.name} · ${row.model}`))].join(' / ')
  const subtitle = `最近使用 ${group.latest.lastAt == null ? group.latest.day : activityTime.format(group.latest.lastAt)} · ${modelLabel}`
  const sources = (['main', 'approval'] as const).map(source => ({ source, rows: group.rows.filter(row => usageSource(row) === source) })).filter(item => item.rows.length)
  const n = group.total.tokens.input + group.total.tokens.output
  return <article aria-label={title} className="border-b border-border-muted py-2.5 last:border-0 last:pb-0">
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><div className="truncate text-[12px] font-medium text-text-primary" title={title}>{title}</div><div className="truncate text-[10px] text-text-muted" title={subtitle}>{subtitle}</div></div>
      <UsageAmount total={group.total} combined />
    </div>
    <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-surface-overlay"><div className="h-full bg-accent/75" style={{ width: `${n / largest * 100}%` }} /></div>
    <UsageDetails rows={group.rows} />
    <details className="group/source mt-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] text-text-muted">
        <Icon icon={iconChevronDown} aria-hidden="true" className="-rotate-90 transition-transform group-open/source:rotate-0" />
        {sources.map(item => USAGE_SOURCE_LABELS[item.source]).join(' / ')}
      </summary>
      <div className="mt-2 space-y-3 border-l border-border-muted pl-3">
        {sources.map(item => <div key={item.source} role="group" aria-label={`${USAGE_SOURCE_LABELS[item.source]}用量`}>
          <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-text-secondary">{USAGE_SOURCE_LABELS[item.source]}</span><UsageAmount total={sumUsage(item.rows)} compact /></div>
          <UsageDetails rows={item.rows} />
          <ModelBreakdown rows={item.rows} />
        </div>)}
      </div>
    </details>
  </article>
}

export default function UsageView({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<UsageRow[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [days, setDays] = useState(7)
  const [provider, setProvider] = useState('')
  const [source, setSource] = useState<UsageSource | 'all'>('all')
  const [dimension, setDimension] = useState<'provider' | 'session'>('session')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<UsageSort>('recent')
  const [page, setPage] = useState(1)
  const detailsRef = useRef<HTMLElement>(null)
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
  const needle = query.trim().toLocaleLowerCase()
  const filtered = useMemo(() => retainedRows.filter(row => row.day >= dates[0] && (!provider || row.provider === provider)
    && (source === 'all' || usageSource(row) === source)
    && (!needle || `${usageSessionLabel(row, names)} ${row.session}`.toLocaleLowerCase().includes(needle))), [retainedRows, dates, provider, source, needle, names])
  const total = useMemo(() => sumUsage(filtered), [filtered])
  const daily = useMemo(() => dates.map(day => ({ day, ...sumUsage(filtered.filter(row => row.day === day)) })), [dates, filtered])
  const maxDaily = Math.max(1, ...daily.map(day => day.tokens.input + day.tokens.output))
  const groups = useMemo(() => {
    const grouped = new Map<string, UsageRow[]>()
    for (const row of filtered) {
      // Reason: source rows belong to one parent; pagination must never split a chat from its approval child.
      const key = JSON.stringify(dimension === 'provider' ? [row.provider, row.model]
        : [isLegacyApprovalUsage(row) ? 'legacy-approval' : row.session])
      const entries = grouped.get(key)
      if (entries) entries.push(row)
      else grouped.set(key, [row])
    }
    return [...grouped.entries()].map(([key, entries]) => ({ key, rows: entries, total: sumUsage(entries),
      latest: entries.reduce((latest, row) => usageLastAt(row) > usageLastAt(latest) ? row : latest) }))
      .sort((a, b) => (sort === 'recent' ? usageLastAt(b.latest) - usageLastAt(a.latest)
        : sort === 'calls' ? b.total.calls - a.total.calls
          : b.total.tokens.input + b.total.tokens.output - a.total.tokens.input - a.total.tokens.output) || a.key.localeCompare(b.key))
  }, [filtered, dimension, sort])
  const largest = Math.max(1, ...groups.map(group => group.total.tokens.input + group.total.tokens.output))
  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
  // Reason: storage pruning or live updates can shrink the last page without a user filter change.
  const currentPage = Math.min(page, pageCount)
  const pageGroups = groups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const goToPage = (next: number) => {
    setPage(Math.max(1, Math.min(next, pageCount)))
    detailsRef.current?.scrollIntoView?.({ block: 'start' })
  }

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
      link.download = `sideki-usage-${dates[0]}-${today}.csv`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setError('导出失败，请重试。') }
  }

  return <div className="flex min-h-full flex-col bg-surface">
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface px-4 pt-3 pb-2">
      <button onClick={onBack} aria-label="返回设置" className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"><Icon icon={iconArrowLeft} className="text-base" /></button>
      <h2 className="text-sm font-semibold text-text-primary">用量统计</h2>
      <button onClick={exportCsv} title="导出全部筛选结果，不限当前页" disabled={!filtered.length || loading} className="ml-auto flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay disabled:opacity-40"><Icon icon={iconDownload} className="text-xs" />导出 CSV</button>
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
          <select className="input-base appearance-none pr-8 !text-[12px]" aria-label="时间范围" value={days} onChange={e => { setDays(Number(e.target.value)); setPage(1) }}>
            <option value={1}>今天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option>
          </select>
          <Icon icon={iconChevronDown} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-text-muted" />
        </div>
        <div className="relative min-w-0 flex-1">
          <select className="input-base appearance-none pr-8 !text-[12px]" aria-label="Provider" value={provider} onChange={e => { setProvider(e.target.value); setPage(1) }}>
            <option value="">全部 Provider</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <Icon icon={iconChevronDown} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-text-muted" />
        </div>
      </div>
      <input type="search" aria-label="搜索会话" placeholder="搜索会话名称或 ID" value={query}
        onChange={event => { setQuery(event.target.value); setPage(1) }} className="input-base !text-[12px]" />
      <div className="flex w-fit rounded-md bg-surface-overlay p-0.5" role="group" aria-label="用量来源">
        {(['all', 'main', 'approval'] as const).map(value => <button key={value} type="button" aria-pressed={source === value} onClick={() => { setSource(value); setPage(1) }}
          className={`rounded-sm px-2.5 py-1 text-[11px] transition-colors ${source === value ? 'bg-surface-raised text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}>
          {value === 'all' ? '全部' : USAGE_SOURCE_LABELS[value]}
        </button>)}
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
        {!filtered.length ? <p className="py-8 text-center text-[12px] text-text-muted">{needle ? '没有匹配的会话用量' : '暂无用量记录'}</p> : <>
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
          <section ref={detailsRef} className="scroll-mt-12 rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="flex w-fit rounded-md bg-surface-overlay p-0.5" aria-label="统计维度">
                {(['provider', 'session'] as const).map(value => <button key={value} aria-pressed={dimension === value} onClick={() => { setDimension(value); setPage(1) }} className={`rounded-sm px-2.5 py-1 text-[11px] transition-colors ${dimension === value ? 'bg-surface-raised text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}>{value === 'provider' ? 'Provider' : 'Session'}</button>)}
              </div>
              <div className="relative shrink-0">
                <select aria-label="明细排序" value={sort} onChange={event => { setSort(event.target.value as UsageSort); setPage(1) }}
                  className="appearance-none rounded-md border border-border-subtle bg-surface-raised py-1 pl-2.5 pr-7 text-[11px] text-text-secondary">
                  <option value="recent">最近使用</option><option value="tokens">用量最高</option><option value="calls">请求最多</option>
                </select>
                <Icon icon={iconChevronDown} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-text-muted" />
              </div>
            </div>
            {pageGroups.map(group => <UsageGroupItem key={group.key} group={group} dimension={dimension} names={names} largest={largest} />)}
            <nav aria-label="用量明细分页" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
              <span className="tabular-nums">共 {groups.length} {dimension === 'session' ? '个会话' : '项'} · 每页 {PAGE_SIZE} {dimension === 'session' ? '个' : '项'}</span>
              <div className="flex items-center gap-1">
                <button type="button" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)} className="rounded px-1.5 py-1 transition-colors hover:bg-surface-overlay hover:text-text-primary disabled:opacity-35">上一页</button>
                <label className="flex items-center gap-1"><span className="sr-only">页码</span>
                  <input aria-label="页码" type="number" min={1} max={pageCount} value={currentPage}
                    onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1) goToPage(next) }}
                    className="w-12 rounded border border-border-subtle bg-surface-raised px-1 py-0.5 text-center tabular-nums text-text-primary" />
                  <span className="tabular-nums">/ {pageCount}</span>
                </label>
                <button type="button" disabled={currentPage === pageCount} onClick={() => goToPage(currentPage + 1)} className="rounded px-1.5 py-1 transition-colors hover:bg-surface-overlay hover:text-text-primary disabled:opacity-35">下一页</button>
              </div>
            </nav>
          </section>
        </>}
      </>}
    </div>
  </div>
}
