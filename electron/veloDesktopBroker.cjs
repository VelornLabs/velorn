'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
async function startDesktopBroker({ runtime, authority, assertAuthorized, signal, forkImpl = fork }) {
  await assertAuthorized()
  if (signal?.aborted) throw Error('Velo request cancelled.')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-native-broker-'))
  fs.chmodSync(root, 0o700)
  const socketPath = path.join(root, 'broker.sock')
  const child = forkImpl(runtime.workerPath, [], { execPath: runtime.nodePath,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let closing, exited = false
  child.once('exit', () => { exited = true })
  const close = () => closing ||= (async () => {
    signal?.removeEventListener('abort', abort)
    if (!exited) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        if (child.connected) child.send({ type: 'close' }, () => {})
        else child.kill('SIGTERM')
      })
    }
    // These are the two exact owned temporary paths, not arbitrary directories.
    try { fs.unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    fs.rmdirSync(root)
  })()
  const abort = () => { void close().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const capability = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Velo private transport startup timed out.')), 20000)
      const fail = () => { clearTimeout(timer); reject(Error('Velo private transport could not start.')) }
      child.once('error', fail); child.once('exit', fail)
      child.on('message', async message => {
        if (message?.type === 'authority') {
          let ok = false
          try { await assertAuthorized(); ok = !signal?.aborted && !closing } catch {}
          if (child.connected) child.send({ type: 'authority-result', id: message.id, ok }, () => {})
        }
        if (message?.type === 'ready') {
          clearTimeout(timer)
          if (!/^[a-f0-9]{64}$/.test(message.capability || '')) fail()
          else resolve(message.capability)
        }
        if (message?.type === 'failed') fail()
      })
      child.send({ type: 'start', socketPath, ...authority }, error => { if (error) fail() })
    })
    await assertAuthorized()
    if (signal?.aborted || closing) throw Error('Velo request cancelled.')
    return { socketPath, capability, close }
  } catch (error) { await close(); throw error }
}
module.exports = { startDesktopBroker }
