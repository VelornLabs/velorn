'use strict'
// Executed by bundled Node, never Electron/renderer. Account authorization is
// delivered privately over parent IPC and is rechecked before every request.
const { createNativeBroker } = require('./veloNativeBroker.cjs')
let broker, closing = false, initialized = false, next = 0
const pending = new Map()
function authorize() {
  if (closing || !process.connected) return Promise.reject(Error('DESKTOP_CLOSED'))
  const id = ++next
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('AUTHORITY_UNCONFIRMED')) }, 15000)
    pending.set(id, { resolve, reject, timer })
    process.send({ type: 'authority', id })
  })
}
async function close() {
  if (closing) return
  closing = true
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('DESKTOP_CLOSED')) }
  pending.clear()
  try { await broker?.close() } finally { process.exit(0) }
}
process.on('disconnect', close)
process.on('SIGTERM', close)
process.on('message', async message => {
  if (message?.type === 'authority-result') {
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id); clearTimeout(item.timer)
    message.ok === true ? item.resolve() : item.reject(Error('DESKTOP_AUTHORITY_REVOKED'))
    return
  }
  if (message?.type === 'close') return close()
  if (message?.type !== 'start' || initialized || closing) return
  initialized = true
  try {
    await authorize()
    const headers = Object.freeze({ authorization: 'Bearer ' + message.token, 'X-Velorn-Computer-Id': message.computerId })
    broker = await createNativeBroker({ socketPath: message.socketPath, baseUrl: message.baseUrl,
      getAuthHeaders: async () => headers, allowLive: true, assertAuthorized: authorize,
      onEvent: event => { if (process.connected && event.type === 'admission-progress') process.send({ type: 'progress', progress: event }) } })
    if (closing) { await broker.close(); return }
    process.send({ type: 'ready', capability: broker.capability })
  } catch {
    if (process.connected) process.send({ type: 'failed' })
    await close()
  }
})
