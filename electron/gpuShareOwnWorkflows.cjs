'use strict'
// An owner's own workflows for GPU sharing.
//
// A person picks one of the workflows saved in Velorn's library. Velorn looks
// inside it and finds, by plain rules, where the description goes in, where a
// picture goes in (if any) and which node saves the result. That makes it one
// of five shapes: text to picture, picture edit, picture to video, text to
// video, text to music. Anything else is turned down with the reason.
//
// What is kept here is small: which saved workflow, its name, the three spots,
// and the fingerprint of the graph they were found in. The workflow itself
// stays in the library. If it changes there, the entry stops working until it
// is added again, so what runs is always what its owner looked at.
//
// Nothing here offers a workflow to anyone. It can be listed, tested on this
// computer and removed. A job through it takes a description and, for the
// picture shapes, a picture; never a node, a model or a setting.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomBytes } = require('node:crypto')
const { refuse, PROMPT_MAX } = require('./gpuShareWorkflows.cjs')

const LIMITS = Object.freeze({ entries: 24, shared: 12, name: 60, exampleBytes: 64 * 1024 * 1024, storeBytes: 256 * 1024 })
const SHAPES = Object.freeze({ 'text-to-picture': 'Text to picture', 'picture-edit': 'Picture edit', 'picture-to-video': 'Picture to video', 'text-to-video': 'Text to video', 'text-to-music': 'Text to music' })
const ID = /^own-[a-f0-9]{16}$/
const SAVE_PICTURE = /^SaveImage$/
const SAVE_VIDEO = /^(?:SaveVideo|SaveWEBM|SaveAnimatedWEBP|VHS_VideoCombine)$/
// ComfyUI's own four ways to save a sound file.
const SAVE_AUDIO = /^(?:SaveAudio|SaveAudioMP3|SaveAudioOpus|SaveAudioAdvanced)$/
const SAVE_OTHER = /Save3D|SaveGLB|SaveLatent|SaveSVG/i
const LYRICS_MAX = 3000
// How long a shared song may be. A sender picks a length up to this; an owner whose workflow is set shorter keeps that shorter limit.
const MUSIC_SECONDS = Object.freeze({ min: 10, max: 240 })
const LENGTH_KEYS = ['max_duration', 'duration', 'seconds', 'duration_seconds']
// Where a music workflow holds its length: a plain number box with one of the usual names, on the part that holds
// the lyrics or the description first, then anywhere. Found fresh each time, so a workflow added before this existed has it too.
function lengthSpot(graph, record) {
  const numberBox = (nodeId) => { const inputs = plain(graph[nodeId]?.inputs) ? graph[nodeId].inputs : {}; const key = LENGTH_KEYS.find(name => typeof inputs[name] === 'number' && Number.isFinite(inputs[name]) && inputs[name] > 0); return key ? { nodeId, inputKey: key } : null }
  for (const nodeId of [record.lyrics?.nodeId, record.prompt?.nodeId]) { const found = typeof nodeId === 'string' ? numberBox(nodeId) : null; if (found) return found }
  for (const nodeId of Object.keys(graph)) { const found = numberBox(nodeId); if (found) return found }
  return null
}
const LOAD_OTHER = /^(?:LoadVideo|VHS_LoadVideo|VHS_LoadVideoPath|LoadAudio|VHS_LoadAudio|Load3D|LoadLatent)$/
const TEXT_KEYS = ['text', 'prompt', 'model.prompt', 'positive_prompt', 'caption', 'value', 'string']
const TEST_PROMPT = 'A red apple on a wooden table, soft morning light.'
const TEST_MUSIC_PROMPT = 'Calm piano with soft strings, slow and warm, instrumental.'
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const spot = value => plain(value) && typeof value.nodeId === 'string' && value.nodeId.length <= 64 && typeof value.inputKey === 'string' && value.inputKey.length <= 160
const titleOf = (graph, nodeId) => String(graph[nodeId]?._meta?.title || graph[nodeId]?.class_type || '').slice(0, 80)
const cleanName = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name)

// Every place a description could go: a text input that holds words, not a link.
function textSpots(graph) {
  const found = []
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const inputKey of TEXT_KEYS) {
      if (typeof node.inputs[inputKey] !== 'string') continue
      if (['value', 'string'].includes(inputKey) && !/string|text|prompt/i.test(node.class_type)) continue
      found.push({ nodeId, inputKey, label: titleOf(graph, nodeId), holds: node.inputs[inputKey].replace(/\s+/g, ' ').trim().slice(0, 120) })
    }
  }
  return found.slice(0, 40)
}

// What a saved workflow is, as far as sharing goes. `bindings` are the ones the library already works out.
function describeGraph(graph, bindings) {
  const problems = []
  const nodes = Object.entries(graph)
  const saves = kind => nodes.filter(([, node]) => kind.test(node.class_type)).map(([nodeId]) => nodeId)
  const pictures = saves(SAVE_PICTURE), videos = saves(SAVE_VIDEO), sounds = saves(SAVE_AUDIO)
  const results = pictures.length + videos.length + sounds.length
  if (nodes.some(([, node]) => SAVE_OTHER.test(node.class_type))) problems.push('It saves something other than a picture, a video or a sound. Velorn can only share picture, video and music workflows.')
  if (results === 0) problems.push('Velorn could not find where the result is saved. It looks for a Save Image, Save Video or Save Audio node.')
  else if (results > 1) problems.push(`It saves ${results} results. Velorn can share a workflow that saves one.`)
  const music = sounds.length === 1 && results === 1
  const outputId = videos[0] || pictures[0] || sounds[0] || null
  if (outputId && typeof graph[outputId].inputs.filename_prefix !== 'string') problems.push('The node that saves the result has no file name setting, so Velorn cannot tell its result apart.')
  const loaders = (bindings?.assets || []).filter(item => item.assetType === 'image')
  if (nodes.some(([, node]) => LOAD_OTHER.test(node.class_type))) problems.push('It starts from a video, a sound or another file. Velorn can only share workflows that start from a description or one picture.')
  if (loaders.length > 1) problems.push(`It starts from ${loaders.length} pictures. Velorn can share a workflow that starts from one, or from none.`)
  if (music && loaders.length) problems.push('It makes a sound but starts from a picture. Velorn can share a music workflow that starts from a description.')
  // Words to sing: a text box named "lyrics". Its neighbour on the same part is the natural place for the description.
  const lyricsAt = music ? nodes.find(([, node]) => typeof node.inputs.lyrics === 'string') : null
  const lyrics = lyricsAt ? { nodeId: lyricsAt[0], inputKey: 'lyrics' } : null
  const choices = textSpots(graph)
  const guess = (lyrics && choices.find(item => item.nodeId === lyrics.nodeId))
    || (spot(bindings?.prompt) && choices.find(item => item.nodeId === bindings.prompt.nodeId && item.inputKey === bindings.prompt.inputKey))
  if (!choices.length) problems.push('Velorn could not find a place for the description. It looks for a text box that holds the prompt.')
  const video = Boolean(videos.length), picture = loaders.length === 1 ? loaders[0] : null
  const shape = music ? 'text-to-music' : video ? (picture ? 'picture-to-video' : 'text-to-video') : picture ? 'picture-edit' : 'text-to-picture'
  return { shape, kind: music ? 'audio' : video ? 'video' : 'image', problems, lyrics,
    prompt: guess ? { nodeId: guess.nodeId, inputKey: guess.inputKey } : choices[0] ? { nodeId: choices[0].nodeId, inputKey: choices[0].inputKey } : null, promptChoices: choices,
    image: picture ? { nodeId: picture.nodeId, inputKey: picture.inputKey, label: titleOf(graph, picture.nodeId), holds: String(graph[picture.nodeId].inputs[picture.inputKey] || '').slice(0, 120) } : null,
    output: outputId ? { nodeId: outputId, classType: graph[outputId].class_type, label: titleOf(graph, outputId) } : null,
    seeds: (bindings?.seeds || []).filter(spot).slice(0, 16).map(item => ({ nodeId: item.nodeId, inputKey: item.inputKey })) }
}

// One stored entry as the job runner needs it: checked choices in, a bound copy of the graph out.
function entryFor(record, { keepPicture = false } = {}) {
  return {
    id: record.id, name: record.name, kind: record.kind, own: true, needsImage: Boolean(record.image) && !keepPicture, minimumVramGb: 0, shapes: [],
    normalize(input) {
      if (!plain(input)) throw refuse('Missing choices for this job.')
      for (const key of Object.keys(input)) if (!['prompt', 'seed', ...(record.kind === 'audio' ? ['lyrics', 'seconds'] : [])].includes(key)) throw refuse(`"${String(key).slice(0, 40)}" is not a choice this workflow takes.`)
      // Words to sing, for a music workflow. One without a place for them takes the choice and makes its music without singing.
      const lyrics = input.lyrics === undefined ? '' : input.lyrics
      if (typeof lyrics !== 'string' || lyrics.length > LYRICS_MAX || /\u0000/.test(lyrics)) throw refuse(`Write lyrics of up to ${LYRICS_MAX} characters.`)
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!prompt || prompt.length > PROMPT_MAX || /\u0000/.test(prompt)) throw refuse(`Write a description of up to ${PROMPT_MAX} characters.`)
      const seed = input.seed === undefined ? null : input.seed
      if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw refuse('The seed must be a whole number.')
      // How long the song may be, for a music workflow. Left out, the owner's own setting stands.
      const given = Object.hasOwn(input, 'seconds'), seconds = given ? input.seconds : null
      if (given && (!Number.isInteger(seconds) || seconds < MUSIC_SECONDS.min || seconds > MUSIC_SECONDS.max)) throw refuse(`A song can be ${MUSIC_SECONDS.min} seconds to ${MUSIC_SECONDS.max / 60} minutes long.`)
      return { prompt, seed, ...(record.lyrics ? { lyrics: lyrics.trim() } : {}), ...(record.kind === 'audio' && seconds !== null ? { seconds } : {}) }
    },
    bind(workflow, choices, { imageName, prefix, randomSeed }) {
      const changed = () => refuse('This workflow changed since it was added. Add it again.', 'GPU_SHARE_WORKFLOW_CHANGED')
      if (!plain(workflow)) throw changed()
      const bound = JSON.parse(JSON.stringify(workflow))
      const set = (place, value, kind) => {
        const node = Object.hasOwn(bound, place.nodeId) ? bound[place.nodeId] : null
        if (!plain(node?.inputs) || typeof node.inputs[place.inputKey] !== kind) throw changed()
        node.inputs[place.inputKey] = value
      }
      const seed = choices.seed === null ? randomSeed() : choices.seed
      set(record.prompt, choices.prompt, 'string')
      // The owner's own lyrics never go out with someone else's song: the sender's words, or none.
      if (record.lyrics) set(record.lyrics, choices.lyrics || '', 'string')
      // The sender's length, never above what the owner set in the workflow nor above the limit for everyone.
      let seconds
      if (record.kind === 'audio') {
        const place = lengthSpot(bound, record)
        if (place) {
          const owners = bound[place.nodeId].inputs[place.inputKey], most = Math.min(MUSIC_SECONDS.max, owners)
          seconds = Math.max(1, Math.min(most, choices.seconds ?? most))
          set(place, seconds, 'number')
        }
      }
      if (record.image && !keepPicture) set(record.image, imageName, 'string')
      for (const place of record.seeds) set(place, seed, 'number')
      if (bound[record.output.nodeId]?.class_type !== record.output.classType) throw changed()
      set({ nodeId: record.output.nodeId, inputKey: 'filename_prefix' }, prefix, 'string')
      return { workflow: bound, seed, ...(seconds ? { seconds } : {}) }
    },
  }
}

function validRecord(value) {
  return plain(value) && ID.test(value.id || '') && typeof value.workflowId === 'string' && value.workflowId.length <= 200 && typeof value.name === 'string' && value.name && value.name.length <= LIMITS.name
    && Object.hasOwn(SHAPES, value.shape) && ['image', 'video', 'audio'].includes(value.kind) && (value.kind === 'audio') === (value.shape === 'text-to-music')
    && (value.lyrics === undefined || value.lyrics === null || value.kind === 'audio' && spot(value.lyrics)) && /^[a-f0-9]{64}$/.test(value.graphFingerprint || '')
    && spot(value.prompt) && (value.image === null || spot(value.image)) && plain(value.output) && typeof value.output.nodeId === 'string' && typeof value.output.classType === 'string'
    && Array.isArray(value.seeds) && value.seeds.length <= 16 && value.seeds.every(spot) && Number.isFinite(value.addedAt)
    && (value.shared === undefined || typeof value.shared === 'boolean') && (value.everyone === undefined || typeof value.everyone === 'boolean')
}

function createGpuShareOwnWorkflows({ dir, library, runner, now = Date.now, makeThumbnail = async () => null } = {}) {
  if (!path.isAbsolute(dir || '') || typeof library?.list !== 'function' || typeof library.prepare !== 'function' || typeof runner?.run !== 'function' || typeof runner.check !== 'function') {
    throw new TypeError('Own workflows need a private folder, the saved workflow library and the job runner.')
  }
  const storePath = path.join(dir, 'own-workflows.json')
  let cached = null, writing = Promise.resolve(), testing = null

  async function load() {
    if (cached) return cached
    try {
      const raw = await fs.readFile(storePath, 'utf8')
      const value = raw.length <= LIMITS.storeBytes ? JSON.parse(raw) : null
      cached = plain(value) && value.version === 1 && Array.isArray(value.workflows) ? value.workflows.filter(validRecord).slice(0, LIMITS.entries) : []
    } catch { cached = [] }
    return cached
  }
  function save(next) {
    const run = writing.then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const temporary = `${storePath}.${randomBytes(6).toString('hex')}.tmp`
      try { await fs.writeFile(temporary, `${JSON.stringify({ version: 1, workflows: next }, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, storePath) }
      catch (error) { await fs.unlink(temporary).catch(() => {}); throw error }
      cached = next
    })
    writing = run.catch(() => {})
    return run
  }
  const shown = record => ({ id: record.id, name: record.name, shape: record.shape, shapeLabel: SHAPES[record.shape], kind: record.kind, needsImage: Boolean(record.image), ...(record.lyrics ? { takesLyrics: true } : {}), addedAt: record.addedAt,
    testedAt: record.testedAt || null, testSeconds: record.testSeconds || null, hasExample: Boolean(record.example), shared: record.shared === true, everyone: record.shared === true && record.everyone === true, fingerprint: record.graphFingerprint, ...(record.trouble ? { trouble: record.trouble } : {}) })

  // The saved workflow as the library prepares it, or a plain reason why not.
  async function prepared(workflowId) {
    let ready
    try { ready = await library.prepare({ workflowId }) } catch (error) { ready = { success: false, code: error?.code } }
    // The library answers with a reason rather than throwing.
    if (ready?.success !== true) {
      throw refuse(ready?.code === 'NEEDS_API_CAPTURE' ? 'Open this workflow in the ComfyUI tab and save it to Velorn again. Velorn needs the copy it makes then.'
        : ready?.code === 'NOT_FOUND' ? 'That workflow is no longer in your saved workflows.' : 'Velorn could not read this saved workflow. It may be too large, or hold a file path or a key.', 'GPU_SHARE_OWN_UNREADABLE')
    }
    if (!plain(ready?.workflow) || !/^[a-f0-9]{64}$/.test(ready.graphFingerprint || '')) throw refuse('Velorn could not read this saved workflow.', 'GPU_SHARE_OWN_UNREADABLE')
    return ready
  }

  // The saved workflows a person can pick from.
  async function candidates() {
    const listed = await library.list()
    const taken = new Set((await load()).map(record => record.workflowId))
    return { workflows: (Array.isArray(listed?.workflows) ? listed.workflows : []).filter(item => plain(item) && typeof item.id === 'string').slice(0, 200)
      .map(item => ({ workflowId: item.id, title: String(item.title || item.label || 'Untitled').slice(0, 120), ready: item.savedRunsReady === true, added: taken.has(item.id) })) }
  }

  // What Velorn found in one saved workflow, for the person to look at before adding it.
  async function inspect({ workflowId } = {}) {
    const ready = await prepared(workflowId)
    const found = describeGraph(ready.workflow, ready.bindings)
    const problems = [...found.problems]
    if (!problems.length) {
      // Bound exactly as a job would be, then judged like every network job: local parts only, every model file here.
      const draft = { id: 'own-0000000000000000', name: 'check', kind: found.kind, lyrics: found.lyrics, prompt: found.prompt, image: found.image && { nodeId: found.image.nodeId, inputKey: found.image.inputKey }, output: found.output, seeds: found.seeds }
      const entry = entryFor(draft)
      let verdict
      try { verdict = await runner.check(entry.bind(ready.workflow, entry.normalize({ prompt: 'check' }), { imageName: 'check.png', prefix: 'velorn_network/check', randomSeed: () => 1 }).workflow) }
      catch (error) { verdict = { ok: false, reason: error?.publicMessage || 'ComfyUI on this computer did not answer.' } }
      if (!verdict.ok) problems.push(verdict.code === 'GPU_SHARE_NOT_LOCAL' && verdict.unknownNodes?.length
        ? `It uses parts Velorn does not know yet, so it cannot be shared for now: ${verdict.unknownNodes.slice(0, 8).join(', ')}.`
        : `${verdict.reason}${verdict.missingModels?.length ? ` Missing: ${verdict.missingModels.slice(0, 8).join(', ')}.` : ''}`)
    }
    return { workflowId, title: String(ready.title || '').slice(0, 120), shape: found.shape, shapeLabel: SHAPES[found.shape], kind: found.kind, canAdd: problems.length === 0, problems,
      prompt: found.prompt, promptChoices: found.promptChoices, image: found.image, output: found.output, lyrics: found.lyrics || null }
  }

  async function add({ workflowId, name, prompt } = {}) {
    const title = cleanName(name)
    if (!title) throw refuse('Give it a name people will recognise.')
    const records = await load()
    if (records.length >= LIMITS.entries) throw refuse(`You can add up to ${LIMITS.entries} of your own workflows.`)
    if (records.some(record => record.workflowId === workflowId)) throw refuse('That workflow is already in your list.')
    if (records.some(record => record.name.toLowerCase() === title.toLowerCase())) throw refuse('Another of your workflows already has that name.')
    const found = await inspect({ workflowId })
    if (!found.canAdd) throw refuse(found.problems[0] || 'This workflow cannot be shared.')
    // The person may choose another of the places Velorn listed for the description, never one of their own making.
    const chosen = prompt === undefined ? found.prompt : found.promptChoices.find(item => spot(prompt) && item.nodeId === prompt.nodeId && item.inputKey === prompt.inputKey)
    if (!chosen) throw refuse('Choose one of the listed places for the description.')
    const ready = await prepared(workflowId)
    const record = { id: `own-${createHash('sha256').update(`${workflowId}\0${ready.graphFingerprint}\0${randomBytes(8).toString('hex')}`).digest('hex').slice(0, 16)}`,
      workflowId, name: title, shape: found.shape, kind: found.kind, ...(found.lyrics ? { lyrics: found.lyrics } : {}), graphFingerprint: ready.graphFingerprint, prompt: { nodeId: chosen.nodeId, inputKey: chosen.inputKey },
      image: found.image ? { nodeId: found.image.nodeId, inputKey: found.image.inputKey } : null, output: { nodeId: found.output.nodeId, classType: found.output.classType },
      seeds: describeGraph(ready.workflow, ready.bindings).seeds, addedAt: now(), testedAt: null, testSeconds: null, example: null }
    await save([...records, record])
    return { workflow: shown(record) }
  }

  // A new name for one in the list. Nothing else about it changes: it is the same workflow, tested and reviewed as it was.
  async function rename({ id, name } = {}) {
    const title = cleanName(name)
    if (!title) throw refuse('Give it a name people will recognise.')
    const records = await load(), record = records.find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    if (records.some(item => item.id !== id && item.name.toLowerCase() === title.toLowerCase())) throw refuse('Another of your workflows already has that name.')
    const next = { ...record, name: title }
    if (title !== record.name) await save(records.map(item => item.id === id ? next : item))
    return { workflow: shown(next) }
  }

  async function remove({ id } = {}) {
    const records = await load(), record = records.find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    await save(records.filter(item => item.id !== id))
    if (record.example) await fs.unlink(path.join(dir, record.example.file)).catch(() => {})
    return { removed: id }
  }

  // The entry and graph for one stored workflow, for the job runner. Refused when the saved workflow is gone or no longer the one that was added.
  async function resolve(id, options) {
    if (!ID.test(id || '')) return null
    const record = (await load()).find(item => item.id === id)
    if (!record) return null
    const ready = await prepared(record.workflowId)
    if (ready.graphFingerprint !== record.graphFingerprint) throw refuse('This workflow changed since it was added. Add it again.', 'GPU_SHARE_WORKFLOW_CHANGED')
    return { entry: entryFor(record, options), template: ready.workflow }
  }

  // Runs it once on this computer with a plain description, and keeps the result as its example.
  // A picture shape starts from the picture the workflow was saved with.
  async function test({ id } = {}) {
    if (testing) throw refuse('Another test is still running. Wait for it to finish.')
    const records = await load(), record = records.find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    const started = now()
    testing = (async () => {
      const own = await resolve(id, { keepPicture: true })
      return runner.run({ jobId: `owntest-${randomBytes(9).toString('hex')}`, workflowId: id, own, choices: { prompt: own.entry.kind === 'audio' ? TEST_MUSIC_PROMPT : TEST_PROMPT } })
    })()
    let result, trouble = ''
    try { result = await testing } catch (error) { trouble = error?.publicMessage || 'The test could not be finished.' } finally { testing = null }
    const current = await load(), at = current.findIndex(item => item.id === id)
    if (at < 0) throw refuse('That workflow was removed while it was being tested.')
    let next
    if (result && Buffer.isBuffer(result.bytes) && result.bytes.length <= LIMITS.exampleBytes) {
      const extension = { 'image/png': 'png', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'opus' }[result.mimeType]
      const file = `${id}.${extension}`
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(dir, file), result.bytes, { mode: 0o600 })
      const { trouble: _old, ...rest } = current[at]
      next = { ...rest, testedAt: now(), testSeconds: Math.max(1, Math.round((now() - started) / 1000)), example: { file, mimeType: result.mimeType } }
    } else next = { ...current[at], shared: false, everyone: false, trouble: (trouble || 'The result was too large to keep as an example.').slice(0, 300) } // What no longer runs is no longer offered.
    await save(current.map((item, index) => index === at ? next : item))
    if (trouble) throw refuse(trouble, 'GPU_SHARE_OWN_TEST_FAILED')
    return { workflow: shown(next) }
  }

  // Offered to the people this owner invites, or not. Only something that has run here once can be offered.
  async function share({ id, shared } = {}) {
    if (typeof shared !== 'boolean') throw refuse('Choose whether to share it.')
    const records = await load(), record = records.find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    if (shared && (!record.testedAt || record.trouble)) throw refuse('Test it first. Only a workflow that has run on this computer can be shared.')
    if (shared && records.filter(item => item.shared && item.id !== id).length >= LIMITS.shared) throw refuse(`You can share up to ${LIMITS.shared} of your own workflows.`)
    const next = { ...record, shared, ...(shared ? {} : { everyone: false }) } // What is not shared is not open to everyone either.
    await save(records.map(item => item.id === id ? next : item))
    return { workflow: shown(next) }
  }
  // What a reviewer is sent before this workflow may be open to everyone: its name and shape, the model files and
  // node types it uses, the fingerprint of its graph and a small picture of its example. Never the workflow.
  async function reviewPackage({ id } = {}) {
    const record = (await load()).find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    if (!record.shared) throw refuse('Share it with the people you invite first.')
    const ready = await prepared(record.workflowId)
    if (ready.graphFingerprint !== record.graphFingerprint) throw refuse('This workflow changed since it was added. Add it again.', 'GPU_SHARE_WORKFLOW_CHANGED')
    const nodes = Object.values(ready.workflow)
    const parts = [...new Set(nodes.map(node => String(node.class_type).slice(0, 160)))].sort().slice(0, 160)
    const models = [...new Set(nodes.flatMap(node => Object.values(node.inputs)).filter(value => typeof value === 'string' && /\.(?:safetensors|ckpt|pth|pt|gguf|bin)$/i.test(value)).map(value => value.slice(0, 160)))].sort().slice(0, 40)
    let example
    if (record.example?.mimeType === 'image/png') {
      try { const small = await makeThumbnail(await fs.readFile(path.join(dir, record.example.file))); if (Buffer.isBuffer(small) && small.length > 4 && small.length <= 150 * 1024) example = small.toString('base64') } catch { example = undefined }
    }
    return { id: record.id, fingerprint: record.graphFingerprint, name: record.name, shape: record.shape, models, parts, ...(example ? { example } : {}) }
  }
  // The copy of the workflow a reviewer may open: exactly the graph that runs, whose fingerprint the review is for.
  async function reviewGraph({ id } = {}) {
    const record = (await load()).find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    const ready = await prepared(record.workflowId)
    if (ready.graphFingerprint !== record.graphFingerprint) throw refuse('This workflow changed since it was added. Add it again.', 'GPU_SHARE_WORKFLOW_CHANGED')
    return { id: record.id, fingerprint: record.graphFingerprint, graph: JSON.stringify(ready.workflow) }
  }
  // Remembers that the owner asked for it to be open to everyone (the review itself is the service's).
  async function setEveryone({ id, everyone } = {}) {
    const records = await load(), record = records.find(item => item.id === id)
    if (!record) throw refuse('That workflow is no longer in your list.')
    if (everyone && !record.shared) throw refuse('Share it with the people you invite first.')
    const next = { ...record, everyone: everyone === true }
    await save(records.map(item => item.id === id ? next : item))
    return { workflow: shown(next) }
  }
  // What this owner has chosen to offer, as the network is told about it.
  const offered = async () => (await load()).filter(record => record.shared === true).map(record => ({ id: record.id, name: record.name, shape: record.shape, kind: record.kind, needsImage: Boolean(record.image),
    ...(record.everyone === true ? { fingerprint: record.graphFingerprint } : {}) }))
  // For a job from someone else: only what is offered right now.
  async function resolveShared(id) { return (await load()).some(record => record.id === id && record.shared === true) ? resolve(id) : null }

  async function example({ id } = {}) {
    const record = (await load()).find(item => item.id === id)
    if (!record?.example || !/^own-[a-f0-9]{16}\.(?:png|mp4|mov|webm|mp3|flac|opus)$/.test(record.example.file)) throw refuse('There is no example for this workflow yet.')
    const bytes = await fs.readFile(path.join(dir, record.example.file))
    if (bytes.length > LIMITS.exampleBytes) throw refuse('The example is too large to show.')
    return { mimeType: record.example.mimeType, bytes: new Uint8Array(bytes) }
  }

  return { list: async () => ({ workflows: (await load()).map(shown), testing: Boolean(testing) }), candidates, inspect, add, remove, rename, test, example, resolve, share, offered, resolveShared, reviewPackage, reviewGraph, setEveryone }
}

// Only the main Velorn window may use these. Adding, removing and testing need a real click (checked in the preload).
const CHANNELS = ['gpu-share-own:list', 'gpu-share-own:candidates', 'gpu-share-own:inspect', 'gpu-share-own:add', 'gpu-share-own:remove', 'gpu-share-own:rename', 'gpu-share-own:test', 'gpu-share-own:example', 'gpu-share-own:share']
const REVIEW_CHANNELS = ['gpu-share-own:offer', 'gpu-review:list', 'gpu-review:example', 'gpu-review:graph', 'gpu-review:try', 'gpu-review:decide', 'gpu-review:ban', 'gpu-review:dismiss', 'gpu-review:evidence']
// `network` is the Velorn network client (review requests travel through it); `getMaker` gives the name the owner goes by.
function registerGpuShareOwnIpc({ ipcMain, getMainWindow, own, onChanged = () => {}, network = null, getMaker = async () => '' }) {
  const allowed = event => {
    const window = getMainWindow()
    return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame)
  }
  for (const channel of CHANNELS) {
    const action = channel.slice('gpu-share-own:'.length)
    ipcMain.handle(channel, async (event, payload) => {
      if (!allowed(event)) return { success: false, error: 'Open GPU sharing in the main Velorn window.' }
      try {
        let result = await own[action](plain(payload) ? payload : {})
        // The list also says where each one stands with the review, and whether this account is a reviewer.
        if (action === 'list' && network) {
          let review = null
          try { review = await network.ownStatus() } catch { review = null }
          const state = item => { const found = review?.submissions.find(entry => entry.ownId === item.id); return !found ? null : found.fingerprint !== item.fingerprint ? { status: 'changed', note: '' } : { status: found.status, note: found.note } }
          result = { ...result, reviewer: review?.reviewer === true, reviewKnown: Boolean(review), workflows: result.workflows.map(item => ({ ...item, review: item.everyone ? state(item) || (review ? { status: 'not-sent', note: '' } : null) : null })) }
        }
        // What is offered to the network may have changed.
        if (['share', 'remove', 'rename', 'test'].includes(action)) { try { onChanged() } catch { /* The next heartbeat picks it up. */ } }
        return { success: true, ...result }
      }
      catch (error) { return { success: false, code: typeof error?.code === 'string' ? error.code : 'GPU_SHARE_OWN_FAILED', error: error?.publicMessage || 'That could not be done.' } }
    })
  }
  const handle = (channel, action) => ipcMain.handle(channel, async (event, payload) => {
    if (!allowed(event)) return { success: false, error: 'Open GPU sharing in the main Velorn window.' }
    if (!network) return { success: false, error: 'The Velorn network is not available here.' }
    try { return { success: true, ...(await action(plain(payload) ? payload : {})) } }
    catch (error) { return { success: false, code: typeof error?.code === 'string' ? error.code : 'GPU_SHARE_OWN_FAILED', error: error?.publicMessage || 'That could not be done.' } }
  })
  // Ask for one to be open to everyone (it is sent for review), or take that back.
  handle('gpu-share-own:offer', async ({ id, everyone }) => {
    if (typeof everyone !== 'boolean') throw refuse('Choose whether to offer it to everyone.')
    if (everyone) {
      const sent = await own.reviewPackage({ id })
      const maker = String(await getMaker() || '').slice(0, 40)
      await network.ownSubmit({ ...sent, ...(maker ? { maker } : {}) })
      // The owner was told before pressing: the reviewer may open the workflow. The service drops this copy once they decide.
      try { await network.ownGraph(await own.reviewGraph({ id })) } catch { /* The review can still go ahead on the facts and a test. */ }
    } else { try { await network.ownWithdraw(id) } catch { /* Not offered here any more either way. */ } }
    const result = await own.setEveryone({ id, everyone })
    try { onChanged() } catch { /* The next heartbeat picks it up. */ }
    return result
  })
  handle('gpu-review:list', () => network.reviewList())
  handle('gpu-review:example', ({ sid }) => network.reviewExample(sid))
  handle('gpu-review:graph', ({ sid }) => network.reviewGraph(sid))
  handle('gpu-review:try', ({ sid, prompt, image }) => network.reviewTry({ sid, prompt,
    image: plain(image) && typeof image.mimeType === 'string' && image.bytes instanceof Uint8Array && image.bytes.byteLength <= 10 * 1024 * 1024 ? { mimeType: image.mimeType, bytes: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength) } : null }))
  handle('gpu-review:decide', ({ sid, approve, note }) => network.reviewDecide({ sid, approve, note }))
  handle('gpu-review:ban', ({ sid, jobId, reporter }) => network.reviewBan({ sid, jobId, reporter }))
  handle('gpu-review:evidence', ({ jobId, kind }) => network.reviewEvidence({ jobId, kind }))
  handle('gpu-review:dismiss', ({ jobId }) => network.reviewDismiss({ jobId }))
  return { dispose() { for (const channel of [...CHANNELS, ...REVIEW_CHANNELS]) ipcMain.removeHandler?.(channel) } }
}

module.exports = { createGpuShareOwnWorkflows, registerGpuShareOwnIpc, describeGraph, entryFor, lengthSpot, SHAPES, LIMITS, CHANNELS, TEST_PROMPT, TEST_MUSIC_PROMPT, LYRICS_MAX, MUSIC_SECONDS }
