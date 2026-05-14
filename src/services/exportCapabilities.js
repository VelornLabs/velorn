const FFMPEG_SUPPORTED_TRANSITIONS = new Set([
  'dissolve',
  'fade-black',
  'fade-white',
  'wipe-left',
  'wipe-right',
  'wipe-up',
  'wipe-down',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
])

const CANVAS_ONLY_EFFECTS = new Set([
  'mask',
  'chromaticAberration',
  'sharpen',
  'filmGrain',
  'vhsDamage',
  'glow',
  'vignette',
  'letterbox',
])

const CANVAS_ONLY_CLIP_TYPES = new Set([
  'text',
  'adjustment',
])

const isEnabledEffect = (effect) => effect && effect.enabled !== false

export const analyzeExportCapabilities = ({ timelineState }) => {
  const reasons = []
  const clips = Array.isArray(timelineState?.clips) ? timelineState.clips : []
  const transitions = Array.isArray(timelineState?.transitions) ? timelineState.transitions : []

  for (const clip of clips) {
    if (!clip) continue
    if (CANVAS_ONLY_CLIP_TYPES.has(clip.type)) {
      reasons.push(`clip:${clip.id || 'unknown'} type:${clip.type}`)
      continue
    }

    const effects = Array.isArray(clip.effects) ? clip.effects : []
    for (const effect of effects) {
      if (!isEnabledEffect(effect)) continue
      if (CANVAS_ONLY_EFFECTS.has(effect.type)) {
        reasons.push(`clip:${clip.id || 'unknown'} effect:${effect.type}`)
      }
    }

    const blendMode = clip?.transform?.blendMode
    if (blendMode && blendMode !== 'normal') {
      reasons.push(`clip:${clip.id || 'unknown'} blendMode:${blendMode}`)
    }

    const adjustments = clip?.adjustments || {}
    const hasAdjustments = Object.values(adjustments).some((value) => {
      if (value == null) return false
      if (typeof value === 'number') return Math.abs(value) > 0.0001
      if (typeof value === 'boolean') return value
      return false
    })
    if (hasAdjustments) {
      reasons.push(`clip:${clip.id || 'unknown'} adjustments`)
    }
  }

  for (const transition of transitions) {
    const type = transition?.type
    if (!type) continue
    if (!FFMPEG_SUPPORTED_TRANSITIONS.has(type)) {
      reasons.push(`transition:${transition.id || 'unknown'} type:${type}`)
    }
    if (type === 'zoom-in' || type === 'zoom-out' || type === 'blur') {
      reasons.push(`transition:${transition.id || 'unknown'} type:${type}`)
    }
  }

  const ffmpegSafe = reasons.length === 0
  return {
    ffmpegSafe,
    reasons,
    lane: ffmpegSafe ? 'ffmpeg' : 'canvas',
  }
}

export default analyzeExportCapabilities
