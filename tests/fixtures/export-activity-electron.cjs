// Real sandboxed Electron windows, production preload and actual native export
// IPC handlers. The handlers are compiled with isolated dependencies instead of
// loading all of main.js (which would start the user's MCP/ComfyUI services).
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fsSync = require('node:fs'), fs = fsSync.promises
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const electronDirectory = path.resolve(__dirname, '../../electron')
const { ExportJobRegistry } = require(path.join(electronDirectory, 'exportJobRegistry.cjs'))
const { prepareExportOutputDirectories, reserveExportOutputs, releaseEmptyExportOutputs } = require(path.join(electronDirectory, 'exportOutputReservation.cjs'))
const profile = fsSync.mkdtempSync(path.join(os.tmpdir(), 'velorn-export-activity-'))
app.setPath('userData', profile)
const source = fsSync.readFileSync(path.join(electronDirectory, 'main.js'), 'utf8')
const workerSource = source.slice(source.indexOf("ipcMain.handle('export:runInWorker'"), source.indexOf('const formatFilterNumber ='))
const cancelSource = source.slice(source.indexOf("ipcMain.handle('export:cancel',"), source.indexOf("ipcMain.handle('export:mixAudio'"))
const broadcastSource = source.slice(source.indexOf('function broadcastExportActivity('), source.indexOf('async function performMcpRendererAction('))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, message) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await fn()) return; await delay(20) }
  throw new Error(message)
}
let mainWindow, done = false
const finish = (code, value) => {
  if (done) return
  done = true
  console.log('EXPORT_ACTIVITY_RESULT ' + JSON.stringify(value))
  app.exit(code)
}
app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, preload: path.join(electronDirectory, 'preload.js'),
  } })
  const install = new Function('dependencies', `
    const { ipcMain, app, BrowserWindow, mainWindow, ExportJobRegistry, crypto, fs,
      fsSync, path, __dirname, isDev, resolveExportWorkerUrl, reserveExportOutputs,
      releaseEmptyExportOutputs, prepareExportOutputDirectories, inspectExportFileNative, ffprobePath,
      beginCappedLogSession, abortGifExportsForOwner } = dependencies
    let exportWorkerWindow = null
    const comfyCloudSetup = null
    ${broadcastSource}
    const exportJobs = new ExportJobRegistry({ onChange: broadcastExportActivity })
    ${workerSource}
    ${cancelSource}
    return { registry: exportJobs, worker: () => exportWorkerWindow }
  `)
  const native = install({ ipcMain, app, BrowserWindow, mainWindow, ExportJobRegistry,
    crypto, fs, fsSync, path, __dirname: electronDirectory, isDev: false,
    resolveExportWorkerUrl: () => pathToFileURL(path.join(__dirname, 'export-activity-worker.html')).href,
    reserveExportOutputs, releaseEmptyExportOutputs, prepareExportOutputDirectories,
    inspectExportFileNative: async () => {}, ffprobePath: '',
    beginCappedLogSession: () => true, abortGifExportsForOwner: () => {},
  })
  await mainWindow.loadURL('data:text/html,<title>Velorn export activity IPC fixture</title>')
  const evaluate = code => mainWindow.webContents.executeJavaScript(code)
  await evaluate('window.activities = []; window.offActivity = window.electronAPI.onExportActivity(value => window.activities.push(value)); true')
  const run = (jobId, owner = 'ui') => evaluate(`window.electronAPI.runExportInWorker(${JSON.stringify({ jobId, owner, outputPath: path.join(profile, `${jobId}.mp4`), options: {} })})`)
  const activity = () => evaluate('window.electronAPI.getExportActivity()')
  const ready = () => native.worker().webContents.executeJavaScript('window.fixture.sendReady()')

  assert.equal((await activity()).activeJob, null)
  await run('normal')
  assert.equal((await activity()).activeJob.jobId, 'normal')
  await ready()
  await until(async () => (await activity()).activeJob?.progress?.progress === 25, 'Real progress IPC did not arrive')
  const updates = await evaluate('window.activities')
  assert.equal(updates[0].activeJob.jobId, 'normal')
  assert.equal(updates.at(-1).activeJob.progress.progress, 25)
  assert.deepEqual(Object.keys(updates.at(-1)), ['revision', 'activeJob'])
  assert.equal(native.worker().isVisible(), false)
  assert.equal(native.worker().webContents.getLastWebPreferences().sandbox, true)
  const revision = (await activity()).revision
  await mainWindow.reload()
  await until(async () => mainWindow.webContents.isLoading() === false, 'Main renderer reload did not complete')
  assert.equal((await activity()).revision, revision)
  assert.equal((await activity()).activeJob.jobId, 'normal')
  await native.worker().webContents.executeJavaScript('window.electronAPI.sendExportComplete({ synthetic: true })')
  await until(async () => (await activity()).activeJob === null, 'Completion did not release activity')

  for (const owner of ['ui', 'mcp']) {
    await run(`cancel-${owner}`, owner)
    assert.equal((await evaluate('window.electronAPI.cancelExport()')).cancelled, true)
    assert.equal((await activity()).activeJob.status, 'cancelling')
    await ready()
    await until(async () => (await activity()).activeJob === null, 'Early cancellation did not release activity')
    assert.equal(native.registry.get(`cancel-${owner}`).status, 'cancelled')
  }

  await run('crash')
  native.worker().webContents.forcefullyCrashRenderer()
  await until(async () => (await activity()).activeJob === null, 'Crash did not release activity')
  assert.equal(native.registry.get('crash').status, 'failed')
  await run('close')
  native.worker().destroy()
  await until(async () => (await activity()).activeJob === null, 'Close did not release activity')
  assert.equal(native.registry.get('close').status, 'failed')
  await run('after-failure')
  await ready()
  await until(async () => (await activity()).activeJob?.progress?.progress === 25, 'Export did not restart after failures')
  await native.worker().webContents.executeJavaScript('window.electronAPI.sendExportComplete({ synthetic: true })')
  await until(async () => (await activity()).activeJob === null, 'Final completion did not release activity')
  assert.equal(native.registry.get('after-failure').status, 'completed')
  const outputPath = path.join(profile, 'exports', 'nested', 'review.mp4')
  const request = {jobId:'mcp-export-custom',owner:'mcp',outputPath,options:{format:'mp4'}}
  const started = await evaluate(`window.electronAPI.runExportInWorker(${JSON.stringify(request)})`)
  assert.equal(started.jobId,request.jobId)
  assert.equal((await fs.stat(outputPath)).size,0)
  await native.worker().webContents.executeJavaScript('window.electronAPI.sendExportComplete({ synthetic: true })')
  await until(async () => (await activity()).activeJob === null,'Custom path job did not finish')
  // A real existing destination refuses before startup and its structured
  // receipt, rather than an opaque Electron exception, reaches the renderer.
  const refused = await evaluate(`window.electronAPI.runExportInWorker(${JSON.stringify({...request,jobId:'mcp-export-refused'})})`)
  assert.equal(refused.success,false);assert.equal(refused.code,'EXPORT_NOT_STARTED')
  assert.equal(refused.workerStarted,false);assert.equal(refused.phase,'destination')
  assert.equal(refused.outputPath,outputPath)
  assert.equal((await activity()).activeJob,null)
  finish(0, { success: true, realElectronIpc: true, sandboxed: true, hiddenWorkers: true,
    scenarios: ['progress', 'reload-rehydration', 'completion', 'early-ui-cancel', 'early-mcp-cancel', 'crash', 'close', 'restart-after-failure', 'custom-destination-folder', 'pre-worker-refusal-receipt'], profile })
}).catch(error => finish(1, { success: false, error: error.stack }))
setTimeout(() => finish(1, { success: false, error: 'Native activity fixture timed out' }), 30000)
