import { Bash } from 'just-bash'
import type { IFileSystem, NetworkConfig } from 'just-bash'
import { createPageCommands } from './shell-commands'
import { createChromeCommand } from './chrome-commands'
import { createDebugCommand } from './debug-commands'
import { createMcpCommand } from './mcp-commands'
import { loadShellFs, saveShellFs, deleteShellFs, MAX_SESSION_SIZE_CHAT, MAX_SESSION_SIZE_PRO } from '../shared/shell-storage'
import { loadConfig, loadSessionIndex } from '../shared/storage'
import { getSkillFiles, isUserSkillDir, skillDirStatus, validateUserSkillsFromVfs, persistUserSkillChanges } from '../shared/skills'
import { getMemoryFiles } from '../shared/memory-storage'
import type { FsSnapshot } from '../shared/shell-storage'
import type { ExecutionApproval } from '../shared/approval-types'
import { VFS_UPLOAD_MAX_BYTES } from '../shared/vfs-upload'

const MAX_STDOUT_LINES = 200
const MAX_STDOUT_BYTES = 8192
const EXEC_TIMEOUT_MS = 5000
const MAX_FILE_SIZE = 500 * 1024

const PRO_MAX_STDOUT_LINES = 2000
const PRO_MAX_STDOUT_BYTES = 65536  // 64KB
const PRO_EXEC_TIMEOUT_MS = 30000   // 30s
const PRO_MAX_FILE_SIZE = 5 * 1024 * 1024  // 5MB

// Reason: large uploads run up to 32MiB independently of image-copy preferences; the snapshot stores
// latin1 strings that IndexedDB keeps as UTF-16 — 2 bytes per source byte. A
// 64MB session ceiling fits one maxed PDF plus normal working files.
export const LARGE_MAX_FILE_SIZE = VFS_UPLOAD_MAX_BYTES
export const LARGE_MAX_SESSION_SIZE = 64 * 1024 * 1024

interface ShellInstance {
  authorization?: ExecutionApproval
  bash: Bash
  tabId: number
  proMode: boolean
  largeFiles: boolean
  fetchEnabled: boolean
}

const instances = new Map<string, ShellInstance>()
const locks = new Map<string, Promise<unknown>>()
const screenshotContexts = new Map<string, { sessionId: string; fs: Bash['fs']; proMode: boolean }>()

const trackedFilesystems = new WeakMap<IFileSystem, { fs: IFileSystem; revision: number; pending: number }>()
const FS_MUTATIONS = new Set(['writeFile', 'appendFile', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'utimes', 'symlink', 'link'])

function trackFilesystem(source: IFileSystem): IFileSystem {
  const existing = trackedFilesystems.get(source)
  if (existing) return existing.fs
  const state = { fs: source, revision: 0, pending: 0 }
  for (const key of FS_MUTATIONS) {
    const value = Reflect.get(source, key) as (...args: unknown[]) => Promise<unknown>
    Object.defineProperty(source, key, {
      configurable: true,
      value: async (...args: unknown[]) => {
        // Reason: invalidate before and after asynchronous mutations, including rollback.
        state.revision++
        state.pending++
        try { return await value.apply(source, args) }
        finally { state.pending--; state.revision++ }
      },
    })
  }
  trackedFilesystems.set(source, state)
  return source
}

// Reason: upload capacity only changes storage-shaped limits. Execution time
// and stdout truncation remain mode-specific, independent of image mirroring.
function fsLimits(proMode: boolean, largeFiles: boolean): { maxFile: number; maxSession: number } {
  if (largeFiles) return { maxFile: LARGE_MAX_FILE_SIZE, maxSession: LARGE_MAX_SESSION_SIZE }
  return {
    maxFile: proMode ? PRO_MAX_FILE_SIZE : MAX_FILE_SIZE,
    maxSession: proMode ? MAX_SESSION_SIZE_PRO : MAX_SESSION_SIZE_CHAT,
  }
}

function truncateOutput(output: string, maxBytes = MAX_STDOUT_BYTES, maxLines = MAX_STDOUT_LINES, hint = 'Use head/tail/grep to narrow.'): string {
  if (output.length > maxBytes) {
    return output.slice(0, maxBytes) + `\n\n[Truncated at ${maxBytes} bytes. ${hint}]`
  }
  const lines = output.split('\n')
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n\n[Truncated: showing ${maxLines}/${lines.length} lines. ${hint}]`
  }
  return output
}

// Reason: just-bash writeFile/readFile are TEXT interfaces — a latin1 byte
// string round-trips through them looking intact while the underlying bytes
// get UTF-8 encoded (cat/pipes then see inflated bytes). Binary files must
// go through the byte interfaces, keyed off extension.
const BINARY_EXT = /\.(jpe?g|png|gif|webp|pdf)$/i
export function isBinaryPath(p: string): boolean {
  return BINARY_EXT.test(p)
}

// Reason: readFileBytes is optional on IFileSystem — fall back to
// readFileBuffer (mandatory) and pack to a latin1 byte string.
async function readBytes(fs: Bash['fs'], path: string): Promise<string> {
  if (fs.readFileBytes) return await fs.readFileBytes(path) as unknown as string
  const buf = await fs.readFileBuffer(path)
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
  return s
}

function latin1ToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}

// Reason: snapshots store binary entries as latin1 byte strings (IndexedDB-
// friendly). Feeding them back to `new Bash({ files })` as plain strings would
// re-encode them as UTF-8 text — convert to Uint8Array at the boundary.
function hydrateFiles(snap: FsSnapshot): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = {}
  for (const [p, v] of Object.entries(snap)) {
    out[p] = isBinaryPath(p) ? latin1ToBytes(v) : v
  }
  return out
}

async function snapshotFs(fs: Bash['fs']): Promise<FsSnapshot> {
  const snapshot: FsSnapshot = {}
  for (const p of fs.getAllPaths()) {
    if (isReadonlyPath(p)) continue
    const stat = await fs.stat(p)
    if (stat.isFile) snapshot[p] = isBinaryPath(p) ? await readBytes(fs, p) : await fs.readFile(p)
  }
  return snapshot
}

async function writeFsFile(fs: Bash['fs'], path: string, content: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/'))
  if (parent) await fs.mkdir(parent, { recursive: true })
  await fs.writeFile(path, content, isBinaryPath(path) ? 'latin1' : 'utf8')
}

async function restoreSnapshot(fs: Bash['fs'], before: FsSnapshot): Promise<void> {
  const after = await snapshotFs(fs)
  for (const path of Object.keys(after)) {
    if (!(path in before)) await fs.rm(path)
  }
  for (const [path, content] of Object.entries(before)) {
    if (after[path] !== content) await writeFsFile(fs, path, content)
  }
}

async function commitSnapshot(sessionId: string, before: FsSnapshot, after: FsSnapshot, proMode: boolean, persist = true): Promise<void> {
  const cfg = await loadConfig()
  const { maxFile, maxSession } = fsLimits(proMode, cfg?.largeFileUploads !== false)
  let retainedSize = 0
  for (const [path, content] of Object.entries(after)) {
    if (content.length <= maxFile) continue
    if (before[path] !== content) throw new Error(`Shell file ${path} exceeds ${maxFile / 1024}KB limit`)
    retainedSize += content.length
  }
  // Reason: unchanged oversized files keep their bytes, not a transferable higher-tier allowance for new writes.
  const previousOrdinarySize = Object.values(before).reduce((sum, content) => sum + (content.length <= maxFile ? content.length : 0), 0)
  const maxSize = retainedSize + Math.max(maxSession, previousOrdinarySize)
  const size = Object.values(after).reduce((sum, content) => sum + content.length, 0)
  if (size > maxSize) throw new Error(`Shell filesystem exceeds ${maxSession / 1024}KB limit for new writes`)
  if (persist) await saveShellFs(sessionId, after, maxSize)
}

async function mutateLiveFs<T>(sessionId: string, fs: Bash['fs'], proMode: boolean, fn: (fs: Bash['fs']) => Promise<T>, persist = true): Promise<T> {
  const before = await snapshotFs(fs)
  try {
    const result = await fn(fs)
    await commitSnapshot(sessionId, before, await snapshotFs(fs), proMode, persist)
    return result
  } catch (e) {
    await restoreSnapshot(fs, before)
    throw e
  }
}

async function coldSessionIsPro(sessionId: string): Promise<boolean> {
  return (await loadSessionIndex()).find(session => session.id === sessionId)?.mode === 'pro'
}

async function readonlyFilesForTab(tabId: number, proMode: boolean): Promise<Record<string, string>> {
  let hostname = ''
  try { const tab = await chrome.tabs.get(tabId); hostname = tab.url ? new URL(tab.url).hostname : '' } catch { /* ignore */ }
  return { ...getSkillFiles(proMode ? 'pro' : 'chat'), ...await getMemoryFiles(hostname) }
}

function makeBash(sessionId: string, tabId: number, proMode: boolean, cfg: Awaited<ReturnType<typeof loadConfig>>, source: { fs: Bash['fs'] } | { files: Record<string, string | Uint8Array> }): Bash {
  const getAuthorization = () => instances.get(sessionId)?.authorization
  const currentMode = proMode ? 'pro' : 'chat'
  const { maxFile } = fsLimits(proMode, cfg?.largeFileUploads !== false)
  const network: NetworkConfig | undefined = cfg?.labFetch
    ? { dangerouslyAllowFullInternetAccess: true, allowedMethods: ['GET', 'HEAD'], denyPrivateRanges: false, maxResponseSize: 512 * 1024, timeoutMs: 10000 }
    : undefined
  const onMemoryUpdate = (path: string, content: string) => {
    if (path.startsWith('/memory/')) void bash.fs.writeFile(path, content)
  }
  const commands = createPageCommands(tabId, currentMode, onMemoryUpdate, sessionId, getAuthorization).map(command => {
    if (command.name !== 'screenshot') return command
    return {
      ...command,
      execute: async (...args: Parameters<typeof command.execute>) => {
        // Reason: only this scoped callback may stage a screenshot inside exec's existing lock and commit.
        const token = `shell-screenshot:${crypto.randomUUID()}`
        screenshotContexts.set(token, { sessionId, fs: args[1].fs, proMode })
        try {
          const scoped = createPageCommands(tabId, currentMode, onMemoryUpdate, token, getAuthorization).find(c => c.name === 'screenshot')!
          return await scoped.execute(...args)
        } finally {
          screenshotContexts.delete(token)
        }
      },
    }
  })
  const bash = new Bash({
    ...source,
    customCommands: [...commands, createChromeCommand(tabId, sessionId, getAuthorization), createMcpCommand(tabId, getAuthorization), ...(proMode ? [createDebugCommand()] : [])],
    cwd: '/',
    executionLimits: {
      maxCommandCount: proMode ? 5000 : 500,
      maxLoopIterations: proMode ? 10000 : 1000,
      maxOutputSize: maxFile,
    },
    network,
  })
  // Reason: Bash must initialize its command paths before tracking the live filesystem.
  trackFilesystem(bash.fs)
  return bash
}

async function createInstanceUnlocked(sessionId: string, tabId: number, proMode: boolean): Promise<ShellInstance> {
  const existing = instances.get(sessionId)
  if (existing) return existing
  const saved = await loadShellFs(sessionId)
  const baseFiles: Record<string, string> = {
    '/page/.keep': '', '/tmp/.keep': '', '/notes/.keep': '', '/context/.keep': '', '/viz/.keep': '', '/todo.json': '[]',
    ...(proMode ? { '/debug/.keep': '', '/debug/reports/.keep': '' } : {}),
  }
  const readonlyFiles = await readonlyFilesForTab(tabId, proMode)
  const cfg = await loadConfig()
  const bash = makeBash(sessionId, tabId, proMode, cfg, { files: { ...hydrateFiles(saved ?? baseFiles), ...readonlyFiles } })
  const instance = { bash, tabId, proMode, largeFiles: cfg?.largeFileUploads !== false, fetchEnabled: !!cfg?.labFetch }
  instances.set(sessionId, instance)
  return instance
}

export async function createInstance(sessionId: string, tabId: number, proMode = false): Promise<ShellInstance> {
  return withSessionLock(sessionId, () => createInstanceUnlocked(sessionId, tabId, proMode))
}

export async function captureShellReadView(sessionId: string, tabId: number): Promise<{ fs: IFileSystem; isCurrent(): boolean }> {
  return withSessionLock(sessionId, async () => {
    const instance = await createInstanceUnlocked(sessionId, tabId, await coldSessionIsPro(sessionId))
    const fs = instance.bash.fs
    const state = trackedFilesystems.get(fs)!
    if (state.pending) throw new Error('审批文件系统正在变更')
    const revision = state.revision
    return {
      fs,
      isCurrent: () => instances.get(sessionId)?.bash.fs === fs && state.pending === 0 && state.revision === revision,
    }
  })
}

// Reason: used by vfs:write for tool result archiving and canvas snapshots.
// Archived messages permanently reference /context/ paths, and canvas files
// must survive session reloads — both are durable: persist immediately, and
// fall back to the IndexedDB snapshot when the in-memory instance is gone
// (service worker restart).
const VFS_WRITE_ALLOWED = ['/context/', '/tmp/', '/viz/']
export async function writeToShellFile(sessionId: string, path: string, content: string): Promise<void> {
  if (!VFS_WRITE_ALLOWED.some(prefix => path.startsWith(prefix))) {
    throw new Error(`Write denied: ${path} is not in an allowed directory`)
  }
  await withSessionLock(sessionId, async () => {
    const instance = instances.get(sessionId)
    const proMode = instance?.proMode ?? await coldSessionIsPro(sessionId)
    const { maxFile } = fsLimits(proMode, (await loadConfig())?.largeFileUploads !== false)
    if (content.length > maxFile) throw new Error(`Shell file ${path} exceeds ${maxFile / 1024}KB limit`)
    if (instance) {
      await mutateLiveFs(sessionId, instance.bash.fs, proMode, fs => writeFsFile(fs, path, content))
    } else {
      const before = await loadShellFs(sessionId) ?? {}
      await commitSnapshot(sessionId, before, { ...before, [path]: content }, proMode)
    }
  })
}

// Reason: labImageFs screenshot mirror. Timestamp filenames sort
// chronologically, so a ring of the newest KEEP_SCREENSHOTS survives —
// screenshots are high-frequency and would otherwise grow unbounded.
export const KEEP_SCREENSHOTS = 5
// Reason: fixed-width suffix keeps same-millisecond captures unique and
// lexicographically ordered (ring pruning relies on name sort).
let screenshotSeq = 0
export async function mirrorScreenshotToVfs(sessionId: string, latin1: string): Promise<string | null> {
  if (latin1.length > PRO_MAX_FILE_SIZE) return null
  const scoped = screenshotContexts.get(sessionId)
  const actualSessionId = scoped?.sessionId ?? sessionId
  const mirror = async () => {
    const dir = '/tmp/screenshots'
    const path = `${dir}/${Date.now()}-${String(screenshotSeq++ % 1000).padStart(3, '0')}.jpeg`
    const instance = instances.get(actualSessionId)
    const fs = scoped?.fs ?? instance?.bash.fs
    const proMode = scoped?.proMode ?? instance?.proMode ?? await coldSessionIsPro(actualSessionId)
    if (fs) {
      await mutateLiveFs(actualSessionId, fs, proMode, async fs => {
        await writeFsFile(fs, path, latin1)
        const names = (await fs.readdir(dir)).filter(n => n.endsWith('.jpeg')).sort()
        for (const stale of names.slice(0, Math.max(0, names.length - KEEP_SCREENSHOTS))) await fs.rm(`${dir}/${stale}`)
      }, !scoped)
    } else {
      const before = await loadShellFs(actualSessionId) ?? {}
      const after = { ...before, [path]: latin1 }
      const shots = Object.keys(after).filter(p => p.startsWith(`${dir}/`) && p.endsWith('.jpeg')).sort()
      for (const stale of shots.slice(0, Math.max(0, shots.length - KEEP_SCREENSHOTS))) delete after[stale]
      await commitSnapshot(actualSessionId, before, after, proMode)
    }
    return path
  }
  try {
    return await (scoped ? mirror() : withSessionLock(sessionId, mirror))
  } catch (e) {
    console.warn('[shell] screenshot mirror failed:', e)
    return null
  }
}


// Reason: the reader's annotation writes must serialize against bash exec on
// the same session — note-store does read-modify-write on the sidecar, and a
// concurrent `pdf note add` would clobber one side. Riding the same per-session
// lock queue as exec gives us that for free.
export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sessionId) ?? Promise.resolve()
  const current = prev.then(fn).catch(e => { throw e })
  const chain = current.then(() => undefined, () => undefined)
  locks.set(sessionId, chain)
  chain.finally(() => { if (locks.get(sessionId) === chain) locks.delete(sessionId) })
  return current
}

export async function execBash(
  sessionId: string,
  tabId: number,
  command: string,
  proMode = false,
  authorization?: ExecutionApproval,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return withSessionLock(sessionId, async () => {
    if (authorization && !authorization.isActive()) throw new Error('调用授权已失效')
    const instance = await createInstanceUnlocked(sessionId, tabId, proMode)
    instance.authorization = authorization
    try { return await execBashInner(sessionId, tabId, command, proMode) }
    finally { instance.authorization = undefined }
  })
    .catch(e => ({ stdout: '', stderr: String(e) + '\n', exitCode: 1 }))
}

async function execBashInner(
  sessionId: string,
  tabId: number,
  command: string,
  proMode = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const instance = await createInstanceUnlocked(sessionId, tabId, proMode)
  const cfg = await loadConfig()
  if (instance.tabId !== tabId || instance.largeFiles !== (cfg?.largeFileUploads !== false) || instance.fetchEnabled !== !!cfg?.labFetch) {
    const fs = instance.bash.fs
    if (instance.tabId !== tabId) {
      const readonlyFiles = await readonlyFilesForTab(tabId, instance.proMode)
      for (const path of fs.getAllPaths()) {
        if (isReadonlyPath(path) && (await fs.stat(path)).isFile) await fs.rm(path)
      }
      for (const [path, content] of Object.entries(readonlyFiles)) await writeFsFile(fs, path, content)
    }
    // Reason: rebind commands and limits on the live FS, never rehydrate stale persisted data over pending changes.
    instance.bash = makeBash(sessionId, tabId, instance.proMode, cfg, { fs })
    instance.tabId = tabId
    instance.largeFiles = cfg?.largeFileUploads !== false
    instance.fetchEnabled = !!cfg?.labFetch
  }

  const timeout = instance.proMode ? PRO_EXEC_TIMEOUT_MS : EXEC_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const result = await mutateLiveFs(sessionId, instance.bash.fs, instance.proMode, async () => {
      try {
        const signal = instance.authorization?.signal
        return await instance.bash.exec(command, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal })
      } finally {
        clearTimeout(timer)
      }
    })

    let skillWarnings = ''
    try {
      skillWarnings = await syncUserSkillChanges(instance.bash)
    } catch { /* validation crash must not affect exec */ }
    await persistSkillFiles(await snapshotFs(instance.bash.fs))

    const maxBytes = instance.proMode ? PRO_MAX_STDOUT_BYTES : MAX_STDOUT_BYTES
    const maxLines = instance.proMode ? PRO_MAX_STDOUT_LINES : MAX_STDOUT_LINES
    // Reason: just-bash surfaces an aborted run as stderr ("bash: execution
    // aborted") instead of throwing, so the catch below never sees it and the
    // model reads something that looks like the user pressed stop. Name the
    // budget here so the timeout is actionable.
    if (controller.signal.aborted) {
      // Reason: earlier commands in the line may have written real diagnostics
      // before the budget ran out, so they are kept — but just-bash's own marker
      // line is dropped, since that is the text being replaced here.
      const prior = result.stderr.split('\n').filter(l => l.trim() !== 'bash: execution aborted').join('\n').trimEnd()
      const kept = prior ? truncateOutput(prior, maxBytes, maxLines) + '\n' : ''
      return {
        stdout: truncateOutput(result.stdout, maxBytes, maxLines),
        stderr: `${kept}${skillWarnings}Command exceeded the ${timeout}ms ${instance.proMode ? 'Pro' : 'Chat'} bash budget and was stopped. The page may still be navigating — retry with a shorter wait, or split the command.\n`,
        exitCode: 124,
      }
    }
    return {
      stdout: truncateOutput(result.stdout, maxBytes, maxLines),
      // Reason: stderr must also be capped to protect the agent context. Skill
      // warnings stay outside the cut so they are never drowned by noisy stderr.
      stderr: truncateOutput(result.stderr, maxBytes, maxLines, 'Rerun with 2> /tmp/err.txt to capture in full.') + skillWarnings,
      exitCode: result.exitCode,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('aborted') || msg.includes('abort')) {
      return { stdout: '', stderr: `Command timed out after ${timeout}ms\n`, exitCode: 124 }
    }
    return { stdout: '', stderr: msg + '\n', exitCode: 1 }
  } finally {
    clearTimeout(timer)
  }
}

async function syncUserSkillChanges(bash: Bash): Promise<string> {
  const vfsPaths = new Map<string, string>()
  for (const p of bash.fs.getAllPaths()) {
    if (!p.startsWith('/skills/')) continue
    const dir = p.split('/')[2]
    if (!dir || !isUserSkillDir(dir)) continue
    try {
      const stat = await bash.fs.stat(p)
      if (stat.isFile) vfsPaths.set(p, await bash.fs.readFile(p))
    } catch { /* skip */ }
  }
  if (vfsPaths.size === 0) return ''
  const { warnings } = validateUserSkillsFromVfs(vfsPaths)
  return warnings.length > 0 ? warnings.join('\n') + '\n' : ''
}

async function persistSkillFiles(snapshot: FsSnapshot): Promise<void> {
  const vfsPaths = new Map<string, string>()
  for (const [path, content] of Object.entries(snapshot)) {
    if (path.startsWith('/skills/')) vfsPaths.set(path, content)
  }
  if (vfsPaths.size === 0) return
  const { changed } = validateUserSkillsFromVfs(vfsPaths)
  await persistUserSkillChanges(changed)
}

function isReadonlyPath(p: string): boolean {
  if (p.startsWith('/memory/')) return true
  if (p.startsWith('/skills/')) {
    const dir = p.split('/')[2]
    return !dir || !isUserSkillDir(dir)
  }
  return false
}

function classifyFileInfo(p: string, size: number): FileInfo {
  if (p.startsWith('/memory/')) return { size, readonly: true }
  if (p.startsWith('/skills/')) {
    const dir = p.split('/')[2]
    if (!dir) return { size, readonly: true }
    const status = skillDirStatus(dir)
    if (status === 'builtin') return { size, readonly: true }
    if (status === 'unregistered') return { size, ephemeral: true }
  }
  return size
}

export type FileInfo = number | { size: number; readonly?: true; ephemeral?: true }

export async function listShellFiles(sessionId: string): Promise<Record<string, FileInfo> | null> {
  const instance = instances.get(sessionId)
  if (instance) {
    const paths = instance.bash.fs.getAllPaths()
    const result: Record<string, FileInfo> = {}
    for (const p of paths) {
      try {
        const stat = await instance.bash.fs.stat(p)
        if (stat.isFile) {
          const content = await instance.bash.fs.readFile(p)
          result[p] = classifyFileInfo(p, content.length)
        }
      } catch { /* skip unreadable */ }
    }
    return result
  }
  // Reason: instance may not be in memory (service worker restarted),
  // fall back to persisted IndexedDB snapshot + readonly files
  const saved = await loadShellFs(sessionId)
  if (!saved) return null
  const result: Record<string, FileInfo> = {}
  for (const [path, content] of Object.entries(saved)) {
    result[path] = content.length
  }
  const readonlyFiles = { ...getSkillFiles(), ...await getMemoryFiles('') }
  for (const [path, content] of Object.entries(readonlyFiles)) {
    if (!(path in result)) {
      result[path] = { size: content.length, readonly: true }
    }
  }
  return result
}

export async function readShellFile(sessionId: string, path: string): Promise<string | null> {
  const instance = instances.get(sessionId)
  if (instance) {
    try {
      const stat = await instance.bash.fs.stat(path)
      if (!stat.isFile) return null
      // Reason: binary files must come back as raw latin1 bytes — the text
      // readFile would return U+FFFD-mangled content.
      return isBinaryPath(path) ? await readBytes(instance.bash.fs, path) : await instance.bash.fs.readFile(path)
    } catch {
      return null
    }
  }
  const saved = await loadShellFs(sessionId)
  if (saved && path in saved) return saved[path]
  // Reason: readonly files (built-in skills, memory) are not persisted in IndexedDB
  if (isReadonlyPath(path)) {
    const readonlyFiles = { ...getSkillFiles(), ...await getMemoryFiles('') }
    return readonlyFiles[path] ?? null
  }
  return null
}

// Reason: the reader pulls PDF bytes over runtime messaging, which caps a
// message at 64 MiB serialized — a 32MB latin1 PDF rides the edge, so reads
// are chunked. Slicing happens on the latin1 string (1 char = 1 byte), which
// both the live instance and the persisted snapshot hand back.
export const PDF_CHUNK = 8 * 1024 * 1024

export async function readShellFileChunk(
  sessionId: string,
  path: string,
  offset: number,
  length: number,
): Promise<{ chunk: string; size: number } | null> {
  const content = await readShellFile(sessionId, path)
  if (content === null) return null
  return { chunk: content.slice(offset, offset + length), size: content.length }
}

// Reason: anchoring an AI quote needs the same markdown projection the model
// quoted from, which means re-parsing the PDF — and the engine only exists in
// the service worker. readShellFile already falls back to the snapshot, so this
// works with no live instance too.
export async function readShellFileBytes(sessionId: string, path: string): Promise<Uint8Array | null> {
  const content = await readShellFile(sessionId, path)
  if (content === null) return null
  return latin1ToBytes(content)
}

// Reason: callers hold withSessionLock across version checks and mutation; reacquiring it here would deadlock.
export async function mutateShellFs<T>(
  sessionId: string,
  tabId: number,
  proMode: boolean,
  fn: (fs: Bash['fs']) => Promise<T>,
): Promise<T> {
  const instance = await createInstanceUnlocked(sessionId, tabId, proMode)
  return mutateLiveFs(sessionId, instance.bash.fs, proMode, fn)
}

const PREVIEW_ALLOWED = ['/tmp/', '/page/', '/viz/']

export async function readAllShellFiles(sessionId: string): Promise<Record<string, string> | null> {
  const instance = instances.get(sessionId)
  if (instance) {
    const paths = instance.bash.fs.getAllPaths()
    const result: Record<string, string> = {}
    for (const p of paths) {
      if (!PREVIEW_ALLOWED.some(prefix => p.startsWith(prefix))) continue
      try {
        const stat = await instance.bash.fs.stat(p)
        if (stat.isFile) result[p] = isBinaryPath(p) ? await readBytes(instance.bash.fs, p) : await instance.bash.fs.readFile(p)
      } catch { /* skip unreadable */ }
    }
    return result
  }
  const saved = await loadShellFs(sessionId)
  if (!saved) return null
  const result: Record<string, string> = {}
  for (const [path, content] of Object.entries(saved)) {
    if (PREVIEW_ALLOWED.some(prefix => path.startsWith(prefix))) result[path] = content
  }
  return result
}

export async function clearPageDir(sessionId: string): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const instance = instances.get(sessionId)
    if (instance) {
      await mutateLiveFs(sessionId, instance.bash.fs, instance.proMode, async fs => {
        await fs.rm('/page', { recursive: true, force: true })
        await fs.mkdir('/page', { recursive: true })
      })
    } else {
      const before = await loadShellFs(sessionId)
      if (!before) return
      const after = Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith('/page/')))
      await commitSnapshot(sessionId, before, after, await coldSessionIsPro(sessionId))
    }
  })
}

export async function deleteShellInstance(sessionId: string): Promise<void> {
  await withSessionLock(sessionId, async () => {
    await deleteShellFs(sessionId)
    instances.delete(sessionId)
  })
}
