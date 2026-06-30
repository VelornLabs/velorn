export const DEFAULT_LETTERBOX_ASPECT = 2.39

// Common cinematic and delivery ratios, plus a custom option.
export const LETTERBOX_ASPECT_PRESETS = [
  { id: '2.76', label: '2.76:1 (Ultra Panavision)', value: 2.76 },
  { id: '2.39', label: '2.39:1 (Anamorphic)', value: 2.39 },
  { id: '2.35', label: '2.35:1 (Cinemascope)', value: 2.35 },
  { id: '2.20', label: '2.20:1 (70mm)', value: 2.2 },
  { id: '2.00', label: '2.00:1 (Univisium)', value: 2.0 },
  { id: '1.90', label: '1.90:1 (IMAX Digital)', value: 1.9 },
  { id: '1.85', label: '1.85:1 (Theatrical)', value: 1.85 },
  { id: '1.78', label: '16:9 (HD)', value: 16 / 9 },
  { id: 'custom', label: 'Custom ratio...', value: null },
]

export function parseAspectRatio(value, fallback = DEFAULT_LETTERBOX_ASPECT) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function resolveLetterboxAspect(presetId, customAspect, fallback = DEFAULT_LETTERBOX_ASPECT) {
  if (presetId === 'custom') {
    return parseAspectRatio(customAspect, fallback)
  }
  return parseAspectRatio(presetId, fallback)
}

/**
 * Returns centered content rect for a target aspect inside width/height frame.
 * Outside this rect are the letterbox bars.
 */
export function getLetterboxContentRect(width, height, targetAspect) {
  const safeWidth = Math.max(1, Number(width) || 1)
  const safeHeight = Math.max(1, Number(height) || 1)
  const safeAspect = parseAspectRatio(targetAspect, DEFAULT_LETTERBOX_ASPECT)

  const contentHeightIfFullWidth = safeWidth / safeAspect
  const contentWidthIfFullHeight = safeHeight * safeAspect

  if (contentHeightIfFullWidth <= safeHeight) {
    const contentHeight = contentHeightIfFullWidth
    const offsetY = (safeHeight - contentHeight) / 2
    return {
      width: safeWidth,
      height: contentHeight,
      offsetX: 0,
      offsetY,
    }
  }

  const contentWidth = contentWidthIfFullHeight
  const offsetX = (safeWidth - contentWidth) / 2
  return {
    width: contentWidth,
    height: safeHeight,
    offsetX,
    offsetY: 0,
  }
}

/**
 * Generate transparent PNG with solid bars outside target aspect.
 */
export function generateLetterboxOverlayBlob(width, height, targetAspect, barColor) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(Number(width) || 1))
  canvas.height = Math.max(1, Math.round(Number(height) || 1))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return Promise.reject(new Error('Canvas context unavailable'))
  }

  const rect = getLetterboxContentRect(canvas.width, canvas.height, targetAspect)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = barColor || '#000000'

  if (rect.offsetY > 0) {
    // Top + bottom bars
    ctx.fillRect(0, 0, canvas.width, rect.offsetY)
    ctx.fillRect(0, rect.offsetY + rect.height, canvas.width, canvas.height - (rect.offsetY + rect.height))
  } else if (rect.offsetX > 0) {
    // Left + right pillar bars
    ctx.fillRect(0, 0, rect.offsetX, canvas.height)
    ctx.fillRect(rect.offsetX + rect.width, 0, canvas.width - (rect.offsetX + rect.width), canvas.height)
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

export function generateColorMatteBlob(width, height, color) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(Number(width) || 1))
  canvas.height = Math.max(1, Math.round(Number(height) || 1))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return Promise.reject(new Error('Canvas context unavailable'))
  }
  ctx.fillStyle = color || '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
  })
}
