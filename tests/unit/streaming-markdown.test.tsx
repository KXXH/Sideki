// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import StreamingMarkdown from '../../src/sidepanel/components/StreamingMarkdown'

vi.mock('@iconify/react', () => ({ Icon: () => null }))

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  chrome.storage.local.onChanged = { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(), hasListeners: vi.fn() }
})

afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(content: string, isStreaming = true) {
  await act(async () => root.render(<StreamingMarkdown content={content} isStreaming={isStreaming} />))
}

function animatedText(element: Element = container) {
  return [...element.querySelectorAll<HTMLElement>('[data-sd-animate]')]
    .filter(span => span.style.getPropertyValue('--sd-duration') !== '0ms')
    .map(span => span.textContent).join('')
}

describe('Markdown streaming animation', () => {
  it.each([
    ['Hello wor', 'Hello world', 'ld'],
    ['这是中文', '这是中文流式新增', '流式新增'],
  ])('fades only appended characters, including a partially received word (%s)', async (before, after, appended) => {
    await render(before)
    await render(after)

    expect(container.textContent).toBe(after)
    expect(animatedText()).toBe(appended)
  })

  it('does not queue a large burst of words behind stagger delays', async () => {
    await render('First paragraph.\n\n' + 'streaming text '.repeat(500))

    const spans = [...container.querySelectorAll<HTMLElement>('[data-sd-animate]')]
    expect(spans.length).toBeGreaterThan(0)
    expect(spans.every(span => parseFloat(span.style.getPropertyValue('--sd-delay') || '0') === 0)).toBe(true)
  })

  it('keeps a settled paragraph stable as the following paragraph streams', async () => {
    await render('Already complete.\n\nHel')
    const paragraph = container.querySelector('p')!
    const firstCharacter = paragraph.querySelector('[data-sd-animate]')

    await render('Already complete.\n\nHello wor')
    const previousAnimatedText = animatedText(paragraph)
    await render('Already complete.\n\nHello world')

    expect(container.querySelector('p')).toBe(paragraph)
    expect(paragraph.querySelector('[data-sd-animate]')).toBe(firstCharacter)
    expect(animatedText(paragraph)).toBe(previousAnimatedText)
    expect(animatedText(container.querySelectorAll('p')[1])).toBe('ld')
  })

  it('renders finished messages without animation wrappers', async () => {
    await render('Finished **reply**.')
    await render('Finished **reply**.', false)

    expect(container.querySelector('[data-sd-animate]')).toBeNull()
    expect(container.querySelector('strong')?.textContent).toBe('reply')
  })
})

describe('Markdown ordered lists', () => {
  it.each([0, 1, 3, 42])('preserves the Markdown start number %i in the list and its displayed counter', async start => {
    await render(`${start}. First item\n${start + 1}. Second item`, false)

    const list = container.querySelector('ol')!
    expect(list.start).toBe(start)
    expect(list.style.counterReset).toBe(`item ${start - 1}`)
    expect(list.querySelectorAll(':scope > li')).toHaveLength(2)
  })

  it('keeps nested list starts independent from the surrounding list', async () => {
    await render('3. Outer third\n\n    7. Inner seventh\n    8. Inner eighth\n\n4. Outer fourth', false)

    const [outer, inner] = container.querySelectorAll('ol')
    expect(outer.start).toBe(3)
    expect(outer.style.counterReset).toBe('item 2')
    expect(inner.start).toBe(7)
    expect(inner.style.counterReset).toBe('item 6')
    expect(outer.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(inner.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(outer.lastElementChild?.textContent).toContain('Outer fourth')
  })

  it('retains its starting number while more items stream in', async () => {
    await render('3. Third\n4. Fo')
    const list = container.querySelector('ol')!
    await render('3. Third\n4. Fourth\n5. Fifth')

    expect(container.querySelector('ol')).toBe(list)
    expect(list.start).toBe(3)
    expect(list.style.counterReset).toBe('item 2')
    expect(list.querySelectorAll(':scope > li')).toHaveLength(3)
  })
})
