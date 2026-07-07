import { useCallback, useEffect, useRef, useState } from 'react'
import { parseCubicBezierEasing, formatCubicBezierEasing } from '../utils/keyframes'

const PLOT_SIZE = 168
const PLOT_PADDING = 14
// Vertical value range shown in the plot. Wider than [0,1] so anticipation
// and overshoot handles stay visible and draggable.
const VALUE_MIN = -0.6
const VALUE_MAX = 1.6

export const BEZIER_EASING_PRESETS = [
  { id: 'smooth', label: 'Smooth', points: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
  { id: 'snappy', label: 'Snappy', points: { x1: 0.5, y1: 0, x2: 0.15, y2: 1 } },
  { id: 'gentle', label: 'Gentle', points: { x1: 0.4, y1: 0, x2: 0.6, y2: 1 } },
  { id: 'anticipate', label: 'Anticipate', points: { x1: 0.6, y1: -0.28, x2: 0.35, y2: 1 } },
  { id: 'overshoot', label: 'Overshoot', points: { x1: 0.3, y1: 0, x2: 0.45, y2: 1.35 } },
]

const DEFAULT_POINTS = BEZIER_EASING_PRESETS[0].points

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const xToPx = (x) => PLOT_PADDING + clamp(x, 0, 1) * (PLOT_SIZE - PLOT_PADDING * 2)
const yToPx = (y) => {
  const normalized = (clamp(y, VALUE_MIN, VALUE_MAX) - VALUE_MIN) / (VALUE_MAX - VALUE_MIN)
  return PLOT_SIZE - normalized * PLOT_SIZE
}
const pxToX = (px) => clamp((px - PLOT_PADDING) / (PLOT_SIZE - PLOT_PADDING * 2), 0, 1)
const pxToY = (px) => clamp(VALUE_MIN + ((PLOT_SIZE - px) / PLOT_SIZE) * (VALUE_MAX - VALUE_MIN), VALUE_MIN, VALUE_MAX)

/**
 * Interactive editor for cubic-bezier keyframe easing.
 * Emits an easing string (e.g. "cubic-bezier(0.25, 0.1, 0.25, 1)") via
 * onChange when the user commits a change (drag end, preset, numeric edit).
 */
export default function BezierEasingEditor({ value, onChange }) {
  const parsed = parseCubicBezierEasing(value)
  const [points, setPoints] = useState(parsed || DEFAULT_POINTS)
  const dragHandleRef = useRef(null)
  const svgRef = useRef(null)
  const pointsRef = useRef(points)
  pointsRef.current = points

  // Re-sync when an outside selection change hands us a different curve.
  useEffect(() => {
    const next = parseCubicBezierEasing(value)
    if (next) setPoints(next)
  }, [value])

  const commit = useCallback((nextPoints) => {
    setPoints(nextPoints)
    onChange?.(formatCubicBezierEasing(nextPoints))
  }, [onChange])

  const eventToPlot = useCallback((event) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: pxToX(((event.clientX - rect.left) / rect.width) * PLOT_SIZE),
      y: pxToY(((event.clientY - rect.top) / rect.height) * PLOT_SIZE),
    }
  }, [])

  const handlePointerDown = useCallback((handle) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    dragHandleRef.current = handle
    event.target.setPointerCapture?.(event.pointerId)
  }, [])

  const handlePointerMove = useCallback((event) => {
    const handle = dragHandleRef.current
    if (!handle) return
    const plot = eventToPlot(event)
    if (!plot) return
    setPoints((current) => (
      handle === 'p1'
        ? { ...current, x1: plot.x, y1: plot.y }
        : { ...current, x2: plot.x, y2: plot.y }
    ))
  }, [eventToPlot])

  const handlePointerUp = useCallback((event) => {
    if (!dragHandleRef.current) return
    dragHandleRef.current = null
    event.target.releasePointerCapture?.(event.pointerId)
    commit(pointsRef.current)
  }, [commit])

  const handleNumberChange = useCallback((key) => (event) => {
    const parsedValue = Number(event.target.value)
    if (!Number.isFinite(parsedValue)) return
    const isX = key === 'x1' || key === 'x2'
    const nextValue = isX ? clamp(parsedValue, 0, 1) : clamp(parsedValue, VALUE_MIN, VALUE_MAX)
    commit({ ...pointsRef.current, [key]: nextValue })
  }, [commit])

  const startX = xToPx(0)
  const startY = yToPx(0)
  const endX = xToPx(1)
  const endY = yToPx(1)
  const p1X = xToPx(points.x1)
  const p1Y = yToPx(points.y1)
  const p2X = xToPx(points.x2)
  const p2Y = yToPx(points.y2)

  return (
    <div className="space-y-2 select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PLOT_SIZE} ${PLOT_SIZE}`}
        className="w-full rounded border border-sf-dark-600 bg-sf-dark-950 touch-none"
        style={{ aspectRatio: '1 / 1' }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Unit box (value 0..1) */}
        <rect
          x={startX}
          y={endY}
          width={endX - startX}
          height={startY - endY}
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(255,255,255,0.12)"
          strokeDasharray="3 3"
        />
        {/* Handle arms */}
        <line x1={startX} y1={startY} x2={p1X} y2={p1Y} stroke="rgba(56,189,248,0.7)" strokeWidth="1" />
        <line x1={endX} y1={endY} x2={p2X} y2={p2Y} stroke="rgba(251,191,36,0.7)" strokeWidth="1" />
        {/* Curve */}
        <path
          d={`M ${startX} ${startY} C ${p1X} ${p1Y}, ${p2X} ${p2Y}, ${endX} ${endY}`}
          fill="none"
          stroke="rgba(255,255,255,0.9)"
          strokeWidth="1.5"
        />
        {/* Endpoints */}
        <circle cx={startX} cy={startY} r="3" fill="rgba(255,255,255,0.5)" />
        <circle cx={endX} cy={endY} r="3" fill="rgba(255,255,255,0.5)" />
        {/* Draggable control points */}
        <circle
          cx={p1X}
          cy={p1Y}
          r="6"
          fill="rgb(56,189,248)"
          stroke="rgba(255,255,255,0.8)"
          strokeWidth="1"
          className="cursor-grab"
          onPointerDown={handlePointerDown('p1')}
        />
        <circle
          cx={p2X}
          cy={p2Y}
          r="6"
          fill="rgb(251,191,36)"
          stroke="rgba(255,255,255,0.8)"
          strokeWidth="1"
          className="cursor-grab"
          onPointerDown={handlePointerDown('p2')}
        />
      </svg>

      <div className="grid grid-cols-4 gap-1">
        {[['x1', points.x1], ['y1', points.y1], ['x2', points.x2], ['y2', points.y2]].map(([key, val]) => (
          <label key={key} className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase text-sf-text-muted">{key}</span>
            <input
              type="number"
              step="0.05"
              value={Number(Number(val).toFixed(3))}
              onChange={handleNumberChange(key)}
              className="w-full px-1 py-0.5 rounded text-[10px] border border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary focus:outline-none focus:ring-1 focus:ring-sf-accent/60"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        {BEZIER_EASING_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => commit(preset.points)}
            className="px-1.5 py-0.5 rounded text-[10px] border border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary hover:border-sf-accent hover:text-sf-text-primary transition-colors"
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}
