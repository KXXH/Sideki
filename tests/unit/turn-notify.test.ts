import { describe, it, expect } from 'vitest'
import {
  extractTurnSnippet,
  shouldNotifyTurn,
  turnNotificationId,
  parseTurnNotificationId,
  turnNotificationText,
} from '../../src/shared/turn-notify'

type Msg = { role: string; parts: { type: string; text?: string }[] }

const user = (text: string): Msg => ({ role: 'user', parts: [{ type: 'text', text }] })
const assistant = (...texts: string[]): Msg => ({ role: 'assistant', parts: texts.map(t => ({ type: 'text', text: t })) })

describe('extractTurnSnippet', () => {
  it('takes the LAST assistant message, not the first', () => {
    const snippet = extractTurnSnippet([user('问'), assistant('第一轮回答'), user('再问'), assistant('第二轮回答')] as never)
    expect(snippet).toBe('第二轮回答')
  })

  it('joins multiple text parts and ignores non-text parts', () => {
    const msg = {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '内部推理' },
        { type: 'text', text: '前半' },
        { type: 'tool-bash', text: 'echo hi' },
        { type: 'text', text: '后半' },
      ],
    }
    expect(extractTurnSnippet([user('问'), msg] as never)).toBe('前半后半')
  })

  it('flattens markdown furniture into one line', () => {
    const md = '## 结论\n\n- 第一点 **加粗**\n- 第二点 `code`\n\n> 引用\n\n[链接](https://example.com) 和 ![图](x.png)'
    const flat = extractTurnSnippet([user('问'), assistant(md)] as never)
    expect(flat).toBe('结论 第一点 加粗 第二点 code 引用 链接 和')
  })

  it('drops fenced code content', () => {
    const md = '看这段：\n```js\nconst secret = 1\n```\n就这样'
    expect(extractTurnSnippet([user('问'), assistant(md)] as never)).toBe('看这段： 就这样')
  })

  it('truncates to the limit with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const snippet = extractTurnSnippet([assistant(long)] as never, 20)
    expect(snippet).toBe('x'.repeat(20) + '…')
  })

  it('does not truncate at exactly the limit', () => {
    expect(extractTurnSnippet([assistant('y'.repeat(20))] as never, 20)).toBe('y'.repeat(20))
  })

  it('returns empty for a turn with no assistant text', () => {
    expect(extractTurnSnippet([user('问')] as never)).toBe('')
    expect(extractTurnSnippet([assistant('   ')] as never)).toBe('')
    expect(extractTurnSnippet([] as never)).toBe('')
  })
})

describe('shouldNotifyTurn', () => {
  it('stays silent while the user watches that session in a focused window', () => {
    expect(shouldNotifyTurn({ foreground: true, anyWindowFocused: true, enabled: true })).toBe(false)
  })

  it('fires when the session is not the one on screen', () => {
    expect(shouldNotifyTurn({ foreground: false, anyWindowFocused: true, enabled: true })).toBe(true)
  })

  it('fires when no browser window holds focus', () => {
    expect(shouldNotifyTurn({ foreground: true, anyWindowFocused: false, enabled: true })).toBe(true)
  })

  it('honours the opt-out', () => {
    expect(shouldNotifyTurn({ foreground: false, anyWindowFocused: false, enabled: false })).toBe(false)
  })
})

describe('notification id round trip', () => {
  it('keeps mode and window id so the click handler needs no lookup', () => {
    const id = turnNotificationId('pro', 42, '3f2a-uuid')
    expect(parseTurnNotificationId(id)).toEqual({ mode: 'pro', windowId: 42, sessionId: '3f2a-uuid' })
  })

  it('survives a missing window id', () => {
    expect(parseTurnNotificationId(turnNotificationId('chat', null, 'abc')))
      .toEqual({ mode: 'chat', windowId: null, sessionId: 'abc' })
  })

  it('keeps colons inside the session id', () => {
    expect(parseTurnNotificationId(turnNotificationId('chat', 7, 'a:b:c')))
      .toEqual({ mode: 'chat', windowId: 7, sessionId: 'a:b:c' })
  })

  it('ignores foreign notification ids', () => {
    expect(parseTurnNotificationId('consent-1727000000000')).toBeNull()
    expect(parseTurnNotificationId('turn-done:')).toBeNull()
    expect(parseTurnNotificationId('turn-done:chat')).toBeNull()
    expect(parseTurnNotificationId('turn-done:chat:12')).toBeNull()
    expect(parseTurnNotificationId('turn-done:chat:12:')).toBeNull()
    expect(parseTurnNotificationId('turn-done:other:12:abc')).toBeNull()
  })
})

describe('turnNotificationText', () => {
  it('falls back for an untitled session and an empty answer', () => {
    expect(turnNotificationText({ title: '  ', snippet: '' })).toEqual({ title: 'Sideki', message: '已完成' })
  })

  it('never shows the placeholder as a name', () => {
    expect(turnNotificationText({ title: 'New Chat', snippet: '做完了' }))
      .toEqual({ title: 'Sideki', message: '做完了' })
  })

  it('passes real content through', () => {
    expect(turnNotificationText({ title: ' 修列表 ', snippet: ' 改完了 ' })).toEqual({ title: '修列表', message: '改完了' })
  })
})
