const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyModelDownloads, checkRequest, isLocalComfyFrameUrl, FRAME_HOOK } = require('../electron/comfyModelDownload.cjs')

const GOOD = { url: 'https://huggingface.co/Org/repo/resolve/main/loras/thing.safetensors', name: 'thing.safetensors', directory: 'loras' }

test('a normal model request is accepted', () => {
  const checked = checkRequest(GOOD)
  assert.equal(checked.success, true)
  assert.equal(checked.filename, 'thing.safetensors')
  assert.equal(checked.folder, 'loras')
})

test('requests that could write somewhere else or fetch from elsewhere are refused', () => {
  assert.equal(checkRequest({ ...GOOD, url: 'http://huggingface.co/x/y.safetensors' }).success, false)
  assert.equal(checkRequest({ ...GOOD, url: 'https://example.com/y.safetensors' }).success, false)
  assert.equal(checkRequest({ ...GOOD, url: 'https://huggingface.co.evil.net/y.safetensors' }).success, false)
  assert.equal(checkRequest({ ...GOOD, name: '../thing.safetensors' }).success, false)
  assert.equal(checkRequest({ ...GOOD, name: 'thing.sh' }).success, false)
  assert.equal(checkRequest({ ...GOOD, name: '.hidden.safetensors' }).success, false)
  assert.equal(checkRequest({ ...GOOD, directory: '../../etc' }).success, false)
  assert.equal(checkRequest({ ...GOOD, directory: 'loras/sub' }).success, false)
  assert.equal(checkRequest({ ...GOOD, directory: '' }).success, false)
  assert.equal(checkRequest({ ...GOOD, url: 'not a url' }).success, false)
})

test('only a ComfyUI on this computer gets the hook', () => {
  assert.equal(isLocalComfyFrameUrl('http://127.0.0.1:8189/'), true)
  assert.equal(isLocalComfyFrameUrl('http://localhost:8188/?x=1'), true)
  assert.equal(isLocalComfyFrameUrl('https://comfy.example.com/'), false)
  assert.equal(isLocalComfyFrameUrl('http://192.168.1.20:8188/'), false)
  assert.equal(isLocalComfyFrameUrl(''), false)
})

test('the hook offers ComfyUI the hand-off it looks for', () => {
  assert.match(FRAME_HOOK, /__comfyDesktop2/)
  assert.match(FRAME_HOOK, /downloadModel/)
  assert.doesNotThrow(() => new Function(`return ${FRAME_HOOK.replace(/^\(\(\) => \{/, '(() => { const window = { addEventListener() {}, parent: { postMessage() {} } };')}`))
})

async function setup(body = [Buffer.from('abc'), Buffer.from('defg')], { ok = true, length } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'velorn-comfy-dl-'))
  const sent = []
  const fetched = []
  const downloads = createComfyModelDownloads({
    resolveFolder: async (folder) => ({ folder: path.join(dir, folder), available: true }),
    fetchImpl: async (url) => {
      fetched.push(url)
      const total = body.reduce((sum, chunk) => sum + chunk.length, 0)
      return { ok, status: ok ? 200 : 404, headers: { get: () => String(length ?? total) }, body: (async function* () { for (const chunk of body) yield chunk })() }
    },
    fs: fsp,
    createWriteStream: fs.createWriteStream,
    notify: (payload) => sent.push(payload),
  })
  const finished = () => new Promise((resolve) => { const tick = () => (sent.some((entry) => entry.done) ? resolve() : setTimeout(tick, 5)); tick() })
  return { dir, sent, fetched, downloads, finished }
}

test('the file lands in the folder ComfyUI named, and progress is reported', async () => {
  const { dir, sent, downloads, finished } = await setup()
  const started = await downloads.start(GOOD)
  assert.equal(started.success, true)
  await finished()
  assert.equal(await fsp.readFile(path.join(dir, 'loras', 'thing.safetensors'), 'utf8'), 'abcdefg')
  assert.equal(sent.at(-1).state, 'completed')
  assert.equal(sent.at(-1).percent, 100)
  assert.deepEqual(await fsp.readdir(path.join(dir, 'loras')), ['thing.safetensors'])
})

test('a file that is already there is not downloaded again', async () => {
  const { dir, fetched, downloads } = await setup()
  await fsp.mkdir(path.join(dir, 'loras'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'loras', 'thing.safetensors'), 'old')
  const answer = await downloads.start(GOOD)
  assert.equal(answer.alreadyThere, true)
  assert.equal(fetched.length, 0)
  assert.equal(await fsp.readFile(path.join(dir, 'loras', 'thing.safetensors'), 'utf8'), 'old')
})

test('a failed or cut-off download leaves nothing behind', async () => {
  for (const options of [{ ok: false }, { length: 999 }]) {
    const { dir, sent, downloads, finished } = await setup(undefined, options)
    assert.equal((await downloads.start(GOOD)).success, true)
    await finished()
    assert.equal(sent.at(-1).state, 'interrupted')
    assert.deepEqual(await fsp.readdir(path.join(dir, 'loras')).catch(() => []), [])
  }
})

test('a missing ComfyUI folder or drive is explained, and nothing is fetched', async () => {
  const fetched = []
  const make = (resolveFolder) => createComfyModelDownloads({ resolveFolder, fetchImpl: async (url) => { fetched.push(url); return {} }, fs: fsp, createWriteStream: fs.createWriteStream })
  assert.match((await make(async () => ({ folder: '' })).start(GOOD)).error, /does not know where your ComfyUI folder is/)
  assert.match((await make(async () => ({ folder: '/mnt/gone/loras', available: false })).start(GOOD)).error, /not there right now/)
  assert.match((await make(async () => { throw new Error('boom') }).start(GOOD)).error, /boom/)
  assert.equal(fetched.length, 0)
})
