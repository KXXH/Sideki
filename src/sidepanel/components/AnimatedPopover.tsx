import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { createPortal } from 'react-dom'
import type { HTMLMotionProps } from 'motion/react'
import type { Ref } from 'react'

interface Props extends Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit' | 'transition'> {
  open: boolean
  direction?: 'up' | 'down'
  portaled?: boolean
  onExitComplete?: () => void
  ref?: Ref<HTMLDivElement>
}

function Surface({ direction = 'down', ref, ...props }: Omit<Props, 'open' | 'portaled' | 'onExitComplete'>) {
  const present = useIsPresent()
  const reducedMotion = useReducedMotion()
  const offset = reducedMotion ? 0 : direction === 'down' ? -4 : 4
  return (
    <motion.div
      {...props}
      ref={ref}
      // Reason: exiting menus stay mounted for the fade, but must immediately leave keyboard and pointer interaction.
      role={present ? props.role : undefined}
      aria-hidden={!present || props['aria-hidden']}
      inert={!present || props.inert}
      style={{ ...props.style, pointerEvents: present ? props.style?.pointerEvents : 'none', transformOrigin: direction === 'down' ? 'top' : 'bottom' }}
      initial={{ opacity: 0, y: offset, scale: reducedMotion ? 1 : 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: offset, scale: reducedMotion ? 1 : 0.985 }}
      transition={{ duration: reducedMotion ? 0 : present ? 0.16 : 0.1, ease: [0.2, 0.8, 0.2, 1] }}
    />
  )
}

export default function AnimatedPopover({ open, portaled = true, onExitComplete, ...props }: Props) {
  const content = <AnimatePresence onExitComplete={onExitComplete}>{open && <Surface key="popover" {...props} />}</AnimatePresence>
  return portaled ? createPortal(content, document.body) : content
}
