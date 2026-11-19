const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepareLinuxIcons, verifyDebIconListing, verifyDebIcons } = require('../scripts/linux-icon-permissions.cjs')
const completed = require('../scripts/electron-builder-artifact-completed.cjs')
const { execFileSync } = require('node:child_process')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-icon-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'build/icons'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, 'build/icons/256x256.png'), 'unchanged artwork', { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'private-input'), 'unchanged private input', { mode: 0o600 })
  return root
}

const icon = mode => `${mode} 0/0 12 2026-11-03 00:00 ./usr/share/icons/hicolor/256x256/apps/velorn.png`
const launcher = '-rw-r--r-- 0/0 12 2026-11-03 00:00 ./usr/share/applications/velorn.desktop'

test('normalizes only public Linux artwork; content and unrelated permissions unchanged', t => {
  const root = fixture(t)
  assert.deepEqual(prepareLinuxIcons(root, 'linux'), ['256x256.png'])
  assert.equal(fs.statSync(path.join(root, 'build/icons')).mode & 0o777, 0o755)
  const file = path.join(root, 'build/icons/256x256.png')
  assert.equal(fs.statSync(file).mode & 0o777, 0o644)
  assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged artwork')
  assert.equal(fs.statSync(path.join(root, 'private-input')).mode & 0o777, 0o600)
  assert.deepEqual(prepareLinuxIcons(root, 'linux'), ['256x256.png'])
})

test('Mac and Windows packaging do not inspect or modify Linux files', () => {
  assert.deepEqual(prepareLinuxIcons('/does-not-exist', 'darwin'), [])
  assert.deepEqual(prepareLinuxIcons('/does-not-exist', 'win32'), [])
})

test('rejects missing or empty icon inputs', t => {
  const root = fixture(t)
  fs.unlinkSync(path.join(root, 'build/icons/256x256.png'))
  assert.throws(() => prepareLinuxIcons(root, 'linux'), /No Linux PNG/)
  assert.throws(() => prepareLinuxIcons('/does-not-exist', 'linux'), /ENOENT/)
})

test('rejects icon symlinks and hardlinks without modifying their targets', t => {
  const root = fixture(t)
  const name = path.join(root, 'build/icons/128x128.png')
  const target = path.join(root, 'private-input')
  fs.symlinkSync(target, name)
  assert.throws(() => prepareLinuxIcons(root, 'linux'), /regular, unlinked/)
  fs.unlinkSync(name)
  fs.linkSync(target, name)
  assert.throws(() => prepareLinuxIcons(root, 'linux'), /regular, unlinked/)
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
})

test('rejects linked icon directory', t => {
  const root = fixture(t)
  fs.renameSync(path.join(root, 'build/icons'), path.join(root, 'build/original'))
  fs.symlinkSync(path.join(root, 'build/original'), path.join(root, 'build/icons'))
  assert.throws(() => prepareLinuxIcons(root, 'linux'), /real directory/)
})

test('finished package gate rejects the reported 0600 regression', () => {
  assert.throws(() => verifyDebIconListing(`${icon('-rw-------')}\n${launcher}`, ['256x256.png']), /unreadable/)
  assert.deepEqual(verifyDebIconListing(`${icon('-rw-r--r--')}\n${launcher}`, ['256x256.png']), ['256x256.png'])
})

test('finished package gate rejects missing/duplicate icons and missing/unreadable launcher', () => {
  assert.throws(() => verifyDebIconListing(launcher, ['256x256.png']), /inventory/)
  assert.throws(() => verifyDebIconListing(`${icon('-rw-r--r--')}\n${launcher}`, ['128x128.png']), /inventory/)
  assert.throws(() => verifyDebIconListing(`${icon('-rw-r--r--')}\n${icon('-rw-r--r--')}\n${launcher}`, ['256x256.png']), /inventory/)
  assert.throws(() => verifyDebIconListing(icon('-rw-r--r--'), ['256x256.png']), /missing.*launcher/)
  assert.throws(() => verifyDebIconListing(`${icon('-rw-r--r--')}\n${launcher.replace('-rw-r--r--', '-rw-------')}`, ['256x256.png']), /unreadable/)
})

test('artifact hook leaves other platforms untouched', async () => {
  for (const file of ['Velorn.dmg', 'Velorn.exe', 'Velorn.AppImage']) await completed({ file })
})

test('real DEB hook fails private icons and passes readable icons', { skip: process.platform !== 'linux' }, async t => {
  const root = fixture(t)
  const debRoot = path.join(root, 'deb-root')
  const control = path.join(debRoot, 'DEBIAN')
  const iconDir = path.join(debRoot, 'usr/share/icons/hicolor/256x256/apps')
  const desktopDir = path.join(debRoot, 'usr/share/applications')
  for (const dir of [control, iconDir, desktopDir]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(control, 'control'), 'Package: velorn-icon-test\nVersion: 1.0\nArchitecture: all\nMaintainer: Velorn <opensource@velorn.ai>\nDescription: disposable icon permissions regression fixture\n')
  fs.writeFileSync(path.join(iconDir, 'velorn.png'), 'fixture', { mode: 0o600 })
  fs.writeFileSync(path.join(desktopDir, 'velorn.desktop'), '[Desktop Entry]\nIcon=velorn\n', { mode: 0o644 })
  const file = path.join(root, 'fixture.deb')
  const build = () => execFileSync('dpkg-deb', ['--build', '--root-owner-group', debRoot, file], { stdio: 'pipe' })
  build()
  await assert.rejects(completed({ file, packager: { projectDir: root } }), /unreadable/)
  fs.chmodSync(path.join(iconDir, 'velorn.png'), 0o644)
  build()
  await completed({ file, packager: { projectDir: root } })
  assert.deepEqual(verifyDebIcons(file, ['256x256.png']), ['256x256.png'])
})

test('packaging configuration wires both prevention and finished-artifact gate', () => {
  const root = path.join(__dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.build.artifactBuildCompleted, 'scripts/electron-builder-artifact-completed.cjs')
  assert.match(fs.readFileSync(path.join(root, pkg.build.beforePack), 'utf8'), /prepareLinuxIcons\(context\.packager\.projectDir, platform\)/)
})
