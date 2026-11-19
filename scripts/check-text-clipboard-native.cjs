// Real sandboxed Electron/preload/IPC with in-memory clipboard and menu sinks.
// Never reads or changes the user's OS clipboard; no app, project or provider.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const root = path.resolve(__dirname, '..')

async function launch() {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.env.VELORN_TEST_ELECTRON_BINARY || require('electron'), [__filename],
    { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => child.kill(), 25000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer)
  if (code !== 0) throw new Error(`Clipboard native fixture exited ${code}`)
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { registerTextClipboardIpc } = require('../electron/textClipboard.cjs')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-text-clipboard-native-'))
  app.setPath('userData', path.join(profile, 'profile'))
  app.commandLine.appendSwitch('disable-background-networking')
  const windows = [], writes = [], menus = [], groups = []
  let main, server, shown = false
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  try {
    await app.whenReady()
    server = require('node:http').createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'none'" })
      response.end('<!doctype html><html><body><p>Velorn clipboard fixture</p>' + (request.url === '/' ? '<iframe src="/child"></iframe>' : '') + '</body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const create = () => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'),
        sandbox: true, nodeIntegration: false, contextIsolation: true, partition: `clipboard-fixture-${windows.length}` } })
      windows.push(window)
      window.on('show', () => { shown = true })
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }))
      return window
    }
    main = create()
    registerTextClipboardIpc({ ipcMain, getMainWindow: () => main, clipboard: { writeText: text => writes.push(text) },
      Menu: { buildFromTemplate: template => { const entry = { template, popup: options => { entry.options = options } }; menus.push(entry); return entry } } })
    await main.loadURL(origin + '/')
    const run = (script, gesture = false, window = main) => window.webContents.executeJavaScript(script, gesture)
    assert.equal(await run('typeof require'), 'undefined')
    assert.equal(await run('typeof window.electronAPI.readClipboardText'), 'undefined')
    assert.match(await run('window.electronAPI.writeClipboardText("not a gesture").then(()=>"unexpected", error=>error.message)'), /user gesture/)
    assert.deepEqual(writes, [])
    pass('Sandboxed real preload is write-only and refuses background calls without a gesture')
    const text = 'Velorn reply\n**Markdown**\nC:\\clips\\shot 02.mov\n日本語 🦋'
    assert.deepEqual(await run(`window.electronAPI.writeClipboardText(${JSON.stringify(text)})`, true), { success: true })
    assert.deepEqual(writes, [text])
    pass('Renderer user activation crosses the real isolated preload and writes exact UTF-8 text into the injected sink')
    assert.deepEqual(await run('window.electronAPI.showTextCopyMenu("selected reply")', true), { success: true })
    assert.equal(menus.length, 1)
    assert.equal(menus[0].options.window, main)
    assert.equal(writes.length, 1)
    menus[0].template[0].click()
    assert.deepEqual(writes, [text, 'selected reply'])
    pass('Right-click bridge captures selected text and only the native Copy callback writes')
    const foreign = create(); await foreign.loadURL(origin + '/foreign')
    assert.match(await run('window.electronAPI.writeClipboardText("foreign").then(()=>"unexpected", error=>error.message)', true, foreign), /main frame/)
    assert.equal(writes.length, 2)
    const frame = main.webContents.mainFrame.frames[0]
    assert.equal(await frame.executeJavaScript('typeof window.electronAPI'), 'undefined')
    pass('Foreign renderer rejects at the real IPC boundary; untrusted child frame has no clipboard bridge')
    assert.equal(shown, false)
    const result = { success: true, groups, profile, osClipboardAccessed: false, windowNeverShown: true,
      runtime: { platform: process.platform, electron: process.versions.electron } }
    fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(result, null, 2))
    console.log('TEXT_CLIPBOARD_NATIVE_RESULT ' + JSON.stringify(result))
  } finally {
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    server?.close()
  }
}

if (process.versions.electron) runElectron().then(() => require('electron').app.exit(0), error => {
  console.error(error); require('electron').app.exit(1)
})
else launch().catch(error => { console.error(error); process.exitCode = 1 })
