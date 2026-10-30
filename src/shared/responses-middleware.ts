import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV4Prompt, LanguageModelV4ToolResultOutput, LanguageModelV4FilePart } from '@ai-sdk/provider'
import type { ApiConfig } from './types'

function imagePart(url: string, low = false): LanguageModelV4FilePart | null {
  const match = /^data:(image\/[\w.+-]+);base64,/.exec(url)
  if (!match) return null
  return { type: 'file', mediaType: match[1], data: { type: 'url', url: new URL(url) }, ...(low ? { providerOptions: { responses: { imageDetail: 'low' } } } : {}) }
}

function migrateMetadata<T extends { type: string; providerOptions?: Record<string, unknown> }>(part: T): T {
  const old = part.providerOptions?.openai
  if (part.providerOptions?.responses || !old || typeof old !== 'object') return part
  // Reason: old OpenAI reasoning text is a summary, not raw reasoning; preserve that distinction when restoring stored sessions.
  return { ...part, providerOptions: { ...part.providerOptions, responses: {
    ...old,
    ...(part.type === 'reasoning' && 'text' in part && typeof part.text === 'string' ? { reasoningSummary: part.text ? [{ type: 'summary_text', text: part.text }] : [], reasoningContent: null } : {}),
  } } }
}

function screenshotOutput(output: LanguageModelV4ToolResultOutput, allowImages: boolean): LanguageModelV4ToolResultOutput {
  if (output.type === 'content') {
    if (allowImages) return output
    const value = output.value.filter(part => part.type !== 'file' || !part.mediaType.startsWith('image'))
    return { ...output, value: value.length ? value : [{ type: 'text', text: '[image removed]' }] }
  }
  if (output.type !== 'text' && output.type !== 'json') return output
  let parsed: unknown = output.value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return output }
  }
  if (!parsed || typeof parsed !== 'object' || !('dataUrl' in parsed) || typeof parsed.dataUrl !== 'string') return output
  const image = imagePart(parsed.dataUrl)
  if (!image) return output
  const message = 'message' in parsed && typeof parsed.message === 'string' ? parsed.message : 'Screenshot captured'
  // Reason: send actual multimodal tool output instead of a base64 string that the model cannot see.
  return { type: 'content', value: [{ type: 'text', text: message }, ...(allowImages ? [image] : [])] }
}

export function responsesPrompt(prompt: LanguageModelV4Prompt, pageImages: string[], allowImages: boolean): LanguageModelV4Prompt {
  let firstUser = true
  return prompt.map(message => {
    if (message.role === 'system') return message
    if (message.role === 'user') {
      const prepend = firstUser && allowImages ? pageImages.map(url => imagePart(url, true)).filter((part): part is LanguageModelV4FilePart => part !== null) : []
      firstUser = false
      const filtered = allowImages ? message.content : message.content.filter(part => part.type !== 'file' || !part.mediaType.startsWith('image'))
      const content = filtered.length ? filtered : [{ type: 'text' as const, text: '[image removed]' }]
      return { ...message, content: [...(prepend.length ? [{ type: 'text' as const, text: `[页面图片：以下 ${prepend.length} 张图片对应正文中的图片占位符]` }, ...prepend] : []), ...content] }
    }
    if (message.role === 'tool') return { ...message, content: message.content.map(part => part.type === 'tool-result' ? { ...part, output: screenshotOutput(part.output, allowImages) } : part) }
    return { ...message, content: message.content.filter(part => allowImages || part.type !== 'file' || !part.mediaType.startsWith('image')).map(migrateMetadata).map(part => part.type === 'tool-result' ? { ...part, output: screenshotOutput(part.output, allowImages) } : part) }
  })
}

export function responsesMiddleware(config: ApiConfig, opts: { pageImagesRef?: { current: string[] }; supportsImages?: boolean } = {}): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      const options = params.providerOptions?.responses ?? {}
      const effort = options.reasoningEffort ?? (params.reasoning === 'high' && config.reasoningEffort === 'max' ? 'max' : params.reasoning) ?? config.reasoningEffort
      const wantsReasoning = typeof effort === 'string' && effort !== '' && effort !== 'none' && effort !== 'provider-default'
      return {
        ...params,
        // Reason: Responses otherwise normalizes optional tool fields to required nullable fields, which our existing Zod inputs reject.
        tools: params.tools?.map(tool => tool.type === 'function' && tool.strict === undefined ? { ...tool, strict: false } : tool),
        prompt: responsesPrompt(params.prompt, opts.pageImagesRef?.current ?? [], opts.supportsImages ?? config.supportsImages !== false),
        ...(Number.isFinite(config.modelParams?.temperature) ? { temperature: config.modelParams!.temperature } : {}),
        ...(Number.isFinite(config.modelParams?.topP) ? { topP: config.modelParams!.topP } : {}),
        ...(Number.isFinite(config.modelParams?.maxTokens) ? { maxOutputTokens: config.modelParams!.maxTokens } : {}),
        providerOptions: {
          ...params.providerOptions,
          responses: {
            ...options,
            ...(typeof effort === 'string' && effort !== '' && effort !== 'provider-default' ? { reasoningEffort: effort } : {}),
            ...(wantsReasoning ? { reasoningSummary: options.reasoningSummary ?? 'auto' } : {}),
          },
        },
      }
    },
  }
}

// Reason: the generic SDK omits persistence controls; local history remains authoritative for every endpoint.
export function createResponsesFetch(fetcher: typeof fetch): typeof fetch {
  const unsupported = new Set<string>()
  return async (url, init) => {
    if (typeof init?.body !== 'string') return fetcher(url, init)
    const body = JSON.parse(init.body)
    body.store = false
    delete body.previous_response_id
    delete body.conversation
    body.include = ['reasoning.encrypted_content']
    for (;;) {
      if (unsupported.has('include')) delete body.include
      if (unsupported.has('reasoning.summary') && body.reasoning) delete body.reasoning.summary
      const response = await fetcher(url, { ...init, body: JSON.stringify(body) })
      if (response.status !== 400 && response.status !== 422) return response
      let error: { param?: unknown; code?: unknown; message?: unknown } | undefined
      try { error = (await response.clone().json()).error } catch { return response }
      const param = error?.param
      const rejected = typeof error?.code === 'string' && /^(unsupported_parameter|unknown_parameter)$/.test(error.code)
        || typeof error?.message === 'string' && /unsupported|not supported|unknown|unrecognized|unexpected/i.test(error.message)
      // Reason: only negotiate optional enhancements explicitly rejected before generation; never replay a started stream or drop user-selected effort.
      if (!rejected || typeof param !== 'string' || !['include', 'reasoning.summary'].includes(param) || unsupported.has(param)
        || param === 'reasoning.summary' && body.reasoning?.summary == null) return response
      unsupported.add(param)
      await response.body?.cancel()
    }
  }
}
