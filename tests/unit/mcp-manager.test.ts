import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMCPClient, type OAuthClientProvider } from '@ai-sdk/mcp'

// Reason: the manager's job is deciding *when* to talk to the servers — the
// transport itself is the SDK's. A fake client lets us count exactly how many
// tools/list round trips a given call sequence costs.
const toolsCalls: string[] = []
const closeCalls: string[] = []
const originalFetch = globalThis.fetch
let connectImpl: (url: string) => Promise<void> = async () => {}
let toolsImpl: (url: string) => Promise<void> = async () => {}
let closeImpl: (url: string) => Promise<void> = async () => {}

vi.mock('@ai-sdk/mcp', () => ({
  auth: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  createMCPClient: vi.fn(async ({ transport }: { transport: { url: string } }) => {
    await connectImpl(transport.url)
    const host = new URL(transport.url).hostname.split('.')[0]
    return {
      tools: async () => {
        toolsCalls.push(transport.url)
        await toolsImpl(transport.url)
        return { ['tool_' + host]: { description: 'd', inputSchema: {} } }
      },
      callTool: async () => ({}),
      close: async () => { closeCalls.push(transport.url); await closeImpl(transport.url) },
    }
  }),
}))

import { McpClientManager, probeMcpServer, MCP_INITIALIZATION_TIMEOUT_MS } from '../../src/shared/mcp-client'
import type { McpServerConfig } from '../../src/shared/types'

const server = (id: string, over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id, name: `srv_${id}`, url: `https://${id}.example.com/mcp`, auth: { type: 'none' }, enabled: true, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(chrome.storage.local.get).mockResolvedValue({})
  toolsCalls.length = 0
  closeCalls.length = 0
  connectImpl = async () => {}
  toolsImpl = async () => {}
  closeImpl = async () => {}
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); globalThis.fetch = originalFetch })

function useDeadlineClock() {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms)
    return controller.signal
  })
}

describe('McpClientManager.ensureTools', () => {
  it('skips the same unauthenticated Exa server that Settings marks needs_auth', async () => {
    const exa = server('exa', { url: 'https://mcp.exa.ai/mcp?login', auth: { type: 'oauth' } })
    expect(await probeMcpServer(exa)).toEqual({ status: 'needs_auth', toolCount: 0 })
    const connections: string[] = []
    connectImpl = async url => {
      connections.push(url)
      if (url === exa.url) await new Promise(() => {})
    }
    const result = await Promise.race([
      new McpClientManager().ensureTools([
        server('aone', { enabled: false, auth: { type: 'oauth' } }),
        server('ding'), server('mdn', { enabled: false }), exa,
      ]),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 20)),
    ])
    expect(result).not.toBe('blocked')
    expect(connections).toEqual([server('ding').url])
    if (result !== 'blocked') {
      expect(result.tools.map(t => t.qualifiedName)).toEqual(['srv_ding_tool_ding'])
      expect(result.errors.exa).toContain('授权')
    }
  })

  it.each(['connect', 'list'])('bounds a stuck %s, aborts its network and allows retry without stale tools', async stage => {
    useDeadlineClock()
    const m = new McpClientManager()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    if (stage === 'connect') connectImpl = url => url.includes('bad.') ? gate : Promise.resolve()
    else toolsImpl = url => url.includes('bad.') ? gate : Promise.resolve()
    const first = m.ensureTools([server('good'), server('bad')])
    await vi.advanceTimersByTimeAsync(0)
    const badTransport = vi.mocked(createMCPClient).mock.calls.find(([config]) => {
      return (config?.transport as { url?: string }).url?.includes('bad.')
    })![0]!.transport as { fetch: typeof fetch }
    const network = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', network)
    const networkResult = badTransport.fetch('https://bad.example.com/oauth').catch(error => error)
    await vi.advanceTimersByTimeAsync(MCP_INITIALIZATION_TIMEOUT_MS)
    const result = await first
    expect(result.errors.bad).toContain('超时')
    expect(result.tools.map(t => t.serverId)).toEqual(['good'])
    expect((await networkResult).message).toContain('超时')
    expect(network.mock.calls[0][1]!.signal!.aborted).toBe(true)

    connectImpl = async () => {}
    toolsImpl = async () => {}
    const retried = await m.ensureTools([server('good'), server('bad')])
    expect(retried.errors).toEqual({})
    expect(retried.tools).toHaveLength(2)
    const goodLists = toolsCalls.filter(url => url.includes('good.')).length
    expect(goodLists).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(await m.getToolMetadata()).toEqual(retried.tools)
    if (stage === 'connect') expect(closeCalls).toContain(server('bad').url)
    await m.disconnectAll()
  })

  it('reports list failures and retries them without re-listing healthy servers', async () => {
    const m = new McpClientManager()
    toolsImpl = async url => { if (url.includes('bad.')) throw new Error('list failed') }
    const first = await m.ensureTools([server('good'), server('bad')])
    expect(first.errors.bad).toBe('list failed')
    expect(first.tools.map(t => t.serverId)).toEqual(['good'])
    toolsImpl = async () => {}
    toolsCalls.length = 0
    expect((await m.ensureTools([server('good'), server('bad')])).tools).toHaveLength(2)
    expect(toolsCalls).toEqual([server('bad').url])
  })

  it('does not let a hung close block config changes', async () => {
    const m = new McpClientManager()
    await m.ensureTools([server('old')])
    closeImpl = () => new Promise(() => {})
    const result = await m.ensureTools([server('new')])
    expect(result.tools.map(t => t.serverId)).toEqual(['new'])
    expect(closeCalls).toContain(server('old').url)
  })

  it('reconciles a changed config instead of returning an old inflight result', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    connectImpl = url => url.includes('old.') ? gate : Promise.resolve()
    const m = new McpClientManager()
    const old = m.ensureTools([server('old')])
    const updated = m.ensureTools([server('new')])
    release()
    expect((await old).tools.map(t => t.serverId)).toEqual(['old'])
    expect((await updated).tools.map(t => t.serverId)).toEqual(['new'])
  })

  it('keeps authenticated OAuth tools and requires explicit login when a redirect is needed', async () => {
    const exa = server('exa', { auth: { type: 'oauth' } })
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ mcp_tokens_exa: { access_token: 'test-token' } })
    const result = await new McpClientManager().ensureTools([exa])
    expect(result.tools).toHaveLength(1)
    expect(result.errors).toEqual({})
    const transport = vi.mocked(createMCPClient).mock.calls[0][0]!.transport as { authProvider: OAuthClientProvider }
    await expect(transport.authProvider.redirectToAuthorization(new URL('https://example.com/login'))).rejects.toThrow('需要授权')
  })

  it('settles a stalled settings probe with a timeout instead of displaying connecting forever', async () => {
    useDeadlineClock()
    connectImpl = () => new Promise(() => {})
    const pending = probeMcpServer(server('mdn', { enabled: false }))
    await vi.advanceTimersByTimeAsync(MCP_INITIALIZATION_TIMEOUT_MS)
    expect(await pending).toMatchObject({ status: 'error', toolCount: 0, error: expect.stringContaining('超时') })
  })

  it('connects and lists tools on first use', async () => {
    const m = new McpClientManager()
    const res = await m.ensureTools([server('a')])
    expect(toolsCalls).toEqual(['https://a.example.com/mcp'])
    expect(res.tools.map(t => t.qualifiedName)).toEqual(['srv_a_tool_a'])
    expect(res.errors).toEqual({})
  })

  it('a second session reuses the connections and does NOT re-list tools', async () => {
    const m = new McpClientManager()
    await m.ensureTools([server('a'), server('b')])
    toolsCalls.length = 0
    // Reason: this is the regression the fix targets — a new session used to
    // force one tools/list round trip per server even though nothing changed.
    const res = await m.ensureTools([server('a'), server('b')])
    expect(toolsCalls).toEqual([])
    expect(closeCalls).toEqual([])
    expect(res.tools).toHaveLength(2)
  })

  it('a url edit reconnects and re-lists (same id, different server)', async () => {
    const m = new McpClientManager()
    await m.ensureTools([server('a')])
    toolsCalls.length = 0
    await m.ensureTools([server('a', { url: 'https://moved.example.com/mcp' })])
    expect(closeCalls).toEqual(['https://a.example.com/mcp'])
    expect(toolsCalls).toEqual(['https://moved.example.com/mcp'])
  })

  it('a rename re-lists too (qualified tool names carry the server name)', async () => {
    const m = new McpClientManager()
    await m.ensureTools([server('a')])
    toolsCalls.length = 0
    const res = await m.ensureTools([server('a', { name: 'renamed' })])
    expect(toolsCalls).toHaveLength(1)
    expect(res.tools.map(t => t.qualifiedName)).toEqual(['renamed_tool_a'])
  })

  it('an empty server list drops the connections once', async () => {
    const m = new McpClientManager()
    await m.ensureTools([server('a')])
    closeCalls.length = 0
    const res = await m.ensureTools([])
    expect(closeCalls).toEqual(['https://a.example.com/mcp'])
    expect(res.tools).toEqual([])
    closeCalls.length = 0
    await m.ensureTools([])
    expect(closeCalls).toEqual([])
  })

  it('retries only the server that failed, without reconnecting the healthy one', async () => {
    const m = new McpClientManager()
    let failFirst = true
    connectImpl = async (url) => {
      if (url.includes('b.example') && failFirst) throw new Error('boom')
    }
    const first = await m.ensureTools([server('a'), server('b')])
    expect(Object.keys(first.errors)).toEqual(['b'])
    expect(first.tools.map(t => t.qualifiedName)).toEqual(['srv_a_tool_a'])
    expect(closeCalls).toEqual([])

    failFirst = false
    toolsCalls.length = 0
    const second = await m.ensureTools([server('a'), server('b')])
    expect(second.errors).toEqual({})
    expect(second.tools).toHaveLength(2)
    // Reason: only the missing server is re-listed — and the healthy one is not
    // torn down, so one flaky server cannot cause a reconnect storm.
    expect(toolsCalls).toEqual(['https://b.example.com/mcp'])
    expect(closeCalls).toEqual([])
  })

  it('collapses concurrent callers into one refresh', async () => {
    const m = new McpClientManager()
    const [r1, r2, r3] = await Promise.all([
      m.ensureTools([server('a')]),
      m.ensureTools([server('a')]),
      m.ensureTools([server('a')]),
    ])
    expect(toolsCalls).toEqual(['https://a.example.com/mcp'])
    expect(r1.tools).toHaveLength(1)
    expect(r2.tools).toHaveLength(1)
    expect(r3.tools).toHaveLength(1)
  })

  it('surfaces every server failure in the errors map', async () => {
    const m = new McpClientManager()
    connectImpl = async () => { throw new Error('down') }
    const res = await m.ensureTools([server('a'), server('b')])
    expect(res.errors).toEqual({ a: 'down', b: 'down' })
    expect(res.tools).toEqual([])
  })
})
