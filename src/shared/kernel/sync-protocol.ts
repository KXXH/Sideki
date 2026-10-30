import type { ChatStatus, UIMessage } from 'ai'
import type { SendItem } from './chat-kernel'

// Reason: panel sync is snapshot + rev-checked patches, never event replay.
// The kernel's materialized state IS the truth; a reconnecting panel takes a
// snapshot, an online panel applies contiguous patches and falls back to a
// resync on any rev gap. Pure functions only — no chrome API, fully unit
// testable, shared verbatim by both ends so mirrors can never drift.

export interface KernelSnapshotSource {
  rev: number
  sessionId: string
  messages: UIMessage[]
  status: ChatStatus
  // Reason: Error objects don't survive structured clone across ports intact —
  // the wire format carries the message string only.
  errorMessage: string | undefined
  queue: readonly SendItem[]
  compacting: boolean
  preparing: boolean
  // Reason: a send is in flight but the turn has not reached the SDK yet —
  // status is still 'ready', so this is the only signal that says "busy".
  dispatching: boolean
  // Reason: host-defined runtime metadata (session list, token stats…) —
  // small objects, carried whole in every frame instead of diffed.
  extras?: Record<string, unknown>
}

export interface SyncSnapshot {
  type: 'snapshot'
  rev: number
  sessionId: string
  messages: UIMessage[]
  status: ChatStatus
  errorMessage: string | undefined
  queue: SendItem[]
  compacting: boolean
  preparing: boolean
  // Reason: a send is in flight but the turn has not reached the SDK yet —
  // status is still 'ready', so this is the only signal that says "busy".
  dispatching: boolean
  extras?: Record<string, unknown>
}

export interface SyncPatch {
  type: 'patch'
  // Reason: the rev this patch was diffed against — apply only when the
  // mirror sits exactly at baseRev, otherwise the caller must resync.
  baseRev: number
  rev: number
  // Reason: authoritative length after the patch; shrinkage (compaction)
  // needs no per-index tombstones, the mirror just truncates.
  messageCount: number
  changed: { index: number; message: UIMessage }[]
  status: ChatStatus
  errorMessage: string | undefined
  queue: SendItem[]
  compacting: boolean
  preparing: boolean
  // Reason: a send is in flight but the turn has not reached the SDK yet —
  // status is still 'ready', so this is the only signal that says "busy".
  dispatching: boolean
  extras?: Record<string, unknown>
}

export interface PanelMirror {
  rev: number
  sessionId: string
  messages: UIMessage[]
  status: ChatStatus
  errorMessage: string | undefined
  queue: SendItem[]
  compacting: boolean
  preparing: boolean
  // Reason: a send is in flight but the turn has not reached the SDK yet —
  // status is still 'ready', so this is the only signal that says "busy".
  dispatching: boolean
  extras?: Record<string, unknown>
}

export function snapshotFrom(src: KernelSnapshotSource): SyncSnapshot {
  return {
    type: 'snapshot',
    rev: src.rev,
    sessionId: src.sessionId,
    messages: [...src.messages],
    status: src.status,
    errorMessage: src.errorMessage,
    queue: [...src.queue],
    compacting: src.compacting,
    preparing: src.preparing,
    dispatching: src.dispatching,
    extras: src.extras,
  }
}

export function applySnapshot(snap: SyncSnapshot): PanelMirror {
  return {
    rev: snap.rev,
    sessionId: snap.sessionId,
    messages: snap.messages,
    status: snap.status,
    errorMessage: snap.errorMessage,
    queue: snap.queue,
    compacting: snap.compacting,
    preparing: snap.preparing,
    dispatching: snap.dispatching,
    extras: snap.extras,
  }
}

// Reason: KernelChatState mutations always produce fresh message references
// (copy-on-write), so reference inequality is a complete change detector —
// no deep comparison, diff cost is O(n) pointer checks.
export function diffPatch(
  base: { rev: number; messages: UIMessage[] },
  src: KernelSnapshotSource,
): SyncPatch {
  const changed: { index: number; message: UIMessage }[] = []
  for (let i = 0; i < src.messages.length; i++) {
    if (base.messages[i] !== src.messages[i]) {
      changed.push({ index: i, message: src.messages[i] })
    }
  }
  return {
    type: 'patch',
    baseRev: base.rev,
    rev: src.rev,
    messageCount: src.messages.length,
    changed,
    status: src.status,
    errorMessage: src.errorMessage,
    queue: [...src.queue],
    compacting: src.compacting,
    preparing: src.preparing,
    dispatching: src.dispatching,
    extras: src.extras,
  }
}

// Reason: returns null instead of throwing — a gap or hole is a normal
// protocol event (missed patch, reordered delivery); the caller's contract
// is "null → request a fresh snapshot".
export function applyPatch(mirror: PanelMirror, patch: SyncPatch): PanelMirror | null {
  if (patch.baseRev !== mirror.rev) return null

  const next: (UIMessage | undefined)[] = mirror.messages.slice(0, patch.messageCount)
  next.length = patch.messageCount
  for (const c of patch.changed) {
    if (c.index < 0 || c.index >= patch.messageCount) return null
    next[c.index] = c.message
  }
  // Reason: growth beyond the mirror must be fully covered by changed
  // entries — an unfilled hole means the patch is corrupt.
  for (let i = 0; i < next.length; i++) {
    if (next[i] === undefined) return null
  }

  return {
    rev: patch.rev,
    sessionId: mirror.sessionId,
    messages: next as UIMessage[],
    status: patch.status,
    errorMessage: patch.errorMessage,
    queue: patch.queue,
    compacting: patch.compacting,
    preparing: patch.preparing,
    dispatching: patch.dispatching,
    extras: patch.extras ?? mirror.extras,
  }
}
