const isEnabledClip = (clip) => clip?.enabled !== false

const toNumber = (value, fallback = 0) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const getTrackPriority = (tracks = [], trackId) => {
  const index = Array.isArray(tracks) ? tracks.findIndex((track) => track?.id === trackId) : -1
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER
}

export function getExportTimelineEndTime(state = {}) {
  const clips = Array.isArray(state.clips) ? state.clips : []
  if (clips.length === 0) return 0
  return clips.reduce((maxEnd, clip) => {
    if (!clip) return maxEnd
    const start = toNumber(clip.startTime, 0)
    const duration = Math.max(0, toNumber(clip.duration, 0))
    return Math.max(maxEnd, start + duration)
  }, 0)
}

export function getExportActiveClipsAtTime(state = {}, time) {
  const safeTime = Number(time)
  if (!Number.isFinite(safeTime)) return []

  const tracks = Array.isArray(state.tracks) ? state.tracks : []
  const clips = Array.isArray(state.clips) ? state.clips : []
  const activeClips = []

  for (const track of tracks) {
    if (!track || track.visible === false || track.muted) continue

    const trackClips = clips.filter((clip) =>
      clip
      && clip.trackId === track.id
      && isEnabledClip(clip)
      && safeTime >= toNumber(clip.startTime, 0)
      && safeTime < toNumber(clip.startTime, 0) + Math.max(0, toNumber(clip.duration, 0))
    )

    if (trackClips.length > 0) {
      trackClips
        .sort((a, b) => toNumber(a.startTime, 0) - toNumber(b.startTime, 0))
        .forEach((clip) => activeClips.push({ clip, track }))
    }
  }

  return activeClips
}

export function getExportTransitionAtTime(state = {}, time) {
  const safeTime = Number(time)
  if (!Number.isFinite(safeTime)) return null

  const tracks = Array.isArray(state.tracks) ? state.tracks : []
  const clips = Array.isArray(state.clips) ? state.clips : []
  const transitions = Array.isArray(state.transitions) ? state.transitions : []
  const candidates = []

  for (const transition of transitions) {
    if (!transition || typeof transition !== 'object') continue

    if (transition.kind === 'edge') {
      const clip = clips.find((candidate) => candidate?.id === transition.clipId)
      if (!clip) continue

      const clipTrack = tracks.find((track) => track?.id === clip.trackId)
      if (!clipTrack || clipTrack.type !== 'video') continue

      const duration = Math.min(toNumber(transition.duration, 0), Math.max(0, toNumber(clip.duration, 0)))
      if (duration <= 0) continue

      if (transition.edge === 'in') {
        const start = toNumber(clip.startTime, 0)
        const end = start + duration
        if (safeTime >= start && safeTime < end) {
          const progress = (safeTime - start) / duration
          candidates.push({
            trackPriority: getTrackPriority(tracks, clip.trackId),
            kindPriority: 1,
            data: { transition, clip, edge: 'in', progress },
          })
        }
      } else {
        const end = toNumber(clip.startTime, 0) + Math.max(0, toNumber(clip.duration, 0))
        const start = end - duration
        if (safeTime >= start && safeTime < end) {
          const progress = (safeTime - start) / duration
          candidates.push({
            trackPriority: getTrackPriority(tracks, clip.trackId),
            kindPriority: 1,
            data: { transition, clip, edge: 'out', progress },
          })
        }
      }

      continue
    }

    const clipA = clips.find((candidate) => candidate?.id === transition.clipAId)
    const clipB = clips.find((candidate) => candidate?.id === transition.clipBId)
    if (!clipA || !clipB) continue

    const clipTrack = tracks.find((track) => track?.id === clipA.trackId)
    if (!clipTrack || clipTrack.type !== 'video') continue
    if (clipA.trackId !== clipB.trackId) continue

    const duration = toNumber(transition.duration, 0)
    if (!Number.isFinite(duration) || duration <= 0) continue

    const transitionStart = toNumber(clipB.startTime, 0)
    const clipAEnd = toNumber(clipA.startTime, 0) + Math.max(0, toNumber(clipA.duration, 0))
    if (safeTime >= transitionStart && safeTime < clipAEnd) {
      const progress = (safeTime - transitionStart) / duration
      candidates.push({
        trackPriority: getTrackPriority(tracks, clipA.trackId),
        kindPriority: 0,
        data: {
          transition,
          clipA,
          clipB,
          progress: Math.min(1, Math.max(0, progress)),
        },
      })
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    if (a.trackPriority !== b.trackPriority) return a.trackPriority - b.trackPriority
    return a.kindPriority - b.kindPriority
  })

  return candidates[0].data
}

export function createExportTimelineQueries(state = {}) {
  const exportState = state || {}
  return {
    getActiveClipsAtTime: (time) => getExportActiveClipsAtTime(exportState, time),
    getTransitionAtTime: (time) => getExportTransitionAtTime(exportState, time),
    getTimelineEndTime: () => getExportTimelineEndTime(exportState),
  }
}

export default createExportTimelineQueries
