'use strict'

const { spawn } = require('node:child_process')
const os = require('node:os')
const { childEnvironment, codexCommand, preflightCodex } = require('./connectedAgentCodex.cjs')

const LOGIN_TIMEOUT_MS = 300000
const LOGIN_OUTPUT_BYTES = 64 * 1024
const fault = (code, message) => Object.assign(new Error(message), { code })
const cancelled = () => fault('CANCELLED', 'Codex sign-in was cancelled. Check connection to see the current account status.')

// Only a native, explicitly requested action calls this helper. The official
// CLI owns browser login and credential storage. Velorn discards subprocess
// output without forwarding or storing URLs, codes, tokens or diagnostics,
// and never reads account files.
async function signInCodex({ executablePath, signal, spawnImpl = spawn, preflightImpl = preflightCodex,
  environment = process.env, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw cancelled()
  const executable = codexCommand(executablePath)
  if (!executablePath) throw fault('CODEX_EXECUTABLE_INVALID', 'Choose a Codex installation before signing in.')
  const env = childEnvironment(environment)
  // Browser opening needs desktop-session hints on Linux. These are login-
  // only values, never commands such as BROWSER, shell options, or URL input.
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    delete env[key]
    const value = environment[key]
    if (typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)) env[key] = value
  }
  const cwd = os.tmpdir()
  await preflightImpl({ executablePath: executable, signal, environment: env, cwd })
  if (signal?.aborted) throw cancelled()

  return new Promise((resolve, reject) => {
    let child, timer, stopTimer, finished = false, received = 0, stoppingError
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(stopTimer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ success: true })
    }
    const stop = error => {
      if (finished || stoppingError) return
      stoppingError = error
      clearTimeout(timer)
      // Never terminate a user's browser or another Codex process/group.
      try { child.kill('SIGKILL') } catch { finish(error); return }
      // Hold native login ownership until exit. Do not hang forever if an OS
      // teardown fails to deliver close after the owned process is killed.
      if (!finished) stopTimer = setTimeout(() => finish(error), 1000)
    }
    const onAbort = () => stop(cancelled())
    const discard = chunk => {
      if (finished) return
      received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (received > LOGIN_OUTPUT_BYTES) stop(fault('CODEX_LOGIN_FAILED', 'Codex sign-in returned too much diagnostic output. Check your Codex installation and try again.'))
    }
    try {
      child = spawnImpl(executable, ['login'], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', discard)
      child.stderr.on('data', discard)
      const failed = () => fault('CODEX_LOGIN_FAILED', 'Codex sign-in could not start. Check your Codex installation and try again.')
      child.stdout.on('error', () => stop(failed()))
      child.stderr.on('error', () => stop(failed()))
      child.on('error', () => finish(stoppingError || failed()))
      child.on('close', (code, exitSignal) => {
        if (stoppingError) { finish(stoppingError); return }
        if (signal?.aborted) { finish(cancelled()); return }
        if (exitSignal || code !== 0) finish(fault('CODEX_LOGIN_FAILED', 'Codex sign-in did not finish. Check connection, or try signing in again.'))
        else finish()
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      const duration = Number.isFinite(timeoutMs) ? Math.min(LOGIN_TIMEOUT_MS, Math.max(1, timeoutMs)) : LOGIN_TIMEOUT_MS
      timer = setTimeout(() => stop(fault('CODEX_LOGIN_TIMEOUT', 'Codex sign-in timed out. Check connection before trying again.')), duration)
      if (signal?.aborted) onAbort()
    } catch {
      const failure = fault('CODEX_LOGIN_FAILED', 'Codex sign-in could not start. Check your Codex installation and try again.')
      if (child) stop(failure)
      else finish(failure)
    }
  })
}

module.exports = { signInCodex, LOGIN_TIMEOUT_MS, LOGIN_OUTPUT_BYTES }
