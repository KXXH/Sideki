import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { projectMessages } from '../../src/sidepanel/message-display'
import { derivePhase, type StatusPhase } from '../../src/sidepanel/status-phase'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function message(id: string, role: UIMessage['role'], text = id): UIMessage {
  return freeze({ id, role, parts: [{ type: 'text', text }], metadata: { originalId: id } })
}

const messageKey = (session: string, id: string) => JSON.stringify([session, 'message', id])
const replyKey = (session: string, id: string) => JSON.stringify([session, 'reply', id])

describe('projectMessages', () => {
  it.each<StatusPhase>(['idle', 'building', 'requesting', 'working', 'writing'])(
    'preserves frozen raw messages, parts, metadata and indices in phase %s', phase => {
      const raw = freeze([message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user')])
      const before = JSON.stringify(raw)
      const projected = projectMessages(raw, 'session', phase)
      const pending = phase === 'building' || phase === 'requesting'

      expect(projected).not.toBe(raw)
      expect(projected).toHaveLength(raw.length + Number(pending))
      expect(raw).toHaveLength(3)
      expect(JSON.stringify(raw)).toBe(before)
      raw.forEach((original, i) => {
        expect(projected[i].message).toBe(original)
        expect(projected[i].message?.parts).toBe(original.parts)
        expect(projected[i].message?.metadata).toBe(original.metadata)
        expect(projected[i].sourceIndex).toBe(i)
      })
      if (pending) {
        expect(projected.at(-1)).toEqual({ key: replyKey('session', 'u2'), message: null, sourceIndex: 3 })
      }
    },
  )

  it('keeps earlier keys and each pending-to-real reply key stable through three turns', () => {
    let raw: readonly UIMessage[] = freeze([])
    let previousKeys: string[] = []

    for (let turn = 1; turn <= 3; turn++) {
      const user = message(`u${turn}`, 'user')
      raw = freeze([...raw, user])
      const building = projectMessages(raw, 'session', 'building')
      const requesting = projectMessages(raw, 'session', 'requesting')
      expect(building.map(item => item.key)).toEqual([
        ...previousKeys, messageKey('session', user.id), replyKey('session', user.id),
      ])
      expect(requesting).toEqual(building)
      expect(requesting.at(-1)?.message).toBeNull()
      expect(requesting.at(-1)?.sourceIndex).toBe(raw.length)

      const emptyAssistant: UIMessage = freeze({ id: `sdk-a${turn}`, role: 'assistant', parts: [] })
      const started = projectMessages(freeze([...raw, emptyAssistant]), 'session', 'working')
      const assistant = message(emptyAssistant.id, 'assistant', `Answer ${turn}`)
      raw = freeze([...raw, assistant])
      const writing = projectMessages(raw, 'session', 'writing')
      const completed = projectMessages(raw, 'session', 'idle')
      for (const items of [started, writing, completed]) {
        expect(items.map(item => item.key)).toEqual(requesting.map(item => item.key))
        expect(items.at(-1)?.sourceIndex).toBe(requesting.at(-1)?.sourceIndex)
        expect(items.every(item => item.message !== null)).toBe(true)
      }
      expect(started.at(-1)?.message).toBe(emptyAssistant)
      expect(completed.at(-1)?.message).toBe(assistant)
      expect(assistant.id).toBe(`sdk-a${turn}`)
      previousKeys = completed.map(item => item.key)
    }
  })

  it('assigns only the first assistant per user the reply key and retains all additional assistants', () => {
    const raw = freeze([
      message('u1', 'user'), message('a1', 'assistant'), message('a2', 'assistant'), message('a3', 'assistant'),
      message('u2', 'user'), message('a4', 'assistant'), message('a5', 'assistant'),
    ])
    const items = projectMessages(raw, 'session', 'requesting')
    expect(items.map(item => item.key)).toEqual([
      messageKey('session', 'u1'), replyKey('session', 'u1'), messageKey('session', 'a2'), messageKey('session', 'a3'),
      messageKey('session', 'u2'), replyKey('session', 'u2'), messageKey('session', 'a5'),
    ])
    expect(new Set(items.map(item => item.key)).size).toBe(raw.length)
    expect(items).toHaveLength(raw.length)
    items.forEach((item, i) => expect(item.message).toBe(raw[i]))
  })

  it('retains orphan assistants and a compacted summary before the first user', () => {
    const raw = freeze([
      message('orphan', 'assistant'), message('summary', 'assistant', '[Context Compacted] Earlier conversation'),
      message('system', 'system'), message('u1', 'user'), message('a1', 'assistant'),
    ])
    const items = projectMessages(raw, 'session', 'idle')
    expect(items.map(item => item.key)).toEqual([
      messageKey('session', 'orphan'), messageKey('session', 'summary'), messageKey('session', 'system'),
      messageKey('session', 'u1'), replyKey('session', 'u1'),
    ])
    items.forEach((item, i) => {
      expect(item.message).toBe(raw[i])
      expect(item.sourceIndex).toBe(i)
    })
  })

  it('targets the latest user when consecutive users have no assistant yet', () => {
    const raw = freeze([message('u1', 'user'), message('u2', 'user')])
    const pending = projectMessages(raw, 'session', 'requesting')
    const replied = projectMessages(freeze([...raw, message('a2', 'assistant')]), 'session', 'working')
    expect(pending.at(-1)?.key).toBe(replyKey('session', 'u2'))
    expect(replied.map(item => item.key)).toEqual(pending.map(item => item.key))
    expect(pending).toHaveLength(3)
  })

  it.each(['ready', 'error'])('%s creates no pending slot after stop, failure or completion', status => {
    const phase = derivePhase({ status, preparing: false, dispatching: false, trailing: 'none' })
    expect(phase).toBe('idle')
    const user = message('u1', 'user')
    for (const raw of [freeze([user]), freeze([user, message('a1', 'assistant')])]) {
      const items = projectMessages(raw, 'session', phase)
      expect(items).toHaveLength(raw.length)
      expect(items.every(item => item.message !== null)).toBe(true)
    }
  })

  it.each<StatusPhase>(['idle', 'building', 'requesting', 'working', 'writing'])(
    'does not invent a pending slot for an empty list or a trailing non-user in phase %s', phase => {
      expect(projectMessages(freeze([]), 'session', phase)).toEqual([])
      for (const role of ['assistant', 'system'] as const) {
        const raw = freeze([message('u1', 'user'), message('last', role)])
        const items = projectMessages(raw, 'session', phase)
        expect(items).toHaveLength(2)
        expect(items.at(-1)?.message).toBe(raw[1])
      }
    },
  )

  it('isolates every key by session, including pending and extra assistant keys', () => {
    const raw = freeze([
      message('user/"reply"', 'user'), message('a1', 'assistant'), message('a2', 'assistant'), message('u2', 'user'),
    ])
    const first = projectMessages(raw, 's/"one"', 'requesting')
    const second = projectMessages(raw, 's/"two"', 'requesting')
    const keys = [...first, ...second].map(item => item.key)
    expect(new Set(keys).size).toBe(keys.length)
    first.forEach((item, i) => {
      expect(item.message).toBe(second[i].message)
      expect(item.sourceIndex).toBe(second[i].sourceIndex)
      expect(JSON.parse(item.key)[0]).toBe('s/"one"')
      expect(JSON.parse(second[i].key)[0]).toBe('s/"two"')
    })
  })
})
