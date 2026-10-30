import { describe, it, expect } from 'vitest'
import { Bash } from 'just-bash'

describe('Shell (just-bash)', () => {
  it('executes echo', async () => {
    const bash = new Bash({ files: {}, cwd: '/' })
    const r = await bash.exec('echo hello')
    expect(r.stdout).toBe('hello\n')
    expect(r.exitCode).toBe(0)
  })

  it('persists files across calls', async () => {
    const bash = new Bash({ files: { '/tmp/.keep': '' }, cwd: '/' })
    await bash.exec('echo "test" > /tmp/out.txt')
    const r = await bash.exec('cat /tmp/out.txt')
    expect(r.stdout).toContain('test')
  })

  it('supports pipe and grep', async () => {
    const bash = new Bash({ files: {}, cwd: '/' })
    await bash.exec('echo "alpha\nbeta\ngamma" > /tmp/data.txt')
    const r = await bash.exec('cat /tmp/data.txt | grep beta')
    expect(r.stdout).toContain('beta')
    expect(r.stdout).not.toContain('alpha')
  })

  it('respects execution limits', async () => {
    const bash = new Bash({ files: {}, cwd: '/', executionLimits: { maxLoopIterations: 3 } })
    const r = await bash.exec('for i in 1 2 3 4 5; do echo $i; done')
    expect(r.exitCode).not.toBe(0)
  })

  it('supports custom commands', async () => {
    const { defineCommand } = await import('just-bash')
    const bash = new Bash({
      files: {},
      cwd: '/',
      customCommands: [defineCommand('hello', async () => ({ stdout: 'world\n', stderr: '', exitCode: 0 }))],
    })
    const r = await bash.exec('hello')
    expect(r.stdout).toBe('world\n')
  })
})
