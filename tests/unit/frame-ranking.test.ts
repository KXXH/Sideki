import { describe, it, expect } from 'vitest'
import { scoreFrame, pickContentFrame, buildFrameNote, stripInvisibleChars, type FrameMetrics } from '../../src/background/tool-handlers'

// Reason: getPageContent used to concatenate every frame's HTML into a pseudo
// document, giving ad iframes equal footing with the real content. Ranking now
// picks the frame holding the document; these tests pin the three real-world
// cases the scoring was designed for plus the ordering guarantees.

function frame(over: Partial<FrameMetrics> = {}): FrameMetrics {
  return {
    frameId: 0,
    url: 'https://example.com/',
    title: 'Example',
    textLen: 1000,
    htmlLen: 5000,
    area: 1_200_000,
    hasSemantic: false,
    ...over,
  }
}

describe('scoreFrame', () => {
  it('drops frames below the readable-text floor', () => {
    expect(scoreFrame(frame({ textLen: 49 }))).toBe(0)
    expect(scoreFrame(frame({ textLen: 50, frameId: 3 }))).toBe(50)
  })

  it('uses text length as the base score', () => {
    expect(scoreFrame(frame({ frameId: 3, textLen: 800 }))).toBe(800)
  })

  it('boosts a semantic content root', () => {
    expect(scoreFrame(frame({ frameId: 3, textLen: 800, hasSemantic: true }))).toBe(1600)
  })

  it('boosts the top frame', () => {
    expect(scoreFrame(frame({ frameId: 0, textLen: 800 }))).toBe(1200)
  })

  it('penalises ad-sized frames', () => {
    // 300x250 = 75_000 px², below the 100_000 cutoff
    expect(scoreFrame(frame({ frameId: 4, textLen: 800, area: 75_000 }))).toBeCloseTo(240)
    // 728x90 and 160x600 are also below the cutoff
    expect(scoreFrame(frame({ frameId: 4, textLen: 800, area: 65_520 }))).toBeCloseTo(240)
    expect(scoreFrame(frame({ frameId: 4, textLen: 800, area: 96_000 }))).toBeCloseTo(240)
    // a real content viewport is not penalised
    expect(scoreFrame(frame({ frameId: 4, textLen: 800, area: 310_000 }))).toBe(800)
  })
})

describe('pickContentFrame', () => {
  it('returns null when no frame has readable text', () => {
    expect(pickContentFrame([frame({ textLen: 0 }), frame({ frameId: 7, textLen: 12 })])).toBeNull()
    expect(pickContentFrame([])).toBeNull()
  })

  it('keeps the article when lazy media frames are empty (cloudflare case)', () => {
    // Reason: off-screen Stream iframes return no document, so they never even
    // reach ranking — the page that used to hang now resolves to the top frame.
    const picked = pickContentFrame([
      frame({ frameId: 0, textLen: 9000, hasSemantic: true }),
    ])
    expect(picked?.winner.frameId).toBe(0)
    expect(picked?.others).toEqual([])
  })

  it('picks the nested editor over the app shell (dingtalk case)', () => {
    const shell = frame({ frameId: 0, textLen: 700, title: 'Docs' })
    const editor = frame({
      frameId: 7, textLen: 8000, hasSemantic: true,
      url: 'https://docs.dingtalk.com/doc/1', area: 900_000,
    })
    const picked = pickContentFrame([shell, editor])
    expect(picked?.winner.frameId).toBe(7)
    expect(picked?.others.map(m => m.frameId)).toEqual([0])
  })

  it('keeps a shorter article ahead of a longer comments frame', () => {
    // article 2000 × 2.0 semantic × 1.5 top = 6000 beats comments 5000
    const article = frame({ frameId: 0, textLen: 2000, hasSemantic: true })
    const comments = frame({ frameId: 3, textLen: 5000, url: 'https://disqus.com/embed' })
    expect(pickContentFrame([comments, article])?.winner.frameId).toBe(0)
  })

  it('orders ties by text length then frameId', () => {
    const a = frame({ frameId: 9, textLen: 500 })
    const b = frame({ frameId: 2, textLen: 500 })
    const c = frame({ frameId: 5, textLen: 600 })
    const picked = pickContentFrame([a, b, c])
    expect(picked?.winner.frameId).toBe(5)
    expect(picked?.others.map(m => m.frameId)).toEqual([2, 9])
  })
})

describe('buildFrameNote', () => {
  it('is absent for a plain single-frame page', () => {
    expect(buildFrameNote(frame({ frameId: 0 }), [])).toBeUndefined()
  })

  it('states provenance when content came from a nested frame', () => {
    const note = buildFrameNote(frame({ frameId: 7, url: 'https://docs.dingtalk.com/doc/1' }), [])
    expect(note).toBe('[content from frame 7 · docs.dingtalk.com]')
  })

  it('lists sibling frames with ids and sizes', () => {
    const note = buildFrameNote(frame({ frameId: 0 }), [
      frame({ frameId: 7, textLen: 12_400, url: 'https://docs.dingtalk.com/doc/1' }),
      frame({ frameId: 3, textLen: 5200, url: 'https://disqus.com/embed' }),
    ])
    expect(note).toContain('read one with frame=<id>')
    expect(note).toContain('- 7 · docs.dingtalk.com · 12.4KB text')
    expect(note).toContain('- 3 · disqus.com · 5.2KB text')
  })

  it('caps the listing at five frames and says so', () => {
    const others = Array.from({ length: 8 }, (_, i) => frame({ frameId: i + 1, textLen: 100 }))
    const note = buildFrameNote(frame({ frameId: 0 }), others) ?? ''
    expect(note).toContain('(top 5 of 8)')
    expect(note.split('\n').filter(l => l.startsWith('- '))).toHaveLength(5)
  })
})

describe('stripInvisibleChars', () => {
  it('removes watermark-class invisible characters', () => {
    // the DingTalk sample: ZWSP + pop-directional + invisible operators + BOM + SHY
    const dirty = '\u200B\u202C\u2061\u2062\u2063\u2060\uFEFF\u00ADAI自动化文档'
    expect(stripInvisibleChars(dirty)).toBe('AI自动化文档')
  })

  it('removes bidi override controls', () => {
    expect(stripInvisibleChars('a\u202Eb\u200Ec\u200Fd')).toBe('abcd')
  })

  it('keeps ZWJ so composed emoji stay intact', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(stripInvisibleChars(family)).toBe(family)
  })

  it('keeps ZWNJ so Persian orthography stays intact', () => {
    const persian = '\u0645\u06CC\u200C\u0631\u0648\u0645'
    expect(stripInvisibleChars(persian)).toBe(persian)
  })

  it('leaves ordinary text untouched', () => {
    const s = 'plain text 中文 éèê \n\t spaces'
    expect(stripInvisibleChars(s)).toBe(s)
  })
})
