import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { StateMachine } from './state.js'
import { writePush, deletePush, archiveSession, createDailySnapshot, pruneSnapshots, pruneArchived, getBackupStats, getDiskUsage, readAllBackupData } from './disk.js'
import { log } from './health.js'

const PROTOCOL_VERSION = 1

export function startServer(backupDir, port) {
  const state = new StateMachine(backupDir)
  const startTime = Date.now()
  let snapshotDoneToday = false

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      const stats = getBackupStats(backupDir)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'running',
        state: state.state,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        sessionCount: stats.sessionCount,
        diskUsage: getDiskUsage(backupDir),
        lastSyncTs: state.lastSyncTs,
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/backup' })

  wss.on('connection', (ws) => {
    let authedKey = null
    let didHello = false
    log(`[ws] client connected`)

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }))
        return
      }

      if (msg.type === 'hello') didHello = true
      const response = handleMessage(msg, state, backupDir, authedKey, (key) => { authedKey = key }, didHello)
      if (response) {
        ws.send(JSON.stringify(response))
      }

      // Trigger daily snapshot on first successful push
      if (msg.type === 'push' && !snapshotDoneToday) {
        const created = createDailySnapshot(backupDir)
        if (created) {
          snapshotDoneToday = true
          pruneSnapshots(backupDir, 3)
          pruneArchived(backupDir, 30)
          log('[snapshot] daily snapshot created')
        }
      }
    })

    ws.on('close', () => {
      log(`[ws] client disconnected`)
    })

    ws.on('error', (err) => {
      log(`[ws] error: ${err.message}`)
    })
  })

  // Reset snapshot flag at midnight
  setInterval(() => {
    const hour = new Date().getHours()
    if (hour === 0) snapshotDoneToday = false
  }, 60 * 60 * 1000)

  httpServer.listen(port, '127.0.0.1', () => {
    log(`[server] listening on 127.0.0.1:${port}`)
  })

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`[server] port ${port} already in use — another daemon is running`)
      process.exit(0)
    }
    throw err
  })

  // Graceful shutdown
  const shutdown = () => {
    log('[server] shutting down...')
    wss.clients.forEach(ws => ws.close())
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { httpServer, wss, state }
}

function handleMessage(msg, state, backupDir, authedKey, setAuthedKey, didHello) {
  switch (msg.type) {
    case 'hello': {
      if (msg.protocolVersion && msg.protocolVersion > PROTOCOL_VERSION) {
        return { type: 'error', code: 'PROTOCOL_MISMATCH', message: `daemon supports protocol v${PROTOCOL_VERSION}, extension requires v${msg.protocolVersion}` }
      }
      const result = state.handleHello(msg.backupKey)
      if (result.type === 'welcome' && state.state === 'active' && msg.backupKey === state.backupKey) {
        setAuthedKey(msg.backupKey)
        const stats = getBackupStats(backupDir)
        return {
          ...result,
          protocolVersion: PROTOCOL_VERSION,
          daemonVersion: '0.1.0',
          backupDir,
          knownSessions: buildKnownSessions(backupDir),
        }
      }
      if (result.type === 'backup_exists') {
        const stats = getBackupStats(backupDir)
        return {
          ...result,
          lastModified: state.lastSyncTs,
          sessionCount: stats.sessionCount,
          totalSize: stats.totalSize,
        }
      }
      // empty or paused — welcome with no sessions
      return {
        ...result,
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: '0.1.0',
        backupDir,
        knownSessions: {},
      }
    }

    case 'discover': {
      const stats = getBackupStats(backupDir)
      return state.handleDiscover(stats.sessionCount, stats.totalSize)
    }

    case 'pair': {
      if (!msg.backupKey) return { type: 'error', message: 'backupKey required' }
      if (!didHello) return { type: 'error', message: 'must send hello before pair' }
      setAuthedKey(msg.backupKey)
      return state.pair(msg.backupKey, msg.extensionVersion)
    }

    case 'unpair': {
      setAuthedKey(null)
      return state.unpair()
    }

    case 'restore:request': {
      if (state.state === 'empty') {
        return { type: 'error', message: 'no backup data to restore' }
      }
      log(`[restore] serving full backup data`)
      const data = readAllBackupData(backupDir)
      return { type: 'restore:data', ...data }
    }

    case 'push': {
      if (!state.canPush(authedKey)) {
        log(`[push] rejected: not authorized (key=${authedKey}, category=${msg.category}, key=${msg.key})`)
        return { type: 'ack', category: msg.category, key: msg.key, ok: false, error: 'not authorized' }
      }
      try {
        if (msg.deleted) {
          if (msg.category === 'session') {
            archiveSession(backupDir, msg.key)
          } else {
            deletePush(backupDir, msg.category, msg.key)
          }
        } else {
          writePush(backupDir, msg.category, msg.key, msg.data)
        }
        state.touch(msg.extensionVersion)
        return { type: 'ack', category: msg.category, key: msg.key, ok: true }
      } catch (err) {
        log(`[push] error: ${err.message}`)
        return { type: 'ack', category: msg.category, key: msg.key, ok: false, error: err.message }
      }
    }

    case 'status': {
      const stats = getBackupStats(backupDir)
      return {
        type: 'status:response',
        uptime: Math.floor((Date.now() - (globalThis.__startTime || Date.now())) / 1000),
        diskUsage: getDiskUsage(backupDir),
        sessionCount: stats.sessionCount,
        lastBackupTs: state.lastSyncTs,
      }
    }

    default:
      return { type: 'error', message: `unknown message type: ${msg.type}` }
  }
}

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function buildKnownSessions(backupDir) {
  const sessionsDir = join(backupDir, 'current', 'sessions')
  if (!existsSync(sessionsDir)) return {}

  const result = {}
  for (const id of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, id)
    try {
      const stat = statSync(dir)
      if (!stat.isDirectory()) continue
      const vfsPath = join(dir, 'vfs.json')
      const fsSize = existsSync(vfsPath) ? statSync(vfsPath).size : 0
      result[id] = { ts: Math.floor(stat.mtimeMs), fsSize }
    } catch { /* skip */ }
  }
  return result
}
