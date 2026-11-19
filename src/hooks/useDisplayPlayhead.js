import { useEffect, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import { selectFramePlayhead } from '../utils/framePlayhead.mjs'

/**
 * The playhead time for panels that only SHOW values at the playhead.
 *
 * Paused (including scrubbing and frame-stepping) it is exact and immediate.
 * During playback the store's playhead is written on every animation frame;
 * a large panel that followed it would rebuild itself 60 times a second and
 * take time away from the picture. So while playing this updates a few times
 * a second instead, and snaps to the exact time the moment playback stops.
 *
 * Do not use this for anything that must act at the precise playhead while
 * playing; read `useTimelineStore.getState().playheadPosition` there.
 */
export function useDisplayPlayhead(playingIntervalMs = 200) {
  const [value, setValue] = useState(() => useTimelineStore.getState().playheadPosition)

  useEffect(() => {
    let timer = null
    let lastPush = 0
    const clear = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const push = () => {
      timer = null
      lastPush = performance.now()
      setValue(useTimelineStore.getState().playheadPosition)
    }
    const unsubscribe = useTimelineStore.subscribe((state, previous) => {
      if (state.playheadPosition === previous.playheadPosition && state.isPlaying === previous.isPlaying) return
      if (!state.isPlaying) {
        clear()
        setValue(state.playheadPosition)
        return
      }
      if (timer !== null) return
      timer = setTimeout(push, Math.max(0, playingIntervalMs - (performance.now() - lastPush)))
    })
    setValue(useTimelineStore.getState().playheadPosition)
    return () => {
      unsubscribe()
      clear()
    }
  }, [playingIntervalMs])

  return value
}

/**
 * The playhead for panels that must keep following playback closely (the
 * viewer's scrubber, overlays and cached-chunk hand-over) but have no use for
 * more than one update per timeline frame. Paused it is the exact playhead.
 * While playing it advances once per timeline frame instead of once per
 * screen refresh, which on a 24 fps timeline and a 60 or 144 Hz screen is
 * 2.5 to 6 times fewer re-renders with nothing visibly different.
 */
export function useFramePlayhead() {
  return useTimelineStore(selectFramePlayhead)
}

export default useDisplayPlayhead
