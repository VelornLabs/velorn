/**
 * Content signature for per-clip render bakes.
 *
 * A full bake (cacheKind 'full') is valid only while the clip's
 * bake-relevant content matches what was rendered. Rather than patching
 * every store mutation to invalidate caches (and hoping future mutations
 * remember to), consumers compare the signature captured at render time
 * against the clip's current signature. Store mutations always produce new
 * clip objects (zustand immutability), so a WeakMap memo makes the check
 * O(1) per clip version — cheap enough for per-frame render paths.
 *
 * Deliberately EXCLUDED from the signature: startTime/trackId (moving a
 * clip doesn't change its baked pixels), opacity/blendMode (kept live by
 * the bake contract), and transitions (composited live over the bake).
 */
const clipBakeSignatureCache = new WeakMap()

export const getClipBakeSignature = (clip) => {
  if (!clip || typeof clip !== 'object') return ''
  const cached = clipBakeSignatureCache.get(clip)
  if (cached !== undefined) return cached

  const transform = clip.transform || {}
  const signature = JSON.stringify({
    type: clip.type,
    assetId: clip.assetId || null,
    url: clip.url || null,
    duration: clip.duration,
    trimStart: clip.trimStart ?? null,
    trimEnd: clip.trimEnd ?? null,
    sourceTimeScale: clip.sourceTimeScale ?? null,
    speed: clip.speed ?? null,
    reverse: !!clip.reverse,
    // Opacity/blendMode stay live; everything else about the transform is baked.
    transform: { ...transform, opacity: undefined, blendMode: undefined },
    keyframes: clip.keyframes || null,
    effects: clip.effects || null,
    adjustments: clip.adjustments || null,
    text: clip.text ?? null,
    textProperties: clip.textProperties || null,
    shapeProperties: clip.shapeProperties || null,
  })
  clipBakeSignatureCache.set(clip, signature)
  return signature
}

/** A full bake is fresh only when its stored signature matches the clip's current content. */
export const isFullBakeFresh = (clip) => (
  !!clip
  && clip.cacheStatus === 'cached'
  && clip.cacheKind === 'full'
  && !!clip.cacheUrl
  && !!clip.cacheSignature
  && clip.cacheSignature === getClipBakeSignature(clip)
)
