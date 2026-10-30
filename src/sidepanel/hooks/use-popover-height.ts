import { useEffect, useState, type RefObject } from 'react'

export function usePopoverHeight(open: boolean, trigger: RefObject<HTMLElement | null>, direction: 'up' | 'down', limit = 440) {
  const [height, setHeight] = useState(limit)
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      // Reason: a composer can sit high in a short chat; viewport-relative caps alone let upward menus cross the top edge.
      const available = direction === 'up' ? rect.top - 12 : window.innerHeight - rect.bottom - 12
      setHeight(Math.min(limit, Math.max(80, available)))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [open, trigger, direction, limit])
  return height
}
