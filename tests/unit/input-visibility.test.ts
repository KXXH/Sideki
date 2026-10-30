import { describe, it, expect } from 'vitest'
import { hiddenReason, describeHidden, type RenderProbe } from '../../src/shared/input'

function probe(over: Partial<RenderProbe> = {}): RenderProbe {
  return {
    connected: true,
    rendered: true,
    display: 'block',
    visibility: 'visible',
    opacity: 1,
    rect: { x: 10, y: 20, width: 100, height: 30 },
    viewport: { w: 1000, h: 800 },
    scrolled: true,
    ...over,
  }
}

describe('hiddenReason', () => {
  it('passes a plain visible element', () => {
    expect(hiddenReason(probe())).toBeNull()
  })

  it('rejects a detached element before anything else', () => {
    expect(hiddenReason(probe({ connected: false, rendered: false, display: 'none' }))).toBe('detached')
  })

  it('attributes display:none', () => {
    expect(hiddenReason(probe({ rendered: false, display: 'none' }))).toBe('display')
  })

  it('attributes visibility:hidden and collapse', () => {
    expect(hiddenReason(probe({ rendered: false, visibility: 'hidden' }))).toBe('visibility')
    expect(hiddenReason(probe({ rendered: false, visibility: 'collapse' }))).toBe('visibility')
  })

  // Reason: an element under a display:none ancestor computes its own display as
  // specified, so only checkVisibility catches it. That residual bucket is what
  // 'render' names — the whole point of trusting the probe over the style.
  it('falls back to render when the style does not explain it', () => {
    expect(hiddenReason(probe({ rendered: false }))).toBe('render')
  })

  it('rejects a zero-area box', () => {
    expect(hiddenReason(probe({ rect: { x: 5, y: 5, width: 0, height: 10 } }))).toBe('size')
    expect(hiddenReason(probe({ rect: { x: 5, y: 5, width: 10, height: 0 } }))).toBe('size')
  })

  // Reason: this is the load-bearing case for the sr-only pattern — a real
  // checkbox at opacity 0 over a styled span is exactly what you must click.
  it('never blocks opacity 0', () => {
    expect(hiddenReason(probe({ opacity: 0 }))).toBeNull()
  })

  it('never blocks a 1x1 clipped box', () => {
    expect(hiddenReason(probe({ rect: { x: 0, y: 0, width: 1, height: 1 } }))).toBeNull()
  })

  describe('offscreen', () => {
    it('rejects a box parked off-page to the left', () => {
      expect(hiddenReason(probe({ rect: { x: -9999, y: 20, width: 100, height: 30 } }))).toBe('offscreen')
    })

    it('rejects a box parked off-page above', () => {
      expect(hiddenReason(probe({ rect: { x: 10, y: -9999, width: 100, height: 30 } }))).toBe('offscreen')
    })

    it('rejects a box beyond the right and bottom edges', () => {
      expect(hiddenReason(probe({ rect: { x: 1000, y: 20, width: 100, height: 30 } }))).toBe('offscreen')
      expect(hiddenReason(probe({ rect: { x: 10, y: 800, width: 100, height: 30 } }))).toBe('offscreen')
    })

    it('accepts a box only partly outside', () => {
      expect(hiddenReason(probe({ rect: { x: -50, y: 20, width: 100, height: 30 } }))).toBeNull()
      expect(hiddenReason(probe({ rect: { x: 980, y: 20, width: 100, height: 30 } }))).toBeNull()
    })

    // Reason: without the scroll the verdict would fire on everything below the
    // fold, which is reachable — the flag is what keeps the check honest.
    it('stays silent when the rect was not measured after a scroll', () => {
      const below = { x: 10, y: 5000, width: 100, height: 30 }
      expect(hiddenReason(probe({ rect: below, scrolled: false }))).toBeNull()
      expect(hiddenReason(probe({ rect: below, scrolled: true }))).toBe('offscreen')
    })
  })
})

describe('describeHidden', () => {
  // Reason: the plan path keys its allFrames retry off the "No element found"
  // substring. A hidden target was found, so no message here may contain it.
  it('never collides with the retry sentinel', () => {
    const reasons = ['detached', 'display', 'visibility', 'render', 'size', 'offscreen'] as const
    for (const r of reasons) {
      expect(describeHidden(probe(), r, '#x')).not.toContain('No element found')
    }
  })

  it('names the target and the cause', () => {
    expect(describeHidden(probe({ display: 'none' }), 'display', '#menu-item'))
      .toContain('"#menu-item"')
    expect(describeHidden(probe({ visibility: 'collapse' }), 'visibility', '#x'))
      .toContain('visibility:collapse')
  })

  it('reports the measured geometry for size and offscreen', () => {
    expect(describeHidden(probe({ rect: { x: 0, y: 0, width: 0, height: 12 } }), 'size', '#x'))
      .toContain('0x12')
    const off = describeHidden(probe({ rect: { x: -9999, y: 20, width: 10, height: 10 } }), 'offscreen', '#x')
    expect(off).toContain('-9999,20')
    expect(off).toContain('1000x800')
  })

  it('tells the model what to do next', () => {
    expect(describeHidden(probe(), 'display', '#x')).toContain('Reveal it first')
  })

  // Reason: el.click() does no hit testing, so it still fires handlers on an
  // unrendered element — that is why the pre-engine implementation appeared to
  // work on collapsed menus. Without naming it, the refusal reads as a closed
  // choice of two actions and a model that follows instructions will not invent
  // a third, so a page that used to work would simply stop working.
  it('names the last-resort escape for every reachable-handler case', () => {
    for (const r of ['display', 'visibility', 'render', 'size', 'offscreen'] as const) {
      const msg = describeHidden(probe(), r, '#x')
      expect(msg, r).toContain('Last resort')
      expect(msg, r).toContain('el.click()')
    }
  })

  // Reason: an event on a detached node never reaches a connected root, so a
  // framework that delegates would not see it. Offering the escape there would
  // be advice that does not work.
  it('withholds the escape for a detached target', () => {
    const msg = describeHidden(probe({ connected: false }), 'detached', '#x')
    expect(msg).not.toContain('Last resort')
    expect(msg).toContain('Re-read the page')
  })
})
