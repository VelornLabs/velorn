import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// Run the production compositor with a deterministic WebGL test double. Its
// unrelated shader/effect imports are inert here; readback methods are intact.
const source = (await fs.readFile(new URL('../src/services/gpuCompositor.js', import.meta.url), 'utf8'))
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')
  .replace(/^export const /gm, 'const ')

function harness({ statuses = ['CONDITION_SATISFIED'], missingFence = false, debugExtension = true,
  onYield = () => {}, onCopy = () => {}, contextIsLost = () => false } = {}) {
  let clock = 0, copyCount = 0
  const calls = [], parameters = [], extensions = [], events = new Map()
  const statusQueue = [...statuses]
  let boundPbo = null
  const methods = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getParameter(name) {
      parameters.push(name)
      if (name === 'MAX_SAMPLES') return 0
      return ({ VENDOR: 'Test vendor', RENDERER: 'Test renderer', UNMASKED_VENDOR_WEBGL: 'GPU vendor', UNMASKED_RENDERER_WEBGL: 'GPU renderer' })[name] ?? null
    },
    getExtension(name) {
      extensions.push(name)
      if (name === 'WEBGL_debug_renderer_info' && debugExtension) {
        return { UNMASKED_VENDOR_WEBGL: 'UNMASKED_VENDOR_WEBGL', UNMASKED_RENDERER_WEBGL: 'UNMASKED_RENDERER_WEBGL' }
      }
      return null
    },
    drawArrays() { clock += 2 },
    bindBuffer(target, buffer) { if (target === 'PIXEL_PACK_BUFFER') boundPbo = buffer },
    readPixels(...args) {
      clock += 3
      calls.push(['readPixels', args.at(-1)])
      if (typeof args.at(-1) !== 'number') args.at(-1).fill(42)
    },
    fenceSync: () => missingFence ? null : {},
    flush() { clock += 5; calls.push(['flush']) },
    clientWaitSync() {
      clock += 7
      const status = statusQueue.shift() ?? 'ALREADY_SIGNALED'
      calls.push(['poll', status])
      return status
    },
    getBufferSubData(_target, _offset, output) {
      clock += 13
      output.fill(++copyCount)
      calls.push(['copy'])
      onCopy()
    },
    deleteSync() { calls.push(['deleteSync']) },
    isContextLost: contextIsLost,
  }
  const gl = new Proxy(methods, {
    get(target, name) {
      if (name in target) return target[name]
      if (/^[A-Z0-9_]+$/.test(name)) return name
      if (name.startsWith('create')) return () => ({})
      return () => {}
    },
  })
  const context = vm.createContext({
    console,
    performance: { now: () => clock },
    setTimeout(callback) { clock += 11; onYield(); callback() },
    document: {
      createElement: () => ({ getContext: () => gl, addEventListener: (name, callback) => events.set(name, callback) }),
    },
    ImageData: class {
      constructor(data, width, height) { Object.assign(this, { data, width, height }) }
    },
    GLSL_EFFECT_VERTEX_SOURCE: '',
    GLSL_EFFECT_FRAGMENT_SOURCE: '',
    ADJUSTMENT_STAGES_GLSL: '',
    ADJUSTMENT_COLOR_PASS_FS: '',
    VELOCITY_BLUR_VERTEX_SOURCE: '',
    VELOCITY_BLUR_FRAGMENT_SOURCE: '',
  })
  vm.runInContext(`${source}\nglobalThis.compositor = createGpuCompositor({ width: 2, height: 2 })`, context)
  assert.ok(context.compositor)
  return { compositor: context.compositor, calls, parameters, extensions, events, getBoundPbo: () => boundPbo }
}

test('async readback separates submission, fence polling/yields, and CPU buffer copy', async () => {
  const { compositor, calls } = harness({ statuses: ['TIMEOUT_EXPIRED', 'TIMEOUT_EXPIRED', 'CONDITION_SATISFIED'] })
  const ticket = compositor.beginFrameReadback()
  let stats = compositor.getReadbackStats()
  assert.equal(stats.asyncSubmitted, 1)
  assert.equal(stats.asyncResolved, 0)
  assert.equal(stats.asyncFinalPassMs, 2)
  assert.equal(stats.asyncReadPixelsMs, 3)
  assert.equal(stats.asyncFlushMs, 5)
  assert.equal(stats.asyncSubmitMs, 10)
  assert.equal(calls.some(([call]) => call === 'copy'), false)
  const pixels = await compositor.resolveFrameReadback(ticket)
  assert.equal(pixels.length, 16)
  assert.equal(pixels[0], 1)
  stats = compositor.getReadbackStats()
  assert.equal(stats.asyncResolved, 1)
  assert.equal(stats.fencePolls, 3)
  assert.equal(stats.fenceTimeouts, 2)
  assert.equal(stats.fencePollMs, 21)
  assert.equal(stats.fenceYieldMs, 22)
  assert.equal(stats.fenceWaitMs, 43)
  assert.equal(stats.bufferCopyMs, 13)
  assert.equal(stats.asyncResolveMs, 56)
  assert.equal(stats.maxFenceWaitMs, 43)
  assert.equal(stats.maxBufferCopyMs, 13)
  assert.equal(stats.maxAsyncReadPixelsMs, 3)
  assert.equal(compositor.canUseAsyncReadback(), true)
  assert.deepEqual(calls.map(([call]) => call), ['readPixels', 'flush', 'poll', 'poll', 'poll', 'copy', 'deleteSync'])
})

test('stats remain fixed-size cumulative detached snapshots and renderer queries run once', async () => {
  const { compositor, parameters, extensions } = harness()
  const first = compositor.getReadbackStats()
  assert.equal(first.width, 2)
  assert.equal(first.height, 2)
  assert.equal(first.rendererInfo.unmaskedRenderer, 'GPU renderer')
  first.rendererInfo.renderer = 'mutated snapshot'
  first.asyncSubmitted = 999
  for (let index = 0; index < 30; index++) {
    await compositor.resolveFrameReadback(compositor.beginFrameReadback())
  }
  const latest = compositor.getReadbackStats()
  assert.equal(latest.asyncSubmitted, 30)
  assert.equal(latest.asyncResolved, 30)
  assert.equal(latest.asyncReadPixelsMs, 90)
  assert.equal(latest.bufferCopyMs, 390)
  assert.equal(latest.maxBufferCopyMs, 13)
  assert.equal(latest.rendererInfo.renderer, 'Test renderer')
  assert.equal(first.asyncResolved, 0)
  assert.equal(Object.keys(first).length, Object.keys(latest).length)
  assert.equal(Object.values(latest).some(Array.isArray), false)
  assert.deepEqual(extensions, ['WEBGL_debug_renderer_info'])
  assert.deepEqual(parameters, ['MAX_SAMPLES', 'VENDOR', 'RENDERER', 'UNMASKED_VENDOR_WEBGL', 'UNMASKED_RENDERER_WEBGL'])
})

test('synchronous export and stage fallback readbacks are counted separately from async reads', () => {
  const { compositor } = harness()
  assert.equal(compositor.readFramePixels()[0], 42)
  let image = null
  compositor.readStageIntoContext({ putImageData(value) { image = value } })
  assert.equal(image.data[0], 42)
  assert.equal(image.width, 2)
  const stats = compositor.getReadbackStats()
  assert.equal(stats.syncFrameReads, 1)
  assert.equal(stats.syncStageReads, 1)
  assert.equal(stats.syncReadPixelsMs, 6)
  assert.equal(stats.syncFinalPassMs, 4)
  assert.equal(stats.asyncSubmitted, 0)
  assert.equal(stats.bufferCopyMs, 0)
})

test('diagnostics preserve ring backpressure, ticket validation and returned pixel ownership', async () => {
  const { compositor } = harness()
  const tickets = [compositor.beginFrameReadback(), compositor.beginFrameReadback(), compositor.beginFrameReadback()]
  assert.throws(() => compositor.beginFrameReadback(), /ring exhausted/)
  await assert.rejects(compositor.resolveFrameReadback(99), /Unknown GPU readback ticket/)
  const firstPixels = await compositor.resolveFrameReadback(tickets[0])
  const secondPixels = await compositor.resolveFrameReadback(tickets[1])
  assert.notEqual(firstPixels, secondPixels)
  assert.equal(firstPixels[0], 1)
  assert.equal(secondPixels[0], 2)
  await assert.rejects(compositor.resolveFrameReadback(tickets[1]), /Unknown GPU readback ticket/)
  assert.equal(compositor.getReadbackStats().asyncSubmitted, 3)
  assert.equal(compositor.getReadbackStats().asyncResolved, 2)
  assert.equal(compositor.beginFrameReadback(), tickets[0])
})

test('missing optional GPU identity and context loss are safe to inspect', () => {
  const { compositor, events, extensions } = harness({ debugExtension: false })
  assert.equal(compositor.getReadbackStats().rendererInfo.unmaskedRenderer, null)
  let prevented = false
  events.get('webglcontextlost')({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(compositor.getReadbackStats().contextLost, true)
  assert.equal(compositor.isContextLost(), true)
  assert.deepEqual(extensions, ['WEBGL_debug_renderer_info'])
})

test('failed and missing fences throw, release their slots and never copy potentially invalid pixels', async () => {
  const failed = harness({ statuses: ['WAIT_FAILED'] })
  const ticket = failed.compositor.beginFrameReadback()
  await assert.rejects(failed.compositor.resolveFrameReadback(ticket), /fence wait failed/)
  assert.equal(failed.compositor.getReadbackStats().fenceWaitFailures, 1)
  assert.equal(failed.compositor.getReadbackStats().asyncResolved, 0)
  assert.equal(failed.calls.some(([call]) => call === 'copy'), false)
  assert.equal(failed.getBoundPbo(), null)
  assert.equal(failed.compositor.beginFrameReadback(), ticket)
  const missing = harness({ missingFence: true })
  assert.throws(() => missing.compositor.beginFrameReadback(), /fence could not be created/)
  const stats = missing.compositor.getReadbackStats()
  assert.equal(stats.missingFences, 1)
  assert.equal(stats.fencePolls, 0)
  assert.equal(stats.asyncSubmitted, 0)
  assert.equal(stats.asyncResolved, 0)
  assert.equal(stats.bufferCopyMs, 0)
  assert.equal(missing.getBoundPbo(), null)
})

test('a bounded fence wait collects its original PBO then drains pending tickets without more polling', async () => {
  const { compositor, calls, getBoundPbo } = harness({ statuses: Array(100).fill('TIMEOUT_EXPIRED') })
  const first = compositor.beginFrameReadback(), second = compositor.beginFrameReadback()
  const firstPixels = await compositor.resolveFrameReadback(first)
  let stats = compositor.getReadbackStats()
  assert.equal(compositor.canUseAsyncReadback(), false)
  assert.equal(stats.fenceWaitFallbacks, 1)
  assert.equal(stats.forcedPboReadbacks, 1)
  assert.equal(stats.fallbackReason, 'fence-timeout')
  assert.equal(stats.fenceWaitMs, 54)
  assert.equal(stats.fencePolls, 3)
  assert.equal(stats.bufferCopyMs, 13)
  assert.throws(() => compositor.beginFrameReadback(), /Asynchronous GPU readback disabled/)
  const secondPixels = await compositor.resolveFrameReadback(second)
  stats = compositor.getReadbackStats()
  assert.equal(firstPixels[0], 1)
  assert.equal(secondPixels[0], 2)
  assert.equal(stats.fencePolls, 3)
  assert.equal(stats.fenceWaitFallbacks, 1)
  assert.equal(stats.forcedPboReadbacks, 2)
  assert.equal(calls.filter(([call]) => call === 'readPixels').length, 2, 'fallback must never reread the current stage')
  assert.equal(getBoundPbo(), null)
  assert.equal(compositor.readFramePixels()[0], 42)
  assert.equal(harness().compositor.canUseAsyncReadback(), true, 'fallback is scoped to one compositor')
})

test('cancellation before/during polling and during copy throws and releases readback state', async () => {
  for (const when of ['before', 'yield', 'copy']) {
    const controller = new AbortController()
    const h = harness({ statuses: ['TIMEOUT_EXPIRED'],
      onYield: () => { if (when === 'yield') controller.abort() },
      onCopy: () => { if (when === 'copy') controller.abort() } })
    const ticket = h.compositor.beginFrameReadback()
    if (when === 'before') controller.abort()
    await assert.rejects(h.compositor.resolveFrameReadback(ticket, { signal: controller.signal }), /Export cancelled/)
    assert.equal(h.compositor.getReadbackStats().asyncResolved, 0)
    assert.equal(h.compositor.getReadbackStats().fenceWaitFallbacks, 0)
    assert.equal(h.calls.filter(([call]) => call === 'deleteSync').length, 1)
    assert.equal(h.getBoundPbo(), null)
    assert.equal(h.compositor.beginFrameReadback(), ticket)
    if (when !== 'copy') assert.equal(h.calls.some(([call]) => call === 'copy'), false)
  }
})

test('context loss, invalid statuses, disposal and copy errors never return frame pixels', async () => {
  for (const failure of ['loss', 'invalid', 'disposed', 'copy']) {
    let lost = false
    const h = harness({ statuses: [failure === 'invalid' ? 'INVALID' : 'TIMEOUT_EXPIRED'],
      contextIsLost: () => lost,
      onYield: () => {
        if (failure === 'loss') lost = true
        if (failure === 'disposed') h.compositor.dispose()
      },
      onCopy: () => { if (failure === 'copy') throw new Error('Synthetic copy failure') } })
    await assert.rejects(h.compositor.resolveFrameReadback(h.compositor.beginFrameReadback()),
      /GPU context lost|invalid fence status|Synthetic copy failure/)
    assert.equal(h.compositor.getReadbackStats().asyncResolved, 0)
    assert.equal(h.getBoundPbo(), null)
    if (failure !== 'copy') assert.equal(h.calls.some(([call]) => call === 'copy'), false)
  }
})
