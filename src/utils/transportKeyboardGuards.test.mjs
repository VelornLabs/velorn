import test from 'node:test'
import assert from 'node:assert/strict'
import { isComposingKeyEvent, isNativeTransportActivation, isTransportKeyboardBlocked, isNativeTextKeyboardEvent } from './transportKeyboardGuards.mjs'
import { attachSourceTransportKeyboard } from './sourceTransportKeyboard.mjs'
import { attachPreviewPopoutKeyboard } from './previewPopoutKeyboard.mjs'

class Target {
  listeners = new Map()
  addEventListener(name, fn, capture) { const list = this.listeners.get(name) || []; list.push({ fn, capture }); this.listeners.set(name, list) }
  removeEventListener(name, fn, capture) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.fn !== fn || item.capture !== capture)) }
  dispatch(name, data = {}) {
    const event = { key: '', target: this, defaultPrevented: false, prevented: 0, stopped: 0,
      preventDefault() { this.defaultPrevented = true; this.prevented++ }, stopPropagation() { this.stopped++ }, ...data }
    for (const { fn } of this.listeners.get(name) || []) fn(event)
    return event
  }
}
const element = (tagName, attrs = {}, parentElement = null) => ({ tagName, parentElement, getAttribute: name => attrs[name] ?? null,
  getClientRects: () => [{}], style: { display: 'block', visibility: 'visible' } })

test('Agent text surfaces own keys through target, active focus and composed path', () => {
  const panel = element('ASIDE', { 'data-editor-keyboard-scope': 'text' }), child = element('SPAN', {}, panel), body = element('BODY')
  const documentTarget = { activeElement: body }
  for (const event of [{ target: child }, { target: body, composedPath: () => [child] }]) {
    assert.equal(isNativeTextKeyboardEvent(event, { documentTarget }), true)
    assert.equal(isTransportKeyboardBlocked(event, { documentTarget }), true)
  }
  documentTarget.activeElement = child
  assert.equal(isNativeTextKeyboardEvent({ target: body, key: 'v', ctrlKey: true }, { documentTarget }), true)
  documentTarget.activeElement = body
  assert.equal(isNativeTextKeyboardEvent({ target: body, key: 'v', ctrlKey: true }, { documentTarget }), false)
})

test('real text selection reserves Copy/Cut before clip/custom shortcuts when key target remains elsewhere', () => {
  const selection = { isCollapsed: false, toString: () => 'Agent reply 日本語' }, documentTarget = { getSelection: () => selection }
  for (const event of [{ key: 'c', ctrlKey: true }, { key: 'C', metaKey: true }, { key: 'x', ctrlKey: true },
    { key: 'Insert', ctrlKey: true }, { key: 'Delete', shiftKey: true }]) {
    assert.equal(isNativeTextKeyboardEvent(event, { documentTarget }), true)
    assert.equal(isTransportKeyboardBlocked(event, { documentTarget }), true)
  }
  for (const event of [{ key: 'c' }, { key: 'v', ctrlKey: true }, { key: 'c', ctrlKey: true, altKey: true }, { key: ' ' }]) {
    assert.equal(isNativeTextKeyboardEvent(event, { documentTarget }), false)
  }
  selection.isCollapsed = true
  assert.equal(isNativeTextKeyboardEvent({ key: 'c', ctrlKey: true }, { documentTarget }), false)
})
function fixture() {
  const win = new Target(), doc = new Target(), actions = [], body = element('BODY')
  doc.activeElement = body; doc.hidden = false; doc.modals = []; doc.querySelectorAll = () => doc.modals
  win.getComputedStyle = node => node.style
  let enabled = true
  const stop = attachSourceTransportKeyboard({ windowTarget: win, documentTarget: doc, canHandle: () => enabled, onAction: action => actions.push(action) })
  const key = (type, key, extra = {}) => win.dispatch(type, { key, code: key === ' ' ? 'Space' : '', target: doc.activeElement, ...extra })
  return { win, doc, body, actions, stop, key, setEnabled: value => { enabled = value } }
}

test('all native form types, role ancestors and composed-path editors retain keyboard ownership', () => {
  const f = fixture(), options = { documentTarget: f.doc, windowTarget: f.win }
  for (const tag of ['INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']) {
    f.doc.activeElement = element(tag)
    assert.equal(isTransportKeyboardBlocked({ target: f.body }, options), true)
  }
  f.doc.activeElement = f.body
  for (const attrs of [{ role: 'slider' }, { role: 'separator' }, { contenteditable: '' }]) {
    assert.equal(isTransportKeyboardBlocked({ target: element('SPAN', {}, element('DIV', attrs)) }, options), true)
  }
  assert.equal(isTransportKeyboardBlocked({ target: f.body, composedPath: () => [element('INPUT')] }, options), true)
  assert.equal(isTransportKeyboardBlocked({ target: element('BUTTON') }, options), false)
  f.stop()
})

test('IME, handled, hidden and visible-modal events block transport without confusing hidden dialogs', () => {
  const f = fixture(), options = { documentTarget: f.doc, windowTarget: f.win }
  for (const event of [{ isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { defaultPrevented: true }]) {
    assert.equal(isTransportKeyboardBlocked(event, options), true)
  }
  assert.equal(isComposingKeyEvent({ key: 'Enter', nativeEvent: { isComposing: true } }), true)
  f.doc.hidden = true; assert.equal(isTransportKeyboardBlocked({}, options), true); f.doc.hidden = false
  f.doc.modals = [element('DIV')]; assert.equal(isTransportKeyboardBlocked({}, options), true)
  f.doc.modals[0].style.visibility = 'hidden'; assert.equal(isTransportKeyboardBlocked({}, options), false)
  f.stop()
})

test('native Enter activation includes nested buttons and links but not plain workspace surfaces', () => {
  for (const node of [element('BUTTON'), element('A'), element('SPAN', {}, element('DIV', { role: 'button' }))]) {
    assert.equal(isNativeTransportActivation({ target: node }, {}), true)
  }
  assert.equal(isNativeTransportActivation({ target: element('DIV') }, {}), false)
})

test('Source Space consumes both phases and toggles once on release, not OS repeats', () => {
  const f = fixture()
  assert.equal(f.key('keydown', ' ').stopped, 0)
  assert.equal(f.key('keydown', ' ', { repeat: true }).defaultPrevented, true)
  assert.deepEqual(f.actions, [])
  const release = f.key('keyup', ' ')
  assert.equal(release.defaultPrevented, true)
  assert.equal(release.stopped, 0, 'passive preview pan tracking must receive the release')
  f.key('keyup', ' ')
  assert.deepEqual(f.actions, ['toggle'])
  f.key('keydown', ' ', { repeat: true }); f.key('keyup', ' ')
  assert.deepEqual(f.actions, ['toggle'])
  f.stop()
})

test('Source Enter uses bounded transport off buttons; mark/step grammar keeps its capture ownership', () => {
  const f = fixture()
  f.key('keydown', 'Enter'); f.key('keydown', 'Enter', { repeat: true })
  f.doc.activeElement = element('BUTTON'); assert.equal(f.key('keydown', 'Enter').stopped, 0)
  f.doc.activeElement = f.body
  for (const key of ['I', 'O', 'X', 'ArrowLeft', 'ArrowRight']) assert.equal(f.key('keydown', key).stopped, 1)
  f.key('keydown', 'Escape')
  f.key('keydown', 'ArrowRight', { repeat: true }); f.key('keydown', 'i', { repeat: true })
  assert.deepEqual(f.actions, ['toggle', 'in', 'out', 'clear', 'previous-frame', 'next-frame', 'exit', 'next-frame'])
  f.stop()
})

test('Source Space cancels on focus, mouse, pointer, blur, hidden, modifier use and unmount', () => {
  const f = fixture()
  for (const [target, event] of [[f.doc, 'focusin'], [f.doc, 'pointerdown'], [f.doc, 'mousedown'], [f.doc, 'visibilitychange'],
    [f.win, 'blur'], [f.win, 'comfystudio-space-modifier-used']]) {
    f.key('keydown', ' '); target.dispatch(event); f.key('keyup', ' ')
  }
  f.key('keydown', ' '); f.stop(); f.key('keyup', ' ')
  assert.deepEqual(f.actions, [])
  assert.equal([...f.win.listeners.values(), ...f.doc.listeners.values()].flat().length, 0)
})

test('Source rechecks forms/modal/session/composition at release and preserves modified shortcuts', () => {
  const f = fixture()
  f.key('keydown', ' '); f.doc.activeElement = element('SELECT'); f.key('keyup', ' ')
  f.doc.activeElement = f.body
  f.key('keydown', ' '); f.doc.modals = [element('DIV')]; f.key('keyup', ' '); f.doc.modals = []
  f.key('keydown', ' '); f.setEnabled(false); f.key('keyup', ' '); f.setEnabled(true)
  f.key('keydown', ' '); f.key('keyup', ' ', { isComposing: true })
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(f.key('keydown', 'i', { [modifier]: true }).defaultPrevented, false)
  }
  f.key('keydown', 'i', { isComposing: true }); f.key('keydown', 'o', { defaultPrevented: true })
  assert.deepEqual(f.actions, [])
  f.stop()
})

test('popout Space is release-only and F never repeats fullscreen toggles', () => {
  const f = fixture(); f.stop()
  const stop = attachPreviewPopoutKeyboard({ windowTarget: f.win, documentTarget: f.doc,
    onTogglePlay: () => f.actions.push('play'), onToggleFullscreen: () => f.actions.push('fullscreen') })
  const key = (type, name, extra = {}) => f.doc.dispatch(type, { key: name, target: f.body, ...extra })
  key('keydown', ' '); key('keydown', ' ', { repeat: true }); assert.deepEqual(f.actions, [])
  key('keyup', ' '); key('keyup', ' ')
  key('keydown', 'f'); key('keydown', 'f', { repeat: true })
  assert.deepEqual(f.actions, ['play', 'fullscreen'])
  stop()
})

test('popout guards, lost focus/visibility and cleanup retire pending Space without stale ownership', () => {
  const f = fixture(); f.stop()
  let enabled = true
  const stop = attachPreviewPopoutKeyboard({ windowTarget: f.win, documentTarget: f.doc,
    canHandle: () => enabled, onTogglePlay: () => f.actions.push('play') })
  const key = (type, extra = {}) => f.doc.dispatch(type, { key: ' ', target: f.body, ...extra })
  for (const [target, event] of [[f.win, 'blur'], [f.doc, 'focusin'], [f.doc, 'visibilitychange'], [f.doc, 'pointerdown']]) {
    key('keydown'); target.dispatch(event); key('keyup')
  }
  key('keydown'); enabled = false; key('keyup'); enabled = true
  key('keydown'); key('keyup', { isComposing: true })
  key('keydown', { ctrlKey: true }); key('keyup')
  key('keydown'); stop(); key('keyup')
  assert.deepEqual(f.actions, [])
  assert.equal([...f.doc.listeners.values(), ...f.win.listeners.values()].flat().length, 0)
})
