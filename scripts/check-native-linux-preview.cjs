'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const resources = path.join(root, 'release/linux-unpacked/resources')
const archive = path.join(resources, 'app.asar')
const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
const actual = JSON.parse(asar.extractFile(archive, 'package.json'))
assert.equal(actual.name, 'velorn'); assert.equal(actual.version, expected.version)
const modules = ['main.js', 'remoteCompanionGuided.cjs', 'connectedAgentLuna.cjs', 'veloDesktopEngine.cjs',
  'veloDesktopRuntime.cjs', 'veloDesktopBroker.cjs', 'veloDesktopGateway.cjs', 'veloNativeBroker.cjs',
  'veloNativeBrokerWorker.cjs', 'veloEngineTurn.cjs', 'veloCodexEngine.cjs', 'veloAdmissionWait.cjs']
for (const name of modules) assert.deepEqual(asar.extractFile(archive, 'electron/' + name), fs.readFileSync(path.join(root, 'electron', name)), name)
const files = asar.listPackage(archive)
assert.ok(!files.some(file => /(^|\/)(phone-account\.json|auth\.json|\.env|launch\.json|candidate-isolation\.json)$/.test(file)))
assert.ok(!files.some(file => /veloEngineCandidate\.cjs$|veloCandidateGatewayClient\.cjs$|veloOwnerTestGateway\.cjs$/.test(file)))
assert.equal(fs.existsSync(path.join(resources, 'velo-candidate-gateway')), false)
const runtime = path.join(resources, 'velo-codex-runtime')
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json')))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
for (const item of [...manifest.binaries, ...manifest.notices]) assert.equal(hash(path.join(runtime, item.path)), item.sha256, item.path)
for (const name of ['veloNativeBroker.cjs', 'veloNativeBrokerWorker.cjs', 'veloAdmissionWait.cjs'])
  assert.equal(hash(path.join(runtime, 'support', name)), hash(path.join(root, 'electron', name)), name)
assert.deepEqual(fs.readdirSync(runtime).sort(), ['bin', 'manifest.json', 'notices', 'support'])
for (const file of files.filter(file => file.startsWith('/dist/') && !file.endsWith('/'))) {
  const source = path.join(root, file.slice(1))
  if (fs.existsSync(source) && fs.statSync(source).isFile()) assert.deepEqual(asar.extractFile(archive, file.slice(1)), fs.readFileSync(source), file)
}
const deb = path.join(root, 'release/Velorn-' + expected.version + '-linux-amd64.deb')
const field = name => execFileSync('dpkg-deb', ['--field', deb, name], { encoding: 'utf8' }).trim()
assert.equal(field('Package'), 'velorn'); assert.equal(field('Architecture'), 'amd64')
assert.match(field('Depends'), /\bbubblewrap\b/)
const icons = fs.readFileSync(path.join(root, '../package-contents.txt'), 'utf8').split('\n').filter(line => /\/usr\/share\/icons\/.*\/velorn\.png$/.test(line))
assert.ok(icons.length >= 9)
assert.ok(icons.every(line => line.startsWith('-rw-r--r--')))
console.log(JSON.stringify({ passed: true, version: actual.version, architecture: field('Architecture'),
  matchedNativeModules: modules.length, runtimeBinaries: manifest.binaries.length, runtimeNotices: manifest.notices.length,
  readableInstalledIcons: icons.length, isolatedFixtureAbsent: true, installed: false, uploaded: false, paidRequests: 0 }, null, 2))
