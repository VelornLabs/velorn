import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Run the actual hook callback, local connection service and renderer queue
// handlers with RAM-only queues and a deferred native health bridge. No App,
// ComfyUI, real project, model runtime or network is started by these tests.
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const hook = read('../src/hooks/useComfyUI.js')
const localConnection = read('../src/services/localComfyConnection.js')
const workspace = read('../src/components/GenerateWorkspace.jsx')
const actions = read('../src/services/mcpActions.js')
const plain = value => JSON.parse(JSON.stringify(value))

function between(source, first, last) {
  const start = source.indexOf(first), end = source.indexOf(last, start)
  assert.ok(start >= 0 && end > start, `Source boundaries: ${first}`)
  return source.slice(start, end)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const job = { workflowId: 'fixture-image', prompt: 'Synthetic fixture image', seed: 42 }

function harness({ connected = false, allowQueueWhileWaiting = false, launcherCanAutoStart = false,
  dependenciesReady = true, hydration, health, handlerType = 'prompt', assets = [], manifestOverrides = {} } = {}) {
  const state = { checks: [], settings: [], renderedConnected: connected, queue: [],
    writes: 0, dependencyChecks: 0, starts: 0, responses: [], mounted: false }
  const listeners = new Map(), storage = new Map()
  const deny = name => () => { throw new Error(`Forbidden fixture operation: ${name}`) }
  const manifest = { title: 'Synthetic workflow', outputType: 'image', runnable: true, fields: [], ...manifestOverrides }
  const window = {
    electronAPI: {
      async getSetting(key) {
        state.settings.push(key)
        if (hydration) await hydration.promise
        return { host: '127.0.0.1', port: 8189 }
      },
      async checkLocalComfyConnection(payload) {
        state.checks.push(plain(payload))
        return health ? health.promise : { ok: true, status: 200 }
      },
    },
    addEventListener(name, callback) { listeners.set(name, callback) },
    removeEventListener(name) { listeners.delete(name) },
    dispatchEvent(event) {
      if (event.type === 'comfystudio-open-generate-tab') state.mounted = true
      if (event.type === 'comfystudio-mcp-music-video-keyframe-probe' && state.mounted) {
        // This is the workspace's existing unconditional readiness response.
        event.detail.respond({ ready: true })
      }
      listeners.get(event.type)?.(event)
    },
  }
  const context = vm.createContext({
    URL, Error, console, setTimeout, clearTimeout,
    window, fetch: deny('renderer fetch'),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    useCallback: callback => callback,
    setIsConnected: value => { state.renderedConnected = value },
    // The handler deliberately retains its initial render's false value even
    // after setIsConnected; a queued request must use the awaited return value.
    isConnected: connected, allowQueueWhileWaiting, launcherCanAutoStart,
    queueRef: { current: state.queue }, ACTIVE_JOB_STATUSES: ['running'],
    assets, duration: 3, fps: 24, fullPrompt: 'Synthetic frame prompt', negativePrompt: '',
    resolution: { width: 512, height: 320 }, effectiveImageResolution: { width: 512, height: 512 },
    getMcpMyWorkflowLibraryId: () => null,
    getWorkflowManifestByWorkflowId: () => manifest,
    getWorkflowDisplayLabel: () => 'Synthetic workflow',
    isSingleVideoWorkflowId: () => true,
    useFrameForAIStore: { getState: () => ({ frame: { file: { name: 'fixture.png' } } }) },
    createQueuedJob: args => ({ ...args, id: `fixture-job-${state.writes + 1}` }),
    setGenerationQueue: update => { state.queue = update(state.queue); state.writes++ },
    setFormError: () => {}, addComfyLog: () => {},
    startComfyLauncher: () => { state.starts++ },
    validateDependenciesForQueue: async () => { state.dependencyChecks++; return dependenciesReady },
  })
  vm.runInContext(localConnection.replace(/^export /gm, ''), context)
  context.comfyui = {
    checkConnection: async () => Boolean((await vm.runInContext('checkLocalComfyConnection()', context)).ok),
    connect: deny('WebSocket connect'), queuePrompt: deny('ComfyUI generation'),
  }
  const callback = between(hook, '  const checkHttpConnection = useCallback(', '  const recheckConnection =')
  vm.runInContext(callback, context)
  const eventName = `comfystudio-mcp-queue-${handlerType}-generation-batch`
  const marker = workspace.indexOf(`    window.addEventListener('${eventName}', handler)`)
  assert.ok(marker >= 0)
  const start = workspace.lastIndexOf('    const handler = (event) => {', marker)
  assert.ok(start >= 0)
  const handler = vm.runInContext(`(() => { ${workspace.slice(start, marker)}; return handler })()`, context)
  listeners.set(eventName, handler)
  if (handlerType === 'prompt') {
    vm.runInContext(between(actions, 'async function waitForGenerateWorkspaceReady(', 'async function dispatchMusicVideoWorkspaceRequest('), context)
    vm.runInContext(between(actions, 'async function handleQueuePromptGenerationBatch(', 'function handleAddTimelineMarkers('), context)
  }
  return {
    state,
    check: () => vm.runInContext('checkHttpConnection()', context),
    dispatch(payload = {}) {
      return new Promise(resolve => handler({ detail: { jobs: [job], previewOnly: false, ...payload,
        respond: value => { state.responses.push(plain(value)); resolve(plain(value)) } } }))
    },
    applyViaMcp(payload = {}) {
      context.queuePayload = { jobs: [job], previewOnly: false, ...payload }
      return vm.runInContext('handleQueuePromptGenerationBatch(queuePayload)', context)
    },
  }
}

test('first approved MCP submission waits for native health after workspace readiness, then queues exactly once', async () => {
  const health = deferred(), h = harness({ health })
  const initialProbe = h.check()
  const applied = h.applyViaMcp()
  await tick()
  assert.equal(h.state.mounted, true, 'MCP readiness has already accepted the listener')
  assert.equal(h.state.renderedConnected, false)
  assert.equal(h.state.checks.length, 2, 'Both initial and queue-time probes are pending')
  assert.equal(h.state.writes, 0)
  assert.equal(h.state.dependencyChecks, 0)
  health.resolve({ ok: true, status: 200, port: 8189 })
  const result = plain(await applied)
  assert.equal(await initialProbe, true)
  assert.equal(result.success, true)
  assert.equal(result.status.isConnected, true)
  assert.equal(result.jobs.length, 1)
  assert.equal(h.state.queue.length, 1)
  assert.equal(h.state.writes, 1)
  assert.equal(h.state.dependencyChecks, 1)
  assert.equal(h.state.starts, 0)
  assert.equal(h.state.checks.every(request => request.port === 8189), true)
})

test('queue health awaits saved-endpoint hydration and never waits for WebSocket or React repaint', async () => {
  const hydration = deferred(), h = harness({ hydration })
  const applied = h.dispatch()
  await tick()
  assert.equal(h.state.checks.length, 0)
  assert.equal(h.state.writes, 0)
  hydration.resolve()
  const result = await applied
  assert.equal(result.success, true)
  assert.equal(result.status.isConnected, true)
  assert.equal(h.state.checks[0].port, 8189, 'Do not probe the unhydrated default 8188')
  assert.equal(h.state.writes, 1)
})

for (const handlerType of ['prompt', 'timeline']) {
  test(`${handlerType} preview remains available offline without health checks or queue mutations`, async () => {
    const health = deferred(), h = harness({ handlerType, health })
    const result = await h.dispatch({ previewOnly: true })
    assert.equal(result.success, true)
    assert.equal(result.previewOnly, true)
    assert.equal(h.state.checks.length, 0)
    assert.equal(h.state.writes, 0)
    assert.equal(h.state.dependencyChecks, 0)
  })

  test(`${handlerType} approved queue uses fresh health instead of stale connected screen state`, async () => {
    const health = deferred(), h = harness({ handlerType, connected: true, health })
    const applied = h.dispatch()
    await tick()
    assert.equal(h.state.writes, 0)
    health.resolve({ ok: false, error: 'Fixture server offline' })
    const result = await applied
    assert.equal(result.success, false)
    assert.match(result.error, /not connected yet/)
    assert.equal(result.status.isConnected, false)
    assert.equal(h.state.dependencyChecks, 0)
    assert.equal(h.state.starts, 0)
    assert.equal(h.state.writes, 0)
    assert.equal(h.state.responses.length, 1)
  })

  test(`${handlerType} first-mount false state does not block a healthy first queue`, async () => {
    const h = harness({ handlerType })
    const result = await h.dispatch()
    assert.equal(result.success, true)
    assert.equal(result.status.isConnected, true)
    assert.equal(h.state.writes, 1)
    assert.equal(h.state.queue.length, 1)
    assert.equal(h.state.responses.length, 1)
  })

  test(`${handlerType} existing launcher-wait behavior is preserved after a genuinely offline check`, async () => {
    const health = deferred(), h = harness({ handlerType, health, allowQueueWhileWaiting: true, launcherCanAutoStart: true })
    const applied = h.dispatch()
    health.resolve({ ok: false, error: 'Fixture launcher not started yet' })
    const result = await applied
    assert.equal(result.success, true)
    assert.equal(result.status.isConnected, false)
    assert.equal(h.state.starts, 1)
    assert.equal(h.state.writes, 1)
  })
}

test('successful fresh connection does not bypass missing workflow dependencies or retry a job', async () => {
  const h = harness({ dependenciesReady: false })
  const result = await h.dispatch()
  assert.equal(result.success, false)
  assert.match(result.error, /Missing required workflow dependencies/)
  assert.equal(h.state.checks.length, 1)
  assert.equal(h.state.dependencyChecks, 1)
  assert.equal(h.state.writes, 0)
  assert.equal(h.state.responses.length, 1)
})

test('invalid batch fails before starting a health check', async () => {
  const h = harness()
  const result = await h.dispatch({ jobs: [] })
  assert.equal(result.success, false)
  assert.equal(h.state.checks.length, 0)
  assert.equal(h.state.writes, 0)
})

const i2vJob = { workflowId: 'ltx23-i2v', prompt: 'A gentle camera push-in.',
  assetFieldIds: { image: 'existing-image' }, durationSeconds: 3, fps: 24,
  resolution: { width: 512, height: 320 }, seed: 44 }
const i2vManifest = { title: 'Image to Video (LTX 2.3)', outputType: 'video', needsImage: true }

test('explicit image-to-video job preserves its image and settings without taking a timeline frame', async () => {
  const h = harness({ assets: [{ id: 'existing-image', type: 'image', name: 'Synthetic image' }], manifestOverrides: i2vManifest })
  const result = await h.dispatch({ jobs: [i2vJob] })
  assert.equal(result.success, true)
  assert.equal(h.state.writes, 1)
  const queued = plain(h.state.queue[0])
  assert.equal(queued.workflowId, 'ltx23-i2v')
  assert.equal(queued.category, 'video')
  assert.equal(queued.inputAssetId, 'existing-image')
  assert.equal(queued.inputAssetType, 'image')
  assert.equal(queued.inputFromTimelineFrame, false)
  assert.equal(queued.needsImage, true)
  assert.equal(queued.duration, 3)
  assert.equal(queued.fps, 24)
  assert.equal(queued.seed, 44)
  assert.deepEqual(queued.resolution, { width: 512, height: 320 })
  assert.deepEqual(queued.assetFieldIds, { image: 'existing-image' })
})

test('image-to-video rejects absent or wrong-type source assets before queue creation', async () => {
  for (const assets of [[], [{ id: 'existing-image', type: 'audio' }]]) {
    const h = harness({ assets, manifestOverrides: i2vManifest })
    const result = await h.dispatch({ jobs: [i2vJob] })
    assert.equal(result.success, false)
    assert.match(result.error, /Unknown reference\/input asset ID|input must be an image asset/)
    assert.equal(h.state.writes, 0)
    assert.equal(h.state.checks.length, 0)
  }
})
