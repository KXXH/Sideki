import type { ReactNode, Ref, TextareaHTMLAttributes } from 'react'

interface Props {
  proMode?: boolean
  attachments?: ReactNode
  beforeInput?: ReactNode
  input: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }
  attachmentControl: ReactNode
  modelControls: ReactNode
  actions: ReactNode
}

// Reason: live chat and the update walkthrough share one input layout; only
// their data and event handlers differ, so the walkthrough cannot drift visually.
export default function ChatComposer({ proMode = false, attachments, beforeInput, input, attachmentControl, modelControls, actions }: Props) {
  return <div className={`flex flex-col rounded-xl border border-border-subtle bg-surface-raised p-2 transition-[border,box-shadow] focus-within:border-accent/40 focus-within:ring-2 focus-within:ring-accent/5 ${proMode ? 'pro-input-glow' : ''}`}>
    {attachments}
    <div className="flex flex-col gap-1">
      {beforeInput}
      <textarea {...input} placeholder={input.placeholder ?? '问问这个页面…'} rows={input.rows ?? 1} aria-label={input['aria-label'] ?? '消息草稿'} style={{ fontFamily: 'var(--font-content)', fontSize: 'var(--font-content-size)', ...input.style }} className="max-h-32 min-h-8 w-full resize-none border-0 bg-transparent px-0.5 py-1 text-text-primary outline-none placeholder:text-text-muted" />
      <div className="flex items-center gap-1.5">
        {attachmentControl}
        <div className="flex min-w-0 flex-1 items-center gap-1">{modelControls}</div>
        {actions}
      </div>
    </div>
  </div>
}
