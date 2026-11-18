'use strict'
// The host's own sharing choices for the Velorn network: off by default, checked
// as a whole, saved privately, and honest about what this computer can offer.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createGpuShareHost, registerGpuShareIpc, normalizeSettings, DEFAULTS } = require('../electron/gpuShareHost.cjs')

async function fixture(t, { queue = { queue_running: [], queue_pending: [] }, capability = { ok: true }, exportBusy = false, comfyDown = false, devices = [{ name: 'cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync', type: 'cuda', vram_total: 33659879424 }] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-gpu-share-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const state = { queue, capability, exportBusy, comfyDown, devices, asked: [] }
  const make = () => createGpuShareHost({ settingsPath: path.join(dir, 'private', 'gpu-share.json'), getEndpoint: async () => 'http://127.0.0.1:8188', isExportBusy: () => state.exportBusy,
    runner: { capability: async id => { state.asked.push(id); return { workflowId: id, ...state.capability } } },
    fetchImpl: async url => { if (state.comfyDown) throw new Error('refused'); if (url === 'http://127.0.0.1:8188/system_stats') return new Response(JSON.stringify({ devices: state.devices }), { status: 200 })
      assert.equal(url, 'http://127.0.0.1:8188/queue'); return new Response(JSON.stringify(state.queue), { status: 200 }) } })
  return { dir, state, make, host: make() }
}

test('sharing is off until the person switches it on, and Velorn offers no workflows of its own', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.host.getSettings(), { version: 1, enabled: false, allowedWorkflows: [], invited: [], askBeforeEach: true, dailyLimitPerPerson: 2, displayName: '', everyone: { enabled: false, perPerson: 2, total: 20 } })
  const status = await f.host.status()
  assert.equal(status.idle, true); assert.deepEqual([status.offering, status.offers, status.ownOffering], [[], [], []])
  assert.equal(status.network.connected, false); assert.match(status.network.note, /Not connected/)
  // A built-in workflow that was ticked in an earlier Velorn is not offered any more, sharing on or off.
  await f.host.updateSettings({ enabled: true, allowedWorkflows: ['ltx23-i2v', 'h3-t2i'] })
  assert.deepEqual([(await f.host.status()).offering, f.state.asked], [[], []], 'nothing is offered and ComfyUI is not even asked about them')
})

test('choices are saved privately and survive a restart; a damaged file never switches sharing on', async t => {
  const f = await fixture(t)
  await f.host.updateSettings({ enabled: true, allowedWorkflows: ['ltx23-i2v'], invited: [' Friend@Example.com ', 'friend@example.com', 'other@velorn.test'], askBeforeEach: false, dailyLimitPerPerson: 4, displayName: '', everyone: { enabled: false, perPerson: 2, total: 20 } })
  const file = path.join(f.dir, 'private', 'gpu-share.json')
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  const again = f.make()
  assert.deepEqual(await again.getSettings(), { version: 1, enabled: true, allowedWorkflows: ['ltx23-i2v'], invited: ['friend@example.com', 'other@velorn.test'], askBeforeEach: false, dailyLimitPerPerson: 4, displayName: '', everyone: { enabled: false, perPerson: 2, total: 20 } })
  assert.deepEqual((await fs.readdir(path.join(f.dir, 'private'))), ['gpu-share.json'], 'no temporary file is left behind')
  await fs.writeFile(file, '{"enabled":true,"allowedWorkflows":["ltx23-i2v"],"somethingElse":1}')
  const damaged = await f.make().getSettings()
  assert.equal(damaged.enabled, false); assert.equal(damaged.unreadable, true)
  await fs.writeFile(file, 'not json')
  assert.equal((await f.make().getSettings()).enabled, false)
})

test('only known workflows, real emails and sensible limits are accepted', async t => {
  const f = await fixture(t)
  for (const patch of [{ allowedWorkflows: ['my-own-workflow'] }, { allowedWorkflows: 'ltx23-i2v' }, { invited: ['not an email'] }, { invited: ['a@b'] }, { invited: ['x@y.com<script>'] },
    { invited: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`) }, { enabled: 'yes' }, { askBeforeEach: 1 }, { dailyLimitPerPerson: 0 }, { dailyLimitPerPerson: 11 }, { dailyLimitPerPerson: 2.5 },
    { version: 2 }, { somethingElse: true }, null, 'on', []]) {
    await assert.rejects(f.host.updateSettings(patch), { code: 'GPU_SHARE_SETTINGS_INVALID' }, JSON.stringify(patch))
  }
  assert.deepEqual(await f.host.getSettings(), { ...DEFAULTS, allowedWorkflows: [], invited: [] }, 'a refused change changes nothing')
  assert.throws(() => normalizeSettings({ enabled: true, allowedWorkflows: ['__proto__'] }), { code: 'GPU_SHARE_SETTINGS_INVALID' })
})

test('this computer says why it is not free', async t => {
  const busy = await fixture(t, { queue: { queue_running: [[1, 'x']], queue_pending: [] }, exportBusy: true })
  const status = await busy.host.status()
  assert.equal(status.idle, false); assert.deepEqual(status.reasons, ['An export is running.', 'ComfyUI is working on something.'])
  const down = await fixture(t, { comfyDown: true })
  const off = await down.host.status()
  assert.deepEqual([off.idle, off.comfyRunning, off.reasons, off.gpu], [false, false, ['ComfyUI is not running.'], null])
  assert.deepEqual(down.state.asked, [], 'ComfyUI is not asked about workflows while it is not running')
})

test('only the main Velorn window can read or change the choices', async t => {
  const f = await fixture(t)
  const handlers = new Map(), contents = { mainFrame: {} }, window = { isDestroyed: () => false, webContents: contents }
  const ipc = registerGpuShareIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, getMainWindow: () => window, host: f.host })
  const ours = { sender: contents, senderFrame: contents.mainFrame }
  assert.equal((await handlers.get('gpu-share:status')(ours)).success, true)
  assert.equal((await handlers.get('gpu-share:update')(ours, { enabled: true })).settings.enabled, true)
  assert.deepEqual(await handlers.get('gpu-share:update')(ours, { allowedWorkflows: ['nope'] }), { success: false, error: 'Only workflows on the Velorn network list can be shared.' })
  for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: {} }, {}]) {
    assert.equal((await handlers.get('gpu-share:status')(event)).success, false)
    assert.equal((await handlers.get('gpu-share:update')(event, { enabled: false })).success, false)
  }
  assert.equal((await f.host.getSettings()).enabled, true, 'a refused caller changed nothing')
  ipc.dispose(); assert.equal(handlers.size, 0)
})

test('the graphics card is named with the size it is sold as', async t => {
  const big = await fixture(t)
  assert.deepEqual((await big.host.status()).gpu, { name: 'NVIDIA GeForce RTX 5090', memoryGb: 32 })
  // A "16 GB" card reports a little under 16, a "24 GB" card a little under 24.
  const small = await fixture(t, { devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4060 Ti : native', type: 'cuda', vram_total: 16.7e9 }] })
  assert.deepEqual((await small.host.status()).gpu, { name: 'NVIDIA GeForce RTX 4060 Ti', memoryGb: 16 })
  const mid = await fixture(t, { devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4090 : native', vram_total: 25.2e9 }] })
  assert.equal((await mid.host.status()).gpu.memoryGb, 24)
  assert.equal((await (await fixture(t, { comfyDown: true })).host.status()).gpu, null)
})

test('the maker name is the owner\'s own short text, and their shared own workflows are what is offered', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-gpu-share-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const own = { offered: async () => [{ id: 'own-0123456789abcdef', name: 'Cats', shape: 'picture-edit', kind: 'image', needsImage: true }, { id: 'own-fedcba9876543210', name: 'Broken', shape: 'text-to-picture', kind: 'image', needsImage: false }] }
  const host = createGpuShareHost({ settingsPath: path.join(dir, 'gpu-share.json'), getEndpoint: async () => 'http://127.0.0.1:8188', getOwn: () => own,
    runner: { capability: async id => ({ workflowId: id, ok: id !== 'own-fedcba9876543210' }) },
    fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : { devices: [] }), { status: 200 }) })
  assert.equal((await host.updateSettings({ displayName: '  Sam   <script>\n the  maker ' })).displayName, 'Sam script the maker')
  assert.equal((await host.updateSettings({ displayName: 'x'.repeat(90) })).displayName.length, 40)
  await assert.rejects(host.updateSettings({ displayName: 7 }), { code: 'GPU_SHARE_SETTINGS_INVALID' })
  // Sharing off: nothing of the owner's own is offered either.
  assert.deepEqual([(await host.status()).offering, (await host.status()).ownOffering], [[], []])
  await host.updateSettings({ enabled: true, allowedWorkflows: ['ltx23-i2v'] })
  const status = await host.status()
  assert.deepEqual(status.ownOffering, [{ id: 'own-0123456789abcdef', name: 'Cats', shape: 'picture-edit' }], 'one that no longer runs here is left out')
  assert.deepEqual(status.offering, ['own-0123456789abcdef'], 'the built-in one that is still ticked is not')
})

test('open to everyone is off by default, and its limits are checked like the rest', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.host.getSettings()).everyone, { enabled: false, perPerson: 2, total: 20 })
  assert.deepEqual((await f.host.updateSettings({ everyone: { enabled: true, perPerson: 3, total: 50 } })).everyone, { enabled: true, perPerson: 3, total: 50 })
  for (const bad of [{ enabled: 'yes', perPerson: 2, total: 20 }, { enabled: true, perPerson: 0, total: 20 }, { enabled: true, perPerson: 2, total: 5000 }, { enabled: true, perPerson: 2, total: 20, to: 'anyone' }, 'on', null])
    await assert.rejects(f.host.updateSettings({ everyone: bad }), { code: 'GPU_SHARE_SETTINGS_INVALID' }, JSON.stringify(bad))
  assert.deepEqual((await f.make().getSettings()).everyone, { enabled: true, perPerson: 3, total: 50 }, 'kept across a restart')
})
