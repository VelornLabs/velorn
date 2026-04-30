import { memo, useCallback, useEffect, useRef } from 'react'
import { createGlslEffectRenderer } from '../../utils/glslEffects'

const GlslEffectCanvas = memo(function GlslEffectCanvas({
  sourceRef = null,
  sourceUrl = '',
  effects = [],
  clipTime = 0,
  className = '',
  style = {},
  onRenderState = null,
}) {
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const imageRef = useRef(null)
  const latestRef = useRef({ effects, clipTime })
  const renderedRef = useRef(false)

  latestRef.current = { effects, clipTime }

  const setRendered = useCallback((next) => {
    if (renderedRef.current === next) return
    renderedRef.current = next
    if (typeof onRenderState === 'function') onRenderState(next)
  }, [onRenderState])

  useEffect(() => {
    if (!sourceUrl) {
      imageRef.current = null
      setRendered(false)
      return undefined
    }

    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => setRendered(false)
    image.onerror = () => setRendered(false)
    imageRef.current = image
    image.src = sourceUrl

    return () => {
      if (imageRef.current === image) imageRef.current = null
    }
  }, [sourceUrl, setRendered])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    let disposed = false
    let rafId = 0

    try {
      rendererRef.current = createGlslEffectRenderer(canvas)
    } catch (err) {
      console.warn('Could not initialize GLSL effect renderer.', err)
      setRendered(false)
      return undefined
    }

    const renderFrame = () => {
      if (disposed) return
      const loadedImage = imageRef.current?.naturalWidth > 0 ? imageRef.current : null
      const source = loadedImage || sourceRef?.current
      if (source) {
        try {
          const { effects: latestEffects, clipTime: latestClipTime } = latestRef.current
          const rendered = Boolean(rendererRef.current?.render(source, latestEffects, latestClipTime))
          setRendered(rendered)
        } catch (err) {
          console.warn('GLSL effect preview failed.', err)
          setRendered(false)
        }
      } else {
        setRendered(false)
      }
      rafId = requestAnimationFrame(renderFrame)
    }

    rafId = requestAnimationFrame(renderFrame)

    return () => {
      disposed = true
      if (rafId) cancelAnimationFrame(rafId)
      rendererRef.current?.dispose()
      rendererRef.current = null
      setRendered(false)
    }
  }, [sourceRef, setRendered])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        backgroundColor: 'transparent',
        pointerEvents: 'none',
        zIndex: 2,
        ...style,
      }}
    />
  )
})

export default GlslEffectCanvas
