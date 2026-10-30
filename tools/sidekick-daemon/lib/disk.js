import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync, cpSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

/**
 * Atomic write: write to temp file then rename.
 * Ensures readers never see partial content.
 */
export function atomicWrite(filePath, content) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`)
  writeFileSync(tmp, content)
  renameSync(tmp, filePath)
}

/**
 * Category-to-path mapping for backup data.
 */
function resolvePath(backupDir, category, key) {
  const base = join(backupDir, 'current')
  switch (category) {
    case 'config':
      return join(base, 'config.json')
    case 'session':
      return join(base, 'sessions', key, 'session.json')
    case 'history':
      return join(base, 'sessions', key, 'history.json')
    case 'shellfs':
      return join(base, 'sessions', key, 'vfs.json')
    case 'memory': {
      if (key === 'global') return join(base, 'memory', 'global.md')
      if (key === 'notes') return join(base, 'memory', 'notes.jsonl')
      // site memory: key is "site:{hostname}" from IndexedDB or just hostname
      const hostname = key.startsWith('site:') ? key.slice('site:'.length) : key
      return join(base, 'memory', 'sites', `${hostname}.md`)
    }
    case 'userSkills':
      return join(base, 'user-skills.json')
    case 'customActions':
      return join(base, 'custom-actions.json')
    case 'mcpAuth':
      return join(base, 'mcp-auth', `${key}.json`)
    default:
      return join(base, 'misc', `${category}-${key}.json`)
  }
}

/**
 * Write a push payload to disk.
 */
export function writePush(backupDir, category, key, data) {
  const filePath = resolvePath(backupDir, category, key)
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  atomicWrite(filePath, content)
}

/**
 * Delete a non-session push payload from disk.
 */
export function deletePush(backupDir, category, key) {
  const filePath = resolvePath(backupDir, category, key)
  if (existsSync(filePath)) rmSync(filePath)
}

/**
 * Archive a deleted session (move to archived/ instead of physical delete).
 */
export function archiveSession(backupDir, sessionId) {
  const src = join(backupDir, 'current', 'sessions', sessionId)
  if (!existsSync(src)) return false
  const dest = join(backupDir, 'current', 'archived', sessionId)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  rmSync(src, { recursive: true })
  return true
}

/**
 * Create a daily snapshot using APFS CoW clone (falls back to regular copy).
 */
export function createDailySnapshot(backupDir) {
  const today = new Date().toISOString().slice(0, 10)
  const snapshotDir = join(backupDir, 'snapshots', today)
  if (existsSync(snapshotDir)) return false // already done today

  const src = join(backupDir, 'current')
  if (!existsSync(src)) return false

  mkdirSync(dirname(snapshotDir), { recursive: true })
  try {
    // COPYFILE_FICLONE = 0x04 — uses CoW on APFS, zero extra disk
    cpSync(src, snapshotDir, { recursive: true, mode: 0x04 })
  } catch {
    // Fallback: regular recursive copy (non-APFS systems)
    cpSync(src, snapshotDir, { recursive: true })
  }
  return true
}

/**
 * Remove snapshots older than retentionDays.
 */
export function pruneSnapshots(backupDir, retentionDays = 3) {
  const snapshotsDir = join(backupDir, 'snapshots')
  if (!existsSync(snapshotsDir)) return

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const name of readdirSync(snapshotsDir)) {
    const ts = new Date(name).getTime()
    if (isNaN(ts) || ts >= cutoff) continue
    rmSync(join(snapshotsDir, name), { recursive: true, force: true })
  }
}

/**
 * Prune archived sessions older than retentionDays.
 */
export function pruneArchived(backupDir, retentionDays = 30) {
  const archivedDir = join(backupDir, 'current', 'archived')
  if (!existsSync(archivedDir)) return

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const name of readdirSync(archivedDir)) {
    const dir = join(archivedDir, name)
    try {
      const stat = statSync(dir)
      if (stat.mtimeMs < cutoff) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* skip */ }
  }
}

/**
 * Get summary of current backup: session count and total size.
 */
export function getBackupStats(backupDir) {
  const sessionsDir = join(backupDir, 'current', 'sessions')
  if (!existsSync(sessionsDir)) return { sessionCount: 0, totalSize: 0 }

  let totalSize = 0
  const sessions = readdirSync(sessionsDir)
  for (const id of sessions) {
    const dir = join(sessionsDir, id)
    try {
      const stat = statSync(dir)
      if (!stat.isDirectory()) continue
      for (const file of readdirSync(dir)) {
        totalSize += statSync(join(dir, file)).size
      }
    } catch { /* skip */ }
  }
  return { sessionCount: sessions.length, totalSize }
}

/**
 * Get disk usage of entire backup directory.
 */
export function getDiskUsage(backupDir) {
  if (!existsSync(backupDir)) return 0
  let total = 0
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  try { walk(backupDir) } catch { /* best effort */ }
  return total
}

/**
 * Read all backup data for restore (used by restore:request handler).
 */
export function readAllBackupData(backupDir) {
  const base = join(backupDir, 'current')
  const result = { chromeStorage: {}, indexedDB: {} }

  // Config
  const configPath = join(base, 'config.json')
  if (existsSync(configPath)) {
    try { result.chromeStorage['sidekick_config'] = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  }

  // Sessions
  const sessionsDir = join(base, 'sessions')
  if (existsSync(sessionsDir)) {
    const allSessions = []
    for (const id of readdirSync(sessionsDir)) {
      const sessionPath = join(sessionsDir, id, 'session.json')
      if (!existsSync(sessionPath)) continue
      try {
        allSessions.push(JSON.parse(readFileSync(sessionPath, 'utf-8')))
      } catch { /* skip corrupted */ }

      // History
      const historyPath = join(sessionsDir, id, 'history.json')
      if (existsSync(historyPath)) {
        try { result.chromeStorage[`history:${id}`] = JSON.parse(readFileSync(historyPath, 'utf-8')) } catch {}
      }

      // VFS
      const vfsPath = join(sessionsDir, id, 'vfs.json')
      if (existsSync(vfsPath)) {
        try { result.indexedDB[`shellfs:${id}`] = JSON.parse(readFileSync(vfsPath, 'utf-8')) } catch {}
      }
    }
    result.chromeStorage['sidekick_sessions'] = allSessions
  }

  // Memory
  const memGlobal = join(base, 'memory', 'global.md')
  if (existsSync(memGlobal)) {
    try { result.indexedDB['memory:global'] = readFileSync(memGlobal, 'utf-8') } catch {}
  }
  const memNotes = join(base, 'memory', 'notes.jsonl')
  if (existsSync(memNotes)) {
    try { result.indexedDB['memory:notes'] = readFileSync(memNotes, 'utf-8') } catch {}
  }
  const sitesDir = join(base, 'memory', 'sites')
  if (existsSync(sitesDir)) {
    for (const file of readdirSync(sitesDir)) {
      if (!file.endsWith('.md')) continue
      const hostname = file.slice(0, -3)
      try { result.indexedDB[`memory:site:${hostname}`] = readFileSync(join(sitesDir, file), 'utf-8') } catch {}
    }
  }

  // User skills
  const skillsPath = join(base, 'user-skills.json')
  if (existsSync(skillsPath)) {
    try { result.chromeStorage['userSkills'] = JSON.parse(readFileSync(skillsPath, 'utf-8')) } catch {}
  }

  // Custom actions
  const actionsPath = join(base, 'custom-actions.json')
  if (existsSync(actionsPath)) {
    try { result.chromeStorage['customActions'] = JSON.parse(readFileSync(actionsPath, 'utf-8')) } catch {}
  }

  // MCP auth
  const mcpAuthDir = join(base, 'mcp-auth')
  if (existsSync(mcpAuthDir)) {
    for (const file of readdirSync(mcpAuthDir)) {
      if (!file.endsWith('.json')) continue
      const key = file.slice(0, -5)
      try { result.chromeStorage[key] = JSON.parse(readFileSync(join(mcpAuthDir, file), 'utf-8')) } catch {}
    }
  }

  return result
}

