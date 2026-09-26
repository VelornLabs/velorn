// Never shown: unlike UI test hosts, this fixture must not call showInactive.
// No app preload, real project, production IPC or MCP server is loaded.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-export-scheduling-'))
app.setPath('userData', profile)
let window, finished = false
let nativePipe = null, nativeVerification = null
const nativeEncode = process.env.VELORN_TEST_NATIVE_ENCODE === '1'
const runtime = { electron: process.versions.electron, chrome: process.versions.chrome,
  platform: process.platform, arch: process.arch, executable: process.execPath }
const assertSender = event => {
  if (event.sender !== window?.webContents) throw new Error('Foreign fixture sender')
}
const finish = (code, result) => {
  if (finished) return
  finished = true
  nativePipe?.child.kill()
  console.log('EXPORT_SCHEDULER_RESULT ' + JSON.stringify({ ...result, runtime,
    ...(nativeVerification ? { nativeVerification } : {}) }))
  app.exit(code)
}
ipcMain.handle('export-scheduler-ping', event => {
  assertSender(event)
  return { hidden: !window.isVisible() }
})
// Optional real native sink. It can only create one fixed synthetic MP4 under
// this fixture's mkdtemp-owned profile, never a caller-selected/user path.
ipcMain.handle('export-scheduler-native-start', (event, options) => {
  assertSender(event)
  if (!nativeEncode || nativePipe || options.width !== 1280 || options.height !== 720 || options.fps !== 24 || options.duration !== 6) {
    throw new Error('Native fixture only allows one 6-second 720p24 synthetic render')
  }
  const outputPath = path.join(profile, 'synthetic-export.mp4')
  const child = spawn(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-r', '24', '-i', 'pipe:0', '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath],
  { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  const state = { child, outputPath, frames: 0, startedAt: Date.now(), stderr: '' }
  state.done = new Promise(resolve => {
    child.once('error', error => resolve({ success: false, error: error.message }))
    child.once('close', code => resolve({ success: code === 0, error: code === 0 ? null : state.stderr || `FFmpeg exited ${code}` }))
  })
  child.stderr.on('data', data => { state.stderr = (state.stderr + data).slice(-4000) })
  child.stdin.on('error', () => {}) // The pending write callback reports it.
  nativePipe = state
  return { success: true, sessionId: 'fixture-native', encoderUsed: 'libx264' }
})
ipcMain.handle('export-scheduler-native-write', async (event, id, buffer) => {
  assertSender(event)
  if (id !== 'fixture-native' || !nativePipe || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== 1280 * 720 * 4) {
    throw new Error('Invalid native fixture frame')
  }
  const state = nativePipe
  if (state.frames >= 144) throw new Error('Synthetic frame limit exceeded')
  state.frames++
  return new Promise(resolve => state.child.stdin.write(Buffer.from(buffer), error => resolve({ success: !error, error: error?.message })))
})
ipcMain.handle('export-scheduler-native-finish', async (event, id) => {
  assertSender(event)
  if (id !== 'fixture-native' || !nativePipe) throw new Error('Missing native fixture pipe')
  const state = nativePipe
  state.child.stdin.end()
  const completion = await state.done
  nativePipe = null
  if (!completion.success) throw new Error(completion.error)
  const probeBinary = require('@derhuerst/ffprobe-static')
  const probe = JSON.parse(execFileSync(typeof probeBinary === 'string' ? probeBinary : probeBinary.path, [
    '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration',
    '-of', 'json', state.outputPath,
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true }))
  const video = probe.streams[0], seconds = Number(probe.format.duration)
  if (state.frames !== 144 || video.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720
    || video.r_frame_rate !== '24/1' || Number(video.nb_read_frames) !== 144 || Math.abs(seconds - 6) > 0.05) {
    throw new Error('Encoded MP4 failed ffprobe verification: ' + JSON.stringify(probe))
  }
  // Decode all frames too: ffprobe metadata alone cannot prove a good stream.
  execFileSync(require('ffmpeg-static'), ['-hide_banner', '-v', 'error', '-xerror', '-i', state.outputPath, '-f', 'null', '-'],
    { timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true })
  nativeVerification = { outputPath: state.outputPath, bytes: fs.statSync(state.outputPath).size,
    submittedFrames: state.frames, encoder: 'libx264 medium CRF18', nativeElapsedMs: Date.now() - state.startedAt,
    ffprobe: probe, fullDecodePassed: true }
  return { success: true, encoderUsed: 'libx264', verified: true }
})
ipcMain.handle('export-scheduler-native-abort', async (event, id) => {
  assertSender(event)
  if (id !== 'fixture-native') throw new Error('Unknown native fixture pipe')
  const state = nativePipe
  if (state) { state.child.kill(); await state.done; nativePipe = null }
  return { success: true }
})
ipcMain.on('export-scheduler-result', (event, result) => {
  if (event.sender !== window?.webContents) return
  if (window.isVisible()) return finish(1, { error: 'Fixture became visible' })
  finish(result?.success ? 0 : 1, { ...result, windowNeverShown: true })
})
app.whenReady().then(() => {
  window = new BrowserWindow({ show: false, width: 640, height: 360,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload: path.join(__dirname, 'export-scheduler-preload.cjs'),
      additionalArguments: nativeEncode ? ['--velorn-test-native-encode'] : [] } })
  window.on('show', () => finish(1, { error: 'Hidden export fixture was shown' }))
  window.webContents.on('render-process-gone', (_, details) => finish(1, { error: 'Renderer exited', details }))
  window.webContents.on('console-message', (_, level, message) => { if (level >= 2) console.error(message) })
  const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198')
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Fixture requires a loopback Vite server')
  window.loadURL(new URL('/tests/fixtures/export-scheduler.html', base).href).catch(error => finish(1, { error: error.message }))
  setTimeout(() => finish(1, { error: 'Never-shown export timed out (possible RAF starvation)' }), nativeEncode ? 90000 : 30000)
}).catch(error => finish(1, { error: error.message }))
app.on('window-all-closed', () => app.quit())
