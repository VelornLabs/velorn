// FLUX.2 klein 4B (distilled, Apache-2.0): Velorn's local picture model for
// the Director. One light model does both jobs: a picture from words alone
// (cast portraits, shots with nobody in them) and a picture that keeps the
// character from one or more reference pictures (keyframes).
//
// The bundled graph (public/workflows/image_flux2_klein_4b.json) has one
// reference. This shapes it for a job: no reference, one, or several.

export const FLUX2_KLEIN_WORKFLOW_ID = 'flux2-klein'
export const FLUX2_KLEIN_MAX_REFERENCES = 3

const REFERENCE_NODE_IDS = ['76', '80', '122', '123', '121']
const snap16 = (value, fallback) => {
  const number = Math.round(Number(value) / 16) * 16
  return Number.isFinite(number) && number >= 256 ? Math.min(number, 2048) : fallback
}

// Tells the model what the reference pictures are for. Without this it treats
// them loosely and the character drifts more from shot to shot.
export function buildKleinReferencePrompt(prompt, referenceCount) {
  const text = String(prompt || '').trim()
  if (!(referenceCount > 0)) return text
  const lead = referenceCount === 1
    ? 'Use the character from the reference image and keep their face, colours and body proportions exactly the same.'
    : 'Use the characters from the reference images and keep each one\'s face, colours and body proportions exactly the same.'
  return `${lead} New picture: ${text}`
}

export function modifyFlux2KleinWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    inputImage = '',
    referenceImages = [],
    seed = Math.floor(Math.random() * 1000000000000),
    width = 1280,
    height = 720,
    filenamePrefix = '',
  } = options
  const graph = JSON.parse(JSON.stringify(workflow))
  const references = [inputImage, ...(Array.isArray(referenceImages) ? referenceImages : [])]
    .map((name) => String(name || '').trim())
    .filter((name, index, list) => name && list.indexOf(name) === index)
    .slice(0, FLUX2_KLEIN_MAX_REFERENCES)

  const w = snap16(width, 1280)
  const h = snap16(height, 720)
  graph['74'].inputs.text = buildKleinReferencePrompt(prompt, references.length)
  graph['73'].inputs.noise_seed = Math.abs(Math.floor(Number(seed) || 0))
  graph['62'].inputs.width = w
  graph['62'].inputs.height = h
  graph['66'].inputs.width = w
  graph['66'].inputs.height = h
  if (filenamePrefix) graph['9'].inputs.filename_prefix = filenamePrefix

  for (const id of REFERENCE_NODE_IDS) delete graph[id]
  let positive = ['74', 0]
  let negative = ['82', 0]
  references.forEach((name, index) => {
    const base = 200 + index * 10
    const load = String(base), scale = String(base + 1), encode = String(base + 2), pos = String(base + 3), neg = String(base + 4)
    graph[load] = { class_type: 'LoadImage', _meta: { title: `Reference image ${index + 1}` }, inputs: { image: name } }
    graph[scale] = { class_type: 'ImageScaleToTotalPixels', inputs: { upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1, image: [load, 0] } }
    graph[encode] = { class_type: 'VAEEncode', inputs: { pixels: [scale, 0], vae: ['72', 0] } }
    graph[pos] = { class_type: 'ReferenceLatent', inputs: { conditioning: positive, latent: [encode, 0] } }
    graph[neg] = { class_type: 'ReferenceLatent', inputs: { conditioning: negative, latent: [encode, 0] } }
    positive = [pos, 0]
    negative = [neg, 0]
  })
  graph['63'].inputs.positive = positive
  graph['63'].inputs.negative = negative
  return graph
}
