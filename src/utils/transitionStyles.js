/**
 * Shared transition style math for the canvas compositors.
 *
 * Single source of truth consumed by BOTH the live preview
 * (CanvasPreviewRenderer) and the exporter — these two previously carried
 * duplicated switch statements that had already drifted (edge-mode fade
 * overlays rendered on export but not in preview). Any new transition type
 * added here works in both automatically.
 *
 * The style model is what 2D-canvas compositing can express per clip side:
 *   { opacity, translateX/Y (fraction of frame), scale, clipInset, blur, display }
 * plus a full-frame color overlay described by getFadeOverlayInfo().
 */

const easeInQuad = (t) => t * t
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t)
const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2)

export const getTransitionCanvasStyle = (transitionInfo, isVideoA) => {
  if (!transitionInfo) {
    return { opacity: isVideoA ? 1 : 0, display: isVideoA }
  }

  const { transition, progress } = transitionInfo
  const type = transition?.type || 'dissolve'
  const zoomAmount = transition?.settings?.zoomAmount ?? 0.1
  const blurAmount = transition?.settings?.blurAmount ?? 8
  const edgeMode = transition?.kind === 'edge'
  const edge = transitionInfo?.edge
  const effectiveIsVideoA = edgeMode ? edge === 'out' : isVideoA

  const base = {
    opacity: 1,
    translateX: 0,
    translateY: 0,
    scale: 1,
    clipInset: null,
    blur: 0,
    display: true,
  }

  if (edgeMode && (type === 'fade-black' || type === 'fade-white' || type === 'dip-color')) {
    const opacity = effectiveIsVideoA ? 1 - progress : progress
    return { ...base, opacity }
  }
  if (edgeMode && type === 'flash') {
    // The pop comes entirely from the overlay; the clip stays fully visible.
    return { ...base }
  }

  if (type === 'cross-zoom') {
    // One continuous accelerating zoom through the cut: outgoing ramps up
    // to full zoom + blur at the seam, incoming settles back down from it.
    const zoom = transition?.settings?.zoomAmount ?? 0.4
    const zoomBlur = transition?.settings?.blurAmount ?? 12
    if (effectiveIsVideoA) {
      const local = Math.min(1, progress * 2)
      const drive = easeInQuad(local)
      return {
        ...base,
        scale: 1 + drive * zoom,
        blur: drive * zoomBlur,
        display: progress < 0.5,
      }
    }
    const local = Math.max(0, (progress - 0.5) * 2)
    const settle = 1 - easeOutQuad(local)
    return {
      ...base,
      scale: 1 + settle * zoom,
      blur: settle * zoomBlur,
      display: progress >= 0.5,
    }
  }

  if (type === 'whip-left' || type === 'whip-right') {
    // Push both clips with an ease-in-out ramp and blur that peaks at max
    // velocity mid-transition (gaussian stands in for directional smear).
    const whipBlur = transition?.settings?.blurAmount ?? 16
    const ease = easeInOutQuad(progress)
    const blur = Math.sin(progress * Math.PI) ** 1.5 * whipBlur
    const direction = type === 'whip-left' ? -1 : 1
    if (effectiveIsVideoA) {
      return { ...base, translateX: direction * ease, blur }
    }
    return { ...base, translateX: direction * (ease - 1), blur }
  }

  if (type === 'flash') {
    // Hard cut at the midpoint; the additive pop is drawn by the overlay.
    if (effectiveIsVideoA) {
      return { ...base, display: progress < 0.5 }
    }
    return { ...base, display: progress >= 0.5 }
  }

  if (effectiveIsVideoA) {
    switch (type) {
      case 'dissolve':
        // Keep outgoing clip fully opaque and fade incoming over it.
        // Fading both layers in source-over darkens the midpoint.
        return { ...base, opacity: 1 }
      case 'fade-black':
      case 'fade-white':
      case 'dip-color':
        return { ...base, opacity: progress < 0.5 ? 1 - progress * 2 : 0 }
      case 'wipe-left':
        return { ...base, clipInset: { top: 0, right: progress, bottom: 0, left: 0 } }
      case 'wipe-right':
        return { ...base, clipInset: { top: 0, right: 0, bottom: 0, left: progress } }
      case 'wipe-up':
        return { ...base, clipInset: { top: 0, right: 0, bottom: progress, left: 0 } }
      case 'wipe-down':
        return { ...base, clipInset: { top: progress, right: 0, bottom: 0, left: 0 } }
      case 'slide-left':
        return { ...base, translateX: -progress }
      case 'slide-right':
        return { ...base, translateX: progress }
      case 'slide-up':
        return { ...base, translateY: -progress }
      case 'slide-down':
        return { ...base, translateY: progress }
      case 'zoom-in':
        return { ...base, scale: 1 + progress * zoomAmount, opacity: 1 - progress }
      case 'zoom-out':
        return { ...base, scale: 1 - progress * zoomAmount, opacity: 1 - progress }
      case 'blur':
        return { ...base, blur: progress * blurAmount, opacity: 1 - progress }
      default:
        return { ...base, opacity: 1 - progress }
    }
  }

  switch (type) {
    case 'dissolve':
      return { ...base, opacity: progress }
    case 'fade-black':
    case 'fade-white':
    case 'dip-color':
      return { ...base, opacity: progress > 0.5 ? (progress - 0.5) * 2 : 0 }
    case 'wipe-left':
      return { ...base, clipInset: { top: 0, right: 0, bottom: 0, left: 1 - progress } }
    case 'wipe-right':
      return { ...base, clipInset: { top: 0, right: 1 - progress, bottom: 0, left: 0 } }
    case 'wipe-up':
      return { ...base, clipInset: { top: 1 - progress, right: 0, bottom: 0, left: 0 } }
    case 'wipe-down':
      return { ...base, clipInset: { top: 0, right: 0, bottom: 1 - progress, left: 0 } }
    case 'slide-left':
      return { ...base, translateX: 1 - progress }
    case 'slide-right':
      return { ...base, translateX: -(1 - progress) }
    case 'slide-up':
      return { ...base, translateY: 1 - progress }
    case 'slide-down':
      return { ...base, translateY: -(1 - progress) }
    case 'zoom-in':
      return { ...base, scale: 1 - zoomAmount + progress * zoomAmount, opacity: progress }
    case 'zoom-out':
      return { ...base, scale: 1 + zoomAmount - progress * zoomAmount, opacity: progress }
    case 'blur':
      return { ...base, blur: (1 - progress) * blurAmount, opacity: progress }
    default:
      return { ...base, opacity: progress }
  }
}

const getOverlayColor = (transition) => {
  const type = transition?.type
  if (type === 'fade-white') return '#FFFFFF'
  if (type === 'flash') return transition?.settings?.color || '#FFFFFF'
  if (type === 'dip-color') return transition?.settings?.color || '#000000'
  return '#000000'
}

/**
 * Full-frame color overlay for fade/dip/flash transitions.
 * Returns { opacity, color } or null. Edge-mode transitions get overlays
 * too (this previously worked on export but not in preview).
 */
export const getFadeOverlayInfo = (transitionInfo) => {
  if (!transitionInfo) return null

  const { transition, progress } = transitionInfo
  const type = transition?.type
  const edgeMode = transition?.kind === 'edge'
  const edge = transitionInfo?.edge

  if (type === 'flash') {
    // Fast attack/decay exposure pop, peaking at the cut (or clip edge).
    const distance = edgeMode
      ? (edge === 'in' ? progress : 1 - progress)
      : Math.abs(2 * progress - 1)
    return {
      opacity: Math.pow(Math.max(0, 1 - distance), edgeMode ? 2.2 : 0.6),
      color: getOverlayColor(transition),
    }
  }

  if (type !== 'fade-black' && type !== 'fade-white' && type !== 'dip-color') return null

  if (edgeMode) {
    return {
      opacity: edge === 'in' ? (1 - progress) : progress,
      color: getOverlayColor(transition),
    }
  }

  return {
    opacity: progress < 0.5 ? progress * 2 : (1 - progress) * 2,
    color: getOverlayColor(transition),
  }
}

export const applyTransitionClip = (ctx, rect, transitionStyle) => {
  if (!transitionStyle?.clipInset) return
  const { top, right, bottom, left } = transitionStyle.clipInset
  const insetTop = rect.height * top
  const insetRight = rect.width * right
  const insetBottom = rect.height * bottom
  const insetLeft = rect.width * left
  ctx.beginPath()
  ctx.rect(insetLeft, insetTop, rect.width - insetLeft - insetRight, rect.height - insetTop - insetBottom)
  ctx.clip()
}

export const getTransitionStyleForClip = (transitionInfo, clip) => {
  if (!transitionInfo || !clip) return null
  if (transitionInfo.transition?.kind === 'edge') {
    if (transitionInfo.clip?.id !== clip.id) return null
    return getTransitionCanvasStyle(transitionInfo, transitionInfo.edge === 'out')
  }
  if (transitionInfo.clipA?.id === clip.id) return getTransitionCanvasStyle(transitionInfo, true)
  if (transitionInfo.clipB?.id === clip.id) return getTransitionCanvasStyle(transitionInfo, false)
  return null
}
