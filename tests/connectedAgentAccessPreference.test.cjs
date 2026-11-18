'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createFullAccessPreference, CONSENT, LOCAL_CONSENT, VELO_CONSENT } = require('../electron/connectedAgentAccessPreference.cjs')

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-access-preference-'))
  const filePath = path.join(folder, 'consent.json')
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  return { folder, filePath, preference: createFullAccessPreference({ filePath }) }
}

test('native opt-in is versioned, private, atomic, and survives a fresh controller without saving a grant', async t => {
  const { folder, filePath, preference } = await fixture(t)
  assert.equal(await preference.read(), false)
  await preference.remember()
  assert.equal(await preference.read(), true)
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { ...CONSENT, remembered: true })
  if (process.platform !== 'win32') assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(folder), ['consent.json'])
  assert.equal(await createFullAccessPreference({ filePath }).read(), true)
  await preference.forget()
  assert.equal(await preference.read(), false)
  assert.equal(await createFullAccessPreference({ filePath }).read(), false)
})

test('LM Studio consent persists independently and never restores computer access', async t => {
  const { filePath, preference } = await fixture(t)
  await preference.remember('lmstudio')
  assert.equal(await preference.read('lmstudio'), true)
  assert.equal(await preference.read('codex'), false)
  const restarted = createFullAccessPreference({ filePath })
  assert.equal(await restarted.read('lmstudio'), true)
  assert.equal(await restarted.read('codex'), false)
  await restarted.remember('codex')
  await restarted.forget('lmstudio')
  assert.equal(await restarted.read('codex'), true)
  assert.equal(await restarted.read('lmstudio'), false)
  assert.throws(() => restarted.read('other'), /Choose Velo, LM Studio or Codex/)
})

test('Velo computer consent is versioned, private and isolated from both other providers', async t => {
  const { filePath, preference } = await fixture(t)
  await preference.remember('luna')
  assert.equal(await preference.read('luna'), true)
  assert.equal(await preference.read('codex'), false)
  assert.equal(await preference.read('lmstudio'), false)
  assert.deepEqual(JSON.parse(await fs.readFile(`${filePath}.luna`, 'utf8')), { ...VELO_CONSENT, remembered: true })
  if (process.platform !== 'win32') assert.equal((await fs.stat(`${filePath}.luna`)).mode & 0o777, 0o600)
  const restarted = createFullAccessPreference({ filePath })
  assert.equal(await restarted.read('luna'), true)
  await restarted.forget('luna')
  assert.equal(await restarted.read('luna'), false)
})

test('old Velo tool-only approval never restores computer access or rewrites existing preferences', async t => {
  const { filePath, preference } = await fixture(t)
  await preference.remember('codex'); await preference.remember('lmstudio')
  const codexBefore = await fs.readFile(filePath, 'utf8'), localBefore = await fs.readFile(`${filePath}.lmstudio`, 'utf8')
  const old = JSON.stringify({ ...LOCAL_CONSENT, provider: 'luna', remembered: true })
  await fs.writeFile(`${filePath}.luna`, old, { mode: 0o600 })
  assert.equal(await preference.read('luna'), false)
  assert.equal(await createFullAccessPreference({ filePath }).read('luna'), false)
  assert.equal(await fs.readFile(`${filePath}.luna`, 'utf8'), old, 'Reading cannot silently migrate the old choice')
  assert.equal(await preference.read('codex'), true); assert.equal(await preference.read('lmstudio'), true)
  await preference.remember('luna')
  assert.equal(await createFullAccessPreference({ filePath }).read('luna'), true)
  await preference.forget('luna')
  assert.equal(await createFullAccessPreference({ filePath }).read('luna'), false)
  assert.equal(await fs.readFile(filePath, 'utf8'), codexBefore)
  assert.equal(await fs.readFile(`${filePath}.lmstudio`, 'utf8'), localBefore)
})

test('Velo computer consent rejects mismatched scope, version, provider, image bundle and extra authority fields', async t => {
  const { filePath, preference } = await fixture(t)
  const valid = { ...VELO_CONSENT, remembered: true }
  for (const value of [{ ...valid, version: 1 }, { ...valid, version: 3 },
    { ...valid, scope: LOCAL_CONSENT.scope }, { ...valid, scope: CONSENT.scope },
    { ...valid, provider: 'codex' }, { ...valid, shareImagesAndView: false },
    { ...valid, remembered: 'true' }, { ...valid, grant: 'not-authority' }]) {
    await fs.writeFile(`${filePath}.luna`, JSON.stringify(value), { mode: 0o600 })
    assert.equal(await preference.read('luna'), false)
  }
})

test('malformed, old, differently scoped, oversized, and loosely typed saved choices fail closed', async t => {
  const { filePath, preference } = await fixture(t)
  const valid = { ...CONSENT, remembered: true }
  for (const value of [null, [], true, { ...valid, version: 0 }, { ...valid, scope: 'other' },
    { ...valid, provider: 'lmstudio' }, { ...valid, shareImagesAndView: false }, { ...valid, remembered: 'true' },
    { ...valid, token: 'not-authority' }, { ...valid, remembered: false }]) {
    await fs.writeFile(filePath, JSON.stringify(value), { mode: 0o600 })
    assert.equal(await preference.read(), false)
  }
  for (const value of ['{broken', ' '.repeat(3000) + JSON.stringify(valid)]) {
    await fs.writeFile(filePath, value, { mode: 0o600 })
    assert.equal(await preference.read(), false)
  }
})

test('nonprivate files, directories, and symlinked consent are not authority', async t => {
  const { folder, filePath, preference } = await fixture(t)
  assert.equal(await createFullAccessPreference({ filePath: folder }).read(), false)
  if (process.platform === 'win32') return
  await preference.remember()
  await fs.chmod(filePath, 0o644)
  assert.equal(await preference.read(), false)
  await fs.chmod(filePath, 0o600)
  const link = path.join(folder, 'link.json')
  await fs.symlink(filePath, link)
  assert.equal(await createFullAccessPreference({ filePath: link }).read(), false)
})

test('queued opt-in and revocation are ordered and leave no temporary files', async t => {
  const { folder, filePath, preference } = await fixture(t)
  await Promise.all([preference.remember(), preference.forget()])
  assert.equal(await createFullAccessPreference({ filePath }).read(), false)
  assert.deepEqual(await fs.readdir(folder), ['consent.json'])
  assert.throws(() => createFullAccessPreference({ filePath: 'relative.json' }), TypeError)
})

test('failed opt-in never exposes a previously saved true in the active process', async t => {
  const { filePath, preference } = await fixture(t)
  await preference.remember()
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === filePath) throw Object.assign(new Error('Fixture write failure'), { code: 'EACCES' })
    return rename(source, destination)
  })
  await assert.rejects(preference.remember())
  assert.equal(await preference.read(), false)
  await preference.forget()
  assert.equal(await createFullAccessPreference({ filePath }).read(), false)
})

test('failed atomic revocation removes only the exact consent file, preventing restore after restart', async t => {
  const { folder, filePath, preference } = await fixture(t)
  await preference.remember()
  const sibling = path.join(folder, 'unrelated.txt')
  await fs.writeFile(sibling, 'keep')
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === filePath) throw Object.assign(new Error('Fixture write failure'), { code: 'EACCES' })
    return rename(source, destination)
  })
  await preference.forget()
  assert.equal(await preference.read(), false)
  assert.equal(await createFullAccessPreference({ filePath }).read(), false)
  assert.equal(await fs.readFile(sibling, 'utf8'), 'keep')
  assert.deepEqual(await fs.readdir(folder), ['unrelated.txt'])
})

test('unrecoverable disk revocation fails closed and explicitly warns about restarting', async t => {
  const { filePath, preference } = await fixture(t)
  await preference.remember()
  const rename = fs.rename, unlink = fs.unlink
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === filePath) throw Object.assign(new Error('Fixture write failure'), { code: 'EACCES' })
    return rename(source, destination)
  })
  t.mock.method(fs, 'unlink', async target => {
    if (target === filePath) throw Object.assign(new Error('Fixture unlink failure'), { code: 'EACCES' })
    return unlink(target)
  })
  await assert.rejects(preference.forget(), error => error.code === 'FULL_ACCESS_PREFERENCE_FAILED'
    && /remembered choice could not be cleared/.test(error.message) && /before restarting/.test(error.message))
  assert.equal(await preference.read(), false)
})
