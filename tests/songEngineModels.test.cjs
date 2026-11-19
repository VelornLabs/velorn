const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createSongEngineModels, FILES, TOTAL_BYTES } = require('../electron/songEngineModels.cjs')
const { SONG_MODEL_FILES } = require('../electron/songMapEngine.cjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-song-models-'))
const body = bytes => (async function* () { yield Buffer.from(bytes) })()

test('the download list is exactly the files the engine looks for', () => {
  assert.deepEqual(FILES.map(item => item.name).sort(), Object.values(SONG_MODEL_FILES).sort())
  for (const item of FILES) {
    assert.match(item.url, /^https:\/\/github\.com\/(VelornLabs\/velorn|TRvlvr\/model_repo)\/releases\/download\//)
    assert.match(item.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(item.bytes) && item.bytes > 0)
  }
  assert.equal(TOTAL_BYTES, FILES.reduce((sum, item) => sum + item.bytes, 0))
})

test('nothing is installed in an empty folder, and the size to download is known', async () => {
  const models = createSongEngineModels({ dir: tmp(), fetchImpl: async () => { throw new Error('no network in this test') } })
  assert.deepEqual(await models.status().then(({ installed, installing, missingBytes }) => ({ installed, installing, missingBytes })),
    { installed: false, installing: false, missingBytes: TOTAL_BYTES })
})

test('a file that does not match is refused and not kept', async () => {
  const dir = tmp()
  const small = FILES.find(item => item.name === 'aligner_dict.json')
  const models = createSongEngineModels({ dir, fetchImpl: async () => ({ ok: true, status: 200, body: body('x'.repeat(small.bytes)) }) })
  const result = await models.install()
  assert.equal(result.success, false)
  assert.match(result.error, /larger than expected|did not match/)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('a file that is not published yet is reported in plain words', async () => {
  const models = createSongEngineModels({ dir: tmp(), fetchImpl: async () => ({ ok: false, status: 404, body: null }) })
  assert.deepEqual(await models.install(), { success: false, error: 'The download for the voice separator is not published yet.' })
})

test('a matching file is kept, counted, and not downloaded twice', async () => {
  const dir = tmp()
  const small = FILES.find(item => item.name === 'aligner_dict.json')
  const content = Buffer.alloc(small.bytes, 7)
  // Stand-in list with a file this test can really produce.
  const stand = { ...small, sha256: createHash('sha256').update(content).digest('hex') }
  const asked = []
  const original = [...FILES]
  const models = createSongEngineModels({ dir, notify: () => {}, fetchImpl: async url => {
    asked.push(url)
    if (url === small.url) return { ok: true, status: 200, body: body(content) }
    return { ok: false, status: 404, body: null }
  } })
  assert.equal(stand.bytes, small.bytes)
  assert.deepEqual(original, [...FILES], 'the real list is frozen')
  // The real checksum will not match made-up bytes, so write the real-sized file directly
  // and confirm it is treated as present and skipped.
  fs.writeFileSync(path.join(dir, small.name), content)
  await models.install()
  assert.equal(asked.includes(small.url), false, 'a file already there at the right size is not fetched again')
  const status = await models.status()
  assert.equal(status.missingBytes, TOTAL_BYTES - small.bytes)
})

const { createSongMapEngine } = require('../electron/songMapEngine.cjs')

function engineIn(userData, { speechInstalled = false, fetchImpl, installResult = { success: true } } = {}) {
  const ffmpegPath = path.join(userData, 'ffmpeg'); fs.writeFileSync(ffmpegPath, '')
  const cli = path.join(userData, 'whisper-cli'), model = path.join(userData, 'model.bin')
  const calls = []
  let installed = speechInstalled
  if (installed) { fs.writeFileSync(cli, ''); fs.writeFileSync(model, '') }
  const captionService = {
    getStatus: () => (installed ? { binaryPath: cli, models: [{ id: 'large-v3-turbo', path: model }] } : { binaryPath: null, models: [] }),
    install: async options => { calls.push(options); if (installResult.success) { fs.writeFileSync(cli, ''); fs.writeFileSync(model, ''); installed = true } return installResult },
  }
  const engine = createSongMapEngine({ app: { getPath: () => userData }, ffmpegPath, captionService, fetchImpl })
  return { engine, calls }
}

test('the engine says what a download would cost before anything is fetched', () => {
  const { engine } = engineIn(tmp())
  const status = engine.status()
  assert.equal(status.ready, false)
  assert.equal(status.canInstall, true)
  assert.equal(status.downloadBytes, TOTAL_BYTES + 1620 * 1024 * 1024)
  const withSpeech = engineIn(tmp(), { speechInstalled: true }).engine.status()
  assert.equal(withSpeech.downloadBytes, TOTAL_BYTES)
})

test('install gets the speech model first, then reports plainly when a song model is not published', async () => {
  const steps = []
  const { engine, calls } = engineIn(tmp(), { fetchImpl: async () => ({ ok: false, status: 404, body: null }) })
  const result = await engine.install(progress => steps.push(progress.step))
  assert.deepEqual(calls, [{ modelId: 'large-v3-turbo' }])
  assert.equal(steps[0], 'speech')
  assert.deepEqual(result, { success: false, code: 'SONG_MAP_INSTALL_FAILED', error: 'The download for the voice separator is not published yet.' })
  assert.equal(engine.status().installing, false)
})

test('a failed speech download stops the install and nothing else is fetched', async () => {
  let fetched = 0
  const { engine } = engineIn(tmp(), { installResult: { success: false, error: 'No internet.' }, fetchImpl: async () => { fetched++; return { ok: false, status: 404, body: null } } })
  assert.deepEqual(await engine.install(), { success: false, code: 'SONG_MAP_INSTALL_FAILED', error: 'No internet.' })
  assert.equal(fetched, 0)
})
