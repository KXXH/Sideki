import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import {
  snapshotFrom,
  diffPatch,
  applySnapshot,
  applyPatch,
  type KernelSnapshotSource,
  type PanelMirror,
} from '../../src/shared/kernel/sync-protocol'

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage
}

function source(over: Partial<KernelSnapshotSource> = {}): KernelSnapshotSource {
  return {
    rev: 1,
    sessionId: 's1',
    messages: [msg('1', 'user', 'hi')],
    status: 'ready',
    errorMessage: undefined,
    queue: [],
    compacting: false,
    preparing: false,
    dispatching: false,
    ...over,
  }
}

describe('snapshotFrom / applySnapshot', () => {
  it('round-trips the full kernel state', () => {
    const src = source({
      rev: 7,
      status: 'streaming',
      errorMessage: 'boom',
      queue: [{ id: 'q1', text: 'later' }],
      compacting: true,
      preparing: true,
      dispatching: true,
    })
    const mirror = applySnapshot(snapshotFrom(src))
    expect(mirror.rev).toBe(7)
    expect(mirror.sessionId).toBe('s1')
    expect(mirror.messages.map(m => m.id)).toEqual(['1'])
    expect(mirror.status).toBe('streaming')
    expect(mirror.errorMessage).toBe('boom')
    expect(mirror.queue.map(q => q.id)).toEqual(['q1'])
    expect(mirror.compacting).toBe(true)
    expect(mirror.preparing).toBe(true)
    expect(mirror.dispatching).toBe(true)
  })
})

describe('diffPatch', () => {
  it('detects changed messages by reference, skips stable ones', () => {
    const m1 = msg('1', 'user', 'a')
    const m2 = msg('2', 'assistant', 'b')
    const base = { rev: 1, messages: [m1, m2] }
    const m2b = msg('2', 'assistant', 'b-updated')
    const patch = diffPatch(base, source({ rev: 3, messages: [m1, m2b] }))
    expect(patch.baseRev).toBe(1)
    expect(patch.rev).toBe(3)
    expect(patch.messageCount).toBe(2)
    expect(patch.changed).toEqual([{ index: 1, message: m2b }])
  })

  it('includes appended messages and reports shrinkage via messageCount', () => {
    const m1 = msg('1', 'user', 'a')
    const grow = diffPatch({ rev: 1, messages: [m1] }, source({ rev: 2, messages: [m1, msg('2', 'assistant', 'b')] }))
    expect(grow.messageCount).toBe(2)
    expect(grow.changed.map(c => c.index)).toEqual([1])

    const shrink = diffPatch({ rev: 2, messages: [m1, msg('2', 'assistant', 'b')] }, source({ rev: 3, messages: [m1] }))
    expect(shrink.messageCount).toBe(1)
    expect(shrink.changed).toEqual([])
  })

  it('a full replacement (compaction) marks every index changed', () => {
    const before = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c')]
    const after = [msg('s', 'assistant', 'summary'), msg('3', 'user', 'c')]
    const patch = diffPatch({ rev: 5, messages: before }, source({ rev: 6, messages: after }))
    expect(patch.messageCount).toBe(2)
    expect(patch.changed.map(c => c.index)).toEqual([0, 1])
  })
})

describe('applyPatch', () => {
  function mirrorOf(rev: number, messages: UIMessage[]): PanelMirror {
    return applySnapshot(snapshotFrom(source({ rev, messages })))
  }

  it('applies a contiguous patch and carries status/flags', () => {
    const m1 = msg('1', 'user', 'a')
    const mirror = mirrorOf(1, [m1])
    const src = source({ rev: 4, messages: [m1, msg('2', 'assistant', 'b')], status: 'streaming', preparing: true, dispatching: true })
    const next = applyPatch(mirror, diffPatch({ rev: 1, messages: mirror.messages }, src))
    expect(next).not.toBeNull()
    expect(next!.rev).toBe(4)
    expect(next!.messages.map(m => m.id)).toEqual(['1', '2'])
    expect(next!.status).toBe('streaming')
    expect(next!.preparing).toBe(true)
    expect(next!.dispatching).toBe(true)
  })

  it('returns null on a rev gap — caller must resync', () => {
    const m1 = msg('1', 'user', 'a')
    const mirror = mirrorOf(1, [m1])
    const src = source({ rev: 9, messages: [m1] })
    // Reason: patch built against rev 5, mirror is at rev 1 → gap
    const patch = diffPatch({ rev: 5, messages: [m1] }, src)
    expect(applyPatch(mirror, patch)).toBeNull()
  })

  it('returns null when growth leaves an unfilled hole (corrupt patch)', () => {
    const m1 = msg('1', 'user', 'a')
    const mirror = mirrorOf(1, [m1])
    const patch = {
      type: 'patch' as const, baseRev: 1, rev: 2, messageCount: 3,
      changed: [{ index: 2, message: msg('3', 'user', 'c') }],
      status: 'ready' as const, errorMessage: undefined,
      queue: [], compacting: false, preparing: false, dispatching: false,
    }
    expect(applyPatch(mirror, patch)).toBeNull()
  })

  it('is idempotent-safe: reapplying the same patch fails the rev check', () => {
    const m1 = msg('1', 'user', 'a')
    const mirror = mirrorOf(1, [m1])
    const patch = diffPatch({ rev: 1, messages: [m1] }, source({ rev: 2, messages: [m1, msg('2', 'assistant', 'b')] }))
    const once = applyPatch(mirror, patch)
    expect(once).not.toBeNull()
    expect(applyPatch(once!, patch)).toBeNull()
  })
})
