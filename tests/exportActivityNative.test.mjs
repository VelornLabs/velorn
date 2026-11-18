import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ExportJobRegistry } = require('../electron/exportJobRegistry.cjs')
const { resolveExportWorkerUrl } = require('../electron/exportWorkerUrl.cjs')
const mainSource = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
const workerSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('export:runInWorker'"), mainSource.indexOf('const formatFilterNumber ='))
const cancelSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('export:cancel',"), mainSource.indexOf("ipcMain.handle('export:mixAudio'"))
const broadcastSource = mainSource.slice(mainSource.indexOf('function broadcastExportActivity('), mainSource.indexOf('async function performMcpRendererAction('))

function harness({ failure, reserve, cloudSetupFailure = false } = {}) {
  const handlers = new Map(), windows = [], forwarded = [], released = [], cloudSetupChanges = []
  const ipcMain = new EventEmitter()
  ipcMain.handle = (name, fn) => handlers.set(name, fn)
  class FakeWindow extends EventEmitter {
    constructor() {
      super()
      if (failure === 'constructor') throw new Error('Synthetic constructor failure')
      this.destroyed = false
      this.messages = []
      this.webContents = new EventEmitter()
      this.webContents.id = 50 + windows.length
      this.webContents.send = (...args) => this.messages.push(args)
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    close() { this.destroyed = true; this.emit('closed') }
    async loadURL(url) { this.url = url; if (failure === 'load') throw new Error('Synthetic load failure') }
  }
  const mainWindow = { isDestroyed: () => false,
    webContents: { id: 7, getURL: () => 'http://localhost:5198/', send: (...args) => forwarded.push(args) } }
  let context
  const registry = new ExportJobRegistry({ onChange: activity => context.broadcastExportActivity(activity) })
  context = vm.createContext({ ipcMain, mainWindow, exportJobs: registry, exportWorkerWindow: null,
    comfyCloudSetup: { exportChanged: () => {
      cloudSetupChanges.push(Boolean(registry.activeId))
      if (cloudSetupFailure) throw new Error('Synthetic cloud setup notification failure')
    } },
    BrowserWindow: FakeWindow, crypto, path, isDev: true, __dirname: '/synthetic/electron',
    resolveExportWorkerUrl: options => { if (failure === 'url') throw new Error('Synthetic URL failure'); return resolveExportWorkerUrl(options) },
    inspectExportFileNative() {}, ffprobePath: '/synthetic/ffprobe',
    reserveExportOutputs: reserve || (async () => { if (failure === 'reservation') throw new Error('Synthetic reservation failure'); return [] }),
    prepareExportOutputDirectories: async () => {},
    releaseEmptyExportOutputs: async paths => released.push(paths),
    fs: { lstat: async () => { const error = new Error('Missing'); error.code = 'ENOENT'; throw error } },
    fsSync: { appendFileSync() {} }, app: { getPath: () => '/synthetic' }, beginCappedLogSession: () => true,
    abortGifExportsForOwner() {}, console: { error() {}, warn() {} }, Date,
  })
  vm.runInContext(broadcastSource + workerSource + cancelSource, context)
  const call = (name, args, sender = mainWindow.webContents) => handlers.get(name)({ sender }, args)
  const run = (jobId, owner = 'ui') => call('export:runInWorker', {
    jobId, owner, projectPath: '/synthetic/project', outputPath: `/synthetic/${jobId}.mp4`, options: {},
  })
  const activity = () => forwarded.filter(entry => entry[0] === 'export:activity').map(entry => entry[1])
  const emit = (channel, data, window = windows.at(-1)) => ipcMain.emit(channel, { sender: window.webContents }, data)
  return { registry, call, run, windows, forwarded, activity, emit, mainWindow, released, cloudSetupChanges }
}

test('registry activity revisions are monotonic and active snapshots are isolated clones', () => {
  const events = [], jobs = new ExportJobRegistry({ onChange: value => events.push(value) })
  assert.deepEqual(jobs.activity(), { revision: 0, activeJob: null })
  jobs.begin({ jobId: 'one' })
  const progress = { progress: 42, stage: 'render' }
  jobs.progress('one', progress)
  progress.progress = -1
  events.at(-1).activeJob.progress.stage = 'changed externally'
  assert.equal(jobs.activity().activeJob.progress.progress, 42)
  assert.equal(jobs.activity().activeJob.progress.stage, 'render')
  jobs.requestCancelActive()
  jobs.finish('one', { error: 'Export cancelled' })
  assert.deepEqual(events.map(event => event.revision), [1, 2, 3, 4])
  assert.equal(events.at(-1).activeJob, null)
  assert.equal(jobs.list()[0].status, 'cancelled')
  assert.deepEqual(Object.keys(events.at(-1)), ['revision', 'activeJob'])
})

test('late events and duplicate cancel/finish do not publish or clear a newer active job', () => {
  const jobs = new ExportJobRegistry()
  jobs.begin({ jobId: 'old' }); jobs.finish('old')
  jobs.begin({ jobId: 'new' })
  const revision = jobs.activity().revision
  assert.equal(jobs.progress('old', { progress: 99 }), false)
  assert.equal(jobs.finish('old', { error: 'late failure' }), false)
  assert.equal(jobs.activity().revision, revision)
  assert.equal(jobs.activity().activeJob.jobId, 'new')
  jobs.requestCancelActive()
  const cancelRevision = jobs.activity().revision
  jobs.requestCancelActive()
  assert.equal(jobs.activity().revision, cancelRevision)
})

test('notification failure cannot strand running or terminal native state', () => {
  const jobs = new ExportJobRegistry({ onChange: () => { throw new Error('Renderer gone') } })
  assert.doesNotThrow(() => jobs.begin({ jobId: 'one' }))
  assert.doesNotThrow(() => jobs.finish('one', { error: 'crashed' }))
  assert.deepEqual(jobs.activity(), { revision: 2, activeJob: null })
  assert.equal(jobs.get('one').status, 'failed')
})

test('native activity broadcasts begin, progress, cancelling and completion and getter rehydrates', async () => {
  const h = harness()
  await h.run('first')
  assert.equal(h.activity()[0].activeJob.jobId, 'first')
  h.emit('export:progress', { progress: 25 })
  const current = h.call('export:getActivity')
  assert.deepEqual(current, h.activity().at(-1))
  assert.equal(current.activeJob.progress.progress, 25)
  await h.call('export:cancel')
  assert.equal(h.activity().at(-1).activeJob.status, 'cancelling')
  h.emit('export:error', 'Export cancelled')
  assert.equal(h.activity().at(-1).activeJob, null)
  assert.equal(h.call('export:getActivity').activeJob, null)
  assert.deepEqual(h.activity().map(value => value.revision), [1, 2, 3, 4])
  assert.deepEqual(h.cloudSetupChanges, [true, true, true, false], 'Credential setup is notified of each native export transition')
  await h.run('second')
  const latest = h.call('export:getActivity')
  h.emit('export:error', 'Late error', h.windows[0])
  assert.deepEqual(h.call('export:getActivity'), latest)
  h.emit('export:complete', { outputPath: '/synthetic/second.mp4' })
  assert.equal(h.activity().at(-1).activeJob, null)
  assert.equal(h.registry.get('second').status, 'completed')
})

test('optional cloud setup notification failure cannot hide native export activity', async () => {
  const h = harness({ cloudSetupFailure: true })
  await h.run('notification-failure')
  assert.equal(h.activity().at(-1).activeJob.jobId, 'notification-failure')
  h.emit('export:complete', {})
  assert.equal(h.activity().at(-1).activeJob, null)
  assert.equal(h.registry.get('notification-failure').status, 'completed')
})

test('main editor may cancel UI or MCP exports before worker readiness; MCP job ownership stays strict', async () => {
  for (const owner of ['ui', 'mcp']) {
    const h = harness()
    await h.run(owner, owner)
    await assert.rejects(h.call('export:cancel', undefined, { id: 99 }), /Only the Velorn editor/)
    assert.equal(h.registry.get(owner).status, 'running')
    assert.equal((await h.call('export:cancel')).cancelled, true)
    h.emit('export:workerReady')
    assert.deepEqual(h.windows[0].messages.slice(-2).map(entry => entry[0]), ['export:job', 'export:cancel-job'])
    if (owner === 'ui') assert.throws(() => h.call('export:cancelJob', { jobId: owner }), /not owned/)
    else assert.throws(() => h.call('export:cancelJob', { jobId: owner }, { id: 99 }), /not owned/)
    h.emit('export:error', 'Export cancelled')
    assert.equal((await h.call('export:cancel')).cancelled, false)
  }
})

test('early UI cancellation while reserving output is retained before any worker exists', async () => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const reserved = new Promise(resolve => { entered = resolve })
  const h = harness({ reserve: async () => { entered(); return gate } })
  const pending = h.run('startup', 'mcp')
  await reserved
  assert.equal(h.windows.length, 0)
  assert.equal(h.activity().at(-1).activeJob.status, 'running')
  assert.equal((await h.call('export:cancel')).cancelled, true)
  assert.equal((await h.run('competing', 'ui')).success, false)
  release([])
  await pending
  h.emit('export:workerReady')
  assert.deepEqual(h.windows[0].messages.slice(-2).map(entry => entry[0]), ['export:job', 'export:cancel-job'])
  h.emit('export:error', 'Export cancelled')
  assert.equal(h.activity().at(-1).activeJob, null)
})

test('all native startup failures, worker crashes and unexpected closes release export activity', async () => {
  for (const failure of ['reservation', 'url', 'constructor', 'load', 'crash', 'close']) {
    const h = harness({ failure })
    if (failure === 'reservation') assert.equal((await h.run(failure, 'mcp')).code, 'EXPORT_NOT_STARTED')
    else if (['url', 'constructor', 'load'].includes(failure)) await assert.rejects(h.run(failure, 'mcp'), /Synthetic/)
    else {
      await h.run(failure)
      if (failure === 'crash') h.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
      else h.windows[0].close()
    }
    assert.equal(h.registry.get(failure).status, 'failed', failure)
    assert.equal(h.call('export:getActivity').activeJob, null, failure)
    assert.equal(h.activity()[0].activeJob.jobId, failure)
    assert.equal(h.activity().at(-1).activeJob, null, failure)
    assert.deepEqual(h.activity().map(value => value.revision), [1, 2], failure)
  }
})

test('foreign worker messages cannot change the authoritative activity state', async () => {
  const h = harness()
  await h.run('real')
  const before = h.call('export:getActivity')
  const fake = { webContents: { id: 300 } }
  h.emit('export:progress', { progress: 100 }, fake)
  h.emit('export:complete', {}, fake)
  h.emit('export:error', 'not real', fake)
  assert.deepEqual(h.call('export:getActivity'), before)
  h.emit('export:complete', {})
})

test('main renderer teardown cannot prevent worker cleanup and later exports', async () => {
  const h = harness()
  await h.run('first')
  h.mainWindow.webContents.send = () => { throw new Error('Web contents destroyed') }
  assert.doesNotThrow(() => h.emit('export:complete', {}))
  assert.equal(h.registry.activeId, null)
  assert.equal(h.windows[0].isDestroyed(), true)
  assert.equal((await h.run('next')).jobId, 'next')
  h.emit('export:error', 'Synthetic failure')
  assert.equal(h.registry.activeId, null)
})

test('preload activity subscription is removable and getter invokes the narrow IPC', async () => {
  const exposed = {}, calls = [], ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = async (...args) => { calls.push(args); return { revision: 3, activeJob: null } }
  vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } } }),
    process: { platform: 'linux' },
  })
  const messages = [], api = exposed.electronAPI
  const off = api.onExportActivity(value => messages.push(value))
  const activity = { revision: 2, activeJob: { jobId: 'test' } }
  ipcRenderer.emit('export:activity', {}, activity)
  off()
  ipcRenderer.emit('export:activity', {}, { revision: 3, activeJob: null })
  assert.deepEqual(messages, [activity])
  assert.equal(ipcRenderer.listenerCount('export:activity'), 0)
  assert.equal((await api.getExportActivity()).revision, 3)
  assert.deepEqual(calls, [['export:getActivity']])
})
