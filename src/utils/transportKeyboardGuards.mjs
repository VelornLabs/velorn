// Shared focus/lifecycle boundary for Editor and Source transport. These
// guards do not register shortcuts or change the editor's binding priority.
const BLOCKED_ROLES = new Set(['textbox', 'combobox', 'spinbutton', 'slider', 'separator', 'menu', 'menuitem', 'listbox'])
const MODAL_SELECTOR = '[aria-modal="true"], [role="dialog"], .fixed.inset-0'

export const isComposingKeyEvent = event => Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229)
export const isSpaceKey = event => event?.code === 'Space' || [' ', 'Space', 'Spacebar'].includes(event?.key)

function ancestors(element) {
  const result = [], seen = new Set()
  while (element && !seen.has(element)) {
    seen.add(element); result.push(element)
    element = element.parentElement || element.parentNode
  }
  return result
}

// A selected reply is not a form control: its key event can still target BODY
// or the previously focused timeline. Reserve Copy/Cut before custom bindings
// and clip shortcuts, while preserving normal editor keys without text focus.
export function isNativeTextKeyboardEvent(event, { documentTarget = globalThis.document,
  windowTarget = globalThis.window } = {}) {
  const ownsText = element => ancestors(element).some(node => node.getAttribute?.('data-editor-keyboard-scope') === 'text')
  if ([event?.target, documentTarget?.activeElement, ...(event?.composedPath?.() || [])].some(ownsText)) return true
  const key = String(event?.key || '').toLowerCase()
  const copyOrCut = !event?.altKey && (((event?.ctrlKey || event?.metaKey) && ['c', 'x'].includes(key))
    || (event?.ctrlKey && key === 'insert') || (event?.shiftKey && key === 'delete'))
  if (!copyOrCut) return false
  const selection = documentTarget?.getSelection?.() || windowTarget?.getSelection?.()
  return Boolean(selection && !selection.isCollapsed && selection.toString())
}

export function isNativeTransportActivation(event, documentTarget = globalThis.document) {
  return [event?.target, documentTarget?.activeElement].some(element => ancestors(element).some(node =>
    ['BUTTON', 'A'].includes(String(node.tagName || '').toUpperCase()) || node.getAttribute?.('role') === 'button'))
}

export function hasVisibleKeyboardModal(documentTarget = globalThis.document, windowTarget = globalThis.window) {
  const styleOwner = documentTarget?.defaultView || windowTarget
  return [...(documentTarget?.querySelectorAll?.(MODAL_SELECTOR) || [])].some(element => {
    if (!element.getClientRects?.().length) return false
    const style = styleOwner?.getComputedStyle?.(element) || element.style || {}
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  })
}

export function isTransportKeyboardBlocked(event, { documentTarget = globalThis.document, windowTarget = globalThis.window,
  allowDefaultPrevented = false } = {}) {
  if ((!allowDefaultPrevented && event?.defaultPrevented) || isComposingKeyEvent(event)
    || documentTarget?.hidden || documentTarget?.visibilityState === 'hidden') return true
  if (isNativeTextKeyboardEvent(event, { documentTarget, windowTarget })) return true
  const blockedElement = element => ancestors(element).some(node => {
    const tag = String(node.tagName || '').toUpperCase()
    const editable = node.getAttribute?.('contenteditable')
    return ['INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag) || node.isContentEditable
      || (editable != null && String(editable).toLowerCase() !== 'false')
      || String(node.getAttribute?.('role') || '').toLowerCase().split(/\s+/).some(role => BLOCKED_ROLES.has(role))
  })
  if ([event?.target, documentTarget?.activeElement, ...(event?.composedPath?.() || [])].some(blockedElement)) return true
  return hasVisibleKeyboardModal(documentTarget, windowTarget)
}
