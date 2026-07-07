/**
 * Track matte support: a clip can use the visual layer directly above it as
 * an alpha or luma matte. The matte layer itself is consumed (hidden from
 * normal output) while its pixels cut the matted clip's alpha.
 */

export const TRACK_MATTE_NONE = 'none'

export const TRACK_MATTE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'alpha', label: 'Alpha Matte (layer above)' },
  { value: 'alpha-inverted', label: 'Alpha Inverted Matte' },
  { value: 'luma', label: 'Luma Matte (layer above)' },
  { value: 'luma-inverted', label: 'Luma Inverted Matte' },
]

const VALID_MODES = new Set(TRACK_MATTE_OPTIONS.map((option) => option.value))

export function normalizeTrackMatte(value) {
  const normalized = String(value || TRACK_MATTE_NONE).trim().toLowerCase()
  return VALID_MODES.has(normalized) ? normalized : TRACK_MATTE_NONE
}

/**
 * @returns {null | { channel: 'alpha'|'luma', invert: boolean }}
 */
export function parseTrackMatte(value) {
  const mode = normalizeTrackMatte(value)
  if (mode === TRACK_MATTE_NONE) return null
  return {
    channel: mode.startsWith('alpha') ? 'alpha' : 'luma',
    invert: mode.endsWith('-inverted'),
  }
}

/**
 * Pair matted clips with their matte source: the visual layer entry directly
 * above in the stack. Entries must be in draw order (index 0 = bottom layer,
 * last = top layer), the order both renderers already build.
 *
 * @param {Array<{ clip: Object }>} entries
 * @returns {{ matteEntryByClipId: Map<string, Object>, consumedClipIds: Set<string> }}
 */
export function resolveTrackMatteAssignments(entries = []) {
  const matteEntryByClipId = new Map()
  const consumedClipIds = new Set()

  for (let index = 0; index < entries.length; index += 1) {
    const clip = entries[index]?.clip
    if (!clip || !parseTrackMatte(clip.trackMatte)) continue
    // Adjustment clips grade the stage rather than drawing pixels, so they
    // can neither carry nor provide a matte.
    if (clip.type === 'adjustment') continue

    const above = entries[index + 1]
    if (!above?.clip || above.clip.type === 'adjustment') continue

    matteEntryByClipId.set(clip.id, above)
    consumedClipIds.add(above.clip.id)
  }

  return { matteEntryByClipId, consumedClipIds }
}

/**
 * Apply a rastered matte canvas to a 2D layer canvas in place.
 * Alpha mattes use native compositing; luma mattes run the same full-frame
 * luminance loop the 2D mask path already uses.
 */
export function applyTrackMatteToCanvas(layerCtx, matteCanvas, matteInfo, width, height) {
  if (!layerCtx || !matteCanvas || !matteInfo) return

  if (matteInfo.channel === 'alpha') {
    layerCtx.save()
    layerCtx.filter = 'none'
    layerCtx.globalAlpha = 1
    layerCtx.globalCompositeOperation = matteInfo.invert ? 'destination-out' : 'destination-in'
    layerCtx.drawImage(matteCanvas, 0, 0)
    layerCtx.restore()
    return
  }

  const matteCtx = matteCanvas.getContext('2d', { willReadFrequently: true })
  if (!matteCtx) return
  const layerData = layerCtx.getImageData(0, 0, width, height)
  const matteData = matteCtx.getImageData(0, 0, width, height)
  const layerPixels = layerData.data
  const mattePixels = matteData.data

  for (let i = 0; i < layerPixels.length; i += 4) {
    // Straight-alpha canvas: scale luminance by matte alpha so transparent
    // matte areas read 0, matching the GPU path's premultiplied luminance.
    const lum = (mattePixels[i] + mattePixels[i + 1] + mattePixels[i + 2]) / 3
    const coverage = (lum * mattePixels[i + 3]) / (255 * 255)
    const value = matteInfo.invert ? 1 - coverage : coverage
    layerPixels[i + 3] = Math.round(layerPixels[i + 3] * value)
  }

  layerCtx.putImageData(layerData, 0, 0)
}
