import { useShallow } from 'zustand/react/shallow'
import useTimelineStore from '../stores/timelineStore'

/**
 * Subscribe to named timeline-store fields only.
 *
 * A bare `useTimelineStore()` re-renders its component on every store write,
 * and during playback the playhead is written on every animation frame. Pass
 * a module-level array of field names; the component then re-renders only
 * when one of those fields changes. Never list `playheadPosition` here for a
 * large component: read it at the moment of use with
 * `useTimelineStore.getState().playheadPosition`, or subscribe a small child.
 */
export function useTimelineFields(fields) {
  return useTimelineStore(useShallow((state) => {
    const slice = {}
    for (const field of fields) slice[field] = state[field]
    return slice
  }))
}

export default useTimelineFields
