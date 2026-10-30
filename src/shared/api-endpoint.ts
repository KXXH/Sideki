// Reason: accept both API base URLs and pasted inference URLs without duplicating a protocol suffix.
export function apiBaseUrl(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/(responses|chat\/completions)$/, '')
}
