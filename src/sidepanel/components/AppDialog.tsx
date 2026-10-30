import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { Icon } from '@iconify/react'
import { iconClose } from '../../shared/icons'
import './app-dialog.css'

interface Props {
  open: boolean
  title: string
  onClose: () => void
  placement?: 'center' | 'bottom'
  dismissible?: boolean
  proMode?: boolean
  children: ReactNode
  footer?: ReactNode
}

export function DialogAction({ variant = 'secondary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button {...props} type={type} className={`app-dialog-action app-dialog-action-${variant} ${className}`} />
}

function Surface({ title, onClose, placement = 'center', dismissible = true, proMode, children, footer }: Omit<Props, 'open'>) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const present = useIsPresent()
  const reduced = useReducedMotion()
  useEffect(() => {
    const dialog = dialogRef.current!
    const previous = document.activeElement
    if (!dialog.open) dialog.showModal()
    return () => {
      // Reason: release the top-layer focus trap before restoring the opener, including when a whole view unmounts.
      if (dialog.open) dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const close = () => { if (present && dismissible) onClose() }
  const offset = reduced ? 0 : placement === 'bottom' ? 16 : 8
  return <motion.dialog ref={dialogRef} className={`app-dialog ${proMode ? 'pro-mode' : ''}`} data-placement={placement}
    data-closing={!present || undefined} aria-labelledby={titleId} aria-hidden={!present || undefined} inert={!present}
    onCancel={event => { event.preventDefault(); close() }}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ duration: reduced ? 0 : present ? .18 : .14 }}>
    <div className="app-dialog-backdrop" aria-hidden="true" onClick={close} />
    <motion.section className="app-dialog-panel" initial={{ y: offset, scale: reduced || placement === 'bottom' ? 1 : .985 }}
      animate={{ y: 0, scale: 1 }} exit={{ y: offset, scale: reduced || placement === 'bottom' ? 1 : .985 }}
      transition={{ duration: reduced ? 0 : present ? .2 : .14, ease: [.2, .8, .2, 1] }}>
      <header className="app-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="app-dialog-close" aria-label="关闭弹窗" disabled={!dismissible || !present} onClick={close}><Icon icon={iconClose} /></button></header>
      <div className="app-dialog-body">{children}</div>
      {footer && <footer className="app-dialog-footer">{footer}</footer>}
    </motion.section>
  </motion.dialog>
}

export default function AppDialog({ open, ...props }: Props) {
  return createPortal(<AnimatePresence>{open && <Surface key="dialog" {...props} />}</AnimatePresence>, document.body)
}
