import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverRunningComfy, connectRunningComfy } from '../src/services/comfyConnectionSetup.mjs'
import { getLocalComfyConnectionSync, saveLocalComfyConnectionPort, COMFY_CONNECTION_CHANGED_EVENT } from '../src/services/localComfyConnection.js'
import { pickComfyLauncherScript, pickComfyLauncherMacApp, getComfyLauncherConfig } from '../src/services/comfyLauncher.js'

function fixture(overrides = {}) {
  const calls = [], storage = new Map(), events = []
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail } }
  globalThis.window = {
    dispatchEvent: event => events.push(event),
    electronAPI: {
      setSetting: async (key, value) => { calls.push(['save', key, value]); return { success: true } },
      comfyLauncher: {
        getState: async () => ({ state: 'external', ownership: 'external', httpBase: 'http://127.0.0.1:8188' }),
        discoverConnections: async () => ({ success: true, connections: [8188, 8000].map(port => ({ port, httpBase: `http://127.0.0.1:${port}`, deviceNames: ['Synthetic GPU'] })) }),
        probeConnection: async ({ port }) => { calls.push(['probe', port]); return { success: true, connection: { port, httpBase: `http://127.0.0.1:${port}`, deviceNames: [] } } },
        ...overrides,
      },
    },
  }
  return { calls, storage, events, api: window.electronAPI.comfyLauncher }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(predicate) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Synthetic connection operation did not reach its wait point')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('discovery presents all candidates without settings writes or lifecycle calls', async () => {
  const f = fixture()
  const result = await discoverRunningComfy()
  assert.deepEqual(result.connections.map(item => item.port), [8188, 8000])
  assert.deepEqual(f.calls, []); assert.deepEqual(f.events, [])
})

test('manual custom port is freshly tested and saved, then dispatches one connection change', async () => {
  const f = fixture()
  const result = await connectRunningComfy('http://localhost:18889')
  assert.equal(result.success, true)
  assert.deepEqual(f.calls.map(item => item[0]), ['probe', 'save'])
  assert.equal(f.calls[0][1], 18889)
  assert.equal(getLocalComfyConnectionSync().port, 18889)
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, COMFY_CONNECTION_CHANGED_EVENT)
})

test('non-local or invalid input never probes or saves', async () => {
  for (const input of ['http://example.com:8188', '0', '65536', '123.4', 'badport']) {
    const f = fixture(); assert.equal((await connectRunningComfy(input)).success, false)
    assert.deepEqual(f.calls, [])
  }
})

test('failed/replaced endpoint is not saved', async () => {
  for (const response of [{ success: false, error: 'Offline' }, { success: true, connection: { port: 9 } }]) {
    const f = fixture({ probeConnection: async () => response })
    const before = getLocalComfyConnectionSync().port
    assert.equal((await connectRunningComfy(8188)).success, false)
    assert.equal(getLocalComfyConnectionSync().port, before); assert.deepEqual(f.calls, [])
  }
})

test('failed native save preserves in-memory and localStorage connection and does not announce success', async () => {
  const f = fixture()
  await saveLocalComfyConnectionPort(8188)
  const stored = [...f.storage], count = f.events.length
  window.electronAPI.setSetting = async () => ({ success: false, error: 'Disk unavailable' })
  const result = await connectRunningComfy(8000)
  assert.equal(result.success, false); assert.match(result.error, /Disk unavailable/)
  assert.equal(getLocalComfyConnectionSync().port, 8188)
  assert.deepEqual([...f.storage], stored); assert.equal(f.events.length, count)
})

test('owned running/starting/stopping instances must not be abandoned by a port switch', async () => {
  for (const ownership of ['ours', 'app']) for (const state of ['running', 'starting', 'stopping']) {
    const f = fixture({ getState: async () => ({ state, ownership, httpBase: 'http://127.0.0.1:8188' }) })
    assert.equal((await connectRunningComfy(8000)).success, false)
    assert.deepEqual(f.calls, [])
    assert.equal((await connectRunningComfy(8188)).success, true)
  }
})

test('launcher state is rechecked after an asynchronous probe', async () => {
  let reads = 0
  const f = fixture({ getState: async () => ++reads === 1
    ? { state: 'idle', ownership: 'none' }
    : { state: 'starting', ownership: 'ours', httpBase: 'http://127.0.0.1:8188' } })
  assert.equal((await connectRunningComfy(8000)).success, false)
  assert.deepEqual(f.calls, [['probe', 8000]])
})

test('closing guided setup during either launcher read cancels without saving', async () => {
  for (const heldRead of [1, 2]) {
    const gate = deferred(); let reads = 0, current = true
    const f = fixture({ getState: async () => {
      if (++reads === heldRead) await gate.promise
      return { state: 'idle', ownership: 'none' }
    } })
    const before = getLocalComfyConnectionSync().port
    const pending = connectRunningComfy(8000, { isCurrent: () => current })
    await until(() => reads === heldRead); current = false; gate.resolve()
    assert.deepEqual(await pending, { success: false, cancelled: true })
    assert.equal(reads, heldRead)
    assert.deepEqual(f.calls, heldRead === 1 ? [] : [['probe', 8000]])
    assert.equal(getLocalComfyConnectionSync().port, before); assert.deepEqual([...f.storage], []); assert.deepEqual(f.events, [])
  }
})

test('closing guided setup during a successful or rejected probe returns cancelled without further reads or writes', async () => {
  for (const rejectProbe of [false, true]) {
    const gate = deferred(); let probing = false, current = true, reads = 0
    const f = fixture({ getState: async () => { reads++; return { state: 'idle', ownership: 'none' } },
      probeConnection: async ({ port }) => {
        probing = true; await gate.promise
        if (rejectProbe) throw new Error('The now-closed probe failed')
        return { success: true, connection: { port } }
      } })
    const before = getLocalComfyConnectionSync().port
    const pending = connectRunningComfy(8000, { isCurrent: () => current })
    await until(() => probing); current = false; gate.resolve()
    assert.deepEqual(await pending, { success: false, cancelled: true })
    assert.equal(reads, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []); assert.deepEqual([...f.storage], [])
    assert.equal(getLocalComfyConnectionSync().port, before)
  }
})

test('closed or invalid synchronous liveness guard prevents connection work', async () => {
  let reads = 0
  const f = fixture({ getState: async () => { reads++; return { state: 'idle', ownership: 'none' } } })
  for (const isCurrent of [() => false, () => undefined, () => { throw new Error('No longer mounted') }, 'not-a-function']) {
    assert.deepEqual(await connectRunningComfy(8000, { isCurrent }), { success: false, cancelled: true })
    assert.deepEqual(await saveLocalComfyConnectionPort(8000, { isCurrent }), { success: false, cancelled: true })
  }
  assert.equal(reads, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []); assert.deepEqual([...f.storage], [])
})

test('cancelled save also leaves browser fallback cache and storage untouched', async () => {
  const f = fixture(), before = getLocalComfyConnectionSync().port
  delete window.electronAPI.setSetting
  assert.deepEqual(await saveLocalComfyConnectionPort(8000, { isCurrent: () => false }), { success: false, cancelled: true })
  assert.equal(getLocalComfyConnectionSync().port, before); assert.deepEqual([...f.storage], []); assert.deepEqual(f.events, [])
  assert.equal((await saveLocalComfyConnectionPort(8000)).success, true)
  assert.equal(getLocalComfyConnectionSync().port, 8000); assert.equal(f.events.length, 1)
})

test('missing native bridge and rejected probes yield useful errors without writes', async () => {
  const f = fixture({ discoverConnections: undefined, probeConnection: undefined })
  assert.match((await discoverRunningComfy()).error, /reopen Velorn/)
  assert.match((await connectRunningComfy(8000)).error, /reopen Velorn/)
  assert.deepEqual(f.calls, [])
  fixture({ probeConnection: async () => { throw new Error('Unavailable') } })
  assert.equal((await connectRunningComfy(8000)).error, 'Unavailable')
})

test('concurrent settings saves are persisted and announced in order', async () => {
  const f = fixture(), pending = []
  window.electronAPI.setSetting = async (key, value) => {
    f.calls.push(value.port)
    await new Promise(resolve => pending.push(resolve))
    return { success: true }
  }
  const first = saveLocalComfyConnectionPort(8188), second = saveLocalComfyConnectionPort(8000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, [8188]); pending.shift()()
  await first; await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, [8188, 8000]); pending.shift()()
  await second
  assert.equal(getLocalComfyConnectionSync().port, 8000)
  assert.deepEqual(f.events.map(event => event.detail.port), [8188, 8000])
})

test('queued settings save rechecks cancellation before native persistence and leaves the queue usable', async () => {
  const f = fixture(), gate = deferred(); let current = true, started = false
  window.electronAPI.setSetting = async (_key, value) => {
    f.calls.push(value.port); started = true; await gate.promise; return { success: true }
  }
  const first = saveLocalComfyConnectionPort(8188)
  await until(() => started)
  const cancelled = saveLocalComfyConnectionPort(8000, { isCurrent: () => current })
  current = false; gate.resolve()
  assert.equal((await first).success, true)
  assert.deepEqual(await cancelled, { success: false, cancelled: true })
  assert.deepEqual(f.calls, [8188]); assert.equal(getLocalComfyConnectionSync().port, 8188)
  assert.deepEqual(f.events.map(event => event.detail.port), [8188])
  assert.equal((await saveLocalComfyConnectionPort(8189)).success, true)
  assert.deepEqual(f.calls, [8188, 8189]); assert.equal(getLocalComfyConnectionSync().port, 8189)
})

test('guided connect carries its cancellation guard into the settings save queue', async () => {
  const gate = deferred(); let current = true, started = false, reads = 0
  const f = fixture({ getState: async () => { reads++; return { state: 'idle', ownership: 'none' } } })
  window.electronAPI.setSetting = async (_key, value) => {
    f.calls.push(['save', value.port]); started = true; await gate.promise; return { success: true }
  }
  const first = saveLocalComfyConnectionPort(8188)
  await until(() => started)
  const pending = connectRunningComfy(8000, { isCurrent: () => current })
  await until(() => reads === 2)
  // Let connect pass its second read and enqueue behind the held first save.
  await new Promise(resolve => setImmediate(resolve))
  current = false; gate.resolve(); await first
  assert.deepEqual(await pending, { success: false, cancelled: true })
  assert.deepEqual(f.calls, [['save', 8188], ['probe', 8000]])
  assert.deepEqual(f.events.map(event => event.detail.port), [8188]); assert.equal(getLocalComfyConnectionSync().port, 8188)
})

test('closing after native save starts reports its actual success or failure instead of claiming rollback', async () => {
  for (const success of [true, false]) {
    const f = fixture(), gate = deferred(); let started = false, current = true
    await saveLocalComfyConnectionPort(8188)
    const eventsBefore = f.events.length, storageBefore = [...f.storage]
    window.electronAPI.setSetting = async (_key, value) => {
      f.calls.push(['save-started', value.port]); started = true; await gate.promise
      return success ? { success: true } : { success: false, error: 'Save failed after starting' }
    }
    const pending = connectRunningComfy(8000, { isCurrent: () => current })
    await until(() => started); current = false; gate.resolve()
    const result = await pending
    assert.equal(result.success, success); assert.equal(result.cancelled, undefined)
    assert.equal(getLocalComfyConnectionSync().port, success ? 8000 : 8188)
    assert.equal(f.events.length, eventsBefore + (success ? 1 : 0))
    if (success) assert.equal(result.connection.port, 8000)
    else { assert.match(result.error, /Save failed after starting/); assert.deepEqual([...f.storage], storageBefore) }
  }
})

test('launcher pickers do not report success when saving the selected target failed', async () => {
  fixture({ pickLauncherScript: async () => ({ success: true, filePath: '/synthetic/start.sh' }),
    pickMacApp: async () => ({ success: true, filePath: '/Applications/ComfyUI.app' }),
    setConfig: async () => ({ success: false, error: 'Cannot save launcher' }) })
  const before = getComfyLauncherConfig()
  for (const pick of [pickComfyLauncherScript, pickComfyLauncherMacApp]) {
    const result = await pick()
    assert.equal(result.success, false); assert.match(result.error, /Cannot save/)
  }
  assert.deepEqual(getComfyLauncherConfig(), before)
})
