import assert from 'node:assert/strict'
import test from 'node:test'

import { trapDialogFocus } from './dialogFocus.mjs'

function makeElement(name, { tagName = 'BUTTON', parentElement = null, open = false } = {}) {
  const element = {
    name,
    tagName,
    parentElement,
    open,
    children: [],
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {
      globalThis.document.activeElement = this
    },
  }
  parentElement?.children.push(element)
  return element
}

function makeDialog(elements) {
  return {
    querySelectorAll: () => elements,
    contains: (element) => elements.includes(element),
    focus() {
      globalThis.document.activeElement = this
    },
  }
}

function makeTabEvent({ shiftKey = false } = {}) {
  return {
    key: 'Tab',
    shiftKey,
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
}

test.afterEach(() => {
  delete globalThis.document
})

test('wraps forward Tab from the last control to the first', () => {
  const first = makeElement('first')
  const last = makeElement('last')
  const dialog = makeDialog([first, last])
  globalThis.document = { activeElement: last }
  const event = makeTabEvent()

  assert.equal(trapDialogFocus(event, dialog), true)
  assert.equal(event.prevented, true)
  assert.equal(globalThis.document.activeElement, first)
})

test('wraps Shift+Tab from the first control to the last', () => {
  const first = makeElement('first')
  const last = makeElement('last')
  const dialog = makeDialog([first, last])
  globalThis.document = { activeElement: first }
  const event = makeTabEvent({ shiftKey: true })

  assert.equal(trapDialogFocus(event, dialog), true)
  assert.equal(globalThis.document.activeElement, last)
})

test('keeps focus on a dialog that has no focusable controls', () => {
  const dialog = makeDialog([])
  globalThis.document = { activeElement: null }
  const event = makeTabEvent()

  assert.equal(trapDialogFocus(event, dialog), true)
  assert.equal(globalThis.document.activeElement, dialog)
})

test('wraps from the final summary while closed detail fields report layout rectangles', () => {
  const first = makeElement('first')
  const details = makeElement('details', { tagName: 'DETAILS' })
  const summary = makeElement('summary', { tagName: 'SUMMARY', parentElement: details })
  const hiddenInput = makeElement('hidden input', { tagName: 'INPUT', parentElement: details })
  const dialog = makeDialog([first, summary, hiddenInput])
  globalThis.document = { activeElement: summary }

  assert.equal(hiddenInput.getClientRects().length, 1)
  assert.equal(trapDialogFocus(makeTabEvent(), dialog), true)
  assert.equal(globalThis.document.activeElement, first)
  assert.equal(trapDialogFocus(makeTabEvent({ shiftKey: true }), dialog), true)
  assert.equal(globalThis.document.activeElement, summary)
})

test('retains child controls of the first summary but excludes subsequent summaries', () => {
  const first = makeElement('first')
  const details = makeElement('details', { tagName: 'DETAILS' })
  makeElement('content before summary', { tagName: 'DIV', parentElement: details })
  const summary = makeElement('summary', { tagName: 'SUMMARY', parentElement: details })
  const summaryText = makeElement('summary text', { tagName: 'SPAN', parentElement: summary })
  const summaryButton = makeElement('summary button', { parentElement: summaryText })
  const hiddenSummary = makeElement('second summary', { tagName: 'SUMMARY', parentElement: details })
  const hiddenButton = makeElement('second summary button', { parentElement: hiddenSummary })
  const dialog = makeDialog([first, summary, summaryButton, hiddenSummary, hiddenButton])
  globalThis.document = { activeElement: first }

  assert.equal(trapDialogFocus(makeTabEvent({ shiftKey: true }), dialog), true)
  assert.equal(globalThis.document.activeElement, summaryButton)
  assert.equal(trapDialogFocus(makeTabEvent(), dialog), true)
  assert.equal(globalThis.document.activeElement, first)
})

test('open details expose fields and closing them updates the trap immediately', () => {
  const first = makeElement('first')
  const details = makeElement('details', { tagName: 'DETAILS', open: true })
  const summary = makeElement('summary', { tagName: 'SUMMARY', parentElement: details })
  const input = makeElement('input', { tagName: 'INPUT', parentElement: details })
  const dialog = makeDialog([first, summary, input])
  globalThis.document = { activeElement: first }

  assert.equal(trapDialogFocus(makeTabEvent({ shiftKey: true }), dialog), true)
  assert.equal(globalThis.document.activeElement, input)
  details.open = false
  globalThis.document.activeElement = first
  assert.equal(trapDialogFocus(makeTabEvent({ shiftKey: true }), dialog), true)
  assert.equal(globalThis.document.activeElement, summary)
})

test('nested open details inside a closed ancestor remain hidden', () => {
  const first = makeElement('first')
  const outer = makeElement('outer details', { tagName: 'DETAILS' })
  const outerSummary = makeElement('outer summary', { tagName: 'SUMMARY', parentElement: outer })
  const body = makeElement('outer body', { tagName: 'DIV', parentElement: outer })
  const inner = makeElement('inner details', { tagName: 'DETAILS', parentElement: body, open: true })
  const innerSummary = makeElement('inner summary', { tagName: 'SUMMARY', parentElement: inner })
  const hidden = makeElement('hidden inner control', { parentElement: inner })
  const dialog = makeDialog([first, outerSummary, innerSummary, hidden])
  globalThis.document = { activeElement: first }

  assert.equal(trapDialogFocus(makeTabEvent({ shiftKey: true }), dialog), true)
  assert.equal(globalThis.document.activeElement, outerSummary)
})

test('closed details without a summary expose no descendant controls', () => {
  const details = makeElement('details', { tagName: 'DETAILS' })
  const hidden = makeElement('hidden', { parentElement: details })
  const dialog = makeDialog([hidden])
  globalThis.document = { activeElement: null }

  assert.equal(trapDialogFocus(makeTabEvent(), dialog), true)
  assert.equal(globalThis.document.activeElement, dialog)
})

test('ordinary middle controls and non-Tab keys keep normal focus behavior', () => {
  const first = makeElement('first')
  const middle = makeElement('middle')
  const last = makeElement('last')
  const dialog = makeDialog([first, middle, last])
  globalThis.document = { activeElement: middle }
  const event = makeTabEvent()

  assert.equal(trapDialogFocus(event, dialog), false)
  assert.equal(event.prevented, false)
  event.key = 'Escape'
  assert.equal(trapDialogFocus(event, dialog), false)
  assert.equal(globalThis.document.activeElement, middle)
})
