'use strict'
// Turns one Create request (a model from createModels plus the person's
// choices) into the JSON body that model's Comfy Router endpoint expects.
// Pure functions: nothing here touches the network, the key or the disk.
//
// One request always asks for ONE picture or ONE clip. Asking for several
// pictures means several requests, each quoted, approved and recorded alone.
// A request may carry ONE input picture: to edit or draw from (picture models),
// or to start a clip from or use as a reference (video models). Clip and sound
// inputs are not built here; a request that carries them is refused.
// A picture request to a Gemini picture model may instead carry up to three
// REFERENCE pictures (`pictures`): the Director's keyframes send a person and
// a place this way.
const { getModel, getVoice, sizesFor, resolutionsFor, AUDIO_KINDS } = require('./createModels.cjs')

const SHAPES = ['landscape', 'square', 'portrait']
const RATIO = { landscape: '16:9', square: '1:1', portrait: '9:16' }
// Pixel sizes per size class. The 1K wide and tall sizes are 1376 x 768 so they
// clear the one-megapixel floor Seedream 5.0 Pro and 4.0 enforce.
const PIXELS = {
  '1K': { landscape: [1376, 768], square: [1024, 1024], portrait: [768, 1376] },
  '2K': { landscape: [2560, 1440], square: [2048, 2048], portrait: [1440, 2560] },
  '4K': { landscape: [3840, 2160], square: [2880, 2880], portrait: [2160, 3840] }
}
// GPT Image has its own published 1K sizes.
const GPT_1K = { landscape: [1536, 1024], square: [1024, 1024], portrait: [1024, 1536] }
const PROMPT_MAX = 4000
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const PICTURE_MAX = 10 * 1024 * 1024
const PICTURE_USES = ['start', 'reference']
const PICTURES_MAX = 3

function refuse(message) { return Object.assign(new Error(message), { code: 'CREATE_REQUEST_INVALID' }) }
const dims = pair => `${pair[0]}x${pair[1]}`

// Voice takes the words to say and a voice from the catalog. Sound and music
// take a description and a length. None of them takes a picture or a shape.
function normalizeAudio(model, input) {
  const voice = model.kind === 'voice'
  const allowed = voice ? ['prompt', 'voice'] : model.kind === 'sound' ? ['prompt', 'seconds', 'loop'] : ['prompt', 'seconds']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw refuse(`"${key}" is not a choice ${model.name} takes.`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || /\x00/.test(prompt)) throw refuse(voice ? 'Write what the voice should say first.' : 'Write a description first.')
  if (voice) {
    if (prompt.length > model.characters.max) throw refuse(`${model.name} takes up to ${model.characters.max.toLocaleString('en-US')} characters at a time.`)
    const chosen = getVoice(input.voice)
    if (typeof input.voice !== 'string' || !chosen) throw refuse('Choose a voice.')
    return { model, picture: null, choices: { prompt, voice: chosen.id, characters: prompt.length } }
  }
  if (prompt.length > PROMPT_MAX) throw refuse('Write a shorter description.')
  const seconds = input.seconds === undefined ? model.seconds.offered[0] : input.seconds
  if (!Number.isInteger(seconds) || seconds < model.seconds.min || seconds > model.seconds.max) throw refuse(`${model.name} makes ${model.seconds.min} to ${model.seconds.max} seconds.`)
  if (input.loop !== undefined && typeof input.loop !== 'boolean') throw refuse('Unknown repeat choice.')
  return { model, picture: null, choices: { prompt, seconds, ...(input.loop ? { loop: true } : {}) } }
}

function normalize(modelId, input) {
  const model = getModel(modelId)
  if (!model) throw refuse('Unknown Create model.')
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw refuse('Missing Create choices.')
  if (AUDIO_KINDS.includes(model.kind)) return normalizeAudio(model, input)
  const allowed = model.kind === 'video' ? ['prompt', 'shape', 'seconds', 'resolution', 'picture', 'pictureUse'] : ['prompt', 'shape', 'size', 'picture', 'pictures']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw refuse(`"${key}" is not a choice ${model.name} takes.`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || prompt.length > PROMPT_MAX || /\x00/.test(prompt)) throw refuse('Write a description first.')
  const shape = input.shape === undefined ? 'landscape' : input.shape
  if (!SHAPES.includes(shape)) throw refuse('Unknown shape.')
  const readPicture = (p) => {
    if (p === null || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== 2 || !PICTURE_TYPES.includes(p.mimeType) || typeof p.base64 !== 'string') throw refuse('The picture must be a PNG, JPEG or WebP file.')
    if (!p.base64.length || p.base64.length > 4 * Math.ceil(PICTURE_MAX / 3) || p.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.base64)) throw refuse('The picture is damaged or larger than 10 MB.')
    return { mimeType: p.mimeType, base64: p.base64 }
  }
  let picture = null
  if (input.picture !== undefined) picture = readPicture(input.picture)
  let pictures = []
  if (input.pictures !== undefined) {
    if (picture || model.format !== 'gemini-image') throw refuse(`${model.name} does not take several reference pictures.`)
    if (!Array.isArray(input.pictures) || input.pictures.length < 1 || input.pictures.length > PICTURES_MAX) throw refuse(`Send one to ${PICTURES_MAX} reference pictures.`)
    pictures = input.pictures.map(readPicture)
  }
  if (input.pictureUse !== undefined && (!picture || !PICTURE_USES.includes(input.pictureUse))) throw refuse('Unknown way to use the picture.')
  if (model.kind === 'video') {
    const seconds = input.seconds === undefined ? 5 : input.seconds
    const resolution = input.resolution === undefined ? '720p' : input.resolution
    if (!Number.isInteger(seconds) || seconds < model.seconds.min || seconds > model.seconds.max) throw refuse(`${model.name} makes clips of ${model.seconds.min} to ${model.seconds.max} seconds.`)
    if (!resolutionsFor(model).includes(resolution)) throw refuse(`${model.name} does not offer ${resolution}.`)
    return { model, picture, choices: { prompt, shape, seconds, resolution, ...(picture ? { pictureUse: input.pictureUse || 'start' } : {}) } }
  }
  const size = input.size === undefined ? '1K' : input.size
  if (!sizesFor(model).includes(size)) throw refuse(`${model.name} does not offer ${size}.`)
  return { model, picture, pictures, choices: { prompt, shape, size } }
}

const dataUri = p => `data:${p.mimeType};base64,${p.base64}`
const BUILDERS = {
  // Seedance 2.5 takes its shape from a starting picture and refuses a fixed one.
  seedance: (c, p, model) => ({ content: [{ type: 'text', text: c.prompt },
    ...(p ? [{ type: 'image_url', image_url: { url: dataUri(p) }, role: c.pictureUse === 'reference' ? 'reference_image' : 'first_frame' }] : [])],
    duration: c.seconds, ...(p && c.pictureUse === 'start' && model.id === 'seedance-2-5' ? {} : { ratio: RATIO[c.shape] }), resolution: c.resolution, watermark: false }),
  'gemini-image': (c, p, _model, more = []) => ({ contents: [{ role: 'user', parts: [...(p ? [p] : more).map(item => ({ inlineData: { mimeType: item.mimeType, data: item.base64 } })), { text: c.prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: RATIO[c.shape], imageSize: c.size } } }),
  // Same safety choices as Velorn's original Seedream request: one image,
  // returned inline, never fetched from a link. Seedream 5.0 Pro and Flash make
  // one image only and refuse the two batch/stream fields 4.0 accepts (seen as
  // invalid_input on real requests, 2026-11-09), so those are sent to 4.0 alone.
  seedream: (c, p, model) => ({ prompt: c.prompt, ...(p ? { image: dataUri(p) } : {}), size: dims(PIXELS[c.size][c.shape]), response_format: 'b64_json',
    ...(model.id === 'seedream-4-0' ? { sequential_image_generation: 'disabled', stream: false } : {}), watermark: true }),
  'gpt-image': (c, p) => ({ prompt: c.prompt, ...(p ? { image: [dataUri(p)] } : {}), quality: 'medium', n: 1, size: dims((c.size === '1K' ? GPT_1K : PIXELS[c.size])[c.shape]) }),
  flux: (c, p) => ({ prompt: c.prompt, ...(p ? { images: [p.base64] } : {}), aspect_ratio: RATIO[c.shape], resolution: c.size.toLowerCase() }),
  // ElevenLabs speech: one line of dialogue in one voice. Comfy fills in the model from the address.
  'eleven-dialogue': c => ({ inputs: [{ text: c.prompt, voice_id: getVoice(c.voice).voiceId }] }),
  // The length is required on this route and is what the request is charged on.
  // `loop` asks for a sound whose end runs smoothly back into its start.
  'eleven-sfx': c => ({ text: c.prompt, duration_seconds: c.seconds, ...(c.loop ? { loop: true } : {}) })
}

// Returns { model, choices, picture, body }. `choices` is the validated,
// defaulted copy of what the person picked. It never holds the picture's bytes:
// those are only in `picture` and `body`, which must not be stored or shown.
function buildCreateRequest(modelId, input) {
  const { model, choices, picture, pictures = [] } = normalize(modelId, input)
  return { model, choices: { ...choices, ...(picture || pictures.length ? { hasPicture: true } : {}) }, picture, pictures,
    body: BUILDERS[model.format](choices, picture, model, pictures) }
}

module.exports = { buildCreateRequest, SHAPES, PROMPT_MAX, PICTURE_TYPES, PICTURE_MAX, PICTURES_MAX }
