const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isInClosedDetails(element, container) {
  let child = element
  for (let ancestor = element.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
      const summary = [...ancestor.children].find((entry) => entry.tagName === 'SUMMARY')
      // Closed details can still report child layout rectangles in Chromium.
      // Only the first direct summary (and its descendants) remains exposed.
      if (child !== summary) return true
    }
    child = ancestor
  }
  return false
}

function getFocusableElements(container) {
  if (!container?.querySelectorAll) return []
  return [...container.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)].filter((element) => (
    element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
    && !isInClosedDetails(element, container)
  ))
}

export function trapDialogFocus(event, container) {
  if (event.key !== 'Tab' || !container) return false

  const focusable = getFocusableElements(container)
  if (focusable.length === 0) {
    event.preventDefault()
    container.focus?.()
    return true
  }

  const activeElement = document.activeElement
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && (activeElement === first || !container.contains(activeElement))) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && (activeElement === last || !container.contains(activeElement))) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
