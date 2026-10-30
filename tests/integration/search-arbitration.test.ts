// Reason: arbitration test — settles the dispute between local unit tests
// (which pass) and the field agent's report (claiming --search "留观" misses).
// Source text replicates the EXACT physical form confirmed by the agent's XHR
// probe on deploy-gray.js: JSON.stringify showed "\\u9996\\u6279\\u7559\\u89c2 \\u226530 \\u5206",
// i.e. literal single-backslash \uXXXX escape sequences in the raw text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bash } from 'just-bash'

// Real production source text shape: a minified single-line bundle with the
// escaped CJK payload buried at a known offset (like offset 54381 in the field file).
const PREFIX = 'var a=1;function f(x){return x+1};'.repeat(100) // ~3.4KB of minified noise
const PAYLOAD = 'title:"\\u9996\\u6279\\u7559\\u89c2 \\u226530 \\u5206\\u949f"' // 首批留观 ≥30 分钟
const REAL_SHAPE_SOURCE = PREFIX + PAYLOAD + ';var z=0;'
// Uppercase-hex variant some bundlers emit (观 = U+89C2 → \u89C2)
const UPPER_HEX_SOURCE = PREFIX + 'label:"\\u7559\\u89C2"' + ';'

vi.mock('../../src/background/debug-session', () => ({
  debugSession: {
    isAttached: vi.fn().mockReturnValue(true),
    attach: vi.fn().mockResolvedValue(undefined),
    getScriptSource: vi.fn(),
  },
}))

import { createDebugCommand } from '../../src/background/debug-commands'
import { debugSession } from '../../src/background/debug-session'

function makeBash() {
  return new Bash({ files: {}, cwd: '/', customCommands: [createDebugCommand()] })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(debugSession.isAttached).mockReturnValue(true)
  vi.mocked(debugSession.getScriptSource).mockResolvedValue(REAL_SHAPE_SOURCE)
})

describe('ARBITRATION: --search 中文 on real-shape escaped source', () => {
  const CASES = [
    'debug source 1 --search=留观',
    'debug source 1 --search 留观',
    'debug source 1 --search "留观"',
    'debug source 1 --search="首批留观"',
  ]

  for (const cmd of CASES) {
    it(`[${cmd}] must HIT`, async () => {
      const bash = makeBash()
      const r = await bash.exec(cmd)
      // Print raw output for human inspection — this is the arbitration evidence
      console.log(`\n$ ${cmd}\n--- stdout ---\n${r.stdout}--- stderr ---\n${r.stderr}--- exit: ${r.exitCode} ---`)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).not.toContain('No matches')
      expect(r.stdout).toContain('[col:')
    })
  }

  it('[uppercase hex \\u89C2] must HIT (case-insensitive)', async () => {
    vi.mocked(debugSession.getScriptSource).mockResolvedValue(UPPER_HEX_SOURCE)
    const bash = makeBash()
    const r = await bash.exec('debug source 1 --search=留观')
    console.log(`\n$ debug source 1 --search=留观 (upper-hex source)\n--- stdout ---\n${r.stdout}--- exit: ${r.exitCode} ---`)
    expect(r.stdout).not.toContain('No matches')
    expect(r.stdout).toContain('[col:')
  })

  it('reported col must equal the raw indexOf offset (agent cross-check)', async () => {
    const bash = makeBash()
    const r = await bash.exec('debug source 1 --search=留观')
    const expected = REAL_SHAPE_SOURCE.indexOf('\\u7559\\u89c2')
    console.log(`\nraw indexOf("\\\\u7559\\\\u89c2") = ${expected}, tool output: ${r.stdout.match(/\[col:\d+\]/)?.[0]}`)
    expect(r.stdout).toContain(`[col:${expected}]`)
  })

  it('negative control: word absent from source must MISS', async () => {
    const bash = makeBash()
    const r = await bash.exec('debug source 1 --search=不存在的词')
    console.log(`\n$ debug source 1 --search=不存在的词\n--- stdout ---\n${r.stdout}`)
    expect(r.stdout).toContain('No matches')
  })
})
