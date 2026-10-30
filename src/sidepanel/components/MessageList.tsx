import { TimerWakeEvent } from './ScheduledTaskStrip'
import { useState, useRef, useEffect, useMemo, useCallback, useId, memo, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'
import { motion, useAnimationFrame, animate } from 'motion/react'
import { motionValue } from 'motion'
import type { UIMessage } from 'ai'
import type { ToolCallDisplay } from '../../shared/types'
import type { ApprovalState } from '../../shared/approval-service'
import {
  iconCopy, iconRefresh, iconImage, iconCheck, iconLinkVariant,
  iconLoading, iconCheckCircle, iconBrain, iconCircleDot, iconThinking, iconQuote, iconCancel, iconChevronRight,
  iconAutoFix, iconCrosshairs, iconFileDocument,
  iconPermissionReview, iconPermissionDenied, iconPermissionError, iconToolError,
} from '../../shared/icons'
import type { EmptySuggestion, EmptyStateDeck } from '../empty-state-suggestions'
import AnimatedIcon from './AnimatedIcon'
import StreamingMarkdown from './StreamingMarkdown'
import VizFrame from './VizFrame'
import { copyMessageAsImage, type ExportStats } from '../utils/export-image'
import { loadConfig } from '../../shared/storage'
import { getMeta, isSkillPart, isElementPart, isFilePart, splitLegacyZws } from '../../shared/message-protocol'
import { derivePhase, type StatusPhase, type TrailingKind } from '../status-phase'
import { usePhaseLabel } from '../hooks/usePhaseLabel'
import { supportsToolDescription, toolDescription } from '../../shared/tool-description'

function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className={className}>
      <path fill="#d97757" d="m7.5 20.61l5.5-3.08l.1-.27l-.1-.15h-.27l-.92-.06a234 234 0 0 1-8.51-.34l-.67-.14l-.62-.82l.06-.41l.56-.38l.8.07c3.08.2 6.15.4 9.21.72h.46l.06-.19l-.16-.1l-.12-.12l-2.74-1.86c-2.04-1.3-3.55-2.43-5.38-3.68l-.43-.54l-.18-1.18l.76-.84l1.03.07l.26.07c2.03 1.6 4.1 3.14 6.17 4.66l.43.36l.17-.12l.02-.09l-.2-.32c-1.43-2.6-2.55-4.62-4-6.96l-.2-.72c-.08-.3-.13-.55-.13-.85l.87-1.18l.49-.16l1.16.16l.49.42c1.4 3.31 2.76 5.93 4.23 8.83l.29.97l.1.3h.19v-.17c.65-3.42 0-6.57 1.22-9.53l.87-.57l.68.33l.56.8l-.08.51c-.37 2.62-.92 5.22-1.4 7.82h.24l.29-.29a69 69 0 0 1 4.91-5.94l.64-.5h1.2l.89 1.32l-.4 1.36a53.5 53.5 0 0 0-4.66 6.47l.09.13l.22-.02c2.4-.57 4.84-.99 7.27-1.4l.97.45l.1.46l-.37.94c-3 .72-6 1.34-9 2.05l-.05.04l.06.07c2.7.26 5.62.3 7.99.47l.92.61l.55.75l-.1.56l-1.4.73c-2.93-.7-5.19-1.22-7.91-1.9h-.22v.13c2.18 2.12 4.6 4.27 6.54 6.07l.15.68l-.38.53l-.4-.06c-2.04-1.43-3.9-3.09-5.8-4.7h-.15v.2l.52.76c1.14 1.79 2.64 3.25 2.87 5.37l-.2.41l-.7.25l-.78-.14a73 73 0 0 1-4.58-7.04l-.17.09l-.78 8.46l-.37.43l-.85.33l-.71-.54l-.38-.87a114 114 0 0 0 1.53-7.97l.2-.73l-.01-.05l-.16.02a77 77 0 0 1-6.23 7.88l-.48.2l-.84-.44l.08-.77l.47-.69c2.07-2.57 3.54-4.66 5.54-7v-.19h-.07l-7.4 4.8l-1.31.17l-.57-.53l.07-.87l.27-.28l2.23-1.53z" />
    </svg>
  )
}

// Reason: SDK uses `tool-${name}` typed parts for known tools and `dynamic-tool`
// for unknown. We treat both uniformly via this helper type.
interface ToolCallInfo {
  toolName: string
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  rawInput?: unknown
  approval?: { approved?: boolean; reason?: string }
  reviewing?: boolean
}

function toolWasDenied(call: ToolCallInfo): boolean {
  return call.state === 'output-denied' || (call.state === 'approval-responded' && call.approval?.approved === false)
}

function toolApprovalFailed(call: ToolCallInfo): boolean {
  return toolWasDenied(call) && call.approval?.reason?.startsWith('审批未完成：') === true
}

function toolIsCalling(call: ToolCallInfo): boolean {
  return !toolWasDenied(call) && ['input-streaming', 'input-available', 'call', 'approval-requested', 'approval-responded'].includes(call.state)
}

function extractToolInfo(part: UIMessage['parts'][number]): ToolCallInfo | null {
  if (part.type === 'dynamic-tool') {
    return {
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      state: part.state,
      input: 'input' in part ? part.input : undefined,
      rawInput: 'rawInput' in part ? part.rawInput : undefined,
      output: part.state === 'output-available' ? part.output : undefined,
      errorText: part.state === 'output-error' ? part.errorText : undefined,
      approval: 'approval' in part ? part.approval : undefined,
    }
  }
  if (part.type.startsWith('tool-')) {
    const p = part as unknown as Record<string, unknown>
    return {
      toolName: (part.type as string).slice(5),
      toolCallId: p.toolCallId as string,
      state: p.state as string,
      input: p.input,
      rawInput: p.rawInput,
      output: p.state === 'output-available' ? p.output : undefined,
      errorText: p.state === 'output-error' ? (p.errorText as string) : undefined,
      approval: p.approval as ToolCallInfo['approval'],
    }
  }
  return null
}

function isToolPart(part: UIMessage['parts'][number]): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

// Reason: a finished visualize call renders as an inline frame at its position;
// while it is still running it stays an ordinary tool row.
function vizSnapshot(tool: ToolCallInfo): { path: string; title: string; network: boolean; canvasId: string } | null {
  if (tool.toolName !== 'visualize' || tool.state !== 'output-available') return null
  const output = tool.output
  if (!output || typeof output !== 'object') return null
  const { path, title, network, canvasId } = output as Record<string, unknown>
  if (typeof path !== 'string' || !path) return null
  return { path, title: typeof title === 'string' && title ? title : basenameOf(path), network: network === true, canvasId: typeof canvasId === 'string' && canvasId ? canvasId : `path:${path}` }
}

function basenameOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function shuffledIndices(size: number): number[] {
  const bag = Array.from({ length: size }, (_, i) => i)
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[bag[i], bag[j]] = [bag[j], bag[i]]
  }
  return bag
}

// Reason: one pool, one pointer, no exposure rules — the slot rotates by hand.
function useRotatingSuggestion(size: number) {
  const [state, setState] = useState(() => ({ bag: shuffledIndices(size), pos: 0 }))
  const index = state.bag[state.pos] ?? 0
  const next = () => {
    setState((s) => {
      if (s.pos + 1 < s.bag.length) return { ...s, pos: s.pos + 1 }
      const bag = shuffledIndices(size)
      // Reason: avoid the same utterance twice across a bag boundary.
      if (size > 1 && bag[0] === s.bag[s.pos]) [bag[0], bag[1]] = [bag[1], bag[0]]
      return { bag, pos: 0 }
    })
  }
  return [index, next] as const
}

function SuggestionRow({ suggestion, onSend, onSwap }: {
  suggestion: EmptySuggestion
  onSend: (prompt: string) => void
  onSwap?: () => void
}) {
  return (
    <div className="group/example flex items-center gap-2 border-b border-border-muted py-3">
      <button
        onClick={() => onSend(suggestion.prompt)}
        className="min-w-0 flex-1 text-left text-[13px] leading-[1.5] text-text-primary transition-colors group-hover/example:text-accent"
      >
        <span className="text-text-muted">“</span>{suggestion.say}<span className="text-text-muted">”</span>
      </button>
      {onSwap && (
        <button
          onClick={onSwap}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] leading-[1.4] text-text-muted transition-colors hover:bg-surface-overlay hover:text-accent"
        >
          <span className="mr-0.5 font-mono">↻</span>换一个
        </button>
      )}
      <span aria-hidden="true" className="shrink-0 font-mono text-[16px] leading-none text-text-muted transition-colors group-hover/example:text-accent">›</span>
    </div>
  )
}

function MoreSuggestions({ items, onSend }: {
  items: EmptySuggestion[]
  onSend: (prompt: string) => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorName = `--empty-more-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative mt-2.5">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        style={{ anchorName } as CSSProperties}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[10.5px] leading-[1.5] text-text-muted transition-colors hover:text-accent"
      >
        更多玩法<span aria-hidden="true" className="font-mono text-[13px] leading-none">›</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            positionAnchor: anchorName,
            bottom: 'anchor(top)',
            left: 'anchor(left)',
            positionTryFallbacks: 'flip-block, flip-inline',
          } as CSSProperties}
          className="theme-overlay animate-slide-up-in fixed z-50 mb-1.5 w-[calc(100vw-3rem)] max-w-[420px] overflow-hidden rounded-lg p-1"
        >
          <div className="px-2 pb-1 pt-1.5">
            <div className="text-[12px] font-medium text-text-primary">更多玩法</div>
            <div className="mt-0.5 text-[10px] leading-[1.5] text-text-muted">挑一个说法，点一下就行。</div>
          </div>
          {items.map((suggestion) => (
            <button
              key={suggestion.name}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onSend(suggestion.prompt)
              }}
              className="group/item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-overlay"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[10px] leading-[1.4] text-text-muted">{suggestion.name}</span>
                <span className="text-[11.5px] leading-[1.5] text-text-secondary transition-colors group-hover/item:text-accent">{suggestion.say}</span>
              </span>
              <span aria-hidden="true" className="shrink-0 font-mono text-[14px] leading-none text-text-muted transition-colors group-hover/item:text-accent">›</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

interface EmptyStateProps {
  deck: EmptyStateDeck
  pageHost?: string
  onSend: (prompt: string) => void
}

export function EmptyState({ deck, pageHost, onSend }: EmptyStateProps) {
  const [rotatingIndex, rotate] = useRotatingSuggestion(deck.pool.length)
  const rotating = deck.pool[rotatingIndex]

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-[420px]" style={{ animation: "empty-rise 400ms ease-out both" }}>
        <div className="flex items-center gap-1.5 text-[10px] leading-[1.4] tracking-[0.035em] text-text-muted">
          <span className="h-1 w-1 shrink-0 bg-accent" />
          <span className="truncate">{pageHost ? `当前页面 · ${pageHost}` : "当前页面"}</span>
        </div>
        <h2 className="mt-3.5 text-[21px] font-semibold leading-[1.38] text-text-primary">{deck.heading}</h2>
        <p className="mt-2 text-[11.5px] leading-[1.65] text-text-secondary">{deck.sub}</p>
        <div className="mt-5 border-t border-border-subtle">
          {deck.fixed.map((suggestion) => (
            <SuggestionRow key={suggestion.name} suggestion={suggestion} onSend={onSend} />
          ))}
          {rotating && (
            <SuggestionRow
              suggestion={rotating}
              onSend={onSend}
              onSwap={deck.pool.length > 1 ? rotate : undefined}
            />
          )}
        </div>
        {deck.pool.length > 0 && <MoreSuggestions items={deck.pool} onSend={onSend} />}
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: UIMessage | null
  isStreaming: boolean
  isLast: boolean
  pendingPhase?: StatusPhase
  onRegenerate?: (messageId: string) => void
  fromBridge?: boolean
  relayedToCC?: boolean
  sessionId?: string
  pageRef?: { url: string; title: string } | null
  toolCallDisplay?: ToolCallDisplay
  approvalState?: Pick<ApprovalState, 'status' | 'toolCallId'>
}

// Reason: memoized — the mirror patch stream re-renders ChatView every 80ms
// during streaming, but untouched messages keep their references (kernel
// copy-on-write + applyPatch index merge), so shallow compare skips them all.
export const MessageBubble = memo(function MessageBubble({ message, isStreaming, isLast, pendingPhase = 'idle', onRegenerate, fromBridge, relayedToCC, sessionId, pageRef, toolCallDisplay = 'description', approvalState }: MessageBubbleProps) {
  const collapseSteps = useCollapseSteps()
  const captureRef = useRef<HTMLDivElement>(null)
  const isActiveMsg = isLast && (isStreaming || pendingPhase !== 'idle')
  // Reason: a reply that was already visible while waiting must not replay its entrance on completion.
  const [wasActive, setWasActive] = useState(isActiveMsg)
  if (isActiveMsg && !wasActive) setWasActive(true)

  if (message?.role === 'user') {
    const timerMeta = getMeta(message)
    const canvasTitles = message.parts.filter(p => p.type === 'data-canvas-context')
      .flatMap(p => (p as unknown as { data: Array<{ title: string }> }).data).map(s => s.title)
    if (timerMeta?.source === 'timer' && timerMeta.timer) return <TimerWakeEvent wake={timerMeta.timer} />
    const isV2 = getMeta(message)?.v === 2
    const images = message.parts.filter(p => p.type === 'file' && p.mediaType?.startsWith('image/'))
    const skillParts = message.parts.filter(isSkillPart)
    const elementParts = message.parts.filter(isElementPart)
    const fileParts = message.parts.filter(isFilePart)
    const texts = message.parts
      .filter(p => p.type === 'text')
      // Reason: v2 text parts are pure user input; legacy parts need ZWS splitting
      .map(p => (p.type === 'text' ? (isV2 ? p.text : splitLegacyZws(p.text)) : ''))
      .filter(Boolean)
    // Reason: corner quote badge only for legacy messages — v2 renders element chips instead
    const hasQuote = !isV2 && message.parts.some(p => p.type === 'text' && p.text.includes('[Selected element:'))
    return (
      <div className="animate-fade-in-up flex justify-end">
        <div
          className="relative min-w-0 max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-br from-user-bubble to-user-bubble/70 px-3.5 py-2.5 leading-relaxed text-user-bubble-text ring-1 ring-border-subtle/50 select-text"
          style={{ fontFamily: 'var(--font-content)', fontSize: 'var(--font-content-size)' }}
        >
          {(fromBridge || hasQuote) && (
            <span className="absolute -bottom-1.5 -left-1.5 flex items-center">
              {fromBridge && (
                <span className="group/cc relative z-10">
                  <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-surface shadow-sm ring-1 ring-border-muted">
                    <ClaudeIcon className="h-3 w-3" />
                  </span>
                  <span className="theme-raised pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-surface-overlay px-1.5 py-0.5 text-[9px] text-text-secondary opacity-0 ring-1 ring-border-subtle transition-opacity group-hover/cc:opacity-100">从 Claude Code 发送</span>
                </span>
              )}
              {hasQuote && (
                <span className={`group/qt relative ${fromBridge ? '-ml-1.5 z-0' : 'z-10'}`}>
                  <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-surface shadow-sm ring-1 ring-border-muted text-accent">
                    <Icon icon={iconQuote} className="h-3 w-3" />
                  </span>
                  <span className="theme-raised pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-surface-overlay px-1.5 py-0.5 text-[9px] text-text-secondary opacity-0 ring-1 ring-border-subtle transition-opacity group-hover/qt:opacity-100">包含引用内容</span>
                </span>
              )}
            </span>
          )}
          {images.map((p, i) => (
            <img key={i} src={p.type === 'file' ? p.url : ''} alt="Selected element" className="mb-1.5 max-h-32 rounded-lg" />
          ))}
          {/* Reason: skill command renders as an inline-code style chip before the text */}
          {skillParts.map((p, i) => (
            <span key={`sk-${i}`} className="mr-1.5 inline-flex translate-y-px items-center gap-1 rounded-md bg-surface/80 px-1.5 py-0.5 align-baseline font-mono text-[12px] leading-none text-accent ring-1 ring-border-muted">
              <Icon icon={iconAutoFix} className="h-3 w-3" />
              /{p.data.name}
            </span>
          ))}
          {/* Reason: encoded URL queries can have no natural breakpoints; wrap within the bubble without changing copied text. */}
          {texts.map((t, i) => <span key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{t}</span>)}
          {(canvasTitles.length > 0 || timerMeta?.canvasSource) && (
            <span className="mt-1.5 block text-[11px] text-text-secondary">
              {timerMeta?.canvasSource ? `来自画布：${timerMeta.canvasSource.title}` : `画布状态：${canvasTitles.join('、')}`}
            </span>
          )}
          {/* Reason: element attachments render as chips at the end of the bubble */}
          {elementParts.length > 0 && (
            <span className={`flex flex-wrap gap-1 ${texts.length > 0 || skillParts.length > 0 ? 'mt-1.5' : ''}`}>
              {elementParts.map((p, i) => (
                <span key={`el-${i}`} title={p.data.snapshot.slice(0, 300)} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface/80 px-1.5 py-0.5 font-mono text-[11px] leading-none text-text-secondary ring-1 ring-border-muted">
                  <Icon icon={iconCrosshairs} className="h-3 w-3 shrink-0 text-accent" />
                  <span className="truncate">{p.data.label}</span>
                </span>
              ))}
            </span>
          )}
          {/* Reason: uploaded files leave no other trace in the bubble — the model reads them from the VFS */}
          {fileParts.length > 0 && (
            <span className={`flex flex-wrap gap-1 ${texts.length > 0 || skillParts.length > 0 || elementParts.length > 0 ? 'mt-1.5' : ''}`}>
              {fileParts.map((p, i) => (
                <span key={`fl-${i}`} title={p.data.path} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface/80 px-1.5 py-0.5 font-mono text-[11px] leading-none text-text-secondary ring-1 ring-border-muted">
                  <Icon icon={iconFileDocument} className="h-3 w-3 shrink-0 text-accent" />
                  <span className="truncate">{p.data.name}</span>
                  <span className="shrink-0 text-text-muted">{p.data.size < 1024 * 1024 ? `${Math.round(p.data.size / 1024)}KB` : `${(p.data.size / (1024 * 1024)).toFixed(1)}MB`}</span>
                  {/* Reason: PDF uploads are readable in the annotation reader — chip stays inert for other files */}
                  {/\.pdf$/i.test(p.data.name) && sessionId && (
                    <button
                      type="button"
                      className="ml-0.5 shrink-0 rounded-sm px-1 text-[10px] text-accent hover:bg-accent/10"
                      onClick={() => {
                        chrome.runtime.sendMessage({
                          type: 'pdfdoc:open-reader',
                          sessionId,
                          path: p.data.path,
                        }).catch(() => {})
                      }}
                    >阅读器</button>
                  )}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    )
  }

  const parts = message?.parts ?? []
  const hasText = parts.some(p => p.type === 'text' && p.text.trim())
  const hasToolCalls = parts.some(isToolPart)

  if (!hasText && !hasToolCalls && !isActiveMsg) {
    return null
  }

  const groups: GroupItem[] = []
  let toolBatch: ToolCallInfo[] = []
  const flushToolBatch = () => {
    if (toolBatch.length === 0) return
    groups.push({ kind: 'tools', calls: [...toolBatch] })
    toolBatch = []
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // Reason: text-start has no visible content yet and must not remove the waiting header.
    if (part.type === 'text' && !part.text.trim()) continue
    const toolInfo = extractToolInfo(part)
    if (toolInfo) {
      toolInfo.reviewing = isActiveMsg && approvalState?.status === 'reviewing' && approvalState.toolCallId === toolInfo.toolCallId
      const viz = vizSnapshot(toolInfo)
      if (viz) {
        flushToolBatch()
        groups.push({ kind: 'viz', path: viz.path, title: viz.title, network: viz.network, canvasId: viz.canvasId, toolCallId: toolInfo.toolCallId })
      } else {
        toolBatch.push(toolInfo)
      }
    } else {
      flushToolBatch()
      groups.push({ kind: 'part', part, idx: i })
    }
  }
  flushToolBatch()

  // Reason: second pass — merge consecutive non-text groups into a single collapsible StepsCollapse.
  // Only active when collapseSteps setting is on (default).
  const displayGroups: DisplayItem[] = []
  if (collapseSteps) {
    let stepRun: GroupItem[] = []
    const flushSteps = (trailing: boolean) => {
      // Reason: the placeholder and tools keep one steps parent through text
      // start and turn completion, preserving in-flight title transitions.
      if (trailing && isActiveMsg && (stepRun.length > 0 || groups.length === 0)) {
        displayGroups.push({ kind: 'steps', items: [...stepRun] })
      } else if (stepRun.some(g => g.kind === 'tools' || (g.kind === 'part' && g.part.type === 'reasoning'))) {
        displayGroups.push({ kind: 'steps', items: [...stepRun] })
      }
      stepRun = []
    }
    for (const g of groups) {
      // Reason: an inline visualization is a content block, not a step — it
      // keeps its position and never collapses into the steps drawer.
      const isContent = g.kind === 'viz' || (g.kind === 'part' && g.part.type === 'text')
      if (isContent) {
        flushSteps(false)
        displayGroups.push(g)
      } else {
        stepRun.push(g)
      }
    }
    flushSteps(true)
  }
  const renderGroups: DisplayItem[] = collapseSteps ? displayGroups : groups

  // Reason: only the trailing steps group is actively receiving content during streaming
  const lastStepsIdx = isActiveMsg ? renderGroups.findLastIndex(g => g.kind === 'steps') : -1

  // Reason: the in-bubble status speaks for a live message only — a finished
  // one has its counts instead.
  const phase: StatusPhase = isActiveMsg
    ? pendingPhase !== 'idle' ? pendingPhase : derivePhase({ status: 'streaming', preparing: false, dispatching: false, trailing: trailingKindOf(renderGroups) })
    : 'idle'

  return (
    <div className={!isActiveMsg && !wasActive ? 'animate-fade-in-up' : ''}>
      <div ref={captureRef}>
        {renderGroups.map((g, gi) => {
          if (g.kind === 'steps') {
            return <StepsCollapse key={`sc-${gi}`} items={g.items} isActive={gi === lastStepsIdx} phase={phase} display={toolCallDisplay} />
          }
          if (g.kind === 'tools') {
            return <ToolCallGroup key={`tg-${gi}`} calls={g.calls} isActive={isActiveMsg} display={toolCallDisplay} />
          }
          if (g.kind === 'viz') {
            return (
              <VizFrame
                key={`viz-${g.toolCallId}`}
                canvasId={g.canvasId}
                sessionId={sessionId ?? ''}
                path={g.path}
                title={g.title}
                network={g.network}
              />
            )
          }
          const { part, idx } = g
          if (part.type === 'reasoning') {
            return <ReasoningBlock key={idx} text={part.text} isStreaming={isStreaming && idx === parts.length - 1} />
          }
          if (part.type === 'text') {
            if (!part.text.trim()) return null
            // Reason: strip relay metadata suffix appended after successful CC delivery
            const zwsIdx = part.text.indexOf('​[relayed:')
            const displayText = zwsIdx >= 0 ? part.text.slice(0, zwsIdx) : part.text
            if (!displayText.trim()) return null
            return (
              <div key={idx} data-export="keep">
                <StreamingMarkdown
                  content={displayText}
                  isStreaming={isStreaming && idx === parts.length - 1}
                  sessionId={sessionId}
                />
              </div>
            )
          }
          return null
        })}
        {isActiveMsg && !collapseSteps && <StreamingStatus phase={phase} />}
        {!isActiveMsg && pageRef && (
          <div className="flex items-center gap-1 px-0 pt-1 text-[10px] text-text-muted animate-fade-in">
            <Icon icon={iconLinkVariant} className="shrink-0 text-[10px]" />
            <button
              onClick={() => chrome.tabs.create({ url: pageRef.url })}
              title={`${pageRef.title}\n${pageRef.url}`}
              className="min-w-0 truncate transition-colors hover:text-text-secondary"
            >
              来源 · {hostnameOf(pageRef.url)}
            </button>
          </div>
        )}
      </div>
      {!isActiveMsg && message?.role === 'assistant' && hasText && (
        <MessageActions message={message} isLast={isLast} onRegenerate={getMeta(message)?.source === 'timer' ? undefined : onRegenerate} relayedToCC={relayedToCC} captureRef={captureRef} />
      )}
    </div>
  )
})

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

// Reason: visualize inputs only reference a VFS file — never echo file contents
// in the tool row. Shared by the one-line summary and the expanded detail.
function vizInputLines(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as Record<string, unknown>
  const lines: string[] = []
  if (typeof obj.title === 'string' && obj.title) lines.push(`title: ${obj.title}`)
  if (typeof obj.path === 'string' && obj.path) lines.push(`path: ${obj.path}`)
  return lines
}

function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  if (toolName === 'visualize') {
    const obj = input as Record<string, unknown>
    const text = typeof obj.title === 'string' && obj.title
      ? `${obj.title} · ${typeof obj.path === 'string' ? obj.path : ''}`
      : typeof obj.path === 'string' ? obj.path : ''
    return text.length > 40 ? text.slice(0, 40) + '…' : text
  }
  const first = Object.entries(input as Record<string, unknown>).find(([key, v]) => key !== 'description' && typeof v === 'string')
  if (!first) return ''
  const val = first[1] as string
  return val.length > 40 ? val.slice(0, 40) + '…' : val
}

function extractDataUrl(output: unknown): string | null {
  if (typeof output === 'string') {
    try {
      const obj = JSON.parse(output)
      if (obj?.dataUrl?.startsWith('data:image/')) return obj.dataUrl
    } catch { /* not JSON */ }
  } else if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if (typeof obj.dataUrl === 'string' && obj.dataUrl.startsWith('data:image/')) return obj.dataUrl
  }
  return null
}

function formatInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  if (toolName === 'visualize') return vizInputLines(input).join('\n')
  const obj = input as Record<string, unknown>
  // Reason: bash tools — show command directly, it's the only thing users care about
  if ('command' in obj && typeof obj.command === 'string') return obj.command
  const lines: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'description' && supportsToolDescription(toolName)) continue
    if (v === undefined || v === null) continue
    const val = typeof v === 'string' ? v : JSON.stringify(v)
    lines.push(`${k}: ${val}`)
  }
  return lines.join('\n')
}

function ToolCallItem({ call, isActive, display }: { call: ToolCallInfo; isActive?: boolean; display: ToolCallDisplay }) {
  const [expanded, setExpanded] = useState(false)
  const isCalling = toolIsCalling(call)
  const isDenied = toolWasDenied(call)
  const isInterrupted = isCalling && !isActive
  const isRunning = isCalling && !isInterrupted
  const isDone = call.state === 'output-available' || call.state === 'result'
  const isError = call.state === 'output-error' || isDenied
  const isReviewing = isRunning && (call.reviewing || call.state === 'approval-requested')
  const detail = isDenied ? (call.approval?.reason || '此操作未获批准') : isInterrupted ? 'Interrupted' : isError ? (call.errorText || '') : (isDone ? (typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? '')) : '')
  const approvalFailed = toolApprovalFailed(call)
  const hasError = isError || isInterrupted || detail.startsWith('Error:')
  const statusIcon = isReviewing ? iconPermissionReview : isRunning ? iconLoading : isInterrupted ? iconCancel : isDenied ? (approvalFailed ? iconPermissionError : iconPermissionDenied) : hasError ? iconToolError : iconCheckCircle
  const statusCls = isReviewing ? 'text-text-muted animate-approval-breathe' : isRunning ? 'text-text-muted animate-spin' : isInterrupted || approvalFailed ? 'text-warning' : hasError ? 'text-error' : 'text-text-muted'
  const statusText = isReviewing ? '确认操作…' : isRunning && call.state !== 'input-streaming' ? '执行中…' : isDenied ? (approvalFailed ? '确认异常' : '已拒绝') : hasError && !isInterrupted ? '调用失败' : ''
  const imageUrl = !hasError && call.toolName === 'screenshot' ? extractDataUrl(call.output) : null
  const inputText = formatInput(call.toolName, call.input)
  const describedTool = supportsToolDescription(call.toolName)
  const description = display !== 'raw' && describedTool ? toolDescription(call) : null
  const label = description ?? call.toolName
  const inputSummary = summarizeInput(call.toolName, call.input)

  return (
    <div className="py-0.5 animate-fade-in">
      <button
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        title={`${call.toolName} · ${label}`}
        className={`flex max-w-full items-center gap-1 text-[11px] transition-colors ${hasError && !isDenied ? 'text-error/60 hover:text-error' : 'text-text-muted hover:text-text-secondary'}`}
      >
        <Icon icon={statusIcon} aria-hidden="true" className={`shrink-0 text-xs ${statusCls}`} />
        <span className="flex min-w-0 items-center gap-1">
          <span className="tool-title-viewport">
            <SwapSlot content={{ kind: 'label', text: label, mono: !description }} truncate shimmer={isRunning} />
          </span>
          {!expanded && !description && inputSummary && (
            <span className="truncate text-text-muted">{inputSummary}</span>
          )}
          {statusText && <span role="status" className={`shrink-0 whitespace-nowrap text-[10px] ${isDenied && !approvalFailed ? 'inline-flex items-center rounded-[2px] bg-error/8 px-1 py-px leading-none text-error' : approvalFailed ? 'text-warning' : hasError ? 'text-error' : 'text-text-muted'}`}>
            <SwapSlot content={{ kind: 'label', text: statusText }} />
          </span>}
        </span>
      </button>
      <div className={`expand-panel ${expanded ? 'is-open' : ''}`}>
        <div>
          <div className="mt-1 px-3 font-mono text-[10px] text-text-muted">{call.toolName}</div>
          {inputText && (
            <pre className="mt-1 whitespace-pre-wrap break-all rounded-md px-3 py-2 font-mono text-[11px] leading-relaxed bg-surface-overlay text-text-secondary">
              {inputText.slice(0, 500)}
            </pre>
          )}
          {imageUrl ? (
            <a href={imageUrl} target="_blank" rel="noopener noreferrer">
              <img src={imageUrl} alt="Screenshot" className="mt-1 max-w-full cursor-pointer rounded-md border border-border-muted transition-opacity hover:opacity-80" />
            </a>
          ) : detail ? (
            <pre className="mt-1 whitespace-pre-wrap break-all rounded-md px-3 py-2 font-mono text-[11px] leading-relaxed bg-surface-overlay/50 text-text-muted">
              {detail.slice(0, 500)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ToolCallGroup({ calls, isActive, display }: { calls: ToolCallInfo[]; isActive?: boolean; display: ToolCallDisplay }) {
  const [expanded, setExpanded] = useState(false)
  const doneCount = calls.filter(c => c.state === 'output-available' || c.state === 'result').length
  const errorCount = calls.filter(c => c.state === 'output-error').length
  const deniedCount = calls.filter(c => toolWasDenied(c) && !toolApprovalFailed(c)).length
  const approvalErrorCount = calls.filter(toolApprovalFailed).length
  const finishedCount = doneCount + errorCount + deniedCount + approvalErrorCount
  const callingCount = calls.filter(toolIsCalling).length

  return (
    <div className="my-0.5 animate-fade-in">
      {calls.length > 1 && <button
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1 py-0.5 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
      >
        <Icon icon={callingCount > 0 && isActive ? iconLoading : iconCircleDot} className={`text-xs shrink-0 ${callingCount > 0 && isActive ? 'text-text-muted animate-spin' : 'text-text-muted'}`} />
        <span>查看 {calls.length} 个步骤</span>
        {errorCount > 0 && <span className="shrink-0 text-error/60">· {errorCount} 个失败</span>}
        {deniedCount > 0 && <span className="shrink-0 text-error/60">· {deniedCount} 个已拒绝</span>}
        {approvalErrorCount > 0 && <span className="shrink-0 text-warning">· {approvalErrorCount} 个确认异常</span>}
        {callingCount > 0 && isActive && (
          <span className="ml-auto shrink-0 text-text-muted">
            {finishedCount}/{calls.length}
          </span>
        )}
      </button>}
      <div className={calls.length > 1 ? `expand-panel ${expanded ? 'is-open' : ''}` : undefined}>
        <div className={calls.length > 1 ? 'pl-1 pt-0.5' : undefined}>
          {calls.map(c => <ToolCallItem key={c.toolCallId} call={c} isActive={isActive} display={display} />)}
        </div>
      </div>
    </div>
  )
}

function ReasoningBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="my-0.5 animate-fade-in">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 py-0.5 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
      >
        <Icon icon={iconBrain} className="text-xs text-text-muted" />
        <span className={isStreaming ? 'shimmer-sweep inline-block' : ''}>深度思考</span>
      </button>
      <div className={`expand-panel ${open ? 'is-open' : ''}`}>
        <div
          className="pl-1 pt-1 text-[11px] leading-relaxed text-text-muted whitespace-pre-wrap"
          style={{ fontFamily: 'var(--font-content)' }}
        >
          {text}
        </div>
      </div>
    </div>
  )
}

function useCollapseSteps(): boolean {
  const [collapse, setCollapse] = useState(true)
  useEffect(() => {
    loadConfig().then(c => { if (c?.collapseSteps === false) setCollapse(false) })
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.sidekick_config) {
        const val = changes.sidekick_config.newValue?.collapseSteps
        setCollapse(val !== false)
      }
    }
    chrome.storage.local.onChanged.addListener(handler)
    return () => chrome.storage.local.onChanged.removeListener(handler)
  }, [])
  return collapse
}

type GroupItem =
  | { kind: 'part'; part: UIMessage['parts'][number]; idx: number }
  | { kind: 'tools'; calls: ToolCallInfo[] }
  | { kind: 'viz'; path: string; title: string; network: boolean; toolCallId: string; canvasId: string }
type DisplayItem = GroupItem | { kind: 'steps'; items: GroupItem[] }

function InlineReasoning({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
      >
        <Icon icon={iconBrain} className="text-xs text-text-muted" />
        <span className={isStreaming ? 'shimmer-sweep inline-block' : ''}>深度思考</span>
      </button>
      <div className={`expand-panel ${open ? 'is-open' : ''}`}>
        <div>
          <div
            className="pl-1 pt-1 text-[11px] leading-relaxed text-text-muted whitespace-pre-wrap"
            style={{ fontFamily: 'var(--font-content)' }}
          >
            {text}
          </div>
        </div>
      </div>
    </div>
  )
}

// Reason: a steps group only ever holds non-text runs, so the last item is
// either a tool batch or a reasoning part.
function trailingKindOf(groups: DisplayItem[]): TrailingKind {
  const last = groups[groups.length - 1]
  if (!last) return 'none'
  if (last.kind === 'tools') return 'tool'
  if (last.kind === 'viz') return 'none'
  if (last.kind === 'steps') {
    const inner = last.items[last.items.length - 1]
    if (!inner) return 'none'
    if (inner.kind === 'tools') return 'tool'
    if (inner.kind !== 'part') return 'none'
    return inner.part.type === 'reasoning' ? 'reasoning' : 'none'
  }
  if (last.part.type === 'text') return 'text'
  return last.part.type === 'reasoning' ? 'reasoning' : 'none'
}

// Reason: only used when collapseSteps is off — no steps groups exist in that mode
function StreamingStatus({ phase }: { phase: StatusPhase }) {
  const label = usePhaseLabel(phase)

  return (
    <div className="my-0.5 animate-fade-in">
      <span className="flex items-center gap-1 py-0.5 text-[11px] text-text-muted">
        <LinesIndicator active={true} phase={phase} />
        <SwapSlot content={{ kind: 'label', text: label }} />
      </span>
    </div>
  )
}

export function LinesIndicator({ active, phase }: { active: boolean; phase: StatusPhase }) {
  const [diagnosticId] = useState(() => crypto.randomUUID().slice(0, 8))
  // Reason: capture the mount-time value only; state initializer is the lint-safe way to do this
  const [initialActive] = useState(active)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lines = useMemo(() => Array.from({ length: 6 }, (_, i) => motionValue(initialActive ? 0 : i * 30)), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const opacities = useMemo(() => Array.from({ length: 6 }, (_, i) => motionValue(initialActive ? 1 - i * 0.15 : 0.5 - i * 0.06)), [])
  const elapsedRef = useRef(0)
  const lastTimeRef = useRef<number | null>(null)
  const wasActiveRef = useRef(active)
  const animsRef = useRef<Array<{ stop: () => void }>>([])

  useAnimationFrame(time => {
    if (!active) {
      lastTimeRef.current = null
      return
    }
    if (lastTimeRef.current === null) {
      lastTimeRef.current = time
      return
    }
    const delta = time - lastTimeRef.current
    lastTimeRef.current = time
    elapsedRef.current += delta

    const dur = 900
    for (let i = 0; i < 6; i++) {
      const delay = dur * (0.375 - i * 0.075)
      const t = ((elapsedRef.current - delay) % (dur * 2) + dur * 2) % (dur * 2)
      let p: number
      if (t < dur) {
        p = t / dur
      } else {
        p = 1 - (t - dur) / dur
      }
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
      lines[i].set(eased * 180)
    }
  })

  useEffect(() => {
    if (wasActiveRef.current && !active) {
      animsRef.current.forEach(a => a.stop())
      animsRef.current = [
        ...lines.map((l, i) => animate(l, i * 30, { duration: 0.5, ease: 'easeOut' })),
        ...opacities.map((o, i) => animate(o, 0.5 - i * 0.06, { duration: 0.4, ease: 'easeOut' })),
      ]
    }
    if (!wasActiveRef.current && active) {
      animsRef.current.forEach(a => a.stop())
      animsRef.current = opacities.map((o, i) => animate(o, 1 - i * 0.15, { duration: 0.3, ease: 'easeOut' }))
      elapsedRef.current = 0
    }
    wasActiveRef.current = active
    return () => { animsRef.current.forEach(a => a.stop()) }
  }, [active, lines, opacities])

  useEffect(() => {
    console.info(`[reply-slot] mount id=${diagnosticId}`)
    return () => console.info(`[reply-slot] unmount id=${diagnosticId}`)
  }, [diagnosticId])

  useEffect(() => {
    console.info(`[reply-slot] phase id=${diagnosticId} phase=${phase} active=${active} elapsedMs=${Math.round(elapsedRef.current)} angle=${lines[0].get().toFixed(1)}`)
  }, [diagnosticId, phase, active, lines])

  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: 14, height: 14 }}>
      {lines.map((rot, i) => (
        <motion.span
          key={i}
          className="absolute left-0 top-[calc(50%-1px)] h-[2px] w-full rounded-full bg-current"
          style={{ rotate: rot, opacity: opacities[i] }}
        />
      ))}
    </span>
  )
}

const ROLL_STEPS = 2
const SWAP_OUT_MS = 400

type SlotContent = { kind: 'label'; text: string; mono?: boolean } | { kind: 'count'; count: number }

// Reason: the ghost is the real number — it carries the width, the baseline and the
// accessible name — while the reel overlays one column per digit, each column a strip
// whose first row is the final digit (the rest are the digits it drops past).
function RollingNumber({ value, roll }: { value: number; roll: boolean }) {
  return (
    <span className={roll ? 'roll-num' : 'roll-num roll-static'}>
      <span className="roll-ghost">{value}</span>
      <span className="roll-reel" aria-hidden="true">
        {[...String(value)].map((ch, i) => (
          <span key={i}>
            <span
              className="roll-strip"
              style={{ '--roll-delay': `${i * 45}ms`, '--roll-steps': ROLL_STEPS } as CSSProperties}
            >
              {Array.from({ length: ROLL_STEPS + 1 }, (_, j) => (
                <i key={j}>{(Number(ch) + j) % 10}</i>
              ))}
            </span>
          </span>
        ))}
      </span>
    </span>
  )
}

function SlotBody({ content, animate, shimmer = false }: { content: SlotContent; animate: boolean; shimmer?: boolean }) {
  if (content.kind === 'label') return <span className={`inline-block ${content.mono ? 'font-mono' : ''} ${shimmer ? 'shimmer-sweep' : ''}`}>{content.text}</span>
  return <>查看 <RollingNumber value={content.count} roll={animate} /> 个步骤</>
}

// Reason: the outgoing text has to stay mounted through its fade, and only a state
// adjustment during render (React's documented pattern) keeps it around — a plain prop
// swap would unmount it on the same frame the new text appears.
export function SwapSlot({ content, truncate = false, shimmer = false }: { content: SlotContent; truncate?: boolean; shimmer?: boolean }) {
  const id = content.kind === 'label' ? `label:${content.text}` : `count:${content.count}`
  // Reason: capture the mount-time value only; state initializer is the lint-safe way to do this
  const [initialId] = useState(id)
  const [slot, setSlot] = useState<{ id: string; content: SlotContent; out: SlotContent | null }>({ id, content, out: null })
  if (slot.id !== id) setSlot({ id, content, out: slot.content })
  // Reason: only a content change animates — the first render rides whatever entrance
  // the message itself plays, so reopening the panel does not replay every count.
  const animate = slot.id !== initialId

  useEffect(() => {
    if (!slot.out) return
    const timer = window.setTimeout(() => setSlot(s => (s.out ? { ...s, out: null } : s)), SWAP_OUT_MS)
    return () => window.clearTimeout(timer)
  }, [slot])

  return (
    <span className={`relative inline-block whitespace-nowrap ${truncate ? 'max-w-full align-bottom' : ''}`}>
      {slot.out && (
        <span className={`swap-out absolute left-0 top-0 whitespace-nowrap ${truncate ? 'max-w-full truncate' : ''}`}>
          <SlotBody content={slot.out} animate={false} shimmer={shimmer} />
        </span>
      )}
      {/* Reason: keyed by content so the enter animation restarts — in-place text
          updates do not retrigger a CSS animation. */}
      <span
        key={slot.id}
        className={`${truncate ? 'inline-block max-w-full truncate align-bottom' : ''} ${animate ? (slot.content.kind === 'count' ? 'swap-in-fast' : 'swap-in') : ''}`}
      >
        <SlotBody content={slot.content} animate={animate} shimmer={shimmer} />
      </span>
    </span>
  )
}

function StepsCollapse({ items, isActive, phase, display }: { items: GroupItem[]; isActive: boolean; phase: StatusPhase; display: ToolCallDisplay }) {
  const [expanded, setExpanded] = useState(false)
  // Reason: a group that is not the live one must not speak — and a live one
  // outlives its phase silently, so idle freezes the wording here too.
  const label = usePhaseLabel(isActive ? phase : 'idle')

  // Reason: only count items that actually render — unknown part types return null
  const stepCount = items.reduce((n, g) => {
    if (g.kind === 'tools') return n + g.calls.length
    if (g.kind === 'part' && g.part.type === 'reasoning') return n + 1
    return n
  }, 0)

  const showHeader = isActive || stepCount > 1
  const showExpanded = !showHeader || expanded || (isActive && stepCount > 0)

  return (
    <div className="my-0.5">
      {showHeader && <button
        onClick={() => setExpanded(v => !v)}
        aria-expanded={showExpanded}
        className="group flex max-w-full items-center gap-1 py-0.5 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
      >
        <LinesIndicator active={isActive} phase={isActive ? phase : 'idle'} />
        <SwapSlot content={isActive ? { kind: 'label', text: label } : { kind: 'count', count: stepCount }} />
        {!isActive && <Icon icon={iconChevronRight} className={`text-xs transition-all duration-200 ${expanded ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />}
      </button>}
      {stepCount > 0 && (
        <div className={`expand-panel ${showExpanded ? 'is-open' : ''}`}>
          <div className={showHeader ? 'ml-[calc(var(--spacing)*1.5+0.5px)] border-l border-text-muted/20 pl-3 pt-0.5' : undefined}>
            {items.map((g, i) => {
              if (g.kind === 'tools') {
                return g.calls.map(c => <ToolCallItem key={c.toolCallId} call={c} isActive={isActive} display={display} />)
              }
              if (g.kind === 'part' && g.part.type === 'reasoning') {
                // Reason: only the trailing item of the trailing group can still be
                // receiving content, so it alone carries the in-progress sweep.
                return <InlineReasoning key={g.idx} text={g.part.text} isStreaming={isActive && i === items.length - 1} />
              }
              return null
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export function ThinkingDots() {
  return (
    <div className="py-2 px-1 animate-fade-in text-accent/50">
      <AnimatedIcon icon={iconThinking} className="text-lg" />
    </div>
  )
}

interface Stats {
  completionTokens: number; promptTokens?: number; elapsed: number; ttft: number
  reasoningElapsed: number; speed: number
}

function StatsBar({ message }: { message: UIMessage }) {
  const stats = (message as unknown as { metadata?: Stats }).metadata
  if (!stats?.completionTokens) return null
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2.5 py-2 text-[10px] tabular-nums text-text-muted/70">
      <span>{stats.promptTokens ? <>{formatTokens(stats.promptTokens)}<span className="mx-1 opacity-70">↑</span>{formatTokens(stats.completionTokens)}<span className="mx-px opacity-70">↓</span></> : `${stats.completionTokens} tokens`}</span>
      <span>·</span>
      <span>{stats.elapsed.toFixed(1)}s{stats.reasoningElapsed > 0 ? ` (思考 ${stats.reasoningElapsed.toFixed(1)}s)` : ''}</span>
      <span>·</span>
      <span>{stats.speed.toFixed(1)} tok/s</span>
      {stats.ttft > 0 && <><span>·</span><span>TTFT {stats.ttft < 1 ? `${Math.round(stats.ttft * 1000)}ms` : `${stats.ttft.toFixed(1)}s`}</span></>}
    </div>
  )
}

function MessageActions({ message, isLast, onRegenerate, relayedToCC, captureRef }: {
  message: UIMessage; isLast: boolean; onRegenerate?: (messageId: string) => void; relayedToCC?: boolean
  captureRef: React.RefObject<HTMLDivElement | null>
}) {
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState<'idle' | 'busy' | 'done'>('idle')
  const [confirming, setConfirming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorName = `--msg-menu-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const stats = (message as unknown as { metadata?: Stats }).metadata
  const hasStats = Boolean(stats?.completionTokens)

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setConfirming(false)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, closeMenu])

  const handleCopy = () => {
    const text = message.parts
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleExportImage = async () => {
    if (!captureRef.current || exporting !== 'idle') return
    closeMenu()
    setExporting('busy')
    try {
      const meta = (message as unknown as { metadata?: ExportStats }).metadata
      await copyMessageAsImage(captureRef.current, meta)
      setExporting('done')
      setTimeout(() => setExporting('idle'), 1500)
    } catch (err) {
      console.error('[export-image] failed:', err)
      setExporting('idle')
    }
  }

  const handleRegenerate = () => {
    if (!onRegenerate) return
    if (isLast) {
      onRegenerate(message.id)
      closeMenu()
    } else if (!confirming) {
      setConfirming(true)
    } else {
      closeMenu()
      onRegenerate(message.id)
    }
  }

  const itemClass = 'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:bg-surface-overlay hover:text-text-primary disabled:opacity-50'

  return (
    <div className="flex items-center gap-0.5 px-0 pt-1 animate-fade-in">
      <button
        onClick={handleCopy}
        className="-ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-surface-raised hover:text-text-secondary"
      >
        <Icon icon={iconCopy} className="text-xs" />
        {copied ? '已复制' : '复制'}
      </button>
      <button
        ref={btnRef}
        onClick={() => {
          if (menuOpen) closeMenu()
          else setMenuOpen(true)
        }}
        style={{ anchorName } as CSSProperties}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="更多操作"
        className={`flex items-center justify-center rounded-md px-1.5 py-0.5 text-sm leading-none transition-colors ${
          menuOpen
            ? 'bg-surface-raised text-text-secondary'
            : 'text-text-muted hover:bg-surface-raised hover:text-text-secondary'
        }`}
      >
        ⋯
      </button>
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            positionAnchor: anchorName,
            bottom: 'anchor(top)',
            left: 'anchor(left)',
            positionTryFallbacks: 'flip-block, flip-inline',
          } as CSSProperties}
          className="theme-overlay animate-slide-up-in fixed z-50 mb-1.5 w-52 overflow-hidden rounded-lg p-1"
        >
          {hasStats && (
            <>
              <StatsBar message={message} />
              <div className="mx-1 my-0.5 border-t border-border-muted" />
            </>
          )}
          <button
            onClick={handleExportImage}
            disabled={exporting === 'busy'}
            role="menuitem"
            className={itemClass}
          >
            <Icon icon={exporting === 'done' ? iconCheck : iconImage} className="shrink-0 text-xs" />
            {exporting === 'busy' ? '生成中...' : exporting === 'done' ? '已复制' : '复制为图片'}
          </button>
          {onRegenerate && (
            <button
              onClick={handleRegenerate}
              role="menuitem"
              className={`${itemClass} ${confirming ? 'bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning' : ''}`}
            >
              <Icon icon={iconRefresh} className="shrink-0 text-xs" />
              {confirming ? '确认清空后续消息？' : '重新生成'}
            </button>
          )}
          {confirming && (
            <button onClick={() => setConfirming(false)} role="menuitem" className={itemClass}>
              取消
            </button>
          )}
        </div>,
        document.body,
      )}
      {relayedToCC && (
        <span className="group/relay relative ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-text-muted">
          <ClaudeIcon className="h-3 w-3" />
          <span className="pointer-events-none absolute -top-6 right-0 whitespace-nowrap rounded-md bg-surface-overlay px-1.5 py-0.5 text-[9px] text-text-secondary opacity-0 theme-raised ring-1 ring-border-subtle transition-opacity group-hover/relay:opacity-100">已转发至 Claude Code</span>
        </span>
      )}
    </div>
  )
}

export { ContextMeter } from './ContextMeter'

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
