import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV4Usage } from '@ai-sdk/provider'
import type { ApiConfig, ApiProtocol } from './types'
import type { TokenCounts, UsageEvent } from './token-usage'

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function normalizeTokenUsage(usage: LanguageModelV4Usage, protocol?: ApiProtocol): TokenCounts {
  const raw = object(usage.raw)
  const responses = protocol === 'responses' || raw.input_tokens_details != null || raw.output_tokens_details != null
  const prompt = object(responses ? raw.input_tokens_details : raw.prompt_tokens_details)
  const completion = object(responses ? raw.output_tokens_details : raw.completion_tokens_details)
  const read = count(prompt.cached_tokens) ?? count(raw.prompt_cache_hit_tokens) ?? count(raw.cache_read_input_tokens)
  const write = count(raw.cache_creation_input_tokens) ?? count(raw.cache_write_tokens)
  // Reason: the compatible adapter substitutes zero for absent fields. Raw presence distinguishes missing from zero.
  const hasRaw = usage.raw != null
  let input = hasRaw ? count(raw.prompt_tokens) : count(usage.inputTokens.total)
  if (input === null && count(raw.input_tokens) !== null) {
    // Reason: Anthropic-style input_tokens excludes both cache creation and cache reads.
    input = count(raw.input_tokens)! + (responses ? 0 : (read ?? 0) + (write ?? 0))
  }
  return {
    input,
    output: hasRaw ? count(raw.completion_tokens) ?? count(raw.output_tokens) : count(usage.outputTokens.total),
    read: hasRaw ? read : count(usage.inputTokens.cacheRead),
    write: write ?? count(usage.inputTokens.cacheWrite),
    reasoning: hasRaw ? count(completion.reasoning_tokens) : count(usage.outputTokens.reasoning),
  }
}

export function usageMiddleware(config: ApiConfig, session = ''): LanguageModelMiddleware {
  const profile = config.profiles?.find(p => p.id === config.activeProfileId)
  const identity = {
    session: session.slice(0, 200),
    provider: (config.activeProfileId || 'default').slice(0, 200),
    name: (profile?.name || 'Default').slice(0, 200),
    model: config.model.slice(0, 200),
  }
  async function report(usage: LanguageModelV4Usage) {
    try {
      const event: UsageEvent = { ...identity, id: crypto.randomUUID(), at: Date.now(), tokens: normalizeTokenUsage(usage, config.apiProtocol) }
      const result = await chrome.runtime.sendMessage({ type: 'usage:record', event })
      if (result?.success === false) console.warn('[usage] save failed')
    } catch {
      // Reason: accounting must never turn a successful model response into a failed conversation.
      console.warn('[usage] save unavailable')
    }
  }
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      await report(result.usage)
      return result
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream()
      let recorded = false
      return {
        ...result,
        stream: result.stream.pipeThrough(new TransformStream({
          async transform(part, controller) {
            if (part.type === 'finish' && !recorded) {
              recorded = true
              await report(part.usage)
            }
            controller.enqueue(part)
          },
        })),
      }
    },
  }
}
