// Run against an isolated Vite server (default 5198). Launch Electron directly
// to retain its normal sandbox: Playwright's Electron launcher adds no-sandbox.
// VELORN_TEST_NATIVE_ENCODE=1 adds an actual six-second 720p24 H.264 render,
// ffprobe frame-count validation and full decode under the temporary profile.
// VELORN_TEST_ELECTRON_BINARY can select another unpacked Electron runtime.
// An installed application executable loads its bundled app, not this fixture.
// --serve owns an isolated Vite child and stops it after the Electron check.
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const isReady = url => new Promise(resolve => {
  const request = http.get(url, response => {
    response.resume()
    resolve(response.statusCode === 200)
  })
  request.on('error', () => resolve(false))
  request.setTimeout(500, () => request.destroy())
})

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  // The server is Node running Vite directly, not a platform-specific npm/shell
  // wrapper. Closing it also closes the esbuild service's parent pipe.
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--serve')) throw new Error('Usage: node scripts/check-export-worker-scheduling.cjs [--serve]')
  const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198')
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.username || base.password) {
    throw new Error('Fixture requires a loopback HTTP Vite server')
  }
  const env = { ...process.env, VELORN_TEST_URL: base.origin }
  delete env.ELECTRON_RUN_AS_NODE
  let server, fixture
  const interrupted = signal => {
    fixture?.kill()
    server?.kill()
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  }
  const onInterrupt = () => interrupted('SIGINT')
  const onTerminate = () => interrupted('SIGTERM')
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  try {
    if (args.includes('--serve')) {
      const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
      server = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', base.port || '80', '--strictPort', '--clearScreen', 'false'],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let serverError, output = ''
      server.once('error', error => { serverError = error })
      server.stdout.on('data', data => { output = (output + data).slice(-8000); process.stdout.write(data) })
      server.stderr.on('data', data => process.stderr.write(data))
      const deadline = Date.now() + 30000
      while (true) {
        if (serverError) throw serverError
        if (server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated Vite server exited before the fixture was ready')
        // Only probe after our child announces its own listening URL, so an
        // occupied port cannot silently route this test to somebody else's app.
        if (output.includes(base.origin) && await isReady(new URL('/tests/fixtures/export-scheduler.html', base))) break
        if (Date.now() >= deadline) throw new Error('Isolated Vite server did not become ready within 30 seconds')
        await delay(100)
      }
    }
    const executable = process.env.VELORN_TEST_ELECTRON_BINARY || require('electron')
    let fixtureOutput = ''
    fixture = spawn(executable, [path.join(root, 'tests', 'fixtures', 'export-scheduler-electron.cjs')],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    fixture.stdout.on('data', data => { fixtureOutput = (fixtureOutput + data).slice(-64000); process.stdout.write(data) })
    const outcome = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { fixture.kill(); reject(new Error('Export scheduling fixture process timed out')) },
        process.env.VELORN_TEST_NATIVE_ENCODE === '1' ? 105000 : 45000)
      fixture.once('error', error => { clearTimeout(timeout); reject(error) })
      fixture.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
    })
    if (outcome.code !== 0) throw new Error(`Export scheduling fixture failed (${outcome.signal || `exit ${outcome.code}`})`)
    const resultLine = fixtureOutput.split(/\r?\n/).find(line => line.startsWith('EXPORT_SCHEDULER_RESULT '))
    if (!resultLine || JSON.parse(resultLine.slice('EXPORT_SCHEDULER_RESULT '.length)).success !== true) {
      throw new Error('Electron exited without a successful fixture result; use an Electron runtime, not a packaged application executable')
    }
  } finally {
    await stopChild(fixture)
    await stopChild(server)
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}

main().catch(error => { console.error(error.message); process.exitCode ||= 1 })
