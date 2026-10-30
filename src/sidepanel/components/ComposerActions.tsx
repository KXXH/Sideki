import { Icon } from '@iconify/react'
import queueIcon from '@iconify-icons/lucide/clock'
import { iconLoading, iconSend, iconStop } from '../../shared/icons'

interface Props {
  running: boolean
  stopping: boolean
  sending: boolean
  hasDraft: boolean
  onSend: () => void
  onStop: () => void
}

export default function ComposerActions({ running, stopping, sending, hasDraft, onSend, onStop }: Props) {
  const showStop = running && !hasDraft
  const queueing = running && hasDraft
  const busy = showStop ? stopping : sending
  return (
      <button
        type="button"
        onClick={showStop ? onStop : onSend}
        disabled={showStop ? stopping : sending || !hasDraft}
        aria-busy={busy}
        aria-label={showStop ? (stopping ? '正在停止' : '停止当前回复') : queueing ? '加入队列' : '发送消息'}
        title={showStop ? (stopping ? '正在停止' : '停止当前回复') : sending ? '正在准备发送' : queueing ? '加入队列（Enter；Shift+Enter 换行）' : '发送（Enter；Shift+Enter 换行）'}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all active:scale-95 disabled:opacity-30 ${showStop
          ? 'bg-text-primary text-surface hover:opacity-80'
          : 'bg-accent text-on-accent shadow-sm hover:brightness-110'}`}
      >
        <Icon icon={busy ? iconLoading : showStop ? iconStop : queueing ? queueIcon : iconSend} className={`text-sm ${busy ? 'animate-spin' : ''}`} />
      </button>
  )
}
