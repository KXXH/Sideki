// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLockIndicator } from '../../src/background/page-lock-indicator'
import type { ToolActivity } from '../../src/shared/tool-description'

let seq = 0
const call = (id: string, description = id): ToolActivity => ({ id, description, phase: 'executing' })
const host = () => document.getElementById('__sidekick_lock_indicator__')!
const text = () => host().shadowRoot!.querySelector('.label')!.textContent
const update = (calls?: ToolActivity[]) => installLockIndicator(true, ++seq, 90_000, 820, calls)

beforeEach(() => {
  vi.useFakeTimers()
  seq = 0
  delete (globalThis as Record<string, unknown>).__sidekickLockSeq
})
afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.querySelector('#__sidekick_lock_indicator__')?.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).__sidekickLockSeq
})

describe('island activity pacing', () => {
  it('skips short calls and keeps the same island mounted', () => {
    update([call('a')])
    const island = host()
    vi.advanceTimersByTime(599)
    expect(text()).toBe('Agent 正在此页工作')
    update([])
    vi.advanceTimersByTime(3_000)
    expect(text()).toBe('Agent 正在此页工作')
    expect(host()).toBe(island)
  })

  it('shows a sustained call after 600ms and replaces only with the latest live candidate after 2s', () => {
    update([call('a')])
    vi.advanceTimersByTime(600)
    expect(text()).toBe('a')
    update([call('b')])
    vi.advanceTimersByTime(700)
    update([call('c')])
    vi.advanceTimersByTime(1_299)
    expect(text()).toBe('a')
    vi.advanceTimersByTime(1)
    expect(text()).toBe('c')
    expect(host().shadowRoot!.querySelector('.label')!.getAttribute('title')).toBe('c')
  })

  it('never replays a finished candidate and restores the generic status after the hold', () => {
    update([call('a')])
    vi.advanceTimersByTime(600)
    update([call('b')])
    vi.advanceTimersByTime(700)
    update([])
    vi.advanceTimersByTime(1_300)
    expect(text()).toBe('Agent 正在此页工作')
    vi.advanceTimersByTime(4_000)
    expect(text()).toBe('Agent 正在此页工作')
  })

  it('preserves elapsed time across heartbeats and distinguishes preparation from execution', () => {
    update([{ ...call('a', '提取价格'), phase: 'preparing' }])
    vi.advanceTimersByTime(300)
    update()
    vi.advanceTimersByTime(300)
    expect(text()).toBe('准备：提取价格')
    update([call('a', '提取价格')])
    vi.advanceTimersByTime(2_000)
    expect(text()).toBe('提取价格')
  })

  it('hides immediately at turn end and cancels delayed updates', () => {
    update([call('a')])
    vi.advanceTimersByTime(200)
    installLockIndicator(false, ++seq, 90_000, 820)
    expect(host().dataset.visible).toBe('leaving')
    vi.advanceTimersByTime(600)
    expect(text()).toBe('Agent 正在此页工作')
    vi.advanceTimersByTime(220)
    expect(document.getElementById('__sidekick_lock_indicator__')).toBeNull()
  })

  it('renders model text as plain text and ignores stale injections', () => {
    update([call('a', '<img src=x onerror=alert(1)>')])
    vi.advanceTimersByTime(600)
    expect(text()).toBe('<img src=x onerror=alert(1)>')
    expect(host().shadowRoot!.querySelector('img')).toBeNull()
    installLockIndicator(true, seq - 1, 90_000, 820, [call('stale')])
    vi.advanceTimersByTime(3_000)
    expect(text()).toBe('<img src=x onerror=alert(1)>')
  })
})
