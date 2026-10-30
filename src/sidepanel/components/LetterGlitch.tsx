import { useRef, useEffect } from 'react'

interface Props {
  glitchColors?: string[]
  glitchSpeed?: number
  centerVignette?: boolean
  outerVignette?: boolean
  smooth?: boolean
  characters?: string
  className?: string
}

export default function LetterGlitch({
  glitchColors = ['#2b2d5e', '#818cf8', '#6366f1'],
  className = '',
  glitchSpeed = 50,
  centerVignette = false,
  outerVignette = true,
  smooth = true,
  characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$&*()-_+=/[]{};:<>.,0123456789',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef(0)
  const letters = useRef<{ char: string; color: string; targetColor: string; colorProgress: number }[]>([])
  const grid = useRef({ columns: 0, rows: 0 })
  const context = useRef<CanvasRenderingContext2D | null>(null)
  const lastGlitchTime = useRef(Date.now())

  const chars = Array.from(characters)

  const fontSize = 16
  const charWidth = 10
  const charHeight = 20

  const getRandomChar = () => chars[Math.floor(Math.random() * chars.length)]
  const getRandomColor = () => glitchColors[Math.floor(Math.random() * glitchColors.length)]
  const glitchKey = glitchColors.join('|')

  const hexToRgb = (hex: string) => {
    hex = hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (_, r, g, b) => r + r + g + g + b + b)
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
  }

  const interpolateColor = (s: { r: number; g: number; b: number }, e: { r: number; g: number; b: number }, f: number) =>
    `rgb(${Math.round(s.r + (e.r - s.r) * f)}, ${Math.round(s.g + (e.g - s.g) * f)}, ${Math.round(s.b + (e.b - s.b) * f)})`

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    context.current = canvas.getContext('2d')

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const dpr = window.devicePixelRatio || 1
      const rect = parent.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      context.current?.setTransform(dpr, 0, 0, dpr, 0, 0)

      const columns = Math.ceil(rect.width / charWidth)
      const rows = Math.ceil(rect.height / charHeight)
      grid.current = { columns, rows }
      letters.current = Array.from({ length: columns * rows }, () => ({
        char: getRandomChar(),
        color: getRandomColor(),
        targetColor: getRandomColor(),
        colorProgress: 1,
      }))
      draw()
    }

    const draw = () => {
      const ctx = context.current
      if (!ctx || letters.current.length === 0) return
      const { width, height } = canvas.getBoundingClientRect()
      ctx.clearRect(0, 0, width, height)
      ctx.font = `${fontSize}px monospace`
      ctx.textBaseline = 'top'
      letters.current.forEach((l, i) => {
        ctx.fillStyle = l.color
        ctx.fillText(l.char, (i % grid.current.columns) * charWidth, Math.floor(i / grid.current.columns) * charHeight)
      })
    }

    const update = () => {
      const count = Math.max(1, Math.floor(letters.current.length * 0.05))
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * letters.current.length)
        const l = letters.current[idx]
        if (!l) continue
        l.char = getRandomChar()
        l.targetColor = getRandomColor()
        if (!smooth) { l.color = l.targetColor; l.colorProgress = 1 }
        else l.colorProgress = 0
      }
    }

    const smoothTransitions = () => {
      let dirty = false
      for (const l of letters.current) {
        if (l.colorProgress < 1) {
          l.colorProgress = Math.min(l.colorProgress + 0.05, 1)
          const s = hexToRgb(l.color), e = hexToRgb(l.targetColor)
          if (s && e) { l.color = interpolateColor(s, e, l.colorProgress); dirty = true }
        }
      }
      if (dirty) draw()
    }

    const animate = () => {
      const now = Date.now()
      if (now - lastGlitchTime.current >= glitchSpeed) {
        update(); draw(); lastGlitchTime.current = now
      }
      if (smooth) smoothTransitions()
      animationRef.current = requestAnimationFrame(animate)
    }

    resize()
    animate()

    let timer: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { cancelAnimationFrame(animationRef.current); resize(); animate() }, 100)
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(animationRef.current)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glitchSpeed, smooth, glitchKey])

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: '#000', overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {outerVignette && (
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle, transparent 60%, rgba(0,0,0,1) 100%)' }} />
      )}
      {centerVignette && (
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.8) 0%, transparent 60%)' }} />
      )}
    </div>
  )
}
