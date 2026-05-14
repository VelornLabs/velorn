const roundUs = (n) => Math.round(n * 1000000) / 1000000

const getSortedCutPoints = ({ timelineState, rangeStart, rangeEnd }) => {
  const points = new Set([rangeStart, rangeEnd])
  const clips = Array.isArray(timelineState?.clips) ? timelineState.clips : []
  const transitions = Array.isArray(timelineState?.transitions) ? timelineState.transitions : []

  for (const clip of clips) {
    if (!clip) continue
    points.add(roundUs(clip.startTime || 0))
    points.add(roundUs((clip.startTime || 0) + (clip.duration || 0)))
  }

  for (const t of transitions) {
    if (!t) continue
    const d = Number(t.duration) || 0
    if (d <= 0) continue
    if (t.kind === 'edge') {
      const clip = clips.find((c) => c.id === t.clipId)
      if (!clip) continue
      const start = t.edge === 'in' ? clip.startTime : (clip.startTime + clip.duration - d)
      points.add(roundUs(start))
      points.add(roundUs(start + d))
      continue
    }
    const clipB = clips.find((c) => c.id === t.clipBId)
    if (!clipB) continue
    const start = clipB.startTime
    points.add(roundUs(start))
    points.add(roundUs(start + d))
  }

  return [...points].filter((v) => v >= rangeStart && v <= rangeEnd).sort((a, b) => a - b)
}

const isCanvasOnlyClip = (clip) => clip?.type === 'text' || clip?.type === 'adjustment'

const isCanvasOnlyEffect = (effect) => {
  if (!effect || effect.enabled === false) return false
  return ['mask', 'chromaticAberration', 'sharpen', 'filmGrain', 'vhsDamage', 'glow', 'vignette', 'letterbox'].includes(effect.type)
}

const isGlobalCanvasReason = (clip, activeEntries, timelineState) => {
  if (!clip) return false
  if (clip.type === 'text' || clip.type === 'adjustment') return true
  if (clip?.transform?.blendMode && clip.transform.blendMode !== 'normal') return true

  const compositeState = clip?.compositeLowerLayers
  if (compositeState === 'on' || compositeState === 'off') {
    return true
  }

  const clipTime = Math.max(0, (Number(activeEntries?.time) || 0) - (Number(clip.startTime) || 0))
  const track = Array.isArray(timelineState?.tracks)
    ? timelineState.tracks.find((t) => t.id === clip.trackId)
    : null

  if (clip.type === 'video' && track?.type === 'video') {
    const effects = Array.isArray(clip.effects) ? clip.effects : []
    if (effects.some((effect) => isCanvasOnlyEffect(effect) && effect?.scope === 'global')) {
      return true
    }
  }

  return false
}

const laneForScope = ({ activeEntries, segmentStart, segmentEnd, timelineState, segmentTime }) => {
  const clips = (activeEntries || []).map((entry) => entry?.clip).filter(Boolean)
  if (clips.some((clip) => isCanvasOnlyClip(clip))) {
    return { lane: 'canvas', reasons: clips.filter(isCanvasOnlyClip).map((clip) => `clip:${clip.id || 'unknown'} type:${clip.type}`), global: true }
  }
  const canvasReasons = []
  for (const clip of clips) {
    const effects = Array.isArray(clip.effects) ? clip.effects : []
    for (const effect of effects) {
      if (isCanvasOnlyEffect(effect)) {
        canvasReasons.push(`clip:${clip.id || 'unknown'} effect:${effect.type}`)
      }
    }
    if (clip?.transform?.blendMode && clip.transform.blendMode !== 'normal') {
      canvasReasons.push(`clip:${clip.id || 'unknown'} blendMode:${clip.transform.blendMode}`)
    }
  }

  if (canvasReasons.length > 0) {
    const global = clips.some((clip) => isGlobalCanvasReason(clip, { time: segmentTime }, timelineState))
    return { lane: 'canvas', reasons: canvasReasons, start: segmentStart, end: segmentEnd, global }
  }
  return { lane: 'ffmpeg', reasons: [], start: segmentStart, end: segmentEnd, global: false }
}

const isRenderFriendlyClip = (clip) => {
  if (!clip) return false
  if (clip.type !== 'video' && clip.type !== 'image') return false
  if (clip.type === 'video' && clip.reverse) return false
  if ((clip.effects || []).some((effect) => isCanvasOnlyEffect(effect))) return false
  if (clip?.transform?.blendMode && clip.transform.blendMode !== 'normal') return false
  if (clip.type === 'text' || clip.type === 'adjustment') return false
  return true
}

export const buildExportLanePlan = ({ timelineState, rangeStart, rangeEnd, exportMode = 'auto' }) => {
  const cuts = getSortedCutPoints({ timelineState, rangeStart, rangeEnd })
  const segments = []

  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]
    const end = cuts[i + 1]
    if (!(end > start)) continue
    const mid = start + (end - start) / 2
    const activeEntries = typeof timelineState.getActiveClipsAtTime === 'function'
      ? timelineState.getActiveClipsAtTime(mid)
      : []
    const laneInfo = laneForScope({ activeEntries, segmentStart: start, segmentEnd: end, timelineState, segmentTime: mid })
    let lane = laneInfo.lane
    if (exportMode === 'canvas') lane = 'canvas'
    if (exportMode === 'ffmpeg') lane = 'ffmpeg'

    segments.push({
      start,
      end,
      duration: roundUs(end - start),
      lane,
      reasons: laneInfo.reasons,
      ffmpegSafe: lane === 'ffmpeg',
      renderFriendly: lane === 'ffmpeg' && (activeEntries || []).every((entry) => isRenderFriendlyClip(entry?.clip)),
      globalCanvas: !!laneInfo.global,
    })
  }

  return {
    exportMode,
    segments,
    counts: {
      total: segments.length,
      ffmpeg: segments.filter((s) => s.lane === 'ffmpeg').length,
      canvas: segments.filter((s) => s.lane === 'canvas').length,
    },
  }
}

export default buildExportLanePlan
