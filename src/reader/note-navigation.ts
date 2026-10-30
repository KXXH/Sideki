import type { PdfNote } from '../shared/pdf-note-store'

export interface PendingNoteJump {
  id: string
  page: number
  scrolledToPage: boolean
}

export function advanceNoteJump(
  pending: PendingNoteJump | null,
  notes: readonly PdfNote[],
  root: Pick<Document, 'getElementById'> = document,
): PendingNoteJump | null {
  if (!pending || !notes.some(n => n.id === pending.id && n.page === pending.page)) return null
  const page = root.getElementById(`pdf-page-${pending.page}`)
  if (!page) return pending
  const band = Array.from(page.querySelectorAll<HTMLElement>('[data-note-id]'))
    .find(el => el.dataset.noteId === pending.id)
  if (band) {
    band.scrollIntoView({ block: 'center' })
    return null
  }
  if (pending.scrolledToPage) return pending
  // Reason: the permanent page slot triggers lazy loading before an annotation band exists.
  page.scrollIntoView({ block: 'start' })
  return { ...pending, scrolledToPage: true }
}
