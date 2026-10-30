import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hidePageLockIndicator, installLockIndicator, setPageLockIndicatorEnabled, showPageLockIndicator, syncPageLockIndicator } from '../../src/background/page-lock-indicator'
import { ScriptDeadlineError } from '../../src/background/tool-handlers'

const LEASE_MS = 90_000
const LEAVE_MS = 820

function calls() {
  return vi.mocked(chrome.scripting.executeScript).mock.calls.map(c => c[0] as { target?: { tabId?: number }; args?: unknown[] } & Record<string, unknown>)
}

function argsOf() {
  return calls().map(c => c.args as unknown[])
}

describe('page lock indicator injection', () => {
  beforeEach(() => {
    setPageLockIndicatorEnabled(true)
    vi.mocked(chrome.scripting.executeScript).mockReset()
    // Reason: a real page echoes the sequence it applied — the injector climbs on
    // it, so a mock that omits it would hide the self-healing path.
    vi.mocked(chrome.scripting.executeScript).mockImplementation(
      (async (inj: { args?: unknown[] }) => [{ result: { ok: true, seq: inj.args?.[1] } }]) as never,
    )
  })

  it('injects the island into the target tab', async () => {
    await showPageLockIndicator(42)
    expect(calls()).toHaveLength(1)
    expect(calls()[0].injectImmediately).toBe(true)
    expect(argsOf()[0][0]).toBe(true)
    expect(argsOf()[0].slice(2)).toEqual([LEASE_MS, LEAVE_MS])
  })

  // Reason: the ordering guard's marker lives on the isolated world's global of
  // the top frame. An injection landing in MAIN or in a subframe would carry its
  // own marker, silently reducing the guard to a no-op.
  it('pins the world and the top frame so the guard shares one marker', async () => {
    await showPageLockIndicator(42)
    expect(calls()[0].target).toEqual({ tabId: 42, frameIds: [0] })
    expect(calls()[0].world).toBe('ISOLATED')
  })

  it('injects hide state for exit animation', async () => {
    await hidePageLockIndicator(42)
    expect(argsOf()[0][0]).toBe(false)
  })

  it('syncs old and new tabs without hiding the same tab', () => {
    syncPageLockIndicator(1, 2)
    expect(argsOf().map(a => a[0])).toEqual([false, true])
    expect(calls().map(c => c.target?.tabId)).toEqual([1, 2])

    vi.mocked(chrome.scripting.executeScript).mockClear()
    syncPageLockIndicator(2, 2)
    expect(argsOf().map(a => a[0])).toEqual([true])
  })

  it('does not inject show state while disabled, but still allows hide', async () => {
    setPageLockIndicatorEnabled(false)
    await showPageLockIndicator(42)
    expect(calls()).toHaveLength(0)

    await hidePageLockIndicator(42)
    expect(argsOf()[0][0]).toBe(false)
  })

  it('issues a strictly increasing sequence so the page can order landings', async () => {
    await showPageLockIndicator(42)
    await hidePageLockIndicator(42)
    await showPageLockIndicator(42)
    const seqs = argsOf().map(a => a[1] as number)
    expect(seqs[1]).toBeGreaterThan(seqs[0])
    expect(seqs[2]).toBeGreaterThan(seqs[1])
  })

  // Reason: the counter is not clock-seeded, so after a service-worker restart it
  // starts below what a live document already applied. Without climbing onto the
  // reported marker every later injection would be rejected forever — failing
  // straight into the bug the guard exists to prevent.
  it('climbs onto the sequence the page reports and warns about the drop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ result: { ok: true, seq: 5_000, stale: true } }] as never)
      await showPageLockIndicator(42)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale show'))

      vi.mocked(chrome.scripting.executeScript).mockImplementation(
        (async (inj: { args?: unknown[] }) => [{ result: { ok: true, seq: inj.args?.[1] } }]) as never,
      )
      vi.mocked(chrome.scripting.executeScript).mockClear()
      await showPageLockIndicator(42)
      expect(argsOf()[0][1] as number).toBeGreaterThan(5_000)
    } finally {
      warn.mockRestore()
    }
  })

  it('swallows injection failures because the panel remains authoritative', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('Cannot access chrome:// URL'))
      await expect(showPageLockIndicator(42)).resolves.toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // Reason: a deadline does NOT cancel the injection — that payload can still
  // land later and light a page nothing will hide. It is the one failure class
  // worth reporting.
  it('reports a deadline as a possible late landing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new ScriptDeadlineError('timed out'))
      await showPageLockIndicator(42)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('may still land later'), 'timed out')
    } finally {
      warn.mockRestore()
    }
  })
})

interface FakeHost {
  dataset: Record<string, string>
  remove: ReturnType<typeof vi.fn>
  __sidekickRemoveTimer?: number
}

function fakeHost(visible = 'true'): FakeHost {
  return { dataset: { visible }, remove: vi.fn() }
}

function stubDom(existing: FakeHost | null) {
  const getElementById = vi.fn(() => existing)
  const setTimeout = vi.fn(() => 1)
  const clearTimeout = vi.fn()
  const g = globalThis as Record<string, unknown>
  g.document = { getElementById }
  g.window = { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() }
  return { getElementById, setTimeout, clearTimeout }
}

function marker(): number | undefined {
  return (globalThis as { __sidekickLockSeq?: number }).__sidekickLockSeq
}

// Reason: injections can land out of order — execScript races a deadline but
// never cancels the underlying call. The page is the only place that observes
// actual landing order, so last-writer-wins is enforced there.
describe('page lock indicator ordering guard', () => {
  afterEach(() => {
    const g = globalThis as Record<string, unknown>
    delete g.document
    delete g.window
    delete g.__sidekickLockSeq
  })

  it('applies a newer payload and records the sequence it applied', () => {
    const dom = stubDom(fakeHost())
    expect(installLockIndicator(true, 3, LEASE_MS, LEAVE_MS)).toEqual({ ok: true, seq: 3 })
    expect(marker()).toBe(3)
    expect(dom.getElementById).toHaveBeenCalled()
  })

  it('rejects a stale payload without touching the DOM', () => {
    ;(globalThis as Record<string, unknown>).__sidekickLockSeq = 9
    const dom = stubDom(null)
    expect(installLockIndicator(true, 9, LEASE_MS, LEAVE_MS)).toEqual({ ok: true, seq: 9, stale: true })
    expect(dom.getElementById).not.toHaveBeenCalled()
    expect(marker()).toBe(9)
  })

  // Reason: symmetry matters — the observed failure was a late show outliving a
  // hide, but a late hide extinguishing a live turn is the same defect mirrored.
  it('lets a late hide not clobber a newer show', () => {
    const host = fakeHost()
    const dom = stubDom(host)
    installLockIndicator(true, 5, LEASE_MS, LEAVE_MS)
    dom.getElementById.mockClear()

    expect(installLockIndicator(false, 4, LEASE_MS, LEAVE_MS).stale).toBe(true)
    expect(host.dataset.visible).toBe('true')
    expect(dom.getElementById).not.toHaveBeenCalled()
  })

  it('grants a show only a bounded lease, re-armed by the next show', () => {
    const host = fakeHost()
    const dom = stubDom(host)
    installLockIndicator(true, 1, LEASE_MS, LEAVE_MS)
    expect(dom.setTimeout.mock.calls.map(c => (c as unknown[])[1])).toEqual([LEASE_MS])

    installLockIndicator(true, 2, LEASE_MS, LEAVE_MS)
    expect(dom.clearTimeout).toHaveBeenCalledWith(1)
    expect(dom.setTimeout.mock.calls.map(c => (c as unknown[])[1])).toEqual([LEASE_MS, LEASE_MS])
  })

  it('removes the island itself when the lease expires', () => {
    const host = fakeHost()
    const dom = stubDom(host)
    installLockIndicator(true, 1, LEASE_MS, LEAVE_MS)

    const expire = dom.setTimeout.mock.calls[0][0] as unknown as () => void
    expire()
    expect(host.dataset.visible).toBe('leaving')
    const leave = dom.setTimeout.mock.calls[1] as unknown as [() => void, number]
    expect(leave[1]).toBe(LEAVE_MS)
    leave[0]()
    expect(host.remove).toHaveBeenCalled()
  })

  it('shortens the lease to the exit animation on an explicit hide', () => {
    const host = fakeHost()
    const dom = stubDom(host)
    installLockIndicator(false, 1, LEASE_MS, LEAVE_MS)
    expect(host.dataset.visible).toBe('leaving')
    expect(dom.setTimeout.mock.calls.map(c => (c as unknown[])[1])).toEqual([LEAVE_MS])
  })
})
