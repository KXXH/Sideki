import { useEffect, useRef } from 'react'

// Reason: Her OS1 loader as ONE continuously transforming closed curve.
// The helix is a 1:3:2 Lissajous loop; a circle is the same loop with all
// frequencies at 1. Morphing blends the harmonics (convex combination in
// Fourier space), which keeps the curve closed at every instant — no geometry
// swap, no crossfade. The rigid body spin (rotX) persists through the morph,
// so the final ring keeps rotating in its own plane for free.

interface HerHelixProps {
  done: boolean
  onDone?: () => void
  colors: [string, string]
  className?: string
}

// All tuning collected here — geometry, kinematics, timeline, shading.
const CFG = {
  samples: 220,
  spanRatio: 0.26, // half-length of the sweep, fraction of canvas width
  spanMax: 110, // px cap
  radiusRatio: 0.21, // helix/ring radius relative to span
  freqY: 3, // vertical oscillations (Lissajous winding)
  freqZ: 2, // depth oscillations
  // Reason: z-phase warp — smooth closed-form replacement for the reference's
  // piecewise bezier hack. Reparameterizing z's phase as g(p)=p+A·sin(4πp)
  // (A=warp/4π) drops the z tangent rate at the sweep endpoints (p=.25/.75)
  // to (1−warp), so both turnaround loops lie flat in the same plane — end
  // phases aligned instead of ~90° apart. g(½−p)=½−g(p) keeps the two passes
  // point-symmetric (true 180° double-helix opposition) and the curve closed.
  warp: 0.92,
  spin: 2.2, // rad/s baseline body spin around X
  // Reason: staged outro mirroring the reference's 240-frame ramp — one eased
  // progress P drives: [0,0.35] pure spin-up (drama first), [0.35,1] yaw to
  // end-on view + push-in, [0.72,0.98] the harmonic curve→circle blend. The
  // transform only happens once the spin is already furious.
  spinBoost: 30, // extra rad/s reached at full completion
  morphMs: 4000, // done → full circle
  morphWindow: [0.72, 0.98] as const, // harmonic blend m ramps inside this P range
  yawWindow: [0.35, 1] as const, // group yaw to end-on view inside this P range
  yawAngle: -Math.PI / 2,
  zoomMax: 0.3, // extra scale during the yaw push-in
  // Reason: long focal — near-orthographic. With a short focal the yaw phase
  // magnifies the end swinging toward the camera and the whole body skews
  // sideways; depth is conveyed by fog/width instead of position warp.
  focal: 950, // perspective focal length, px
  holdMs: 280, // ring visible before fading
  fadeMs: 300,
  widthNear: 3.0, // stroke width at nearest depth
  widthFar: 1.1,
  alphaNear: 0.95,
  alphaFar: 0.14, // fog floor — replaces the reference's stacked shadow planes
} as const

const TAU = Math.PI * 2

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

// Progress remapped into a [start, end] sub-window of P, clamped 0..1
function seg(p: number, [a, b]: readonly [number, number]): number {
  return Math.min(Math.max((p - a) / (b - a), 0), 1)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export default function HerHelix({ done, onDone, colors, className }: HerHelixProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(done)
  doneRef.current = done
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const colorsRef = useRef(colors)
  colorsRef.current = colors

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    let w = 0
    let h = 0
    const resize = () => {
      w = parent.offsetWidth
      h = parent.offsetHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    let doneAt: number | null = null
    let finished = false
    let phi = 0 // accumulated body spin
    let last = performance.now()

    interface Seg { x1: number; y1: number; x2: number; y2: number; zCam: number; zBody: number }
    const segs: Seg[] = new Array(CFG.samples)

    const render = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      if (doneRef.current && doneAt === null) doneAt = now
      let P = 0
      let fade = 1
      if (doneAt !== null) {
        const elapsed = now - doneAt
        P = easeInOutCubic(Math.min(elapsed / CFG.morphMs, 1))
        const fadeStart = CFG.morphMs + CFG.holdMs
        if (elapsed > fadeStart) fade = Math.max(1 - (elapsed - fadeStart) / CFG.fadeMs, 0)
        if (elapsed > fadeStart + CFG.fadeMs) {
          if (!finished) {
            finished = true
            ctx.clearRect(0, 0, w, h)
            onDoneRef.current?.()
          }
          return
        }
      }

      // kinematics: spin accelerates with completion, yaw turns to end-on view
      phi += (CFG.spin + CFG.spinBoost * P) * dt
      const m = seg(P, CFG.morphWindow) // harmonic blend: helix → circle
      const yawT = seg(P, CFG.yawWindow)
      const psi = CFG.yawAngle * yawT
      const zoom = 1 + CFG.zoomMax * yawT

      const span = Math.min(w * CFG.spanRatio, CFG.spanMax)
      const rad = span * CFG.radiusRatio
      const warpA = CFG.warp / (TAU * CFG.freqZ)
      const cx = w / 2
      const cy = h / 2
      const cosPhi = Math.cos(phi)
      const sinPhi = Math.sin(phi)
      const cosPsi = Math.cos(psi)
      const sinPsi = Math.sin(psi)

      // sample the closed curve once, keep previous projected point per segment
      let prevX = 0
      let prevY = 0
      let prevZc = 0
      let prevZb = 0
      for (let i = 0; i <= CFG.samples; i++) {
        const p = i / CFG.samples
        // Fourier-space morph: convex blend of integer harmonics stays closed
        const x0 = span * (1 - m) * Math.sin(TAU * p)
        const y0 = rad * ((1 - m) * Math.cos(TAU * CFG.freqY * p) + m * Math.cos(TAU * p))
        const gp = p + warpA * Math.sin(TAU * CFG.freqZ * p)
        const z0 = rad * ((1 - m) * Math.sin(TAU * CFG.freqZ * gp) + m * Math.sin(TAU * p))
        // rigid spin around X (the same spin rotates the final ring in-plane)
        const y1 = y0 * cosPhi - z0 * sinPhi
        const z1 = y0 * sinPhi + z0 * cosPhi
        // group yaw around Y → end-on view as P completes
        const x2 = x0 * cosPsi + z1 * sinPsi
        const z2 = -x0 * sinPsi + z1 * cosPsi
        // perspective projection
        const s = (CFG.focal / (CFG.focal - z2)) * zoom
        const X = cx + x2 * s
        const Y = cy + y1 * s
        if (i > 0) {
          segs[i - 1] = {
            x1: prevX, y1: prevY, x2: X, y2: Y,
            zCam: (z2 + prevZc) / 2, zBody: (z1 + prevZb) / 2,
          }
        }
        prevX = X
        prevY = Y
        prevZc = z2
        prevZb = z1
      }

      // Reason: occlusion sorts by camera depth, but fog/width shade by BODY
      // depth (z1, always ±rad). Camera depth absorbs x·sinψ during the yaw,
      // which clamped the far half to the fog floor and skewed the brightness
      // centroid sideways — body depth is yaw-invariant.
      segs.sort((a, b) => a.zCam - b.zCam)
      const maxDepth = rad + 1
      ctx.clearRect(0, 0, w, h)
      ctx.lineCap = 'round'
      const [near, far] = colorsRef.current
      for (const sg of segs) {
        const raw = Math.min(Math.max((sg.zBody + maxDepth) / (2 * maxDepth), 0), 1)
        // Reason: the finished ring is uniformly lit (Her reference) — depth
        // shading fades out with the morph, otherwise the circle keeps one
        // bright and one dim side from its body-space tilt.
        const dn = lerp(raw, 0.82, m)
        ctx.strokeStyle = dn > 0.5 ? near : far
        ctx.globalAlpha = lerp(CFG.alphaFar, CFG.alphaNear, dn) * fade
        ctx.lineWidth = lerp(CFG.widthFar, CFG.widthNear, dn)
        ctx.beginPath()
        ctx.moveTo(sg.x1, sg.y1)
        ctx.lineTo(sg.x2, sg.y2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className={className} />
}
