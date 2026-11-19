const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createCrashRecovery } = require('../electron/crashRecovery.cjs')
function fixture(t, response = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-crash-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = new EventEmitter(), window = new EventEmitter(), contents = new EventEmitter()
  app.getPath = () => root; app.getVersion = () => 'test'
  let destroyed = false, reloaded = 0, prompted = 0, opened = 0, options
  window.isDestroyed = () => destroyed; window.webContents = contents
  contents.isDestroyed = () => destroyed; contents.reload = () => reloaded++
  const recovery = createCrashRecovery({ app, crashReporter: { start: value => { options = value } },
    dialog: { showMessageBox: async () => { prompted++; return { response: await response } } },
    shell: { openPath: async () => { opened++ } } })
  recovery.attach(window)
  return { app, contents, recovery, destroy: () => { destroyed = true }, options,
    counts: () => ({ reloaded, prompted, opened }),
    crash: () => contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 }) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test('local-only reporting, bounded metadata and explicit reload', async t => {
  const f = fixture(t, 0)
  assert.equal(f.options.uploadToServer, false); assert.equal(f.options.submitURL, undefined)
  f.crash(); await tick()
  assert.deepEqual(f.counts(), { reloaded: 1, prompted: 1, opened: 0 })
  for (let i = 0; i < 40; i++) f.recovery.record('test', { reason: 'x', secret: 'never-save' })
  const records = JSON.parse(fs.readFileSync(path.join(f.recovery.directory, 'latest-events.json')))
  assert.equal(records.length, 30); assert.ok(!JSON.stringify(records).includes('never-save'))
})
test('cancel and diagnostics do not reload; subsequent crashes can prompt again', async t => {
  for (const response of [1, 2]) {
    const f = fixture(t, response); f.crash(); await tick(); f.crash(); await tick()
    assert.equal(f.counts().reloaded, 0); assert.equal(f.counts().prompted, 2)
    assert.equal(f.counts().opened, response === 1 ? 2 : 0)
  }
})
test('duplicate events, closed window and quitting prevent late reload', async t => {
  let resolve
  const f = fixture(t, new Promise(done => { resolve = done }))
  f.crash(); f.crash(); assert.equal(f.counts().prompted, 1)
  f.destroy(); resolve(0); await tick(); assert.equal(f.counts().reloaded, 0)
  const next = fixture(t, 0); next.app.emit('will-quit'); next.crash(); await tick()
  assert.equal(next.counts().prompted, 0)
})
