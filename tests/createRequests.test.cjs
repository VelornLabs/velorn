'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCreateRequest, PROMPT_MAX } = require('../electron/createRequests.cjs')
const { listModels } = require('../electron/createModels.cjs')

const P = 'A red fox trotting through a snowy pine forest'
const body = (id, input) => buildCreateRequest(id, { prompt: P, ...input }).body
const refused = (id, input) => assert.throws(() => buildCreateRequest(id, input), { code: 'CREATE_REQUEST_INVALID' })

test('Seedance: text, length, shape and resolution', () => {
  assert.deepEqual(body('seedance-2-5'), { content: [{ type: 'text', text: P }], duration: 5, ratio: '16:9', resolution: '720p', watermark: false })
  assert.deepEqual(body('seedance-2-5', { seconds: 10, shape: 'portrait', resolution: '1080p' }),
    { content: [{ type: 'text', text: P }], duration: 10, ratio: '9:16', resolution: '1080p', watermark: false })
  assert.equal(body('seedance-2-0-mini', { shape: 'square' }).ratio, '1:1')
})

test('Seedance: refuses lengths and resolutions a model does not offer', () => {
  refused('seedance-2-0-mini', { prompt: P, resolution: '1080p' })
  refused('seedance-2-0', { prompt: P, resolution: '1080p' })
  refused('seedance-2-0', { prompt: P, seconds: 16 })
  refused('seedance-2-5', { prompt: P, seconds: 3 })
  refused('seedance-2-5', { prompt: P, seconds: 5.5 })
  refused('seedance-2-5', { prompt: P, size: '2K' })
})

test('Nano Banana: one picture with shape and size', () => {
  assert.deepEqual(body('nano-banana-2-1'), { contents: [{ role: 'user', parts: [{ text: P }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '1K' } } })
  assert.deepEqual(body('nano-banana-pro', { shape: 'square', size: '4K' }).generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '4K' })
})

test('Seedream: one inline picture at a pixel size inside each model\'s limits', () => {
  assert.deepEqual(body('seedream-4-0', { shape: 'square' }), { prompt: P, size: '1024x1024', response_format: 'b64_json',
    sequential_image_generation: 'disabled', stream: false, watermark: true })
  assert.equal(body('seedream-5-0-pro').size, '1376x768')
  for (const id of ['seedream-5-0-pro', 'seedream-5-0-flash']) assert.deepEqual(body(id), { prompt: P, size: '1376x768', response_format: 'b64_json', watermark: true }, `${id} takes no batch or stream fields`)
  assert.equal(body('seedream-5-0-pro', { size: '2K', shape: 'portrait' }).size, '1440x2560')
  assert.equal(body('seedream-4-0', { size: '4K' }).size, '3840x2160')
  refused('seedream-5-0-pro', { prompt: P, size: '4K' })
  refused('seedream-5-0-flash', { prompt: P, size: '4K' })
  for (const id of ['seedream-5-0-pro', 'seedream-4-0']) for (const shape of ['landscape', 'square', 'portrait']) {
    const [w, h] = body(id, { shape }).size.split('x').map(Number)
    assert.ok(w * h >= 1024 * 1024, `${id} ${shape} is under one megapixel`)
  }
})

test('GPT Image 2.5: medium quality, one picture', () => {
  assert.deepEqual(body('gpt-image-2-5'), { prompt: P, quality: 'medium', n: 1, size: '1536x1024' })
  assert.equal(body('gpt-image-2-5', { shape: 'square' }).size, '1024x1024')
  assert.equal(body('gpt-image-2-5', { shape: 'portrait' }).size, '1024x1536')
  assert.equal(body('gpt-image-2-5', { size: '2K', shape: 'square' }).size, '2048x2048')
  assert.equal(body('gpt-image-2-5', { size: '4K' }).size, '3840x2160')
})

test('FLUX 3 Image: shape and size class', () => {
  assert.deepEqual(body('flux-3-image'), { prompt: P, aspect_ratio: '16:9', resolution: '1k' })
  assert.deepEqual(body('flux-3-image', { shape: 'portrait', size: '4K' }), { prompt: P, aspect_ratio: '9:16', resolution: '4k' })
})

test('every listed model builds with its defaults and returns the stored choices', () => {
  for (const model of listModels().filter(m => ['image', 'video'].includes(m.kind))) {
    const built = buildCreateRequest(model.id, { prompt: `  ${P}  ` })
    assert.equal(built.model, model)
    assert.equal(built.choices.prompt, P)
    assert.equal(built.choices.shape, 'landscape')
    assert.ok(JSON.stringify(built.body).includes(P))
  }
})

test('refuses bad input before anything could be sent', () => {
  refused('missing-model', { prompt: P })
  refused('flux-3-image', null)
  refused('flux-3-image', { prompt: '   ' })
  refused('flux-3-image', { prompt: 'x'.repeat(PROMPT_MAX + 1) })
  refused('flux-3-image', { prompt: 'bad\x00prompt' })
  refused('flux-3-image', { prompt: P, shape: 'circle' })
  refused('flux-3-image', { prompt: P, seconds: 5 })
  refused('flux-3-image', { prompt: P, images: ['data:image/png;base64,AAAA'] })
  refused('seedance-2-5', { prompt: P, startFrom: 'picture' })
})

// ---- one input picture ---------------------------------------------------
const PIC = { mimeType: 'image/png', base64: Buffer.from('synthetic picture bytes!').toString('base64') }
const URI = `data:image/png;base64,${PIC.base64}`

test('each format carries one input picture in its own way', () => {
  assert.deepEqual(body('nano-banana-2-1', { picture: PIC }).contents[0].parts, [{ inlineData: { mimeType: 'image/png', data: PIC.base64 } }, { text: P }])
  assert.equal(body('seedream-5-0-pro', { picture: PIC }).image, URI)
  assert.deepEqual(body('gpt-image-2-5', { picture: PIC }).image, [URI])
  assert.deepEqual(body('flux-3-image', { picture: PIC }).images, [PIC.base64])
  for (const id of ['nano-banana-2-1', 'seedream-5-0-pro', 'gpt-image-2-5', 'flux-3-image']) {
    const { image, images, ...rest } = body(id, { picture: PIC }), plain = body(id)
    if (id === 'nano-banana-2-1') rest.contents = plain.contents
    assert.deepEqual(rest, plain, `${id} changes nothing else`)
  }
})

test('Seedance starts a clip from a picture or uses it as a reference', () => {
  const start = body('seedance-2-0', { picture: PIC })
  assert.deepEqual(start.content[1], { type: 'image_url', image_url: { url: URI }, role: 'first_frame' })
  assert.equal(start.ratio, '16:9')
  assert.equal(body('seedance-2-0', { picture: PIC, pictureUse: 'reference' }).content[1].role, 'reference_image')
  assert.equal('ratio' in body('seedance-2-5', { picture: PIC }), false, 'Seedance 2.5 takes its shape from the starting picture')
  assert.equal(body('seedance-2-5', { picture: PIC, pictureUse: 'reference' }).ratio, '16:9')
})

test('the stored choices say a picture was used but never hold its bytes', () => {
  const built = buildCreateRequest('seedance-2-5', { prompt: P, picture: PIC })
  assert.deepEqual(built.choices, { prompt: P, shape: 'landscape', seconds: 5, resolution: '720p', pictureUse: 'start', hasPicture: true })
  assert.ok(!JSON.stringify(built.choices).includes(PIC.base64))
  assert.equal(buildCreateRequest('flux-3-image', { prompt: P }).picture, null)
  assert.equal('hasPicture' in buildCreateRequest('flux-3-image', { prompt: P }).choices, false)
})

test('refuses a picture of the wrong kind, a damaged one, or several', () => {
  refused('flux-3-image', { prompt: P, picture: { mimeType: 'image/svg+xml', base64: PIC.base64 } })
  refused('flux-3-image', { prompt: P, picture: { mimeType: 'image/png', base64: 'not base64!' } })
  refused('flux-3-image', { prompt: P, picture: { mimeType: 'image/png', base64: '' } })
  refused('flux-3-image', { prompt: P, picture: { mimeType: 'image/png', base64: PIC.base64, url: 'https://example.com/a.png' } })
  refused('flux-3-image', { prompt: P, picture: 'https://example.com/a.png' })
  refused('flux-3-image', { prompt: P, picture: [PIC, PIC] })
  refused('flux-3-image', { prompt: P, picture: PIC, pictureUse: 'start' })
  refused('seedance-2-5', { prompt: P, pictureUse: 'start' })
  refused('seedance-2-5', { prompt: P, picture: PIC, pictureUse: 'last' })
})
