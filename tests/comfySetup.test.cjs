const assert = require('node:assert/strict')
const test = require('node:test')
const http = require('node:http')
const { createComfySetup, isComfySystemStats, requestLocalSystemStats } = require('../electron/comfySetup.cjs')

const stats = (names = ['Example GPU']) => ({ system: { python_version: '3.12.0' }, devices: names.map(name => ({ name })) })
function fakeFiles(entries = {}, { platform = 'linux', homeDir = '/home/test', env = {} } = {}) {
  const calls = [], accessCalls = []
  const key = value => platform === 'win32' ? value.toLowerCase() : value
  const files = new Map(Object.entries(entries).map(([name, value]) => [key(name), value]))
  const setup = createComfySetup({ platform, homeDir, env,
    stat: async name => {
      calls.push(name)
      const value = files.get(key(name))
      if (!value) throw new Error('Not found')
      return { isFile: () => value !== 'directory', isDirectory: () => value === 'directory' }
    },
    access: async (name, mode) => {
      accessCalls.push([name, mode])
      if (files.get(key(name)) === 'not-executable') throw new Error('Permission denied')
    },
    requestSystemStats: async () => { throw new Error('Filesystem discovery must not probe endpoints') },
  })
  return { setup, calls, accessCalls }
}

test('current Comfy Desktop and legacy ComfyUI Mac apps are bounded installation candidates, not service readiness', async () => {
  const h = fakeFiles({
    '/Applications/Comfy Desktop.app': 'directory', '/Applications/Comfy Desktop.app/Contents/Info.plist': 'file',
    '/Users/Tester/Applications/Comfy Desktop.app': 'directory', '/Users/Tester/Applications/Comfy Desktop.app/Contents/Info.plist': 'file',
    '/Applications/ComfyUI.app': 'directory', '/Applications/ComfyUI.app/Contents/Info.plist': 'file',
  }, { platform: 'darwin', homeDir: '/Users/Tester' })
  const found = await h.setup.discoverInstallations()
  assert.deepEqual(found.map(item => item.path), ['/Applications/Comfy Desktop.app', '/Applications/ComfyUI.app', '/Users/Tester/Applications/Comfy Desktop.app'])
  assert.ok(found.every(item => item.launcherMode === 'mac-app' && !Object.hasOwn(item, 'ready')))
  assert.equal(h.accessCalls.length, 0)
})

test('running discovery probes only configured and three known local ports, with stable deduplication', async () => {
  const calls = []
  const setup = createComfySetup({ requestSystemStats: async request => { calls.push(request); return stats() } })
  const candidates = await setup.discoverRunning({ configuredPort: '8191' })
  assert.deepEqual(candidates.map(candidate => candidate.port), [8191, 8188, 8000, 8189])
  assert.deepEqual(calls.map(call => call.httpBase), ['http://127.0.0.1:8191', 'http://127.0.0.1:8188', 'http://127.0.0.1:8000', 'http://127.0.0.1:8189'])
  calls.length = 0
  await setup.discoverRunning({ configuredPort: 8189 })
  assert.deepEqual(calls.map(call => call.port), [8189, 8188, 8000])
})

test('discovery is concurrent and ignores unavailable or non-ComfyUI endpoints', async () => {
  const pending = []
  const setup = createComfySetup({ requestSystemStats: request => new Promise((resolve, reject) => pending.push({ request, resolve, reject })) })
  const result = setup.discoverRunning({ configuredPort: 9000 })
  assert.equal(pending.length, 4)
  pending[0].reject(new Error('Offline'))
  pending[1].resolve({ message: 'Another local app' })
  pending[2].resolve(stats(['GPU one', 'GPU one', ' GPU two ']))
  pending[3].resolve(null)
  assert.deepEqual(await result, [{ port: 8000, httpBase: 'http://127.0.0.1:8000', deviceNames: ['GPU one', 'GPU two'] }])
})

test('single-port probes reject invalid inputs and never scan or accept remote URLs', async () => {
  const calls = []
  const setup = createComfySetup({ requestSystemStats: async request => { calls.push(request); return stats() } })
  for (const value of [undefined, null, false, true, 0, -1, 65536, 8188.5, Infinity, '', 'http://example.com', '8188/path', '8e3', {}]) {
    assert.equal(await setup.probeConnection(value), null)
  }
  assert.equal(calls.length, 0)
  assert.equal((await setup.probeConnection(' 8123 ')).port, 8123)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].httpBase, 'http://127.0.0.1:8123')
})

test('probe timeouts clamp to bounded values and devices are sanitized for display', async () => {
  const calls = []
  const setup = createComfySetup({ requestSystemStats: async request => { calls.push(request); return stats([' ', 23, 'x'.repeat(300), ...Array.from({ length: 25 }, (_, index) => `GPU ${index}`)]) } })
  const candidate = await setup.probeConnection(8188, 1)
  await setup.probeConnection(8188, 999999)
  await setup.probeConnection(8188, NaN)
  assert.deepEqual(calls.map(call => call.timeoutMs), [100, 5000, 1500])
  assert.equal(candidate.deviceNames.length, 16)
  assert.equal(candidate.deviceNames[0].length, 200)
})

test('HTTP 200 alone is insufficient; actual system_stats shape is required', () => {
  for (const value of [null, [], {}, { system: {}, devices: [] }, { system: { python_version: '' }, devices: [] },
    { system: { python_version: '3' } }, { system: { python_version: 3 }, devices: [] }, { system: [], devices: [] }]) {
    assert.equal(isComfySystemStats(value), false)
  }
  assert.equal(isComfySystemStats(stats([])), true)
})

test('configured root works for either inner ComfyUI directory or portable parent', async () => {
  const filename = 'C:\\Tools\\ComfyUI_windows_portable\\run_nvidia_gpu.bat'
  const h = fakeFiles({ [filename]: 'file' }, { platform: 'win32', homeDir: 'C:\\Users\\Tester' })
  for (const root of ['C:\\Tools\\ComfyUI_windows_portable', 'C:\\Tools\\ComfyUI_windows_portable\\ComfyUI']) {
    const found = await h.setup.discoverInstallations({ comfyRootPath: root })
    assert.deepEqual(found, [{ path: filename, label: 'Windows portable NVIDIA launcher', launcherMode: 'script' }])
  }
  assert.equal(h.accessCalls.length, 0, 'Windows batch scripts do not need a POSIX executable bit')
})

test('Windows discovery checks finite common portable paths and excludes Desktop executables', async () => {
  const filename = 'C:\\Users\\Tester\\Downloads\\ComfyUI_windows_portable\\run_nvidia_gpu.bat'
  const exe = 'C:\\Users\\Tester\\AppData\\Local\\Programs\\ComfyUI\\ComfyUI.exe'
  const h = fakeFiles({ [filename]: 'file', [exe]: 'file' }, { platform: 'win32', homeDir: 'C:\\Users\\Tester', env: { SystemDrive: 'C:' } })
  const result = await h.setup.discoverInstallations({ launcherScript: exe })
  assert.deepEqual(result.map(candidate => candidate.path), [filename])
  assert.equal(h.calls.includes(exe), false)
  assert.ok(h.calls.length <= 15)
  assert.equal(h.calls.some(name => name.includes('AppData')), false)
})

test('configured candidates are first and Windows paths deduplicate case-insensitively', async () => {
  const filename = 'C:\\Tools\\RUN_CPU.BAT'
  const h = fakeFiles({ [filename]: 'file' }, { platform: 'win32', homeDir: 'C:\\Users\\Tester' })
  const result = await h.setup.discoverInstallations({ comfyRootPath: 'C:\\Tools', launcherScript: filename })
  assert.deepEqual(result[0], { path: filename, label: 'Configured ComfyUI launcher', launcherMode: 'script' })
  assert.equal(h.calls.filter(value => value.toLowerCase() === filename.toLowerCase()).length, 1)
})

test('POSIX configured scripts and known nearby launchers must be regular executable files', async () => {
  const h = fakeFiles({ '/opt/ComfyUI/run-velorn-comfyui.sh': 'file', '/opt/ComfyUI/run_cpu.sh': 'not-executable',
    '/opt/run_nvidia_gpu.sh': 'directory', '/opt/run_comfyui.sh': 'file' })
  const found = await h.setup.discoverInstallations({ comfyRootPath: '/opt/ComfyUI', launcherScript: '/opt/ComfyUI/run-velorn-comfyui.sh' })
  assert.deepEqual(found.map(candidate => candidate.path), ['/opt/ComfyUI/run-velorn-comfyui.sh', '/opt/run_comfyui.sh'])
  assert.ok(h.accessCalls.every(([, mode]) => mode === 1))
  assert.ok(h.calls.length <= 10)
})

test('Mac discovery recognizes standard and configured app bundles without treating them as scripts', async () => {
  const h = fakeFiles({ '/Applications/ComfyUI.app': 'directory', '/Applications/ComfyUI.app/Contents/Info.plist': 'file',
    '/Users/Tester/Applications/ComfyUI.app': 'directory', '/Users/Tester/Applications/ComfyUI.app/Contents/Info.plist': 'file',
    '/Volumes/Apps/ComfyUI.app': 'directory', '/Volumes/Apps/ComfyUI.app/Contents/Info.plist': 'file' },
  { platform: 'darwin', homeDir: '/Users/Tester' })
  const found = await h.setup.discoverInstallations({ macAppPath: '/Volumes/Apps/ComfyUI.app' })
  assert.deepEqual(found.map(candidate => candidate.path), ['/Volumes/Apps/ComfyUI.app', '/Applications/ComfyUI.app', '/Users/Tester/Applications/ComfyUI.app'])
  assert.ok(found.every(candidate => candidate.launcherMode === 'mac-app'))
  assert.equal(h.accessCalls.length, 0)
})

test('broken app bundles, relative paths and NUL paths are not offered', async () => {
  const h = fakeFiles({ '/Applications/ComfyUI.app': 'directory', '/Users/Tester/Applications/ComfyUI.app': 'file' },
    { platform: 'darwin', homeDir: '/Users/Tester' })
  assert.deepEqual(await h.setup.discoverInstallations({ comfyRootPath: '../ComfyUI', launcherScript: '/tmp/run\0.sh', macAppPath: '../ComfyUI.app' }), [])
  assert.equal(h.calls.some(name => name.includes('\0') || name.includes('..')), false)
})

async function withServer(handler, run) {
  const server = http.createServer(handler)
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { return await run(server.address().port) }
  finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

test('real loopback probe reads only GET/system_stats and parses JSON', async () => {
  await withServer((request, response) => {
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/system_stats')
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(stats()))
  }, async port => {
    assert.deepEqual(await requestLocalSystemStats({ port }), stats())
    const setup = createComfySetup()
    assert.deepEqual(await setup.probeConnection(port), { port, httpBase: `http://127.0.0.1:${port}`, deviceNames: ['Example GPU'] })
  })
})

test('real probes refuse redirects, errors, malformed JSON and oversized bodies', async () => {
  for (const kind of ['redirect', 'error', 'invalid', 'length', 'stream']) {
    let requests = 0
    await withServer((_request, response) => {
      requests++
      if (kind === 'redirect') { response.writeHead(302, { Location: '/other' }); response.end(); return }
      if (kind === 'error') { response.writeHead(500); response.end(JSON.stringify(stats())); return }
      if (kind === 'invalid') { response.end('<html>Not ComfyUI</html>'); return }
      if (kind === 'length') response.writeHead(200, { 'Content-Length': 1024 * 1024 + 1 })
      response.end('x'.repeat(1024 * 1024 + 1))
    }, async port => {
      assert.equal(await requestLocalSystemStats({ port }), null, kind)
      assert.equal(requests, 1, 'The request must not follow redirects')
    })
  }
})

test('real slow response is bounded by total timeout, including a trickling body', async () => {
  await withServer((_request, response) => {
    response.writeHead(200); response.write('{')
    const timer = setInterval(() => response.write(' '), 20)
    response.on('close', () => clearInterval(timer))
  }, async port => {
    const started = Date.now()
    assert.equal(await requestLocalSystemStats({ port, timeoutMs: 100 }), null)
    assert.ok(Date.now() - started < 1500)
  })
})
