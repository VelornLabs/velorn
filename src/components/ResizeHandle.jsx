import { useState, useCallback, useLayoutEffect, useRef } from 'react'

function ResizeHandle({ 
  direction = 'horizontal', // 'horizontal' (left-right) or 'vertical' (up-down)
  onResize,
  className = ''
}) {
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef(null)

  const finishDrag = useCallback((updateState = true) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    drag.window.removeEventListener('blur', drag.onBlur)
    for (const [key, value, priority] of drag.previousStyles) {
      if (value) drag.style.setProperty(key, value, priority)
      else drag.style.removeProperty(key)
    }
    try {
      if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
    } catch { /* A workspace change may already have detached the handle. */ }
    if (updateState) setIsDragging(false)
  }, [])

  const handlePointerDown = useCallback(event => {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) return
    const element = event.currentTarget
    // Capture keeps movement/release in this document over embedded ComfyUI,
    // and supports touch/pen without adding listeners inside another frame.
    try { element.setPointerCapture(event.pointerId) } catch { return }
    event.preventDefault()
    const ownerWindow = element.ownerDocument.defaultView
    const style = element.ownerDocument.body.style
    const onBlur = () => finishDrag()
    dragRef.current = { element, pointerId: event.pointerId, window: ownerWindow, style, onBlur,
      previousStyles: ['cursor', 'user-select'].map(key => [key, style.getPropertyValue(key), style.getPropertyPriority(key)]) }
    style.setProperty('user-select', 'none')
    style.setProperty('cursor', direction === 'horizontal' ? 'col-resize' : 'row-resize')
    ownerWindow.addEventListener('blur', onBlur)
    setIsDragging(true)
  }, [direction, finishDrag])

  const resizeFromPointer = useCallback(event => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    onResize(direction === 'horizontal' ? event.clientX : event.clientY)
  }, [direction, onResize])

  useLayoutEffect(() => () => finishDrag(false), [finishDrag])

  const baseStyles = direction === 'horizontal' 
    ? 'w-1 cursor-col-resize hover:bg-sf-accent/50 active:bg-sf-accent' 
    : 'h-1 cursor-row-resize hover:bg-sf-accent/50 active:bg-sf-accent'

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        if (event.pointerType === 'mouse' && event.buttons === 0) { finishDrag(); return }
        try { resizeFromPointer(event) } catch (error) { finishDrag(); throw error }
      }}
      onPointerUp={event => {
        if (dragRef.current?.pointerId !== event.pointerId) return
        try { resizeFromPointer(event) } finally { finishDrag() }
      }}
      onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) finishDrag() }}
      onLostPointerCapture={event => { if (dragRef.current?.pointerId === event.pointerId) finishDrag() }}
      className={`
        ${baseStyles}
        ${isDragging ? 'bg-sf-accent' : 'bg-transparent'}
        transition-colors duration-150
        flex-shrink-0
        touch-none
        z-10
        group
        ${className}
      `}
    >
      {/* Visual indicator on hover */}
      <div 
        className={`
          ${direction === 'horizontal' ? 'w-0.5 h-full mx-auto' : 'h-0.5 w-full my-auto'}
          ${isDragging ? 'bg-sf-accent' : 'bg-sf-dark-600 group-hover:bg-sf-accent/70'}
          transition-colors
        `}
      />
    </div>
  )
}

export default ResizeHandle
