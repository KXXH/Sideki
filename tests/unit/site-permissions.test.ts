import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  siteOriginOf,
  loadSitePermissions,
  grantSitePermission,
  revokeSitePermission,
  isSiteAllowed,
  SITE_ALLOWABLE_TOOLS,
} from '../../src/shared/site-permissions'

// In-memory chrome.storage.local backing store
let store: Record<string, unknown> = {}

beforeEach(() => {
  store = {}
  vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
    const k = key as string
    return k in store ? { [k]: store[k] } : {}
  })
  vi.mocked(chrome.storage.local.set).mockImplementation(async (items) => {
    Object.assign(store, items)
  })
})

describe('siteOriginOf', () => {
  it('returns origin for http/https URLs', () => {
    expect(siteOriginOf('https://github.com/foo/bar?x=1')).toBe('https://github.com')
    expect(siteOriginOf('http://localhost:5174/page')).toBe('http://localhost:5174')
  })

  it('returns null for non-web protocols', () => {
    expect(siteOriginOf('chrome://extensions')).toBeNull()
    expect(siteOriginOf('file:///tmp/a.html')).toBeNull()
    expect(siteOriginOf('chrome-extension://abc/index.html')).toBeNull()
  })

  it('returns null for invalid URLs', () => {
    expect(siteOriginOf('not a url')).toBeNull()
    expect(siteOriginOf('')).toBeNull()
  })
})

describe('grant / revoke / load', () => {
  it('grant writes a snapshot of the allowable toolset', async () => {
    await grantSitePermission('https://github.com')
    const perms = await loadSitePermissions()
    expect(perms['https://github.com']).toBeDefined()
    expect(perms['https://github.com'].allowedTools.sort()).toEqual([...SITE_ALLOWABLE_TOOLS].sort())
    expect(perms['https://github.com'].grantedAt).toBeGreaterThan(0)
  })

  it('revoke removes only the target origin', async () => {
    await grantSitePermission('https://a.com')
    await grantSitePermission('https://b.com')
    await revokeSitePermission('https://a.com')
    const perms = await loadSitePermissions()
    expect(perms['https://a.com']).toBeUndefined()
    expect(perms['https://b.com']).toBeDefined()
  })
})

describe('isSiteAllowed', () => {
  it('allows granted interaction tools on granted origin', async () => {
    await grantSitePermission('https://github.com')
    expect(await isSiteAllowed('https://github.com', 'click')).toBe(true)
    expect(await isSiteAllowed('https://github.com', 'type')).toBe(true)
    expect(await isSiteAllowed('https://github.com', 'navigate')).toBe(true)
  })

  it('denies ungranted origins', async () => {
    await grantSitePermission('https://github.com')
    expect(await isSiteAllowed('https://evil.com', 'click')).toBe(false)
  })

  it('never exempts execution-class tools, even if stored data contains them', async () => {
    // Reason: simulate tampered storage — code boundary must still hold
    store['sitePermissions'] = {
      'https://github.com': { allowedTools: ['js', 'executeJS', 'click'], grantedAt: 1 },
    }
    expect(await isSiteAllowed('https://github.com', 'js')).toBe(false)
    expect(await isSiteAllowed('https://github.com', 'executeJS')).toBe(false)
    expect(await isSiteAllowed('https://github.com', 'click')).toBe(true)
  })

  it('denies tab management tools regardless of grant', async () => {
    await grantSitePermission('https://github.com')
    expect(await isSiteAllowed('https://github.com', 'tab-switch')).toBe(false)
    expect(await isSiteAllowed('https://github.com', 'tab-close')).toBe(false)
  })

  it('does not exempt tools missing from an older grant snapshot', async () => {
    // Reason: grants are snapshots — future tools must re-confirm
    store['sitePermissions'] = {
      'https://github.com': { allowedTools: ['click'], grantedAt: 1 },
    }
    expect(await isSiteAllowed('https://github.com', 'type')).toBe(false)
    expect(await isSiteAllowed('https://github.com', 'click')).toBe(true)
  })

  it('updates lastUsedAt on hit', async () => {
    await grantSitePermission('https://github.com')
    await isSiteAllowed('https://github.com', 'click')
    const perms = await loadSitePermissions()
    expect(perms['https://github.com'].lastUsedAt).toBeGreaterThan(0)
  })
})
