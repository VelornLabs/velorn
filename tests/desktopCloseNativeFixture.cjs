'use strict'
// Synthetic windows only. The runner supplies the exact packaged module/preload.
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { EventEmitter } = require('node:events'), fs = require('node:fs'), http = require('node:http')
const archive = '/candidate/source/release/linux-unpacked/resources/app.asar'
const { createDesktopClose } = require(archive + '/electron/desktopClose.cjs')
app.setPath('userData', '/state/close-native-profile')
ipcMain.on('engine-candidate:info', event => { event.returnValue = null })
app.on('window-all-closed', () => {})
let scenario, serial = 0
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html')
  if (req.url === '/child') return res.end(`<button id="activate">Edit workflow</button><script>addEventListener('beforeunload',event=>{ event.preventDefault(); return true })</script>`)
  res.end(`<button id="close">Close Velorn</button><input id="project" value="unsaved edit"><iframe id="comfy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" src="/child"></iframe><script>
    window.electronAPI.onPrepareClose(async()=>{
      document.body.dataset.saving='yes';
      const result=await window.electronAPI.readFile('synthetic-save',document.querySelector('#project').value);
      document.body.dataset.saving='no'; return result;
    });
    window.electronAPI.onCloseCancelled(()=>{document.body.dataset.cancelled='yes'});
    document.querySelector('#close').onclick=()=>window.electronAPI.closeWindow();
  </script>`)
})
ipcMain.handle('window:close', () => { scenario.win.close(); return true })
// This IPC name is already exposed by the real preload; fixture handler only.
ipcMain.handle('fs:readFile', async (_event, _file, text) => {
  const s = scenario; s.records.push('save-start')
  if (s.options.hangSave) return new Promise(() => {})
  await new Promise(resolve => setTimeout(resolve, s.options.saveDelay || 15))
  if (s.options.saveFail) { s.records.push('save-failed'); return false }
  fs.writeFileSync(`/state/saved-project-${s.id}.txt`, text || 'saved synthetic edit')
  s.records.push('saved'); return true
})
globalThis.closeTest = {
  async create(options) {
    const id = ++serial, records = [], facade = new EventEmitter(), nativeIpc = new EventEmitter()
    const win = new BrowserWindow({ width: 800, height: 500, webPreferences: { preload: archive + '/electron/preload.js', contextIsolation: true, nodeIntegration: false } })
    const s = scenario = { id, win, options, records, destroyed: false, cleanupCount: 0 }
    facade.quit = () => { const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }; facade.emit('before-quit', e); if (!e.defaultPrevented) { records.push('quit'); facade.emit('will-quit') } }
    const forward = (...args) => nativeIpc.emit('window:closePrepared', ...args)
    ipcMain.on('window:closePrepared', forward)
    const coordinator = createDesktopClose({ app: facade, ipcMain: nativeIpc,
      dialog: {
        async showMessageBox(...args) { const spec = args.at(-1); records.push('dialog:' + spec.title); return { response: s.options.launcherChoice ?? 1 } },
        showMessageBoxSync(_win, spec) { records.push('veto:' + spec.defaultId); return s.options.allowUnsaved ? 1 : 0 },
      }, getWindow: () => s.destroyed ? null : win, getOwnedLauncher: () => s.options.owned,
      stopOnQuit: () => s.options.stopOnQuit,
      async detach() { s.cleanupCount++; records.push('detach'); await new Promise(resolve => setTimeout(resolve, s.options.cleanupDelay || 0)); return { detached: true } },
      async shutdown() { s.cleanupCount++; records.push('stop'); return { stopped: true } },
      async flush() { records.push('flushed') }, timeoutMs: 250,
    })
    coordinator.attach(win)
    win.on('closed', () => { s.destroyed = true; records.push('closed'); ipcMain.removeListener('window:closePrepared', forward) })
    s.quit = () => facade.quit()
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
    return id
  },
  configure(options) { Object.assign(scenario.options, options) },
  close() { scenario.win.close() },
  quit() { scenario.quit() },
  state() { return { id: scenario.id, records: scenario.records, destroyed: scenario.destroyed, cleanupCount: scenario.cleanupCount } },
}
app.whenReady().then(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); globalThis.closeTest.ready = true })
