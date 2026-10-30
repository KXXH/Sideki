import { useEffect, useRef } from 'react'
import { Icon, type IconProps } from '@iconify/react'

// Reason: React reuses DOM nodes across re-renders, but SVG SMIL <animate>
// elements bind playback state to the DOM node. A reused node's animation
// stays frozen. Calling beginElement() after each render restarts it.
export default function AnimatedIcon(props: IconProps) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const svg = ref.current?.querySelector('svg')
    if (!svg) return
    svg.querySelectorAll('animate, animateTransform, animateMotion').forEach(el => {
      el.setAttribute('repeatCount', 'indefinite')
    })
  }, [])

  return (
    <span ref={ref} className="inline-flex">
      <Icon {...props} />
    </span>
  )
}
