import { getShuttleKeyAction } from './shuttlePlayback.js'

const BLOCKED_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'slider', 'separator', 'menu', 'menuitem', 'listbox'])
const SPACE_MODIFIER_USED_EVENT = 'comfystudio-space-modifier-used'
const keyName = event => String(event?.key || '').toLowerCase()
const isSpace = event => event?.code === 'Space' || [' ', 'space', 'spacebar'].includes(keyName(event))
const tagName = element => String(element?.tagName || '').toUpperCase()

function ancestors(element) {
  const result = [], seen = new Set()
  while (element && !seen.has(element)) {
    seen.add(element)
    result.push(element)
    element = element.parentElement || element.parentNode
  }
  return result
}

function focusNodes(event, documentTarget) {
  return [event.target, documentTarget?.activeElement, ...(event.composedPath?.() || [])]
    .flatMap(ancestors)
}

function retainsNativeKeys(nodes) {
  return nodes.some(node => {
    const editable = node.getAttribute?.('contenteditable')
    return ['INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tagName(node)) || node.isContentEditable
      || (editable != null && String(editable).toLowerCase() !== 'false')
      || String(node.getAttribute?.('role') || '').toLowerCase().split(/\s+/).some(role => BLOCKED_ROLES.has(role))
  })
}

/** Capture-phase ownership for a viewer whose hidden editor stays mounted.
 * canHandle means this viewer owns the keyboard, even when it has no media.
 * All owned key events stop before hidden editor listeners. Native defaults
 * (text editing, Tab, sliders, button Enter and OS shortcuts) remain available;
 * target-level JavaScript key handlers deliberately do not receive these keys.
 * onFrameStep receives -1/1; onShuttle receives getShuttleKeyAction's object.
 */
export function attachViewerPresentationKeyboard({
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  canHandle = () => true,
  onExit,
  onTogglePlay,
  onFrameStep,
  onShuttle,
  onStart,
  onEnd,
} = {}) {
  if (!windowTarget?.addEventListener) return () => {}
  let disposed = false, pendingSpace = false, kHeld = false
  const listeners = []
  const reset = () => { pendingSpace = false; kHeld = false }
  const listen = (target, name, handler, capture = false) => {
    if (!target?.addEventListener) return
    target.addEventListener(name, handler, capture)
    listeners.push(() => target.removeEventListener(name, handler, capture))
  }
  const claim = event => {
    if (disposed || !canHandle()) { reset(); return false }
    event.stopImmediatePropagation?.()
    event.stopPropagation?.()
    return true
  }
  const nativeOnly = event => event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.altKey
    || documentTarget?.hidden || documentTarget?.visibilityState === 'hidden'
  const keyDown = event => {
    if (!claim(event)) return
    if (nativeOnly(event)) { reset(); return }
    const key = keyName(event)
    if (key === 'escape') {
      reset()
      event.preventDefault()
      if (!event.repeat) onExit?.()
      return
    }
    const nodes = focusNodes(event, documentTarget)
    if (retainsNativeKeys(nodes)) { reset(); return }
    // Shift can be pressed after K to form a slow-shuttle chord. All other
    // modifiers or focus/lifecycle changes retire held transport gestures.
    if (key === 'shift') { pendingSpace = false; return }
    if (event.shiftKey && !['j', 'k', 'l'].includes(key)) { reset(); return }
    if (isSpace(event)) {
      event.preventDefault()
      if (!event.repeat) pendingSpace = true
      return
    }
    pendingSpace = false
    if (key === 'enter') {
      if (nodes.some(node => ['BUTTON', 'A'].includes(tagName(node)) || node.getAttribute?.('role') === 'button')) return
      event.preventDefault()
      if (!event.repeat) onTogglePlay?.()
      return
    }
    if (key === 'arrowleft' || key === 'arrowright') {
      event.preventDefault()
      onFrameStep?.(key === 'arrowleft' ? -1 : 1)
      return
    }
    if (key === 'home' || key === 'end') {
      event.preventDefault()
      if (!event.repeat) (key === 'home' ? onStart : onEnd)?.()
      return
    }
    if (['j', 'k', 'l'].includes(key)) {
      event.preventDefault()
      const action = getShuttleKeyAction(event, kHeld)
      if (action?.type === 'pause') kHeld = true
      if (action) onShuttle?.(action)
    }
  }
  const keyUp = event => {
    const space = isSpace(event), wasPending = pendingSpace
    if (space) pendingSpace = false
    if (keyName(event) === 'k') kHeld = false
    if (!claim(event)) return
    if (nativeOnly(event) || retainsNativeKeys(focusNodes(event, documentTarget))) { reset(); return }
    if (!space || event.shiftKey) return
    // Prevent a keyup without a matching owned keydown from activating a
    // focused native button after a pointer, focus or presentation change.
    event.preventDefault()
    if (wasPending && !event.repeat) onTogglePlay?.()
  }

  listen(windowTarget, 'keydown', keyDown, true)
  listen(windowTarget, 'keyup', keyUp, true)
  listen(windowTarget, 'blur', reset)
  listen(windowTarget, SPACE_MODIFIER_USED_EVENT, reset)
  listen(documentTarget, 'visibilitychange', reset)
  listen(documentTarget, 'focusin', reset, true)
  listen(documentTarget, 'pointerdown', reset, true)
  listen(documentTarget, 'mousedown', reset, true)
  return () => {
    if (disposed) return
    disposed = true
    reset()
    for (const remove of listeners) remove()
  }
}
