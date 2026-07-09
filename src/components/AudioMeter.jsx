import { useEffect, useRef, useState, useMemo } from 'react'
import useTimelineStore from '../stores/timelineStore'
import { getMasterAnalyser, readAnalyserRmsDb } from '../services/audioMixerGraph'

const METER_MIN_DB = -40
const METER_MAX_DB = 0
const METER_DB_TICKS = [0, -5, -10, -15, -20, -25, -30, -35, -40]
const METER_UPDATE_MS = 50 // ~20 fps, enough for smooth meter
const PEAK_HOLD_MS = 1000

const dbToFillPercent = (db) => {
  const normalizedDb = Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, Number(db) || METER_MIN_DB))
  return ((normalizedDb - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100
}

/**
 * MasterAudioMeter - Stereo VU meter component for timeline audio
 *
 * Reads levels from the shared preview audio graph (audioMixerGraph), the
 * same graph AudioLayerRenderer plays through and the mixer strips meter
 * from — so this meter shows exactly what the program outputs, with no
 * duplicate decoding of timeline media.
 */
function MasterAudioMeter({ height, className = '' }) {
  const [leftLevel, setLeftLevel] = useState(METER_MIN_DB) // dB
  const [leftPeak, setLeftPeak] = useState(METER_MIN_DB) // dB
  const [rightLevel, setRightLevel] = useState(METER_MIN_DB) // dB
  const [rightPeak, setRightPeak] = useState(METER_MIN_DB) // dB

  const peakRef = useRef({ db: METER_MIN_DB, at: 0 })
  const isPlayingRef = useRef(false)

  const isPlaying = useTimelineStore(state => state.isPlaying)

  const meterTicks = useMemo(
    () => METER_DB_TICKS.map((db) => ({
      db,
      top: db === METER_MIN_DB ? 'calc(100% - 1px)' : `${100 - dbToFillPercent(db)}%`,
      isMajor: db % 10 === 0,
    })),
    []
  )

  // Keep ref in sync for the polling loop
  useEffect(() => {
    isPlayingRef.current = isPlaying
    if (!isPlaying) {
      peakRef.current = { db: METER_MIN_DB, at: 0 }
      setLeftLevel(METER_MIN_DB)
      setRightLevel(METER_MIN_DB)
      setLeftPeak(METER_MIN_DB)
      setRightPeak(METER_MIN_DB)
    }
  }, [isPlaying])

  // Analysis loop: use setInterval so it keeps running (rAF can be throttled
  // when the tab is inactive or there is no interaction)
  useEffect(() => {
    const analyze = () => {
      if (!isPlayingRef.current) return

      const db = readAnalyserRmsDb(getMasterAnalyser(), METER_MIN_DB)

      // The program bus is metered mono (summed); mirror to both bars like
      // the previous meter did.
      setLeftLevel(db)
      setRightLevel(db)

      const now = performance.now()
      const prior = peakRef.current
      if (db >= prior.db || now - prior.at > PEAK_HOLD_MS) {
        peakRef.current = { db, at: now }
      }
      setLeftPeak(peakRef.current.db)
      setRightPeak(peakRef.current.db)
    }

    analyze()
    const intervalId = setInterval(analyze, METER_UPDATE_MS)
    return () => clearInterval(intervalId)
  }, [])

  // Get color for a given dB level
  const getColorForDb = (db) => {
    if (db >= -4) return 'bg-red-500' // Red for peaks (0 to -4 dB)
    if (db >= -12) return 'bg-yellow-500' // Yellow for warning (-4 to -12 dB)
    return 'bg-green-500' // Green for normal (-12 to -40 dB)
  }

  const leftPosition = dbToFillPercent(leftLevel)
  const rightPosition = dbToFillPercent(rightLevel)
  const leftPeakPosition = dbToFillPercent(leftPeak)
  const rightPeakPosition = dbToFillPercent(rightPeak)

  return (
    <div className={`flex flex-col items-center bg-sf-dark-800 ${className}`} style={{ width: height ? undefined : '100%', height: height ? `${height}px` : '100%', minHeight: 120 }}>
      {/* Layout: left bar | scale (centered) | right bar */}
      <div className="flex-1 flex items-stretch gap-0 min-h-0 w-full max-w-[92px] px-1">
        {/* Left channel */}
        <div className="flex-1 min-w-0 min-h-0 relative bg-black/50 rounded-l-sm overflow-hidden border border-sf-dark-600 border-r-0">
          <div className="absolute inset-0 pointer-events-none">
            {meterTicks.map(({ db, top, isMajor }) => (
              <div
                key={`left-${db}`}
                className={`absolute left-0 right-0 border-t ${
                  isMajor ? 'border-white/18' : 'border-white/8'
                }`}
                style={{ top }}
              />
            ))}
          </div>
          <div
            className={`absolute bottom-0 left-0 right-0 ${getColorForDb(leftLevel)} transition-all duration-75`}
            style={{ height: `${leftPosition}%` }}
          />
          {leftPeak > METER_MIN_DB && (
            <div
              className="absolute left-0 right-0 bg-red-500"
              style={{ bottom: `${leftPeakPosition}%`, height: '2px' }}
            />
          )}
        </div>

        {/* dB scale - centered between the two bars */}
        <div className="relative py-0.5 text-[8px] text-sf-text-muted font-mono pointer-events-none shrink-0 w-8">
          {meterTicks.map(({ db, top, isMajor }) => (
            <div
              key={`scale-${db}`}
              className="absolute inset-x-0 flex items-center justify-center"
              style={{
                top,
                transform: db === 0 ? 'translateY(0)' : (db === METER_MIN_DB ? 'translateY(-100%)' : 'translateY(-50%)'),
              }}
            >
              <div className={`h-px w-1.5 mr-1 ${isMajor ? 'bg-white/25' : 'bg-white/12'}`} />
              <span className={isMajor ? 'text-sf-text-secondary' : 'text-sf-text-muted'}>{db}</span>
            </div>
          ))}
        </div>

        {/* Right channel */}
        <div className="flex-1 min-w-0 min-h-0 relative bg-black/50 rounded-r-sm overflow-hidden border border-sf-dark-600 border-l-0">
          <div className="absolute inset-0 pointer-events-none">
            {meterTicks.map(({ db, top, isMajor }) => (
              <div
                key={`right-${db}`}
                className={`absolute left-0 right-0 border-t ${
                  isMajor ? 'border-white/18' : 'border-white/8'
                }`}
                style={{ top }}
              />
            ))}
          </div>
          <div
            className={`absolute bottom-0 left-0 right-0 ${getColorForDb(rightLevel)} transition-all duration-75`}
            style={{ height: `${rightPosition}%` }}
          />
          {rightPeak > METER_MIN_DB && (
            <div
              className="absolute left-0 right-0 bg-red-500"
              style={{ bottom: `${rightPeakPosition}%`, height: '2px' }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default MasterAudioMeter
