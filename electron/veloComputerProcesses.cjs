'use strict'

// Per-platform process metadata for Velo's private computer tools. One source
// answers two questions, with the same shape on every system:
//   table()              every visible process: pid, parent, group, state, start
//   identitiesSync(pids) the same facts for a few PIDs, synchronously, for the
//                        Stop/exit hook where nothing asynchronous may be awaited
// Metadata only: never command lines, environments or other users' files. The
// start value is an opaque identity so a recycled PID is never signalled.
// Each source also says how a command is started (shell). Windows has no
// process groups and no /proc; it uses a different guarantee, described below.
const path = require('node:path')

// Linux and macOS: bash as the leader of its own process group.
const bashShell = (command, env) => ({ file: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], env, detached: true })

// Linux: /proc/<pid>/stat. Start is the kernel start time in clock ticks.
function linuxIdentity(pid, stat) {
  if (typeof stat !== 'string' || stat.lastIndexOf(')') < 0) return null
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])
    || !Number.isSafeInteger(Number(fields[1])) || Number(fields[1]) < 0
    || !Number.isSafeInteger(Number(fields[2])) || Number(fields[2]) <= 0) return null
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] }
}
function linuxSource({ fsImpl, readFileSyncImpl }) {
  return {
    limits: {}, shell: bashShell,
    async table() {
      const table = new Map()
      table.available = false; table.unreadable = new Set()
      let entries
      try { entries = await fsImpl.readdir('/proc') } catch { return table }
      table.available = true
      await Promise.all(entries.filter(value => /^\d+$/.test(value)).map(async value => {
        try {
          const stat = await fsImpl.readFile(`/proc/${value}/stat`, 'utf8')
          const identity = linuxIdentity(Number(value), stat)
          if (identity) table.set(Number(value), identity)
          else table.unreadable.add(Number(value))
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error?.code)) table.unreadable.add(Number(value)) }
      }))
      return table
    },
    identitiesSync(pids) {
      const found = new Map()
      for (const pid of pids) {
        try {
          const identity = linuxIdentity(pid, readFileSyncImpl(`/proc/${pid}/stat`, 'utf8'))
          if (identity) found.set(pid, identity)
        } catch { /* Process already exited or the OS denied the read. */ }
      }
      return found
    },
  }
}

// macOS: the system ps. One -o per column because BSD ps reads everything
// after "=" as the header text. lstart goes last because it contains spaces.
// A fixed C locale and UTC keep the start text identical between two reads of
// the same process (no month names in another language, no daylight-saving
// jump). Start has one-second resolution, coarser than Linux.
const PS = '/bin/ps'
const PS_COLUMNS = Object.freeze(['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='])
const PS_OPTIONS = Object.freeze({ env: Object.freeze({ PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' }),
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
function parsePs(text) {
  const rows = new Map(), unreadable = new Set()
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]\S*)\s+(\S.*?)\s*$/.exec(line)
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
    const start = match?.[5].replace(/\s+/g, ' ')
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(Number(match[2]))
      || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= 0
      || !/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(start)) {
      if (Number.isSafeInteger(pid) && pid > 0) unreadable.add(pid)
      continue
    }
    rows.set(pid, { pid, state: match[4][0], parent: Number(match[2]), group: Number(match[3]), start })
  }
  return { rows, unreadable }
}
function psSource({ execFileImpl, execFileSyncImpl }) {
  // An exited-but-not-yet-collected process (state Z) is still the same
  // process. Keep reporting the start seen while it was alive, in case ps
  // prints a different start for it; its PID cannot be reused until collected.
  const lastLive = new Map()
  const settle = identity => {
    if (identity.state !== 'Z') lastLive.set(identity.pid, identity.start)
    else if (lastLive.has(identity.pid)) identity.start = lastLive.get(identity.pid)
    return identity
  }
  return {
    // Each scan starts a ps process, so scan less often than Linux reads /proc.
    limits: { treePollMs: 400 }, shell: bashShell,
    async table() {
      const table = new Map()
      table.available = false; table.unreadable = new Set()
      let text
      try {
        text = await new Promise((resolve, reject) => {
          execFileImpl(PS, ['-A', ...PS_COLUMNS], { ...PS_OPTIONS, timeout: 10000 },
            (error, stdout) => error ? reject(error) : resolve(stdout))
        })
      } catch { return table }
      const { rows, unreadable } = parsePs(text)
      // An empty listing is a failed listing: at least ps itself is running.
      if (rows.size === 0) return table
      table.available = true; table.unreadable = unreadable
      for (const identity of rows.values()) table.set(identity.pid, settle(identity))
      for (const pid of lastLive.keys()) if (!rows.has(pid)) lastLive.delete(pid)
      return table
    },
    identitiesSync(pids) {
      const wanted = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0)
      if (!wanted.length) return new Map()
      let text
      try { text = execFileSyncImpl(PS, ['-p', wanted.join(','), ...PS_COLUMNS], { ...PS_OPTIONS, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }) }
      // ps exits 1 when a listed PID has gone; what it printed is still valid.
      catch (error) { text = typeof error?.stdout === 'string' ? error.stdout : '' }
      const found = new Map()
      for (const identity of parsePs(text).rows.values()) if (wanted.includes(identity.pid)) found.set(identity.pid, settle(identity))
      return found
    },
  }
}

// Windows: containment by a job object instead of tracking.
// The command runs in Windows PowerShell 5.1 (present on every Windows 10/11).
// Before the user's command runs, a fixed start-up script puts that PowerShell
// process into a new Windows job marked "kill everything when the job closes".
// The only handle to the job lives inside that PowerShell process, and child
// programs can neither inherit it nor leave the job. So the moment the
// PowerShell process ends, by finishing, by Stop, or because Velorn itself
// ended, Windows terminates everything the command started. Velorn stops the
// shell through the process handle Node keeps, so a reused process number can
// never be hit. If the job cannot be set up, the command is not run at all.
// The user's command travels in an environment variable, never on the command
// line, so no quoting rule can change its meaning.
const WINDOWS_COMMAND_VARIABLE = 'VELORN_COMMAND'
const WINDOWS_NOT_CONTAINED_EXIT = 197
const WINDOWS_BOOTSTRAP = String.raw`
$ProgressPreference = 'SilentlyContinue'
$velornCommand = $env:${WINDOWS_COMMAND_VARIABLE}
[Environment]::SetEnvironmentVariable('${WINDOWS_COMMAND_VARIABLE}', $null)
try {
  # Load the two everyday modules by name. Otherwise the first cmdlet makes
  # PowerShell examine every installed module, which can take many seconds.
  Import-Module Microsoft.PowerShell.Utility, Microsoft.PowerShell.Management -ErrorAction Stop
  Add-Type -Namespace Velorn -Name CommandJob -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
[DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
[DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
[DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
public static bool Contain() {
  IntPtr job = CreateJobObject(IntPtr.Zero, null);
  if (job == IntPtr.Zero) return false;
  int length = IntPtr.Size == 8 ? 144 : 112;
  IntPtr info = Marshal.AllocHGlobal(length);
  for (int i = 0; i < length; i++) Marshal.WriteByte(info, i, 0);
  Marshal.WriteInt32(info, 16, 0x2000);
  bool ok = SetInformationJobObject(job, 9, info, (uint)length) && AssignProcessToJobObject(job, GetCurrentProcess());
  Marshal.FreeHGlobal(info);
  return ok;
}
'@
  if (-not [Velorn.CommandJob]::Contain()) { throw 'The Windows job could not be created.' }
} catch {
  [Console]::Error.WriteLine('Velorn could not set up its Stop guarantee for this command, so the command was NOT run. Nothing was changed. Detail: ' + $_.Exception.Message)
  exit ${WINDOWS_NOT_CONTAINED_EXIT}
}
try {
  $velornUtf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $velornUtf8
  [Console]::InputEncoding = $velornUtf8
  $OutputEncoding = $velornUtf8
} catch { }
# One extra last line records whether the command's own last statement
# succeeded; from outside the block PowerShell reports success regardless.
try { $velornBlock = [scriptblock]::Create($velornCommand + "${'`'}n" + '$global:VelornLastStatementOk = $?') } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$global:LASTEXITCODE = 0
$global:VelornLastStatementOk = $true
try { & $velornBlock } catch { [Console]::Error.WriteLine($_.ToString() + "${'`'}n" + $_.ScriptStackTrace); exit 1 }
if ($global:VelornLastStatementOk) { exit 0 }
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 1
`
const WINDOWS_ENCODED_BOOTSTRAP = Buffer.from(WINDOWS_BOOTSTRAP, 'utf16le').toString('base64')
const environmentValue = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
function windowsPowerShell(env) {
  const root = environmentValue(env, 'SystemRoot')
  const base = typeof root === 'string' && path.win32.isAbsolute(root) && !/["\0]/.test(root) ? root : 'C:\\Windows'
  return path.win32.join(base, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
function windowsSource() {
  const table = () => Object.assign(new Map(), { available: true, unreadable: new Set() })
  return {
    // contained: the tools stop the shell by its handle and rely on the job
    // for everything below it; there is no process table to scan.
    contained: true, limits: {},
    shell: (command, env) => ({ file: windowsPowerShell(env),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', WINDOWS_ENCODED_BOOTSTRAP],
      env: { ...env, [WINDOWS_COMMAND_VARIABLE]: command }, detached: false }),
    async table() { return table() },
    identitiesSync() { return new Map() },
  }
}

const SUPPORTED = Object.freeze(['linux', 'darwin', 'win32'])
function createProcessSource(platform, implementations) {
  if (platform === 'linux') return linuxSource(implementations)
  if (platform === 'darwin') return psSource(implementations)
  if (platform === 'win32') return windowsSource(implementations)
  return null
}

module.exports = { createProcessSource, SUPPORTED, parsePs, WINDOWS_BOOTSTRAP, WINDOWS_COMMAND_VARIABLE, WINDOWS_NOT_CONTAINED_EXIT }
