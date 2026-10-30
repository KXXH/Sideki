export function truncateToContextWindow(text: string, maxTokens: number): string {
  // Reason: reserve tokens for system prompt + model output
  const reservedTokens = 1000
  const availableTokens = maxTokens - reservedTokens
  // Reason: ~3 chars per token is a conservative cross-language estimate
  const maxChars = availableTokens * 3
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[Content truncated due to context window limit]'
}
