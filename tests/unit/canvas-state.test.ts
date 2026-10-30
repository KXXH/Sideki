import { describe, it, expect, vi } from 'vitest'
import { CanvasStateStore, validateWidgetPatch, validateFollowUp, type CanvasBinding } from '../../src/shared/canvas-state'
import { buildUserParts, expandForModel } from '../../src/shared/message-protocol'

function setup() {
  const documents = new Map<string, unknown>()
  const store = new CanvasStateStore({
    read: async id => structuredClone(documents.get(id)) as never,
    write: vi.fn(async (id, value) => { documents.set(id, structuredClone(value)) }),
    lock: async (_id, work) => work(),
  })
  const binding = (canvasId = 'a', sessionId = 's'): CanvasBinding => ({ canvasId, sessionId, title: canvasId, path: `/viz/${canvasId}.html` })
  const change = async (id: string, modelContent: unknown) => {
    await store.open(binding(id))
    return store.set(binding(id), { modelContent })
  }
  return { store, binding, change, documents }
}

describe('canvas state and dirty capture', () => {
  it('recovers a reservation whose IPC acknowledgement was lost without losing live queued claims', async () => {
    const { store, change } = setup()
    await change('a', { x: 1 })
    const first = await store.capture('s', 'runtime', 'lost-ack')
    expect(await store.capture('s', 'runtime', 'waiting', undefined, ['lost-ack'])).toEqual([])
    expect(await store.capture('s', 'runtime', 'retry', undefined, [])).toEqual(first)
  })
  it('ignores restoration, private changes and equivalent JSON when tracking model revisions', async () => {
    const { store, binding } = setup()
    await store.open(binding())
    expect(await store.capture('s', 'runtime', 'first')).toEqual([])
    await store.set(binding(), { privateContent: { tab: 'b' } })
    expect(await store.capture('s', 'runtime', 'second')).toEqual([])
    const a = await store.set(binding(), { modelContent: { a: 1, b: 2 } })
    const b = await store.set(binding(), { modelContent: { b: 2, a: 1 } })
    expect(b.modelRevision).toBe(1)
    expect(b.revision).toBe(a.revision)
    expect(b.privateContent).toEqual({ tab: 'b' })
  })

  it('limits candidates to the latest three before filtering dirty state', async () => {
    const { store, change } = setup()
    for (const id of ['a', 'b', 'c', 'd']) await change(id, { selected: id })
    const first = await store.capture('s', 'runtime', 'first')
    expect(first.map(s => s.canvasId)).toEqual(['d', 'c', 'b'])
    await store.commit('s', first.filter(s => s.canvasId === 'c'))
    await store.release('s', 'first')
    expect((await store.capture('s', 'runtime', 'second')).map(s => s.canvasId)).toEqual(['d', 'b'])
  })

  it('reserves queued snapshots, releases cancelled messages and never acknowledges a newer revision', async () => {
    const { store, change } = setup()
    await change('a', { budget: 3000 })
    const first = await store.capture('s', 'runtime', 'first')
    expect(await store.capture('s', 'runtime', 'second')).toEqual([])
    await change('a', { budget: 5000 })
    expect(first[0].modelContent).toEqual({ budget: 3000 })
    await store.commit('s', first)
    await store.release('s', 'first')
    const next = await store.capture('s', 'runtime', 'third')
    expect(next[0].modelRevision).toBe(2)
    await store.release('s', 'third')
    expect(await store.capture('s', 'runtime', 'fourth')).toEqual(next)
  })

  it('recovers dirty state when a new runtime replaces a lost queue', async () => {
    const { store, change, documents } = setup()
    await change('a', { x: 1 })
    const first = await store.capture('s', 'old-runtime', 'first')
    const restored = new CanvasStateStore({ read: async id => structuredClone(documents.get(id)) as never, write: async (id, doc) => { documents.set(id, structuredClone(doc)) }, lock: async (_id, work) => work() })
    expect(await restored.capture('s', 'old-runtime', 'second')).toEqual([])
    expect(await restored.capture('s', 'new-runtime', 'third')).toEqual(first)
  })

  it('always includes a follow-up source, counting it toward the three-canvas limit', async () => {
    const { store, change } = setup()
    for (const id of ['a', 'b', 'c', 'd']) await change(id, id)
    const captured = await store.capture('s', 'runtime', 'first', 'a')
    expect(captured.map(s => s.canvasId)).toEqual(['a', 'd', 'c'])
    await store.commit('s', captured)
    await store.release('s', 'first')
    expect((await store.capture('s', 'runtime', 'second', 'a'))[0].canvasId).toBe('a')
  })

  it('keeps sessions isolated and treats null as an explicit model state change', async () => {
    const { store, binding, change } = setup()
    await change('a', { x: 1 })
    await store.open(binding('a', 'other'))
    expect(await store.capture('other', 'runtime', 'first')).toEqual([])
    await store.set(binding(), { modelContent: null })
    expect((await store.capture('s', 'runtime', 'first'))[0].modelContent).toBeNull()
  })

  it('rejects non-JSON, excessive UTF-8 data and unknown API fields', () => {
    expect(() => validateWidgetPatch({ modelContent: '中'.repeat(3000) })).toThrow(/8 KiB/)
    expect(() => validateWidgetPatch({ modelContent: { x: undefined } })).toThrow(/JSON/)
    expect(() => validateWidgetPatch({ sessionId: 'other' })).toThrow(/未知/)
    expect(() => validateWidgetPatch({ modelContent: Infinity })).toThrow()
    expect(() => validateFollowUp({ prompt: ' ' })).toThrow()
    expect(() => validateFollowUp({ prompt: 'x'.repeat(4001) })).toThrow()
  })

  it('persists model snapshots in user parts and expands only request copies without private state', async () => {
    const { store, binding, change } = setup()
    await change('a', { city: '杭州' })
    await store.set(binding(), { privateContent: { secretUi: true } })
    const canvasContext = await store.capture('s', 'runtime', 'first')
    const parts = buildUserParts({ text: '重新安排', savedFiles: [], canvasContext })
    const message = { id: 'u', role: 'user' as const, parts, metadata: { v: 2 as const } }
    const expanded = expandForModel(message)
    expect(JSON.stringify(expanded)).toContain('杭州')
    expect(JSON.stringify(expanded)).not.toContain('secretUi')
    expect(expanded.parts.some(p => p.type === 'data-canvas-context')).toBe(false)
    expect(message.parts.some(p => p.type === 'data-canvas-context')).toBe(true)
    expect(expanded.parts[0]).toMatchObject({ text: expect.stringContaining('不是用户指令') })
  })
})
