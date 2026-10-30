import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalManager } from '../../src/background/approval-manager'
import { createReviewShell } from '../../src/background/review-shell'
import { operatingTabOf } from '../../src/background/tab-locks'
import type { ApprovalPrepareInput, ApprovalReference } from '../../src/shared/approval-types'

vi.mock('../../src/background/review-shell', () => ({ createReviewShell: vi.fn() }))
vi.mock('../../src/background/tab-locks', () => ({ operatingTabOf: vi.fn() }))

const input = (patch: Partial<ApprovalPrepareInput> = {}): ApprovalPrepareInput => ({
  sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a', toolName: 'bash',
  args: { command: 'bash /tmp/script.sh' }, mode: 'auto', tabId: 19, ...patch,
})

function shell() {
  return {
    exec: vi.fn<(command: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string; exitCode: number }>>(async () => ({ stdout: 'script contents', stderr: '', exitCode: 0 })),
    isCurrent: vi.fn(async () => true),
    dispose: vi.fn(),
  }
}

let manager: ApprovalManager
let review: ReturnType<typeof shell>

beforeEach(() => {
  vi.clearAllMocks()
  review = shell()
  vi.mocked(createReviewShell).mockResolvedValue(review)
  vi.mocked(operatingTabOf).mockReturnValue(7)
  vi.mocked(chrome.tabs.get).mockImplementation(async id => ({ id, url: 'https://example.com/product', title: 'Product' } as chrome.tabs.Tab))
  manager = new ApprovalManager()
})

afterEach(() => vi.useRealTimers())

async function approved(patch: Partial<ApprovalPrepareInput> = {}) {
  const request = input(patch)
  const prepared = await manager.prepare(request)
  const completed = await manager.complete(prepared.requestId, 'allow', '')
  if (completed.decision !== 'allow') throw new Error('Synthetic approval failed')
  return { request, reference: { requestId: prepared.requestId, permitId: completed.permitId!, turnId: request.turnId } satisfies ApprovalReference }
}

describe('approval execution capability', () => {
  it('binds preparation to the session operating tab rather than the supplied fallback', async () => {
    const result = await manager.prepare(input())
    expect(result.decision).toBe('review')
    expect(result.environment.tabId).toBe(7)
    expect(createReviewShell).toHaveBeenCalledExactlyOnceWith('session-a', 7)
    expect(review.exec).not.toHaveBeenCalled()
  })

  it('denies the whole call and destroys its investigative environment', async () => {
    const prepared = await manager.prepare(input())
    expect(await manager.complete(prepared.requestId, 'deny', '超出用户授权范围')).toEqual({ decision: 'deny', reason: '超出用户授权范围' })
    await expect(manager.claim({ requestId: prepared.requestId, permitId: 'forged', turnId: 'turn-a' }, 'bash', input().args, 7)).rejects.toThrow()
    await expect(manager.bash(prepared.requestId, 'cat /tmp/script.sh')).rejects.toThrow()
    expect(review.dispose).toHaveBeenCalledTimes(1)
    expect(review.exec).not.toHaveBeenCalled()
  })

  it('rejects changed args, tool, tab, turn and permit without consuming a matching capability', async () => {
    const { reference, request } = await approved()
    await expect(manager.claim(reference, 'bash', { command: 'rm /tmp/script.sh' }, 7)).rejects.toThrow()
    await expect(manager.claim(reference, 'click', request.args, 7)).rejects.toThrow()
    await expect(manager.claim(reference, 'bash', request.args, 8)).rejects.toThrow()
    await expect(manager.claim({ ...reference, turnId: 'other-turn' }, 'bash', request.args, 7)).rejects.toThrow()
    await expect(manager.claim({ ...reference, permitId: 'forged' }, 'bash', request.args, 7)).rejects.toThrow()
    const execution = await manager.claim(reference, 'bash', request.args, 7)
    expect(execution).toMatchObject({ mode: 'auto', sessionId: 'session-a', toolCallId: 'call-a' })
    expect(execution.isActive()).toBe(true)
    await expect(manager.claim(reference, 'bash', request.args, 7)).rejects.toThrow()
    manager.finish(reference.requestId)
    expect(execution.isActive()).toBe(false)
  })

  it('allows only one of two concurrent claims of the same permit', async () => {
    const { reference, request } = await approved()
    const claims = await Promise.allSettled([
      manager.claim(reference, 'bash', request.args, 7),
      manager.claim(reference, 'bash', request.args, 7),
    ])
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(review.dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['description', 'sessionId'])('compares nested %s arguments as executable data', async key => {
    const args = { payload: { [key]: 'original' } }
    const { reference } = await approved({ toolName: 'mcp_update', args })
    await expect(manager.claim(reference, 'mcp_update', { payload: { [key]: 'changed' } }, 7)).rejects.toThrow()
    expect((await manager.claim(reference, 'mcp_update', args, 7)).isActive()).toBe(true)
  })

  it('compares all array entries and tolerates object-key ordering', async () => {
    const args = { targets: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] }
    const { reference } = await approved({ args })
    await expect(manager.claim(reference, 'bash', { targets: [{ id: 'a', value: 1 }] }, 7)).rejects.toThrow()
    expect((await manager.claim(reference, 'bash', { targets: [{ value: 1, id: 'a' }, { value: 2, id: 'b' }] }, 7)).isActive()).toBe(true)
  })

  it('captures the requested args instead of retaining a mutable caller reference', async () => {
    const args = { command: 'cat /tmp/a' }
    const { reference } = await approved({ args })
    args.command = 'rm /tmp/a'
    await expect(manager.claim(reference, 'bash', args, 7)).rejects.toThrow()
    expect((await manager.claim(reference, 'bash', { command: 'cat /tmp/a' }, 7)).isActive()).toBe(true)
  })

  it('creates a manual permit for ask mode without starting the reviewer', async () => {
    const request = input({ mode: 'ask' })
    const prepared = await manager.prepare(request)
    expect(prepared.decision).toBe('manual')
    expect(prepared.permitId).toBeTruthy()
    expect(createReviewShell).not.toHaveBeenCalled()
    const execution = await manager.claim({ requestId: prepared.requestId, permitId: prepared.permitId!, turnId: request.turnId }, 'bash', request.args, 7)
    expect(execution.mode).toBe('ask')
    expect(execution.isActive()).toBe(true)
  })
})

describe('review invalidation', () => {
  it('refuses a verdict when the VFS view is stale', async () => {
    const prepared = await manager.prepare(input())
    review.isCurrent.mockResolvedValue(false)
    expect(await manager.complete(prepared.requestId, 'allow', '')).toMatchObject({ decision: 'deny' })
    expect(review.dispose).toHaveBeenCalledTimes(1)
  })

  it('rechecks the view and target URL immediately before execution', async () => {
    const { reference, request } = await approved()
    review.isCurrent.mockResolvedValue(false)
    await expect(manager.claim(reference, 'bash', request.args, 7)).rejects.toThrow('变化')
    review.isCurrent.mockResolvedValue(true)
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, url: 'https://example.com/other' } as chrome.tabs.Tab)
    await expect(manager.claim(reference, 'bash', request.args, 7)).rejects.toThrow('变化')
    expect(review.exec).not.toHaveBeenCalled()
  })

  it('cancels investigative reads and ignores a late allow verdict', async () => {
    const prepared = await manager.prepare(input())
    await manager.bash(prepared.requestId, 'cat /tmp/script.sh')
    const signal = review.exec.mock.calls[0][1] as AbortSignal
    expect(signal.aborted).toBe(false)
    manager.cancelSession('session-a')
    expect(signal.aborted).toBe(true)
    expect(await manager.complete(prepared.requestId, 'allow', '')).toMatchObject({ decision: 'deny' })
  })

  it('does not allow a cancellation racing an asynchronous freshness check', async () => {
    const prepared = await manager.prepare(input())
    let resolve!: (value: boolean) => void
    review.isCurrent.mockReturnValue(new Promise<boolean>(done => { resolve = done }))
    const verdict = manager.complete(prepared.requestId, 'allow', '')
    manager.cancelSession('session-a')
    resolve(true)
    expect(await verdict).toMatchObject({ decision: 'deny' })
  })

  it('cancels only the specified session', async () => {
    const first = await manager.prepare(input())
    const second = await manager.prepare(input({ sessionId: 'session-b', turnId: 'turn-b', toolCallId: 'call-b' }))
    manager.cancelSession('session-a')
    expect(await manager.complete(first.requestId, 'allow', '')).toMatchObject({ decision: 'deny' })
    expect(await manager.complete(second.requestId, 'allow', '')).toMatchObject({ decision: 'allow' })
  })

  it('expires unused approvals and never revives them', async () => {
    vi.useFakeTimers()
    const { reference, request } = await approved()
    vi.advanceTimersByTime(120_001)
    await expect(manager.claim(reference, 'bash', request.args, 7)).rejects.toThrow()
    expect(await manager.complete(reference.requestId, 'allow', '')).toMatchObject({ decision: 'deny' })
    expect(review.dispose).toHaveBeenCalledTimes(1)
  })

  it('fails closed if the target or read-only environment cannot be prepared', async () => {
    vi.mocked(createReviewShell).mockRejectedValue(new Error('Synthetic environment failure'))
    expect(await manager.prepare(input())).toMatchObject({ decision: 'deny' })
    vi.mocked(operatingTabOf).mockReturnValue(null)
    expect(await manager.prepare(input({ tabId: null }))).toMatchObject({ decision: 'deny' })
  })
})
