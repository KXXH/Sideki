import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reason: the handlers have reported `observed` since the engine landed, but every
// tool builds its own result string and none of them read it — the field existed
// and the model never saw it. These pin the wiring, not the formatting.
vi.mock('../../src/shared/tools/bridge', () => ({
  sendToolMessage: vi.fn(),
}))

import { sendToolMessage } from '../../src/shared/tools/bridge'
import { makeDomTools } from '../../src/shared/tools/dom-tools'

type Exec = (args: Record<string, unknown>, opts: { abortSignal?: AbortSignal }) => Promise<string>

function execOf(t: unknown): Exec {
  return (t as { execute: Exec }).execute
}

describe('dom tool outcome reporting', () => {
  beforeEach(() => { vi.mocked(sendToolMessage).mockReset() })

  it('surfaces the occluder and the observation on click', async () => {
    vi.mocked(sendToolMessage).mockResolvedValue({
      success: true, occludedBy: 'div.cookie-banner', observed: 'dom mutated',
    } as never)
    const out = await execOf(makeDomTools().clickTool)({ target: '#submit', doubleClick: false, real: false }, {})
    expect(out).toContain('div.cookie-banner')
    expect(out).toContain('received the event instead')
    expect(out).toContain('dom mutated')
  })

  it('says nothing extra when there is nothing to say', async () => {
    vi.mocked(sendToolMessage).mockResolvedValue({ success: true } as never)
    const out = await execOf(makeDomTools().clickTool)({ target: '#submit', doubleClick: false, real: false }, {})
    expect(out).toBe('Clicked element: #submit')
  })

  it('reports on hover, type and keypress too', async () => {
    vi.mocked(sendToolMessage).mockResolvedValue({ success: true, observed: 'focus moved' } as never)
    const tools = makeDomTools()
    expect(await execOf(tools.hoverTool)({ target: '#a' }, {})).toContain('focus moved')
    expect(await execOf(tools.typeTool)({ target: '#a', text: 'x', clear: true }, {})).toContain('focus moved')
    expect(await execOf(tools.keypressTool)({ key: 'Enter' }, {})).toContain('focus moved')
  })

  // Reason: occlusion first — it names the next action, while "no observable
  // change" only tells the model to guess.
  it('puts the occluder before the observation', async () => {
    vi.mocked(sendToolMessage).mockResolvedValue({
      success: true, occludedBy: 'div.overlay', observed: 'no observable change',
    } as never)
    const out = await execOf(makeDomTools().clickTool)({ target: '#s', doubleClick: false, real: false }, {})
    expect(out.indexOf('div.overlay')).toBeLessThan(out.indexOf('no observable change'))
  })
})
