function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function modelServiceError(error: unknown, phase: 'verify' | 'save', apiKey: string): string {
  let current: unknown = error
  let message = typeof error === 'string' ? error.trim() : ''
  let status: number | undefined
  for (let depth = 0; depth < 4 && current; depth++) {
    const value = record(current)
    if (typeof value.statusCode === 'number') status ??= value.statusCode
    if (!message && typeof value.message === 'string') message = value.message.trim()
    if (!message && typeof value.responseBody === 'string') {
      try {
        const body = record(JSON.parse(value.responseBody))
        const detail = record(body.error).message ?? body.message
        if (typeof detail === 'string') message = detail.trim()
      } catch { /* response bodies may be empty or HTML */ }
    }
    current = value.cause
  }
  // Reason: inference failures happen before persistence; empty SDK messages must still identify the failed operation.
  if (phase === 'verify') {
    if (status === 401 || status === 403 || /\b40[13]\b/.test(message)) return 'Key 无效或没有模型权限，请检查服务商控制台。'
    if (status === 404) return '连接验证失败：接口地址不存在（HTTP 404），请检查 API 地址和接口格式。'
    message = `连接验证失败${status ? `（HTTP ${status}）` : ''}：${message || '服务未返回错误详情，请检查 API 地址、接口格式和模型 ID。'}`
  } else message = `保存配置失败：${message || '请重试。'}`
  return (apiKey ? message.replaceAll(apiKey, '[Key]') : message).slice(0, 240)
}
