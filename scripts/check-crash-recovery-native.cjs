// Isolated hidden-window crash test. Never attaches to the user's Velorn app.
const { app, BrowserWindow, crashReporter } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createCrashRecovery } = require('../electron/crashRecovery.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-crash-native-'))
app.setPath('userData', root)
app.setPath('crashDumps', path.join(root, 'dumps'))
let prompts = 0, loads = 0
const recovery = createCrashRecovery({ app, crashReporter,
  dialog: { showMessageBox: async () => { prompts++; return { response: 0 } } },
  shell: { openPath: async () => {} } })
const timeout = setTimeout(() => { console.error('Native crash test timed out', root); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  assert.equal(crashReporter.getUploadToServer(), false)
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  recovery.attach(window)
  window.webContents.on('did-finish-load', () => {
    loads++
    if (loads === 1) setTimeout(() => window.webContents.forcefullyCrashRenderer(), 50)
    else {
      try {
        assert.equal(prompts, 1)
        const records = JSON.parse(fs.readFileSync(path.join(recovery.directory, 'latest-events.json')))
        assert.ok(records.some(record => record.kind === 'main-renderer-gone' && record.reason === 'crashed'))
        console.log('PASS: real renderer crash, local-only reporter, one prompt and successful reload.', root)
        clearTimeout(timeout); app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    }
  })
  await window.loadURL('data:text/html,<h1>Isolated recovery fixture</h1>')
}).catch(error => { console.error(error); app.exit(1) })
