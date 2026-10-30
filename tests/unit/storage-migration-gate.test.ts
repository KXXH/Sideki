// @vitest-environment jsdom

import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import StorageMigrationGate from '../../src/sidepanel/components/StorageMigrationGate'
import { loadSessionIndex, SESSION_MIGRATION_KEY, type SessionMigrationStatus } from '../../src/shared/storage'

vi.mock('../../src/shared/storage', () => ({
  loadSessionIndex: vi.fn(),
  SESSION_MIGRATION_KEY: 'sidekick_session_migration_status',
}))

type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
let listeners: Set<ChangeListener>
let stored: SessionMigrationStatus | null
let root: Root
let container: HTMLDivElement
let mounted: boolean
const childMounted = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function Child() {
  useEffect(() => { childMounted() }, [])
  return React.createElement('div', { 'data-testid': 'app' }, 'Chat application')
}

async function render() {
  await act(async () => {
    root.render(React.createElement(StorageMigrationGate, { children: React.createElement(Child) }))
  })
}

function emit(next: SessionMigrationStatus | null, area = 'local') {
  if (area === 'local') stored = next
  for (const listener of listeners) {
    listener({ [SESSION_MIGRATION_KEY]: { newValue: next ?? undefined } }, area)
  }
}

async function clickButton() {
  const button = container.querySelector('button')!
  expect(button).not.toBeNull()
  expect(button.disabled).toBe(false)
  await act(async () => { button.click() })
}

beforeAll(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterAll(() => { vi.unstubAllGlobals() })

beforeEach(() => {
  vi.clearAllMocks()
  stored = null
  listeners = new Set()
  vi.mocked(chrome.storage.onChanged.addListener).mockImplementation(listener => { listeners.add(listener as ChangeListener) })
  vi.mocked(chrome.storage.onChanged.removeListener).mockImplementation(listener => { listeners.delete(listener as ChangeListener) })
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => stored ? { [SESSION_MIGRATION_KEY]: structuredClone(stored) } : {})
  vi.mocked(chrome.storage.local.remove).mockImplementation(async () => { emit(null) })
  vi.mocked(loadSessionIndex).mockResolvedValue([])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mounted = true
})

afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('storage migration landing', () => {
  it('does not mount the app until storage initialization completes', async () => {
    const waiting = deferred<[]>()
    vi.mocked(loadSessionIndex).mockReturnValueOnce(waiting.promise)
    await render()
    expect(childMounted).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    await act(async () => waiting.resolve([]))
    expect(childMounted).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('Chat application')
  })

  it('does not show an optimization result for a new or already acknowledged store', async () => {
    await render()
    expect(container.textContent).toBe('Chat application')
    expect(chrome.storage.local.remove).not.toHaveBeenCalled()
  })

  it('shows durable progress and holds completion until the user continues', async () => {
    stored = { status: 'running', completed: 1, total: 3 }
    const waiting = deferred<[]>()
    vi.mocked(loadSessionIndex).mockReturnValueOnce(waiting.promise)
    await render()
    expect(container.textContent).toContain('正在优化存储')
    expect(container.textContent).toContain('1 / 3')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1')
    await act(async () => emit({ status: 'running', completed: 3, total: 3 }))
    expect(container.textContent).toContain('正在完成存储切换')
    expect(container.textContent).not.toContain('存储优化完成')
    await act(async () => { emit({ status: 'complete', completed: 3, total: 3 }); waiting.resolve([]) })
    expect(container.textContent).toContain('存储优化完成')
    expect(container.querySelector('button')?.textContent).toBe('开始使用')
    expect(childMounted).not.toHaveBeenCalled()
    await clickButton()
    expect(chrome.storage.local.remove).toHaveBeenCalledExactlyOnceWith(SESSION_MIGRATION_KEY)
    expect(container.textContent).toBe('Chat application')
  })

  it('shows completion even when migration finished before the panel opened', async () => {
    stored = { status: 'complete', completed: 12, total: 12 }
    await render()
    expect(container.textContent).toContain('存储优化完成')
    expect(container.textContent).toContain('已优化会话12')
    expect(childMounted).not.toHaveBeenCalled()
  })

  it('shows a failed migration and retries through the real storage entry point', async () => {
    stored = { status: 'error', completed: 2, total: 4, error: 'Synthetic quota failure' }
    vi.mocked(loadSessionIndex).mockRejectedValueOnce(new Error('Synthetic quota failure'))
    await render()
    expect(container.textContent).toContain('存储优化未完成')
    expect(container.textContent).toContain('2 / 4')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Synthetic quota failure')
    const retry = deferred<[]>()
    vi.mocked(loadSessionIndex).mockImplementationOnce(() => {
      emit({ status: 'running', completed: 0, total: 4 })
      return retry.promise
    })
    await clickButton()
    expect(loadSessionIndex).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('正在优化存储')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { emit({ status: 'complete', completed: 4, total: 4 }); retry.resolve([]) })
    expect(container.textContent).toContain('存储优化完成')
    expect(childMounted).not.toHaveBeenCalled()
  })

  it('shows an initial storage read error without inventing a migration count', async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error('Storage unavailable'))
    await render()
    expect(container.textContent).toContain('Storage unavailable')
    expect(container.textContent).not.toContain('0 / 0')
    expect(container.querySelector('button')?.textContent).toContain('重新尝试')
    await clickButton()
    expect(container.textContent).toBe('Chat application')
  })

  it('does not let a stale snapshot overwrite a newer progress event', async () => {
    const snapshot = deferred<Record<string, unknown>>()
    vi.mocked(chrome.storage.local.get).mockReturnValueOnce(snapshot.promise)
    await render()
    await act(async () => emit({ status: 'complete', completed: 5, total: 5 }))
    await act(async () => snapshot.resolve({ [SESSION_MIGRATION_KEY]: { status: 'running', completed: 1, total: 5 } }))
    expect(container.textContent).toContain('存储优化完成')
    expect(container.textContent).not.toContain('1 / 5')
  })

  it('ignores other storage areas', async () => {
    stored = { status: 'complete', completed: 1, total: 1 }
    await render()
    await act(async () => emit({ status: 'running', completed: 0, total: 2 }, 'sync'))
    expect(container.textContent).toContain('存储优化完成')
  })

  it('keeps the result visible if acknowledgement fails and allows another attempt', async () => {
    stored = { status: 'complete', completed: 2, total: 2 }
    await render()
    vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(new Error('Cannot acknowledge'))
    await clickButton()
    expect(container.textContent).toContain('存储优化完成')
    expect(container.textContent).toContain('Cannot acknowledge')
    expect(childMounted).not.toHaveBeenCalled()
    await clickButton()
    expect(container.textContent).toBe('Chat application')
  })

  it('dismisses the result when another panel acknowledges it', async () => {
    stored = { status: 'complete', completed: 2, total: 2 }
    await render()
    await act(async () => emit(null))
    expect(container.textContent).toBe('Chat application')
  })

  it('honors another panel completing and acknowledging a migration after this panel failed', async () => {
    stored = { status: 'error', completed: 1, total: 2, error: 'Retry needed' }
    vi.mocked(loadSessionIndex).mockRejectedValueOnce(new Error('Retry needed'))
    await render()
    await act(async () => emit({ status: 'complete', completed: 2, total: 2 }))
    expect(container.textContent).toContain('存储优化完成')
    await act(async () => emit(null))
    expect(container.textContent).toBe('Chat application')
  })

  it.each(['index', 'status'])('requires initialization retry if %s reading fails despite a stored complete result', async stage => {
    stored = { status: 'complete', completed: 2, total: 2 }
    const error = new Error('Cannot read storage')
    if (stage === 'index') vi.mocked(loadSessionIndex).mockRejectedValueOnce(error)
    else vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({ [SESSION_MIGRATION_KEY]: stored }).mockRejectedValueOnce(error)
    await render()
    expect(container.querySelector('button')?.textContent).toContain('重新尝试')
    expect(childMounted).not.toHaveBeenCalled()
    await clickButton()
    expect(loadSessionIndex).toHaveBeenCalledTimes(2)
    expect(chrome.storage.local.remove).not.toHaveBeenCalled()
    expect(container.textContent).toContain('存储优化完成')
    await clickButton()
    expect(container.textContent).toBe('Chat application')
  })

  it('removes its listener and ignores late reads after unmount', async () => {
    const waiting = deferred<[]>()
    vi.mocked(loadSessionIndex).mockReturnValueOnce(waiting.promise)
    await render()
    await act(async () => root.unmount())
    mounted = false
    expect(listeners.size).toBe(0)
    await act(async () => waiting.resolve([]))
    expect(childMounted).not.toHaveBeenCalled()
    expect(chrome.storage.local.remove).not.toHaveBeenCalled()
  })

  it('renders a zero-session migration as complete without a progress denominator', async () => {
    stored = { status: 'complete', completed: 0, total: 0 }
    await render()
    expect(container.textContent).toContain('已优化会话0')
    expect(container.textContent).not.toContain('0 / 0')
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })
})
