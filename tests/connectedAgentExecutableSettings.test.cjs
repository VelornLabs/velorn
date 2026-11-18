'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createCodexExecutableAccess } = require('../electron/connectedAgentExecutableSettings.cjs')

function fixture({ initial = '', selected = '/trusted/Codex.app', resolveError, writeWait } = {}) {
  let value = initial, picks = 0; const resolutions = [], writes = []
  const access = createCodexExecutableAccess({
    readCustomPath: async () => value,
    writeCustomPath: async (next, options) => {
      if (writeWait) await writeWait()
      if (options.signal?.aborted || options.isCurrent?.() === false) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' })
      writes.push(next); value = next
    },
    choosePath: async () => { picks++; return typeof selected === 'function' ? selected() : selected },
    resolveImpl: async options => {
      resolutions.push(options)
      if (resolveError) throw Object.assign(new Error('The selected installation is unavailable.'), { code: resolveError })
      return { path: '/trusted/native/codex', source: options.customPath ? 'Custom' : 'Desktop app', mode: options.customPath ? 'custom' : 'automatic' }
    },
    resolutionOptions: { platform: 'darwin', excludedRoots: ['/app/Velorn'] },
  })
  return { access, resolutions, writes, get value() { return value }, get picks() { return picks } }
}

test('status/resolve use device preference without persisting discovery or reading a project', async () => {
  const f = fixture()
  assert.deepEqual(await f.access.status(), { path: '/trusted/native/codex', source: 'Desktop app', mode: 'automatic', available: true })
  assert.equal((await f.access.resolve()).path, '/trusted/native/codex')
  assert.equal(f.writes.length, 0)
  assert.equal(f.resolutions.length, 2)
  assert.equal(f.resolutions[0].customPath, '')
  assert.deepEqual(f.resolutions[0].excludedRoots, ['/app/Velorn'])
})

test('native picker validates then saves the chosen alias rather than a versioned target', async () => {
  const f = fixture()
  const result = await f.access.choose({ isCurrent: () => true })
  assert.equal(result.available, true)
  assert.equal(result.mode, 'custom')
  assert.equal(f.value, '/trusted/Codex.app')
  assert.equal(f.resolutions[0].customPath, f.value)
  await f.access.resolve()
  assert.equal(f.resolutions[1].customPath, '/trusted/Codex.app')
})

test('cancel and invalid selections retain the previous preference without fallback', async () => {
  const cancelled = fixture({ initial: '/previous/codex', selected: null })
  assert.equal(await cancelled.access.choose(), null)
  assert.equal(cancelled.writes.length, 0)
  assert.equal(cancelled.resolutions.length, 0)
  const invalid = fixture({ initial: '/previous/codex', resolveError: 'CODEX_EXECUTABLE_INVALID' })
  await assert.rejects(invalid.access.choose(), { code: 'CODEX_EXECUTABLE_INVALID' })
  assert.equal(invalid.value, '/previous/codex')
  assert.equal(invalid.writes.length, 0)
})

test('missing custom install stays visible and does not silently choose another account/runtime', async () => {
  const f = fixture({ initial: '/removed/codex', resolveError: 'CODEX_EXECUTABLE_INVALID' })
  const status = await f.access.status()
  assert.equal(status.mode, 'custom'); assert.equal(status.path, '/removed/codex'); assert.equal(status.available, false)
  await assert.rejects(f.access.resolve(), { code: 'CODEX_EXECUTABLE_INVALID' })
  assert.ok(f.resolutions.every(options => options.customPath === '/removed/codex'))
  assert.equal(f.writes.length, 0)
})

test('automatic explicitly clears the override even when no installation is found', async () => {
  const f = fixture({ initial: '/removed/codex', resolveError: 'CODEX_NOT_FOUND' })
  const result = await f.access.automatic()
  assert.equal(f.value, ''); assert.equal(result.mode, 'automatic'); assert.equal(result.available, false)
  assert.equal(f.resolutions[0].customPath, '')
})

test('cancelled or stale native picker cannot persist its late selection', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const f = fixture({ selected: () => wait })
  const chosen = f.access.choose({ signal: controller.signal, isCurrent: () => !controller.signal.aborted })
  controller.abort(); release('/late/codex')
  await assert.rejects(chosen, { code: 'CANCELLED' })
  assert.equal(f.writes.length, 0); assert.equal(f.resolutions.length, 0)
  await assert.rejects(f.access.automatic({ isCurrent: () => false }), { code: 'CANCELLED' })
  assert.equal(f.writes.length, 0)
})

test('guard is passed into queued persistence and read failures never become provider commands', async () => {
  let release, current = true
  const wait = new Promise(resolve => { release = resolve })
  const f = fixture({ writeWait: () => wait })
  const chosen = f.access.choose({ isCurrent: () => current })
  await new Promise(resolve => setImmediate(resolve))
  current = false; release()
  await assert.rejects(chosen, { code: 'CANCELLED' })
  assert.equal(f.writes.length, 0)
  const corrupt = fixture({ initial: { bad: 'preference' } })
  await assert.rejects(corrupt.access.resolve(), { code: 'CODEX_EXECUTABLE_INVALID' })
  assert.equal(corrupt.resolutions.length, 0)
})

test('generic native settings IPC cannot bypass the Codex executable picker or revoke its preference', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf("ipcMain.handle('settings:set',")
  const end = source.indexOf('// NVIDIA RTX Video Super Resolution', start)
  assert.ok(start > 0 && end > start)
  const handlers = new Map()
  let settings = { connectedAgentCodexExecutable: '/trusted/codex' }, writes = 0, refreshes = 0
  vm.runInNewContext(source.slice(start, end), {
    GENERATION_SPENDING_SETTING_KEY: 'generationSpendingPolicy',
    GENERATION_LOCAL_TRUST_SETTING_KEY: 'generationLocalWorkflowTrust',
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    writeSettingsRaw: async update => { writes++; settings = update(settings) },
    refreshSettingsDependentCaches: async () => { refreshes++ },
  })
  for (const channel of ['settings:set', 'settings:delete']) {
    const result = await handlers.get(channel)({}, 'connectedAgentCodexExecutable', '/untrusted/codex')
    assert.equal(result.success, false, channel)
    assert.match(result.error, /Agent settings/)
    assert.equal(settings.connectedAgentCodexExecutable, '/trusted/codex')
    assert.equal(writes, 0); assert.equal(refreshes, 0)
  }
  assert.equal((await handlers.get('settings:set')({}, 'theme', 'dark')).success, true)
  assert.equal(settings.theme, 'dark')
  assert.equal((await handlers.get('settings:delete')({}, 'theme')).success, true)
  assert.equal(settings.theme, undefined)
  assert.equal(writes, 2); assert.equal(refreshes, 2)
})
