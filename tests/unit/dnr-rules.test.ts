import { describe, expect, it, vi, beforeEach } from 'vitest'
import { buildIdentityRules, syncRequestIdentity } from '../../src/background/dnr'
import type { ApiConfig, ProviderProfile } from '../../src/shared/types'

const EXT_ID = 'test-extension-id'

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return { id: 'p1', name: 'P', endpoint: '', apiKey: '', model: '', reasoningEffort: '', ...overrides }
}

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    endpoint: '',
    apiKey: '',
    model: '',
    contextWindow: 128000,
    systemPrompt: '',
    reasoningEffort: '',
    securityLevel: 'strict',
    maxToolRounds: 10,
    yoloMode: false,
    devMode: false,
    accentColor: 'indigo',
    fontFamily: 'sans',
    fontSize: 'default',
    activeProfileId: 'p1',
    profiles: [],
    ...overrides,
  }
}

describe('buildIdentityRules', () => {
  it('disabled (or absent) identity yields no rules', () => {
    const c = config({ profiles: [profile({ endpoint: 'https://api.openai.com/v1' })] })
    expect(buildIdentityRules(c, EXT_ID)).toEqual([])
    expect(buildIdentityRules({ ...c, requestIdentity: { enabled: false } }, EXT_ID)).toEqual([])
  })

  it('dedupes endpoints across profiles and the top-level mirror', () => {
    const c = config({
      endpoint: 'https://gw.example.com/v1',
      profiles: [
        profile({ id: 'a', endpoint: 'https://gw.example.com/v1' }),
        profile({ id: 'b', endpoint: 'https://gw.example.com/v1/' }),
        profile({ id: 'c', endpoint: 'https://other.example.com/v1' }),
      ],
      requestIdentity: { enabled: true },
    })
    const rules = buildIdentityRules(c, EXT_ID)
    expect(rules).toHaveLength(2)
    const filters = rules.map(r => r.condition.regexFilter).sort()
    expect(filters).toEqual(['^https://gw\\.example\\.com/v1([/?]|$)', '^https://other\\.example\\.com/v1([/?]|$)'])
  })

  it('escapes regex metacharacters and anchors the path boundary', () => {
    const c = config({
      profiles: [profile({ endpoint: 'https://api.io:8080/v1.x/' })],
      requestIdentity: { enabled: true, userAgent: 'MyClient/1.0' },
    })
    const [rule] = buildIdentityRules(c, EXT_ID)
    expect(rule.condition.regexFilter).toBe('^https://api\\.io:8080/v1\\.x([/?]|$)')
    // The anchored regex must match endpoint subpaths but not prefix siblings.
    const re = new RegExp(rule.condition.regexFilter)
    expect(re.test('https://api.io:8080/v1.x')).toBe(true)
    expect(re.test('https://api.io:8080/v1.x/chat/completions')).toBe(true)
    expect(re.test('https://api.io:8080/v1.x?q=1')).toBe(true)
    expect(re.test('https://api.io:8080/v1.xyz')).toBe(false)
    expect(re.test('https://api.io:8080/v2')).toBe(false)
  })

  it('sets UA when provided, removes it when empty or blank', () => {
    const base = config({
      profiles: [profile({ endpoint: 'https://a.example.com/v1' })],
      requestIdentity: { enabled: true },
    })
    const [set] = buildIdentityRules({ ...base, requestIdentity: { enabled: true, userAgent: 'MyClient/1.0' } }, EXT_ID)
    const ua = set.action.requestHeaders!.find(h => h.header === 'user-agent')
    expect(ua).toMatchObject({ operation: 'set', value: 'MyClient/1.0' })

    const [removed] = buildIdentityRules(base, EXT_ID)
    const ua2 = removed.action.requestHeaders!.find(h => h.header === 'user-agent')
    expect(ua2).toMatchObject({ operation: 'remove' })

    const [blank] = buildIdentityRules({ ...base, requestIdentity: { enabled: true, userAgent: '   ' } }, EXT_ID)
    expect(blank.action.requestHeaders!.find(h => h.header === 'user-agent')).toMatchObject({ operation: 'remove' })
  })

  it('always removes the browser fingerprint headers and scopes to own requests', () => {
    const c = config({
      profiles: [profile({ endpoint: 'https://a.example.com/v1' })],
      requestIdentity: { enabled: true, userAgent: 'MyClient/1.0' },
    })
    const [rule] = buildIdentityRules(c, EXT_ID)
    const ops = rule.action.requestHeaders!.map(h => `${h.header}:${h.operation}`)
    expect(ops).toContain('origin:remove')
    expect(ops).toContain('cookie:remove')
    expect(ops).toContain('sec-fetch-site:remove')
    expect(ops).toContain('sec-fetch-mode:remove')
    expect(ops).toContain('sec-fetch-dest:remove')
    expect(rule.condition.initiatorDomains).toEqual([EXT_ID])
    expect(rule.condition.requestMethods).toEqual(['post'])
    expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest'])
  })

  it('skips unparseable endpoints and stays inside the reserved id segment', () => {
    const c = config({
      profiles: [
        profile({ id: 'a', endpoint: 'not a url' }),
        profile({ id: 'b', endpoint: 'https://ok.example.com/v1' }),
      ],
      requestIdentity: { enabled: true },
    })
    const rules = buildIdentityRules(c, EXT_ID)
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBeGreaterThanOrEqual(8000)
    expect(rules[0].id).toBeLessThan(8100)
  })
})

describe('syncRequestIdentity', () => {
  beforeEach(() => {
    vi.mocked(chrome.declarativeNetRequest.getDynamicRules).mockReset().mockResolvedValue([])
    vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mockReset().mockResolvedValue(undefined)
    vi.mocked(chrome.storage.local.get).mockReset().mockResolvedValue({})
  })

  it('full-replaces: removes stale reserved rules and adds the new set', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      sidekick_config: config({
        profiles: [profile({ endpoint: 'https://a.example.com/v1' })],
        requestIdentity: { enabled: true, userAgent: 'MyClient/1.0' },
      }),
    })
    vi.mocked(chrome.declarativeNetRequest.getDynamicRules).mockResolvedValue([
      { id: 8000, priority: 1, condition: {}, action: { type: 'allow' } },
      { id: 4, priority: 1, condition: {}, action: { type: 'allow' } },
    ])

    await syncRequestIdentity()

    const call = vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mock.calls[0][0]
    // Rule 4 belongs to someone else — only the reserved segment is touched.
    expect(call.removeRuleIds).toEqual([8000])
    expect(call.addRules).toHaveLength(1)
    expect(call.addRules![0].condition.initiatorDomains).toEqual(['test-extension-id'])
  })

  it('disabling the feature clears reserved rules without adding any', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      sidekick_config: config({ requestIdentity: { enabled: false } }),
    })
    vi.mocked(chrome.declarativeNetRequest.getDynamicRules).mockResolvedValue([
      { id: 8001, priority: 1, condition: {}, action: { type: 'allow' } },
    ])

    await syncRequestIdentity()

    const call = vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mock.calls[0][0]
    expect(call.removeRuleIds).toEqual([8001])
    expect(call.addRules).toEqual([])
  })

  it('missing config adds nothing', async () => {
    await syncRequestIdentity()
    const call = vi.mocked(chrome.declarativeNetRequest.updateDynamicRules).mock.calls[0][0]
    expect(call.addRules).toEqual([])
    expect(call.removeRuleIds).toEqual([])
  })
})
