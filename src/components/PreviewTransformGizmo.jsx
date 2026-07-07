import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAnimatedTransform, getPositionKeyframePoints } from '../utils/keyframes'

const MOTION_PATH_SAMPLES = 48

const SCALE_MIN = 1
const SCALE_MAX = 1000
const POSITION_SNAP_STEP = 10
const SCALE_SNAP_STEP = 5
const ROTATION_SNAP_STEP = 5

function normalizeRotationDegrees(value) {
  if (!Number.isFinite(value)) return 0
  const normalized = ((value + 180) % 360 + 360) % 360 - 180
  return Object.is(normalized, -0) ? 0 : normalized
}

function clampScale(value) {
  if (!Number.isFinite(value)) return SCALE_MIN
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, value))
}

function roundTo(value, precision = 3) {
  if (!Number.isFinite(value)) return value
  const p = 10 ** precision
  return Math.round(value * p) / p
}

function getSafeNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getDragStartTransform(transform) {
  return {
    positionX: getSafeNumber(transform?.positionX, 0),
    positionY: getSafeNumber(transform?.positionY, 0),
    scaleX: getSafeNumber(transform?.scaleX, 100),
    scaleY: getSafeNumber(transform?.scaleY, 100),
    rotation: getSafeNumber(transform?.rotation, 0),
    cornerPinTLX: getSafeNumber(transform?.cornerPinTLX, 0),
    cornerPinTLY: getSafeNumber(transform?.cornerPinTLY, 0),
    cornerPinTRX: getSafeNumber(transform?.cornerPinTRX, 0),
    cornerPinTRY: getSafeNumber(transform?.cornerPinTRY, 0),
    cornerPinBLX: getSafeNumber(transform?.cornerPinBLX, 0),
    cornerPinBLY: getSafeNumber(transform?.cornerPinBLY, 0),
    cornerPinBRX: getSafeNumber(transform?.cornerPinBRX, 0),
    cornerPinBRY: getSafeNumber(transform?.cornerPinBRY, 0),
  }
}

function snapToStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value
  return Math.round(value / step) * step
}

function getAxisScaleUpdates(drag, e, snap) {
  const offsetX = Math.max(8, Math.abs(e.clientX - drag.centerX))
  const offsetY = Math.max(8, Math.abs(e.clientY - drag.centerY))
  const factorX = Math.max(0.01, offsetX / drag.startOffsetX)
  const factorY = Math.max(0.01, offsetY / drag.startOffsetY)
  let scaleX = clampScale(drag.startTransform.scaleX * factorX)
  let scaleY = clampScale(drag.startTransform.scaleY * factorY)
  if (snap) {
    scaleX = snapToStep(scaleX, SCALE_SNAP_STEP)
    scaleY = snapToStep(scaleY, SCALE_SNAP_STEP)
  }
  return {
    scaleX: roundTo(scaleX, 2),
    scaleY: roundTo(scaleY, 2),
    scaleLinked: false,
  }
}

export default function PreviewTransformGizmo({
  clip,
  transform,
  buildVideoTransform,
  frameRect = null,
  previewScale,
  zoomScale = 1,
  disabled = false,
  onInteractionStart,
  onTransformChange,
  onTransformCommit,
  onKeyframePointChange,
  onKeyframePointCommit,
  cornerPinHandles = null,
}) {
  const rootRef = useRef(null)
  const frameRef = useRef(null)
  const dragStateRef = useRef(null)
  const pendingCommitRef = useRef(null)
  const keyframeDragRef = useRef(null)
  const [isDragging, setIsDragging] = useState(false)
  const [rootSize, setRootSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const rootEl = rootRef.current
    if (!rootEl || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setRootSize((current) => (
        current.width === width && current.height === height ? current : { width, height }
      ))
    })
    observer.observe(rootEl)
    return () => observer.disconnect()
  }, [])

  const effectiveZoom = Number.isFinite(Number(zoomScale)) && Number(zoomScale) > 0
    ? Number(zoomScale)
    : 1
  const pxPerTimelineX = Math.max(0.0001, getSafeNumber(previewScale?.x, 1) * effectiveZoom)
  const pxPerTimelineY = Math.max(0.0001, getSafeNumber(previewScale?.y, 1) * effectiveZoom)

  const frameStyle = useMemo(() => {
    const style = (typeof buildVideoTransform === 'function' ? buildVideoTransform(transform) : {}) || {}
    const safeRect = frameRect
      && Number.isFinite(Number(frameRect.x))
      && Number.isFinite(Number(frameRect.y))
      && Number(frameRect.width) > 0
      && Number(frameRect.height) > 0
      ? {
          left: `${Number(frameRect.x)}px`,
          top: `${Number(frameRect.y)}px`,
          width: `${Number(frameRect.width)}px`,
          height: `${Number(frameRect.height)}px`,
        }
      : { inset: 0 }

    return {
      ...safeRect,
      transform: style.transform,
      transformOrigin: style.transformOrigin || '50% 50%',
    }
  }, [buildVideoTransform, frameRect, transform])

  const beginDrag = useCallback((mode, e) => {
    if (!clip || disabled) return
    if (e.button !== 0) return
    const frameEl = frameRef.current
    if (!frameEl) return
    const frameRect = frameEl.getBoundingClientRect()
    const startTransform = getDragStartTransform(transform)
    const centerX = frameRect.left + frameRect.width / 2
    const centerY = frameRect.top + frameRect.height / 2
    const startDistance = Math.max(8, Math.hypot(e.clientX - centerX, e.clientY - centerY))
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX)
    const startOffsetX = Math.max(8, Math.abs(e.clientX - centerX))
    const startOffsetY = Math.max(8, Math.abs(e.clientY - centerY))

    e.preventDefault()
    e.stopPropagation()
    if (typeof onInteractionStart === 'function') {
      onInteractionStart()
    }

    pendingCommitRef.current = null
    dragStateRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTransform,
      centerX,
      centerY,
      startDistance,
      startAngle,
      startOffsetX,
      startOffsetY,
    }
    setIsDragging(true)
  }, [clip, disabled, transform, onInteractionStart])

  useEffect(() => {
    if (!isDragging) return undefined

    const handlePointerMove = (e) => {
      const drag = dragStateRef.current
      if (!drag) return

      let updates = null
      const snap = e.shiftKey
      if (drag.mode === 'move') {
        const deltaX = (e.clientX - drag.startClientX) / pxPerTimelineX
        const deltaY = (e.clientY - drag.startClientY) / pxPerTimelineY
        let positionX = drag.startTransform.positionX + deltaX
        let positionY = drag.startTransform.positionY + deltaY
        if (snap) {
          positionX = snapToStep(positionX, POSITION_SNAP_STEP)
          positionY = snapToStep(positionY, POSITION_SNAP_STEP)
        }
        updates = {
          positionX: roundTo(positionX),
          positionY: roundTo(positionY),
        }
      } else if (drag.mode === 'scale-corner') {
        if (e.altKey) {
          updates = getAxisScaleUpdates(drag, e, snap)
        } else {
          const distance = Math.max(8, Math.hypot(e.clientX - drag.centerX, e.clientY - drag.centerY))
          const factor = Math.max(0.01, distance / drag.startDistance)
          let scaleX = clampScale(drag.startTransform.scaleX * factor)
          let scaleY = clampScale(drag.startTransform.scaleY * factor)
          if (snap) {
            scaleX = snapToStep(scaleX, SCALE_SNAP_STEP)
            scaleY = snapToStep(scaleY, SCALE_SNAP_STEP)
          }
          updates = {
            scaleX: roundTo(scaleX, 2),
            scaleY: roundTo(scaleY, 2),
          }
        }
      } else if (drag.mode === 'scale-x') {
        const offsetX = Math.max(8, Math.abs(e.clientX - drag.centerX))
        const factorX = Math.max(0.01, offsetX / drag.startOffsetX)
        let scaleX = clampScale(drag.startTransform.scaleX * factorX)
        if (snap) {
          scaleX = snapToStep(scaleX, SCALE_SNAP_STEP)
        }
        updates = {
          scaleX: roundTo(scaleX, 2),
          scaleLinked: false,
        }
      } else if (drag.mode === 'scale-y') {
        const offsetY = Math.max(8, Math.abs(e.clientY - drag.centerY))
        const factorY = Math.max(0.01, offsetY / drag.startOffsetY)
        let scaleY = clampScale(drag.startTransform.scaleY * factorY)
        if (snap) {
          scaleY = snapToStep(scaleY, SCALE_SNAP_STEP)
        }
        updates = {
          scaleY: roundTo(scaleY, 2),
          scaleLinked: false,
        }
      } else if (drag.mode === 'rotate') {
        const angle = Math.atan2(e.clientY - drag.centerY, e.clientX - drag.centerX)
        const deltaDegrees = ((angle - drag.startAngle) * 180) / Math.PI
        let rotation = normalizeRotationDegrees(drag.startTransform.rotation + deltaDegrees)
        if (snap) {
          rotation = snapToStep(rotation, ROTATION_SNAP_STEP)
        }
        updates = {
          rotation: roundTo(rotation, 2),
        }
      } else if (drag.mode.startsWith('corner-pin-')) {
        const cornerKey = drag.mode.slice('corner-pin-'.length)
        const xKey = `cornerPin${cornerKey}X`
        const yKey = `cornerPin${cornerKey}Y`
        let pinX = drag.startTransform[xKey] + (e.clientX - drag.startClientX) / pxPerTimelineX
        let pinY = drag.startTransform[yKey] + (e.clientY - drag.startClientY) / pxPerTimelineY
        if (snap) {
          pinX = snapToStep(pinX, POSITION_SNAP_STEP)
          pinY = snapToStep(pinY, POSITION_SNAP_STEP)
        }
        updates = {
          [xKey]: roundTo(pinX),
          [yKey]: roundTo(pinY),
        }
      }

      if (updates && typeof onTransformChange === 'function') {
        onTransformChange(updates)
        pendingCommitRef.current = updates
      }
    }

    const finishDrag = () => {
      const updates = pendingCommitRef.current
      if (updates && typeof onTransformCommit === 'function') {
        onTransformCommit(updates)
      }
      pendingCommitRef.current = null
      dragStateRef.current = null
      setIsDragging(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [isDragging, pxPerTimelineX, pxPerTimelineY, onTransformChange, onTransformCommit])

  // Motion path overlay: paired positionX/Y keyframes drawn as the true
  // animated trajectory (linear or smooth) with draggable keyframe dots.
  const keyframePoints = useMemo(() => (clip ? getPositionKeyframePoints(clip) : null), [clip])

  const pathSamples = useMemo(() => {
    if (!keyframePoints) return null
    const startTime = keyframePoints[0].time
    const endTime = keyframePoints[keyframePoints.length - 1].time
    if (endTime - startTime <= 0) return null
    const samples = []
    for (let index = 0; index <= MOTION_PATH_SAMPLES; index += 1) {
      const t = startTime + ((endTime - startTime) * index) / MOTION_PATH_SAMPLES
      const sampled = getAnimatedTransform(clip, t) || {}
      samples.push({
        x: getSafeNumber(sampled.positionX, 0),
        y: getSafeNumber(sampled.positionY, 0),
      })
    }
    return samples
  }, [clip, keyframePoints])

  const pathBase = useMemo(() => {
    const rect = frameRect
      && Number.isFinite(Number(frameRect.x))
      && Number(frameRect.width) > 0
      ? frameRect
      : (rootSize.width > 0 ? { x: 0, y: 0, width: rootSize.width, height: rootSize.height } : null)
    if (!rect) return null
    const anchorX = getSafeNumber(transform?.anchorX, 50)
    const anchorY = getSafeNumber(transform?.anchorY, 50)
    return {
      x: Number(rect.x) + Number(rect.width) * (anchorX / 100),
      y: Number(rect.y) + Number(rect.height) * (anchorY / 100),
    }
  }, [frameRect, rootSize, transform?.anchorX, transform?.anchorY])

  const beginKeyframeDrag = useCallback((point, e) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (typeof onInteractionStart === 'function') onInteractionStart()
    keyframeDragRef.current = {
      time: point.time,
      startX: point.x,
      startY: point.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    }

    const handlePointerMove = (moveEvent) => {
      const drag = keyframeDragRef.current
      if (!drag) return
      const nextX = drag.startX + (moveEvent.clientX - drag.startClientX) / pxPerTimelineX
      const nextY = drag.startY + (moveEvent.clientY - drag.startClientY) / pxPerTimelineY
      drag.moved = true
      if (typeof onKeyframePointChange === 'function') {
        onKeyframePointChange(drag.time, { x: roundTo(nextX), y: roundTo(nextY) })
      }
    }
    const finishDrag = (upEvent) => {
      const drag = keyframeDragRef.current
      keyframeDragRef.current = null
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
      if (drag?.moved && typeof onKeyframePointCommit === 'function') {
        const nextX = drag.startX + (upEvent.clientX - drag.startClientX) / pxPerTimelineX
        const nextY = drag.startY + (upEvent.clientY - drag.startClientY) / pxPerTimelineY
        onKeyframePointCommit(drag.time, { x: roundTo(nextX), y: roundTo(nextY) })
      }
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
  }, [disabled, onInteractionStart, onKeyframePointChange, onKeyframePointCommit, pxPerTimelineX, pxPerTimelineY])

  if (!clip || !transform) return null

  const showMotionPath = !!(keyframePoints && pathSamples && pathBase)
  const toOverlayPoint = (point) => ({
    x: pathBase.x + point.x * pxPerTimelineX,
    y: pathBase.y + point.y * pxPerTimelineY,
  })

  return (
    <div ref={rootRef} className="absolute inset-0 overflow-visible pointer-events-none z-40">
      {/* z-10 lifts the pin handles above the transform frame and its
          scale/rotate buttons — otherwise the frame's move surface eats
          every pointer-down aimed at a pin. */}
      {Array.isArray(cornerPinHandles) && cornerPinHandles.length === 4 && (
        <svg className="absolute inset-0 z-10 h-full w-full overflow-visible pointer-events-none">
          {/* Handles arrive TL, TR, BL, BR; outline draws the perimeter TL -> TR -> BR -> BL. */}
          <polygon
            points={[cornerPinHandles[0], cornerPinHandles[1], cornerPinHandles[3], cornerPinHandles[2]]
              .map((handle) => `${handle.x},${handle.y}`).join(' ')}
            fill="rgba(56,189,248,0.05)"
            stroke="rgba(56,189,248,0.85)"
            strokeWidth="1.5"
            strokeDasharray="5 3"
          />
          {cornerPinHandles.map((handle) => (
            <circle
              key={`pin-${handle.key}`}
              cx={handle.x}
              cy={handle.y}
              r="7"
              fill="rgb(56,189,248)"
              stroke="rgba(255,255,255,0.9)"
              strokeWidth="1.5"
              className={disabled ? '' : 'pointer-events-auto cursor-grab'}
              onPointerDown={(e) => beginDrag(`corner-pin-${handle.key}`, e)}
            >
              <title>{`Corner pin ${handle.key} — drag to distort (Shift snaps)`}</title>
            </circle>
          ))}
        </svg>
      )}
      {showMotionPath && (
        <svg className="absolute inset-0 z-10 h-full w-full overflow-visible pointer-events-none">
          <polyline
            points={pathSamples.map((sample) => {
              const overlay = toOverlayPoint(sample)
              return `${overlay.x},${overlay.y}`
            }).join(' ')}
            fill="none"
            stroke="rgba(255,255,255,0.75)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
          {keyframePoints.map((point) => {
            const overlay = toOverlayPoint(point)
            return (
              <circle
                key={`${point.time}`}
                cx={overlay.x}
                cy={overlay.y}
                r="5"
                fill="rgb(253,224,71)"
                stroke="rgba(0,0,0,0.7)"
                strokeWidth="1.5"
                className={disabled ? '' : 'pointer-events-auto cursor-grab'}
                onPointerDown={(e) => beginKeyframeDrag(point, e)}
              >
                <title>{`Position keyframe @ ${point.time.toFixed(2)}s — drag to move`}</title>
              </circle>
            )
          })}
        </svg>
      )}
      <div
        ref={frameRef}
        className={`absolute overflow-visible pointer-events-auto ${disabled ? 'cursor-default' : 'cursor-move'}`}
        style={frameStyle}
        title="Drag to move. Hold Shift to snap."
        onPointerDown={(e) => beginDrag('move', e)}
      >
        <div className="absolute inset-0 border-2 border-sf-accent/90 bg-sf-accent/5 shadow-[0_0_0_1px_rgba(255,255,255,0.18),0_0_0_9999px_rgba(24,24,24,0.02)_inset] pointer-events-none" />
        <div className="absolute inset-0 border border-white/50 border-dashed pointer-events-none" />
        <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-sf-accent/35 pointer-events-none" />
        <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-sf-accent/35 pointer-events-none" />

        {!disabled && (
          <>
            <button
              type="button"
              aria-label="Scale from top-left"
              className="absolute -left-2 -top-2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-nwse-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale uniformly (Alt/Option breaks uniform scale, Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-corner', e)}
            />
            <button
              type="button"
              aria-label="Scale from top-right"
              className="absolute -right-2 -top-2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-nesw-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale uniformly (Alt/Option breaks uniform scale, Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-corner', e)}
            />
            <button
              type="button"
              aria-label="Scale from bottom-left"
              className="absolute -left-2 -bottom-2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-nesw-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale uniformly (Alt/Option breaks uniform scale, Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-corner', e)}
            />
            <button
              type="button"
              aria-label="Scale from bottom-right"
              className="absolute -right-2 -bottom-2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-nwse-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale uniformly (Alt/Option breaks uniform scale, Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-corner', e)}
            />
            <button
              type="button"
              aria-label="Scale width"
              className="absolute -left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-ew-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale width only (Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-x', e)}
            />
            <button
              type="button"
              aria-label="Scale width"
              className="absolute -right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-ew-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale width only (Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-x', e)}
            />
            <button
              type="button"
              aria-label="Scale height"
              className="absolute left-1/2 -translate-x-1/2 -top-2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-ns-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale height only (Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-y', e)}
            />
            <button
              type="button"
              aria-label="Scale height"
              className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-3.5 h-3.5 rounded-[3px] bg-sf-accent border border-white/85 cursor-ns-resize shadow-[0_0_10px_rgba(0,0,0,0.35)]"
              title="Scale height only (Shift snaps)"
              onPointerDown={(e) => beginDrag('scale-y', e)}
            />
            <button
              type="button"
              aria-label="Rotate from top-left corner"
              className="absolute -left-8 -top-8 flex h-6 w-6 items-center justify-center rounded-full bg-sf-dark-950/40 pointer-events-auto cursor-grab active:cursor-grabbing"
              title="Rotate from corner (Shift snaps to 5deg)"
              onPointerDown={(e) => beginDrag('rotate', e)}
            >
              <span className="h-4 w-4 rounded-full bg-sf-dark-950/95 border-2 border-sf-accent shadow-[0_0_14px_rgba(0,0,0,0.45)]" />
            </button>
            <button
              type="button"
              aria-label="Rotate from top-right corner"
              className="absolute -right-8 -top-8 flex h-6 w-6 items-center justify-center rounded-full bg-sf-dark-950/40 pointer-events-auto cursor-grab active:cursor-grabbing"
              title="Rotate from corner (Shift snaps to 5deg)"
              onPointerDown={(e) => beginDrag('rotate', e)}
            >
              <span className="h-4 w-4 rounded-full bg-sf-dark-950/95 border-2 border-sf-accent shadow-[0_0_14px_rgba(0,0,0,0.45)]" />
            </button>
            <button
              type="button"
              aria-label="Rotate from bottom-left corner"
              className="absolute -left-8 -bottom-8 flex h-6 w-6 items-center justify-center rounded-full bg-sf-dark-950/40 pointer-events-auto cursor-grab active:cursor-grabbing"
              title="Rotate from corner (Shift snaps to 5deg)"
              onPointerDown={(e) => beginDrag('rotate', e)}
            >
              <span className="h-4 w-4 rounded-full bg-sf-dark-950/95 border-2 border-sf-accent shadow-[0_0_14px_rgba(0,0,0,0.45)]" />
            </button>
            <button
              type="button"
              aria-label="Rotate from bottom-right corner"
              className="absolute -right-8 -bottom-8 flex h-6 w-6 items-center justify-center rounded-full bg-sf-dark-950/40 pointer-events-auto cursor-grab active:cursor-grabbing"
              title="Rotate from corner (Shift snaps to 5deg)"
              onPointerDown={(e) => beginDrag('rotate', e)}
            >
              <span className="h-4 w-4 rounded-full bg-sf-dark-950/95 border-2 border-sf-accent shadow-[0_0_14px_rgba(0,0,0,0.45)]" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

