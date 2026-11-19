'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')

// Electron's Node runtime must not supply engine/transport dependencies. Use
// the bundled Node 24, private pipes and disposable fixture state only.
async function startCandidateGateway({ gatewayRoot, stateDir, assertIsolation }) {
  assertIsolation()
  const child = spawn('/runtime/bin/node', [path.join(gatewayRoot, 'sidecar.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: '/workspace',
    env: { PATH: '/runtime/bin:/usr/bin:/bin', LANG: 'C.UTF-8', VELORN_CODEX_CANDIDATE: '1' },
  })
  const pending = new Map()
  let nextId = 1, buffer = '', closed = false, closing
  const failure = () => new Error('The isolated synthetic gateway stopped. No live provider was used.')
  const fail = () => {
    closed = true
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()) }
    pending.clear()
  }
  child.once('error', fail)
  child.once('exit', fail)
  child.stdin.on('error', fail)
  child.stdout.on('error', fail)
  child.stderr.on('error', fail)
  child.stderr.resume() // Diagnostics must not expose ephemeral capabilities.
  child.stdout.on('data', chunk => {
    buffer += chunk.toString()
    if (buffer.length > 1024 * 1024) { child.kill(); fail(); return }
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      let response
      try { response = JSON.parse(line) } catch { child.kill(); fail(); return }
      const item = pending.get(response.id)
      if (!item) continue
      pending.delete(response.id); clearTimeout(item.timer)
      response.error ? item.reject(failure()) : item.resolve(response.result)
    }
  })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(failure()); return }
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(failure()); child.kill() }, 15000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n', error => {
      if (error) { pending.delete(id); clearTimeout(timer); reject(failure()) }
    })
  })
  const close = () => closing ||= (async () => {
    if (!closed) { try { await rpc('close') } catch {} }
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1500); timer.unref() })])
    }
    fail()
  })()
  try {
    const value = await rpc('start', { fixture: true, stateDir })
    if (value?.fixture !== true || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(value.baseUrl || '')
      || typeof value.token !== 'string' || typeof value.catalogPath !== 'string') throw failure()
    return { ...value, status: () => rpc('status'), revoke: () => rpc('revoke'), close }
  } catch (error) { await close(); throw error }
}

module.exports = { startCandidateGateway }
