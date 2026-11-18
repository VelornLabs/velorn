import test from 'node:test'
import assert from 'node:assert/strict'
import { attachViewerPresentationKeyboard } from '../src/utils/viewerPresentationKeyboard.mjs'

class FakeTarget {
  constructor() { this.listeners = new Map() }
  addEventListener(name, handler, capture = false) {
    const entries = this.listeners.get(name) || []
    entries.push({ handler, capture })
    this.listeners.set(name, entries)
  }
  removeEventListener(name, handler, capture = false) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(entry => entry.handler !== handler || entry.capture !== capture))
  }
  dispatch(name, properties = {}) {
    const event = { key: '', target: this, defaultPrevented: false, stopped: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true },
      stopImmediatePropagation() { this.immediateStopped = this.stopped = true },
      ...properties, type: name }
    // Window capture precedes pre-existing window bubble listeners.
    const entries = [...(this.listeners.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))
    for (const { handler } of entries) {
      handler(event)
      if (event.immediateStopped) break
    }
    return event
  }
  count() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.length, 0) }
}

function element(tagName = 'DIV', attributes = {}, parentElement = null) {
  return { tagName, parentElement, getAttribute: name => attributes[name] ?? null }
}

function fixture() {
  const win = new FakeTarget(), doc = new FakeTarget(), actions = [], leaked = []
  let active = true
  doc.activeElement = element('BODY')
  doc.visibilityState = 'visible'
  // Simulate editor listeners which predate the viewer, ignore defaultPrevented
  // and can map *any* key (including JKL/navigation) to an authoring action.
  for (const name of ['keydown', 'keyup']) win.addEventListener(name, event => leaked.push([name, event.key]))
  const cleanup = attachViewerPresentationKeyboard({ windowTarget: win, documentTarget: doc,
    canHandle: () => active,
    onExit: () => actions.push('exit'), onTogglePlay: () => actions.push('toggle'),
    onFrameStep: direction => actions.push(['frame', direction]),
    onShuttle: action => actions.push(action), onStart: () => actions.push('start'), onEnd: () => actions.push('end') })
  const key = (name, properties = {}, type = 'keydown') => win.dispatch(type, {
    key: name, code: name === ' ' ? 'Space' : '', target: doc.activeElement, ...properties })
  return { win, doc, actions, leaked, cleanup, key, setActive: value => { active = value } }
}

test('capture ownership blocks hidden authoring and custom-remapped transport on both phases', () => {
  const f = fixture()
  for (const key of ['Delete', 'Backspace', 'i', 'o', 's', 'j', 'ArrowRight', 'Escape']) {
    assert.equal(f.key(key).immediateStopped, true)
    assert.equal(f.key(key, {}, 'keyup').immediateStopped, true)
  }
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(f.key('z', { [modifier]: true }).defaultPrevented, false)
    assert.equal(f.key('z', { [modifier]: true }, 'keyup').immediateStopped, true)
  }
  assert.deepEqual(f.leaked, [])
  assert.deepEqual(f.actions, [{ type: 'fast', direction: 'reverse' }, ['frame', 1], 'exit'])
  f.cleanup()
})

test('Escape exits once even in a form; composition and OS-modified Escape retain native defaults', () => {
  const f = fixture()
  f.doc.activeElement = element('INPUT')
  assert.equal(f.key('Escape').defaultPrevented, true)
  f.key('Escape', { repeat: true })
  f.key('Escape', {}, 'keyup')
  assert.deepEqual(f.actions, ['exit'])
  for (const props of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { defaultPrevented: true }]) {
    const event = f.key('Escape', props)
    assert.equal(event.immediateStopped, true)
    assert.equal(event.defaultPrevented, !!props.defaultPrevented)
  }
  assert.deepEqual(f.actions, ['exit'])
  f.cleanup()
})

test('Space toggles only on matching release and Enter toggles only once per press', () => {
  const f = fixture()
  f.key(' ')
  f.key(' ', { repeat: true })
  assert.deepEqual(f.actions, [])
  assert.equal(f.key(' ', {}, 'keyup').defaultPrevented, true)
  f.key(' ', {}, 'keyup')
  f.key('Enter')
  f.key('Enter', { repeat: true })
  f.key('Enter', {}, 'keyup')
  assert.deepEqual(f.actions, ['toggle', 'toggle'])
  for (const key of ['Space', 'Spacebar']) { f.key(key); f.key(key, {}, 'keyup') }
  assert.deepEqual(f.actions, ['toggle', 'toggle', 'toggle', 'toggle'])
  f.key(' ', { shiftKey: true })
  f.key(' ', { shiftKey: true }, 'keyup')
  assert.equal(f.actions.length, 4)
  f.cleanup()
})

test('native Tab, form editing, slider arrows, button Enter and OS text shortcuts are not prevented', () => {
  const f = fixture()
  for (const node of [element('INPUT'), element('TEXTAREA'), element('SELECT'),
    element('INPUT', { type: 'range' }), element('DIV', { role: 'slider' }),
    element('SPAN', {}, element('DIV', { contenteditable: 'true' }))]) {
    f.doc.activeElement = node
    for (const key of ['j', ' ', 'Enter', 'ArrowLeft', 'Home', 'Delete', 'Tab']) {
      assert.equal(f.key(key).defaultPrevented, false)
      assert.equal(f.key(key, {}, 'keyup').defaultPrevented, false)
    }
    for (const modifier of ['ctrlKey', 'metaKey']) {
      assert.equal(f.key('c', { [modifier]: true }).defaultPrevented, false)
      assert.equal(f.key('z', { [modifier]: true }).defaultPrevented, false)
    }
  }
  for (const node of [element('BUTTON'), element('A', { href: '#' }), element('DIV', { role: 'button' }),
    element('SPAN', {}, element('BUTTON'))]) {
    f.doc.activeElement = node
    assert.equal(f.key('Enter').defaultPrevented, false)
    assert.equal(f.key('Tab').defaultPrevented, false)
  }
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.leaked, [])
  // Space intentionally belongs to viewer playback, not a focused button.
  assert.equal(f.key(' ').defaultPrevented, true)
  f.key(' ', {}, 'keyup')
  assert.deepEqual(f.actions, ['toggle'])
  f.cleanup()
})

test('shadow/composed form focus preserves editing even when activeElement is a host', () => {
  const f = fixture()
  const input = element('INPUT')
  assert.equal(f.key('j', { composedPath: () => [input, f.doc.activeElement] }).defaultPrevented, false)
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.leaked, [])
  f.cleanup()
})

test('frame arrows repeat, endpoints do not, and JKL keep the existing slow/held-K semantics', () => {
  const f = fixture()
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    f.key(key)
    f.key(key, { repeat: true })
  }
  f.key('j'); f.key('L', { shiftKey: true }); f.key('k'); f.key('Shift', { shiftKey: true })
  f.key('J', { shiftKey: true }); f.key('l'); f.key('l', { repeat: true })
  f.key('k', {}, 'keyup'); f.key('l')
  assert.deepEqual(f.actions, [
    ['frame', -1], ['frame', -1], ['frame', 1], ['frame', 1], 'start', 'end',
    { type: 'fast', direction: 'reverse' }, { type: 'step-slow', direction: 'forward' },
    { type: 'pause' }, { type: 'hold-slow', direction: 'reverse' },
    { type: 'hold-slow', direction: 'forward' }, { type: 'fast', direction: 'forward' },
  ])
  assert.deepEqual(f.leaked, [])
  f.cleanup()
})

test('focus, pointer, blur, visibility, modifier-pan and inactive sessions retire Space and K', () => {
  for (const trigger of [
    f => f.win.dispatch('blur'), f => f.doc.dispatch('visibilitychange'),
    f => f.doc.dispatch('focusin'), f => f.doc.dispatch('pointerdown'), f => f.doc.dispatch('mousedown'),
    f => f.win.dispatch('comfystudio-space-modifier-used'),
    f => f.key('Control', { ctrlKey: true }),
    f => { f.setActive(false); f.key('x'); f.setActive(true) },
  ]) {
    const f = fixture()
    f.key('k'); f.key(' '); trigger(f); f.key(' ', {}, 'keyup'); f.key('l')
    assert.deepEqual(f.actions, [{ type: 'pause' }, { type: 'fast', direction: 'forward' }])
    f.cleanup()
  }
})

test('unrelated keys cancel pending Space and hidden or composing events never run transport', () => {
  const f = fixture()
  f.key(' '); f.key('Tab'); f.key(' ', {}, 'keyup')
  f.key(' '); f.key('x'); f.key(' ', {}, 'keyup')
  for (const props of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { altKey: true }]) {
    f.key('j', props)
  }
  f.doc.hidden = true
  f.key('Enter')
  assert.deepEqual(f.actions, [])
  assert.deepEqual(f.leaked, [])
  f.cleanup()
})

test('inactive presentation leaves editor keys untouched; cleanup is complete and idempotent', () => {
  const f = fixture()
  f.setActive(false)
  assert.equal(f.key('Delete').immediateStopped, false)
  assert.deepEqual(f.leaked, [['keydown', 'Delete']])
  f.cleanup(); f.cleanup()
  assert.equal(f.win.count(), 2)
  assert.equal(f.doc.count(), 0)
  assert.doesNotThrow(() => attachViewerPresentationKeyboard({ windowTarget: null })())
})
