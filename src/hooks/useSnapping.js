import { useMemo, useCallback } from 'react'
import useTimelineStore from '../stores/timelineStore'

/**
 * Snapping types for visual feedback
 */
export const SNAP_TYPES = {
  PLAYHEAD: 'playhead',
  CLIP_START: 'clip_start',
  CLIP_END: 'clip_end',
  GRID: 'grid'
}

/**
 * Hook for timeline snapping functionality
 * Provides snap point calculation and snapping logic for clips and playhead
 */
export function useSnapping() {
  const clips = useTimelineStore((state) => state.clips)
  const playheadPosition = useTimelineStore((state) => state.playheadPosition)
  const snappingEnabled = useTimelineStore((state) => state.snappingEnabled)
  const snappingThreshold = useTimelineStore((state) => state.snappingThreshold)
  const zoom = useTimelineStore((state) => state.zoom)
  
  // Pixels per second based on zoom
  const pixelsPerSecond = zoom / 5
  
  // Convert threshold from pixels to time
  const thresholdInSeconds = snappingThreshold / pixelsPerSecond

  const clipEdgeSnapPoints = useMemo(() => {
    const points = []
    clips.forEach((clip) => {
      points.push({
        time: clip.startTime,
        type: SNAP_TYPES.CLIP_START,
        clipId: clip.id,
        priority: 2,
      })
      points.push({
        time: clip.startTime + clip.duration,
        type: SNAP_TYPES.CLIP_END,
        clipId: clip.id,
        priority: 2,
      })
    })
    return points
  }, [clips])

  const allSnapPoints = useMemo(() => {
    return [
      {
        time: playheadPosition,
        type: SNAP_TYPES.PLAYHEAD,
        priority: 1,
      },
      ...clipEdgeSnapPoints,
    ]
  }, [playheadPosition, clipEdgeSnapPoints])

  const getExcludedClipIdSet = useCallback((excludeClipIds = null) => {
    if (!excludeClipIds) return null
    if (excludeClipIds instanceof Set) return excludeClipIds.size > 0 ? excludeClipIds : null
    const normalizedIds = Array.isArray(excludeClipIds)
      ? excludeClipIds.filter(Boolean)
      : [excludeClipIds].filter(Boolean)
    return normalizedIds.length > 0 ? new Set(normalizedIds) : null
  }, [])

  /**
   * Get all snap points on the timeline
   * Returns array of { time, type, clipId? }
   */
  const getSnapPoints = useCallback((excludeClipIds = null) => {
    const excludedClipIds = getExcludedClipIdSet(excludeClipIds)
    if (!excludedClipIds) return allSnapPoints
    return allSnapPoints.filter((point) => !point.clipId || !excludedClipIds.has(point.clipId))
  }, [allSnapPoints, getExcludedClipIdSet])

  /**
   * Find the nearest snap point to a given time
   * Returns { snapped: boolean, time: number, snapPoint?: object, distance?: number }
   */
  const findNearestSnap = useCallback((time, excludeClipIds = null, customThreshold = null) => {
    if (!snappingEnabled) {
      return { snapped: false, time }
    }
    
    const threshold = customThreshold ?? thresholdInSeconds
    const excludedClipIdSet = getExcludedClipIdSet(excludeClipIds)
    let nearestSnap = null
    let minDistance = Infinity
    
    for (const snapPoint of allSnapPoints) {
      if (excludedClipIdSet && snapPoint.clipId && excludedClipIdSet.has(snapPoint.clipId)) continue
      const distance = Math.abs(snapPoint.time - time)
      
      if (distance < threshold && distance < minDistance) {
        // Prioritize higher priority snap points when distances are similar
        if (nearestSnap && Math.abs(distance - minDistance) < 0.01) {
          if (snapPoint.priority < nearestSnap.priority) {
            nearestSnap = snapPoint
            minDistance = distance
          }
        } else {
          nearestSnap = snapPoint
          minDistance = distance
        }
      }
    }
    
    if (nearestSnap) {
      return {
        snapped: true,
        time: nearestSnap.time,
        snapPoint: nearestSnap,
        distance: minDistance
      }
    }
    
    return { snapped: false, time }
  }, [snappingEnabled, thresholdInSeconds, allSnapPoints, getExcludedClipIdSet])

  /**
   * Snap a clip's position (checks both start and end edges)
   * Returns { snapped: boolean, startTime: number, snapInfo?: { edge, snapPoint } }
   */
  const snapClipPosition = useCallback((excludeClipIds, proposedStartTime, clipDuration) => {
    if (!snappingEnabled) {
      return { snapped: false, startTime: proposedStartTime }
    }
    
    const proposedEndTime = proposedStartTime + clipDuration
    
    // Check start edge
    const startSnap = findNearestSnap(proposedStartTime, excludeClipIds)
    
    // Check end edge
    const endSnap = findNearestSnap(proposedEndTime, excludeClipIds)
    
    // Prefer the closer snap, or start edge if equal
    if (startSnap.snapped && endSnap.snapped) {
      if (startSnap.distance <= endSnap.distance) {
        return {
          snapped: true,
          startTime: startSnap.time,
          snapInfo: { edge: 'start', snapPoint: startSnap.snapPoint }
        }
      } else {
        return {
          snapped: true,
          startTime: endSnap.time - clipDuration,
          snapInfo: { edge: 'end', snapPoint: endSnap.snapPoint }
        }
      }
    } else if (startSnap.snapped) {
      return {
        snapped: true,
        startTime: startSnap.time,
        snapInfo: { edge: 'start', snapPoint: startSnap.snapPoint }
      }
    } else if (endSnap.snapped) {
      return {
        snapped: true,
        startTime: endSnap.time - clipDuration,
        snapInfo: { edge: 'end', snapPoint: endSnap.snapPoint }
      }
    }
    
    return { snapped: false, startTime: proposedStartTime }
  }, [snappingEnabled, findNearestSnap])

  /**
   * Snap a trim operation
   * Returns { snapped: boolean, time: number, snapPoint?: object }
   */
  const snapTrim = useCallback((time, clipId) => {
    return findNearestSnap(time, clipId)
  }, [findNearestSnap])

  /**
   * Get all visible snap lines for rendering
   * Returns array of { time, type, active } for drawing vertical guides
   */
  const getVisibleSnapLines = useCallback((activeSnapTime = null) => {
    if (!snappingEnabled) return []
    
    const lines = []
    
    // Always show playhead (it's always a potential snap target)
    lines.push({
      time: playheadPosition,
      type: SNAP_TYPES.PLAYHEAD,
      active: activeSnapTime !== null && Math.abs(activeSnapTime - playheadPosition) < 0.01
    })
    
    // Show clip edges when they're being snapped to
    if (activeSnapTime !== null) {
      clips.forEach(clip => {
        if (Math.abs(activeSnapTime - clip.startTime) < 0.01) {
          lines.push({
            time: clip.startTime,
            type: SNAP_TYPES.CLIP_START,
            clipId: clip.id,
            active: true
          })
        }
        if (Math.abs(activeSnapTime - (clip.startTime + clip.duration)) < 0.01) {
          lines.push({
            time: clip.startTime + clip.duration,
            type: SNAP_TYPES.CLIP_END,
            clipId: clip.id,
            active: true
          })
        }
      })
    }
    
    return lines
  }, [snappingEnabled, playheadPosition, clips])

  return {
    snappingEnabled,
    findNearestSnap,
    snapClipPosition,
    snapTrim,
    getSnapPoints,
    getVisibleSnapLines,
    thresholdInSeconds,
    pixelsPerSecond
  }
}

export default useSnapping
