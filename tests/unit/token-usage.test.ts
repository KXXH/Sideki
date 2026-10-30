import { beforeEach, describe, expect, it, vi } from 'vitest'
import { persistUsage } from '../../src/background/token-usage'
import {
  cacheHitRate, formatCacheHitRate, formatUsageValue, isUsageEvent, localUsageDay, pruneUsage, recordUsage, sumUsage,
  usageCsv, usageDays, usageLastAt, usageSource, usageSessionLabel, USAGE_ENABLED_KEY, USAGE_STORAGE_KEY, type UsageEvent, type UsageStore,
} from '../../src/shared/token-usage'

const now = new Date(2026, 9, 22, 12)
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: crypto.randomUUID(), at: now.getTime(), session: 'session-a', provider: 'p1',
  name: '服务商', model: 'model-a', tokens: { input: 1000, output: 100, read: 800, write: null, reasoning: 30 }, ...overrides,
})

describe('usage accounting', () => {
  it('retains the latest actual call time across delayed events and does not fabricate time for legacy rows', () => {
    const later = now.getTime() + 60_000
    let store = recordUsage(undefined, event({ at: later }), now)
    store = recordUsage(store, event({ at: now.getTime() }), now)
    expect(store.rows[0].lastAt).toBe(later)
    expect(usageLastAt(store.rows[0])).toBe(later)
    expect(usageCsv(store.rows)).toContain(new Date(later).toISOString())
    delete store.rows[0].lastAt
    expect(usageLastAt(store.rows[0])).toBe(new Date(`${store.rows[0].day}T00:00:00`).getTime())
    expect(usageCsv(store.rows)).not.toContain(new Date(later).toISOString())
    store = recordUsage(store, event(), now)
    expect(store.rows[0].lastAt).toBe(now.getTime())
    expect(sumUsage(store.rows).calls).toBe(3)
  })
  it('separates main and approval calls belonging to the same chat without changing combined totals', () => {
    let store = recordUsage(undefined, event(), now)
    delete store.rows[0].source
    store = recordUsage(store, event({ source: 'approval' }), now)
    store = recordUsage(store, event({ source: 'main' }), now)
    expect(store.rows).toHaveLength(2)
    expect(sumUsage(store.rows.filter(row => usageSource(row) === 'main')).tokens.input).toBe(2000)
    expect(sumUsage(store.rows.filter(row => usageSource(row) === 'approval')).tokens.input).toBe(1000)
    expect(sumUsage(store.rows).calls).toBe(3)
    expect(store.rows.every(row => row.session === 'session-a')).toBe(true)
    const csv = usageCsv(store.rows, { 'session-a': '同一个聊天' })
    expect(csv).toContain('"source"')
    expect(csv).toContain('"同一个聊天","main","2"')
    expect(csv).toContain('"同一个聊天","approval","1"')
  })

  it('recognizes old approval rows without inventing a parent chat or losing counts', () => {
    const store = recordUsage(undefined, event({ session: 'approval:old-request' }), now)
    delete store.rows[0].source
    expect(usageSource(store.rows[0])).toBe('approval')
    expect(usageSessionLabel(store.rows[0], {})).toBe('历史自动审批（未关联会话）')
    expect(usageCsv(store.rows)).toContain('"approval:old-request","历史自动审批（未关联会话）","approval"')
    expect(sumUsage(store.rows).tokens.input).toBe(1000)
  })
  it('weights cache hit rate by input tokens and excludes output and cache writes', () => {
    let store = recordUsage(undefined, event(), now)
    store = recordUsage(store, event({ tokens: { input: 9000, output: 5000, read: 900, write: 1000, reasoning: null } }), now)
    expect(cacheHitRate(sumUsage(store.rows))).toBe(0.17)
    expect(formatCacheHitRate(sumUsage(store.rows))).toBe('17.0%')
  })

  it('only reports a rate for complete, nonempty, consistent input/read totals', () => {
    expect(formatCacheHitRate(sumUsage([]))).toBe('—')
    for (const tokens of [
      { input: 1000, read: null }, { input: null, read: 100 },
      { input: 0, read: 0 }, { input: 10, read: 11 },
    ]) {
      const store = recordUsage(undefined, event({ tokens: { ...event().tokens, ...tokens } }), now)
      expect(formatCacheHitRate(sumUsage(store.rows))).toBe('—')
    }
    let store = recordUsage(undefined, event({ tokens: { ...event().tokens, read: 0 } }), now)
    expect(formatCacheHitRate(sumUsage(store.rows))).toBe('0.0%')
    store = recordUsage(store, event({ tokens: { ...event().tokens, read: null } }), now)
    expect(formatCacheHitRate(sumUsage(store.rows))).toBe('—')
  })

  it('sums each model call without adding cache reads or reasoning twice', () => {
    const first = event()
    let store = recordUsage(undefined, first, now)
    store = recordUsage(store, first, now)
    store = recordUsage(store, event(), now)
    expect(store.rows).toHaveLength(1)
    expect(sumUsage(store.rows)).toEqual({ calls: 2,
      tokens: { input: 2000, output: 200, read: 1600, write: 0, reasoning: 60 },
      missing: { input: 0, output: 0, read: 0, write: 2, reasoning: 0 },
    })
    expect(formatUsageValue(sumUsage(store.rows), 'write')).toBe('—')
  })

  it('separates sessions, days, provider profiles, and models', () => {
    let store = recordUsage(undefined, event(), now)
    for (const patch of [{ session: 'session-b' }, { provider: 'p2' }, { model: 'model-b' }, { at: new Date(2026, 9, 21, 23, 59).getTime() }]) {
      store = recordUsage(store, event(patch), now)
    }
    expect(store.rows).toHaveLength(5)
    expect(sumUsage(store.rows).calls).toBe(5)
    expect(usageDays(2, now)).toEqual(['2026-10-21', '2026-10-22'])
    expect(localUsageDay(new Date(2026, 9, 22, 0, 0))).toBe('2026-10-22')
  })

  it('distinguishes missing, partial, and explicitly zero cache usage', () => {
    let store = recordUsage(undefined, event(), now)
    store = recordUsage(store, event({ tokens: { input: 1000, output: 0, read: 0, write: 0, reasoning: null } }), now)
    expect(formatUsageValue(sumUsage(store.rows), 'write')).toBe('≥ 0')
    expect(formatUsageValue(sumUsage(store.rows), 'reasoning')).toBe('≥ 30')
    expect(formatUsageValue(sumUsage(store.rows), 'read')).toBe('800')
  })

  it('prunes by calendar day and evicts the oldest rows to enforce the byte budget', () => {
    let store: UsageStore | undefined
    for (let i = 0; i < 100; i++) {
      const date = new Date(now); date.setDate(date.getDate() - i)
      store = recordUsage(store, event({ at: date.getTime(), name: '中文服务商'.repeat(15) }), now)
    }
    expect(store!.rows).toHaveLength(90)
    expect(store!.rows[0].day).toBe(usageDays(90, now)[0])
    const limited = pruneUsage(store!, now, 12000)
    expect(new TextEncoder().encode(JSON.stringify(limited)).length).toBeLessThanOrEqual(12000)
    expect(limited.rows.length).toBeLessThan(90)
    expect(limited.rows.at(-1)?.day).toBe('2026-10-22')
  })

  it('exports exact counts, empty missing fields, and formula-safe quoted names', () => {
    const store = recordUsage(undefined, event({ name: '=1+1,"商家"\n' }), now)
    const csv = usageCsv(store.rows, { 'session-a': '@SUM(A1)' })
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"\'=1+1,""商家""\n"')
    expect(csv).toContain('"\'@SUM(A1)"')
    expect(csv).toContain('"1000","100","800","","30"')
    expect(csv).toContain('"write_missing_requests"')
  })

  it('rejects malformed or unbounded events', () => {
    expect(isUsageEvent(event())).toBe(true)
    expect(isUsageEvent(event({ model: 'x'.repeat(201) }))).toBe(false)
    expect(isUsageEvent(event({ tokens: { input: -1, output: 0, read: null, write: null, reasoning: null } }))).toBe(false)
    expect(isUsageEvent({ ...event(), tokens: {} })).toBe(false)
    expect(isUsageEvent({ ...event(), source: 'unknown' })).toBe(false)
    expect(isUsageEvent(event({ source: 'approval' }))).toBe(true)
  })
})

describe('durable usage writes', () => {
  let data: Record<string, unknown>
  beforeEach(() => {
    data = {}
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => structuredClone(data))
    vi.mocked(chrome.storage.local.set).mockImplementation(async values => { Object.assign(data, structuredClone(values)) })
  })
  it('serializes concurrent calls and deduplicates replayed events', async () => {
    const e = event({ at: Date.now() })
    await Promise.all([persistUsage(e), persistUsage(e), persistUsage({ ...e, id: 'second-call' })])
    expect(sumUsage((data[USAGE_STORAGE_KEY] as UsageStore).rows).calls).toBe(2)
  })
  it('stops recording while disabled, preserves history, and resumes when enabled', async () => {
    await persistUsage(event({ at: Date.now() }))
    const history = structuredClone(data[USAGE_STORAGE_KEY])
    data[USAGE_ENABLED_KEY] = false
    await persistUsage(event({ at: Date.now() }))
    expect(data[USAGE_STORAGE_KEY]).toEqual(history)
    data[USAGE_ENABLED_KEY] = true
    await persistUsage(event({ at: Date.now() }))
    expect(sumUsage((data[USAGE_STORAGE_KEY] as UsageStore).rows).calls).toBe(2)
  })
})
