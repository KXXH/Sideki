import { get, set, del, keys } from 'idb-keyval'

const GLOBAL_KEY = 'memory:global'
const NOTES_KEY = 'memory:notes'
const SITE_PREFIX = 'memory:site:'
const UNDO_KEY = 'memory:undo'

export const GLOBAL_LIMIT = 1000
export const SITE_LIMIT = 2000

// --- Line-entry model ---
// Reason: global/site memory is line-based — one compact entry per line.
// Storage text IS the prompt/VFS projection; no separate rendering format.

export function parseMemoryLines(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean)
}

// Reason: entries are single-line by design — newlines inside an entry are
// collapsed so the line-diff and substring-replace semantics stay unambiguous.
export function normalizeEntry(content: string): string {
  return content.replace(/\s*\n\s*/g, ' ').trim()
}

// Reason: memory content is injected into the system prompt every session —
// scan writes for prompt-injection patterns and invisible unicode before they
// become persistent. Best-effort pattern list, hardcoded on the write path.
const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u00AD/, label: 'invisible unicode characters' },
  { re: /ignore\s+(all\s+|any\s+)?(previous|prior|earlier|above)\s+(instructions?|rules?|prompts?)/i, label: 'instruction-override pattern' },
  { re: /disregard\s+(all\s+)?(previous|prior|earlier|your)\s+(instructions?|rules?|prompts?)/i, label: 'instruction-override pattern' },
  { re: /忽略(之前|以上|此前|所有)的?(指令|规则|提示词?)/, label: 'instruction-override pattern' },
]

export function scanMemoryContent(content: string): string | null {
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(content)) return label
  }
  return null
}

type EntryTarget = 'global' | 'site'

async function readEntryStore(target: EntryTarget, hostname?: string): Promise<{ text: string; limit: number }> {
  if (target === 'global') return { text: await getGlobalMemory(), limit: GLOBAL_LIMIT }
  if (!hostname) throw new Error('hostname required for site memory')
  return { text: await getSiteMemory(hostname), limit: SITE_LIMIT }
}

async function writeEntryStore(target: EntryTarget, hostname: string | undefined, lines: string[]): Promise<{ ok: boolean; error?: string }> {
  const text = lines.join('\n')
  if (target === 'global') return setGlobalMemory(text)
  return setSiteMemory(hostname!, text)
}

// Reason: Hermes-style capacity error — return current entries + usage so the
// model can consolidate (replace/remove) and retry instead of giving up.
function capacityError(lines: string[], limit: number, addedLen: number): string {
  const current = lines.join('\n')
  return `Memory at ${current.length}/${limit} chars. Adding this entry (${addedLen} chars) would exceed the limit. Consolidate first: merge overlapping entries with \`replace\` or delete stale ones with \`remove\`, then retry.\nCurrent entries:\n${lines.map(l => `- ${l}`).join('\n')}`
}

export async function addMemoryEntry(target: EntryTarget, hostname: string | undefined, content: string): Promise<{ ok: boolean; error?: string }> {
  const entry = normalizeEntry(content)
  if (!entry) return { ok: false, error: 'Empty entry.' }
  const threat = scanMemoryContent(entry)
  if (threat) return { ok: false, error: `Entry rejected: contains ${threat}.` }
  const { text, limit } = await readEntryStore(target, hostname)
  const lines = parseMemoryLines(text)
  if (entry.length > limit) return { ok: false, error: `Entry too long (${entry.length} chars, store limit ${limit}).` }
  if (lines.includes(entry)) return { ok: true, error: 'Duplicate entry — not added.' }
  const next = [...lines, entry]
  if (next.join('\n').length > limit) return { ok: false, error: capacityError(lines, limit, entry.length) }
  return writeEntryStore(target, hostname, next)
}

// Reason: substring match against entry lines — no ids needed; unique-match
// requirement prevents silently editing the wrong entry.
function matchEntry(lines: string[], oldText: string): { idx: number } | { error: string } {
  const needle = oldText.trim()
  if (!needle) return { error: 'Empty match text.' }
  const hits = lines.map((l, i) => l.includes(needle) ? i : -1).filter(i => i >= 0)
  if (hits.length === 0) return { error: `No entry matches "${needle}".` }
  if (hits.length > 1) return { error: `"${needle}" matches ${hits.length} entries — use a more specific substring.` }
  return { idx: hits[0] }
}

export async function replaceMemoryEntry(target: EntryTarget, hostname: string | undefined, oldText: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const entry = normalizeEntry(content)
  if (!entry) return { ok: false, error: 'Empty replacement entry.' }
  const threat = scanMemoryContent(entry)
  if (threat) return { ok: false, error: `Entry rejected: contains ${threat}.` }
  const { text, limit } = await readEntryStore(target, hostname)
  const lines = parseMemoryLines(text)
  const m = matchEntry(lines, oldText)
  if ('error' in m) return { ok: false, error: m.error }
  const next = [...lines]
  next[m.idx] = entry
  if (next.join('\n').length > limit) return { ok: false, error: capacityError(lines, limit, entry.length) }
  return writeEntryStore(target, hostname, next)
}

export async function removeMemoryEntry(target: EntryTarget, hostname: string | undefined, oldText: string): Promise<{ ok: boolean; error?: string; removed?: string }> {
  const { text } = await readEntryStore(target, hostname)
  const lines = parseMemoryLines(text)
  const m = matchEntry(lines, oldText)
  if ('error' in m) return { ok: false, error: m.error }
  const removed = lines[m.idx]
  const next = lines.filter((_, i) => i !== m.idx)
  const result = await writeEntryStore(target, hostname, next)
  return result.ok ? { ok: true, removed } : result
}

// --- Line editing by position (UI) ---
// Reason: the AI addresses entries by substring (it reasons about content), but a
// human clicking row 3 means "this row". Index addressing avoids the ambiguity
// of substring matching on similar lines. originalText is a compare-and-swap
// guard: the store is re-read at write time, so an AI write landing between
// render and save is reported as stale instead of being silently clobbered.

export type MemoryEditCode = 'empty' | 'rejected' | 'over-limit' | 'stale' | 'duplicate'

export interface MemoryEditResult {
  ok: boolean
  code?: MemoryEditCode
  error?: string
}

function guardLine(lines: string[], index: number, originalText: string): MemoryEditResult | null {
  if (lines[index] !== originalText) {
    return { ok: false, code: 'stale', error: 'Memory changed elsewhere since it was loaded.' }
  }
  return null
}

export async function updateMemoryLine(
  target: EntryTarget,
  hostname: string | undefined,
  index: number,
  originalText: string,
  content: string,
): Promise<MemoryEditResult> {
  const entry = normalizeEntry(content)
  if (!entry) return { ok: false, code: 'empty', error: 'Empty entry.' }
  const threat = scanMemoryContent(entry)
  if (threat) return { ok: false, code: 'rejected', error: `Entry rejected: contains ${threat}.` }
  const { text, limit } = await readEntryStore(target, hostname)
  const lines = parseMemoryLines(text)
  const stale = guardLine(lines, index, originalText)
  if (stale) return stale
  const next = [...lines]
  next[index] = entry
  if (next.join('\n').length > limit) {
    return { ok: false, code: 'over-limit', error: capacityError(lines, limit, entry.length) }
  }
  return writeEntryStore(target, hostname, next)
}

export async function removeMemoryLine(
  target: EntryTarget,
  hostname: string | undefined,
  index: number,
  originalText: string,
): Promise<MemoryEditResult> {
  const { text } = await readEntryStore(target, hostname)
  const lines = parseMemoryLines(text)
  const stale = guardLine(lines, index, originalText)
  if (stale) return stale
  return writeEntryStore(target, hostname, lines.filter((_, i) => i !== index))
}

// Reason: manual adds reuse addMemoryEntry (dedupe + capacity + injection scan
// already live there); this only maps its string error onto a code so the UI can
// localise instead of surfacing model-facing English.
export async function addMemoryLine(
  target: EntryTarget,
  hostname: string | undefined,
  content: string,
): Promise<MemoryEditResult> {
  const entry = normalizeEntry(content)
  if (!entry) return { ok: false, code: 'empty', error: 'Empty entry.' }
  const r = await addMemoryEntry(target, hostname, entry)
  // Reason: addMemoryEntry reports duplicates as ok-with-message, not failure.
  if (r.ok) return r.error ? { ok: true, code: 'duplicate', error: r.error } : r
  const err = r.error ?? ''
  const code: MemoryEditCode = err.includes('contains') ? 'rejected' : 'over-limit'
  return { ok: false, code, error: err }
}

// --- Global Memory ---

export async function getGlobalMemory(): Promise<string> {
  return (await get<string>(GLOBAL_KEY)) ?? ''
}

export async function setGlobalMemory(content: string): Promise<{ ok: boolean; error?: string }> {
  if (content.length > GLOBAL_LIMIT) {
    return { ok: false, error: `Exceeds ${GLOBAL_LIMIT} char limit (current: ${content.length}). Please shorten and retry.` }
  }
  const threat = scanMemoryContent(content)
  if (threat) return { ok: false, error: `Content rejected: contains ${threat}.` }
  await set(GLOBAL_KEY, content)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', 'global', content)
  return { ok: true }
}

// --- Site Memory ---

export async function getSiteMemory(hostname: string): Promise<string> {
  return (await get<string>(SITE_PREFIX + hostname)) ?? ''
}

export async function setSiteMemory(hostname: string, content: string): Promise<{ ok: boolean; error?: string }> {
  if (content.length > SITE_LIMIT) {
    return { ok: false, error: `Exceeds ${SITE_LIMIT} char limit (current: ${content.length}). Please shorten and retry.` }
  }
  const threat = scanMemoryContent(content)
  if (threat) return { ok: false, error: `Content rejected: contains ${threat}.` }
  await set(SITE_PREFIX + hostname, content)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', `site:${hostname}`, content)
  return { ok: true }
}

export async function getAllSiteHostnames(): Promise<string[]> {
  const allKeys = await keys()
  return allKeys
    .filter(k => typeof k === 'string' && k.startsWith(SITE_PREFIX))
    .map(k => (k as string).slice(SITE_PREFIX.length))
}

export async function deleteSiteMemory(hostname: string): Promise<void> {
  await del(SITE_PREFIX + hostname)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', `site:${hostname}`, null)
}

// --- Notes Memory ---

export interface NoteEntry {
  id: string
  content: string
  ts: number
}

export async function getNotes(): Promise<NoteEntry[]> {
  const raw = (await get<string>(NOTES_KEY)) ?? ''
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) as NoteEntry } catch { return null }
  }).filter((e): e is NoteEntry => e !== null)
}

export async function addNote(content: string): Promise<NoteEntry | { error: string }> {
  const threat = scanMemoryContent(content)
  if (threat) return { error: `Content rejected: contains ${threat}.` }
  const entry: NoteEntry = { id: crypto.randomUUID().slice(0, 12), content, ts: Date.now() }
  const raw = (await get<string>(NOTES_KEY)) ?? ''
  const updated = raw ? raw + '\n' + JSON.stringify(entry) : JSON.stringify(entry)
  await set(NOTES_KEY, updated)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', 'notes', updated)
  return entry
}

export async function removeNote(id: string): Promise<boolean> {
  const raw = (await get<string>(NOTES_KEY)) ?? ''
  const lines = raw.split('\n').filter(Boolean)
  const filtered = lines.filter(line => {
    try { return (JSON.parse(line) as NoteEntry).id !== id } catch { return true }
  })
  if (filtered.length === lines.length) return false
  const updated = filtered.join('\n')
  await set(NOTES_KEY, updated)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', 'notes', updated)
  return true
}

// Reason: in-place edit keeps line order and id stable; ts refreshed so
// edited notes surface first in recency-sorted search results.
export async function updateNote(id: string, content: string): Promise<boolean> {
  const raw = (await get<string>(NOTES_KEY)) ?? ''
  const lines = raw.split('\n').filter(Boolean)
  let found = false
  const updatedLines = lines.map(line => {
    try {
      const entry = JSON.parse(line) as NoteEntry
      if (entry.id !== id) return line
      found = true
      return JSON.stringify({ ...entry, content, ts: Date.now() })
    } catch { return line }
  })
  if (!found) return false
  const updated = updatedLines.join('\n')
  await set(NOTES_KEY, updated)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', 'notes', updated)
  return true
}

export async function searchNotes(keyword: string): Promise<NoteEntry[]> {
  const notes = await getNotes()
  const lower = keyword.toLowerCase()
  return notes
    .filter(n => n.content.toLowerCase().includes(lower))
    .sort((a, b) => b.ts - a.ts)
}

// --- Curation (propose in sidepanel, apply here — atomically ordered) ---

// Reason: djb2 over the full memory estate — cheap drift guard so an apply
// never lands on state that differs from what the proposal was generated from.
export async function getMemoryFingerprint(hostname?: string): Promise<string> {
  const global = await getGlobalMemory()
  const site = hostname ? await getSiteMemory(hostname) : ''
  const notesRaw = (await get<string>(NOTES_KEY)) ?? ''
  const input = `${global}\u0000${site}\u0000${notesRaw}`
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export interface CurationApplyPlan {
  hostname?: string
  globalText: string
  siteText?: string
  dropNoteIds: string[]
  fingerprint: string
}

interface UndoSnapshot {
  ts: number
  global: string
  hostname?: string
  site?: string
  notesRaw: string
}

// Reason: write order is the crash-safety invariant — promote (global/site)
// BEFORE evicting notes. Worst case on interruption is redundancy, never loss.
export async function applyCurationPlan(plan: CurationApplyPlan): Promise<{ ok: boolean; error?: string }> {
  const current = await getMemoryFingerprint(plan.hostname)
  if (current !== plan.fingerprint) {
    return { ok: false, error: 'Memory changed since the proposal was generated. Regenerate and review again.' }
  }
  const globalLines = parseMemoryLines(plan.globalText)
  const globalText = globalLines.join('\n')
  if (globalText.length > GLOBAL_LIMIT) return { ok: false, error: `Global memory exceeds ${GLOBAL_LIMIT} chars.` }
  const siteLines = plan.siteText !== undefined ? parseMemoryLines(plan.siteText) : null
  const siteText = siteLines ? siteLines.join('\n') : null
  if (siteText !== null && siteText.length > SITE_LIMIT) return { ok: false, error: `Site memory exceeds ${SITE_LIMIT} chars.` }

  // Single-slot undo: snapshot the full estate before any write
  const notesRaw = (await get<string>(NOTES_KEY)) ?? ''
  const snapshot: UndoSnapshot = {
    ts: Date.now(),
    global: await getGlobalMemory(),
    hostname: plan.hostname,
    site: plan.hostname ? await getSiteMemory(plan.hostname) : undefined,
    notesRaw,
  }
  await set(UNDO_KEY, snapshot)

  // 1. Promote: global, then site
  const g = await setGlobalMemory(globalText)
  if (!g.ok) return { ok: false, error: g.error }
  if (plan.hostname && siteText !== null) {
    if (siteText) {
      const s = await setSiteMemory(plan.hostname, siteText)
      if (!s.ok) return { ok: false, error: s.error }
    } else {
      await deleteSiteMemory(plan.hostname)
    }
  }

  // 2. Evict: single rewrite of the notes key (atomic per-key put)
  if (plan.dropNoteIds.length > 0) {
    const dropSet = new Set(plan.dropNoteIds)
    const kept = notesRaw.split('\n').filter(Boolean).filter(line => {
      try { return !dropSet.has((JSON.parse(line) as NoteEntry).id) } catch { return true }
    })
    const updated = kept.join('\n')
    await set(NOTES_KEY, updated)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__backupNotify?.('memory', 'notes', updated)
  }
  return { ok: true }
}

export async function getCurationUndoTs(): Promise<number | null> {
  const snap = await get<UndoSnapshot>(UNDO_KEY)
  return snap?.ts ?? null
}

export async function undoCuration(): Promise<{ ok: boolean; error?: string }> {
  const snap = await get<UndoSnapshot>(UNDO_KEY)
  if (!snap) return { ok: false, error: 'Nothing to undo.' }
  await set(GLOBAL_KEY, snap.global)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', 'global', snap.global)
  if (snap.hostname !== undefined && snap.site !== undefined) {
    if (snap.site) {
      await set(SITE_PREFIX + snap.hostname, snap.site)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).__backupNotify?.('memory', `site:${snap.hostname}`, snap.site)
    } else {
      await deleteSiteMemory(snap.hostname)
    }
  }
  await set(NOTES_KEY, snap.notesRaw)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__backupNotify?.('memory', 'notes', snap.notesRaw)
  await del(UNDO_KEY)
  return { ok: true }
}

// --- VFS files generation ---

export async function getMemoryFiles(hostname?: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const global = await getGlobalMemory()
  files['/memory/global.md'] = global || '(empty)'
  if (hostname) {
    const site = await getSiteMemory(hostname)
    if (site) files['/memory/site.md'] = site
  }
  const notesRaw = (await get<string>(NOTES_KEY)) ?? ''
  files['/memory/notes.jsonl'] = notesRaw || ''
  return files
}
