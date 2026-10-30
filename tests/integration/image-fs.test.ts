import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reason: idb-keyval has no IndexedDB in the test env — back the shell
// storage with an in-memory map so both mirror paths (live instance and
// persisted snapshot) are exercisable.
const memStore = new Map<string, Record<string, string>>()
vi.mock('../../src/shared/shell-storage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/shared/shell-storage')>()
  return {
    ...orig,
    loadShellFs: vi.fn(async (id: string) => memStore.get(id) ?? null),
    saveShellFs: vi.fn(async (id: string, snap: Record<string, string>) => { memStore.set(id, { ...snap }) }),
    deleteShellFs: vi.fn(async (id: string) => { memStore.delete(id) }),
  }
})
vi.mock('../../src/shared/storage', () => ({
  loadConfig: vi.fn().mockResolvedValue({ labImageFs: true }),
  loadSessionIndex: vi.fn().mockResolvedValue([]),
}))
// Reason: getMemoryFiles hits idb-keyval on the createInstance path — stub it
vi.mock('../../src/shared/memory-storage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/shared/memory-storage')>()
  return { ...orig, getMemoryFiles: vi.fn().mockResolvedValue({}) }
})

import { execBash, mirrorScreenshotToVfs, readShellFile } from '../../src/background/shell'

// Reason: full-range byte sample — mirrors must be byte-exact, not UTF-8 filtered
const BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x7f, 0xe4, 0xb8, 0xad, 0x01]
const LATIN1 = String.fromCharCode(...BYTES)
const B64 = 'iVBORw0KGgoA/4B/5LitAQ=='

beforeEach(() => { memStore.clear() })

describe('mirrorScreenshotToVfs', () => {
  it('mirrors bytes intact into a live instance and prunes the ring to 5', async () => {
    const sid = `img-live-${Date.now()}`
    await execBash(sid, 1, 'echo boot')

    const paths: (string | null)[] = []
    for (let i = 0; i < 6; i++) paths.push(await mirrorScreenshotToVfs(sid, LATIN1))
    expect(paths.every(p => p?.startsWith('/tmp/screenshots/'))).toBe(true)

    // Reason: byte fidelity asserted through the shell itself — cat|base64 sees
    // the underlying bytes, unlike the text readFile which decodes them back
    // and can round-trip "intact" over corrupted storage.
    const b64 = await execBash(sid, 1, `cat ${paths[5]} | base64 | tr -d '\\n'`)
    expect(b64.stdout.trim()).toBe(B64)

    const content = await readShellFile(sid, paths[5]!)
    expect([...content!].map(c => c.charCodeAt(0))).toEqual(BYTES)

    // ring: oldest pruned, exactly 5 remain
    expect(await readShellFile(sid, paths[0]!)).toBeNull()
    const ls = await execBash(sid, 1, 'ls /tmp/screenshots | wc -l')
    expect(ls.stdout.trim()).toBe('5')
  })

  it('mirrors into the persisted snapshot when no instance is live', async () => {
    const sid = `img-cold-${Date.now()}`
    const paths: (string | null)[] = []
    for (let i = 0; i < 6; i++) paths.push(await mirrorScreenshotToVfs(sid, LATIN1))
    expect(paths.every(Boolean)).toBe(true)

    const snap = memStore.get(sid)!
    const shots = Object.keys(snap).filter(p => p.startsWith('/tmp/screenshots/'))
    expect(shots).toHaveLength(5)
    expect(shots).not.toContain(paths[0])
    expect([...snap[paths[5]!]].map(c => c.charCodeAt(0))).toEqual(BYTES)
  })

  it('keeps bytes intact across instance restore (snapshot hydrate)', async () => {
    const sid = `img-restore-${Date.now()}`
    // cold mirror → snapshot holds a latin1 byte string
    const path = await mirrorScreenshotToVfs(sid, LATIN1)
    expect(path).not.toBeNull()
    // Reason: first execBash hydrates the instance from the persisted snapshot —
    // binary entries must be re-materialized as bytes, not re-encoded as text
    const b64 = await execBash(sid, 1, `cat ${path} | base64 | tr -d '\\n'`)
    expect(b64.stdout.trim()).toBe(B64)
  })

  it('end to end: mirrored screenshot uploads byte-intact via cat | http-put', async () => {
    const { loadConfig } = await import('../../src/shared/storage')
    vi.mocked(loadConfig).mockResolvedValue({ labImageFs: true, labFetch: true } as never)
    const captured: { body?: Uint8Array } = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      captured.body = init.body as Uint8Array
      return new Response('ok', { status: 200 })
    }))

    const sid = `img-e2e-${Date.now()}`
    await execBash(sid, 1, 'echo boot')
    const path = await mirrorScreenshotToVfs(sid, LATIN1)
    const r = await execBash(sid, 1, `cat ${path} | http-put https://oss.example.com/up --type=image/jpeg`)
    expect(r.exitCode).toBe(0)
    expect(captured.body).toBeInstanceOf(Uint8Array)
    expect(Array.from(captured.body!)).toEqual(BYTES)

    vi.unstubAllGlobals()
    vi.mocked(loadConfig).mockResolvedValue({ labImageFs: true } as never)
  })

  it('rejects oversized payloads with null', async () => {
    const sid = `img-big-${Date.now()}`
    const big = 'x'.repeat(5 * 1024 * 1024 + 1)
    expect(await mirrorScreenshotToVfs(sid, big)).toBeNull()
    expect(memStore.get(sid)).toBeUndefined()
  })
})
