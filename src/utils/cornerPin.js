/**
 * Corner pin distort: per-corner pixel offsets applied to a clip's
 * transformed quad (screen replacements, device mockups). Offsets live flat
 * on the transform (cornerPinTLX ... cornerPinBRY, timeline px) so the
 * generic keyframe machinery animates them; transform.cornerPinEnabled
 * gates the whole effect.
 *
 * GPU-only in v1: the compositor's projective layer quads take per-vertex
 * homogeneous w, so a pinned quad just needs its w weights recomputed. The
 * canvas-2D fallback paths ignore the pin.
 */

// TL, TR, BL, BR — matches getClipQuadCorners' triangle-strip order.
export const CORNER_PIN_KEYS = [
  ['cornerPinTLX', 'cornerPinTLY'],
  ['cornerPinTRX', 'cornerPinTRY'],
  ['cornerPinBLX', 'cornerPinBLY'],
  ['cornerPinBRX', 'cornerPinBRY'],
]

export const CORNER_PIN_CORNERS = [
  { key: 'TL', label: 'Top Left', xKey: 'cornerPinTLX', yKey: 'cornerPinTLY' },
  { key: 'TR', label: 'Top Right', xKey: 'cornerPinTRX', yKey: 'cornerPinTRY' },
  { key: 'BL', label: 'Bottom Left', xKey: 'cornerPinBLX', yKey: 'cornerPinBLY' },
  { key: 'BR', label: 'Bottom Right', xKey: 'cornerPinBRX', yKey: 'cornerPinBRY' },
]

export function hasActiveCornerPin(transform = {}) {
  if (!transform || transform.cornerPinEnabled !== true) return false
  return CORNER_PIN_KEYS.some(([xKey, yKey]) => (
    Math.abs(Number(transform[xKey]) || 0) > 0.001
    || Math.abs(Number(transform[yKey]) || 0) > 0.001
  ))
}

function intersectSegments(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x
  const d1y = p2.y - p1.y
  const d2x = p4.x - p3.x
  const d2y = p4.y - p3.y
  const denominator = d1x * d2y - d1y * d2x
  if (Math.abs(denominator) < 1e-9) return null
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denominator
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denominator
  // Diagonals of a convex quad cross strictly inside both segments; anything
  // else means a concave/crossed quad where the projective weights break.
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null
  return { x: p1.x + t * d1x, y: p1.y + t * d1y }
}

/**
 * Apply pin offsets to a projected quad (corners: [{x, y, u, v, w}] in
 * TL, TR, BL, BR order) and recompute per-vertex w so hardware varying
 * interpolation stays projective for the pinned shape.
 *
 * Diagonal-intersection weights: w_i = (d_i + d_opposite) / d_i, where d is
 * the distance from a corner to the diagonals' crossing. Corners near the
 * crossing sit on the quad's "far" (compressed) side and need the larger w
 * — verified against a real pinhole projection of a tilted square.
 * Concave/degenerate quads fall back to affine (w = 1).
 */
export function applyCornerPinToQuad(corners, transform = {}) {
  if (!Array.isArray(corners) || corners.length !== 4) return corners

  const pinned = corners.map((corner, index) => {
    const [xKey, yKey] = CORNER_PIN_KEYS[index]
    return {
      ...corner,
      x: corner.x + (Number(transform[xKey]) || 0),
      y: corner.y + (Number(transform[yKey]) || 0),
    }
  })

  const [tl, tr, bl, br] = pinned
  const center = intersectSegments(tl, br, tr, bl)
  if (!center) {
    return pinned.map((corner) => ({ ...corner, w: 1 }))
  }

  const distances = pinned.map((corner) => Math.hypot(corner.x - center.x, corner.y - center.y))
  const oppositeIndex = [3, 2, 1, 0]
  return pinned.map((corner, index) => {
    const d = distances[index]
    const dOpposite = distances[oppositeIndex[index]]
    if (!(d > 0.0001) || !(dOpposite > 0.0001)) return { ...corner, w: 1 }
    return { ...corner, w: (d + dOpposite) / d }
  })
}
