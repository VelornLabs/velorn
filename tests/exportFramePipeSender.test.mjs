import test from 'node:test'
import assert from 'node:assert/strict'
import { createFramePipeSender } from '../src/services/exportFramePipeSender.js'

const FRAME_BYTES = 16

// A stand-in for the page: MessageChannel exists, postMessage records the port hand-off.
const createHost = () => {
  const posted = []
  return {
    posted,
    MessageChannel: class { constructor() { this.port1 = { name: 'port1' }; this.port2 = { name: 'port2' } } },
    postMessage: (message, origin, transfer) => posted.push({ message, transfer }),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
    clearTimeout: (id) => clearTimeout(id),
  }
}

// A stand-in for the worker: answers 'port' with `portReply`, frames with recycle + ack.
const createFakeWorker = ({ portReply = { type: 'ready' }, ackSuccess = true } = {}) => {
  const worker = {
    frames: [],
    terminated: false,
    onmessage: null,
    postMessage(data) {
      if (data.type === 'port') {
        if (portReply) queueMicrotask(() => worker.onmessage?.({ data: portReply }))
      } else if (data.type === 'frame') {
        worker.frames.push({ id: data.id, bytes: Array.from(new Uint8Array(data.buffer)) })
        queueMicrotask(() => {
          worker.onmessage?.({ data: { type: 'recycle', buffer: data.buffer } })
          worker.onmessage?.({ data: { type: 'ack', id: data.id, success: ackSuccess, error: ackSuccess ? null : 'pipe closed' } })
        })
      }
    },
    terminate() { worker.terminated = true },
  }
  return worker
}

test('uses the plain invoke route when the app has no port support', async () => {
  const calls = []
  const api = { writeFrameToPipe: async (sessionId, buffer) => { calls.push([sessionId, buffer.byteLength]); return { success: true } } }
  const sender = await createFramePipeSender('s1', FRAME_BYTES, { api, host: createHost(), createWorker: () => { throw new Error('must not be created') } })
  assert.equal(sender.mode, 'invoke')
  assert.equal(sender.takeFrameBuffer(), null)
  assert.deepEqual(await sender.send(new ArrayBuffer(FRAME_BYTES), true), { success: true })
  assert.deepEqual(calls, [['s1', FRAME_BYTES]])
})

test('falls back to invoke when the main process never answers the port', async () => {
  const worker = createFakeWorker({ portReply: null })
  const api = { framePipePortSupported: true, writeFrameToPipe: async () => ({ success: true }) }
  const sender = await createFramePipeSender('s1', FRAME_BYTES, { api, host: createHost(), createWorker: () => worker })
  assert.equal(sender.mode, 'invoke')
  assert.equal(worker.terminated, true)
})

test('falls back to invoke when the main process refuses the port', async () => {
  const worker = createFakeWorker({ portReply: { type: 'failed', error: 'Frame pipe session not found.' } })
  const api = { framePipePortSupported: true, writeFrameToPipe: async () => ({ success: true }) }
  const sender = await createFramePipeSender('s1', FRAME_BYTES, { api, host: createHost(), createWorker: () => worker })
  assert.equal(sender.mode, 'invoke')
})

test('port route hands the port to the preload, sends frames in order and reuses buffers', async () => {
  const worker = createFakeWorker()
  const host = createHost()
  const api = { framePipePortSupported: true, writeFrameToPipe: async () => { throw new Error('invoke must not be used') } }
  const sender = await createFramePipeSender('s1', FRAME_BYTES, { api, host, createWorker: () => worker })
  assert.equal(sender.mode, 'port')
  assert.deepEqual(host.posted[0].message, { type: 'velorn:export-frame-pipe-port', sessionId: 's1' })
  assert.equal(host.posted[0].transfer[0].name, 'port2')

  // Owned buffer: handed over as-is.
  const first = sender.takeFrameBuffer()
  assert.equal(first.length, FRAME_BYTES)
  first.fill(1)
  const firstWrite = sender.send(first.buffer, true)

  // Borrowed buffer: copied, so the caller can overwrite it right away.
  const borrowed = new Uint8Array(FRAME_BYTES).fill(2)
  const secondWrite = sender.send(borrowed.buffer, false)
  borrowed.fill(9)

  assert.deepEqual(await firstWrite, { success: true })
  assert.deepEqual(await secondWrite, { success: true })
  assert.deepEqual(worker.frames.map(frame => frame.bytes[0]), [1, 2])
  assert.ok(worker.frames[0].id < worker.frames[1].id)

  // Recycled buffers come back out of the pool instead of new ones.
  const reused = [sender.takeFrameBuffer().buffer, sender.takeFrameBuffer().buffer]
  assert.ok(reused.includes(first.buffer))
  sender.dispose()
  assert.equal(worker.terminated, true)
})

test('port route reports a failed write and fails writes after dispose', async () => {
  const worker = createFakeWorker({ ackSuccess: false })
  const api = { framePipePortSupported: true }
  const sender = await createFramePipeSender('s1', FRAME_BYTES, { api, host: createHost(), createWorker: () => worker })
  assert.deepEqual(await sender.send(new ArrayBuffer(FRAME_BYTES), true), { success: false, error: 'pipe closed' })
  sender.dispose()
  assert.equal((await sender.send(new ArrayBuffer(FRAME_BYTES), true)).success, false)
})
