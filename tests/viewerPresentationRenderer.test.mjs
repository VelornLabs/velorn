import test from 'node:test'
import assert from 'node:assert/strict'
import { createViewerPresentation } from '../src/services/viewerPresentation.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const turn = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture({ desktop = true, request, nativeSet } = {}) {
  const doc = new EventTarget(), calls = [], changes = []
  let nativeListener = null, focusCount = 0
  doc.fullscreenElement = null
  doc.activeElement = { isConnected: true, focus() { focusCount++ } }
  const element = { requestFullscreen() {
    calls.push('html-enter')
    return Promise.resolve(request?.()).then(() => {
      doc.fullscreenElement = element; doc.dispatchEvent(new Event('fullscreenchange'))
    })
  } }
  doc.exitFullscreen = async () => {
    calls.push('html-exit'); doc.fullscreenElement = null; doc.dispatchEvent(new Event('fullscreenchange'))
  }
  const api = desktop ? { async setViewerPresentation({ enabled }) {
    calls.push(`native-${enabled}`)
    return nativeSet ? nativeSet(enabled) : { active: enabled, revision: calls.length }
  }, onViewerPresentationChanged(cb) { nativeListener = cb; return () => { nativeListener = null } } } : null
  const controller = createViewerPresentation({ getElement: () => element, documentTarget: doc, api,
    onChange: state => changes.push(state) })
  return { doc, element, calls, changes, controller, emit: state => nativeListener?.(state), focusCount: () => focusCount }
}

test('desktop entry is HTML first, then native; exit restores both and focus', async () => {
  const h = fixture()
  await h.controller.enter()
  assert.deepEqual(h.calls, ['html-enter', 'native-true'])
  assert.deepEqual(h.changes.at(-1), { active: true, pending: false, error: null })
  await h.controller.exit()
  assert.deepEqual(h.calls, ['html-enter', 'native-true', 'html-exit', 'native-false'])
  assert.equal(h.focusCount(), 1)
  assert.deepEqual(h.changes.at(-1), { active: false, pending: false, error: null })
  await h.controller.dispose()
})
test('browser fallback keeps HTML fullscreen without desktop calls', async () => {
  const h = fixture({ desktop: false })
  await h.controller.enter(); await h.controller.exit()
  assert.deepEqual(h.calls, ['html-enter', 'html-exit'])
  await h.controller.dispose()
})
test('unmount during deferred HTML entry never enters native presentation', async () => {
  const gate = deferred(), h = fixture({ request: () => gate.promise })
  const entering = h.controller.enter(), disposed = h.controller.dispose()
  gate.resolve(); await entering; await disposed
  assert.deepEqual(h.calls, ['html-enter', 'html-exit'])
  assert.equal(h.doc.fullscreenElement, null)
})
test('exit during native entry waits for ACK then restores; repeated entry is ignored', async () => {
  const gate = deferred(), h = fixture({ nativeSet: enabled => enabled ? gate.promise : { active: false } })
  const entering = h.controller.enter()
  await turn()
  const exiting = h.controller.exit()
  await h.controller.enter()
  assert.deepEqual(h.calls, ['html-enter', 'native-true'])
  gate.resolve({ active: true }); await entering; await exiting
  assert.deepEqual(h.calls, ['html-enter', 'native-true', 'html-exit', 'native-false'])
  assert.equal(h.changes.at(-1).active, false)
  await h.controller.dispose()
})
test('HTML rejection does not touch native window; native rejection rolls HTML back', async () => {
  for (const kind of ['html', 'native']) {
    const h = fixture({ request: kind === 'html' ? () => Promise.reject(new Error('HTML denied')) : undefined,
      nativeSet: kind === 'native' ? enabled => enabled ? Promise.reject(new Error('Native denied')) : { active: false } : undefined })
    await h.controller.enter()
    assert.equal(h.doc.fullscreenElement, null)
    assert.match(h.changes.at(-1).error, /denied/)
    if (kind === 'html') assert.deepEqual(h.calls, ['html-enter'])
    else assert.deepEqual(h.calls, ['html-enter', 'native-true', 'html-exit', 'native-false'])
    await h.controller.dispose()
  }
})
test('external HTML exit and native Escape both release presentation', async () => {
  for (const kind of ['html', 'native']) {
    const h = fixture(); await h.controller.enter()
    if (kind === 'html') await h.doc.exitFullscreen()
    else h.emit({ active: false, revision: 10 })
    await turn()
    assert.equal(h.doc.fullscreenElement, null)
    assert.equal(h.changes.at(-1).active, false)
    assert.equal(h.calls.filter(call => call === 'native-false').length, 1)
    await h.controller.dispose()
  }
})
test('stale native events do not exit a newer presentation', async () => {
  const h = fixture(); await h.controller.enter()
  h.emit({ active: true, revision: 20 }); h.emit({ active: false, revision: 19 })
  await turn(); assert.equal(h.doc.fullscreenElement, h.element)
  await h.controller.dispose()
})
test('native ACK revision also rejects an old exit event before any new event arrives', async () => {
  const h = fixture({ nativeSet: enabled => ({ active: enabled, revision: enabled ? 10 : 11 }) })
  await h.controller.enter()
  h.emit({ active: false, revision: 9 })
  await turn(); assert.equal(h.doc.fullscreenElement, h.element)
  await h.controller.dispose()
})
test('another fullscreen element is not claimed or exited', async () => {
  const h = fixture(), other = {}
  h.doc.fullscreenElement = other
  await h.controller.enter(); await h.controller.dispose()
  assert.equal(h.doc.fullscreenElement, other)
  assert.deepEqual(h.calls, [])
})
test('failed native restore remains retryable', async () => {
  let failures = 1
  const h = fixture({ nativeSet: enabled => {
    if (!enabled && failures-- > 0) throw new Error('Restore failed')
    return { active: enabled }
  } })
  await h.controller.enter(); await h.controller.exit()
  assert.match(h.changes.at(-1).error, /Restore failed/)
  await h.controller.exit()
  assert.equal(h.changes.at(-1).active, false)
  assert.equal(h.changes.at(-1).error, null)
  await h.controller.dispose()
})
