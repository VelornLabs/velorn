import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
const require = createRequire(import.meta.url)
const { ExportJobRegistry } = require('../electron/exportJobRegistry.cjs')
const { inspectExportFileNative } = require('../electron/exportFileInspection.cjs')
const { resolveExportWorkerUrl } = require('../electron/exportWorkerUrl.cjs')
const { prepareExportOutputDirectories, reserveExportOutputs, releaseEmptyExportOutputs } = require('../electron/exportOutputReservation.cjs')
const source = await fs.readFile(new URL('../electron/main.js', import.meta.url), 'utf8')
const handlerSource = source.slice(source.indexOf("ipcMain.handle('export:runInWorker'"), source.indexOf('const formatFilterNumber ='))

function harness({ failLoad = false, failConstructor = false } = {}) {
  const handlers = new Map(), windows = [], forwarded = []
  const ipcMain = new EventEmitter()
  ipcMain.handle = (name, fn) => handlers.set(name, fn)
  const registry = new ExportJobRegistry()
  class FakeWindow extends EventEmitter {
    constructor() {
      super()
      if (failConstructor) throw new Error('Synthetic window creation failed')
      this.destroyed = false
      this.webContents = new EventEmitter()
      this.webContents.id = windows.length + 50
      this.messages = []
      this.webContents.send = (...args) => this.messages.push(args)
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    close() { this.destroyed = true; this.emit('closed') }
    async loadURL(url) { this.url = url; if (failLoad) throw new Error('Synthetic worker load failed') }
  }
  const mainWindow = { isDestroyed: () => false, webContents: { getURL: () => 'http://127.0.0.1:5757/editor', send: (...args) => forwarded.push(args) } }
  const context = vm.createContext({ ipcMain, exportJobs: registry, exportWorkerWindow: null, mainWindow,
    BrowserWindow: FakeWindow, crypto, path, isDev: true, __dirname: '/synthetic/electron',
    resolveExportWorkerUrl, inspectExportFileNative, ffprobePath: '/packaged/ffprobe',
    reserveExportOutputs: async () => [], releaseEmptyExportOutputs: async () => {},
    prepareExportOutputDirectories: async () => {},
    fs: { lstat: async () => { const error = new Error('Missing'); error.code = 'ENOENT'; throw error } },
    fsSync: { appendFileSync() {} }, app: { getPath: () => '/synthetic' }, beginCappedLogSession: () => true,
    abortGifExportsForOwner() {}, console: { error() {} }, Date,
  })
  vm.runInContext(handlerSource, context)
  const call = (name, args, senderId = 7) => handlers.get(name)({ sender: { id: senderId } }, args)
  const run = (jobId, owner = 'mcp') => call('export:runInWorker', { jobId, owner, outputPath: `/synthetic/${jobId}.mp4`, projectPath: '/synthetic/project', options: {} })
  return { call, run, windows, registry, forwarded, ipcMain, context }
}

test('native IPC worker jobs are exclusive, sequential and correlate progress/completion', async () => {
  const h = harness()
  assert.equal((await h.run('first')).jobId, 'first')
  assert.equal((await h.run('second')).success, false)
  assert.equal(h.windows[0].url, 'http://127.0.0.1:5757/?export=worker')
  const worker = h.windows[0]
  h.ipcMain.emit('export:progress', { sender: worker.webContents }, { progress: 20 })
  assert.equal(h.registry.get('first').progress.progress, 20)
  h.ipcMain.emit('export:complete', { sender: worker.webContents }, { outputPath: '/synthetic/first.mp4' })
  assert.equal(h.registry.get('first').status, 'completed')
  assert.equal((await h.run('second')).jobId, 'second')
  h.ipcMain.emit('export:error', { sender: worker.webContents }, 'Late error from old worker')
  assert.equal(h.registry.activeId, 'second')
  assert.equal(h.registry.get('first').status, 'completed')
  h.ipcMain.emit('export:error', { sender: h.windows[1].webContents }, 'Synthetic encoder failure')
  assert.equal(h.registry.get('second').status, 'failed')
  assert.equal(h.registry.activeId, null)
  assert.ok(h.forwarded.every(message => message[2]?.jobId))
})

test('native apply prepares actual custom destination parents before reserving files, and never overwrites', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-export-custom-folder-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const h = harness()
  Object.assign(h.context, { fs, prepareExportOutputDirectories, reserveExportOutputs, releaseEmptyExportOutputs })
  const outputPath = path.join(dir, 'exports', 'nested', 'review.mp4')
  const payload = { owner: 'mcp', jobId: 'mcp-export-custom', outputPath, projectPath: dir, options: {format:'mp4'} }
  assert.equal((await h.call('export:runInWorker', payload)).jobId, payload.jobId)
  assert.equal((await fs.stat(outputPath)).size, 0, 'Exclusive placeholder exists before worker rendering')
  await fs.writeFile(outputPath, 'completed synthetic render')
  h.ipcMain.emit('export:complete', {sender:h.windows[0].webContents}, {outputPath})
  const collision = await h.call('export:runInWorker', {...payload,jobId:'mcp-export-collision'})
  assert.equal(collision.code,'EXPORT_NOT_STARTED');assert.equal(collision.workerStarted,false)
  assert.equal(h.windows.length,1)
  assert.equal(await fs.readFile(outputPath,'utf8'),'completed synthetic render')
  // Existing export directories work too; PNG sequence's leaf stays unclaimed.
  const sequence = path.join(dir,'exports','frames')
  await prepareExportOutputDirectories([sequence,path.join(dir,'deliveries','final.mp4')])
  assert.equal((await fs.stat(path.join(dir,'deliveries'))).isDirectory(),true)
  await assert.rejects(fs.stat(sequence),{code:'ENOENT'})
})

test('destination preparation and reservation failures certify no worker start, then permit a fresh native job', async () => {
  for (const stage of ['prepareExportOutputDirectories','reserveExportOutputs']) {
    const h = harness()
    h.context[stage] = async () => {throw new Error('Synthetic destination permission failure')}
    const result = await h.run('mcp-export-refused')
    assert.equal(result.code,'EXPORT_NOT_STARTED');assert.equal(result.outcome,'not-started')
    assert.equal(result.workerStarted,false);assert.equal(result.phase,'destination')
    assert.equal(h.windows.length,0);assert.equal(h.registry.activeId,null)
    assert.equal(h.registry.get('mcp-export-refused').status,'failed')
    h.context[stage] = async () => []
    assert.equal((await h.run('mcp-export-repaired')).jobId,'mcp-export-repaired')
  }
})

test('native startup, renderer crash, and premature close all become durable failed jobs', async () => {
  for (const scenario of ['constructor', 'load', 'crash', 'close']) {
    const h = harness({ failConstructor: scenario === 'constructor', failLoad: scenario === 'load' })
    if (['constructor', 'load'].includes(scenario)) await assert.rejects(h.run(scenario), /Synthetic/)
    else {
      await h.run(scenario)
      if (scenario === 'crash') h.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
      else h.windows[0].close()
    }
    assert.equal(h.registry.get(scenario).status, 'failed', scenario)
    assert.equal(h.registry.activeId, null, scenario)
  }
})

test('native cancellation checks exact MCP sender ownership and replays early cancellation after ready', async () => {
  const h = harness()
  await h.run('owned')
  assert.throws(() => h.call('export:cancelJob', { jobId: 'owned' }, 8), /not owned/)
  assert.equal(h.call('export:cancelJob', { jobId: 'owned' }).cancelRequested, true)
  h.ipcMain.emit('export:workerReady', { sender: h.windows[0].webContents })
  assert.deepEqual(h.windows[0].messages.slice(-2).map(message => message[0]), ['export:job', 'export:cancel-job'])
  h.ipcMain.emit('export:error', { sender: h.windows[0].webContents }, 'Export cancelled')
  assert.equal(h.registry.get('owned').status, 'cancelled')
  await h.run('ui-job', 'ui')
  assert.throws(() => h.call('export:cancelJob', { jobId: 'ui-job' }), /not owned/)
  assert.equal(h.call('export:getJobs').jobs[0].owner, 'ui')
})

test('dev worker URL follows only loopback app origins, packaged paths use encoded file URL', () => {
  assert.equal(resolveExportWorkerUrl({ isDev: true, mainUrl: 'http://localhost:5757/?foo=1#test' }), 'http://localhost:5757/?export=worker')
  assert.equal(resolveExportWorkerUrl({ isDev: true, mainUrl: 'https://example.com' }), 'http://127.0.0.1:5173/?export=worker')
  assert.equal(resolveExportWorkerUrl({ isDev: true, mainUrl: 'http://localhost.evil.test:5757' }), 'http://127.0.0.1:5173/?export=worker')
  assert.match(resolveExportWorkerUrl({ isDev: false, electronDirectory: '/a folder/app/electron' }), /^file:\/\/\/a%20folder\/app\/dist\/index.html\?export=worker$/)
})

test('actual bundled ffprobe reads an actual synthetic short export without PATH', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-native-export-qc-'))
  const outputPath = path.join(dir, 'synthetic.mp4')
  const ffmpeg = require('ffmpeg-static')
  const probeModule = require('@derhuerst/ffprobe-static')
  const ffprobePath = typeof probeModule === 'string' ? probeModule : probeModule.path
  try {
    await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.5', '-c:v', 'mpeg4', '-c:a', 'aac', outputPath], { timeout: 15000 })
    const result = await inspectExportFileNative({ filePath: outputPath, width: 160, height: 90, fps: 24, durationSeconds: 0.5, includeAudio: true }, { ffprobePath })
    assert.equal(result.ready, true, JSON.stringify(result))
    assert.equal(result.ffprobe.video.codec, 'mpeg4')
    assert.equal(result.ffprobe.audio[0].codec, 'aac')
    assert.equal(result.ffprobeAvailable, true)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('exclusive MCP destination reservation cannot overwrite existing files or competing renders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-export-reservation-'))
  const existing = path.join(dir, 'existing.mp4'), fresh = path.join(dir, 'fresh.mp4')
  await fs.writeFile(existing, 'user-owned content')
  try {
    await assert.rejects(reserveExportOutputs([existing]), { code: 'EEXIST' })
    assert.equal(await fs.readFile(existing, 'utf8'), 'user-owned content')
    const competition = await Promise.allSettled([reserveExportOutputs([fresh]), reserveExportOutputs([fresh])])
    assert.equal(competition.filter(result => result.status === 'fulfilled').length, 1)
    const reservations = competition.find(result => result.status === 'fulfilled').value
    await releaseEmptyExportOutputs(reservations)
    await assert.rejects(fs.stat(fresh), { code: 'ENOENT' })
    const render = await reserveExportOutputs([fresh])
    await fs.writeFile(fresh, 'partial/completed render')
    await releaseEmptyExportOutputs(render)
    assert.equal(await fs.readFile(fresh, 'utf8'), 'partial/completed render')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('failed multi-file reservation cleans only its own empty placeholders and preserves replacement files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-export-reservation-cleanup-'))
  const source = path.join(dir, 'source.mp4'), final = path.join(dir, 'final.mp4')
  await fs.writeFile(final, 'already here')
  try {
    await assert.rejects(reserveExportOutputs([source, final]), { code: 'EEXIST' })
    await assert.rejects(fs.stat(source), { code: 'ENOENT' })
    assert.equal(await fs.readFile(final, 'utf8'), 'already here')
    const reserved = await reserveExportOutputs([source])
    await fs.rename(source, `${source}.moved`)
    await fs.writeFile(source, 'replacement')
    await releaseEmptyExportOutputs(reserved)
    assert.equal(await fs.readFile(source, 'utf8'), 'replacement')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
