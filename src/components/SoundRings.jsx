import { useEffect, useRef } from 'react'
import nebula from '../assets/create/starter-nebula.webp'

// The Sound tab's waiting picture: rings of sound spread from the centre of a
// nebula and bend it as they pass. Each pixel is drawn from a nearby pixel of
// the still picture, and the crest of each ring is brightened.
const WIDTH = 600, HEIGHT = 200
const FRAME_MS = 1000 / 30
const PINK = [1, 0.6, 0.85], VIOLET = [0.62, 0.55, 1], BLUE = [0.42, 0.72, 1]

export default function SoundRings({ className }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return undefined
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let frame = 0, last = 0, stopped = false
    const picture = new Image()
    picture.onload = () => {
      if (stopped) return
      // The starter picture is tall; take a wide band from its upper middle.
      const band = picture.naturalWidth * HEIGHT / WIDTH
      const top = Math.max(0, Math.min(picture.naturalHeight - band, picture.naturalHeight * 0.3))
      ctx.drawImage(picture, 0, top, picture.naturalWidth, band, 0, 0, WIDTH, HEIGHT)
      let source
      try { source = ctx.getImageData(0, 0, WIDTH, HEIGHT).data } catch { return } // leave the still picture
      const out = ctx.createImageData(WIDTH, HEIGHT), to = out.data
      const cx = WIDTH / 2, cy = HEIGHT / 2
      const draw = time => {
        if (stopped) return
        if (!still) frame = requestAnimationFrame(draw)
        // Nothing to paint while the tab is hidden, and 30 frames a second is plenty.
        if (!still && (time - last < FRAME_MS || canvas.offsetParent === null)) return
        last = time
        const t = time / 1000
        for (let y = 0; y < HEIGHT; y++) {
          const oy = (y - cy) * 1.5
          for (let x = 0; x < WIDTH; x++) {
            const ox = x - cx
            const r = Math.hypot(ox, oy) + 0.001, fade = Math.exp(-r / 210)
            const s = Math.sin(r * 0.11 - t * 3.2), push = s * 7 * fade / r
            const sx = Math.min(WIDTH - 1, Math.max(0, Math.round(x + ox * push)))
            const sy = Math.min(HEIGHT - 1, Math.max(0, Math.round(y + oy * push)))
            const glow = s > 0 ? s ** 6 * 70 * fade : 0
            const tint = r < 90 ? PINK : r < 190 ? VIOLET : BLUE
            const from = (sy * WIDTH + sx) * 4, at = (y * WIDTH + x) * 4
            to[at] = source[from] * 0.82 + glow * tint[0]
            to[at + 1] = source[from + 1] * 0.82 + glow * tint[1]
            to[at + 2] = source[from + 2] * 0.82 + glow * tint[2]
            to[at + 3] = 255
          }
        }
        ctx.putImageData(out, 0, 0)
      }
      frame = requestAnimationFrame(still ? () => draw(1400) : draw)
    }
    picture.src = nebula
    return () => { stopped = true; cancelAnimationFrame(frame); picture.onload = null }
  }, [])
  return <canvas ref={ref} className={className} width={WIDTH} height={HEIGHT} aria-hidden="true" />
}
