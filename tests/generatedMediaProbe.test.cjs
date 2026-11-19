const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Evaluate only the actual media IPC registration; never launch main.js or a user project.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
const start = source.indexOf("ipcMain.handle('media:getVideoFps'")
const end = source.indexOf('\nconst audioWaveformCache', start)
assert.ok(start > 0 && end > start)
function handler(probe, ffprobePath = '/fixture/ffprobe') {
  let callback
  vm.runInNewContext(source.slice(start, end), { ffprobePath, probeVideoInfo: probe,
    ipcMain: { handle: (name, fn) => { assert.equal(name, 'media:getVideoFps'); callback = fn } } })
  return callback
}
test('existing media IPC preserves duration and dimensions required for in-place video repair', async () => {
  const result = await handler(async file => {
    assert.equal(file, '/fixture/project/assets/images/output.mp4')
    return { success: true, duration: 5, width: 1280, height: 720, fps: 24, videoCodec: 'h264', hasAudio: false }
  })({}, '/fixture/project/assets/images/output.mp4')
  assert.equal(result.success, true)
  for (const [key, value] of Object.entries({ duration: 5, width: 1280, height: 720, fps: 24, videoCodec: 'h264', hasAudio: false })) {
    assert.equal(result[key], value)
  }
})
test('probe failure and absent native binary cannot report verified media', async () => {
  const failure = { success: false, error: 'Unreadable media' }
  assert.equal(await handler(async () => failure)({}, '/fixture/bad.mp4'), failure)
  const result = await handler(() => assert.fail('Must not probe without binary'), null)({}, '/fixture/bad.mp4')
  assert.equal(result.success, false)
})
