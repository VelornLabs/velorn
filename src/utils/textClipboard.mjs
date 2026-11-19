// Renderer-only text operations. Nothing here reads the system clipboard or
// exposes it to an agent; callers run these from explicit Copy gestures.
export async function copyTextToClipboard(text, { api = globalThis.window?.electronAPI,
  navigatorTarget = globalThis.navigator, documentTarget = globalThis.document } = {}) {
  if (typeof text !== 'string' || !text.length) throw new Error('There is no text to copy.')
  if (typeof api?.writeClipboardText === 'function') {
    const result = await api.writeClipboardText(text)
    if (result?.success !== true) throw new Error('The text could not be copied.')
    return
  }
  // Old preload/browser previews retain a working copy path without a restart.
  if (typeof navigatorTarget?.clipboard?.writeText === 'function') {
    try { await navigatorTarget.clipboard.writeText(text); return } catch (_) { /* Legacy browser fallback below. */ }
  }
  if (!documentTarget?.body || typeof documentTarget.execCommand !== 'function') {
    throw new Error('Copy is unavailable. Select the text and use your system Copy shortcut.')
  }
  const active = documentTarget.activeElement
  const inputSelection = typeof active?.selectionStart === 'number'
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null
  const selection = documentTarget.getSelection?.()
  const ranges = []
  for (let index = 0; index < (selection?.rangeCount || 0); index++) ranges.push(selection.getRangeAt(index).cloneRange())
  const field = documentTarget.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.setAttribute('aria-hidden', 'true')
  Object.assign(field.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0' })
  documentTarget.body.appendChild(field)
  try {
    field.select()
    if (!documentTarget.execCommand('copy')) throw new Error('Copy failed. Select the text and use your system Copy shortcut.')
  } finally {
    field.remove()
    active?.focus?.({ preventScroll: true })
    if (inputSelection) active.setSelectionRange?.(inputSelection.start, inputSelection.end, inputSelection.direction)
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

export function selectedTextWithin(element, documentTarget = globalThis.document) {
  const selection = documentTarget?.getSelection?.()
  if (!selection || selection.isCollapsed || !element?.contains?.(selection.anchorNode)
    || !element.contains(selection.focusNode)) return ''
  return selection.toString()
}
