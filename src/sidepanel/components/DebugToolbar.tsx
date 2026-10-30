import { useState, useEffect, useCallback, useRef } from 'react'
import { Icon } from '@iconify/react'
import { iconProBug, iconProConsole, iconProNetwork, iconProWebhook } from '../../shared/icons'
import type { DebugStatus } from '../../shared/agent'

interface ProStatus {
  attached: boolean
  tabId: number | null
  consoleListening: boolean
  networkListening: boolean
  consoleCount: number
  consoleErrors: number
  networkCount: number
  networkPending: number
  bridge: 'connected' | 'connecting' | 'disconnected'
}

type PillId = 'debugger' | 'console' | 'network' | 'bridge'

export default function DebugToolbar({ debugStatusRef }: { debugStatusRef: { current: DebugStatus | null } }) {
  const [status, setStatus] = useState<ProStatus | null>(null)
  const [expanded, setExpanded] = useState<PillId | null>(null)
  const mountedRef = useRef(true)

  const poll = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'pro:status' }).then(resp => {
      if (mountedRef.current && resp) {
        setStatus(resp as ProStatus)
        debugStatusRef.current = resp as DebugStatus
      }
    }).catch(() => {})
  }, [debugStatusRef])

  useEffect(() => {
    mountedRef.current = true
    poll()
    let timer = setInterval(poll, 3000)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { clearInterval(timer) }
      else { poll(); timer = setInterval(poll, 3000) }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { mountedRef.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [poll])

  const toggle = useCallback(async (feature: 'console' | 'network') => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'pro:toggle', feature })
      if (resp && mountedRef.current) {
        setStatus(resp as ProStatus)
        debugStatusRef.current = resp as DebugStatus
      }
    } catch { /* service worker may be restarting */ }
  }, [debugStatusRef])

  const handlePillClick = useCallback((id: PillId) => {
    setExpanded(prev => prev === id ? null : id)
  }, [])

  if (!status) return null

  return (
    <div className="border-t border-white/[0.03]">
      {/* Pill strip */}
      <div className="flex items-center gap-1 px-0 py-1">
        <Pill
          id="debugger"
          icon={iconProBug}
          active={status.attached}
          expanded={expanded === 'debugger'}
          onClick={handlePillClick}
        />
        <Pill
          id="console"
          icon={iconProConsole}
          active={status.consoleListening}
          badge={status.consoleErrors > 0 ? status.consoleErrors : undefined}
          badgeColor="error"
          expanded={expanded === 'console'}
          onClick={handlePillClick}
        />
        <Pill
          id="network"
          icon={iconProNetwork}
          active={status.networkListening}
          expanded={expanded === 'network'}
          onClick={handlePillClick}
        />
        <Pill
          id="bridge"
          icon={iconProWebhook}
          active={status.bridge === 'connected'}
          connecting={status.bridge === 'connecting'}
          expanded={expanded === 'bridge'}
          onClick={handlePillClick}
        />
      </div>

      {/* Expand panel — keep last content rendered during close animation */}
      <ExpandPanel expanded={expanded} status={status} onToggle={toggle} />
    </div>
  )
}

function Pill({ id, icon, active, connecting, badge, badgeColor, expanded, onClick }: {
  id: PillId
  icon: typeof iconProBug
  active: boolean
  connecting?: boolean
  badge?: number | string
  badgeColor?: 'error' | 'warning'
  expanded: boolean
  onClick: (id: PillId) => void
}) {
  const dotColor = connecting
    ? 'bg-warning/70 animate-pulse'
    : active
      ? (typeof badge === 'number' && badge > 0 && badgeColor === 'error' ? 'bg-error/80' : 'bg-success/70')
      : 'bg-text-muted/30'

  const textColor = active || connecting
    ? 'text-accent'
    : 'text-text-muted/40'

  return (
    <button
      onClick={() => onClick(id)}
      className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] transition-all ${textColor} ${expanded ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full transition-colors ${dotColor}`} />
      <Icon icon={icon} className="text-[11px]" />
      {badge !== undefined && badge !== 0 && (
        <span className={`${badgeColor ? `text-${badgeColor}/80` : 'text-text-muted'} font-medium`}>{badge}</span>
      )}
    </button>
  )
}

// Reason: when expanded goes from a value to null, we keep rendering the last
// panel content so the CSS grid-template-rows transition can animate to 0fr.
// The content is cleared after the transition ends (250ms matches CSS duration).
function ExpandPanel({ expanded, status, onToggle }: {
  expanded: PillId | null; status: ProStatus; onToggle: (f: 'console' | 'network') => void
}) {
  const lastRef = useRef<PillId | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [visible, setVisible] = useState<PillId | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (expanded) {
      lastRef.current = expanded
      setVisible(expanded)
    } else {
      // Reason: keep content during close animation, then unmount
      timerRef.current = setTimeout(() => setVisible(null), 260)
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [expanded])

  const show = visible ?? lastRef.current
  return (
    <div className={`expand-panel ${expanded ? 'is-open' : ''}`}>
      <div className="overflow-hidden">
        {show === 'debugger' && <DebuggerPanel status={status} />}
        {show === 'console' && <ConsolePanel status={status} onToggle={() => onToggle('console')} />}
        {show === 'network' && <NetworkPanel status={status} onToggle={() => onToggle('network')} />}
        {show === 'bridge' && <BridgePanel status={status} />}
      </div>
    </div>
  )
}

function PanelWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[0.03] px-0 py-1.5">
      <div className="text-[10px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  )
}

function ToggleSwitch({ active, onToggle, label }: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-white/[0.04]"
    >
      <span className={`inline-block h-2.5 w-5 rounded-full transition-colors ${active ? 'bg-success/60' : 'bg-text-muted/20'}`}>
        <span className={`block h-2.5 w-2.5 rounded-full bg-white shadow transition-transform ${active ? 'translate-x-2.5' : ''}`} />
      </span>
      <span className="text-text-muted">{label}</span>
    </button>
  )
}

function DebuggerPanel({ status }: { status: ProStatus }) {
  return (
    <PanelWrapper>
      {status.attached
        ? <span>Attached to tab <span className="font-mono text-text-primary">{status.tabId}</span></span>
        : <span className="text-text-muted">Detached</span>
      }
    </PanelWrapper>
  )
}

function ConsolePanel({ status, onToggle }: { status: ProStatus; onToggle: () => void }) {
  return (
    <PanelWrapper>
      <div className="flex items-center justify-between">
        <span>
          {status.consoleListening
            ? <>{status.consoleCount} messages{status.consoleErrors > 0 && <span className="text-error/80">, {status.consoleErrors} errors</span>}</>
            : 'Not listening'
          }
        </span>
        <ToggleSwitch active={status.consoleListening} onToggle={onToggle} label={status.consoleListening ? 'Stop' : 'Start'} />
      </div>
    </PanelWrapper>
  )
}

function NetworkPanel({ status, onToggle }: { status: ProStatus; onToggle: () => void }) {
  return (
    <PanelWrapper>
      <div className="flex items-center justify-between">
        <span>
          {status.networkListening
            ? <>{status.networkCount} captured{status.networkPending > 0 && <span className="text-warning/80">, {status.networkPending} pending</span>}</>
            : 'Not capturing'
          }
        </span>
        <ToggleSwitch active={status.networkListening} onToggle={onToggle} label={status.networkListening ? 'Stop' : 'Start'} />
      </div>
    </PanelWrapper>
  )
}

function BridgePanel({ status }: { status: ProStatus }) {
  return (
    <PanelWrapper>
      {status.bridge === 'connected' && (
        <span>Connected to <span className="font-mono text-text-primary">ws://127.0.0.1:9111</span></span>
      )}
      {status.bridge === 'connecting' && (
        <span className="text-warning/80">Connecting...</span>
      )}
      {status.bridge === 'disconnected' && (
        <span className="text-text-muted">Standalone — start bridge to connect CC</span>
      )}
    </PanelWrapper>
  )
}
