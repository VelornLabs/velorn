import { getAnimatedTransform } from './keyframes'
import { parseTrackMatte } from './trackMatte'
import { hasActiveCornerPin } from './cornerPin'

export const CLIP_COMPOSITE_MODE = {
  AUTO: 'auto',
  ON: 'on',
  OFF: 'off',
}

export const CLIP_COMPOSITE_MODE_OPTIONS = [
  {
    value: CLIP_COMPOSITE_MODE.AUTO,
    label: 'Auto',
    description: 'Read lower layers only when this clip can reveal them.',
  },
  {
    value: CLIP_COMPOSITE_MODE.ON,
    label: 'On',
    description: 'Always composite the lower layers.',
  },
  {
    value: CLIP_COMPOSITE_MODE.OFF,
    label: 'Off',
    description: 'Ignore lower layers under this clip.',
  },
]

const EPSILON = 0.001

export function normalizeClipCompositeMode(value) {
  return Object.values(CLIP_COMPOSITE_MODE).includes(value)
    ? value
    : CLIP_COMPOSITE_MODE.AUTO
}

function getAssetSize(asset) {
  const width = Number(asset?.settings?.width ?? asset?.width)
  const height = Number(asset?.settings?.height ?? asset?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

function getContainedMediaRect(asset, timelineWidth, timelineHeight) {
  const safeTimelineWidth = Math.max(1, Number(timelineWidth) || 1920)
  const safeTimelineHeight = Math.max(1, Number(timelineHeight) || 1080)
  const assetSize = getAssetSize(asset)
  if (!assetSize) {
    return {
      x: 0,
      y: 0,
      width: safeTimelineWidth,
      height: safeTimelineHeight,
    }
  }

  const scale = Math.min(safeTimelineWidth / assetSize.width, safeTimelineHeight / assetSize.height)
  const width = assetSize.width * scale
  const height = assetSize.height * scale
  return {
    x: (safeTimelineWidth - width) / 2,
    y: (safeTimelineHeight - height) / 2,
    width,
    height,
  }
}

function getTransformValue(transform, key, fallback) {
  const value = Number(transform?.[key])
  return Number.isFinite(value) ? value : fallback
}

function hasTransparentEffect(clip) {
  if (!Array.isArray(clip?.effects)) return false
  return clip.effects.some((effect) => {
    if (!effect || effect.enabled === false) return false
    if (effect.type === 'mask') return true
    if (effect.type === 'cameraShake') return true
    if (effect.type === 'vignette') return true
    if (effect.type === 'letterbox') return true
    return false
  })
}

export function isClipFullyObscuringLowerLayers(clip, options = {}) {
  if (!clip) return false
  if (clip.type !== 'video') return false
  // A track matte cuts this clip's alpha, so lower layers can show through.
  if (parseTrackMatte(clip.trackMatte)) return false

  const {
    time = 0,
    getAssetById = null,
    timelineWidth = 1920,
    timelineHeight = 1080,
    transformOverride = null,
  } = options

  const asset = clip.assetId && typeof getAssetById === 'function'
    ? getAssetById(clip.assetId)
    : null

  // Images and alpha-capable videos may contain transparent pixels.
  if (asset?.settings?.hasAlpha === true) return false

  const clipTime = Number(time) - (Number(clip.startTime) || 0)
  if (hasTransparentEffect(clip)) return false

  const transform = transformOverride || getAnimatedTransform(clip, clipTime) || clip.transform || {}
  // A pinned quad can expose any part of the frame beneath it.
  if (hasActiveCornerPin(transform)) return false
  const opacity = getTransformValue(transform, 'opacity', 100)
  const blendMode = transform?.blendMode || 'normal'
  const positionX = getTransformValue(transform, 'positionX', 0)
  const positionY = getTransformValue(transform, 'positionY', 0)
  const scaleX = getTransformValue(transform, 'scaleX', 100)
  const scaleY = getTransformValue(transform, 'scaleY', 100)
  const rotation = getTransformValue(transform, 'rotation', 0)
  const anchorX = getTransformValue(transform, 'anchorX', 50)
  const anchorY = getTransformValue(transform, 'anchorY', 50)
  const cropTop = getTransformValue(transform, 'cropTop', 0)
  const cropBottom = getTransformValue(transform, 'cropBottom', 0)
  const cropLeft = getTransformValue(transform, 'cropLeft', 0)
  const cropRight = getTransformValue(transform, 'cropRight', 0)

  if (opacity < 99.5 || blendMode !== 'normal') return false
  if (Math.abs(positionX) > EPSILON || Math.abs(positionY) > EPSILON) return false
  if (Math.abs(rotation) > EPSILON) return false
  if (cropTop > EPSILON || cropBottom > EPSILON || cropLeft > EPSILON || cropRight > EPSILON) return false

  // Scaling around non-center anchors can expose an edge in less obvious ways.
  // Be conservative: only auto-skip lower layers when the geometry is clearly safe.
  if ((Math.abs(scaleX - 100) > EPSILON || Math.abs(scaleY - 100) > EPSILON)
    && (Math.abs(anchorX - 50) > EPSILON || Math.abs(anchorY - 50) > EPSILON)) {
    return false
  }

  const rect = getContainedMediaRect(asset, timelineWidth, timelineHeight)
  const scaledWidth = rect.width * (scaleX / 100)
  const scaledHeight = rect.height * (scaleY / 100)
  return scaledWidth >= Number(timelineWidth) - EPSILON
    && scaledHeight >= Number(timelineHeight) - EPSILON
}

export function getClipLowerLayerCompositeStatus(clip, options = {}) {
  const mode = normalizeClipCompositeMode(clip?.compositeLowerLayers)

  if (mode === CLIP_COMPOSITE_MODE.ON) {
    return {
      mode,
      compositeLowerLayers: true,
      label: 'On',
      description: 'Always reading lower layers.',
    }
  }

  if (mode === CLIP_COMPOSITE_MODE.OFF) {
    return {
      mode,
      compositeLowerLayers: false,
      label: 'Off',
      description: 'Lower layers are ignored under this clip.',
    }
  }

  const fullyObscuring = isClipFullyObscuringLowerLayers(clip, options)
  return {
    mode,
    compositeLowerLayers: !fullyObscuring,
    label: fullyObscuring ? 'Auto: Off' : 'Auto: On',
    description: fullyObscuring
      ? 'Auto is skipping lower layers because this clip is full-frame, opaque, normal blend, and covers the canvas.'
      : 'Auto is reading lower layers because opacity, scale, crop, mask, rotation, blend mode, or transparent media could reveal them.',
  }
}

export function shouldStopAtClipForLowerLayers(clip, options = {}) {
  const mode = normalizeClipCompositeMode(clip?.compositeLowerLayers)
  if (mode === CLIP_COMPOSITE_MODE.OFF) return true
  if (mode === CLIP_COMPOSITE_MODE.ON) return false
  return isClipFullyObscuringLowerLayers(clip, options)
}

export function getTransitionClipIds(transitionInfo) {
  const ids = new Set()
  if (!transitionInfo) return ids
  if (transitionInfo.clip?.id) ids.add(transitionInfo.clip.id)
  if (transitionInfo.clipA?.id) ids.add(transitionInfo.clipA.id)
  if (transitionInfo.clipB?.id) ids.add(transitionInfo.clipB.id)
  return ids
}

export function cullVisualLayerEntries(entries = [], options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const visible = []
  const transitionClipIds = options.transitionClipIds || new Set()
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const clip = entry?.clip
    visible.unshift(entry)

    if (!clip || clip.type === 'adjustment') continue
    if (transitionClipIds.has(clip.id)) continue

    if (shouldStopAtClipForLowerLayers(clip, options)) {
      break
    }
  }

  return visible
}
