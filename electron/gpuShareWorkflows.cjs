'use strict'
// The workflows that may run on someone else's GPU through the Velorn network.
// This list is the whole of it: a job names one of these ids and a few plain
// choices, never a workflow, a node, a model file or a path. Each entry binds
// those choices into a workflow that ships with Velorn, and refuses to bind if
// that file is no longer the shape it was checked against.
//
// LTX 2.3 image to video came first. MiniMax H3 text to image and image edit
// make pictures: their files (network_minimax_h3_*.json) are the ComfyUI
// templates without the prompt rewriter, so the description that was checked is
// the description that is used.
const SHAPES = Object.freeze({ landscape: [16, 9], square: [1, 1], portrait: [9, 16] })
// The longer edge. Both divide cleanly for every shape above.
const SIZES = Object.freeze({ '720p': { landscape: [1280, 720], square: [960, 960], portrait: [720, 1280] },
  '1080p': { landscape: [1920, 1080], square: [1440, 1440], portrait: [1080, 1920] } })
const PROMPT_MAX = 2000
const IMAGE_MAX = 10 * 1024 * 1024
const IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })

function refuse(message, code = 'GPU_SHARE_INVALID') { return Object.assign(new Error(message), { code, publicMessage: message }) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// The person's choices for one job, checked and defaulted. Nothing else is accepted.
function normalizeVideoChoices(input, { seconds }) {
  if (!plain(input)) throw refuse('Missing choices for this job.')
  const allowed = ['prompt', 'shape', 'size', 'seconds', 'seed']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw refuse(`"${String(key).slice(0, 40)}" is not a choice this workflow takes.`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || prompt.length > PROMPT_MAX || /\u0000/.test(prompt)) throw refuse(`Write a description of up to ${PROMPT_MAX} characters.`)
  const shape = input.shape === undefined ? 'landscape' : input.shape
  if (!Object.hasOwn(SHAPES, shape)) throw refuse('Unknown shape.')
  const size = input.size === undefined ? '720p' : input.size
  if (!Object.hasOwn(SIZES, size)) throw refuse('Unknown size.')
  const length = input.seconds === undefined ? seconds.default : input.seconds
  if (!Number.isInteger(length) || length < seconds.min || length > seconds.max) throw refuse(`This workflow makes clips of ${seconds.min} to ${seconds.max} seconds.`)
  const seed = input.seed === undefined ? null : input.seed
  if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw refuse('The seed must be a whole number.')
  return { prompt, shape, size, seconds: length, seed }
}

// A picture job: a description, and for text to image a shape. Nothing else is accepted.
function normalizeImageChoices(input, { shapes }) {
  if (!plain(input)) throw refuse('Missing choices for this job.')
  const allowed = shapes.length ? ['prompt', 'shape', 'seed'] : ['prompt', 'seed']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw refuse(`"${String(key).slice(0, 40)}" is not a choice this workflow takes.`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || prompt.length > PROMPT_MAX || /\u0000/.test(prompt)) throw refuse(`Write a description of up to ${PROMPT_MAX} characters.`)
  const shape = !shapes.length ? null : input.shape === undefined ? 'square' : input.shape
  if (shape !== null && !shapes.includes(shape)) throw refuse('Unknown shape.')
  const seed = input.seed === undefined ? null : input.seed
  if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw refuse('The seed must be a whole number.')
  return shape === null ? { prompt, seed } : { prompt, shape, seed }
}
// MiniMax H3 is tuned for about 2048 x 2048 pixels of area; each side divides by 32.
const H3_SIZES = Object.freeze({ landscape: [2720, 1536], square: [2048, 2048], portrait: [1536, 2720] })
const H3_COMMON = Object.freeze({ '1': 'UNETLoader', '2': 'CLIPLoader', '3': 'VAELoader', '4': 'PrimitiveStringMultiline', '5': 'MiniMaxH3ImageConditioning',
  '6': 'ConditioningZeroOut', '7': 'KSampler', '8': 'VAEDecode', '9': 'SaveImage' })
const H3_EDIT_NODES = Object.freeze({ ...H3_COMMON, '10': 'LoadImage', '11': 'ResizeImageMaskNode', '12': 'ResizeImageMaskNode', '13': 'GetImageSize' })
// Binds a picture job into one of the two H3 files. The file must be exactly the nodes it was checked with: no more, no fewer.
function bindH3(nodes, workflow, choices, { imageName, prefix, randomSeed }) {
  const changed = () => refuse('The MiniMax H3 workflow in this Velorn is not the one the network was built for. Update Velorn.', 'GPU_SHARE_WORKFLOW_CHANGED')
  if (!plain(workflow) || Object.keys(workflow).length !== Object.keys(nodes).length) throw changed()
  for (const [id, classType] of Object.entries(nodes)) if (workflow[id]?.class_type !== classType || !plain(workflow[id].inputs)) throw changed()
  const bound = JSON.parse(JSON.stringify(workflow))
  const set = (id, key, value) => { if (!Object.hasOwn(bound[id].inputs, key)) throw changed(); bound[id].inputs[key] = value }
  const seed = choices.seed === null ? randomSeed() : choices.seed
  set('4', 'value', choices.prompt); set('7', 'seed', seed); set('9', 'filename_prefix', prefix)
  if (nodes['10']) { set('10', 'image', imageName); return { workflow: bound, seed } } // The result takes the picture's own shape.
  const [width, height] = H3_SIZES[choices.shape]
  set('5', 'width', width); set('5', 'height', height)
  return { workflow: bound, width, height, seed }
}

// Every node this binding touches, with the class it must still be.
const LTX_I2V_NODES = Object.freeze({ '269': 'LoadImage', '320:319': 'PrimitiveStringMultiline', '320:313': 'CLIPTextEncode', '320:328': 'PrimitiveBoolean',
  '320:312': 'PrimitiveInt', '320:299': 'PrimitiveInt', '320:300': 'PrimitiveInt', '320:301': 'PrimitiveInt',
  '320:276': 'RandomNoise', '320:277': 'RandomNoise', '320:302': 'PrimitiveBoolean', '75': 'SaveVideo' })

// Binds a job into the shipped LTX 2.3 file. `imageName` is the name ComfyUI gave the uploaded input picture (or the
// placeholder, for text to video); `prefix` is where this job's result is saved. `randomSeed` supplies a seed when none was chosen.
function bindLtx(workflow, choices, { imageName, prefix, randomSeed }, { fps, fromText }) {
  const changed = () => refuse('The LTX workflow in this Velorn is not the one the network was built for. Update Velorn.', 'GPU_SHARE_WORKFLOW_CHANGED')
  if (!plain(workflow)) throw refuse('The LTX workflow file could not be read.', 'GPU_SHARE_WORKFLOW_CHANGED')
  for (const [id, classType] of Object.entries(LTX_I2V_NODES)) if (workflow[id]?.class_type !== classType || !plain(workflow[id].inputs)) throw changed()
  const bound = JSON.parse(JSON.stringify(workflow))
  const set = (id, key, value) => { if (!Object.hasOwn(bound[id].inputs, key)) throw changed(); bound[id].inputs[key] = value }
  const [width, height] = SIZES[choices.size][choices.shape]
  const seed = choices.seed === null ? randomSeed() : choices.seed
  set('269', 'image', imageName)
  set('320:319', 'value', choices.prompt)
  set('320:313', 'text', '')
  // The prompt enhancer in this workflow rewrites prompts with a text model
  // whose refusals were removed. For a job from someone else it stays off:
  // the description that was checked is the description that is used.
  set('320:328', 'value', false)
  // The workflow's own switch: start from the picture, or ignore it and work from the description alone.
  set('320:302', 'value', fromText)
  set('320:312', 'value', width); set('320:299', 'value', height)
  set('320:300', 'value', fps); set('320:301', 'value', choices.seconds)
  set('320:276', 'noise_seed', seed); set('320:277', 'noise_seed', seed)
  set('75', 'filename_prefix', prefix)
  return { workflow: bound, width, height, seconds: choices.seconds, fps, seed }
}
// What the picture loader is given when a job has no picture: 64 grey pixels square.
const PLACEHOLDER_IMAGE = Object.freeze({ mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoEqv9ErYvQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLAB8+AWnmfUycAAAAAElFTkSuQmCC', 'base64') })

const APPROVED = Object.freeze({
  'ltx23-i2v': Object.freeze({
    id: 'ltx23-i2v', name: 'LTX 2.3 Image to Video', kind: 'video', file: 'video_ltx2_3_i2v.json', needsImage: true, minimumVramGb: 24,
    seconds: Object.freeze({ min: 3, max: 10, default: 5 }), sizes: Object.keys(SIZES), shapes: Object.keys(SHAPES), fps: 24,
    normalize(input) { return normalizeVideoChoices(input, this) },
    bind(workflow, choices, context) { return bindLtx(workflow, choices, context, { fps: this.fps, fromText: false }) },
  }),
  // The same model from a description alone: the same file with its own "Switch to Text to Video?" turned on. The picture
  // loader still has to load something, so the job runner gives it a small grey placeholder (`placeholderImage`).
  'ltx23-t2v': Object.freeze({
    id: 'ltx23-t2v', name: 'LTX 2.3 Text to Video', kind: 'video', file: 'video_ltx2_3_i2v.json', needsImage: false, placeholderImage: true, minimumVramGb: 24,
    seconds: Object.freeze({ min: 3, max: 10, default: 5 }), sizes: Object.keys(SIZES), shapes: Object.keys(SHAPES), fps: 24,
    normalize(input) { return normalizeVideoChoices(input, this) },
    bind(workflow, choices, context) { return bindLtx(workflow, choices, context, { fps: this.fps, fromText: true }) },
  }),
  'h3-t2i': Object.freeze({
    id: 'h3-t2i', name: 'MiniMax H3 Text to Image', kind: 'image', file: 'network_minimax_h3_t2i.json', needsImage: false, minimumVramGb: 32,
    shapes: Object.keys(H3_SIZES),
    normalize(input) { return normalizeImageChoices(input, this) },
    bind(workflow, choices, context) { return bindH3(H3_COMMON, workflow, choices, context) },
  }),
  'h3-edit': Object.freeze({
    id: 'h3-edit', name: 'MiniMax H3 Image Edit', kind: 'image', file: 'network_minimax_h3_edit.json', needsImage: true, minimumVramGb: 32,
    shapes: Object.freeze([]),
    normalize(input) { return normalizeImageChoices(input, this) },
    bind(workflow, choices, context) { return bindH3(H3_EDIT_NODES, workflow, choices, context) },
  }),
})

const getApproved = id => typeof id === 'string' && Object.hasOwn(APPROVED, id) ? APPROVED[id] : null
const listApproved = () => Object.values(APPROVED).map(entry => ({ id: entry.id, name: entry.name, kind: entry.kind, needsImage: entry.needsImage,
  minimumVramGb: entry.minimumVramGb, shapes: [...entry.shapes], ...(entry.kind === 'video' ? { seconds: { ...entry.seconds }, sizes: [...entry.sizes] } : {}) }))

// The picture's own first bytes must match its declared type.
function checkImage(image) {
  if (!plain(image) || !Object.hasOwn(IMAGE_TYPES, image.mimeType) || !Buffer.isBuffer(image.bytes)) throw refuse('The picture must be a PNG, JPEG or WebP file.')
  const b = image.bytes
  if (b.length < 16 || b.length > IMAGE_MAX) throw refuse('The picture is empty or larger than 10 MB.')
  const kind = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
    : b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null
  if (kind !== image.mimeType) throw refuse('The picture is not the kind of file it says it is.')
  return IMAGE_TYPES[kind]
}

module.exports = { getApproved, listApproved, checkImage, refuse, PLACEHOLDER_IMAGE, SIZES, SHAPES, PROMPT_MAX, IMAGE_MAX, IMAGE_TYPES }
