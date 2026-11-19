import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { trackFramePipeOwner } = require('../electron/framePipeOwnership.cjs')
const source = await fs.readFile(new URL('../electron/main.js', import.meta.url), 'utf8')
const pipeHandlers = source.slice(source.indexOf("ipcMain.handle('export:writeFrameToPipe'"), source.indexOf("ipcMain.handle('export:muxAudioVideo'"))

function harness() {
  const sessions = new Map(), handlers = new Map()
  vm.runInNewContext(pipeHandlers, { activeFramePipeExports: sessions, Buffer,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) } })
  const owner = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false })
  const makeSession = (sender, id = `pipe-${sender.id}`) => {
    let closed = false
    const stdin = new EventEmitter()
    stdin.end = () => { closed = true }
    stdin.write = () => true
    const session = trackFramePipeOwner({ sessions, sessionId: id, sender,
      session: { ffmpeg: { stdin, killed: false, kill() { this.killed = true; closed = true; stdin.emit('close') } },
        closePromise: Promise.resolve(), getClosed: () => closed, getError: () => null,
        getCloseCode: () => 0, getStderr: () => '', encoderUsed: 'synthetic' } })
    return session
  }
  const call = (name, sender, id, value) => handlers.get(`export:${name}`)({ sender }, id, value)
  return { sessions, owner, makeSession, call }
}

test('renderer crash/destroy kills only its frame pipes and detaches owner listeners', () => {
  for (const event of ['destroyed', 'render-process-gone']) {
    const h = harness(), a = h.owner(1), b = h.owner(2)
    const first = h.makeSession(a), second = h.makeSession(b)
    a.emit(event)
    assert.equal(first.ffmpeg.killed, true)
    assert.equal(second.ffmpeg.killed, false)
    assert.equal(h.sessions.has('pipe-1'), false)
    assert.equal(h.sessions.has('pipe-2'), true)
    assert.equal(a.listenerCount('destroyed'), 0)
    assert.equal(a.listenerCount('render-process-gone'), 0)
    b.emit('destroyed')
  }
})

test('already-destroyed caller is cleaned up immediately during startup', () => {
  const h = harness(), owner = h.owner(1)
  owner.isDestroyed = () => true
  const session = h.makeSession(owner)
  assert.equal(session.ffmpeg.killed, true)
  assert.equal(h.sessions.size, 0)
})

test('normal abort IPC checks sender ownership and cannot kill another renderer', async () => {
  const h = harness(), owner = h.owner(1), other = h.owner(2)
  const session = h.makeSession(owner), otherSession = h.makeSession(other)
  assert.equal((await h.call('abortFramePipe', other, 'pipe-1')).success, false)
  assert.equal(session.ffmpeg.killed, false)
  assert.equal((await h.call('abortFramePipe', owner, 'pipe-1')).success, true)
  assert.equal(session.ffmpeg.killed, true)
  assert.equal(otherSession.ffmpeg.killed, false)
  assert.equal(owner.listenerCount('destroyed'), 0)
  assert.equal((await h.call('abortFramePipe', owner, 'pipe-1')).success, true)
  other.emit('destroyed')
})

test('normal completion removes owner cleanup without killing the successfully finished encoder', async () => {
  const h = harness(), owner = h.owner(1), session = h.makeSession(owner)
  assert.equal((await h.call('finishFramePipe', h.owner(2), 'pipe-1')).success, false)
  assert.equal((await h.call('finishFramePipe', owner, 'pipe-1')).success, true)
  assert.equal(h.sessions.size, 0)
  owner.emit('destroyed')
  assert.equal(session.ffmpeg.killed, false)
})

test('writes reject foreign senders and an aborted backpressure wait settles on stream close', async () => {
  const h = harness(), owner = h.owner(1), session = h.makeSession(owner)
  assert.equal((await h.call('writeFrameToPipe', h.owner(2), 'pipe-1', new Uint8Array(4))).success, false)
  session.ffmpeg.stdin.write = () => false
  const pending = h.call('writeFrameToPipe', owner, 'pipe-1', new Uint8Array(4))
  assert.equal(session.ffmpeg.stdin.listenerCount('close'), 2, 'stream lifetime cleanup plus pending write')
  owner.emit('render-process-gone')
  assert.equal((await pending).success, false)
  for (const event of ['drain', 'error', 'close']) assert.equal(session.ffmpeg.stdin.listenerCount(event), 0)
})

test('actual waiting FFmpeg subprocess exits on owner crash without touching another owner', { timeout: 10000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-frame-pipe-owner-'))
  const sessions = new Map(), children = [], owners = []
  try {
    for (let index = 0; index < 2; index++) {
      const child = spawn(require('ffmpeg-static'), ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-video_size', '16x16', '-framerate', '24', '-i', 'pipe:0', '-c:v', 'mpeg4', path.join(dir, `${index}.mp4`)],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
      children.push(child)
      let closed = false
      const closePromise = new Promise(resolve => child.once('close', () => { closed = true; resolve() }))
      const owner = Object.assign(new EventEmitter(), { id: index, isDestroyed: () => false })
      owners.push(owner)
      trackFramePipeOwner({ sessions, sessionId: `${index}`, sender: owner,
        session: { ffmpeg: child, getClosed: () => closed, closePromise } })
      await once(child, 'spawn')
    }
    const firstClosed = sessions.get('0').closePromise
    owners[0].emit('render-process-gone')
    await firstClosed
    assert.equal(children[0].killed, true)
    assert.equal(children[1].killed, false)
    assert.equal(children[1].exitCode, null)
    assert.equal(sessions.size, 1)
    const secondClosed = sessions.get('1').closePromise
    owners[1].emit('destroyed')
    await secondClosed
    assert.equal(sessions.size, 0)
  } finally {
    for (const child of children) if (!child.killed) child.kill('SIGKILL')
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('native startup binds cleanup before the asynchronous spawn handshake', () => {
  const handler = source.slice(source.indexOf("ipcMain.handle('export:startFramePipe'"), source.indexOf("ipcMain.handle('export:writeFrameToPipe'"))
  assert.ok(handler.indexOf('trackFramePipeOwner(') < handler.indexOf('const startup = await'))
  assert.match(handler, /if \(!startup\.ok\) \{\s+framePipeSession\.release\(\)/)
  assert.match(handler, /event\.sender\.isDestroyed\(\) \|\| !activeFramePipeExports\.has\(sessionId\)/)
})
