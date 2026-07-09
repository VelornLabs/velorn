import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import {
  hasAudioSolo,
  isAudioTrackAudible,
  TRACK_VOLUME_MAX,
} from '../utils/audioTrackAudibility'
import {
  getMasterAnalyser,
  getTrackAnalyser,
  readAnalyserRmsDb,
} from '../services/audioMixerGraph'

const METER_MIN_DB = -40
const METER_MAX_DB = 0
const METER_UPDATE_MS = 50
const PEAK_HOLD_MS = 1000

const FADER_MIN_DB = -60 // Below this the fader reads -∞ (volume 0)
const FADER_MAX_DB = 6 // volume 200
const FADER_UNITY_POSITION = 0.75 // 0 dB sits at 75% of fader travel

// --- Fader taper -----------------------------------------------------------
// Position [0,1] ↔ dB. Linear in dB above unity, quadratic below so most of
// the throw lives in the useful -20..0 dB range (standard NLE fader feel).

const positionToDb = (position) => {
  const p = Math.max(0, Math.min(1, position))
  if (p <= 0) return -Infinity
  if (p >= FADER_UNITY_POSITION) {
    return ((p - FADER_UNITY_POSITION) / (1 - FADER_UNITY_POSITION)) * FADER_MAX_DB
  }
  const t = p / FADER_UNITY_POSITION
  return FADER_MIN_DB * Math.pow(1 - t, 2)
}

const dbToPosition = (db) => {
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0
  if (db >= 0) {
    return FADER_UNITY_POSITION + (Math.min(db, FADER_MAX_DB) / FADER_MAX_DB) * (1 - FADER_UNITY_POSITION)
  }
  const t = 1 - Math.sqrt(db / FADER_MIN_DB)
  return Math.max(0, Math.min(FADER_UNITY_POSITION, t * FADER_UNITY_POSITION))
}

const volumeToDb = (volume) => {
  const v = Number(volume)
  if (!Number.isFinite(v) || v <= 0) return -Infinity
  return 20 * Math.log10(v / 100)
}

const dbToVolume = (db) => {
  if (!Number.isFinite(db)) return 0
  return Math.max(0, Math.min(TRACK_VOLUME_MAX, 100 * Math.pow(10, db / 20)))
}

const formatDb = (db) => {
  if (!Number.isFinite(db)) return '-∞'
  const rounded = Math.round(db * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`
}

const dbToMeterPercent = (db) => {
  const clamped = Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, Number.isFinite(db) ? db : METER_MIN_DB))
  return ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100
}

const meterColorForDb = (db) => {
  if (db >= -4) return 'bg-red-500'
  if (db >= -12) return 'bg-yellow-500'
  return 'bg-green-500'
}

// Tick marks along the fader throw, in dB
const FADER_TICKS = [6, 0, -6, -12, -24, -40]

/**
 * Vertical fader with NLE-style dB taper. Drag to set, double-click to reset
 * to unity (0 dB).
 */
function Fader({ volume, onChange, onReset, disabled = false }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)

  const position = dbToPosition(volumeToDb(volume))

  const applyPointerPosition = useCallback((event) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) return
    const raw = 1 - (event.clientY - rect.top) / rect.height
    onChange(dbToVolume(positionToDb(raw)))
  }, [onChange])

  const handlePointerDown = useCallback((event) => {
    if (disabled) return
    event.preventDefault()
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    applyPointerPosition(event)
  }, [applyPointerPosition, disabled])

  const handlePointerMove = useCallback((event) => {
    if (!draggingRef.current) return
    applyPointerPosition(event)
  }, [applyPointerPosition])

  const endDrag = useCallback(() => {
    draggingRef.current = false
  }, [])

  return (
    <div
      ref={trackRef}
      className={`relative w-6 flex-1 min-h-0 select-none touch-none ${disabled ? 'opacity-40' : 'cursor-pointer'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={disabled ? undefined : onReset}
      title="Drag to adjust · double-click for 0 dB"
    >
      {/* Rail */}
      <div className="absolute left-1/2 -translate-x-1/2 top-1 bottom-1 w-1 rounded bg-sf-dark-600" />
      {/* Ticks */}
      {FADER_TICKS.map((db) => (
        <div
          key={db}
          className={`absolute left-0 right-0 border-t ${db === 0 ? 'border-white/30' : 'border-white/10'}`}
          style={{ top: `${(1 - dbToPosition(db)) * 100}%` }}
        />
      ))}
      {/* Handle */}
      <div
        className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-3 rounded-sm bg-sf-dark-400 border border-white/40 shadow"
        style={{ top: `${(1 - position) * 100}%` }}
      >
        <div className="absolute left-0.5 right-0.5 top-1/2 -translate-y-1/2 h-px bg-sf-dark-900" />
      </div>
    </div>
  )
}

/** Thin vertical level meter fed by a shared analyser level (dB). */
function StripMeter({ levelDb, peakDb }) {
  return (
    <div className="relative w-1.5 flex-1 min-h-0 bg-black/50 rounded-sm overflow-hidden border border-sf-dark-600">
      <div
        className={`absolute bottom-0 left-0 right-0 ${meterColorForDb(levelDb)} transition-all duration-75`}
        style={{ height: `${dbToMeterPercent(levelDb)}%` }}
      />
      {Number.isFinite(peakDb) && peakDb > METER_MIN_DB && (
        <div
          className="absolute left-0 right-0 bg-red-500"
          style={{ bottom: `${dbToMeterPercent(peakDb)}%`, height: '2px' }}
        />
      )}
    </div>
  )
}

function ChannelStrip({
  name,
  volume,
  levelDb,
  peakDb,
  muted,
  solo,
  dimmed,
  onVolumeChange,
  onVolumeReset,
  onToggleMute,
  onToggleSolo,
  isMaster = false,
}) {
  const db = volumeToDb(volume)
  return (
    <div
      className={`flex flex-col items-stretch w-20 flex-shrink-0 h-full py-2 px-1.5 rounded border ${
        isMaster
          ? 'bg-sf-dark-800 border-sf-accent/30'
          : 'bg-sf-dark-800 border-sf-dark-700'
      } ${dimmed ? 'opacity-60' : ''}`}
    >
      <div
        className={`text-[10px] text-center truncate mb-1 ${isMaster ? 'text-sf-accent' : 'text-sf-text-secondary'}`}
        title={name}
      >
        {name}
      </div>
      <div className="flex-1 min-h-0 flex items-stretch justify-center gap-1.5">
        <Fader volume={volume} onChange={onVolumeChange} onReset={onVolumeReset} />
        <StripMeter levelDb={levelDb} peakDb={peakDb} />
      </div>
      <div className="text-[10px] text-center font-mono text-sf-text-muted mt-1" title="Fader level in dB">
        {formatDb(db)}
      </div>
      {!isMaster && (
        <div className="flex items-center justify-center gap-1 mt-1">
          <button
            onClick={onToggleMute}
            className={`w-6 h-5 rounded text-[10px] font-semibold border transition-colors ${
              muted
                ? 'bg-red-500/80 border-red-400 text-white'
                : 'bg-sf-dark-700 border-sf-dark-600 text-sf-text-muted hover:bg-sf-dark-600'
            }`}
            title={muted ? 'Unmute track' : 'Mute track'}
          >
            M
          </button>
          <button
            onClick={onToggleSolo}
            className={`w-6 h-5 rounded text-[10px] font-semibold border transition-colors ${
              solo
                ? 'bg-yellow-500/80 border-yellow-400 text-black'
                : 'bg-sf-dark-700 border-sf-dark-600 text-sf-text-muted hover:bg-sf-dark-600'
            }`}
            title={solo ? 'Unsolo track' : 'Solo track'}
          >
            S
          </button>
        </div>
      )}
      {isMaster && (
        <div className="h-5 mt-1 flex items-center justify-center text-[9px] text-sf-text-muted uppercase tracking-wide">
          Master
        </div>
      )}
    </div>
  )
}

/**
 * MixerPanel - Audio mixer view for the editor's bottom drawer.
 *
 * One channel strip per audio track (fader, mute, solo, live meter) plus a
 * master strip bound to the program master gain. Faders write straight to
 * the timeline store; meters poll the shared preview audio graph
 * (audioMixerGraph), so what you see is exactly what AudioLayerRenderer is
 * playing. Export honors the same volumes, mute/solo, and master gain.
 */
function MixerPanel() {
  const tracks = useTimelineStore(state => state.tracks)
  const masterAudioVolume = useTimelineStore(state => state.masterAudioVolume)
  const setTrackVolume = useTimelineStore(state => state.setTrackVolume)
  const setMasterAudioVolume = useTimelineStore(state => state.setMasterAudioVolume)
  const toggleTrackMute = useTimelineStore(state => state.toggleTrackMute)
  const toggleTrackSolo = useTimelineStore(state => state.toggleTrackSolo)

  const audioTracks = useMemo(
    () => (tracks || []).filter(track => track.type === 'audio'),
    [tracks]
  )
  const anySolo = hasAudioSolo(audioTracks)

  // One polling loop for every meter: levels/peaks keyed by track id, plus
  // 'master'. Peak-hold decays after PEAK_HOLD_MS.
  const [meterState, setMeterState] = useState({ levels: {}, peaks: {} })
  const peakStampsRef = useRef({}) // key -> { db, at }

  useEffect(() => {
    const tick = () => {
      const now = performance.now()
      const levels = {}
      const peaks = {}
      const stamps = peakStampsRef.current

      const readKey = (key, analyser) => {
        const db = readAnalyserRmsDb(analyser, METER_MIN_DB)
        levels[key] = db
        const prior = stamps[key]
        if (!prior || db >= prior.db || now - prior.at > PEAK_HOLD_MS) {
          stamps[key] = { db, at: now }
        }
        peaks[key] = stamps[key].db
      }

      for (const track of useTimelineStore.getState().tracks || []) {
        if (track.type !== 'audio') continue
        readKey(track.id, getTrackAnalyser(track.id))
      }
      readKey('master', getMasterAnalyser())

      setMeterState({ levels, peaks })
    }

    tick()
    const intervalId = setInterval(tick, METER_UPDATE_MS)
    return () => clearInterval(intervalId)
  }, [])

  if (audioTracks.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-sf-dark-900 text-xs text-sf-text-muted">
        No audio tracks on this timeline — add one to start mixing.
      </div>
    )
  }

  return (
    <div className="w-full h-full flex items-stretch gap-2 bg-sf-dark-900 px-3 py-2 overflow-x-auto">
      <div className="flex items-stretch gap-1.5 flex-1 min-w-0">
        {audioTracks.map((track) => (
          <ChannelStrip
            key={track.id}
            name={track.name || track.id}
            volume={track.volume ?? 100}
            levelDb={meterState.levels[track.id] ?? METER_MIN_DB}
            peakDb={meterState.peaks[track.id] ?? METER_MIN_DB}
            muted={!!track.muted}
            solo={!!track.solo}
            dimmed={!isAudioTrackAudible(track, anySolo)}
            onVolumeChange={(value) => setTrackVolume(track.id, value)}
            onVolumeReset={() => setTrackVolume(track.id, 100)}
            onToggleMute={() => toggleTrackMute(track.id)}
            onToggleSolo={() => toggleTrackSolo(track.id)}
          />
        ))}
      </div>
      <div className="w-px bg-sf-dark-700 flex-shrink-0" />
      <ChannelStrip
        name="Master"
        isMaster
        volume={masterAudioVolume ?? 100}
        levelDb={meterState.levels.master ?? METER_MIN_DB}
        peakDb={meterState.peaks.master ?? METER_MIN_DB}
        onVolumeChange={(value) => setMasterAudioVolume(value)}
        onVolumeReset={() => setMasterAudioVolume(100)}
      />
    </div>
  )
}

export default MixerPanel
