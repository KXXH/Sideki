import { defineCommand } from 'just-bash'
import type { Command, CommandContext } from 'just-bash'
import { handleMcpMessage } from './mcp-manager'
import type { McpToolMeta } from '../shared/mcp-client'

function decodeStdin(stdin: string): string {
  if (!stdin) return ''
  let hasHigh = false
  for (let i = 0; i < stdin.length; i++) {
    if (stdin.charCodeAt(i) > 127) { hasHigh = true; break }
  }
  if (!hasHigh) return stdin
  const bytes = new Uint8Array(stdin.length)
  for (let i = 0; i < stdin.length; i++) bytes[i] = stdin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

const USAGE = [
  'Usage: mcp <subcommand> [options]',
  '',
  'Subcommands:',
  '  list                              List available MCP tools',
  '  call <tool> [key=value ...] [--args JSON]  Call an MCP tool',
  '',
  'Parameter syntax:',
  '  key=value     String value',
  '  key:=JSON     Raw JSON value (objects, arrays, numbers, booleans)',
  '  key=@-        Read value from stdin',
  '  --args JSON   Full JSON object merged into params',
  '',
  'Examples:',
  '  mcp list',
  '  mcp call search_documents keyword="Q3"',
  '  mcp call insert_document_block nodeId="abc" element:=\'{"blockType":"paragraph"}\'',
  '',
].join('\n')

async function handleList(tabId: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await handleMcpMessage('mcp:ensure', {}, tabId) as { tools?: McpToolMeta[] } | undefined
  const meta = res?.tools ?? []
  if (meta.length === 0) {
    return { stdout: '(no MCP tools available — check Settings → MCP Servers)\n', stderr: '', exitCode: 0 }
  }
  const maxName = Math.max(...meta.map(m => m.qualifiedName.length))
  const lines = meta.map(m => `${m.qualifiedName.padEnd(maxName + 2)}${m.description}`)
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
}

function parseKvArgs(args: string[]): { kv: Record<string, unknown>; jsonArg: string | null; parseError: string | null } {
  const kv: Record<string, unknown> = {}
  let jsonArg: string | null = null
  let i = 0
  while (i < args.length) {
    if (args[i] === '--args' && i + 1 < args.length) {
      jsonArg = args[i + 1]
      i += 2
      continue
    }
    // Reason: `:=` passes raw JSON values (httpie convention), `=` passes strings
    const jsonEq = args[i].indexOf(':=')
    if (jsonEq > 0) {
      const key = args[i].slice(0, jsonEq)
      const raw = args[i].slice(jsonEq + 2)
      try {
        kv[key] = JSON.parse(raw)
      } catch {
        return { kv, jsonArg, parseError: `${key}:= invalid JSON: ${raw}` }
      }
      i++
      continue
    }
    const eq = args[i].indexOf('=')
    if (eq > 0) {
      kv[args[i].slice(0, eq)] = args[i].slice(eq + 1)
    }
    i++
  }
  return { kv, jsonArg, parseError: null }
}

async function handleCall(
  args: string[],
  ctx: CommandContext,
  tabId: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (args.length === 0) {
    return { stdout: '', stderr: 'Usage: mcp call <tool> [key=value ...] [--args JSON]\n', exitCode: 1 }
  }

  const toolName = args[0]
  const restArgs = args.slice(1)
  const { kv, jsonArg, parseError } = parseKvArgs(restArgs)
  if (parseError) {
    return { stdout: '', stderr: parseError + '\n', exitCode: 1 }
  }

  let callArgs: Record<string, unknown> = { ...kv }

  // Reason: key=@- reads stdin as raw text value for that key (curl-style convention)
  const stdinKey = Object.keys(callArgs).find(k => callArgs[k] === '@-')
  if (stdinKey) {
    const text = ctx.stdin ? decodeStdin(ctx.stdin as unknown as string) : ''
    callArgs[stdinKey] = text
  }

  if (jsonArg) {
    try {
      const parsed = JSON.parse(jsonArg)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        callArgs = { ...callArgs, ...parsed }
      } else {
        return { stdout: '', stderr: '--args must be a JSON object\n', exitCode: 1 }
      }
    } catch {
      return { stdout: '', stderr: '--args: invalid JSON\n', exitCode: 1 }
    }
  }

  // Reason: stdin pipe mode — when no k=v or --args given, try parsing stdin as JSON args
  if (Object.keys(callArgs).length === 0 && ctx.stdin) {
    const text = decodeStdin(ctx.stdin as unknown as string).trim()
    if (text) {
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          callArgs = parsed as Record<string, unknown>
        }
      } catch { /* not JSON, call with empty args */ }
    }
  }

  try {
    const result = await handleMcpMessage('mcp:call-tool', {
      qualifiedName: toolName,
      args: callArgs,
    }, tabId)
    if (result && typeof result === 'object' && 'error' in result) {
      return { stdout: '', stderr: String((result as Record<string, unknown>).error) + '\n', exitCode: 1 }
    }
    const json = JSON.stringify(result, null, 2)
    return { stdout: json + '\n', stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: '', stderr: (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 }
  }
}

export function createMcpCommand(tabId: number): Command {
  return defineCommand('mcp', async (args, ctx) => {
    const sub = args[0]
    switch (sub) {
      case 'list': return handleList(tabId)
      case 'call': return handleCall(args.slice(1), ctx, tabId)
      default: return { stdout: '', stderr: USAGE, exitCode: 1 }
    }
  })
}
