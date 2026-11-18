// Standalone Electron host: never loads the app's main/preload or user data.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createViewerPresentation, registerViewerPresentationIpc } = require('../../electron/viewerPresentation.cjs')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-viewer-presentation-profile-')))
let window, controller, failNextEntry = false, holdNextEntry = false
const heldEntries = [], events = []
const record = (event, detail = {}) => {
  events.push({ event, ...detail })
  if (events.length > 80) events.shift()
}
const snapshot = () => ({
  platform: process.platform, state: controller.getState(), fullscreen: window.isFullScreen(),
  simpleFullscreen: window.isSimpleFullScreen(), maximized: window.isMaximized(), bounds: window.getBounds(),
  normalBounds: window.getNormalBounds(),
  persistent: controller.getPersistentWindowState(), events: [...events], heldEntries: heldEntries.length,
})
app.whenReady().then(() => {
  window = new BrowserWindow({ show: false, width: 1280, height: 850,
    titleBarStyle: 'hiddenInset', frame: process.platform === 'darwin',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      disableHtmlFullscreenWindowResize: true, preload: path.join(__dirname, 'viewer-presentation-preload.cjs') } })
  controller = createViewerPresentation({ window,
    onChange(state) { record('state', state); window.webContents.send('viewer:presentationChanged', state) },
    onRestored() { record('restored') },
    onError(error) { record('controller-error', { message: error.message }) },
  })
  // Failure/late-ACK controls wrap the real controller, not the UI behavior.
  registerViewerPresentationIpc(ipcMain, () => ({ ...controller, async setEnabled(enabled, reason) {
    if (enabled && failNextEntry) { failNextEntry = false; throw new Error('Synthetic native presentation failure') }
    const shouldHold = enabled && holdNextEntry
    if (shouldHold) holdNextEntry = false
    const state = await controller.setEnabled(enabled, reason)
    if (shouldHold) return new Promise(resolve => heldEntries.push(() => resolve(state)))
    return state
  } }))
  for (const name of ['enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen']) {
    const target = name.includes('html') ? window.webContents : window
    target.on(name, () => record(name))
  }
  ipcMain.handle('viewer-fixture:command', async (event, request = {}) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Foreign fixture sender')
    if (request.action === 'show') window.show()
    else if (request.action === 'fail-next-entry') failNextEntry = true
    else if (request.action === 'hold-next-entry') holdNextEntry = true
    else if (request.action === 'release-entries') heldEntries.splice(0).forEach(resolve => resolve())
    else if (request.action === 'exit-native') await controller.setEnabled(false, 'fixture-native-exit')
    else if (request.action !== 'snapshot') throw new Error('Unknown fixture command')
    return snapshot()
  })
  window.loadURL('about:blank')
}).catch(error => { console.error(error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
