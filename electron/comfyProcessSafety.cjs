const fs = require('node:fs/promises')

const validPid = value => Number.isSafeInteger(value) && value > 1
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535
function onlyPid(values) {
  const ids = new Set(values)
  return ids.size === 1 && validPid([...ids][0]) ? [...ids][0] : null
}

function parseLsofPid(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  if (!lines.length || lines.some(line => !/^p[0-9]+$/.test(line))) return null
  return onlyPid(lines.map(line => Number(line.slice(1))))
}

function parseNetstatPid(stdout, port) {
  if (!validPort(port)) return null
  const ids = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields[0]?.toUpperCase() !== 'TCP' || fields[3]?.toUpperCase() !== 'LISTENING') continue
    const match = fields[1]?.match(/^(.*):(\d+)$/)
    if (!match || Number(match[2]) !== port) continue
    // Velorn's connection is IPv4 loopback. A listener bound solely to a
    // different interface cannot own that endpoint; IPv6 wildcard can.
    if (!['127.0.0.1', '0.0.0.0', '[::]', '[::ffff:127.0.0.1]'].includes(match[1])) continue
    if (fields.length !== 5 || !/^\d+$/.test(fields[4])) return null
    ids.push(Number(fields[4]))
  }
  return onlyPid(ids)
}

/** PID-only control is necessarily best-effort without a native process
 * handle. Fail closed if lookup/start identity is unavailable or ambiguous,
 * and recheck immediately before each signal (never blindly kill later).
 */
function createProcessSafety({ platform = process.platform, runProcess,
  readFile = fs.readFile, signal = process.kill.bind(process),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  async function findPidForPort(port) {
    if (!validPort(port)) return null
    try {
      const result = platform === 'win32'
        ? await runProcess('netstat.exe', ['-ano', '-p', 'TCP'], { timeoutMs: 5000 })
        // lsof selectors otherwise OR together. Do not add a broad -iTCP.
        : await runProcess('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeoutMs: 5000 })
      if (!result?.ok) return null
      return platform === 'win32' ? parseNetstatPid(result.stdout, port) : parseLsofPid(result.stdout)
    } catch { return null }
  }

  async function readIdentity(pid) {
    if (!validPid(pid)) return null
    try {
      if (platform === 'linux') {
        const [stat, boot] = await Promise.all([
          readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        ])
        // comm may contain spaces and parentheses. Fields after its final ')'
        // start at field 3; process start ticks are field 22.
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
        const ticks = fields[19]
        if (!/^\d+$/.test(ticks || '') || !boot.trim() || ['Z', 'X'].includes(fields[0])) return null
        return `linux:${boot.trim()}:${ticks}`
      }
      if (platform === 'darwin') {
        const result = await runProcess('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { timeoutMs: 5000 })
        const value = result?.stdout?.trim()
        return result?.ok && value && /\d{2}:\d{2}:\d{2}/.test(value) ? `darwin:${value}` : null
      }
      if (platform === 'win32') {
        const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; if ($p) { $p.CreationDate.ToUniversalTime().Ticks.ToString() }`
        const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeoutMs: 5000 })
        const value = result?.stdout?.trim()
        return result?.ok && /^\d+$/.test(value || '') ? `win32:${value}` : null
      }
    } catch { /* Missing process, permissions or utilities: do not guess. */ }
    return null
  }

  async function terminatePid(pid, { identity, verifyOwner } = {}) {
    if (!validPid(pid) || !identity || typeof verifyOwner !== 'function') throw new Error('ComfyUI process identity could not be verified.')
    const verified = async () => await verifyOwner() && await readIdentity(pid) === identity
    const originalExited = async () => {
      const current = await readIdentity(pid)
      if (current) return current !== identity
      try { signal(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
    }
    if (!await verified()) throw new Error('ComfyUI process ownership changed or could not be verified; no signal was sent.')
    if (platform === 'win32') {
      const result = await runProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 })
      if (!result?.ok) throw new Error('Could not stop the verified ComfyUI process.')
    } else {
      try { signal(pid, 'SIGTERM') } catch (error) { if (error.code === 'ESRCH') return; throw error }
      const deadline = now() + 8000
      while (now() < deadline) {
        if (await originalExited()) return // Gone/replaced: never signal that PID again.
        await sleep(200)
      }
      if (!await verified()) throw new Error('ComfyUI did not exit; forced termination was skipped because ownership is no longer verified.')
      try { signal(pid, 'SIGKILL') } catch (error) { if (error.code === 'ESRCH') return; throw error }
    }
    const deadline = now() + 2000
    while (now() < deadline) {
      if (await originalExited()) return
      await sleep(100)
    }
    throw new Error('ComfyUI has not confirmed its exit yet.')
  }
  return { findPidForPort, readIdentity, terminatePid }
}

module.exports = { createProcessSafety, parseLsofPid, parseNetstatPid }
