// Site-level consent exemptions ("always allow on this site").
// Storage is an explicit per-origin tool list — auditable, and new tools are
// never silently covered by old grants.
export interface SitePermission {
  allowedTools: string[]
  grantedAt: number
  lastUsedAt?: number
}

export type SitePermissions = Record<string, SitePermission>

const STORAGE_KEY = 'sitePermissions'

// Interaction/navigation tools eligible for site-level exemption.
// Execution class (js/executeJS) and cross-tab tools (tab-*, bookmark-*) are
// deliberately absent: they always require per-action confirmation.
export const SITE_ALLOWABLE_TOOLS = new Set([
  'click', 'hover', 'type', 'select', 'keypress', 'scroll', 'navigate',
])

// Reason: grants only apply to real web origins — chrome://, file:// and
// extension pages never enter the exemption table.
export function siteOriginOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

export async function loadSitePermissions(): Promise<SitePermissions> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return (stored[STORAGE_KEY] ?? {}) as SitePermissions
}

// Writes a snapshot of the current allowable toolset. Tools added in future
// versions are NOT retroactively granted.
export async function grantSitePermission(origin: string): Promise<void> {
  const perms = await loadSitePermissions()
  perms[origin] = {
    allowedTools: [...SITE_ALLOWABLE_TOOLS],
    grantedAt: Date.now(),
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: perms })
}

export async function revokeSitePermission(origin: string): Promise<void> {
  const perms = await loadSitePermissions()
  delete perms[origin]
  await chrome.storage.local.set({ [STORAGE_KEY]: perms })
}

export async function isSiteAllowed(origin: string, tool: string): Promise<boolean> {
  // Reason: hard code boundary — stored data can only narrow permissions,
  // never exempt a tool outside the allowable set (e.g. hand-edited 'js').
  if (!SITE_ALLOWABLE_TOOLS.has(tool)) return false
  const perms = await loadSitePermissions()
  const perm = perms[origin]
  if (!perm?.allowedTools.includes(tool)) return false
  // Reason: audit trail — fire-and-forget, never blocks the consent path
  perm.lastUsedAt = Date.now()
  chrome.storage.local.set({ [STORAGE_KEY]: perms }).catch(() => {})
  return true
}
