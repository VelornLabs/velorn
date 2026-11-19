'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const s = fs.lstatSync(dir)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('Private Velo runtime directory is not private.')
  return fs.realpathSync(dir)
}
function createDesktopRuntime({ runtimeRoot, profileRoot, spawnImpl = spawn }) {
  let verified = false
  function verify() {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('This private Velo engine preview supports Linux x64 only.')
    if (!verified) {
      const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'manifest.json')))
      if (manifest.binaries?.length !== 4) throw Error('Unexpected bundled runtime manifest.')
      for (const item of [...manifest.binaries, ...manifest.notices]) {
        if (!/^(bin|notices)\/[a-zA-Z0-9._/-]+$/.test(item.path) || item.path.includes('..')) throw Error('Invalid runtime manifest path.')
        if (hash(fs.readFileSync(path.join(runtimeRoot, item.path))) !== item.sha256) throw Error('The bundled runtime verification failed. Reinstall this preview.')
      }
      fs.accessSync('/usr/bin/bwrap', fs.constants.X_OK)
      verified = true
    }
    return true
  }
  function account(scope) {
    verify()
    const root = privateDirectory(path.join(profileRoot, 'velo-native'))
    const accountRoot = privateDirectory(path.join(root, hash(scope)))
    const engineHome = privateDirectory(path.join(accountRoot, 'runtime-home'))
    const stateDir = privateDirectory(path.join(accountRoot, 'threads'))
    const catalogs = privateDirectory(path.join(accountRoot, 'catalogs'))
    const uid = process.getuid()
    let found = false
    const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => {
      const fields = line.split(':')
      if (fields.length === 7 && Number(fields[2]) === uid) { fields[5] = engineHome; found = true; return fields.join(':') }
      return line
    }).join('\n')
    if (!found) throw Error('Cannot isolate the Velo engine home for this desktop user.')
    const passwdPath = path.join(accountRoot, 'runtime-passwd')
    // Dedicated, owned file only; never change the host passwd or Codex config.
    const temporary = passwdPath + '.' + crypto.randomUUID()
    fs.writeFileSync(temporary, passwd, { flag: 'wx', mode: 0o600 })
    try { fs.renameSync(temporary, passwdPath) } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    const spawnEngine = (executable, args, options) => {
      if (executable !== path.join(runtimeRoot, 'bin/codex') || options.env.HOME || options.env.CODEX_HOME) throw Error('Unexpected engine launch authority.')
      // Mount namespace only: no network, PID, device or filesystem capability
      // restrictions are added to Full access. Normal OS permissions still apply.
      return spawnImpl('/usr/bin/bwrap', ['--die-with-parent', '--bind', '/', '/',
        '--ro-bind', passwdPath, '/etc/passwd', '--chdir', options.cwd, '--', executable, ...args], options)
    }
    return { root: accountRoot, stateDir, catalogs, engineHome, desktopHome: os.homedir(), spawnEngine }
  }
  return { verify, account, executablePath: path.join(runtimeRoot, 'bin/codex'),
    nodePath: path.join(runtimeRoot, 'bin/node'), workerPath: path.join(runtimeRoot, 'support/veloNativeBrokerWorker.cjs') }
}
module.exports = { createDesktopRuntime, privateDirectory }
