'use strict'
// The models Velorn's Create tab offers through Comfy Router, in display order.
// The data lives in createModels.json so it can be read without running code.
// Prices here are fallbacks recorded on `pricesAsOf`; Create asks Comfy for a
// live quote before showing a cost and uses these only when it cannot.
const data = require('./createModels.json')

const KINDS = ['image', 'video', 'voice', 'sound', 'music']
const AUDIO_KINDS = ['voice', 'sound', 'music']
// Which kind each audio request format makes.
const AUDIO_FORMATS = { 'eleven-dialogue': 'voice', 'eleven-sfx': 'sound' }
const FORMATS = ['seedance', 'gemini-image', 'seedream', 'gpt-image', 'flux', ...Object.keys(AUDIO_FORMATS)]
const REFUSAL = ['yes', 'no', 'unknown']
const QUOTES = ['firm', 'range']
const SOURCES = ['quote', 'paid-test', 'list']
const SIZES = ['1K', '2K', '4K']
const RESOLUTIONS = ['720p', '1080p']
const MODEL_PATH = /^[a-z0-9-]+\/[a-z0-9._-]+$/

function fail(message) { throw new Error(`createModels.json: ${message}`) }
const price = value => typeof value === 'number' && Number.isFinite(value) && value > 0

function validate(catalog) {
  if (!catalog || catalog.version !== 1) fail('unsupported version')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(catalog.pricesAsOf)) fail('pricesAsOf must be a date')
  if (!price(catalog.creditsPerUsd)) fail('creditsPerUsd must be a positive number')
  if (!Array.isArray(catalog.models) || !catalog.models.length) fail('models must be a non-empty list')
  const ids = new Set(), paths = new Set()
  for (const m of catalog.models) {
    const at = `model "${m && m.id}"`
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) fail('every model needs a lowercase id')
    if (ids.has(m.id)) fail(`${at} is listed twice`)
    ids.add(m.id)
    if (!KINDS.includes(m.kind)) fail(`${at} has an unknown kind`)
    if (typeof m.name !== 'string' || !m.name.trim()) fail(`${at} needs a name`)
    if (typeof m.note !== 'string' || !m.note.trim()) fail(`${at} needs a note`)
    if (typeof m.model !== 'string' || !MODEL_PATH.test(m.model)) fail(`${at} has a malformed Comfy model path`)
    if (paths.has(m.model)) fail(`${at} repeats a Comfy model path`)
    paths.add(m.model)
    if (!FORMATS.includes(m.format)) fail(`${at} has an unknown request format`)
    if ((m.format === 'seedance') !== (m.kind === 'video')) fail(`${at} has a format that does not match its kind`)
    if (AUDIO_KINDS.includes(m.kind) !== (m.format in AUDIO_FORMATS) || (m.format in AUDIO_FORMATS && AUDIO_FORMATS[m.format] !== m.kind)) fail(`${at} has a format that does not match its kind`)
    // `delivery: "sync"` marks a model Comfy only runs on its wait-for-the-result route.
    if (!(m.delivery === undefined || m.delivery === 'sync' && AUDIO_KINDS.includes(m.kind))) fail(`${at} has an unknown delivery`)
    // `pending: true` keeps a model off the screen until a real request has shown where its result is stored.
    if (!(m.pending === undefined || m.pending === true)) fail(`${at} has a bad pending value`)
    if (!REFUSAL.includes(m.refusalCharged)) fail(`${at} has an unknown refusalCharged value`)
    if (!QUOTES.includes(m.quote)) fail(`${at} has an unknown quote value`)
    if (!SOURCES.includes(m.priceSource)) fail(`${at} has an unknown priceSource`)
    if (m.kind === 'voice') {
      if (!m.characters || !Number.isInteger(m.characters.max) || m.characters.max < 1 || m.characters.max > 5000) fail(`${at} has a bad character limit`)
      if (!price(m.usdPer1kCharacters)) fail(`${at} needs a price per 1,000 characters`)
    } else if (m.kind === 'sound' || m.kind === 'music') {
      const s = m.seconds
      if (!s || !Number.isInteger(s.min) || !Number.isInteger(s.max) || s.min < 1 || s.max < s.min) fail(`${at} has bad seconds limits`)
      if (!Array.isArray(s.offered) || !s.offered.length || s.offered.some(n => !Number.isInteger(n) || n < s.min || n > s.max)) fail(`${at} offers a length outside its limits`)
      if (!price(m.usdPerAudioSecond)) fail(`${at} needs a price per second`)
    } else if (m.kind === 'video') {
      const s = m.seconds
      if (!s || !Number.isInteger(s.min) || !Number.isInteger(s.max) || s.min < 1 || s.max < s.min) fail(`${at} has bad seconds limits`)
      if (!Array.isArray(s.offered) || !s.offered.length || s.offered.some(n => !Number.isInteger(n) || n < s.min || n > s.max)) fail(`${at} offers a length outside its limits`)
      const rates = m.usdPerSecond || {}
      if (!price(rates['720p'])) fail(`${at} needs a 720p price`)
      for (const [resolution, value] of Object.entries(rates)) {
        if (!RESOLUTIONS.includes(resolution) || !price(value)) fail(`${at} has a bad price for ${resolution}`)
      }
    } else {
      const sizes = m.usdPerImage || {}
      if (!('1K' in sizes) || !price(sizes['1K'])) fail(`${at} needs a 1K price`)
      for (const [size, value] of Object.entries(sizes)) {
        if (!SIZES.includes(size) || !(value === null || price(value))) fail(`${at} has a bad price for ${size}`)
      }
      if (SIZES.filter(size => size in sizes).join() !== SIZES.slice(0, Object.keys(sizes).length).join()) fail(`${at} skips a size`)
    }
  }
  for (const kind of KINDS) {
    const defaults = catalog.models.filter(m => m.kind === kind && m.default === true)
    // Music has no cloud model: it is made on the person's own computer, outside this list.
    if (defaults.length !== 1 && catalog.models.some(m => m.kind === kind)) fail(`there must be exactly one default ${kind} model`)
  }
  const voices = catalog.voices
  if (!Array.isArray(voices) || !voices.length) fail('voices must be a non-empty list')
  const voiceIds = new Set()
  for (const v of voices) {
    if (!v || typeof v.id !== 'string' || !/^[a-z0-9-]+$/.test(v.id) || voiceIds.has(v.id)) fail('every voice needs its own lowercase id')
    voiceIds.add(v.id)
    if (typeof v.name !== 'string' || !v.name.trim() || typeof v.note !== 'string' || !v.note.trim()) fail(`voice "${v.id}" needs a name and a note`)
    if (typeof v.voiceId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(v.voiceId)) fail(`voice "${v.id}" has a malformed provider id`)
    if (typeof v.verified !== 'boolean') fail(`voice "${v.id}" must say whether it is verified`)
  }
  if (!voices.some(v => v.verified)) fail('at least one voice must be verified')
  return catalog
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

const catalog = freeze(validate(data))
const byId = new Map(catalog.models.map(m => [m.id, m]))

function listModels(kind) {
  if (kind !== undefined && !KINDS.includes(kind)) throw new Error('Unknown kind')
  return catalog.models.filter(m => kind === undefined || m.kind === kind)
}
function getModel(id) { return byId.get(id) || null }
function defaultModel(kind) {
  if (!KINDS.includes(kind)) throw new Error('Unknown kind')
  return catalog.models.find(m => m.kind === kind && m.default === true)
}
// Voices that have been heard working on a real request. The rest stay off the screen.
function listVoices({ unverified = false } = {}) { return catalog.voices.filter(v => unverified || v.verified) }
function getVoice(id) { return catalog.voices.find(v => v.id === id) || null }
function sizesFor(model) { return model.kind === 'image' ? SIZES.filter(size => size in model.usdPerImage) : [] }
function resolutionsFor(model) { return model.kind === 'video' ? RESOLUTIONS.filter(r => r in model.usdPerSecond) : [] }

// The recorded price for one request, or null when no price is on record
// (an unsupported option, a size Comfy could not quote, or an edit on a model
// that cannot be quoted before an edit). `firm` is false where Comfy only
// gives a range, so the screen should say "usually about".
function fallbackPrice(id, options = {}) {
  const model = getModel(id)
  if (!model) return null
  const stamp = { firm: model.quote === 'firm', source: model.priceSource, asOf: catalog.pricesAsOf }
  if (model.kind === 'voice') {
    const { characters } = options
    if (!Number.isInteger(characters) || characters < 1 || characters > model.characters.max) return null
    return { usd: model.usdPer1kCharacters * characters / 1000, ...stamp }
  }
  if (model.kind === 'sound' || model.kind === 'music') {
    const { seconds = model.seconds.offered[0] } = options
    if (!Number.isInteger(seconds) || seconds < model.seconds.min || seconds > model.seconds.max) return null
    return { usd: model.usdPerAudioSecond * seconds, ...stamp }
  }
  if (model.kind === 'video') {
    const { seconds = 5, resolution = '720p' } = options
    const rate = model.usdPerSecond[resolution]
    if (!rate || !Number.isInteger(seconds) || seconds < model.seconds.min || seconds > model.seconds.max) return null
    return { usd: rate * seconds, firm: model.quote === 'firm', source: model.priceSource, asOf: catalog.pricesAsOf }
  }
  const { size = '1K', count = 1, edit = false } = options
  if (edit && model.editQuote === false) return null
  const each = model.usdPerImage[size]
  if (!each || !Number.isInteger(count) || count < 1) return null
  return { usd: each * count, firm: model.quote === 'firm', source: model.priceSource, asOf: catalog.pricesAsOf }
}

module.exports = { catalog, validate, listModels, getModel, defaultModel, sizesFor, resolutionsFor, fallbackPrice, listVoices, getVoice,
  KINDS, AUDIO_KINDS, FORMATS, SIZES, RESOLUTIONS }
