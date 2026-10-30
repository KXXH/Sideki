export const RESPONSES_USAGE = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 30 } }
export const IMAGE = 'data:image/png;base64,aGVsbG8='
export const reasoningItem = (id = 'rs_1') => ({ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'Checking the page.' }], encrypted_content: `encrypted-${id}` })
export const plainReasoningItem = (id = 'rs_plain') => ({ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text: 'Inspecting the page directly.' }] })
export const textItem = (text = 'OK', id = 'msg_1') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
export const callItem = (name: string, args: Record<string, unknown> = {}, id = 'call_1') => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' })
export function responseJson(output: object[] = [textItem()]) {
  return Response.json({ id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-6-luna', status: 'completed', output, usage: RESPONSES_USAGE })
}
export function event(type: string, extra: object = {}) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n` }
export function responseEvents(output: ReturnType<typeof textItem | typeof reasoningItem | typeof plainReasoningItem | typeof callItem>[] = [textItem()]) {
  let result = event('response.created', { response: { id: 'resp_1', created_at: 1, model: 'gpt-6-luna', status: 'in_progress' } })
  output.forEach((item, output_index) => {
    result += event('response.output_item.added', { output_index, item: item.type === 'reasoning' ? { ...item, encrypted_content: null } : item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } })
    if (item.type === 'message' && 'content' in item) result += event('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta: item.content[0].text })
    if (item.type === 'function_call' && 'arguments' in item) result += event('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments })
    if (item.type === 'reasoning' && 'content' in item) {
      result += event('response.reasoning_text.delta', { item_id: item.id, output_index, content_index: 0, delta: item.content[0].text })
      result += event('response.reasoning_text.done', { item_id: item.id, output_index, content_index: 0, text: item.content[0].text })
    }
    if (item.type === 'reasoning' && item.summary.length) {
      result += event('response.reasoning_summary_part.added', { item_id: item.id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' } })
      result += event('response.reasoning_summary_text.delta', { item_id: item.id, output_index, summary_index: 0, delta: item.summary[0].text })
      result += event('response.reasoning_summary_part.done', { item_id: item.id, output_index, summary_index: 0, part: item.summary[0] })
    }
    result += event('response.output_item.done', { output_index, item })
  })
  result += event('response.completed', { response: { id: 'resp_1', created_at: 1, model: 'gpt-6-luna', output, status: 'completed', usage: RESPONSES_USAGE } })
  return result
}
export function responseStream(output?: Parameters<typeof responseEvents>[0]) { return new Response(responseEvents(output), { headers: { 'content-type': 'text/event-stream' } }) }
