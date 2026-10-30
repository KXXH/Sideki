interface ShinyTextProps {
  text: string
  speed?: number
  className?: string
}

// Reason: the band's colors ride the theme vars (--shimmer-base / --shimmer-band),
// so one recipe stays equally visible in light and dark. A hardcoded pair can only
// ever suit one of the two.
export default function ShinyText({ text, speed = 2.2, className = '' }: ShinyTextProps) {
  return (
    <span
      className={`shimmer-sweep inline-block ${className}`}
      style={{ animationDuration: `${speed}s` }}
    >
      {text}
    </span>
  )
}
