'use strict'
// The two models song listening needs besides the speech model: a vocal
// separator and an aligner. This file downloads them once into Velorn's data
// folder and checks each against a known size and SHA-256, the same way the
// built-in voice model is fetched (localVoice.cjs).
//
// Where they come from:
//   - Kim_Vocal_2.onnx: the public UVR model collection.
//   - aligner.onnx and aligner_dict.json: exported for Velorn from torchaudio's
//     MMS_FA model. They exist nowhere else, so they are served from a Velorn
//     release. Until that release is published the download says so plainly.
//     (Jaime is handling the aligner's licence; see docs/DIRECTOR_DIRECTION.md.)
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')

const VELORN_RELEASE = 'https://github.com/VelornLabs/velorn/releases/download/song-engine-v1/'
const UVR_RELEASE = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/'
const file = (name, bytes, sha256, base, label) => Object.freeze({ name, bytes, sha256, url: base + name, label })
const FILES = Object.freeze([
  file('Kim_Vocal_2.onnx', 66759214, 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b', UVR_RELEASE, 'the voice separator'),
  file('aligner_dict.json', 251, '0e4719087006ac800a810398db9d4ab85471758822f4592ab9668cb82d9a0494', VELORN_RELEASE, 'the lyric timer'),
  file('aligner.onnx', 1264853271, '7f705b5dd0ed0f4bbafab46fa782c8a68bb4cf5ff6b32d2e79f24df176e0a8d2', VELORN_RELEASE, 'the lyric timer'),
])
const TOTAL_BYTES = FILES.reduce((sum, item) => sum + item.bytes, 0)

function createSongEngineModels({ dir, fetchImpl = globalThis.fetch, notify = () => {} } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir is required.')
  const place = item => path.join(dir, item.name)
  let installing = null

  // A file counts once it is there at exactly the right size. Its contents
  // were checked when it was downloaded.
  async function present(item) {
    try { return (await fsp.stat(place(item))).size === item.bytes } catch { return false }
  }
  async function status() {
    const have = await Promise.all(FILES.map(present))
    const missingBytes = FILES.reduce((sum, item, index) => sum + (have[index] ? 0 : item.bytes), 0)
    return { installed: have.every(Boolean), installing: Boolean(installing), totalBytes: TOTAL_BYTES, missingBytes, folder: dir }
  }

  async function download(item, before, totalBytes) {
    const target = place(item), part = `${target}.part`
    await fsp.mkdir(dir, { recursive: true })
    let response
    try { response = await fetchImpl(item.url, { redirect: 'follow' }) }
    catch { throw new Error(`Velorn could not reach the download for ${item.label}. Check your internet connection and try again.`) }
    if (response.status === 404) throw new Error(`The download for ${item.label} is not published yet.`)
    if (!response.ok || !response.body) throw new Error(`The download server answered ${response.status} for ${item.label}.`)
    const hash = createHash('sha256'), out = fs.createWriteStream(part)
    let got = 0, last = 0
    try {
      for await (const chunk of response.body) {
        got += chunk.length
        if (got > item.bytes) throw new Error(`The file for ${item.label} is larger than expected. It was not kept.`)
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
        if (Date.now() - last > 200) { last = Date.now(); notify({ doneBytes: before + got, totalBytes, current: item.label }) }
      }
      await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())))
      if (got !== item.bytes || hash.digest('hex') !== item.sha256) throw new Error(`The file for ${item.label} did not match the expected file. It was not kept.`)
      await fsp.rename(part, target)
    } catch (error) {
      out.destroy()
      await fsp.rm(part, { force: true }).catch(() => {})
      throw error
    }
  }

  // Downloads whatever is missing, one file at a time. A second call joins the first.
  function install() {
    if (!installing) installing = (async () => {
      try {
        const have = await Promise.all(FILES.map(present))
        const wanted = FILES.filter((_, index) => !have[index])
        const totalBytes = wanted.reduce((sum, item) => sum + item.bytes, 0)
        let before = 0
        for (const item of wanted) {
          await download(item, before, totalBytes)
          before += item.bytes
          notify({ doneBytes: before, totalBytes, current: item.label })
        }
        return { success: true }
      } catch (error) {
        return { success: false, error: error?.message || 'The download did not finish.' }
      } finally { installing = null }
    })()
    return installing
  }

  return { status, install }
}

module.exports = { createSongEngineModels, FILES, TOTAL_BYTES, VELORN_RELEASE }
