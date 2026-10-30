import { loadConfig } from '../shared/storage'
import type { ApiConfig } from '../shared/types'

// Reason: reserved dynamic-rule id segment — sync always full-replaces within
// this range, so it stays idempotent and can never touch rules owned elsewhere.
const RULE_ID_BASE = 8000
const RULE_ID_LIMIT = 100

// Reason: probe-verified header set. Chromium forbids overriding User-Agent in
// fetch (crbug 571722) but declarativeNetRequest modifyHeaders applies to the
// extension's own requests from the service worker, extension pages and the
// offscreen document alike. Origin and Sec-Fetch-* are the other headers that
// mark a request as browser-issued; removing them keeps responses readable and
// triggers no preflight because host-permission fetches skip CORS entirely.
// Reason: cookie — host-permission fetches attach the browser cookie jar for the
// target host regardless of the fetch credentials mode (CORS-exempt channel),
// so ambient browser credentials leak into LLM requests unless stripped here.
function identityHeaders(ua: string | undefined): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  const trimmed = ua?.trim()
  const userAgent: chrome.declarativeNetRequest.ModifyHeaderInfo = trimmed
    ? { header: 'user-agent', operation: 'set', value: trimmed }
    : { header: 'user-agent', operation: 'remove' }
  return [
    userAgent,
    { header: 'origin', operation: 'remove' },
    { header: 'cookie', operation: 'remove' },
    { header: 'sec-fetch-site', operation: 'remove' },
    { header: 'sec-fetch-mode', operation: 'remove' },
    { header: 'sec-fetch-dest', operation: 'remove' },
  ]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Reason: one rule per unique endpoint across ALL profiles — the identity is a
// property of the client, not of one profile. The regex anchors the path exactly
// as entered (`/v1` matches itself and `/v1/...` but not `/v1x`); a urlFilter
// with the same intent would over-match, verified against a live echo server.
export function buildIdentityRules(config: ApiConfig, extensionId: string): chrome.declarativeNetRequest.Rule[] {
  const identity = config.requestIdentity
  if (!identity?.enabled) return []
  const endpoints = new Set<string>()
  for (const p of config.profiles ?? []) {
    const normalized = p.endpoint.trim().replace(/\/+$/, '')
    if (normalized) endpoints.add(normalized)
  }
  const mirror = config.endpoint.trim().replace(/\/+$/, '')
  if (mirror) endpoints.add(mirror)

  const headers = identityHeaders(identity.userAgent)
  const rules: chrome.declarativeNetRequest.Rule[] = []
  for (const endpoint of endpoints) {
    try {
      new URL(endpoint)
    } catch {
      // An unparseable endpoint yields no working LLM requests anyway — skip it
      // rather than registering a rule that can never match.
      continue
    }
    if (rules.length >= RULE_ID_LIMIT) break
    rules.push({
      id: RULE_ID_BASE + rules.length,
      priority: 1,
      condition: {
        regexFilter: `^${escapeRegex(endpoint)}([/?]|$)`,
        initiatorDomains: [extensionId],
        requestMethods: ['post'],
        resourceTypes: ['xmlhttprequest'],
      },
      action: { type: 'modifyHeaders', requestHeaders: headers },
    })
  }
  return rules
}

export async function syncRequestIdentity(): Promise<void> {
  const config = await loadConfig()
  const rules = config ? buildIdentityRules(config, chrome.runtime.id) : []
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  const stale = existing
    .filter(r => r.id >= RULE_ID_BASE && r.id < RULE_ID_BASE + RULE_ID_LIMIT)
    .map(r => r.id)
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale, addRules: rules })
}
