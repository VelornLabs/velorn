'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { resolveCodexExecutable, LIMITS } = require('../electron/connectedAgentExecutable.cjs')

const signatures = { linux: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), darwin: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), win32: Buffer.from([0x4d, 0x5a, 0x90, 0]) }
const missing = () => Object.assign(new Error('Synthetic unavailable file'), { code: 'ENOENT' })

function fileSystem(platform = 'linux') {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const nodes = new Map()
  const calls = []
  const normalize = value => paths.normalize(value)
  const key = value => platform === 'win32' ? normalize(value).toLowerCase() : normalize(value)
  function add(value, node) {
    value = normalize(value)
    const parent = paths.dirname(value)
    if (parent !== value && !nodes.has(key(parent))) add(parent, { type: 'directory' })
    nodes.set(key(value), { path: value, ...node })
    return value
  }
  const native = (value, options = {}) => add(value, { type: 'file', bytes: signatures[platform], executable: true, ...options })
  const script = value => add(value, { type: 'file', bytes: Buffer.from('#!/bin/sh\necho never execute me\n'), executable: true })
  const directory = value => add(value, { type: 'directory' })
  const symlink = (value, target) => add(value, { type: 'symlink', target: normalize(target) })
  function resolve(value, depth = 0) {
    if (depth > 20) throw missing()
    value = normalize(value)
    const direct = nodes.get(key(value))
    if (direct?.type === 'symlink') return resolve(direct.target, depth + 1)
    if (direct) return direct
    let parent = paths.dirname(value)
    while (paths.dirname(parent) !== parent) {
      const ancestor = nodes.get(key(parent))
      if (ancestor?.type === 'symlink') return resolve(paths.join(ancestor.target, paths.relative(parent, value)), depth + 1)
      parent = paths.dirname(parent)
    }
    throw missing()
  }
  const fsImpl = {
    async realpath(value) { calls.push(['realpath', value]); return resolve(value).path },
    async stat(value) { calls.push(['stat', value]); const node = resolve(value); return { isFile: () => node.type === 'file', isDirectory: () => node.type === 'directory' } },
    async access(value, mode) { calls.push(['access', value, mode]); if (!resolve(value).executable) throw Object.assign(new Error('Synthetic permission failure'), { code: 'EACCES' }) },
    async open(value, flags) {
      calls.push(['open', value, flags]); const node = resolve(value)
      if (node.type !== 'file') throw missing()
      return {
        async read(buffer, offset, length, position) { calls.push(['read', value, length]); const bytesRead = node.bytes.copy(buffer, offset, position, position + length); return { bytesRead, buffer } },
        async close() { calls.push(['close', value]) },
      }
    },
    async opendir(value) {
      calls.push(['opendir', value]); const node = resolve(value)
      if (node.type !== 'directory') throw missing()
      const entries = [...nodes.values()].filter(item => key(paths.dirname(item.path)) === key(node.path) && key(item.path) !== key(node.path))
      return {
        async read() { calls.push(['directoryRead', value]); const next = entries.shift(); return next ? { name: paths.basename(next.path), isDirectory: () => next.type === 'directory' } : null },
        async close() { calls.push(['directoryClose', value]) },
      }
    },
  }
  return { fsImpl, native, script, directory, symlink, calls, platform, paths }
}

const options = (fixture, overrides = {}) => ({ platform: fixture.platform, arch: 'x64', environment: {}, homeDirectory: fixture.platform === 'win32' ? 'C:\\Users\\Creator' : '/users/creator', fsImpl: fixture.fsImpl, ...overrides })
const expected = (path, source = 'PATH', mode = 'automatic') => ({ path, source, mode })

test('Linux managed Codex is a last fallback and never supersedes PATH, common or custom choices', async () => {
  const managedPath = '/users/creator/.local/share/velorn/tools/codex/codex'
  const only = fileSystem(); only.native(managedPath)
  assert.deepEqual(await resolveCodexExecutable(options(only)), expected(managedPath, 'Velorn managed installation'))
  for (const choice of ['/chosen/codex', '/users/creator/.cargo/bin/codex', '/usr/lib/chatgpt/resources/codex']) {
    const fixture = fileSystem(); fixture.native(managedPath); fixture.native(choice)
    const found = await resolveCodexExecutable(options(fixture, { environment: { PATH: '/chosen' } }))
    assert.equal(found.path, choice)
  }
  await assert.rejects(resolveCodexExecutable(options(only, { customPath: '/missing/intentional/codex' })), { code: 'CODEX_EXECUTABLE_INVALID' })
})

test('Linux PATH native executable wins over desktop and common installations without launching anything', async () => {
  const fixture = fileSystem()
  const cli = fixture.native('/chosen/bin/codex')
  fixture.native('/usr/lib/chatgpt/resources/codex')
  fixture.native('/users/creator/.cargo/bin/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PATH: '/chosen/bin' } })), expected(cli))
  assert.ok(!fixture.calls.some(call => call[1] === '/usr/lib/chatgpt/resources/codex'))
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'read').map(call => call[2]), [4])
})

test('automatic Linux discovery works with the desktop installation and an empty GUI PATH', async () => {
  const fixture = fileSystem()
  const executable = fixture.native('/usr/lib/chatgpt/resources/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture)), expected(executable, 'Desktop app'))
})

test('automatic discovery checks existing user CLI installations after the desktop locations', async () => {
  const fixture = fileSystem()
  const executable = fixture.native('/users/creator/.cargo/bin/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture)), expected(executable, 'Common installation'))
})

test('Mac discovers both standard desktop bundle names and user Applications', async () => {
  for (const location of ['/Applications/Codex.app', '/Applications/ChatGPT.app', '/users/creator/Applications/Codex.app', '/users/creator/Applications/ChatGPT.app']) {
    const fixture = fileSystem('darwin')
    const executable = fixture.native(`${location}/Contents/Resources/codex`)
    assert.deepEqual(await resolveCodexExecutable(options(fixture)), expected(executable, 'Desktop app'))
  }
})

test('Mac discovers current nested CLI bundles for both desktop names, locations and architectures', async () => {
  for (const arch of ['arm64', 'x64']) {
    for (const location of ['/Applications/Codex.app', '/Applications/ChatGPT.app', '/users/creator/Applications/Codex.app', '/users/creator/Applications/ChatGPT.app']) {
      const fixture = fileSystem('darwin')
      const executable = fixture.native(`${location}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`)
      fixture.script(`${location}/Contents/Resources/codex-cli/bin/codex`)
      assert.deepEqual(await resolveCodexExecutable(options(fixture, { arch })), expected(executable, 'Desktop app'))
      assert.ok(!fixture.calls.some(call => call[1].includes('/codex-cli/bin/')))
      assert.ok(fixture.calls.filter(call => call[0] === 'read').every(call => call[2] === 4))
    }
  }
})

test('Mac consistently prefers the current nested native layout when a bundle contains both layouts', async () => {
  for (const customPath of ['', '/Applications/ChatGPT.app']) {
    const fixture = fileSystem('darwin')
    const executable = fixture.native('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
    const legacy = fixture.native('/Applications/ChatGPT.app/Contents/Resources/codex')
    assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath })),
      expected(executable, customPath ? 'Custom' : 'Desktop app', customPath ? 'custom' : 'automatic'))
    assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1] === legacy))
  }
})

test('Mac native standalone symlink wins over desktop bundles with a sparse GUI PATH', async () => {
  const fixture = fileSystem('darwin')
  const executable = fixture.native('/users/creator/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex')
  fixture.symlink('/users/creator/.local/bin/codex', executable)
  fixture.native('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  fixture.native('/Applications/Codex.app/Contents/Resources/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { arch: 'arm64', environment: { PATH: '/usr/bin:/bin' } })), expected(executable, 'Common installation'))
  assert.ok(!fixture.calls.some(call => call[1].startsWith('/Applications/')))
  assert.ok(!fixture.calls.some(call => call[0] === 'opendir' && call[1].includes('/.codex/')))
})

test('Mac common Homebrew and bounded nvm native CLIs precede desktop fallback', async () => {
  for (const location of ['/opt/homebrew/bin/codex', '/users/creator/.nvm/versions/node/v22.0.0/bin/codex']) {
    const fixture = fileSystem('darwin')
    const executable = fixture.native(location)
    fixture.native('/Applications/ChatGPT.app/Contents/Resources/codex')
    assert.deepEqual(await resolveCodexExecutable(options(fixture)), expected(executable, 'Common installation'))
    assert.ok(!fixture.calls.some(call => call[1].startsWith('/Applications/')))
  }
})

test('Mac PATH selection retains precedence over common CLI and desktop candidates', async () => {
  const fixture = fileSystem('darwin')
  const executable = fixture.native('/chosen/bin/codex')
  fixture.native('/users/creator/.local/bin/codex')
  fixture.native('/Applications/ChatGPT.app/Contents/Resources/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PATH: '/chosen/bin' } })), expected(executable))
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'open').map(call => call[1]), [executable])
})

test('standalone native alias is resolved again after updates without scanning release directories', async () => {
  for (const platform of ['darwin', 'linux']) {
    const fixture = fileSystem(platform)
    const alias = '/users/creator/.local/bin/codex'
    const first = fixture.native('/users/creator/.codex/packages/standalone/releases/first/bin/codex')
    const second = fixture.native('/users/creator/.codex/packages/standalone/releases/second/bin/codex')
    fixture.symlink(alias, first)
    for (const customPath of ['', alias]) {
      fixture.symlink(alias, first)
      assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath })), expected(first, customPath ? 'Custom' : 'Common installation', customPath ? 'custom' : 'automatic'))
      fixture.symlink(alias, second)
      assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath })), expected(second, customPath ? 'Custom' : 'Common installation', customPath ? 'custom' : 'automatic'))
    }
    assert.ok(!fixture.calls.some(call => call[0] === 'opendir' && call[1].includes('/.codex/')))
    assert.ok(fixture.calls.filter(call => call[0] === 'read').every(call => call[2] === 4))
  }
})

test('Mac does not discover unlinked standalone releases or interpret a standalone shell launcher', async () => {
  const fixture = fileSystem('darwin')
  const launcher = fixture.script('/users/creator/.local/bin/codex')
  const unlinked = fixture.native('/users/creator/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex')
  await assert.rejects(resolveCodexExecutable(options(fixture)), { code: 'CODEX_NOT_FOUND' })
  assert.ok(!fixture.calls.some(call => call[1] === unlinked))
  assert.ok(fixture.calls.filter(call => call[0] === 'read' && call[1] === launcher).every(call => call[2] === 4))
  assert.ok(!fixture.calls.some(call => call[0] === 'opendir' && call[1].includes('/.codex/')))
})

test('Mac Homebrew symlink resolves to its actual native executable', async () => {
  const fixture = fileSystem('darwin')
  const executable = fixture.native('/opt/homebrew/Caskroom/codex/1.2.3/codex-aarch64-apple-darwin')
  fixture.symlink('/opt/homebrew/bin/codex', executable)
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { arch: 'arm64' })), expected(executable, 'Common installation'))
})

test('Mac custom app selection resolves the bundled native CLI and does not change its source', async () => {
  const fixture = fileSystem('darwin')
  const app = '/Other Folder/Créateur Codex.app'
  const executable = fixture.native(`${app}/Contents/Resources/codex`)
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath: app })), expected(executable, 'Custom', 'custom'))
})

test('Mac custom renamed desktop bundle and nested CodexCLI.app resolve their native executable', async () => {
  const app = '/Other Folder/Créateur 工具.app'
  const nested = `${app}/Contents/Resources/codex-cli/CodexCLI.app`
  for (const customPath of [app, nested]) {
    const fixture = fileSystem('darwin')
    const executable = fixture.native(`${nested}/Contents/MacOS/codex`)
    fixture.native('/chosen/bin/codex')
    fixture.native('/users/creator/.local/bin/codex')
    assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath, environment: { PATH: '/chosen/bin' } })), expected(executable, 'Custom', 'custom'))
    assert.ok(!fixture.calls.some(call => call[1] === '/chosen/bin/codex' || call[1] === '/users/creator/.local/bin/codex'))
  }
})

test('Mac explicit desktop shell launcher is rejected even beside a valid nested native CLI', async () => {
  const fixture = fileSystem('darwin')
  const resources = '/Applications/ChatGPT.app/Contents/Resources/codex-cli'
  const launcher = fixture.script(`${resources}/bin/codex`)
  const native = fixture.native(`${resources}/CodexCLI.app/Contents/MacOS/codex`)
  await assert.rejects(resolveCodexExecutable(options(fixture, { customPath: launcher })), { code: 'CODEX_EXECUTABLE_INVALID' })
  assert.ok(!fixture.calls.some(call => call[1] === native))
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'read').map(call => call[2]), [4])
})

test('Mac custom bundle symlink updates are resolved without caching the old native target', async () => {
  const fixture = fileSystem('darwin')
  const alias = '/Other Folder/Current ChatGPT.app'
  const firstBundle = '/Installed/first/ChatGPT.app'
  const secondBundle = '/Installed/second/ChatGPT.app'
  const first = fixture.native(`${firstBundle}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`)
  const second = fixture.native(`${secondBundle}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`)
  fixture.symlink(alias, firstBundle)
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath: alias })), expected(first, 'Custom', 'custom'))
  fixture.symlink(alias, secondBundle)
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath: alias })), expected(second, 'Custom', 'custom'))
})

test('Mac missing, non-native, non-executable and excluded nested custom bundles never fall back to other installs', async () => {
  for (const invalid of ['missing', 'shell', 'wrong-platform', 'not-executable', 'excluded']) {
    const fixture = fileSystem('darwin')
    const app = '/Selected/ChatGPT.app'
    const nativePath = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
    if (invalid === 'shell') fixture.script(nativePath)
    if (invalid === 'wrong-platform') fixture.native(nativePath, { bytes: signatures.linux })
    if (invalid === 'not-executable') fixture.native(nativePath, { executable: false })
    if (invalid === 'excluded') {
      const excluded = fixture.native('/project/native/codex')
      fixture.symlink(nativePath, excluded)
    }
    fixture.native('/users/creator/.local/bin/codex')
    fixture.native('/Applications/Codex.app/Contents/Resources/codex')
    await assert.rejects(resolveCodexExecutable(options(fixture, { customPath: app, excludedRoots: ['/project'] })), { code: 'CODEX_EXECUTABLE_INVALID' })
    assert.ok(!fixture.calls.some(call => call[1] === '/users/creator/.local/bin/codex' || call[1].startsWith('/Applications/')))
    assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1].startsWith('/project/')))
  }
})

test('Mac automatic fallback skips invalid nested native candidates and uses a valid legacy layout', async () => {
  const fixture = fileSystem('darwin')
  fixture.script('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  const executable = fixture.native('/Applications/ChatGPT.app/Contents/Resources/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture)), expected(executable, 'Desktop app'))
})

test('Mac bundle discovery preserves excluded-root checks before and after symlinks', async () => {
  const fixture = fileSystem('darwin')
  fixture.native('/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  const excluded = fixture.native('/project/native/codex')
  fixture.symlink('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', excluded)
  const executable = fixture.native('/users/creator/Applications/ChatGPT.app/Contents/Resources/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { excludedRoots: ['/Applications/Codex.app', '/project'] })), expected(executable, 'Desktop app'))
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && (call[1].startsWith('/Applications/Codex.app/') || call[1].startsWith('/project/'))))
})

test('custom native executable supports spaces and Unicode and takes precedence over PATH', async () => {
  const fixture = fileSystem()
  const executable = fixture.native('/My Tools/Créateur 工具/codex custom')
  fixture.native('/path/bin/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath: executable, environment: { PATH: '/path/bin' } })), expected(executable, 'Custom', 'custom'))
  assert.ok(!fixture.calls.some(call => call[1] === '/path/bin/codex'))
})

test('invalid selected custom path never falls back to an available PATH or desktop executable', async () => {
  const fixture = fileSystem()
  fixture.native('/path/bin/codex')
  fixture.native('/usr/lib/chatgpt/resources/codex')
  for (const customPath of ['/missing/codex', '/path/bin/codex --dangerously-bypass-approvals-and-sandbox', 'codex', 'https://example.com/codex', '/path/bin/codex\u0000', '/path/bin/codex\n', null, {}]) {
    await assert.rejects(resolveCodexExecutable(options(fixture, { customPath, environment: { PATH: '/path/bin' } })), { code: 'CODEX_EXECUTABLE_INVALID' })
  }
  assert.ok(!fixture.calls.some(call => call[1] === '/path/bin/codex' || call[1] === '/usr/lib/chatgpt/resources/codex'))
})

test('relative and empty PATH entries are ignored and no current-directory search occurs', async () => {
  const fixture = fileSystem()
  const executable = fixture.native('/valid/bin/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PATH: ':.:relative/bin::/valid/bin' } })), expected(executable))
  assert.ok(fixture.calls.every(call => fixture.paths.isAbsolute(call[1])))
})

test('project and node_modules/.bin paths are excluded both before and after symlink resolution', async () => {
  const fixture = fileSystem()
  fixture.native('/project/bin/codex')
  fixture.native('/elsewhere/node_modules/.bin/codex')
  fixture.symlink('/aliases/bin/codex', '/project/bin/codex')
  fixture.symlink('/project-link', '/project')
  const executable = fixture.native('/safe/bin/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, {
    environment: { PATH: '/project/bin:/elsewhere/node_modules/.bin:/aliases/bin:/safe/bin' }, excludedRoots: ['/project-link'],
  })), expected(executable))
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1] !== executable))
})

test('a similarly named sibling is not mistakenly excluded as part of a project', async () => {
  const fixture = fileSystem()
  const executable = fixture.native('/project-tools/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PATH: '/project-tools' }, excludedRoots: ['/project'] })), expected(executable))
})

test('directory, nonexecutable, foreign-platform binary, and shell script candidates are rejected', async () => {
  const fixture = fileSystem()
  fixture.directory('/directory/codex')
  fixture.native('/no-permission/codex', { executable: false })
  fixture.native('/foreign/codex', { bytes: signatures.win32 })
  fixture.script('/script/codex')
  fixture.native('/short/codex', { bytes: Buffer.from([0x7f, 0x45]) })
  const executable = fixture.native('/valid/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PATH: '/directory:/no-permission:/foreign:/script:/short:/valid' } })), expected(executable))
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1] === '/no-permission/codex'))
})

test('POSIX npm symlink resolves the legacy fixed vendor native slot without reading the JavaScript launcher', async () => {
  const fixture = fileSystem()
  const launcher = fixture.script('/npm/lib/node_modules/@openai/codex/bin/codex.js')
  fixture.symlink('/npm/bin/codex', launcher)
  const executable = fixture.native('/npm/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PATH: '/npm/bin' } })), expected(executable))
  assert.ok(fixture.calls.filter(call => call[0] === 'read').every(call => call[2] === 4))
})

test('npm optional platform package and nested package are resolved for Mac ARM64', async () => {
  for (const scope of ['/npm/lib/node_modules/@openai', '/npm/lib/node_modules/@openai/codex/node_modules/@openai']) {
    const fixture = fileSystem('darwin')
    const launcher = fixture.script('/npm/lib/node_modules/@openai/codex/bin/codex.js')
    fixture.symlink('/npm/bin/codex', launcher)
    const executable = fixture.native(`${scope}/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`)
    assert.deepEqual(await resolveCodexExecutable(options(fixture, { arch: 'arm64', environment: { PATH: '/npm/bin' } })), expected(executable))
  }
})

test('Windows normalizes PATH environment-key casing and supports quoted Unicode path entries', async () => {
  const fixture = fileSystem('win32')
  const executable = fixture.native('C:\\Creator Tools\\映像\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { Path: ';relative;"C:\\Creator Tools\\映像"' } })), expected(executable))
  assert.equal(fixture.calls.filter(call => call[0] === 'access').length, 0)
})

test('Windows npm codex.cmd returns adjacent native .exe, never the batch file', async () => {
  const fixture = fileSystem('win32')
  fixture.script('C:\\Users\\Creator\\AppData\\Roaming\\npm\\codex.cmd')
  const executable = fixture.native('C:\\Users\\Creator\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { pAtH: 'C:\\Users\\Creator\\AppData\\Roaming\\npm' } })), expected(executable))
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1].endsWith('.cmd')))
})

test('a custom Windows npm shim uses the same native resolution without fallback', async () => {
  const fixture = fileSystem('win32')
  const shim = fixture.script('D:\\Npm Tools\\codex.cmd')
  const executable = fixture.native('D:\\Npm Tools\\node_modules\\@openai\\codex\\vendor\\aarch64-pc-windows-msvc\\codex\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { customPath: shim, arch: 'arm64' })), expected(executable, 'Custom', 'custom'))
})

test('Windows rejects arbitrary scripts, renamed batch files, and drive-relative paths', async () => {
  const fixture = fileSystem('win32')
  fixture.script('C:\\Tools\\codex.cmd')
  fixture.native('C:\\Tools\\native-looking.cmd')
  fixture.script('C:\\Tools\\codex.exe')
  for (const customPath of ['C:\\Tools\\codex.cmd', 'C:\\Tools\\native-looking.cmd', 'C:\\Tools\\codex.exe', 'C:codex.exe', '\\Tools\\codex.exe', '\\\\?\\C:\\Tools\\codex.exe']) {
    await assert.rejects(resolveCodexExecutable(options(fixture, { customPath })), { code: 'CODEX_EXECUTABLE_INVALID' })
  }
})

test('Windows discovers the per-user desktop app with case-insensitive environment keys', async () => {
  const fixture = fileSystem('win32')
  const executable = fixture.native('D:\\Profile Data\\Local\\Programs\\Codex\\resources\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { localappdata: 'D:\\Profile Data\\Local' } })), expected(executable, 'Desktop app'))
})

test('Windows finds bounded app-version directories and handles an inaccessible Windows Store directory', async () => {
  const fixture = fileSystem('win32')
  const executable = fixture.native('C:\\Users\\Creator\\AppData\\Local\\Codex\\app-1.20.0\\resources\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { PROGRAMFILES: 'C:\\Program Files' } })), expected(executable, 'Desktop app'))
})

test('Windows Store discovery only inspects bounded known product names, not arbitrary applications', async () => {
  const fixture = fileSystem('win32')
  fixture.native('C:\\Program Files\\WindowsApps\\OtherApp_1.0_x64\\app\\resources\\codex.exe')
  const executable = fixture.native('C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3_x64__example\\app\\resources\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { ProgramFiles: 'C:\\Program Files' } })), expected(executable, 'Desktop app'))
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1].includes('OtherApp')))
})

test('Windows project-root exclusions are case-insensitive', async () => {
  const fixture = fileSystem('win32')
  fixture.native('C:\\Project\\bin\\codex.exe')
  const executable = fixture.native('C:\\Safe\\codex.exe')
  assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment: { Path: 'c:\\PROJECT\\bin;C:\\Safe' }, excludedRoots: ['C:\\project'] })), expected(executable))
})

test('Windows discovers the official standalone native bin in LOCALAPPDATA or its home fallback', async () => {
  for (const environment of [{ LOCALAPPDATA: 'D:\\Local Profile' }, {}]) {
    const fixture = fileSystem('win32')
    const local = environment.LOCALAPPDATA || 'C:\\Users\\Creator\\AppData\\Local'
    const executable = fixture.native(`${local}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`)
    assert.deepEqual(await resolveCodexExecutable(options(fixture, { environment })), expected(executable, 'Common installation'))
    assert.ok(fixture.calls.filter(call => call[0] === 'read').every(call => call[2] === 4))
  }
})

test('Windows standalone discovery does not run wrappers or accept non-PE candidates', async () => {
  const fixture = fileSystem('win32')
  const bin = 'C:\\Users\\Creator\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin'
  fixture.script(`${bin}\\codex.cmd`)
  fixture.native(`${bin}\\codex.exe`, { bytes: signatures.linux })
  await assert.rejects(resolveCodexExecutable(options(fixture)), { code: 'CODEX_NOT_FOUND' })
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1].endsWith('.cmd')))
})

test('bounded nvm installation scan chooses the newest matching version without scanning unrelated directories', async () => {
  const fixture = fileSystem()
  fixture.native('/users/creator/.nvm/versions/node/v9.0.0/bin/codex')
  const executable = fixture.native('/users/creator/.nvm/versions/node/v22.0.0/bin/codex')
  fixture.native('/users/creator/.nvm/versions/node/unrelated/bin/codex')
  assert.deepEqual(await resolveCodexExecutable(options(fixture)), expected(executable, 'Common installation'))
  assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1].includes('unrelated')))
})

test('missing installation returns a stable error without leaking low-level filesystem details', async () => {
  const fixture = fileSystem()
  await assert.rejects(resolveCodexExecutable(options(fixture)), error => error.code === 'CODEX_NOT_FOUND' && !error.message.includes('Synthetic'))
  assert.equal(fixture.calls.filter(call => call[0] === 'open').length, 0)
})

test('automatic discovery bounds PATH and directory entry scanning', async () => {
  const fixture = fileSystem()
  fixture.native('/beyond-limit/codex')
  for (let count = 0; count < LIMITS.directoryEntries + 10; count++) fixture.directory(`/users/creator/.nvm/versions/node/unrelated-${count}`)
  const environment = { PATH: [...Array.from({ length: LIMITS.pathEntries }, (_, index) => `/absent-${index}`), '/beyond-limit'].join(':') }
  await assert.rejects(resolveCodexExecutable(options(fixture, { environment })), { code: 'CODEX_NOT_FOUND' })
  assert.ok(!fixture.calls.some(call => call[1] === '/beyond-limit/codex'))
  assert.equal(fixture.calls.filter(call => call[0] === 'directoryRead').length, LIMITS.directoryEntries)
  assert.equal(fixture.calls.filter(call => call[0] === 'directoryClose').length, 1)
})

test('already-aborted discovery performs no filesystem operations', async () => {
  const fixture = fileSystem()
  const controller = new AbortController(); controller.abort()
  await assert.rejects(resolveCodexExecutable(options(fixture, { signal: controller.signal })), { code: 'CANCELLED' })
  assert.equal(fixture.calls.length, 0)
})

test('aborting a pending filesystem call returns immediately and closes a late-opened handle', async () => {
  const fixture = fileSystem()
  const executable = fixture.native('/path/codex')
  const controller = new AbortController()
  let releaseOpen
  let enteredOpen
  const opened = new Promise(resolve => { enteredOpen = resolve })
  const originalOpen = fixture.fsImpl.open
  fixture.fsImpl.open = async (...args) => {
    enteredOpen()
    await new Promise(resolve => { releaseOpen = resolve })
    return originalOpen(...args)
  }
  const pending = resolveCodexExecutable(options(fixture, { customPath: executable, signal: controller.signal }))
  await opened
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  releaseOpen()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.calls.filter(call => call[0] === 'close').length, 1)
  assert.equal(fixture.calls.filter(call => call[0] === 'read').length, 0)
})
