#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DAEMON_SCRIPT = resolve(__dirname, 'daemon.js')
const DEFAULT_BACKUP_DIR = resolve(homedir(), '.sidekick-backup')
const DEFAULT_PORT = 9333

const backupDir = process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR
const port = parseInt(process.env.BACKUP_PORT || '', 10) || DEFAULT_PORT
const command = process.argv[2] || ''

async function main() {
  switch (command) {
    case 'install': {
      const { install } = await import('../lib/launchd.js')
      install(DAEMON_SCRIPT, backupDir, port)
      break
    }
    case 'uninstall': {
      const { uninstall } = await import('../lib/launchd.js')
      uninstall()
      break
    }
    case 'start': {
      const { start } = await import('../lib/launchd.js')
      start()
      break
    }
    case 'stop': {
      const { stop } = await import('../lib/launchd.js')
      stop()
      break
    }
    case 'status': {
      await showStatus()
      break
    }
    case 'reset': {
      const { resetCrashLog } = await import('../lib/health.js')
      resetCrashLog(backupDir)
      console.log('Crash counter cleared. Daemon will resume normal operation on next start.')
      break
    }
    case 'export': {
      await exportBackup()
      break
    }
    default: {
      // No command or unknown → run the daemon
      if (command && command !== 'run') {
        console.error(`Unknown command: ${command}`)
        printUsage()
        process.exit(1)
      }
      await runDaemon()
    }
  }
}

async function runDaemon() {
  const { preflight, checkCrashLoop, recordCrash, log, setBackupDir } = await import('../lib/health.js')
  setBackupDir(backupDir)

  // Preflight
  const check = preflight(backupDir)
  if (!check.ok) {
    log(`[preflight] FATAL: ${check.error}`)
    process.exit(0) // exit(0) so launchd doesn't restart
  }

  // Crash loop detection
  const crash = checkCrashLoop(backupDir)
  if (crash.suspended) {
    log(`[health] SUSPENDED: ${crash.reason}`)
    log('[health] Run "node daemon.js reset" to clear and resume.')
    // Stay alive but don't start the server — just respond suspended on WS
    const { startSuspendedServer } = await import('../lib/server.js')
    // Fallback: if no suspended server, just idle
    if (typeof startSuspendedServer === 'function') {
      startSuspendedServer(port, crash.reason)
    } else {
      // Minimal HTTP-only server that reports suspended status
      const { createServer } = await import('node:http')
      createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'suspended', reason: crash.reason }))
      }).listen(port, '127.0.0.1', () => {
        log(`[suspended] listening on 127.0.0.1:${port} (suspended mode)`)
      })
    }
    return
  }

  // Record process exit as crash (cleared on clean shutdown)
  let cleanExit = false
  process.on('exit', () => {
    if (!cleanExit) recordCrash(backupDir)
  })
  process.on('SIGINT', () => { cleanExit = true })
  process.on('SIGTERM', () => { cleanExit = true })

  globalThis.__startTime = Date.now()
  log(`[daemon] starting — backup: ${backupDir}, port: ${port}`)

  const { startServer } = await import('../lib/server.js')
  startServer(backupDir, port)
}

async function showStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    const data = await res.json()
    console.log('Sideki Backup Daemon')
    console.log('─'.repeat(30))
    console.log(`Status:     ${data.status}`)
    console.log(`State:      ${data.state}`)
    console.log(`Uptime:     ${formatDuration(data.uptime)}`)
    console.log(`Sessions:   ${data.sessionCount}`)
    console.log(`Disk usage: ${formatBytes(data.diskUsage)}`)
    if (data.lastSyncTs) {
      console.log(`Last sync:  ${new Date(data.lastSyncTs).toLocaleString()}`)
    }
  } catch {
    console.log('Daemon is not running.')
    if (existsSync(resolve(backupDir, 'crash.log'))) {
      const { checkCrashLoop } = await import('../lib/health.js')
      const crash = checkCrashLoop(backupDir)
      if (crash.suspended) {
        console.log(`⚠ Suspended: ${crash.reason}`)
        console.log('Run "node daemon.js reset" to clear.')
      }
    }
  }
}

async function exportBackup() {
  const { readAllBackupData } = await import('../lib/disk.js')
  const data = readAllBackupData(backupDir)
  const payload = {
    version: 1,
    exportedAt: Date.now(),
    extensionVersion: '',
    chromeStorage: data.chromeStorage,
    indexedDB: data.indexedDB,
  }
  // Gzip to stdout
  const { createGzip } = await import('node:zlib')
  const gzip = createGzip()
  gzip.pipe(process.stdout)
  gzip.end(JSON.stringify(payload))
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function printUsage() {
  console.log(`
Usage: node daemon.js [command]

Commands:
  (none)      Start daemon in foreground
  install     Install as launchd service (auto-start + crash recovery)
  uninstall   Remove launchd service
  start       Start via launchctl
  stop        Stop via launchctl
  status      Show daemon status
  reset       Clear crash counter, resume from suspended mode
  export      Export backup as gzip JSON to stdout

Environment:
  BACKUP_DIR  Backup directory (default: ~/.sidekick-backup)
  BACKUP_PORT Port number (default: 9333)
`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
