import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get, set } from 'idb-keyval'

const storage = vi.hoisted(() => ({
  db: new Map<string, unknown>(),
  beforeSet: undefined as undefined | ((key: string) => Promise<void>),
}))

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => structuredClone(storage.db.get(key))),
  set: vi.fn(async (key: string, value: unknown) => {
    const copy = structuredClone(value)
    await storage.beforeSet?.(key)
    storage.db.set(key, copy)
  }),
  del: vi.fn(async (key: string) => { storage.db.delete(key) }),
  keys: vi.fn(async () => [...storage.db.keys()]),
}))

vi.mock('../../src/background/tool-handlers', () => ({
  handleDomSnapshot: vi.fn().mockResolvedValue({ success: true, snapshot: '<div/>' }),
  handleClick: vi.fn().mockResolvedValue({ success: true, text: 'ok' }),
  handleExecuteJS: vi.fn().mockResolvedValue({ success: true, result: '' }),
  handleGetPageContent: vi.fn().mockResolvedValue({ success: true, html: '' }),
  handleGetElementInfo: vi.fn().mockResolvedValue({ success: true }),
  handleFindElement: vi.fn().mockResolvedValue({ success: true, output: '', selectors: [], count: 0 }),
  handleType: vi.fn().mockResolvedValue({ success: true }),
  handleScroll: vi.fn().mockResolvedValue({ success: true }),
  handleNavigate: vi.fn().mockResolvedValue({ success: true }),
  handleScreenshot: vi.fn().mockResolvedValue({ success: true, dataUrl: '' }),
  handleWait: vi.fn().mockResolvedValue({ success: true }),
  requireConsent: vi.fn().mockResolvedValue(true),
  execInTab: vi.fn(),
}))

import {
  execBash, withSessionLock, mutateShellFs, deleteShellInstance, createInstance,
  writeToShellFile, readShellFile, mirrorScreenshotToVfs, clearPageDir,
  LARGE_MAX_FILE_SIZE, LARGE_MAX_SESSION_SIZE,
} from '../../src/background/shell'
import { loadShellFs, saveShellFs } from '../../src/shared/shell-storage'
import { appendNote } from '../../src/shared/pdf-note-store'
import { handleScreenshot } from '../../src/background/tool-handlers'

const MiB = 1024 * 1024
const pdf = '%PDF-1.7\n%\x00\x80\xff\n' + 'a'.repeat(MiB)
const input = { author: 'user' as const, page: 1, quote: 'a synthetic quote', color: 'yellow' as const }
let largeFileUploads: boolean | undefined = false
let imageCopies = false
let sessions: { id: string; mode: 'chat' | 'pro' }[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

function pauseNextSave() {
  const started = deferred()
  const release = deferred()
  storage.beforeSet = async key => {
    if (key !== 'shellfs:s1') return
    storage.beforeSet = undefined
    started.resolve()
    await release.promise
  }
  return { started, release }
}

async function restart(sessionId = 's1') {
  const snapshot = await loadShellFs(sessionId)
  await deleteShellInstance(sessionId)
  if (snapshot) await saveShellFs(sessionId, snapshot, LARGE_MAX_SESSION_SIZE)
}

function note(quote = input.quote, sessionId = 's1') {
  return withSessionLock(sessionId, () => mutateShellFs(sessionId, 205, false, fs =>
    appendNote(fs, '/tmp/paper.pdf', { ...input, quote })))
}

beforeEach(async () => {
  storage.beforeSet = undefined
  largeFileUploads = false
  imageCopies = false
  sessions = []
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({
    sidekick_config: { largeFileUploads, labImageFs: imageCopies },
    sidekick_session_index: sessions.map(s => ({ ...s, title: s.id, createdAt: 1, updatedAt: 1, messageCount: 0 })),
  }))
  vi.mocked(get).mockImplementation(async key => structuredClone(storage.db.get(String(key))))
  vi.mocked(handleScreenshot).mockResolvedValue({ success: true, dataUrl: '' })
  await Promise.all(['s1', 's2', 'fresh'].map(deleteShellInstance))
  storage.db.clear()
  vi.clearAllMocks()
})

describe('reader storage durability', () => {
  it('writes through the live instance and persists before returning', async () => {
    await execBash('s1', 1, 'echo boot')
    const saved = await note()
    expect(saved?.id).toMatch(/^n[0-9a-f]{6}$/)
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf.notes.jsonl']).toContain(input.quote)
    const result = await execBash('s1', 1, 'cat /tmp/paper.pdf.notes.jsonl')
    expect(result.stdout).toContain(input.quote)
  })

  it('creates a fresh instance for the first reader mutation', async () => {
    const saved = await note('first write', 'fresh')
    expect(saved?.id).toMatch(/^n[0-9a-f]{6}$/)
    expect((await loadShellFs('fresh'))?.['/tmp/paper.pdf.notes.jsonl']).toContain('first write')
  })

  it('rehydrates persisted files on reader restart and preserves them on tab rebind', async () => {
    await execBash('s1', 1, 'echo kept > /tmp/keeper.txt')
    await restart()
    await note('after restart')
    const result = await execBash('s1', 1, 'cat /tmp/keeper.txt /tmp/paper.pdf.notes.jsonl')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('kept')
    expect(result.stdout).toContain('after restart')
    await restart()
    expect(await readShellFile('s1', '/tmp/keeper.txt')).toBe('kept\n')
    expect(await readShellFile('s1', '/tmp/paper.pdf.notes.jsonl')).toContain('after restart')
  })

  it('serializes concurrent reader read-modify-write operations', async () => {
    await Promise.all(['one', 'two', 'three'].map(quote => note(quote)))
    const lines = (await readShellFile('s1', '/tmp/paper.pdf.notes.jsonl'))!.trim().split('\n')
    expect(lines.map(line => JSON.parse(line).quote)).toEqual(['one', 'two', 'three'])
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf.notes.jsonl']).toBe(lines.join('\n') + '\n')
  })
})

describe('current storage tiers', () => {
  it.each([false, true])('defaults to large uploads regardless of image copies (copies=%s)', async copies => {
    largeFileUploads = undefined
    imageCopies = copies
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    await createInstance('s1', 1)
    imageCopies = !copies
    await writeToShellFile('s1', '/tmp/another.pdf', pdf)
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(pdf)
    expect(await readShellFile('s1', '/tmp/another.pdf')).toBe(pdf)
  })

  it('does not grant large capacity just because image copies are enabled', async () => {
    imageCopies = true
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', pdf)).rejects.toThrow('500KB limit')
    await createInstance('s1', 1)
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', pdf)).rejects.toThrow('500KB limit')
  })

  it('persists a 1MiB PDF after enabling large uploads on an existing chat shell', async () => {
    await createInstance('s1', 1)
    largeFileUploads = true
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(pdf)
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe(pdf)
    await restart()
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(pdf)
    const instance = await createInstance('s1', 1)
    expect(Array.from((await instance.bash.fs.readFileBuffer('/tmp/paper.pdf')).slice(9, 14)))
      .toEqual(Array.from(pdf.slice(9, 14), c => c.charCodeAt(0)))
  })

  it.each([false, true])('retains large PDFs after disabling large uploads and saving a note (restart=%s)', async cold => {
    largeFileUploads = true
    await createInstance('s1', 1)
    const large = pdf + 'b'.repeat(5 * MiB)
    await writeToShellFile('s1', '/tmp/paper.pdf', large)
    if (cold) await restart()
    largeFileUploads = false
    await note('large uploads are off')
    const snapshot = await loadShellFs('s1')
    expect(snapshot?.['/tmp/paper.pdf']).toBe(large)
    expect(snapshot?.['/tmp/paper.pdf.notes.jsonl']).toContain('large uploads are off')
    await restart()
    await createInstance('s1', 1)
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(large)
    expect(await readShellFile('s1', '/tmp/paper.pdf.notes.jsonl')).toContain('large uploads are off')
  })

  it.each([false, true])('rejects new and replacement oversized files without changing old data (live=%s)', async live => {
    if (live) await createInstance('s1', 1)
    await writeToShellFile('s1', '/tmp/paper.pdf', 'old bytes')
    const before = await loadShellFs('s1')
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', pdf)).rejects.toThrow('500KB limit')
    await expect(writeToShellFile('s1', '/tmp/second.pdf', pdf)).rejects.toThrow('500KB limit')
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe('old bytes')
    expect(await readShellFile('s1', '/tmp/second.pdf')).toBeNull()
    expect(await loadShellFs('s1')).toEqual(before)
    await restart()
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe('old bytes')
  })

  it('does not let a live high-tier instance keep granting that tier after large uploads are disabled', async () => {
    largeFileUploads = true
    await createInstance('s1', 1)
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    largeFileUploads = false
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', pdf + 'changed')).rejects.toThrow('500KB limit')
    await expect(writeToShellFile('s1', '/tmp/new.pdf', pdf)).rejects.toThrow('500KB limit')
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(pdf)
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe(pdf)
  })

  it('resolves the real cold session mode instead of always granting the lab tier', async () => {
    sessions = [{ id: 's1', mode: 'pro' }]
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    await expect(writeToShellFile('s2', '/tmp/paper.pdf', pdf)).rejects.toThrow('500KB limit')
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', 'a'.repeat(5 * MiB + 1))).rejects.toThrow('5120KB limit')
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe(pdf)
    expect(await loadShellFs('s2')).toBeNull()
  })

  it.each([false, true])('enforces total session capacity transactionally (live=%s)', async live => {
    if (live) await createInstance('s1', 1)
    await writeToShellFile('s1', '/tmp/target.txt', 'old')
    for (let i = 0; i < 4; i++) await writeToShellFile('s1', `/tmp/filler-${i}.txt`, 'a'.repeat(500 * 1024))
    const before = await loadShellFs('s1')
    await expect(writeToShellFile('s1', '/tmp/target.txt', 'b'.repeat(100 * 1024))).rejects.toThrow('2048KB limit')
    expect(await readShellFile('s1', '/tmp/target.txt')).toBe('old')
    expect(await loadShellFs('s1')).toEqual(before)
  })

  it('does not transfer a grandfathered PDF allowance to ordinary new files', async () => {
    largeFileUploads = true
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf + 'a'.repeat(5 * MiB))
    largeFileUploads = false
    await note()
    for (let i = 0; i < 4; i++) await writeToShellFile('s1', `/tmp/filler-${i}.txt`, 'a'.repeat(500 * 1024))
    const before = await loadShellFs('s1')
    await expect(writeToShellFile('s1', '/tmp/extra.txt', 'b'.repeat(100 * 1024))).rejects.toThrow('2048KB limit')
    await expect(withSessionLock('s1', () => mutateShellFs('s1', 1, false, async fs => {
      await fs.rm('/tmp/paper.pdf')
      await fs.writeFile('/tmp/extra.txt', 'b'.repeat(100 * 1024))
    }))).rejects.toThrow('2048KB limit')
    expect(await loadShellFs('s1')).toEqual(before)
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(before?.['/tmp/paper.pdf'])
    expect(await readShellFile('s1', '/tmp/extra.txt')).toBeNull()
  })

  it('preserves an over-quota ordinary working set after downgrade but rejects further growth', async () => {
    largeFileUploads = true
    for (let i = 0; i < 5; i++) await writeToShellFile('s1', `/tmp/filler-${i}.txt`, 'a'.repeat(500 * 1024))
    largeFileUploads = false
    await createInstance('s1', 1)
    expect((await execBash('s1', 1, 'true')).exitCode).toBe(0)
    const before = await loadShellFs('s1')
    await expect(writeToShellFile('s1', '/tmp/new.txt', 'growth')).rejects.toThrow('2048KB limit')
    expect(await loadShellFs('s1')).toEqual(before)
    await writeToShellFile('s1', '/tmp/filler-0.txt', 'smaller')
    expect((await loadShellFs('s1'))?.['/tmp/filler-4.txt']).toBe('a'.repeat(500 * 1024))
  })

  it.each([1, 2])('refreshes exec limits without replacing the live FS (tab=%s)', async tabId => {
    const instance = await createInstance('s1', 1)
    const fs = instance.bash.fs
    await writeToShellFile('s1', '/tmp/keeper.txt', 'kept')
    largeFileUploads = true
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    const result = await execBash('s1', tabId, 'cat /tmp/paper.pdf | wc -c')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(String(pdf.length))
    expect(instance.bash.fs).toBe(fs)
    expect(await readShellFile('s1', '/tmp/keeper.txt')).toBe('kept')
    largeFileUploads = false
    const rejected = await execBash('s1', tabId, 'cp /tmp/paper.pdf /tmp/copy.pdf; echo changed > /tmp/keeper.txt')
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr).toContain('500KB limit')
    expect(await readShellFile('s1', '/tmp/keeper.txt')).toBe('kept')
    expect(await readShellFile('s1', '/tmp/copy.pdf')).toBeNull()
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe(pdf)
  })

  it('rejects a PDF above the lab maximum without replacing archived bytes', async () => {
    largeFileUploads = true
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', 'x'.repeat(LARGE_MAX_FILE_SIZE + 1))).rejects.toThrow('32768KB limit')
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe(pdf)
  })

  it('checks configuration again at commit after a long-running mutation', async () => {
    largeFileUploads = true
    await writeToShellFile('s1', '/tmp/paper.pdf', 'old')
    await expect(withSessionLock('s1', () => mutateShellFs('s1', 1, false, async fs => {
      await fs.writeFile('/tmp/paper.pdf', pdf, 'latin1')
      largeFileUploads = false
    }))).rejects.toThrow('500KB limit')
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe('old')
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe('old')
  })

  it('retains the mode of an existing pro session when exec omits the optional mode', async () => {
    await createInstance('s1', 1, true)
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    const result = await execBash('s1', 2, 'cp /tmp/paper.pdf /tmp/copy.pdf')
    expect(result.exitCode).toBe(0)
    expect((await loadShellFs('s1'))?.['/tmp/copy.pdf']).toBe(pdf)
  })
})

describe('per-session commit ordering', () => {
  it.each([false, true])('retains both concurrent cold attachment and reader mutations (attachment first=%s)', async attachmentFirst => {
    largeFileUploads = true
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    const jobs = attachmentFirst
      ? [writeToShellFile('s1', '/tmp/second.pdf', pdf), note('concurrent note')]
      : [note('concurrent note'), writeToShellFile('s1', '/tmp/second.pdf', pdf)]
    await Promise.all(jobs)
    await restart()
    await createInstance('s1', 1)
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe(pdf)
    expect(await readShellFile('s1', '/tmp/second.pdf')).toBe(pdf)
    expect(await readShellFile('s1', '/tmp/paper.pdf.notes.jsonl')).toContain('concurrent note')
  })

  it.each(['write', 'reader', 'exec', 'clear', 'screenshot'] as const)('%s keeps the lock until the IndexedDB commit, without blocking another session', async operation => {
    largeFileUploads = true
    await execBash('s1', 1, 'echo page > /page/source.txt; echo old > /tmp/keeper.txt')
    const gate = pauseNextSave()
    let completed = false
    const first = (async () => {
      if (operation === 'write') await writeToShellFile('s1', '/tmp/first.txt', 'first')
      if (operation === 'reader') await note('first note')
      if (operation === 'exec') expect((await execBash('s1', 1, 'echo first > /tmp/first.txt')).exitCode).toBe(0)
      if (operation === 'clear') await clearPageDir('s1')
      if (operation === 'screenshot') expect(await mirrorScreenshotToVfs('s1', '\xff\x00')).not.toBeNull()
      completed = true
    })()
    await gate.started.promise
    let entered = false
    const second = withSessionLock('s1', async () => {
      entered = true
      await mutateShellFs('s1', 205, false, fs => fs.writeFile('/tmp/second.txt', 'second'))
    })
    try {
      await writeToShellFile('s2', '/tmp/independent.txt', 'independent')
      expect((await loadShellFs('s2'))?.['/tmp/independent.txt']).toBe('independent')
      expect(completed).toBe(false)
      expect(entered).toBe(false)
    } finally {
      gate.release.resolve()
      await Promise.all([first, second])
    }
    const snapshot = await loadShellFs('s1')
    expect(snapshot?.['/tmp/keeper.txt']).toBe('old\n')
    expect(snapshot?.['/tmp/second.txt']).toBe('second')
    if (operation === 'write' || operation === 'exec') expect(snapshot?.['/tmp/first.txt']?.trim()).toBe('first')
    if (operation === 'reader') expect(snapshot?.['/tmp/paper.pdf.notes.jsonl']).toContain('first note')
    if (operation === 'clear') expect(snapshot?.['/page/source.txt']).toBeUndefined()
    if (operation === 'screenshot') expect(Object.keys(snapshot!).some(path => path.startsWith('/tmp/screenshots/'))).toBe(true)
  })

  it('serializes cold creation behind a pending attachment commit', async () => {
    const gate = pauseNextSave()
    const writing = writeToShellFile('s1', '/tmp/first.txt', 'first')
    await gate.started.promise
    const creating = createInstance('s1', 1)
    try {
      await writeToShellFile('s2', '/tmp/independent.txt', 'second')
    } finally {
      gate.release.resolve()
      await writing
    }
    const instance = await creating
    expect(await instance.bash.fs.readFile('/tmp/first.txt')).toBe('first')
    expect(await createInstance('s1', 2)).toBe(instance)
    await note()
    expect((await loadShellFs('s1'))?.['/tmp/first.txt']).toBe('first')
  })

  it('orders deletion after outstanding commits and never resurrects the snapshot', async () => {
    const gate = pauseNextSave()
    const writing = execBash('s1', 1, 'echo first > /tmp/first.txt')
    await gate.started.promise
    const deleting = deleteShellInstance('s1')
    gate.release.resolve()
    expect((await writing).exitCode).toBe(0)
    await deleting
    expect(await loadShellFs('s1')).toBeNull()
    expect(await readShellFile('s1', '/tmp/first.txt')).toBeNull()
  })

  it('clears cold page files while preserving PDFs and concurrent archive writes', async () => {
    largeFileUploads = true
    await execBash('s1', 1, 'echo page > /page/source.txt')
    await writeToShellFile('s1', '/tmp/paper.pdf', pdf)
    await restart()
    largeFileUploads = false
    await Promise.all([clearPageDir('s1'), writeToShellFile('s1', '/context/archive.txt', 'archive')])
    const snapshot = await loadShellFs('s1')
    expect(snapshot?.['/page/source.txt']).toBeUndefined()
    expect(snapshot?.['/tmp/paper.pdf']).toBe(pdf)
    expect(snapshot?.['/context/archive.txt']).toBe('archive')
  })

  it('stages bash screenshots in the enclosing commit without recursive locking', async () => {
    largeFileUploads = true
    vi.mocked(handleScreenshot).mockImplementation(async (_tabId, params) => {
      const path = await mirrorScreenshotToVfs(params.sessionId!, '\xff\x80\x00')
      return { success: true, message: `Saved: ${path}` }
    })
    const result = await execBash('s1', 1, 'echo before > /tmp/before.txt; screenshot; echo after > /tmp/after.txt')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('/tmp/screenshots/')
    const snapshot = await loadShellFs('s1')
    expect(snapshot?.['/tmp/before.txt']).toBe('before\n')
    expect(snapshot?.['/tmp/after.txt']).toBe('after\n')
    const path = Object.keys(snapshot!).find(path => path.startsWith('/tmp/screenshots/'))!
    expect(snapshot?.[path]).toBe('\xff\x80\x00')
    expect(vi.mocked(set).mock.calls.filter(([key]) => key === 'shellfs:s1')).toHaveLength(1)
  })

  it('does not let an external screenshot bypass the queue while a bash screenshot is active', async () => {
    largeFileUploads = true
    const started = deferred()
    const release = deferred()
    vi.mocked(handleScreenshot).mockImplementation(async (_tabId, params) => {
      started.resolve()
      await release.promise
      const path = await mirrorScreenshotToVfs(params.sessionId!, 'internal')
      return { success: true, message: `Saved: ${path}` }
    })
    const executing = execBash('s1', 1, 'screenshot')
    await started.promise
    let externalFinished = false
    const external = mirrorScreenshotToVfs('s1', 'external').then(path => {
      externalFinished = true
      return path
    })
    try {
      await writeToShellFile('s2', '/tmp/independent.txt', 'second')
      expect(externalFinished).toBe(false)
    } finally {
      release.resolve()
    }
    expect((await executing).exitCode).toBe(0)
    const path = await external
    expect(path).not.toBeNull()
    const snapshot = await loadShellFs('s1')
    expect(Object.values(snapshot!)).toContain('internal')
    expect(snapshot?.[path!]).toBe('external')
  })
})

describe('storage failures preserve acknowledged data', () => {
  it.each([false, true])('propagates save errors and preserves the old file (live=%s)', async live => {
    if (live) await createInstance('s1', 1)
    await writeToShellFile('s1', '/tmp/paper.pdf', 'old bytes')
    const before = await loadShellFs('s1')
    storage.beforeSet = async () => { throw new Error('IndexedDB write failed') }
    await expect(writeToShellFile('s1', '/tmp/paper.pdf', 'new bytes')).rejects.toThrow('IndexedDB write failed')
    expect(await readShellFile('s1', '/tmp/paper.pdf')).toBe('old bytes')
    expect(await loadShellFs('s1')).toEqual(before)
    storage.beforeSet = undefined
    await writeToShellFile('s1', '/tmp/retry.txt', 'retry works')
    expect((await loadShellFs('s1'))?.['/tmp/paper.pdf']).toBe('old bytes')
  })

  it('does not overwrite storage after a failed cold read', async () => {
    await writeToShellFile('s1', '/tmp/keeper.txt', 'kept')
    const before = await loadShellFs('s1')
    vi.mocked(get).mockRejectedValueOnce(new Error('IndexedDB read failed'))
    await expect(writeToShellFile('s1', '/tmp/new.txt', 'new')).rejects.toThrow('IndexedDB read failed')
    expect(await loadShellFs('s1')).toEqual(before)
  })

  it('rolls back reader mutations that exceed capacity or throw midway', async () => {
    await note('original')
    const before = await loadShellFs('s1')
    await expect(withSessionLock('s1', () => mutateShellFs('s1', 205, false, async fs => {
      await fs.writeFile('/tmp/paper.pdf.notes.jsonl', 'x'.repeat(500 * 1024 + 1))
    }))).rejects.toThrow('500KB limit')
    await expect(withSessionLock('s1', () => mutateShellFs('s1', 205, false, async fs => {
      await fs.writeFile('/tmp/paper.pdf.notes.jsonl', 'changed')
      throw new Error('mutation failed')
    }))).rejects.toThrow('mutation failed')
    expect(await readShellFile('s1', '/tmp/paper.pdf.notes.jsonl')).toBe(before?.['/tmp/paper.pdf.notes.jsonl'])
    expect(await loadShellFs('s1')).toEqual(before)
  })

  it('reports exec persistence failure and rolls back its live changes', async () => {
    await writeToShellFile('s1', '/tmp/keeper.txt', 'kept')
    storage.beforeSet = async () => { throw new Error('IndexedDB write failed') }
    const result = await execBash('s1', 1, 'echo replaced > /tmp/keeper.txt; echo new > /tmp/new.txt')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('IndexedDB write failed')
    expect(await readShellFile('s1', '/tmp/keeper.txt')).toBe('kept')
    expect(await readShellFile('s1', '/tmp/new.txt')).toBeNull()
    expect((await loadShellFs('s1'))?.['/tmp/keeper.txt']).toBe('kept')
  })

  it.each(['reader', 'clear'] as const)('propagates %s commit errors and restores original live files', async operation => {
    await execBash('s1', 1, 'echo page > /page/source.txt')
    await note('original note')
    const before = await loadShellFs('s1')
    storage.beforeSet = async () => { throw new Error('IndexedDB write failed') }
    await expect(operation === 'reader' ? note('rejected note') : clearPageDir('s1')).rejects.toThrow('IndexedDB write failed')
    expect(await loadShellFs('s1')).toEqual(before)
    expect(await readShellFile('s1', '/page/source.txt')).toBe('page\n')
    expect(await readShellFile('s1', '/tmp/paper.pdf.notes.jsonl')).toBe(before?.['/tmp/paper.pdf.notes.jsonl'])
  })

  it('keeps live and persisted data consistent if backup notification throws after commit', async () => {
    await createInstance('s1', 1)
    const previous = Object.getOwnPropertyDescriptor(globalThis, '__backupNotify')
    Reflect.set(globalThis, '__backupNotify', () => { throw new Error('notification failed') })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(writeToShellFile('s1', '/tmp/committed.txt', 'committed')).resolves.toBeUndefined()
      expect(await readShellFile('s1', '/tmp/committed.txt')).toBe('committed')
      expect((await loadShellFs('s1'))?.['/tmp/committed.txt']).toBe('committed')
    } finally {
      if (previous) Object.defineProperty(globalThis, '__backupNotify', previous)
      else Reflect.deleteProperty(globalThis, '__backupNotify')
      warning.mockRestore()
    }
  })

  it('restores the screenshot ring when the new snapshot cannot commit', async () => {
    largeFileUploads = true
    await createInstance('s1', 1)
    for (let i = 0; i < 5; i++) expect(await mirrorScreenshotToVfs('s1', `image-${i}`)).not.toBeNull()
    const before = await loadShellFs('s1')
    storage.beforeSet = async () => { throw new Error('IndexedDB write failed') }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await mirrorScreenshotToVfs('s1', 'rejected-image')).toBeNull()
    } finally {
      warning.mockRestore()
    }
    expect(await loadShellFs('s1')).toEqual(before)
    for (const [path, content] of Object.entries(before!)) expect(await readShellFile('s1', path)).toBe(content)
  })
})
