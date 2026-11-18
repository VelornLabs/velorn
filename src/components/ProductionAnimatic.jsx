import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { getProductionShotVisual } from '../utils/production.mjs'

export const productionShotLabel = shot => shot.label || `Shot ${shot.id.slice(-6).toUpperCase()}`
export function productionShotVisual(shot, assets, board) {
  return getProductionShotVisual(board, shot, assets)?.asset
}
const timeLabel = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`

function Frame({ asset }) {
  const [failed, setFailed] = useState(false)
  const video = useRef(null)
  useEffect(() => setFailed(false), [asset?.url])
  useEffect(() => {
    const element = video.current
    return () => { element?.pause(); element?.removeAttribute('src'); element?.load() }
  }, [])
  if (!asset || failed || !asset.url) return <div className="pr-frame-placeholder">{asset ? 'Preview unavailable — reconnect this asset.' : 'Add a reference image or choose a take for this shot.'}</div>
  if (asset.type === 'video' && !asset.poster?.url) return <video ref={video} src={asset.url} muted playsInline preload="auto" onError={() => setFailed(true)} aria-label="Video take still frame" />
  return <img src={asset.type === 'video' ? asset.poster.url : asset.url} alt={asset.name || 'Shot reference'} onError={() => setFailed(true)} />
}

export default function ProductionAnimatic({ board, assets, onSelectShot, selectedShotId }) {
  const production = board.production
  const song = assets.find(asset => asset.id === board.songAssetId)
  const songUrl = song?.url
  const offset = production?.songStartSeconds || 0
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [starting, setStarting] = useState(false)
  const [labels, setLabels] = useState(true)
  const [error, setError] = useState('')
  const audioRef = useRef(null), playEpoch = useRef(0), clock = useRef({ time: 0, position: 0 })
  const pendingPlay = useRef(null), wantsPlayback = useRef(false)
  const shots = useMemo(() => {
    let at = 0
    return board.shots.map(shot => { const result = { ...shot, start: at, end: at + shot.durationSeconds }; at = result.end; return result })
  }, [board.shots])
  const duration = shots.at(-1)?.end || 0
  const activeShot = shots.find(shot => position >= shot.start && position < shot.end) || shots.at(-1)
  const activeVisual = activeShot && productionShotVisual(activeShot, assets, board)
  const direction = production?.shotDirections.find(item => item.shotId === activeShot?.id)
  const stop = () => { playEpoch.current++; pendingPlay.current = null; wantsPlayback.current = false; audioRef.current?.pause(); setPlaying(false); setStarting(false) }
  useEffect(() => {
    const media = audioRef.current
    playEpoch.current++
    pendingPlay.current = null; wantsPlayback.current = false
    media?.pause()
    setPlaying(false); setStarting(false); setPosition(0); setError('')
    return () => { playEpoch.current++; pendingPlay.current = null; wantsPlayback.current = false; media?.pause() }
  }, [board.shots, songUrl, offset])
  useEffect(() => {
    const media = audioRef.current
    return () => { media?.pause(); media?.removeAttribute('src'); media?.load() }
  }, [songUrl])
  useEffect(() => {
    if (!playing) return undefined
    let frame
    const tick = () => {
      const elapsed = songUrl ? Math.max(0, (audioRef.current?.currentTime || 0) - offset)
        : clock.current.position + (performance.now() - clock.current.time) / 1000
      setPosition(Math.min(duration, elapsed))
      if (elapsed >= duration) { stop(); return }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, songUrl, offset, duration])
  const seek = value => {
    const next = Math.max(0, Math.min(duration, Number(value) || 0))
    setPosition(next)
    clock.current = { time: performance.now(), position: next }
    if (songUrl && audioRef.current) audioRef.current.currentTime = offset + next
  }
  const play = async () => {
    if (playing) { stop(); return }
    if (pendingPlay.current !== null) return
    setError('')
    const epoch = ++playEpoch.current
    pendingPlay.current = epoch; wantsPlayback.current = true; setStarting(true)
    const next = position >= duration ? 0 : position
    try {
      if (songUrl && audioRef.current) {
        const media = audioRef.current
        if (Number.isFinite(media.duration) && offset + duration > media.duration + 0.05) throw new Error('The song is shorter than this animatic excerpt. Adjust the song start or shot durations.')
        media.currentTime = offset + next
        await media.play()
        if (epoch !== playEpoch.current) {
          // A newer play request can own this same element. An older promise
          // may release an abandoned element, but must not pause its successor.
          if (audioRef.current !== media || !wantsPlayback.current) media.pause()
          return
        }
      }
      clock.current = { time: performance.now(), position: next }
      setPosition(next); setPlaying(true)
    } catch (err) { if (epoch === playEpoch.current) { stop(); setError(err.message || 'Unable to play this song.') } }
    finally { if (pendingPlay.current === epoch) { pendingPlay.current = null; setStarting(false) } }
  }
  return <section className="pr-animatic" data-testid="production-animatic" aria-label="Animatic preview">
    {songUrl && <audio key={songUrl} ref={audioRef} src={songUrl} preload="metadata" onEnded={stop} onError={() => { stop(); setError('The song could not be loaded. Reconnect it in Assets.') }} />}
    <div className="pr-animatic-screen">
      {activeShot ? <Frame key={activeVisual?.id || activeShot.id} asset={activeVisual} /> : <div className="pr-frame-placeholder">Your shot images will play here, timed to your music.<br />Build the storyboard with your assistant first.</div>}
      {labels && activeShot && <div className="pr-frame-label"><strong>{productionShotLabel(activeShot)}</strong><span>{activeShot.title}</span>{direction?.lipSync && <small>LIP SYNC PLANNED</small>}</div>}
      <span className="pr-preview-badge">STILL-FRAME ANIMATIC</span>
    </div>
    <div className="pr-animatic-controls">
      <button type="button" aria-label={playing ? 'Pause animatic' : 'Play animatic'} aria-busy={starting} disabled={!duration || starting} onClick={play}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <button type="button" aria-label="Restart animatic" disabled={!duration} onClick={() => { stop(); seek(0) }}><RotateCcw size={14} /></button>
      <input aria-label="Animatic playhead seconds" type="range" min="0" max={duration || 1} step="0.01" value={position} disabled={!duration} onChange={event => seek(event.target.value)} />
      <output aria-label="Animatic time">{timeLabel(position)} / {timeLabel(duration)}</output>
      <label className="pr-check"><input type="checkbox" checked={labels} onChange={event => setLabels(event.target.checked)} />Shot labels</label>
    </div>
    {error && <p role="alert" className="pr-warning">{error}</p>}
    <p className="pr-muted">{songUrl ? `${song.name || 'Song'} · starts at ${timeLabel(offset)}` : 'Silent preview — choose a song in Concept to audition the edit.'} · Reference images stay here when video takes arrive. This preview does not change the editor timeline.</p>
    <div className="pr-shot-strip">{shots.map(shot => <button type="button" key={shot.id} aria-pressed={shot.id === selectedShotId} onClick={() => { stop(); seek(shot.start); onSelectShot(shot.id) }}><span>{productionShotLabel(shot)}</span><strong>{shot.title}</strong><small>{shot.durationSeconds}s</small></button>)}</div>
  </section>
}
