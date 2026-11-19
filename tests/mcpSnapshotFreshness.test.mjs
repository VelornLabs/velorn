import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentDispatchScope } = require('../electron/connectedAgentDispatch.cjs')
const renderer = fs.readFileSync(new URL('../src/services/mcpActions.js', import.meta.url), 'utf8')
const bridgeSource = renderer.slice(renderer.indexOf('export function startMcpActionBridge()')).replace('export function', 'function')
const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
const nativeSource = main.slice(main.indexOf("ipcMain.handle('mcp:updateSnapshot'"), main.indexOf('// ComfyUI Launcher IPC'))
const empty = () => ({ schemaVersion: 2, project: null, currentTimeline: null, assets: [], timelines: [], folders: [] })
const project = () => ({ ...empty(), project: { name: 'Fresh project', path: '/synthetic/freshness' },
  currentTimeline: { id: 'timeline', clips: [], tracks: [], transitions: [] } })
const json = result => JSON.parse(result.content[0].text)

function harness({ run, capture } = {}) {
  let live = empty(), callback, sequence = 0
  const server = createComfyStudioMcpServer()
  server.updateSnapshot(empty())
  const ipcMain = new EventEmitter(), handlers = new Map(), pending = new Map(), responses = []
  ipcMain.handle = (name, handler) => handlers.set(name, handler)
  const sender = { id: 1, mainFrame: {} }, otherSender = { id: 2 }
  vm.runInNewContext(nativeSource, { ipcMain, mcpServer: server, mainWindow: { webContents: sender },
    pendingMcpActionRequests: pending, clearTimeout, console, agentDispatchScope: createAgentDispatchScope() })
  const api = {
    onAction(handler) { callback = handler; return () => { callback = null } },
    sendActionResult(response) { responses.push(response); ipcMain.emit('mcp:actionResult', { sender, senderFrame: sender.mainFrame }, response) },
  }
  const bridge = vm.runInNewContext(bridgeSource + '\nstartMcpActionBridge', {
    window: { electronAPI: { mcp: api } },
    runMcpAction: async (action, payload) => run ? run(action, payload, value => { live = value }, () => live) : { action },
    buildMcpSnapshot: () => capture ? capture(live) : structuredClone(live),
    assertAgentInteractionContext: guard => { assert.equal(guard, undefined, 'Legacy freshness fixture has no agent guard') },
    captureAgentInteractionContext: () => ({ context: { session: 'synthetic-freshness' }, selection: {}, playhead: 0 }),
  })
  const stop = bridge()
  async function action(name, payload = {}) {
    const id = `action-${++sequence}`
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    // Exactly the production action callback and native handler. No timer,
    // sleep, heartbeat, per-read refresh, or pre-populated post-action state.
    void callback({ id, action: name, payload })
    return result
  }
  return { action, server, responses, pending, ipcMain, sender, otherSender, stop,
    publish: (snapshot, from = sender) => handlers.get('mcp:updateSnapshot')({ sender: from }, snapshot) }
}

test('successful create, import, edit and Undo are immediately visible to cached read tools', async () => {
  const h = harness({ run(action, _payload, set, get) {
    if (action === 'create_project') set(project())
    if (action === 'import_asset_from_path') set({ ...get(), assets: [{ id: 'asset', name: 'Imported', type: 'video' }] })
    if (action === 'edit') set({ ...get(), currentTimeline: { ...get().currentTimeline,
      clips: [{ id: 'clip', type: 'video', assetId: 'asset', duration: 2 }] } })
    if (action === 'undo') set({ ...get(), currentTimeline: { ...get().currentTimeline, clips: [] } })
    return { success: true, action }
  } })
  await h.action('create_project')
  assert.equal(json(await h.server.callTool('get_project')).project.name, 'Fresh project')
  assert.equal((await h.server.callTool('get_timeline')).isError, undefined)
  await h.action('import_asset_from_path')
  assert.equal(json(await h.server.callTool('get_assets')).assets[0].id, 'asset')
  await h.action('edit')
  assert.equal(json(await h.server.callTool('get_timeline')).clips[0].id, 'clip')
  await h.action('undo')
  assert.equal(json(await h.server.callTool('get_timeline')).clips.length, 0)
  h.stop()
})

test('get_assets accepts natural complete-inventory aliases without filtering out every asset', async () => {
  const server = createComfyStudioMcpServer()
  server.updateSnapshot({ ...project(), assets: [
    { id: 'video', name: 'Video', type: 'video' },
    { id: 'audio', name: 'Audio', type: 'audio' },
  ] })
  const definition = server.tools.find(tool => tool.name === 'get_assets')
  assert.match(definition.description, /omit type.*all\/any.*every media type/i)
  assert.match(definition.inputSchema.properties.type.description, /omit it.*all\/any.*complete inventory/i)
  for (const args of [{}, { type: 'all' }, { type: 'ANY' }, { type: '*' }]) {
    const result = json(await server.callTool('get_assets', args))
    assert.equal(result.count, 2)
    assert.deepEqual(result.assets.map(asset => asset.id), ['video', 'audio'])
  }
  assert.deepEqual(json(await server.callTool('get_assets', { type: 'audio' })).assets.map(asset => asset.id), ['audio'])
})

test('capture follows awaited action completion, including overlapping asynchronous work', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = harness({ async run(action, _payload, set, get) {
    if (action === 'slow') await gate
    set({ ...project(), assets: [...get().assets, { id: action }] })
    return { action }
  } })
  const slow = h.action('slow')
  await h.action('fast')
  assert.deepEqual(h.server.lastSnapshot.assets.map(asset => asset.id), ['fast'])
  release(); await slow
  assert.deepEqual(h.server.lastSnapshot.assets.map(asset => asset.id), ['fast', 'slow'])
  h.stop()
})

test('an action error still publishes its current state before being reported', async () => {
  const h = harness({ run(_action, _payload, set) { set(project()); throw new Error('Synthetic action failure') } })
  await assert.rejects(h.action('partial-failure'), /Synthetic action failure/)
  assert.equal(json(await h.server.callTool('get_project')).project.name, 'Fresh project')
  assert.equal(h.pending.size, 0)
  h.stop()
})

test('snapshot failure after a completed action is explicit and warns against replay', async () => {
  const h = harness({ capture() { throw new Error('Synthetic snapshot failure') } })
  await assert.rejects(h.action('edit'), /completed.*snapshot.*[Dd]o not.*repeat/)
  assert.equal(h.pending.size, 0)
  assert.equal(h.responses[0].success, true)
  assert.match(h.responses[0].snapshotError, /Synthetic snapshot failure/)
  h.stop()
})

test('native snapshot rejection cannot be acknowledged as fresh success', async () => {
  const h = harness()
  h.server.updateSnapshot = () => false
  await assert.rejects(h.action('edit'), /completed.*snapshot.*[Dd]o not.*repeat/)
  assert.equal(h.pending.size, 0)
  h.stop()
})

test('foreign windows and expired action responses cannot replace editor snapshots', async () => {
  const h = harness()
  assert.equal((await h.publish(project(), h.otherSender)).success, false)
  assert.equal(h.server.lastSnapshot.project, null)
  h.pending.set('pending', { resolve() { assert.fail('Foreign result must not resolve') } })
  h.ipcMain.emit('mcp:actionResult', { sender: h.otherSender }, { id: 'pending', success: true, snapshot: project() })
  h.ipcMain.emit('mcp:actionResult', { sender: h.sender }, { id: 'expired', success: true, snapshot: project() })
  assert.equal(h.server.lastSnapshot.project, null)
  assert.equal(h.pending.has('pending'), true)
  h.pending.clear()
  assert.equal((await h.publish(project())).success, true)
  assert.equal(h.server.lastSnapshot.project.name, 'Fresh project')
  h.stop()
})
