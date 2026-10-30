import { Icon } from '@iconify/react'
import { iconCog, iconChat, iconProFlash, iconProTerminal } from '../../shared/icons'

type View = 'chat' | 'settings' | 'dev'

interface Props {
  activeView: View
  onViewChange: (view: View) => void
  proMode: boolean
  onProModeChange: (enabled: boolean) => void
  devMode: boolean
  seamless?: boolean
}

export default function Header({ activeView, onViewChange, proMode, onProModeChange, devMode, seamless = false }: Props) {
  return (
    <header className={`bg-surface ${seamless ? '' : 'border-b border-border-muted'}`}>
      <div className="flex items-center gap-2 px-[var(--chat-gutter)] py-2">
      <div className="flex rounded-lg bg-surface-raised p-0.5">
        <button
          onClick={() => { onProModeChange(false); onViewChange('chat') }}
          aria-pressed={!proMode && activeView !== 'dev'}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-200 ${
            !proMode && activeView !== 'dev'
              ? 'bg-accent-wash text-accent shadow-sm'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <Icon icon={iconChat} className="text-xs" />
          Chat
        </button>
        <button
          onClick={() => { onProModeChange(true); onViewChange('chat') }}
          aria-pressed={proMode && activeView !== 'dev'}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-200 ${
            proMode && activeView !== 'dev'
              ? 'bg-accent-wash text-accent shadow-sm'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <Icon icon={iconProFlash} className="text-xs" />
          Pro
        </button>
        {devMode && (
          <button
            onClick={() => onViewChange('dev')}
            aria-pressed={activeView === 'dev'}
            className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-200 ${
              activeView === 'dev'
                ? 'bg-success/15 text-success shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <Icon icon={iconProTerminal} className="text-xs" />
            Dev
          </button>
        )}
      </div>

      <button
        onClick={() => onViewChange('settings')}
        className={`ml-auto rounded-md p-1.5 transition-colors duration-150 ${
          activeView === 'settings'
            ? 'bg-accent-wash text-accent'
            : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay'
        }`}
        title="设置"
        aria-label="设置"
      >
        <Icon icon={iconCog} className="text-sm" />
      </button>
      </div>
    </header>
  )
}
