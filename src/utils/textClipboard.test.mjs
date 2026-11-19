import test from 'node:test'
import assert from 'node:assert/strict'
import { copyTextToClipboard, selectedTextWithin } from './textClipboard.mjs'

test('explicit Copy prefers the native write-only bridge and reports rejection rather than false success', async () => {
  const calls = []
  const navigatorTarget = { clipboard: { writeText: () => { throw new Error('Browser should not run') } } }
  await copyTextToClipboard('**reply**\n日本語 🦋', { api: { writeClipboardText: async text => { calls.push(text); return { success: true } } }, navigatorTarget })
  assert.deepEqual(calls, ['**reply**\n日本語 🦋'])
  await assert.rejects(copyTextToClipboard('text', { api: { writeClipboardText: async () => ({ success: false }) }, navigatorTarget }), /could not/)
  await assert.rejects(copyTextToClipboard('text', { api: { writeClipboardText: async () => { throw new Error('denied') } }, navigatorTarget }), /denied/)
  await assert.rejects(copyTextToClipboard('', {}), /no text/)
})

test('old preload/browser Copy supports clipboard.writeText without clipboard reads', async () => {
  const calls = []
  await copyTextToClipboard('text', { api: {}, navigatorTarget: { clipboard: { writeText: async text => calls.push(text) } } })
  assert.deepEqual(calls, ['text'])
  await assert.rejects(copyTextToClipboard('text', { api: {}, navigatorTarget: {}, documentTarget: {} }), /unavailable/)
})

test('legacy Copy fallback restores input focus and browser selection on success and failure', async () => {
  for (const success of [true, false]) {
    const calls = [], savedRange = {}, selection = { rangeCount: 1,
      getRangeAt: () => ({ cloneRange: () => savedRange }), removeAllRanges: () => calls.push('clear'), addRange: range => calls.push(range) }
    const field = { style: {}, setAttribute: () => {}, select: () => calls.push('select'), remove: () => calls.push('remove') }
    const activeElement = { selectionStart: 2, selectionEnd: 6, selectionDirection: 'backward',
      focus: options => calls.push(options), setSelectionRange: (...args) => calls.push(args) }
    const documentTarget = { activeElement, getSelection: () => selection, createElement: () => field,
      body: { appendChild: value => assert.equal(value, field) }, execCommand: command => { calls.push(command); return success } }
    const promise = copyTextToClipboard('copied exactly', { api: {}, navigatorTarget: {}, documentTarget })
    if (success) await promise
    else await assert.rejects(promise, /Copy failed/)
    assert.equal(field.value, 'copied exactly')
    assert.deepEqual(calls, ['select', 'copy', 'remove', { preventScroll: true }, [2, 6, 'backward'], 'clear', savedRange])
  }
})

test('context menu only accepts a non-collapsed selection wholly inside its own panel', () => {
  const a = {}, b = {}, outside = {}
  const selection = { anchorNode: a, focusNode: b, isCollapsed: false, toString: () => 'selected\ntext' }
  const panel = { contains: node => [a, b].includes(node) }, doc = { getSelection: () => selection }
  assert.equal(selectedTextWithin(panel, doc), 'selected\ntext')
  selection.focusNode = outside; assert.equal(selectedTextWithin(panel, doc), '')
  selection.focusNode = b; selection.isCollapsed = true; assert.equal(selectedTextWithin(panel, doc), '')
})
