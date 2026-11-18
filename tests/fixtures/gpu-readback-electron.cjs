// A never-shown, sandboxed compositor-only renderer with a disposable profile.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-gpu-readback-'))
app.setPath('userData', profile)
let window, finished = false
const finish = (code, result) => {
  if (finished) return
  finished = true
  console.log('GPU_READBACK_RESULT ' + JSON.stringify(result))
  app.exit(code)
}
ipcMain.on('gpu-readback-result', (event, result) => {
  if (event.sender !== window?.webContents) return
  if (window.isVisible()) return finish(1, { error: 'GPU readback fixture became visible' })
  finish(result?.success ? 0 : 1, { ...result, windowNeverShown: true })
})
app.whenReady().then(() => {
  window = new BrowserWindow({ show: false, width: 160, height: 90,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: path.join(__dirname, 'gpu-readback-preload.cjs') } })
  window.on('show', () => finish(1, { error: 'GPU readback fixture was shown' }))
  window.webContents.on('render-process-gone', (_, details) => finish(1, { error: 'Renderer exited', details }))
  window.webContents.on('console-message', (_, level, message) => { if (level >= 2) console.error(message) })
  const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198')
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Fixture requires a loopback Vite server')
  window.loadURL(new URL('/tests/fixtures/gpu-readback.html', base).href).catch(error => finish(1, { error: error.message }))
  setTimeout(() => finish(1, { error: 'GPU readback fixture timed out' }), 20000)
}).catch(error => finish(1, { error: error.message }))
app.on('window-all-closed', () => app.quit())
