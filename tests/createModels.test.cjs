'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { catalog, validate, listModels, getModel, defaultModel, sizesFor, resolutionsFor, fallbackPrice, FORMATS } = require('../electron/createModels.cjs')
const { MODEL } = require('../electron/comfyRouter.cjs')

const clone = () => JSON.parse(JSON.stringify(catalog))
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.005, `${actual} is not about ${expected}`)

test('offers the agreed line-up in display order', () => {
  assert.deepEqual(listModels('video').map(m => m.name), ['Seedance 2.0 Mini', 'Seedance 2.0 Fast', 'Seedance 2.0', 'Seedance 2.5'])
  assert.deepEqual(listModels('image').map(m => m.name), ['Nano Banana 2.1', 'Nano Banana Pro', 'Nano Banana 2',
    'Seedream 5.0 Pro', 'Seedream 5.0 Flash', 'Seedream 4.0', 'GPT Image 2.5', 'FLUX 3 Image'])
  assert.equal(listModels().filter(m => ['image', 'video'].includes(m.kind)).length, 12)
})

test('preselects Seedance 2.5 and Nano Banana 2.1', () => {
  assert.equal(defaultModel('video').name, 'Seedance 2.5')
  assert.equal(defaultModel('image').name, 'Nano Banana 2.1')
  assert.throws(() => defaultModel('audio'))
})

test('uses the Sunburst version of GPT Image 2.5 and keeps the existing Seedream 4.0 path', () => {
  assert.equal(getModel('gpt-image-2-5').model, 'openai/gpt-image-2.5-sunburst')
  assert.equal(getModel('seedream-4-0').model, MODEL)
  assert.equal(getModel('missing'), null)
})

test('covers five request formats and leaves out clip editing', () => {
  assert.deepEqual([...new Set(listModels().map(m => m.format))].sort(), [...FORMATS].sort())
  assert.ok(!listModels().some(m => /omni|wan|veo/i.test(m.model)))
})

test('records which models charge for a refused request', () => {
  const charged = value => listModels().filter(m => m.refusalCharged === value).map(m => m.id)
  assert.deepEqual(charged('no'), ['seedance-2-0-mini', 'seedance-2-0-fast', 'seedance-2-0', 'seedance-2-5', 'flux-3-image'])
  assert.deepEqual(charged('unknown'), ['gpt-image-2-5', 'eleven-v4', 'eleven-v4-turbo', 'eleven-sfx-v2', 'pika-music'])
  assert.equal(charged('yes').length, 6)
})

test('offers only the sizes and resolutions each model supports', () => {
  assert.deepEqual(sizesFor(getModel('seedream-5-0-pro')), ['1K', '2K'])
  assert.deepEqual(sizesFor(getModel('flux-3-image')), ['1K', '2K', '4K'])
  assert.deepEqual(sizesFor(getModel('seedance-2-5')), [])
  assert.deepEqual(resolutionsFor(getModel('seedance-2-0-mini')), ['720p'])
  assert.deepEqual(resolutionsFor(getModel('seedance-2-0')), ['720p'])
  assert.deepEqual(resolutionsFor(getModel('seedance-2-5')), ['720p', '1080p'])
  assert.deepEqual(resolutionsFor(getModel('flux-3-image')), [])
})

test('video fallback prices match the 9 November quotes', () => {
  near(fallbackPrice('seedance-2-0-mini').usd, 0.54)
  near(fallbackPrice('seedance-2-0-fast').usd, 0.87)
  near(fallbackPrice('seedance-2-0').usd, 1.09)
  near(fallbackPrice('seedance-2-5').usd, 1.66)
  near(fallbackPrice('seedance-2-5', { seconds: 10 }).usd, 3.32)
  near(fallbackPrice('seedance-2-5', { resolution: '1080p' }).usd, 4.08)
  assert.equal(fallbackPrice('seedance-2-0', { resolution: '1080p' }), null)
  assert.equal(fallbackPrice('seedance-2-0-mini', { resolution: '1080p' }), null)
  assert.equal(fallbackPrice('seedance-2-5', { seconds: 31 }), null)
  assert.equal(fallbackPrice('seedance-2-0', { seconds: 16 }), null)
  assert.equal(fallbackPrice('seedance-2-5', { seconds: 3 }), null)
})

test('picture fallback prices match the quotes and the one paid test', () => {
  assert.deepEqual(fallbackPrice('nano-banana-2-1'), { usd: 0.055, firm: false, source: 'paid-test', asOf: '2026-11-09' })
  assert.equal(fallbackPrice('nano-banana-2-1', { size: '4K' }), null)
  near(fallbackPrice('nano-banana-2-1', { size: '2K' }).usd, 0.08)
  assert.equal(fallbackPrice('nano-banana-pro').source, 'paid-test')
  near(fallbackPrice('nano-banana-pro').usd, 0.165)
  near(fallbackPrice('flux-3-image', { size: '4K' }).usd, 0.87)
  near(fallbackPrice('seedream-5-0-pro', { size: '2K' }).usd, 0.09)
  assert.equal(fallbackPrice('seedream-5-0-pro', { size: '4K' }), null)
  near(fallbackPrice('seedream-4-0', { size: '4K', count: 4 }).usd, 0.12)
  assert.equal(fallbackPrice('flux-3-image').firm, true)
  assert.equal(fallbackPrice('flux-3-image', { count: 0 }), null)
  assert.equal(fallbackPrice('missing'), null)
})

test('GPT Image 2.5 has no price before an edit', () => {
  near(fallbackPrice('gpt-image-2-5').usd, 0.02)
  assert.equal(fallbackPrice('gpt-image-2-5', { edit: true }), null)
  assert.notEqual(fallbackPrice('flux-3-image', { edit: true }), null)
})

test('the list cannot be changed at run time', () => {
  assert.throws(() => { catalog.models.push({}) })
  assert.throws(() => { getModel('flux-3-image').usdPerImage['1K'] = 0 })
})

test('rejects a malformed list', async t => {
  const cases = {
    'two defaults': c => { c.models[0].default = true },
    'no default': c => { delete c.models.find(m => m.id === 'nano-banana-2-1').default },
    'duplicate id': c => { c.models[1].id = c.models[0].id },
    'duplicate path': c => { c.models[1].model = c.models[0].model },
    'bad path': c => { c.models[0].model = 'https://example.com/model' },
    'unknown format': c => { c.models[0].format = 'other' },
    'format and kind disagree': c => { c.models[4].format = 'seedance' },
    'missing 720p price': c => { delete c.models[0].usdPerSecond['720p'] },
    'offered length outside limits': c => { c.models[0].seconds.offered = [5, 20] },
    'zero price': c => { c.models[11].usdPerImage['1K'] = 0 },
    'skipped size': c => { delete c.models[11].usdPerImage['2K'] },
    'unknown refusal value': c => { c.models[0].refusalCharged = 'maybe' },
    'wrong version': c => { c.version = 2 }
  }
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, () => { const c = clone(); change(c); assert.throws(() => validate(c), /createModels\.json/) })
  }
  assert.doesNotThrow(() => validate(clone()))
})
