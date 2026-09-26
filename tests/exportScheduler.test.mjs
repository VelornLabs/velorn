import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { createExportScheduler } from '../src/services/exportScheduler.mjs'

function harness({ visible = true, messageChannel = true } = {}) {
  const messages = [], raf = [], timers = [], channels = []
  const host = {
    document: { visibilityState: visible ? 'visible' : 'hidden' },
    requestAnimationFrame: callback => raf.push(callback),
    setTimeout: callback => timers.push(callback),
    ...(messageChannel ? { MessageChannel: class {
      constructor() {
        this.port1 = { onmessage: null, close() { this.closed = true } }
        this.port2 = { postMessage: () => messages.push(() => this.port1.onmessage?.()), close() { this.closed = true } }
        channels.push(this)
      }
    } } : {}),
  }
  return { host, messages, raf, timers, channels }
}

test('offscreen progress uses a real task even when Electron reports a visible document and RAF never fires', async () => {
  const h = harness(), scheduler = createExportScheduler({ host: h.host, offscreen: true })
  let resolved = false
  const wait = scheduler.yieldForProgress().then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false, 'not a microtask-only yield')
  assert.equal(h.raf.length, 0)
  assert.equal(h.messages.length, 1)
  h.messages.shift()()
  await wait
  assert.equal(resolved, true)
  assert.equal(scheduler.mode, 'offscreen-task-queue')
  scheduler.dispose()
})

test('visible direct exports retain repaint opportunities and independent task yields', async () => {
  const h = harness(), scheduler = createExportScheduler({ host: h.host })
  const repaint = scheduler.yieldForProgress(), task = scheduler.yieldTask()
  assert.equal(h.raf.length, 1); assert.equal(h.messages.length, 1)
  h.raf.shift()(); h.messages.shift()()
  await Promise.all([repaint, task])
  scheduler.dispose()
})

test('a hidden document or absent RAF also falls back to tasks for direct exports', async () => {
  for (const visible of [false, true]) {
    const h = harness({ visible })
    if (visible) delete h.host.requestAnimationFrame
    const scheduler = createExportScheduler({ host: h.host })
    const wait = scheduler.yieldForProgress()
    assert.equal(h.messages.length, 1); assert.equal(h.raf.length, 0)
    h.messages.shift()(); await wait; scheduler.dispose()
  }
})

test('old runtimes without MessageChannel yield via a timer rather than spinning microtasks', async () => {
  const h = harness({ messageChannel: false }), scheduler = createExportScheduler({ host: h.host, offscreen: true })
  const wait = scheduler.yieldForProgress()
  assert.equal(h.timers.length, 1); assert.equal(h.raf.length, 0)
  h.timers.shift()(); await wait; scheduler.dispose()
})

test('shared channel preserves FIFO task ordering and closes both ports on cleanup', async () => {
  const h = harness(), scheduler = createExportScheduler({ host: h.host, offscreen: true }), order = []
  const waits = [scheduler.yieldTask().then(() => order.push(1)), scheduler.yieldForProgress().then(() => order.push(2))]
  assert.equal(h.channels.length, 1)
  h.messages.shift()(); await Promise.resolve(); assert.deepEqual(order, [1])
  h.messages.shift()(); await Promise.all(waits); assert.deepEqual(order, [1, 2])
  scheduler.dispose(); scheduler.dispose()
  assert.equal(h.channels[0].port1.closed, true); assert.equal(h.channels[0].port2.closed, true)
  await scheduler.yieldTask(); assert.equal(h.channels.length, 1)
})

test('cleanup settles pending tasks without leaving unresolved promises', async () => {
  const h = harness(), scheduler = createExportScheduler({ host: h.host, offscreen: true })
  const wait = scheduler.yieldTask()
  scheduler.dispose(); await wait
  h.messages.shift()() // Late delivery after disposal is harmless.
})

test('native MessageChannel delivers queued decoder-style tasks and cancellation during a hot loop', async () => {
  const scheduler = createExportScheduler({ offscreen: true }), controller = new AbortController()
  let frames = 0, timerRan = false
  const timeout = setTimeout(() => { timerRan = true; controller.abort() }, 10)
  try {
    while (!controller.signal.aborted && frames < 100000) {
      await scheduler.yieldTask()
      frames++
    }
    assert.equal(timerRan, true)
    assert.ok(frames > 0 && frames < 100000)
  } finally { clearTimeout(timeout); scheduler.dispose() }
})

test('worker explicitly opts in and every exporter progress wait uses the shared runtime scheduler', async () => {
  const source = await fs.readFile(new URL('../src/services/exporter.js', import.meta.url), 'utf8')
  const worker = await fs.readFile(new URL('../src/components/ExportWorker.jsx', import.meta.url), 'utf8')
  assert.match(worker, /\{ offscreen: true \}/)
  assert.doesNotMatch(source, /requestAnimationFrame|yieldToMain|yieldToEventLoop/)
  assert.equal(source.match(/await scheduler\.yieldForProgress\(\)/g)?.length, 2)
  assert.match(source, /finally \{\s+scheduler\.dispose\(\)/)
  assert.match(source, /progressYield: perFrameMs\(exportPerf\.progressYieldMs\)/)
  assert.match(source, /taskYield: perFrameMs\(exportPerf\.taskYieldMs\)/)
})
