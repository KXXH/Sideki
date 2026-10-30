import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  snapshotTurnTabs,
  restoreTurnTabs,
  resolveOperatingTab,
  releaseTurn,
  touchTurn,
  ownerOf,
  operatingTabOf,
  noteNavigationTarget,
  noteExplicitOperatingTab,
  noteTabRemoved,
  gateExplicitTab,
  lockedTabsSnapshot,
  registerTabLockListeners,
  setPageLockIndicatorPreference,
  updateTurnActivity,
  __resetTabLocks,
} from '../../src/background/tab-locks'

const A = 'session-a'
const B = 'session-b'

describe('tab-locks: turn-scoped tab stack', () => {
  beforeEach(() => {
    __resetTabLocks()
    vi.mocked(chrome.tabs.get).mockImplementation(
      async (id: number) => ({ id, windowId: 100, title: `Tab ${id}` }) as chrome.tabs.Tab,
    )
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, windowId: 100 } as chrome.tabs.Tab])
  })

  it('seeds the stack from a pinned anchor verbatim', async () => {
    const r = await resolveOperatingTab(A, 42, true)
    expect(r.tabId).toBe(42)
    expect(ownerOf(42)).toBe(A)
  })

  it('routes descriptions only to the owning stack, carries them through navigation and clears on release', async () => {
    const activity = [{ id: 'call', description: '读取页面标题', phase: 'executing' }]
    const injections = () => vi.mocked(chrome.scripting.executeScript).mock.calls
      .map(c => c[0] as { target?: { tabId?: number }; args?: unknown[]; func?: { name: string } })
      .filter(c => c.func?.name === 'installLockIndicator')
    vi.mocked(chrome.scripting.executeScript).mockClear()
    updateTurnActivity(B, activity)
    expect(injections()).toHaveLength(0)
    await resolveOperatingTab(A, 42, true)
    updateTurnActivity(A, activity)
    expect(injections().at(-1)?.target?.tabId).toBe(42)
    expect(injections().at(-1)?.args?.[4]).toEqual(activity)
    noteNavigationTarget(42, 43)
    expect(injections().at(-1)?.target?.tabId).toBe(43)
    expect(injections().at(-1)?.args?.[4]).toEqual(activity)
    releaseTurn(A)
    const count = injections().length
    updateTurnActivity(A, activity)
    expect(injections()).toHaveLength(count)
    await resolveOperatingTab(B, 43, true)
    expect(injections().at(-1)?.args?.[4]).toBeUndefined()
  })

  it('resolves an unpinned anchor to the active tab of its window', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 7, windowId: 100 } as chrome.tabs.Tab])
    const r = await resolveOperatingTab(A, 42, false)
    expect(r.tabId).toBe(7)
  })

  it('keeps returning the stack top, ignoring a changed anchor mid-turn', async () => {
    await resolveOperatingTab(A, 42, true)
    // Reason: user switched tabs / another task activated something — the
    // turn must stay on its own tab.
    const r = await resolveOperatingTab(A, 999, true)
    expect(r.tabId).toBe(42)
  })

  it('follows a navigation target opened by the stack top', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 55)
    const r = await resolveOperatingTab(A, 42, true)
    expect(r.tabId).toBe(55)
    expect(ownerOf(55)).toBe(A)
    expect(ownerOf(42)).toBe(A)
  })

  it('ignores navigation targets whose source is not a stack top', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(777, 88)
    expect(ownerOf(88)).toBeNull()
    const r = await resolveOperatingTab(A, 42, true)
    expect(r.tabId).toBe(42)
  })

  it('pops back to the previous tab when the top closes', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 55)
    noteTabRemoved(55)
    const r = await resolveOperatingTab(A, 42, true)
    expect(r.tabId).toBe(42)
    expect(ownerOf(55)).toBeNull()
  })

  it('drops the stack when its last tab closes, re-seeding on the next call', async () => {
    await resolveOperatingTab(A, 42, true)
    noteTabRemoved(42)
    expect(ownerOf(42)).toBeNull()
    const r = await resolveOperatingTab(A, 61, true)
    expect(r.tabId).toBe(61)
  })

  it('does not lock a turn that never touches a tab', () => {
    expect(lockedTabsSnapshot()).toEqual([])
  })
})

describe('tab-locks: session×session arbitration', () => {
  beforeEach(() => {
    __resetTabLocks()
    vi.mocked(chrome.tabs.get).mockImplementation(
      async (id: number) => ({ id, windowId: 100, title: `Tab ${id}` }) as chrome.tabs.Tab,
    )
  })

  it('blocks a second session seeding onto a held tab', async () => {
    await resolveOperatingTab(A, 42, true)
    const r = await resolveOperatingTab(B, 42, true)
    expect(r.tabId).toBeNull()
    expect(r.blocked).toBe(true)
    expect(r.message).toContain('another background task')
    // Reason: the model has no tab addressing here — it must be told to stop,
    // not to retry or switch.
    expect(r.message).toContain('Retrying will keep failing')
    expect(ownerOf(42)).toBe(A)
  })

  it('lets the holder re-enter its own tab', async () => {
    await resolveOperatingTab(A, 42, true)
    const again = await resolveOperatingTab(A, 42, true)
    expect(again.blocked).toBeUndefined()
    expect(again.tabId).toBe(42)
  })

  it('frees the tab for another session after release', async () => {
    await resolveOperatingTab(A, 42, true)
    releaseTurn(A)
    const r = await resolveOperatingTab(B, 42, true)
    expect(r.tabId).toBe(42)
    expect(ownerOf(42)).toBe(B)
  })

  it('blocks explicit references to a foreign-held tab and names it', async () => {
    await resolveOperatingTab(A, 42, true)
    const err = await gateExplicitTab(B, 42)
    expect(err).toContain('tab #42')
    expect(err).toContain('Tab 42')
    // Reason: explicit targets CAN be routed around — both branches offered.
    expect(err).toContain('target a different tab or skip this step')
    expect(err).toContain('stop and ask the user')
  })

  it('allows explicit references to own and to free tabs', async () => {
    await resolveOperatingTab(A, 42, true)
    expect(await gateExplicitTab(A, 42)).toBeNull()
    expect(await gateExplicitTab(B, 99)).toBeNull()
  })

  it('expires a stale lock so a dead host cannot deadlock other sessions', async () => {
    await resolveOperatingTab(A, 42, true)
    const later = Date.now() + 130_000
    expect(ownerOf(42, later)).toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      const r = await resolveOperatingTab(B, 42, true)
      expect(r.blocked).toBeUndefined()
      expect(r.tabId).toBe(42)
    } finally {
      vi.mocked(Date.now).mockRestore()
    }
  })

  // Reason: liveness is "turn alive", not "turn touched a tab" — a long
  // reasoning / MCP-only stretch must keep both the lock and the stack.
  it('keeps a lock alive past the TTL while the turn heartbeats', async () => {
    const t0 = Date.now()
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 55)
    const spy = vi.spyOn(Date, 'now')
    try {
      spy.mockReturnValue(t0 + 100_000)
      touchTurn(A)
      // Reason: 200s after seed but only 100s after the heartbeat.
      expect(ownerOf(55, t0 + 200_000)).toBe(A)
      spy.mockReturnValue(t0 + 200_000)
      const r = await resolveOperatingTab(A, 42, true)
      expect(r.tabId).toBe(55)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not revive a stack that already expired', async () => {
    const t0 = Date.now()
    await resolveOperatingTab(A, 42, true)
    const spy = vi.spyOn(Date, 'now')
    try {
      spy.mockReturnValue(t0 + 130_000)
      touchTurn(A)
      expect(ownerOf(42, t0 + 131_000)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('ignores a heartbeat for a session holding no tab', () => {
    touchTurn('never-ran')
    expect(lockedTabsSnapshot()).toEqual([])
  })
})

// Reason: `chrome tabs --switch/--new` must move the turn's operating tab —
// otherwise the command changes only the user's view while every later tool
// keeps acting on the page the agent just left.
describe('tab-locks: explicit tab targeting moves the stack top', () => {
  beforeEach(() => {
    __resetTabLocks()
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    vi.mocked(chrome.scripting.executeScript).mockClear()
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true } }])
    vi.mocked(chrome.tabs.get).mockImplementation(
      async (id: number) => ({ id, windowId: 100, title: `Tab ${id}` }) as chrome.tabs.Tab,
    )
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, windowId: 100 } as chrome.tabs.Tab])
  })

  function changed() {
    return vi.mocked(chrome.runtime.sendMessage).mock.calls
      .filter(c => (c[0] as { type?: string })?.type === 'tab-lock:changed')
      .map(c => c[0] as { sessionId: string; tabId: number | null })
  }

  it('adopts a tab for a session that holds no stack yet', () => {
    noteExplicitOperatingTab(A, 42)
    expect(operatingTabOf(A)).toBe(42)
    expect(ownerOf(42)).toBe(A)
    expect(changed()).toEqual([{ type: 'tab-lock:changed', sessionId: A, tabId: 42 }])
  })

  it('moves the top to a tab outside the stack, keeping the one it left owned', async () => {
    await resolveOperatingTab(A, 42, true)
    noteExplicitOperatingTab(A, 55)
    expect(operatingTabOf(A)).toBe(55)
    // Reason: a pop-back target must stay locked, or another session could claim
    // the tab this turn may still return to.
    expect(ownerOf(42)).toBe(A)
    expect(changed().map(c => c.tabId)).toEqual([42, 55])
  })

  it('moves a lower stack entry up instead of duplicating it', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 55)
    noteExplicitOperatingTab(A, 42)
    expect(operatingTabOf(A)).toBe(42)

    // Reason: a duplicate would leave a dead id at the top here.
    noteTabRemoved(42)
    expect(operatingTabOf(A)).toBe(55)
    expect(ownerOf(42)).toBeNull()
  })

  it('stays silent when the target is already the top', async () => {
    await resolveOperatingTab(A, 42, true)
    vi.mocked(chrome.runtime.sendMessage).mockClear()

    noteExplicitOperatingTab(A, 42)
    expect(changed()).toEqual([])
  })

  it('refreshes liveness when re-targeting the current top', async () => {
    const t0 = Date.now()
    const spy = vi.spyOn(Date, 'now')
    try {
      spy.mockReturnValue(t0)
      await resolveOperatingTab(A, 42, true)
      spy.mockReturnValue(t0 + 100_000)
      noteExplicitOperatingTab(A, 42)
      expect(operatingTabOf(A, t0 + 130_000)).toBe(42)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not revive an expired stack — the target starts a fresh one', async () => {
    const t0 = Date.now()
    const spy = vi.spyOn(Date, 'now')
    try {
      spy.mockReturnValue(t0)
      await resolveOperatingTab(A, 42, true)
      spy.mockReturnValue(t0 + 130_000)
      noteExplicitOperatingTab(A, 55)
      expect(operatingTabOf(A, t0 + 130_001)).toBe(55)
      expect(ownerOf(42, t0 + 130_001)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

// Reason: the staleness backstop is the ONLY release a dead host gets. If it
// frees the lock without the rest of the release cleanup, the injected island
// and the pointer outlive the turn with no stack entry left to reference them.
describe('tab-locks: staleness eviction cleans up like a release', () => {
  const STALE_MS = 120_000

  function indicatorArgs() {
    return vi.mocked(chrome.scripting.executeScript).mock.calls
      .map(c => (c[0] as { args?: unknown[] }).args?.[0])
  }

  beforeEach(() => {
    __resetTabLocks()
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    vi.mocked(chrome.scripting.executeScript).mockClear()
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true } }])
    vi.mocked(chrome.tabs.get).mockImplementation(
      async (id: number) => ({ id, windowId: 100, title: `Tab ${id}` }) as chrome.tabs.Tab,
    )
  })

  it('hides the indicator of the evicted stack top', async () => {
    await resolveOperatingTab(A, 42, true)
    vi.mocked(chrome.scripting.executeScript).mockClear()

    expect(operatingTabOf(A, Date.now() + STALE_MS + 1)).toBeNull()
    expect(indicatorArgs()).toContain(false)
    expect(vi.mocked(chrome.scripting.executeScript).mock.calls[0][0])
      .toMatchObject({ target: { tabId: 42 } })
  })

  it('broadcasts the cleared top so the panel strip follows', async () => {
    await resolveOperatingTab(A, 42, true)
    vi.mocked(chrome.runtime.sendMessage).mockClear()

    operatingTabOf(A, Date.now() + STALE_MS + 1)
    const changed = vi.mocked(chrome.runtime.sendMessage).mock.calls
      .map(c => c[0] as { type?: string; tabId?: number | null })
      .filter(m => m.type === 'tab-lock:changed')
    expect(changed).toEqual([{ type: 'tab-lock:changed', sessionId: A, tabId: null }])
  })

  it('clears the notified-top memo so a later turn on the same tab shows again', async () => {
    await resolveOperatingTab(A, 42, true)
    operatingTabOf(A, Date.now() + STALE_MS + 1)
    vi.mocked(chrome.scripting.executeScript).mockClear()

    // Reason: a stale memo would make notifyTop early-return on prev === top
    // and the new turn would never light the indicator.
    await resolveOperatingTab(A, 42, true)
    expect(indicatorArgs()).toContain(true)
  })

  it('leaves a fresh stack alone', async () => {
    await resolveOperatingTab(A, 42, true)
    vi.mocked(chrome.scripting.executeScript).mockClear()

    expect(operatingTabOf(A, Date.now() + STALE_MS - 1)).toBe(42)
    expect(indicatorArgs()).not.toContain(false)
  })
})

// Reason: the page strip must name the page the context points at — it needs
// both a push broadcast and a pull for a panel that opened mid-turn.
describe('tab-locks: operating tab exposure', () => {
  beforeEach(() => {
    __resetTabLocks()
    vi.mocked(chrome.runtime.sendMessage).mockClear()
    vi.mocked(chrome.tabs.get).mockImplementation(
      async (id: number) => ({ id, windowId: 100, title: `Tab ${id}` }) as chrome.tabs.Tab,
    )
  })

  it('reports the operating tab, and null once released', async () => {
    expect(operatingTabOf(A)).toBeNull()
    await resolveOperatingTab(A, 42, true)
    expect(operatingTabOf(A)).toBe(42)
    noteNavigationTarget(42, 55)
    expect(operatingTabOf(A)).toBe(55)
    releaseTurn(A)
    expect(operatingTabOf(A)).toBeNull()
  })

  it('broadcasts on seed, push and release — but not on repeated resolution', async () => {
    const changed = () => vi.mocked(chrome.runtime.sendMessage).mock.calls
      .filter(c => (c[0] as { type?: string })?.type === 'tab-lock:changed')
      .map(c => c[0] as { sessionId: string; tabId: number | null })

    await resolveOperatingTab(A, 42, true)
    expect(changed()).toEqual([{ type: 'tab-lock:changed', sessionId: A, tabId: 42 }])

    // Reason: per-tool-call resolution must stay silent — no top change.
    await resolveOperatingTab(A, 42, true)
    await resolveOperatingTab(A, 42, true)
    expect(changed()).toHaveLength(1)

    noteNavigationTarget(42, 55)
    releaseTurn(A)
    expect(changed().map(c => c.tabId)).toEqual([42, 55, null])
  })
})

describe('tab-locks: page lock indicator projection', () => {
  beforeEach(() => {
    __resetTabLocks()
    setPageLockIndicatorPreference(true)
    vi.mocked(chrome.scripting.executeScript).mockClear()
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true } }])
    vi.mocked(chrome.tabs.get).mockImplementation(
      async (id: number) => ({ id, windowId: 100, title: `Tab ${id}` }) as chrome.tabs.Tab,
    )
  })

  function indicatorArgs() {
    return vi.mocked(chrome.scripting.executeScript).mock.calls
      .map(c => c[0] as { target?: { tabId?: number }; args?: unknown[] })
      // Reason: the same hooks also tear down the AI pointer overlay. Only the
      // lock indicator takes a boolean visibility flag.
      .filter(c => typeof c.args?.[0] === 'boolean')
      .map(c => ({ tabId: c.target?.tabId, visible: c.args?.[0] }))
  }

  it('shows on seed and hides on release', async () => {
    await resolveOperatingTab(A, 42, true)
    releaseTurn(A)
    expect(indicatorArgs()).toEqual([
      { tabId: 42, visible: true },
      { tabId: 42, visible: false },
    ])
  })

  it('moves from the old top to the new top on push', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 55)
    expect(indicatorArgs()).toEqual([
      { tabId: 42, visible: true },
      { tabId: 42, visible: false },
      { tabId: 55, visible: true },
    ])
  })

  it('moves from the old top to the explicitly targeted tab', async () => {
    await resolveOperatingTab(A, 42, true)
    noteExplicitOperatingTab(A, 55)
    expect(indicatorArgs()).toEqual([
      { tabId: 42, visible: true },
      { tabId: 42, visible: false },
      { tabId: 55, visible: true },
    ])
  })

  it('hides current stack tops when the appearance preference is disabled', async () => {
    await resolveOperatingTab(A, 42, true)
    vi.mocked(chrome.scripting.executeScript).mockClear()

    setPageLockIndicatorPreference(false)
    expect(indicatorArgs()).toEqual([{ tabId: 42, visible: false }])

    vi.mocked(chrome.scripting.executeScript).mockClear()
    setPageLockIndicatorPreference(true)
    expect(indicatorArgs()).toEqual([{ tabId: 42, visible: true }])
  })

  it('restores the island after same-tab navigation rebuilds the page', async () => {
    await resolveOperatingTab(A, 42, true)
    vi.mocked(chrome.scripting.executeScript).mockClear()
    registerTabLockListeners()
    const updated = vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls.at(-1)?.[0] as ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void)
    updated(42, { status: 'complete' })
    expect(indicatorArgs()).toEqual([{ tabId: 42, visible: true }])
  })

  // Reason: the injected island only holds a bounded lease (see
  // page-lock-indicator). The turn-alive heartbeat is what renews it — riding
  // this channel keeps the renewal timer out of the service worker.
  it('renews the lease on the current stack top for every heartbeat', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 55)
    vi.mocked(chrome.scripting.executeScript).mockClear()

    touchTurn(A)
    expect(indicatorArgs()).toEqual([{ tabId: 55, visible: true }])
  })

  it('renews nothing for a session holding no tab, nor after release', async () => {
    touchTurn('never-ran')
    expect(indicatorArgs()).toEqual([])

    await resolveOperatingTab(A, 42, true)
    releaseTurn(A)
    vi.mocked(chrome.scripting.executeScript).mockClear()
    touchTurn(A)
    expect(indicatorArgs()).toEqual([])
  })
})


describe('scheduled tab stack restoration', () => {
  beforeEach(() => {
    __resetTabLocks()
    vi.mocked(chrome.tabs.get).mockImplementation(async id => ({ id }) as chrome.tabs.Tab)
  })
  it('keeps navigation history without owning tabs while waiting', async () => {
    await resolveOperatingTab(A, 42, true)
    noteNavigationTarget(42, 43)
    const snapshot = snapshotTurnTabs(A)
    expect(snapshot).toEqual([42, 43])
    releaseTurn(A)
    expect(ownerOf(42)).toBeNull()
    expect(ownerOf(43)).toBeNull()
    await restoreTurnTabs(A, snapshot)
    expect(operatingTabOf(A)).toBe(43)
    noteTabRemoved(43)
    expect(operatingTabOf(A)).toBe(42)
  })
  it('does not take any tabs if another session owns a parent', async () => {
    await resolveOperatingTab(B, 42, true)
    await expect(restoreTurnTabs(A, [42, 43])).rejects.toThrow('其他会话')
    expect(ownerOf(43)).toBeNull()
    expect(ownerOf(42)).toBe(B)
  })
  it('refuses a missing top instead of falling back to another page', async () => {
    vi.mocked(chrome.tabs.get).mockImplementation(async id => {
      if (id === 43) throw new Error('closed')
      return { id } as chrome.tabs.Tab
    })
    await expect(restoreTurnTabs(A, [42, 43])).rejects.toThrow('已关闭')
    expect(operatingTabOf(A)).toBeNull()
  })
})
