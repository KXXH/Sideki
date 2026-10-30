import { describe, it, expect } from 'vitest'
import { agentFingerprint, mcpServerFingerprint } from '../../src/shared/agent-fingerprint'
import type { ApiConfig, McpServerConfig } from '../../src/shared/types'

const base: ApiConfig = {
  endpoint: 'https://api.example.com/v1',
  model: 'gpt-x',
  apiKey: 'sk-1',
  reasoningEffort: 'medium',
  supportsImages: true,
} as unknown as ApiConfig

const server = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 's1',
  name: 'docs',
  url: 'https://mcp.example.com/mcp',
  auth: { type: 'none' },
  enabled: true,
  ...over,
})

const withMcp = (...servers: McpServerConfig[]): ApiConfig => ({ ...base, mcpServers: servers })

describe('agentFingerprint — provider fields', () => {
  it('changes for every field the agent bakes in', () => {
    const ref = agentFingerprint(base)
    expect(agentFingerprint({ ...base, endpoint: 'https://other/v1' })).not.toBe(ref)
    expect(agentFingerprint({ ...base, model: 'gpt-y' })).not.toBe(ref)
    expect(agentFingerprint({ ...base, apiKey: 'sk-2' })).not.toBe(ref)
    expect(agentFingerprint({ ...base, reasoningEffort: 'high' })).not.toBe(ref)
    expect(agentFingerprint({ ...base, supportsImages: false })).not.toBe(ref)
  })

  it('ignores config the agent does not consume', () => {
    const ref = agentFingerprint(base)
    const ui = { ...base, theme: 'dark', fontSize: 'relaxed', labAutoCompress: false } as unknown as ApiConfig
    expect(agentFingerprint(ui)).toBe(ref)
  })

  it('does not rebuild the agent or its description-enabled tools for tool presentation changes', () => {
    expect(agentFingerprint({ ...base, toolCallDisplay: 'raw' })).toBe(agentFingerprint(base))
    expect(agentFingerprint({ ...base, toolCallDisplay: 'description' })).toBe(agentFingerprint(base))
  })

  it('does not rebuild for a math display toggle; the craton samples it only when otherwise built', () => {
    expect(agentFingerprint({ ...base, labSingleDollarMath: true })).toBe(agentFingerprint(base))
    expect(agentFingerprint({ ...base, labSingleDollarMath: false })).toBe(agentFingerprint(base))
  })

  it('rebuilds for a protocol change while preserving the legacy default', () => {
    expect(agentFingerprint({ ...base, apiProtocol: 'chat-completions' })).toBe(agentFingerprint(base))
    expect(agentFingerprint({ ...base, apiProtocol: 'responses' })).not.toBe(agentFingerprint(base))
  })

  it.each([
    { labBackendCompat: false },
    { maxToolRounds: 40 },
    { systemPrompt: 'Answer briefly' },
    { contextWindow: 200_000 },
    { modelParams: { temperature: 0.2 } },
    { disabledSkills: ['debug'] },
  ])('invalidates captured behavior when settings change: %j', patch => {
    expect(agentFingerprint({ ...base, ...patch })).not.toBe(agentFingerprint(base))
  })

  it('preserves the agent for file and display preferences and equivalent compat defaults', () => {
    expect(agentFingerprint({ ...base, largeFileUploads: false, labImageFs: true, aiPointer: false }))
      .toBe(agentFingerprint(base))
    expect(agentFingerprint({ ...base, labBackendCompat: true })).toBe(agentFingerprint(base))
  })
})

describe('agentFingerprint — MCP servers', () => {
  it('changes when a server is added or removed', () => {
    const none = agentFingerprint(base)
    const one = agentFingerprint(withMcp(server()))
    expect(one).not.toBe(none)
    expect(agentFingerprint(withMcp())).toBe(none)
  })

  it('changes on url, name and auth edits', () => {
    const ref = agentFingerprint(withMcp(server()))
    expect(agentFingerprint(withMcp(server({ url: 'https://mcp.example.com/v2' })))).not.toBe(ref)
    expect(agentFingerprint(withMcp(server({ name: 'renamed' })))).not.toBe(ref)
    expect(agentFingerprint(withMcp(server({ auth: { type: 'oauth' } })))).not.toBe(ref)
  })

  it('changes when a server is toggled off or on', () => {
    const on = agentFingerprint(withMcp(server({ enabled: true })))
    const off = agentFingerprint(withMcp(server({ enabled: false })))
    expect(off).not.toBe(on)
    expect(agentFingerprint(withMcp(server({ enabled: false })))).toBe(off)
  })

  it('ignores edits to a disabled server', () => {
    const ref = agentFingerprint(withMcp(server({ enabled: false })))
    const edited = withMcp(server({ enabled: false, url: 'https://moved.example.com/mcp', name: 'moved' }))
    expect(agentFingerprint(edited)).toBe(ref)
  })

  it('treats a missing server list the same as an empty one', () => {
    expect(agentFingerprint(base)).toBe(agentFingerprint(withMcp()))
  })

  // Reason: pinning the order sensitivity on purpose — the SW keys socket reuse
  // on the same string, so both sides must agree on what a reorder means.
  it('changes when servers are reordered', () => {
    const a = server({ id: 'a', name: 'alpha' })
    const b = server({ id: 'b', name: 'beta' })
    expect(agentFingerprint(withMcp(a, b))).not.toBe(agentFingerprint(withMcp(b, a)))
  })

  it('mcpServerFingerprint agrees with the slice embedded in agentFingerprint', () => {
    const servers = [server(), server({ id: 's2', name: 'b', enabled: false })]
    const fp = agentFingerprint({ ...base, mcpServers: servers })
    expect(fp.endsWith(mcpServerFingerprint(servers))).toBe(true)
    expect(mcpServerFingerprint(servers)).toBe('s1|https://mcp.example.com/mcp|docs|none')
  })
})
