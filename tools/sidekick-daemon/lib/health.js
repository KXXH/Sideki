import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const CRASH_WINDOW_MS = 5 * 60 * 1000
const CRASH_THRESHOLD = 3

/**
 * Log a message with timestamp to daemon.log and stdout.
 */
export function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  try {
    const logPath = join(getBackupDir(), 'daemon.log')
    appendFileSync(logPath, line + '\n')
  } catch { /* best effort */ }
}

let _backupDir = ''
export function setBackupDir(dir) { _backupDir = dir }
export function getBackupDir() { return _backupDir }

/**
 * Preflight checks before starting the daemon.
 * Returns { ok: boolean, error?: string }
 */
export function preflight(backupDir) {
  // 1. Backup directory writable
  try {
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    accessSync(backupDir, constants.W_OK)
  } catch (e) {
    return { ok: false, error: `Backup directory not writable: ${e.message}` }
  }

  // 2. Disk space > 100MB
  try {
    const output = execSync(`df -k "${backupDir}"`, { encoding: 'utf-8' })
    const lines = output.trim().split('\n')
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/)
      const availKB = parseInt(parts[3], 10)
      if (availKB < 100 * 1024) {
        return { ok: false, error: `Insufficient disk space: ${Math.floor(availKB / 1024)}MB available (need 100MB+)` }
      }
    }
  } catch { /* skip check if df fails */ }

  // 3. meta.json parseable (if exists)
  const metaPath = join(backupDir, 'current', 'meta.json')
  if (existsSync(metaPath)) {
    try {
      JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      // Corrupted but recoverable — StateMachine handles this by treating as empty
      log('[preflight] meta.json corrupted, will be rebuilt on next pair')
    }
  }

  return { ok: true }
}

/**
 * Check crash loop: if 3+ crashes in 5 minutes, enter suspended mode.
 * Returns { suspended: boolean, reason?: string }
 */
export function checkCrashLoop(backupDir) {
  const crashPath = join(backupDir, 'crash.log')
  if (!existsSync(crashPath)) return { suspended: false }

  try {
    const raw = readFileSync(crashPath, 'utf-8').trim()
    if (!raw) return { suspended: false }
    const timestamps = raw.split('\n').map(Number).filter(t => !isNaN(t))
    const now = Date.now()
    const recent = timestamps.filter(t => now - t < CRASH_WINDOW_MS)
    if (recent.length >= CRASH_THRESHOLD) {
      return { suspended: true, reason: `${recent.length} crashes in last 5 minutes` }
    }
  } catch { /* file read error — not suspended */ }

  return { suspended: false }
}

/**
 * Record a crash timestamp.
 */
export function recordCrash(backupDir) {
  const crashPath = join(backupDir, 'crash.log')
  try {
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
    appendFileSync(crashPath, Date.now() + '\n')
  } catch { /* best effort */ }
}

/**
 * Clear crash log (used by `daemon.js reset`).
 */
export function resetCrashLog(backupDir) {
  const crashPath = join(backupDir, 'crash.log')
  try {
    writeFileSync(crashPath, '')
  } catch { /* ignore */ }
}
