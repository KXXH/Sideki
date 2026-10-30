import { describe, it, expect } from 'vitest'
import type { UIMessage } from 'ai'
import {
  expandForModel, visibleText, splitLegacyZws, findPageForReply,
  BRIDGE_TAG, RELAYED_TAG, ZWS,
} from '../../src/shared/message-protocol'

function userMsg(parts: UIMessage['parts'], metadata?: unknown): UIMessage {
  return { id: 'u1', role: 'user', parts, metadata } as UIMessage
}

function assistantMsg(parts: UIMessage['parts'], metadata?: unknown): UIMessage {
  return { id: 'a1', role: 'assistant', parts, metadata } as UIMessage
}

const text = (t: string) => ({ type: 'text' as const, text: t })

describe('message-protocol', () => {
  describe('splitLegacyZws', () => {
    it('extracts text after bridge prefix', () => {
      expect(splitLegacyZws(`[from:claude-code]${ZWS}hello`)).toBe('hello')
    })

    it('extracts text after element snapshot', () => {
      expect(splitLegacyZws(`[Selected element: btn]\n<div/>${ZWS}my question`)).toBe('my question')
    })

    it('keeps text before ZWS for skill commands', () => {
      expect(splitLegacyZws(`/seo-audit${ZWS}skill body`)).toBe('/seo-audit')
    })

    it('hides bare snapshot without ZWS', () => {
      expect(splitLegacyZws('[Selected element: btn]\n<div/>')).toBe('')
    })

    it('passes plain text through', () => {
      expect(splitLegacyZws('just text')).toBe('just text')
    })
  })

  describe('visibleText', () => {
    it('returns raw text for v2 messages without legacy parsing', () => {
      const msg = userMsg([text(`weird${ZWS}but intended`)], { v: 2 })
      expect(visibleText(msg)).toBe(`weird${ZWS}but intended`)
    })

    it('applies legacy split for non-v2 messages', () => {
      const msg = userMsg([text(`[from:claude-code]${ZWS}hi`)])
      expect(visibleText(msg)).toBe('hi')
    })
  })

  describe('expandForModel', () => {
    it('passes legacy messages through untouched', () => {
      const msg = userMsg([text(`/skill${ZWS}content`)])
      expect(expandForModel(msg)).toBe(msg)
    })

    it('passes v2 plain text through untouched', () => {
      const msg = userMsg([text('hello')], { v: 2 })
      expect(expandForModel(msg)).toBe(msg)
    })

    it('expands skill part into command + instructions', () => {
      const msg = userMsg([
        { type: 'data-skill', data: { name: 'seo-audit', content: 'DO THE AUDIT' } } as UIMessage['parts'][number],
        text('check this page'),
      ], { v: 2 })
      const out = expandForModel(msg)
      const t = out.parts.find(p => p.type === 'text') as { text: string }
      expect(t.text).toBe('/seo-audit check this page\nDO THE AUDIT')
      expect(out.parts.some(p => p.type === 'data-skill')).toBe(false)
    })

    it('hoists element snapshots before the user text', () => {
      const msg = userMsg([
        text('what is this?'),
        { type: 'data-element', data: { label: 'button 提交', snapshot: '<button>提交</button>' } } as UIMessage['parts'][number],
      ], { v: 2 })
      const out = expandForModel(msg)
      const t = out.parts.find(p => p.type === 'text') as { text: string }
      expect(t.text).toBe('[Selected element: button 提交]\n<button>提交</button>\n\nwhat is this?')
    })

    it('prepends bridge tag from metadata.source', () => {
      const msg = userMsg([text('fix the bug')], { v: 2, source: 'claude-code' })
      const out = expandForModel(msg)
      const t = out.parts.find(p => p.type === 'text') as { text: string }
      expect(t.text).toBe(`${BRIDGE_TAG} fix the bug`)
    })

    it('keeps file parts when expanding', () => {
      const msg = userMsg([
        { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,x' } as UIMessage['parts'][number],
        text('see image'),
        { type: 'data-element', data: { label: 'el', snapshot: '<i/>' } } as UIMessage['parts'][number],
      ], { v: 2 })
      const out = expandForModel(msg)
      expect(out.parts.filter(p => p.type === 'file')).toHaveLength(1)
      expect(out.parts.filter(p => p.type === 'text')).toHaveLength(1)
    })

    it('appends relayed tag to assistant messages with metadata.relayed', () => {
      const msg = assistantMsg([text('the answer')], { v: 2, relayed: true })
      const out = expandForModel(msg)
      const t = out.parts.find(p => p.type === 'text') as { text: string }
      expect(t.text).toBe(`the answer\n${RELAYED_TAG}`)
    })

    it('leaves assistant messages without relayed flag untouched', () => {
      const msg = assistantMsg([text('the answer')], { v: 2 })
      expect(expandForModel(msg)).toBe(msg)
    })

    it('folds attachmentNotes into model text, keeping file parts', () => {
      const msg = userMsg([
        { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,x' } as UIMessage['parts'][number],
        text('what is this'),
      ], { v: 2, attachmentNotes: '\n[attachment saved: /tmp/attachments/1-0.jpeg (9KB)]' })
      const out = expandForModel(msg)
      expect(out.parts.filter(p => p.type === 'file')).toHaveLength(1)
      const t = out.parts.find(p => p.type === 'text') as { text: string }
      expect(t.text).toBe('what is this\n[attachment saved: /tmp/attachments/1-0.jpeg (9KB)]')
    })

    it('expands image-only messages when attachmentNotes present', () => {
      const msg = userMsg([
        { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,x' } as UIMessage['parts'][number],
      ], { v: 2, attachmentNotes: '\n[attachment saved: /tmp/a.jpeg (1KB)]' })
      const out = expandForModel(msg)
      const t = out.parts.find(p => p.type === 'text') as { text: string }
      expect(t.text).toContain('[attachment saved: /tmp/a.jpeg (1KB)]')
    })
  })

  describe('findPageForReply', () => {
    const page = { pageUrl: 'https://a.com/x', pageTitle: 'A' }

    it('returns the page of the triggering user message', () => {
      const msgs = [
        { role: 'user', metadata: { v: 2, ...page } },
        { role: 'assistant' },
      ]
      expect(findPageForReply(msgs, 1)).toEqual({ url: 'https://a.com/x', title: 'A' })
    })

    it('skips intermediate assistant messages in multi-step turns', () => {
      const msgs = [
        { role: 'user', metadata: { v: 2, ...page } },
        { role: 'assistant' },
        { role: 'assistant' },
      ]
      expect(findPageForReply(msgs, 2)).toEqual({ url: 'https://a.com/x', title: 'A' })
    })

    it('does not attribute an older message page to a newer reply', () => {
      const msgs = [
        { role: 'user', metadata: { v: 2, ...page } },
        { role: 'assistant' },
        { role: 'user', metadata: { v: 2 } },
        { role: 'assistant' },
      ]
      expect(findPageForReply(msgs, 3)).toBeNull()
    })

    it('returns null for legacy messages without metadata', () => {
      const msgs = [{ role: 'user' }, { role: 'assistant' }]
      expect(findPageForReply(msgs, 1)).toBeNull()
    })

    it('falls back to url as title when pageTitle missing', () => {
      const msgs = [
        { role: 'user', metadata: { v: 2, pageUrl: 'https://b.com' } },
        { role: 'assistant' },
      ]
      expect(findPageForReply(msgs, 1)).toEqual({ url: 'https://b.com', title: 'https://b.com' })
    })

    it('clamps out-of-range index', () => {
      const msgs = [{ role: 'user', metadata: { v: 2, ...page } }]
      expect(findPageForReply(msgs, 99)).toEqual({ url: 'https://a.com/x', title: 'A' })
      expect(findPageForReply([], 0)).toBeNull()
    })
  })
})
