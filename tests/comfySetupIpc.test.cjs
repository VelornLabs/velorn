const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
function fixture(overrides = {}) {
  const handlers = new Map(), calls = []
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const begin = main.indexOf("ipcMain.handle('comfyLauncher:detectLaunchers'")
  const end = main.indexOf("ipcMain.handle('comfyLauncher:pickLauncherScript'", begin)
  assert.ok(begin > 0 && end > begin)
  const dependencies = {
    ipcMain: { handle: (name, action) => handlers.set(name, action) },
    COMFY_ROOT_SETTING_KEY: 'comfyRootPath', LAUNCHER_SETTING_KEY: 'comfyLauncher',
    readSettingsRaw: async () => ({ comfyRootPath: '/existing/ComfyUI', comfyLauncher: { launcherScript: '/existing/start.sh' } }),
    safeCloneLauncherConfig: config => config, resolveLocalComfyPort: async () => 8189,
    sanitizeLocalComfyPort: port => Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535 ? Number(port) : null,
    comfySetup: {
      discoverInstallations: async options => { calls.push(['installations', options]); return [] },
      discoverRunning: async options => { calls.push(['running', options]); return [{ port: options.configuredPort }] },
      probeConnection: async port => { calls.push(['probe', port]); return { port, httpBase: `http://127.0.0.1:${port}` } },
    },
    ...overrides,
  }
  vm.runInNewContext(main.slice(begin, end), dependencies)
  return { calls, handlers, dependencies }
}
test('native setup IPC discovery reads configured port without exposing a remote host or changing settings', async () => {
  const f = fixture()
  const result = await f.handlers.get('comfyLauncher:discoverConnections')({}, { host: 'https://example.com', port: 9 })
  assert.equal(result.success, true); assert.equal(result.connections[0].port, 8189)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].configuredPort, 8189)
})
test('native setup IPC probes only a valid selected port and returns errors instead of false connection', async () => {
  const f = fixture(), action = f.handlers.get('comfyLauncher:probeConnection')
  for (const port of [0, 65536, 'http://example.com', 1.5]) assert.equal((await action({}, { port })).success, false)
  assert.equal(f.calls.length, 0)
  assert.equal((await action({}, { port: 8000 })).connection.port, 8000)
  f.dependencies.comfySetup.probeConnection = async () => null
  assert.match((await action({}, { port: 8000 })).error, /Open ComfyUI/)
})
test('native setup IPC returns installation modes and uses the configured paths', async () => {
  const f = fixture()
  const result = await f.handlers.get('comfyLauncher:detectLaunchers')({}, {})
  assert.equal(result.success, true)
  assert.equal(f.calls[0][1].comfyRootPath, '/existing/ComfyUI')
  assert.equal(f.calls[0][1].launcherScript, '/existing/start.sh')
  f.dependencies.comfySetup.discoverInstallations = async () => { throw new Error('Unreadable') }
  assert.equal((await f.handlers.get('comfyLauncher:detectLaunchers')({}, {})).error, 'Unreadable')
})
test('preload exposes only the matching discovery and probe IPC methods', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8')
  assert.match(preload, /discoverConnections: \(\) => ipcRenderer.invoke\('comfyLauncher:discoverConnections'\)/)
  assert.match(preload, /probeConnection: \(payload\) => ipcRenderer.invoke\('comfyLauncher:probeConnection', payload\)/)
})
