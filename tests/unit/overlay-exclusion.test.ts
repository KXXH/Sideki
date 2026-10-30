import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { OVERLAY_SELECTOR, OVERLAY_SELECTORS, SK_OVERLAY_ATTR, AI_POINTER_ID, AI_POINTER_Z_INDEX } from '../../src/shared/input'
import { installResolver } from '../../src/background/element-resolver'
import { setOverlayVisibility } from '../../src/background/tool-handlers'

// Reason: Sidekick's overlays used to dodge the DOM snapshot and page-content
// serialization only by accident — they mount on documentElement while those
// paths root at document.body. The AI pointer breaks that accident: it is a
// fixed, interactive-looking node the resolver would happily target. This suite
// pins the one thing a shared selector can actually get wrong — falling out of
// sync with the markers the overlays really set.

const OVERLAY_SOURCES = [
  'src/background/element-picker.ts',
  'src/background/page-lock-indicator.ts',
]

function markersIn(source: string): string[] {
  return [
    ...source.matchAll(/['"`](data-sidekick-[a-z-]+)['"`]/g),
    ...source.matchAll(/['"`](__sidekick_[a-z_]+__)['"`]/g),
  ].map(m => m[1])
}

describe('OVERLAY_SELECTORS', () => {
  it('covers every marker the overlay scripts actually set', () => {
    const found = new Set(OVERLAY_SOURCES.flatMap(f => markersIn(readFileSync(f, 'utf8'))))
    expect(found.size).toBeGreaterThan(0)
    found.add(AI_POINTER_ID)
    found.add(SK_OVERLAY_ATTR)

    for (const marker of found) {
      const covered = OVERLAY_SELECTORS.some(s => s.includes(marker))
      expect(covered, `${marker} is not covered by OVERLAY_SELECTORS`).toBe(true)
    }
  })

  it('is a valid comma-joined selector list', () => {
    expect(OVERLAY_SELECTOR.split(', ')).toEqual([...OVERLAY_SELECTORS])
    expect(OVERLAY_SELECTOR).not.toContain(',,')
  })

  it('sits below the lock indicator and consent highlight', () => {
    expect(AI_POINTER_Z_INDEX).toBeLessThan(2147483646)
  })
})

describe('installResolver overlay exclusion', () => {
  it('consults the injected selector rather than a module constant', () => {
    // Reason: the function is serialized by executeScript, so a module-scope
    // reference would be a free variable at runtime. It must arrive as an arg.
    const src = installResolver.toString()
    expect(installResolver.length).toBe(1)
    expect(src).toContain('overlaySelector')
    expect(src).not.toContain('OVERLAY_SELECTOR')
  })

  it('filters overlay nodes out of the text-search candidates', () => {
    const src = installResolver.toString()
    expect(src).toContain('closest(overlaySelector)')
  })
})

describe('setOverlayVisibility', () => {
  it('consults the injected selector rather than a module constant', () => {
    // Reason: serialized by executeScript, so a module-scope reference would be
    // a free variable at runtime — same constraint installResolver is held to.
    const src = setOverlayVisibility.toString()
    expect(setOverlayVisibility.length).toBe(2)
    expect(src).toContain('overlaySelector')
    expect(src).not.toContain('OVERLAY_SELECTOR')
  })

  it('hides with !important and restores by removing the property', () => {
    // Reason: a page rule could otherwise outweigh the hide, and assigning ''
    // instead of removeProperty would leave a stray inline declaration behind.
    const src = setOverlayVisibility.toString()
    expect(src).toMatch(/setProperty\(.visibility., .hidden., .important.\)/)
    expect(src).toMatch(/removeProperty\(.visibility.\)/)
  })
})
