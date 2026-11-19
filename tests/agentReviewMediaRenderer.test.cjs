const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const source = fs.readFileSync(require.resolve('../src/components/AgentReviewGallery.jsx'), 'utf8')
const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code
const frame = (id = 'one', extra = {}) => ({ id: `review-${id}`, chatId: 'chat-one', turnId: 'turn-one',
  dataUrl: 'data:image/jpeg;base64,/9j/2Q==', label: 'Timeline frame', capturedAt: 1700000000000,
  timeSeconds: 3, timelineId: 'timeline-one', ...extra })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// Exercise hook state/effect boundaries without a real project or model call.
function fixture({ api = {}, options: initial = {} } = {}) {
  let index = 0, effects = [], rerender = false, result, listener
  const slots = [], calls = []
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initial) { const i = index++; slots[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => {
      const next = typeof value === 'function' ? value(slots[i].value) : value
      if (!Object.is(next, slots[i].value)) { slots[i].value = next; rerender = true }
    }] },
    useRef(initial) { const i = index++; slots[i] ||= { current: initial }; return slots[i] },
    useCallback(fn, deps) { const i = index++; if (!equal(slots[i]?.deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value },
    useEffect(fn, deps) { const i = index++; if (!equal(slots[i]?.deps, deps)) { const old = slots[i]; slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn() }) } },
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
  }
  const native = api === null ? undefined : {
    listFrames: async payload => { calls.push(['list', payload]); return api.listFrames ? api.listFrames(payload) : { success: true, frames: [] } },
    saveFrame: async payload => { calls.push(['save', payload]); return api.saveFrame ? api.saveFrame(payload) : { success: true } },
    onChanged(fn) { listener = fn; return () => { if (listener === fn) listener = null } },
  }
  const options = { projectKey: 'project-one', projectPath: '/synthetic/project-one', chatId: 'chat-one', turnIds: ['turn-one'], isProjectCurrent: () => true, ...initial }
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, React: react, window: { electronAPI: { agentReviewMedia: native } },
    require(name) { if (name === 'react') return react; throw Error(name) } })
  function render() { index = 0; rerender = false; result = module.exports.useAgentReviewMedia(options); const next = effects; effects = []; next.forEach(fn => fn()) }
  async function flush() { for (let i = 0; i < 16; i++) { await Promise.resolve(); if (rerender) render() } }
  render()
  return { calls, options, render, flush, get result() { return result }, emit(event) { listener?.(event) },
    gallery(props) { index = 1000; return module.exports.AgentReviewGallery(props) },
    recovered(props) { return module.exports.AgentRecoveredReviewGallery(props) },
    unmount() { for (const slot of slots) slot?.cleanup?.() } }
}

test('restores only known conversation turns, including unavailable placeholders, without localStorage', async () => {
  const f = fixture({ api: { listFrames: async () => ({ success: true, frames: [frame(), frame('missing', { unavailable: true, dataUrl: undefined }),
    frame('other-chat', { chatId: 'another-chat' }), frame('other-turn', { turnId: 'another-turn' }), frame('bad-url', { dataUrl: 'file:///secret' })] }) } })
  await f.flush()
  assert.deepEqual(Array.from(f.result.frames, item => item.id), ['review-one', 'review-missing'])
  assert.equal(f.result.frames[0].persisted, true)
  assert.equal(f.result.frames[1].unavailable, true)
  assert.equal(f.result.frames[1].dataUrl, undefined)
  assert.equal(f.calls[0][1].projectPath, '/synthetic/project-one')
  assert.equal(f.result.warning, '')
  f.unmount()
})

test('saves capture with original turn and project independently of phone or model image sharing', async () => {
  let saved
  const f = fixture({ api: { saveFrame: async payload => { saved = payload; return { success: true } } } })
  await f.flush()
  await f.result.saveFrame(frame(), { chatId: 'chat-one', turnId: 'turn-one' }); await f.flush()
  assert.equal(saved.projectPath, '/synthetic/project-one')
  assert.equal(saved.chatId, 'chat-one'); assert.equal(saved.turnId, 'turn-one')
  assert.equal(saved.frame.dataUrl, frame().dataUrl)
  assert.equal(f.result.frames[0].persisted, true)
  f.unmount()
  const reopened = fixture({ api: { listFrames: async () => ({ success: true, frames: [{ ...saved.frame, chatId: saved.chatId, turnId: saved.turnId }] }) } })
  await reopened.flush(); assert.equal(reopened.result.frames[0].id, 'review-one'); reopened.unmount()
})

test('a stale load cannot erase a capture that was saved while the load was in flight', async () => {
  const read = deferred()
  const f = fixture({ api: { listFrames: () => read.promise } })
  await f.result.saveFrame(frame(), { chatId: 'chat-one', turnId: 'turn-one' }); await f.flush()
  read.resolve({ success: true, frames: [] }); await f.flush()
  assert.equal(f.result.frames.length, 1)
  assert.equal(f.result.frames[0].persisted, true)
  f.unmount()
})

test('a native change while a save is pending cannot replace the new capture with older data', async () => {
  const write = deferred()
  const f = fixture({ api: { saveFrame: () => write.promise, listFrames: async () => ({ success: true, frames: [frame('one', { label: 'Old still' })] }) } })
  await f.flush()
  const save = f.result.saveFrame(frame('one', { label: 'New still' }), { chatId: 'chat-one', turnId: 'turn-one' })
  f.emit({ chatId: 'chat-one' }); await f.flush()
  assert.equal(f.result.frames[0].label, 'New still')
  write.resolve({ success: true }); await save; await f.flush()
  assert.equal(f.result.frames[0].persisted, true)
  f.unmount()
})

test('stale project and conversation responses cannot attach media to a new scope', async () => {
  const old = deferred()
  const f = fixture({ api: { listFrames: payload => payload.chatId === 'chat-one' ? old.promise : Promise.resolve({ success: true, frames: [] }) } })
  f.options.chatId = 'chat-two'; f.options.turnIds = ['turn-two']; f.render(); await f.flush()
  old.resolve({ success: true, frames: [frame()] }); await f.flush()
  assert.equal(f.result.frames.length, 0)
  f.options.projectKey = 'project-two'; f.options.projectPath = '/synthetic/project-two'; f.render(); await f.flush()
  assert.equal(f.result.frames.length, 0)
  f.options.isProjectCurrent = () => false; f.render()
  await f.result.saveFrame(frame(), { chatId: 'chat-one', turnId: 'turn-one' })
  assert.equal(f.calls.some(([kind]) => kind === 'save'), false)
  f.unmount()
})

test('save failure retains a session preview and warning even after a native reload', async () => {
  const f = fixture({ api: { saveFrame: async () => ({ success: false, error: 'Disk full' }) } })
  await f.flush(); await f.result.saveFrame(frame(), { chatId: 'chat-one', turnId: 'turn-one' }); await f.flush()
  f.emit({ chatId: 'chat-one' }); await f.flush()
  assert.equal(f.result.frames.length, 1); assert.equal(f.result.frames[0].persisted, false)
  assert.match(f.result.warning, /could not be saved/)
  f.unmount()
})

test('old preload supports session previews with an explicit restart warning', async () => {
  const f = fixture({ api: null }); await f.flush()
  await f.result.saveFrame(frame(), { chatId: 'chat-one', turnId: 'turn-one' }); await f.flush()
  assert.equal(f.result.frames.length, 1); assert.equal(f.result.frames[0].persisted, false)
  assert.match(f.result.warning, /session only/)
  f.unmount()
})

test('load errors and export persistence errors are visible without changing saved media', async () => {
  const f = fixture({ api: { listFrames: async () => ({ success: false }) } }); await f.flush()
  assert.match(f.result.warning, /could not be restored/)
  f.emit({ error: 'Could not save review history. Check project storage.', chatId: 'chat-one' }); await f.flush()
  assert.match(f.result.warning, /Could not save review history/)
  f.unmount()
})

test('restored history is not limited to the former latest twelve stills', async () => {
  const f = fixture({ api: { listFrames: async () => ({ success: true, frames: Array.from({ length: 30 }, (_, i) => frame(String(i))) }) } })
  await f.flush(); assert.equal(f.result.frames.length, 30); f.unmount()
})

test('unavailable gallery item has neither an image nor an editor/enlarge button', () => {
  const f = fixture()
  const tree = f.gallery({ frames: [frame('missing', { unavailable: true, dataUrl: undefined })], onShow() { throw Error('Must not navigate') } })
  const nodes = []; const walk = value => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') { nodes.push(value); walk(value.children) } }
  walk(tree)
  assert.equal(nodes.some(node => node.type === 'img'), false)
  assert.equal(nodes.some(node => node.type === 'button' && String(node.props['aria-label']).startsWith('Enlarge')), false)
  assert.equal(nodes.some(node => node.type === 'button' && node.children.includes('Show in editor')), false)
  assert.ok(nodes.some(node => node.type === 'p' && node.children.some(text => typeof text === 'string' && text.includes('File unavailable'))))
  f.unmount()
})

test('an unfinished saved user turn recovers only its own stills without inventing an assistant reply', () => {
  const f = fixture(), message = { role: 'user', turnId: 'turn-one', text: 'Inspect this shot' }
  const props = { message, messages: [message], frames: [frame(), frame('other-chat', { chatId: 'another-chat' }),
    frame('other-turn', { turnId: 'another-turn' })], chatId: 'chat-one', busy: false, onShow() {} }
  const recovered = f.recovered(props)
  assert.equal(recovered.props['aria-label'], 'Recovered review media')
  assert.equal(recovered.children[0].children[0], 'Recovered review media · previous request did not finish')
  assert.deepEqual(Array.from(recovered.children[1].props.frames, item => item.id), ['review-one'])
  assert.equal(f.recovered({ ...props, busy: true }), null)
  assert.equal(f.recovered({ ...props, frames: [] }), null)
  assert.equal(f.recovered({ ...props, messages: [...props.messages, { role: 'assistant', turnId: 'turn-one', text: 'Done' }] }), null)
  assert.equal(f.recovered({ ...props, messages: [...props.messages, { role: 'assistant', turnId: 'turn-one', deliveryStatus: 'failed' }] }), null)
  assert.equal(f.recovered({ ...props, message: { role: 'user', text: 'Legacy message' } }), null)
  assert.equal(props.messages.length, 1, 'Recovered review UI must not synthesize a persisted reply')
  f.unmount()
})
