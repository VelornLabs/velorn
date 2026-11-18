import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { getAudioWaveformData } from '../services/audioWaveform'

// The player for a finished sound: a play button, the recording's own waveform
// (click or drag it to move through the sound) and the time. It replaces the
// browser's plain audio bar. If the waveform cannot be read, even bars are
// drawn and everything else still works.
const BARS = 140
const clock = seconds => {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// Where the waveform may be read from. In the desktop app it must be a real file, read
// by the main process: Electron's own audio decoder can crash the whole window, even on
// small valid files, so it is never used here. Anything else gets even bars.
function waveformSource(path, src) {
  const desktop = typeof window !== 'undefined' && window.electronAPI?.isElectron === true
  if (!desktop) return src
  if (path && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))) return path
  return /^file:\/\//i.test(src || '') ? src : null
}

export default function SoundPlayer({ src, path = '', label = 'sound' }) {
  const audio = useRef(null), canvas = useRef(null), dragging = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const [peaks, setPeaks] = useState(null)

  // Read the waveform once for each sound.
  useEffect(() => {
    let cancelled = false
    setPeaks(null); setTime(0); setLength(0); setPlaying(false)
    const source = waveformSource(path, src)
    if (source) getAudioWaveformData(source, BARS).then(data => {
      if (cancelled || !Array.isArray(data?.peaks) || !data.peaks.length) return
      const levels = data.peaks.map(value => Math.abs(Number(value) || 0)), top = Math.max(...levels)
      if (top > 0) setPeaks(levels.map(value => value / top))
      if (data.duration > 0) setLength(current => (current > 0 ? current : data.duration))
    }).catch(() => { /* Even bars are drawn instead. */ })
    return () => { cancelled = true }
  }, [src, path])

  // While playing, follow the sound every frame so the waveform fills smoothly.
  useEffect(() => {
    if (!playing) return undefined
    let frame = requestAnimationFrame(function tick() { if (audio.current) setTime(audio.current.currentTime); frame = requestAnimationFrame(tick) })
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const draw = useCallback(() => {
    const el = canvas.current
    if (!el) return
    const ratio = window.devicePixelRatio || 1, width = el.clientWidth, height = el.clientHeight
    if (!width || !height) return
    if (el.width !== Math.round(width * ratio) || el.height !== Math.round(height * ratio)) { el.width = Math.round(width * ratio); el.height = Math.round(height * ratio) }
    const g = el.getContext('2d'), style = getComputedStyle(el)
    g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, width, height)
    const bars = Math.max(24, Math.min(BARS, Math.floor(width / 5))), slot = width / bars, thick = Math.max(2, slot * 0.56)
    const played = length > 0 ? Math.min(1, time / length) : 0
    const fill = g.createLinearGradient(0, 0, width, 0)
    fill.addColorStop(0, style.getPropertyValue('--sp-a').trim() || '#8B7CF6'); fill.addColorStop(0.5, style.getPropertyValue('--sp-b').trim() || '#5AA7FF'); fill.addColorStop(1, style.getPropertyValue('--sp-c').trim() || '#FF7FC0')
    const rest = style.getPropertyValue('--sp-rest').trim() || '#3A3A40'
    for (let bar = 0; bar < bars; bar++) {
      const level = peaks ? peaks[Math.min(peaks.length - 1, Math.floor(bar / bars * peaks.length))] : 0.28
      const tall = Math.max(3, level * (height - 4)), x = bar * slot + (slot - thick) / 2
      g.fillStyle = (bar + 0.5) / bars <= played ? fill : rest
      g.beginPath(); g.roundRect(x, (height - tall) / 2, thick, tall, thick / 2); g.fill()
    }
  }, [peaks, time, length])
  useEffect(() => { draw() }, [draw])
  useEffect(() => {
    if (!canvas.current || typeof ResizeObserver !== 'function') return undefined
    const watcher = new ResizeObserver(() => draw()); watcher.observe(canvas.current)
    return () => watcher.disconnect()
  }, [draw])

  const toggle = () => { const el = audio.current; if (!el) return; if (el.paused) el.play().catch(() => {}); else el.pause() }
  const seekTo = seconds => { const el = audio.current; if (!el || !(length > 0)) return; el.currentTime = Math.max(0, Math.min(length, seconds)); setTime(el.currentTime) }
  const seekAt = event => { const box = canvas.current.getBoundingClientRect(); seekTo((event.clientX - box.left) / box.width * length) }
  const onKey = event => {
    const step = { ArrowLeft: -Math.max(1, length / 20), ArrowRight: Math.max(1, length / 20) }[event.key]
    if (step) { event.preventDefault(); seekTo(time + step) } else if (event.key === 'Home') { event.preventDefault(); seekTo(0) } else if (event.key === 'End') { event.preventDefault(); seekTo(length) }
  }
  const realLength = () => { const d = audio.current?.duration; if (Number.isFinite(d) && d > 0) setLength(d) }

  return <div className="vc-player" data-playing={playing}>
    <audio ref={audio} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); setTime(0); if (audio.current) audio.current.currentTime = 0 }}
      onLoadedMetadata={realLength} onDurationChange={realLength} onTimeUpdate={event => setTime(event.currentTarget.currentTime)} />
    <button type="button" className="vc-player-go" aria-label={playing ? `Pause the ${label}` : `Play the ${label}`} onClick={toggle}>
      {playing ? <Pause aria-hidden="true" size={20} fill="currentColor" /> : <Play aria-hidden="true" size={20} fill="currentColor" style={{ marginLeft: 3 }} />}</button>
    <canvas ref={canvas} className="vc-player-wave" role="slider" tabIndex={0} aria-label={`Position in the ${label}`}
      aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(time)} aria-valuetext={`${clock(time)} of ${clock(length)}`} onKeyDown={onKey}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); seekAt(event) }}
      onPointerMove={event => { if (dragging.current) seekAt(event) }} onPointerUp={() => { dragging.current = false }} onPointerCancel={() => { dragging.current = false }} />
    <span className="vc-player-time" aria-hidden="true">{clock(time)} <i>/</i> {clock(length)}</span>
  </div>
}
