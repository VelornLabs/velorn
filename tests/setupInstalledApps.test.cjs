'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const pathModule = require('node:path')
const { createSetupInstalledApps } = require('../electron/setupInstalledApps.cjs')
const payload = { integration: 'lmstudio' }
const live = { isCurrent: () => true }

function fixture(options = {}) {
  const platform = options.platform || 'linux'
  const path = platform === 'win32' ? pathModule.win32 : pathModule.posix
  const home = platform === 'win32' ? 'C:\\Users\\test' : '/home/test'
  const entries = new Map(), aliases = new Map(), reads = [], launches = [], confirmations = []
  let ino = 0
  const error = code => Object.assign(new Error('PRIVATE_SECRET'), { code })
  const lookup = value => {
    const item = entries.get(aliases.get(value) || value)
    if (!item) throw error('ENOENT')
    if (item.error) throw error(item.error)
    return item
  }
  const dir = value => {
    if (!entries.has(value)) entries.set(value, { directory: true, mode: 0o755, uid: 1000, ino: ++ino, mtimeMs: 1, data: Buffer.alloc(0) })
    const parent = path.dirname(value)
    if (parent !== value) dir(parent)
  }
  const file = (value, content = Buffer.from('7f454c46', 'hex'), metadata = {}) => {
    dir(path.dirname(value))
    entries.set(value, { directory: false, mode: 0o755, uid: 1000, ino: ++ino, mtimeMs: 1, data: Buffer.from(content), ...metadata })
  }
  const desktop = (target, extra = '', filename = path.join(home, '.local/share/applications/lmstudio.desktop')) => {
    file(filename, `[Desktop Entry]\nType=Application\nName=LM Studio\nExec=${target}\n${extra}`, { mode: 0o644 })
  }
  const fs = {
    realpath: async value => { reads.push(['realpath', value]); lookup(value); return aliases.get(value) || value },
    stat: async value => {
      reads.push(['stat', value]); const item = lookup(value)
      return { ...item, size: item.data.length, dev: 1, isDirectory: () => item.directory, isFile: () => !item.directory }
    },
    open: async value => {
      reads.push(['open', value]); const item = lookup(value)
      return { read: async (buffer, offset, length, position) => ({ bytesRead: item.data.copy(buffer, offset, position, position + length) }), close: async () => {} }
    },
    opendir: async value => {
      reads.push(['opendir', value]); const item = lookup(value)
      if (!item.directory) throw error('ENOTDIR')
      const children = [...entries.keys()].filter(key => key !== value && path.dirname(key) === value)
      let index = 0
      return { read: async () => index < children.length ? { name: path.basename(children[index++]) } : null, close: async () => {} }
    },
  }
  const spawn = (command, args, config) => {
    launches.push({ command, args, config })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => child.emit(options.spawnError ? 'error' : 'spawn', new Error('PRIVATE_SECRET')))
    return child
  }
  dir(home)
  const setup = createSetupInstalledApps({ app: { getPath: name => name === 'home' ? home : path.join(home, 'AppData', 'Roaming') }, platform, fs, spawn,
    environment: { HOME: home, DISPLAY: ':1', PATH: '/usr/bin', OPENAI_API_KEY: 'PRIVATE_SECRET', VELORN_SETUP_OPENAI_API_KEY: 'PRIVATE_SECRET',
      NODE_OPTIONS: 'PRIVATE_SECRET', ELECTRON_RUN_AS_NODE: '1', AWS_SECRET_ACCESS_KEY: 'PRIVATE_SECRET' }, getUid: () => 1000,
    confirmOpen: async request => { confirmations.push(request); return options.confirm ? options.confirm(request) : true },
    chooseExecutable: async () => options.choose?.(),
  })
  return { setup, entries, aliases, reads, launches, confirmations, file, dir, desktop, home, path }
}

test('construction is passive and payload rejects path, integration and shell argument injection', async () => {
  const f = fixture()
  assert.deepEqual(f.reads, [])
  for (const value of [null, [], {}, { integration: 'codex' }, { ...payload, path: '/tmp/a' }, { ...payload, args: ['--no-sandbox'] }]) {
    assert.equal((await f.setup.inspect(value)).state, 'unknown')
    assert.equal((await f.setup.open(value, live)).status, 'unavailable')
    assert.equal((await f.setup.choose(value, live)).status, 'unavailable')
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.launches, [])
})

test('missing installation is bounded not-found, not proof of absent app or stopped server', async () => {
  const f = fixture()
  const status = await f.setup.inspect(payload)
  assert.equal(status.state, 'not_found'); assert.equal(status.canOpen, false)
  assert.match(status.summary, /may be installed elsewhere/)
  assert.ok(f.reads.every(([, value]) => !/\.config|auth|credentials|models/i.test(value)))
  assert.deepEqual(f.launches, [])
})

test('Linux AppImage discovery is read-only and exposes no path or startup assumption', async () => {
  const f = fixture()
  f.file('/home/test/Applications/LM-Studio-0.4.0-x64.AppImage')
  const status = await f.setup.inspect(payload)
  assert.equal(status.state, 'found'); assert.equal(status.canOpen, true)
  assert.doesNotMatch(JSON.stringify(status), /\/home|PRIVATE_SECRET/)
  assert.match(status.summary, /does not tell us whether its server is running/)
  assert.deepEqual(f.launches, []); assert.deepEqual(f.confirmations, [])
})

test('known Linux package binaries do not require unbounded enumeration of system bin', async () => {
  const f = fixture()
  f.file('/usr/bin/lm-studio')
  for (let index = 0; index < 300; index++) f.file(`/usr/bin/other-${index}`)
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
  assert.equal(f.reads.some(([operation, value]) => operation === 'opendir' && value === '/usr/bin'), false)
})

test('validated desktop file discovers a custom-location AppImage with unused file placeholder', async () => {
  const f = fixture()
  const target = '/home/test/Custom Apps/LM-Studio-0.4.AppImage'
  f.file(target); f.desktop(`"${target}" %U`)
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
  const status = await f.setup.open(payload, live)
  assert.equal(status.status, 'opened')
  assert.equal(f.launches[0].command, target); assert.deepEqual(f.launches[0].args, [])
})

test('desktop shell/env wrappers, custom arguments and malformed duplicate entries are never launched', async () => {
  for (const exec of ['env /home/test/custom/LM-Studio.AppImage', 'sh -c /home/test/custom/LM-Studio.AppImage',
    '/home/test/custom/LM-Studio.AppImage --no-sandbox', '/home/test/custom/LM-Studio.AppImage /private/model.gguf',
    '/home/test/custom/LM-Studio.AppImage;touch /tmp/x', '"/home/test/custom/LM-Studio.AppImage" %k',
    '"/home/test/custom/LM-Studio.AppImage"\nExec=/home/test/custom/LM-Studio.AppImage']) {
    const f = fixture(); f.file('/home/test/custom/LM-Studio.AppImage'); f.desktop(exec)
    assert.equal((await f.setup.inspect(payload)).canOpen, false, exec)
    assert.equal((await f.setup.open(payload, live)).status, 'unavailable', exec)
    assert.deepEqual(f.launches, [])
  }
})

test('inspection never invokes lms even when a CLI exists', async () => {
  const f = fixture(); f.file('/usr/bin/lms')
  assert.equal((await f.setup.inspect(payload)).state, 'not_found')
  assert.equal(f.reads.some(([, value]) => /\/lms$/.test(value)), false)
  assert.deepEqual(f.launches, [])
})

test('ambiguous installations refuse launch and deduplicated canonical symlink is one candidate', async () => {
  const f = fixture()
  f.file('/home/test/Applications/LM-Studio-1.AppImage'); f.file('/home/test/Applications/LM-Studio-2.AppImage')
  assert.equal((await f.setup.inspect(payload)).canOpen, false)
  assert.equal((await f.setup.open(payload, live)).status, 'unavailable')
  assert.deepEqual(f.confirmations, [])
  f.entries.delete('/home/test/Applications/LM-Studio-2.AppImage')
  f.aliases.set('/usr/bin/lm-studio', '/home/test/Applications/LM-Studio-1.AppImage')
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
})

test('untrusted metadata, shell scripts and unsupported binary formats are not launchable', async () => {
  for (const [contents, metadata] of [['#!/bin/sh\ntouch /tmp/a', {}], [Buffer.from('7f454c46', 'hex'), { mode: 0o777 }],
    [Buffer.from('7f454c46', 'hex'), { uid: 12345 }], [Buffer.from('7f454c46', 'hex'), { mode: 0o644 }],
    [Buffer.from('7f454c46', 'hex'), { mode: 0o4755 }]]) {
    const f = fixture(); f.file('/usr/bin/lm-studio', contents, metadata)
    assert.equal((await f.setup.inspect(payload)).canOpen, false)
    assert.equal((await f.setup.open(payload, live)).status, 'unavailable')
    assert.deepEqual(f.launches, [])
  }
})

test('world-writable ancestor and oversized desktop metadata are refused', async () => {
  const f = fixture(); f.file('/home/test/Applications/LM-Studio.AppImage')
  f.entries.get('/home/test/Applications').mode = 0o777
  assert.equal((await f.setup.inspect(payload)).canOpen, false)
  const g = fixture(); g.desktop('/home/test/custom/LM-Studio.AppImage', `#${'x'.repeat(33000)}`)
  assert.equal((await g.setup.inspect(payload)).state, 'unknown')
  assert.equal(g.reads.some(([kind]) => kind === 'open'), false)
})

test('incomplete directory search and permission failures report uncertainty without error/path leakage', async () => {
  const f = fixture()
  f.dir('/home/test/Applications'); f.entries.get('/home/test/Applications').error = 'EACCES'
  const status = await f.setup.inspect(payload)
  assert.equal(status.state, 'unknown'); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_SECRET|\/home/)
  const g = fixture()
  for (let index = 0; index < 300; index++) g.file(`/home/test/Downloads/file-${index}`)
  assert.equal((await g.setup.inspect(payload)).state, 'unknown')
  assert.equal(g.reads.filter(([kind]) => kind === 'open').length, 0)
})

test('incomplete unrelated inventory does not block explicit confirmation of one validated application', async () => {
  const f = fixture()
  f.file('/usr/bin/lm-studio')
  for (let index = 0; index < 300; index++) f.file(`/home/test/Downloads/file-${index}`)
  f.dir('/usr/share/applications'); f.entries.get('/usr/share/applications').error = 'EACCES'
  const status = await f.setup.inspect(payload)
  assert.equal(status.state, 'found'); assert.equal(status.canOpen, true)
  assert.match(status.summary, /Some other locations or launchers could not be checked/)
  assert.doesNotMatch(status.summary, /only installation/)
  assert.equal((await f.setup.open(payload, live)).status, 'opened')
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.confirmations[0].path, '/usr/bin/lm-studio')
  assert.equal(f.launches[0].command, '/usr/bin/lm-studio')
  assert.deepEqual(f.launches[0].args, [])
})

test('unsafe desktop metadata is never executed when a separate validated app is explicitly approved', async () => {
  const f = fixture()
  f.file('/usr/bin/lm-studio')
  f.desktop('sh -c /home/test/custom/LM-Studio.AppImage')
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
  assert.equal((await f.setup.open(payload, live)).status, 'opened')
  assert.equal(f.confirmations[0].path, '/usr/bin/lm-studio')
  assert.equal(f.launches[0].command, '/usr/bin/lm-studio')
  assert.deepEqual(f.launches[0].args, [])
})

test('launch requires current view plus explicit native confirmation', async () => {
  const f = fixture({ confirm: async () => false }); f.file('/usr/bin/lm-studio')
  assert.equal((await f.setup.open(payload)).status, 'stale')
  assert.equal((await f.setup.open(payload, { isCurrent: () => false })).status, 'stale')
  assert.equal((await f.setup.open(payload, live)).status, 'cancelled')
  assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].path, '/usr/bin/lm-studio')
  assert.deepEqual(f.launches, [])
})

test('replacement while confirmation is visible fails closed', async () => {
  let f
  f = fixture({ confirm: async () => { f.file('/usr/bin/lm-studio'); return true } }); f.file('/usr/bin/lm-studio')
  assert.equal((await f.setup.open(payload, live)).status, 'changed')
  assert.deepEqual(f.launches, [])
})

test('new ambiguous candidate after confirmation fails closed', async () => {
  let f
  f = fixture({ confirm: async () => { f.file('/home/test/Applications/LM-Studio-2.AppImage'); return true } })
  f.file('/usr/bin/lm-studio')
  assert.equal((await f.setup.open(payload, live)).status, 'changed')
  assert.deepEqual(f.launches, [])
})

test('closing setup during native confirmation prevents launch', async () => {
  let active = true
  const f = fixture({ confirm: async () => { active = false; return true } }); f.file('/usr/bin/lm-studio')
  assert.equal((await f.setup.open(payload, { isCurrent: () => active })).status, 'stale')
  assert.deepEqual(f.launches, [])
})

test('launch sends no model or server flags and strips secret/Node/Electron environment variables', async () => {
  const f = fixture(); f.file('/usr/bin/lm-studio')
  const status = await f.setup.open(payload, live)
  assert.equal(status.status, 'opened'); assert.equal(status.ok, true)
  assert.match(status.summary, /existing startup preferences/)
  const { command, args, config } = f.launches[0]
  assert.equal(command, '/usr/bin/lm-studio'); assert.deepEqual(args, [])
  assert.equal(config.shell, false); assert.equal(config.stdio, 'ignore')
  assert.equal(config.cwd, '/usr/bin')
  assert.deepEqual(config.env, { HOME: '/home/test', PATH: '/usr/bin', DISPLAY: ':1' })
  assert.doesNotMatch(JSON.stringify([status, config]), /PRIVATE_SECRET|no-sandbox|NODE_OPTIONS/)
})

test('spawn errors are sanitized and do not report readiness', async () => {
  const f = fixture({ spawnError: true }); f.file('/usr/bin/lm-studio')
  const status = await f.setup.open(payload, live)
  assert.equal(status.status, 'failed'); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_SECRET|\/usr\/bin/)
})

test('chooser keeps an exact app in RAM without launch; later opening still confirms', async () => {
  const chosen = '/home/test/Custom Apps/LM-Studio.AppImage'
  const f = fixture({ choose: async () => chosen }); f.file(chosen)
  assert.equal((await f.setup.inspect(payload)).state, 'not_found')
  assert.equal((await f.setup.choose(payload, live)).status, 'selected')
  assert.deepEqual(f.launches, []); assert.deepEqual(f.confirmations, [])
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
  assert.equal((await f.setup.open(payload, live)).status, 'opened')
  assert.equal(f.confirmations.length, 1)
  f.file(chosen)
  assert.equal((await f.setup.inspect(payload)).canOpen, false)
  assert.equal((await f.setup.open(payload, live)).status, 'unavailable')
})

test('chooser rejects installers, unrelated executables, commands and cancelled/stale selection', async () => {
  for (const chosen of [null, '/home/test/Downloads/LM-Studio-Installer.sh', '/usr/bin/bash', 'lm-studio --server']) {
    const f = fixture({ choose: async () => chosen })
    if (chosen?.startsWith('/')) f.file(chosen)
    assert.equal((await f.setup.choose(payload, live)).status, chosen ? 'unavailable' : 'cancelled')
    assert.deepEqual(f.launches, [])
  }
  let active = true
  const g = fixture({ choose: async () => { active = false; return '/usr/bin/lm-studio' } }); g.file('/usr/bin/lm-studio')
  assert.equal((await g.setup.choose(payload, { isCurrent: () => active })).status, 'stale')
})

test('concurrent native launch/selection is blocked while confirmation is outstanding', async () => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const f = fixture({ confirm: async () => { entered(); return new Promise(resolve => { release = resolve }) } }); f.file('/usr/bin/lm-studio')
  const first = f.setup.open(payload, live); await waiting
  assert.equal((await f.setup.open(payload, live)).status, 'busy')
  assert.equal((await f.setup.choose(payload, live)).status, 'busy')
  release(false); await first
})

test('macOS validated app bundle uses fixed OS launcher, never executable arguments', async () => {
  const f = fixture({ platform: 'darwin' })
  f.file('/Applications/LM Studio.app/Contents/MacOS/LM Studio', Buffer.from('cffaedfe', 'hex'))
  // The system Applications directory is normally administrator-writable.
  Object.assign(f.entries.get('/Applications'), { mode: 0o775, uid: 0 })
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
  assert.equal((await f.setup.open(payload, live)).status, 'opened')
  assert.equal(f.launches[0].command, '/usr/bin/open')
  assert.deepEqual(f.launches[0].args, ['-a', '/Applications/LM Studio.app'])
})

test('Windows known per-user installation checks local executable header', async () => {
  const f = fixture({ platform: 'win32' })
  const target = 'C:\\Users\\test\\AppData\\Local\\Programs\\LM Studio\\LM Studio.exe'
  f.file(target, 'MZ00')
  assert.equal((await f.setup.inspect(payload)).canOpen, true)
  assert.equal((await f.setup.open(payload, live)).status, 'opened')
  assert.equal(f.launches[0].command, target); assert.deepEqual(f.launches[0].args, [])
})

test('Windows chooser refuses UNC/device paths and installer-shaped filenames', async () => {
  for (const chosen of ['\\\\server\\share\\LM Studio.exe', '\\\\?\\C:\\Apps\\LM Studio.exe', 'C:\\Downloads\\LM-Studio-0.4.0-x64.exe']) {
    const f = fixture({ platform: 'win32', choose: async () => chosen }); f.file(chosen, 'MZ00')
    assert.equal((await f.setup.choose(payload, live)).status, 'unavailable')
    assert.deepEqual(f.launches, [])
  }
})

test('unsupported platform reports unknown without scanning or launching', async () => {
  const f = fixture({ platform: 'freebsd' })
  assert.equal((await f.setup.inspect(payload)).state, 'unknown')
  assert.deepEqual(f.reads, []); assert.deepEqual(f.launches, [])
})
