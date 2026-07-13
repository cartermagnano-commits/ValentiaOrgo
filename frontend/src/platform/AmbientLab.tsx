'use client'

import { useEffect, useRef } from 'react'

/**
 * Living backdrop for the auth pages: a slowly drifting "molecular
 * constellation" rendered on canvas — atoms wander, bonds fade in and out
 * between close neighbors (very close pairs render as double bonds), and
 * the whole field parallaxes gently toward the pointer. Soft aurora blobs
 * (CSS, see App.css) sit underneath for depth.
 *
 * Canvas is DPR-aware for crisp strokes and the simulation is O(n²) over
 * ~45 points — negligible. Under prefers-reduced-motion a single static
 * frame is drawn and no animation loop runs.
 */

const ACCENT = '37, 111, 143'   // --accent  #256f8f
const ACCENT2 = '23, 92, 82'    // --accent2 #175c52

const LINK_DIST = 140           // px — bonds appear inside this distance
const DOUBLE_DIST = 62          // px — very close pairs read as double bonds
const SPEED = 9                 // px/s — barely-drifting, never frantic
const PARALLAX = 18             // px of pointer-follow at depth 1

type Atom = {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  depth: number     // 0.5..1.4 — scales parallax for a layered feel
  hetero: boolean   // a few "heteroatoms" render larger in the deep teal
}

export default function AmbientLab() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let atoms: Atom[] = []
    let raf = 0
    let last = performance.now()
    // Pointer position in [0,1], smoothed each frame so parallax glides.
    const target = { x: 0.5, y: 0.5 }
    const eased = { x: 0.5, y: 0.5 }

    function seed() {
      const count = Math.max(24, Math.round((width * height) / 26000))
      atoms = Array.from({ length: count }, () => {
        const angle = Math.random() * Math.PI * 2
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          vx: Math.cos(angle) * SPEED,
          vy: Math.sin(angle) * SPEED,
          r: 1.6 + Math.random() * 1.6,
          depth: 0.5 + Math.random() * 0.9,
          hetero: Math.random() < 0.14,
        }
      })
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
      if (reduceMotion) draw()
    }

    function step(dt: number) {
      for (const a of atoms) {
        a.x += a.vx * dt
        a.y += a.vy * dt
        // Wrap with a margin so bonds never pop at the edges.
        if (a.x < -30) a.x = width + 30
        if (a.x > width + 30) a.x = -30
        if (a.y < -30) a.y = height + 30
        if (a.y > height + 30) a.y = -30
      }
    }

    function draw() {
      ctx.clearRect(0, 0, width, height)
      const px = (eased.x - 0.5) * PARALLAX
      const py = (eased.y - 0.5) * PARALLAX

      // Project once per frame; bonds and atoms share the same positions.
      const pts = atoms.map(a => ({
        x: a.x + px * a.depth,
        y: a.y + py * a.depth,
        a,
      }))

      ctx.lineWidth = 1
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x
          const dy = pts[i].y - pts[j].y
          const d = Math.hypot(dx, dy)
          if (d >= LINK_DIST || d < 1) continue
          const alpha = (1 - d / LINK_DIST) * 0.28
          ctx.strokeStyle = `rgba(${ACCENT}, ${alpha.toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(pts[i].x, pts[i].y)
          ctx.lineTo(pts[j].x, pts[j].y)
          ctx.stroke()
          if (d < DOUBLE_DIST) {
            // Chemistry wink: close pairs get a parallel second stroke.
            const ox = (-dy / d) * 3
            const oy = (dx / d) * 3
            ctx.beginPath()
            ctx.moveTo(pts[i].x + ox, pts[i].y + oy)
            ctx.lineTo(pts[j].x + ox, pts[j].y + oy)
            ctx.stroke()
          }
        }
      }

      for (const p of pts) {
        const { r, hetero } = p.a
        ctx.fillStyle = hetero
          ? `rgba(${ACCENT2}, 0.5)`
          : `rgba(${ACCENT}, 0.42)`
        ctx.beginPath()
        ctx.arc(p.x, p.y, hetero ? r + 1.2 : r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    function frame(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      eased.x += (target.x - eased.x) * 0.04
      eased.y += (target.y - eased.y) * 0.04
      step(dt)
      draw()
      raf = requestAnimationFrame(frame)
    }

    function onPointer(event: PointerEvent) {
      target.x = event.clientX / window.innerWidth
      target.y = event.clientY / window.innerHeight
    }

    resize()
    window.addEventListener('resize', resize)
    if (!reduceMotion) {
      window.addEventListener('pointermove', onPointer)
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointer)
    }
  }, [])

  return (
    <div className="ambient-lab" aria-hidden="true">
      <span className="ambient-blob blob-a" />
      <span className="ambient-blob blob-b" />
      <span className="ambient-blob blob-c" />
      <canvas ref={canvasRef} className="ambient-canvas" />
    </div>
  )
}
