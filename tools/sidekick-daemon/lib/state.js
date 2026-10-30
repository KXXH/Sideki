import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './disk.js'

/**
 * Three-state machine: empty → active ↔ paused
 * Persisted in meta.json within the backup directory.
 */

export class StateMachine {
  #backupDir
  #metaPath
  #state = 'empty'    // 'empty' | 'active' | 'paused'
  #backupKey = null
  #lastSyncTs = 0
  #extensionVersion = ''
  #persistTimer = null

  constructor(backupDir) {
    this.#backupDir = backupDir
    this.#metaPath = join(backupDir, 'current', 'meta.json')
    this.#load()
  }

  get state() { return this.#state }
  get backupKey() { return this.#backupKey }
  get lastSyncTs() { return this.#lastSyncTs }
  get extensionVersion() { return this.#extensionVersion }

  #load() {
    try {
      if (!existsSync(this.#metaPath)) return
      const raw = readFileSync(this.#metaPath, 'utf-8')
      const data = JSON.parse(raw)
      this.#state = data.state ?? 'empty'
      this.#backupKey = data.backupKey ?? null
      this.#lastSyncTs = data.lastSyncTs ?? 0
      this.#extensionVersion = data.extensionVersion ?? ''
    } catch {
      // Corrupted meta — treat as empty, will be rebuilt on next pair
      this.#state = 'empty'
      this.#backupKey = null
    }
  }

  #persist() {
    if (this.#persistTimer) { clearTimeout(this.#persistTimer); this.#persistTimer = null }
    const dir = join(this.#backupDir, 'current')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data = {
      state: this.#state,
      backupKey: this.#backupKey,
      lastSyncTs: this.#lastSyncTs,
      extensionVersion: this.#extensionVersion,
    }
    atomicWrite(this.#metaPath, JSON.stringify(data, null, 2))
  }

  /**
   * Handle hello from extension.
   * Returns response type: 'welcome' | 'backup_exists'
   */
  handleHello(backupKey) {
    if (this.#state === 'empty' || this.#state === 'paused') {
      return { type: 'welcome' }
    }
    // state === 'active'
    if (backupKey && backupKey === this.#backupKey) {
      return { type: 'welcome' }
    }
    // Key mismatch or null — a reinstall occurred
    return { type: 'backup_exists' }
  }

  /**
   * Handle discover request — always returns real data status regardless of state.
   */
  handleDiscover(sessionCount, totalSize) {
    if (this.#state === 'empty') {
      return { type: 'discover:response', sessionCount: 0, totalSize: 0, lastModified: 0 }
    }
    return {
      type: 'discover:response',
      sessionCount,
      totalSize,
      lastModified: this.#lastSyncTs,
    }
  }

  /**
   * Pair with a new backup key. Transitions to active.
   */
  pair(backupKey, extensionVersion) {
    this.#state = 'active'
    this.#backupKey = backupKey
    this.#extensionVersion = extensionVersion || this.#extensionVersion
    this.#persist()
    return { type: 'pair:ok' }
  }

  /**
   * Unpair — transitions to paused, data preserved.
   */
  unpair() {
    this.#state = 'paused'
    this.#backupKey = null
    this.#persist()
    return { type: 'unpair:ok' }
  }

  /**
   * Update sync timestamp (called after each successful push).
   */
  touch(extensionVersion) {
    this.#lastSyncTs = Date.now()
    if (extensionVersion) this.#extensionVersion = extensionVersion
    if (!this.#persistTimer) {
      this.#persistTimer = setTimeout(() => {
        this.#persistTimer = null
        this.#persist()
      }, 1000)
    }
  }

  /**
   * Validate that a push is authorized (key matches active state).
   */
  canPush(backupKey) {
    return this.#state === 'active' && backupKey === this.#backupKey
  }

  toJSON() {
    return {
      state: this.#state,
      backupKey: this.#backupKey,
      lastSyncTs: this.#lastSyncTs,
      extensionVersion: this.#extensionVersion,
    }
  }
}
