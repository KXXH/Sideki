export const USAGE_STORAGE_KEY = 'sidekick_token_usage_v1'
export const USAGE_ENABLED_KEY = 'sidekick_token_usage_enabled'
export const USAGE_RETENTION_DAYS = 90
export const USAGE_MAX_BYTES = 1024 * 1024
export const USAGE_FIELDS = ['input', 'output', 'read', 'write', 'reasoning'] as const
export type UsageField = typeof USAGE_FIELDS[number]
export type TokenCounts = Record<UsageField, number | null>

export interface UsageEvent {
  id: string
  at: number
  session: string
  provider: string
  name: string
  model: string
  tokens: TokenCounts
}

export interface UsageRow {
  day: string
  session: string
  provider: string
  name: string
  model: string
  calls: number
  tokens: Record<UsageField, number>
  missing: Record<UsageField, number>
}

export interface UsageStore {
  version: 1
  rows: UsageRow[]
  recent: string[]
}

export function localUsageDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function usageDays(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(now)
    // Reason: calendar arithmetic preserves midnight boundaries across DST changes.
    date.setDate(date.getDate() - count + i + 1)
    return localUsageDay(date)
  })
}

export function emptyUsageTotals() {
  return {
    calls: 0,
    tokens: { input: 0, output: 0, read: 0, write: 0, reasoning: 0 },
    missing: { input: 0, output: 0, read: 0, write: 0, reasoning: 0 },
  }
}

export function sumUsage(rows: UsageRow[]) {
  const total = emptyUsageTotals()
  for (const row of rows) {
    total.calls += row.calls
    for (const field of USAGE_FIELDS) {
      total.tokens[field] += row.tokens[field]
      total.missing[field] += row.missing[field]
    }
  }
  return total
}

export function isUsageEvent(value: unknown): value is UsageEvent {
  if (!value || typeof value !== 'object') return false
  const e = value as UsageEvent
  return typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 100
    && Number.isFinite(e.at) && e.at > 0 && e.at < 8.64e15
    && ['session', 'provider', 'name', 'model'].every(key => {
      const value = e[key as keyof UsageEvent]
      return typeof value === 'string' && value.length <= 200
    })
    && !!e.tokens && USAGE_FIELDS.every(field => e.tokens[field] === null
      || (Number.isSafeInteger(e.tokens[field]) && e.tokens[field]! >= 0))
}

export function pruneUsage(store: UsageStore, now = new Date(), maxBytes = USAGE_MAX_BYTES): UsageStore {
  const cutoff = usageDays(USAGE_RETENTION_DAYS, now)[0]
  const rows = store.rows.filter(row => row.day >= cutoff).sort((a, b) => a.day.localeCompare(b.day))
  const recent = store.recent.slice(-128)
  // Reason: count serialized UTF-8 bytes, including non-ASCII profile names, before writing.
  const encoder = new TextEncoder()
  const overhead = encoder.encode(JSON.stringify({ version: 1, rows: [], recent })).length
  const sizes = rows.map(row => encoder.encode(JSON.stringify(row)).length + 1)
  let bytes = overhead + sizes.reduce((a, b) => a + b, 0)
  let drop = 0
  while (bytes > maxBytes && drop < rows.length) bytes -= sizes[drop++]
  return { version: 1, rows: rows.slice(drop), recent }
}

export function recordUsage(store: UsageStore | undefined, event: UsageEvent, now = new Date()): UsageStore {
  const current = pruneUsage(store ?? { version: 1, rows: [], recent: [] }, now)
  if (current.recent.includes(event.id)) return current
  const day = localUsageDay(new Date(event.at))
  if (day < usageDays(USAGE_RETENTION_DAYS, now)[0]) return current
  const rows = current.rows.slice()
  const index = rows.findIndex(row => row.day === day && row.session === event.session
    && row.provider === event.provider && row.model === event.model)
  const existing = rows[index]
  const row: UsageRow = existing
    ? { ...existing, name: event.name, tokens: { ...existing.tokens }, missing: { ...existing.missing } }
    : { day, session: event.session, provider: event.provider, name: event.name, model: event.model, ...emptyUsageTotals() }
  row.calls++
  for (const field of USAGE_FIELDS) {
    const value = event.tokens[field]
    if (value === null) row.missing[field]++
    else row.tokens[field] += value
  }
  if (index < 0) rows.push(row)
  else rows[index] = row
  return pruneUsage({ version: 1, rows, recent: [...current.recent, event.id] }, now)
}

export function cacheHitRate(total: ReturnType<typeof sumUsage>): number | null {
  // Reason: absent cache counts must not lower the rate; only complete input/read totals share a denominator.
  if (!total.calls || total.missing.input || total.missing.read || total.tokens.input <= 0
    || total.tokens.read > total.tokens.input) return null
  return total.tokens.read / total.tokens.input
}

export function formatCacheHitRate(total: ReturnType<typeof sumUsage>): string {
  const rate = cacheHitRate(total)
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

export function formatUsageValue(total: ReturnType<typeof sumUsage>, field: UsageField): string {
  if (!total.calls || total.missing[field] === total.calls) return '—'
  const n = total.tokens[field]
  const value = n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
  return total.missing[field] ? `≥ ${value}` : value
}

function csvCell(value: string | number): string {
  // Reason: spreadsheet apps must not execute user-controlled names as formulas.
  const text = String(value).replace(/^[\s]*[=+@-]/, match => `'${match}`)
  return `"${text.replace(/"/g, '""')}"`
}

export function usageCsv(rows: UsageRow[], sessionNames: Record<string, string> = {}): string {
  const headers = ['date', 'provider_id', 'provider', 'model', 'session_id', 'session', 'requests',
    'input', 'output', 'cache_read', 'cache_write', 'reasoning',
    ...USAGE_FIELDS.map(field => `${field}_missing_requests`)]
  return '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map(row => [
    row.day, row.provider, row.name, row.model, row.session,
    row.session ? sessionNames[row.session] ?? row.session : '后台任务', row.calls,
    ...USAGE_FIELDS.map(field => row.missing[field] === row.calls ? '' : row.tokens[field]),
    ...USAGE_FIELDS.map(field => row.missing[field]),
  ].map(csvCell).join(','))].join('\r\n')
}
