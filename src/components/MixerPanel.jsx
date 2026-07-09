import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import {
  hasAudioSolo,
  isAudioTrackAudible,
  TRACK_VOLUME_MAX,
} from '../utils/audioTrackAudibility'
import {
  AUDIO_INSERT_LABELS,
  AUDIO_INSERT_TYPES,
  REVERB_PRESETS,
  createAudioInsert,
  normalizeAudioInsert,
} from '../utils/audioInserts'
import {
  getInsertMeters,
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

// Slider definitions for the FX editor pane, per insert type
const INSERT_PARAM_SLIDERS = {
  compressor: [
    { key: 'thresholdDb', label: 'Threshold', min: -60, max: 0, step: 1, format: (v) => `${v} dB` },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, format: (v) => `${v}:1` },
    { key: 'kneeDb', label: 'Knee', min: 0, max: 40, step: 1, format: (v) => `${v} dB` },
    { key: 'attackMs', label: 'Attack', min: 0, max: 200, step: 1, format: (v) => `${v} ms` },
    { key: 'releaseMs', label: 'Release', min: 10, max: 1000, step: 10, format: (v) => `${v} ms` },
    { key: 'makeupDb', label: 'Makeup', min: 0, max: 24, step: 0.5, format: (v) => `+${v} dB` },
  ],
  limiter: [
    { key: 'ceilingDb', label: 'Ceiling', min: -24, max: 0, step: 0.5, format: (v) => `${v} dB` },
    { key: 'releaseMs', label: 'Release', min: 10, max: 500, step: 10, format: (v) => `${v} ms` },
  ],
  reverb: [
    { key: 'wet', label: 'Mix', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  ],
}

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
  inserts = [],
  selected,
  onSelect,
  onVolumeChange,
  onVolumeReset,
  onToggleMute,
  onToggleSolo,
  isMaster = false,
}) {
  const db = volumeToDb(volume)
  return (
    <div
      onClick={onSelect}
      className={`flex flex-col items-stretch w-20 flex-shrink-0 h-full py-2 px-1.5 rounded border cursor-pointer ${
        selected
          ? 'bg-sf-dark-800 border-sf-accent/60'
          : isMaster
            ? 'bg-sf-dark-800 border-sf-accent/30 hover:border-sf-accent/50'
            : 'bg-sf-dark-800 border-sf-dark-700 hover:border-sf-dark-600'
      } ${dimmed ? 'opacity-60' : ''}`}
    >
      <div
        className={`text-[10px] text-center truncate ${isMaster ? 'text-sf-accent' : 'text-sf-text-secondary'}`}
        title={name}
      >
        {name}
      </div>
      {/* FX badges — informational; edit in the FX pane (select strip first) */}
      <div className="h-4 mt-0.5 mb-0.5 flex items-center justify-center gap-0.5 overflow-hidden">
        {inserts.length === 0 ? (
          <span className="text-[8px] text-sf-text-muted/50">—</span>
        ) : (
          inserts.slice(0, 3).map((insert) => (
            <span
              key={insert.id}
              className={`px-0.5 rounded-sm text-[8px] font-mono leading-3 border ${
                insert.enabled
                  ? 'text-amber-300 border-amber-300/40 bg-amber-300/10'
                  : 'text-sf-text-muted/60 border-sf-dark-600 bg-transparent'
              }`}
              title={`${AUDIO_INSERT_LABELS[insert.type].full}${insert.enabled ? '' : ' (bypassed)'}`}
            >
              {AUDIO_INSERT_LABELS[insert.type].short}
            </span>
          ))
        )}
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
            onClick={(e) => { e.stopPropagation(); onToggleMute() }}
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
            onClick={(e) => { e.stopPropagation(); onToggleSolo() }}
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
 * FX editor pane: insert list + parameters for the selected strip.
 * Lives at the drawer's right edge so nothing has to popover inside the
 * horizontally scrolling strip area.
 */
function FxPane({ stripName, inserts, reductions, onChangeInserts }) {
  const [expandedInsertId, setExpandedInsertId] = useState(null)

  const updateInsert = (insertId, patch) => {
    onChangeInserts(inserts.map((insert) => (
      insert.id === insertId ? normalizeAudioInsert({ ...insert, ...patch }) : insert
    )))
  }

  const removeInsert = (insertId) => {
    onChangeInserts(inserts.filter((insert) => insert.id !== insertId))
    if (expandedInsertId === insertId) setExpandedInsertId(null)
  }

  const addInsert = (type) => {
    const insert = createAudioInsert(type)
    if (!insert) return
    onChangeInserts([...inserts, insert])
    setExpandedInsertId(insert.id)
  }

  return (
    <div className="w-56 flex-shrink-0 h-full flex flex-col bg-sf-dark-800 border border-sf-dark-700 rounded py-2 px-2 overflow-y-auto">
      <div className="text-[10px] text-sf-text-secondary mb-1.5 flex items-baseline justify-between">
        <span className="uppercase tracking-wide text-sf-text-muted">FX</span>
        <span className="truncate ml-2" title={stripName}>{stripName}</span>
      </div>

      {inserts.length === 0 && (
        <div className="text-[10px] text-sf-text-muted/70 mb-2">
          No effects on this strip. Signal path: inserts → fader → meter.
        </div>
      )}

      {inserts.map((insert) => {
        const label = AUDIO_INSERT_LABELS[insert.type]
        const expanded = expandedInsertId === insert.id
        const reduction = reductions[insert.id]
        return (
          <div key={insert.id} className="mb-1.5 border border-sf-dark-600 rounded bg-sf-dark-900/60">
            <div className="flex items-center gap-1 px-1.5 py-1">
              <button
                onClick={() => updateInsert(insert.id, { enabled: !insert.enabled })}
                className={`w-3 h-3 rounded-full border flex-shrink-0 ${
                  insert.enabled
                    ? 'bg-amber-300 border-amber-200'
                    : 'bg-transparent border-sf-dark-500'
                }`}
                title={insert.enabled ? 'Bypass' : 'Enable'}
              />
              <button
                onClick={() => setExpandedInsertId(expanded ? null : insert.id)}
                className={`flex-1 text-left text-[10px] truncate ${insert.enabled ? 'text-sf-text-secondary' : 'text-sf-text-muted/60'}`}
              >
                {label.full}
              </button>
              {(insert.type === 'compressor' || insert.type === 'limiter') && (
                <span
                  className="text-[9px] font-mono text-sf-text-muted w-9 text-right flex-shrink-0"
                  title="Gain reduction"
                >
                  {Number.isFinite(reduction) && reduction < -0.1 ? `${reduction.toFixed(1)}` : '0.0'}
                </span>
              )}
              <button
                onClick={() => removeInsert(insert.id)}
                className="text-sf-text-muted hover:text-sf-error text-[11px] leading-none px-0.5 flex-shrink-0"
                title="Remove effect"
              >
                ×
              </button>
            </div>

            {expanded && (
              <div className="px-1.5 pb-1.5 pt-0.5 border-t border-sf-dark-700">
                {insert.type === 'reverb' && (
                  <div className="flex items-center gap-1 mb-1">
                    {REVERB_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        onClick={() => updateInsert(insert.id, { preset })}
                        className={`flex-1 py-0.5 rounded text-[9px] capitalize border ${
                          insert.preset === preset
                            ? 'bg-sf-accent/20 text-sf-accent border-sf-accent/40'
                            : 'bg-sf-dark-700 text-sf-text-muted border-sf-dark-600 hover:bg-sf-dark-600'
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                )}
                {INSERT_PARAM_SLIDERS[insert.type].map(({ key, label: paramLabel, min, max, step, format }) => (
                  <div key={key} className="mb-1 last:mb-0">
                    <div className="flex items-baseline justify-between text-[9px] text-sf-text-muted">
                      <span>{paramLabel}</span>
                      <span className="font-mono">{format(insert[key])}</span>
                    </div>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={insert[key]}
                      onChange={(e) => updateInsert(insert.id, { [key]: Number(e.target.value) })}
                      className="w-full h-1 accent-amber-300"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <div className="flex items-center gap-1 mt-auto pt-1.5">
        {AUDIO_INSERT_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => addInsert(type)}
            className="flex-1 py-1 rounded text-[9px] bg-sf-dark-700 text-sf-text-muted border border-sf-dark-600 hover:bg-sf-dark-600 hover:text-sf-text-secondary"
            title={`Add ${AUDIO_INSERT_LABELS[type].full}`}
          >
            + {AUDIO_INSERT_LABELS[type].short}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * MixerPanel - Audio mixer view for the editor's bottom drawer.
 *
 * One channel strip per audio track (fader, mute, solo, live meter, FX
 * badges) plus a master strip bound to the program master gain, and an FX
 * pane for the selected strip's insert effects (compressor/limiter/reverb).
 * Faders and inserts write straight to the timeline store; meters and
 * gain-reduction readouts poll the shared preview audio graph
 * (audioMixerGraph), so what you see is exactly what AudioLayerRenderer is
 * playing. Export runs the same insert chains offline (audioInsertChain).
 */
function MixerPanel() {
  const tracks = useTimelineStore(state => state.tracks)
  const masterAudioVolume = useTimelineStore(state => state.masterAudioVolume)
  const masterAudioInserts = useTimelineStore(state => state.masterAudioInserts)
  const setTrackVolume = useTimelineStore(state => state.setTrackVolume)
  const setMasterAudioVolume = useTimelineStore(state => state.setMasterAudioVolume)
  const setTrackInserts = useTimelineStore(state => state.setTrackInserts)
  const setMasterAudioInserts = useTimelineStore(state => state.setMasterAudioInserts)
  const toggleTrackMute = useTimelineStore(state => state.toggleTrackMute)
  const toggleTrackSolo = useTimelineStore(state => state.toggleTrackSolo)

  const audioTracks = useMemo(
    () => (tracks || []).filter(track => track.type === 'audio'),
    [tracks]
  )
  const anySolo = hasAudioSolo(audioTracks)

  // Selected strip for the FX pane: track id or 'master'. Default to the
  // first audio track — per-track effects are the common case, and opening
  // on Master made track FX easy to miss.
  const [selectedStrip, setSelectedStrip] = useState(() => {
    const initialTracks = useTimelineStore.getState().tracks || []
    const firstAudio = initialTracks.find((track) => track.type === 'audio')
    return firstAudio ? firstAudio.id : 'master'
  })
  const selectedTrack = selectedStrip === 'master'
    ? null
    : audioTracks.find((track) => track.id === selectedStrip) || null
  // Falls back to master when the selected track no longer exists
  const effectiveStrip = selectedTrack ? selectedTrack.id : 'master'

  // One polling loop for every meter: levels/peaks keyed by track id, plus
  // 'master'. Peak-hold decays after PEAK_HOLD_MS. Gain reduction is read
  // for the selected strip's comp/limiter inserts.
  const [meterState, setMeterState] = useState({ levels: {}, peaks: {}, reductions: {} })
  const peakStampsRef = useRef({}) // key -> { db, at }
  const selectedStripRef = useRef(effectiveStrip)
  selectedStripRef.current = effectiveStrip

  useEffect(() => {
    const tick = () => {
      const now = performance.now()
      const levels = {}
      const peaks = {}
      const reductions = {}
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

      for (const meter of getInsertMeters(selectedStripRef.current)) {
        reductions[meter.id] = meter.getReductionDb()
      }

      setMeterState({ levels, peaks, reductions })
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

  const paneInserts = selectedTrack
    ? (selectedTrack.inserts || [])
    : (masterAudioInserts || [])
  const paneName = selectedTrack ? (selectedTrack.name || selectedTrack.id) : 'Master'
  const paneOnChange = selectedTrack
    ? (inserts) => setTrackInserts(selectedTrack.id, inserts)
    : (inserts) => setMasterAudioInserts(inserts)

  return (
    <div className="w-full h-full flex items-stretch gap-2 bg-sf-dark-900 px-3 py-2 overflow-x-auto">
      <div className="flex items-stretch gap-1.5 flex-1 min-w-0 overflow-x-auto">
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
            inserts={track.inserts || []}
            selected={selectedStrip === track.id}
            onSelect={() => setSelectedStrip(track.id)}
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
        inserts={masterAudioInserts || []}
        selected={selectedStrip === 'master'}
        onSelect={() => setSelectedStrip('master')}
        onVolumeChange={(value) => setMasterAudioVolume(value)}
        onVolumeReset={() => setMasterAudioVolume(100)}
      />
      <FxPane
        stripName={paneName}
        inserts={paneInserts}
        reductions={meterState.reductions}
        onChangeInserts={paneOnChange}
      />
    </div>
  )
}

export default MixerPanel
