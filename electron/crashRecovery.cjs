const fs = require('node:fs')
const path = require('node:path')

function createCrashRecovery({ app, crashReporter, dialog, shell, versions = process.versions }) {
  const directory = path.join(app.getPath('userData'), 'crash-diagnostics')
  const reportPath = path.join(directory, 'latest-events.json')
  let quitting = false
  function record(kind, details = {}) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      let events = []
      try {
        if (fs.statSync(reportPath).size < 128 * 1024) events = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      } catch {}
      if (!Array.isArray(events)) events = []
      events.push({ at: new Date().toISOString(), kind, reason: String(details.reason || '').slice(0, 100),
        exitCode: details.exitCode, type: String(details.type || '').slice(0, 80),
        appVersion: app.getVersion(), electron: versions.electron, chrome: versions.chrome,
        platform: process.platform, arch: process.arch })
      fs.writeFileSync(reportPath, JSON.stringify(events.slice(-30), null, 2), { mode: 0o600 })
    } catch (error) { console.warn('[Crash diagnostics] Could not write event:', error.message) }
  }
  try {
    crashReporter.start({ productName: 'Velorn', uploadToServer: false, ignoreSystemCrashHandler: false })
  } catch (error) { record('reporter-start-failed', { reason: error.message }) }
  app.on('will-quit', () => { quitting = true })
  app.on('child-process-gone', (_event, details) => record('child-process-gone', details))
  function attach(window) {
    let pending = false
    window.webContents.on('render-process-gone', async (_event, details) => {
      record('main-renderer-gone', details)
      if (quitting || pending || window.isDestroyed() || details.reason === 'clean-exit') return
      pending = true
      try {
        const { response } = await dialog.showMessageBox(window, {
          type: 'error', title: 'Velorn needs to recover', message: 'The Velorn display process stopped.',
          detail: `Reason: ${details.reason} (exit ${details.exitCode}).\n\nReload restores the interface; reopen your saved project if needed. Changes since the last save may be lost. Running external generations may continue—inspect their status before retrying.\n\nCrash reports stay on this computer and are not uploaded. Dumps may contain sensitive in-memory data; review before sharing.\nDiagnostics: ${directory}\nCrash dumps: ${app.getPath('crashDumps')}`,
          buttons: ['Reload Velorn', 'Open diagnostics', 'Leave open'], defaultId: 0, cancelId: 2, noLink: true,
        })
        if (quitting || window.isDestroyed() || window.webContents.isDestroyed()) return
        if (response === 0) window.webContents.reload()
        else if (response === 1) await shell.openPath(directory)
      } catch (error) { record('recovery-dialog-failed', { reason: error.message }) }
      finally { pending = false }
    })
    window.on('unresponsive', () => record('main-window-unresponsive'))
  }
  return { attach, record, directory }
}
module.exports = { createCrashRecovery }
