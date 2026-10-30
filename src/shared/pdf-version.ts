export const PDF_VERSION_ERROR = 'PDF content changed or its version is missing; reopen the document before continuing.'

export async function pdfDocumentVersion(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function assertPdfVersion(expected: unknown, actual: string): void {
  if (expected !== actual) throw new Error(PDF_VERSION_ERROR)
}
