// Audio insert (effect) model shared by the mixer UI, the live preview graph,
// the export mixdown, and the MCP surface. An insert list lives on each audio
// track (`track.inserts`) and on the timeline (`masterAudioInserts`). Inserts
// process in list order, BEFORE the fader (standard desk topology:
// signal → inserts → fader → meter).
//
// Only data lives here — node construction is in services/audioInsertChain.js
// so this file stays importable from stores and MCP validation without
// touching Web Audio.

export const AUDIO_INSERT_TYPES = ['compressor', 'limiter', 'reverb']

export const REVERB_PRESETS = ['room', 'hall', 'plate']

const PARAM_DEFS = {
  compressor: {
    thresholdDb: { min: -60, max: 0, def: -24 },
    ratio: { min: 1, max: 20, def: 4 },
    kneeDb: { min: 0, max: 40, def: 6 },
    attackMs: { min: 0, max: 200, def: 10 },
    releaseMs: { min: 10, max: 1000, def: 250 },
    makeupDb: { min: 0, max: 24, def: 0 },
  },
  limiter: {
    ceilingDb: { min: -24, max: 0, def: -1 },
    releaseMs: { min: 10, max: 500, def: 50 },
  },
  reverb: {
    // preset handled separately (string enum)
    wet: { min: 0, max: 1, def: 0.25 },
  },
}

export const AUDIO_INSERT_LABELS = {
  compressor: { full: 'Compressor', short: 'CMP' },
  limiter: { full: 'Limiter', short: 'LIM' },
  reverb: { full: 'Reverb', short: 'REV' },
}

const clampNumber = (value, { min, max, def }) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return def
  return Math.max(min, Math.min(max, parsed))
}

let insertIdCounter = 1

export function createAudioInsert(type) {
  if (!AUDIO_INSERT_TYPES.includes(type)) return null
  const id = `fx-${Date.now().toString(36)}-${insertIdCounter++}`
  return normalizeAudioInsert({ id, type, enabled: true })
}

export function normalizeAudioInsert(insert) {
  if (!insert || !AUDIO_INSERT_TYPES.includes(insert.type)) return null
  const defs = PARAM_DEFS[insert.type]
  const normalized = {
    id: typeof insert.id === 'string' && insert.id ? insert.id : `fx-${Date.now().toString(36)}-${insertIdCounter++}`,
    type: insert.type,
    enabled: insert.enabled !== false,
  }
  for (const [key, def] of Object.entries(defs)) {
    normalized[key] = clampNumber(insert[key], def)
  }
  if (insert.type === 'reverb') {
    normalized.preset = REVERB_PRESETS.includes(insert.preset) ? insert.preset : 'room'
  }
  return normalized
}

/**
 * Normalize an insert list from any source (UI, project file, MCP payload).
 * Drops unknown types, clamps params, guarantees ids.
 */
export function normalizeAudioInserts(inserts) {
  if (!Array.isArray(inserts)) return []
  return inserts.map(normalizeAudioInsert).filter(Boolean)
}

export function getEnabledAudioInserts(inserts) {
  return normalizeAudioInserts(inserts).filter((insert) => insert.enabled)
}

/**
 * Stable signature for change detection (live graph rebuilds, export cache
 * decisions). Only audible-relevant fields participate.
 */
export function getAudioInsertsSignature(inserts) {
  return JSON.stringify(getEnabledAudioInserts(inserts))
}

export function hasEnabledAudioInserts(inserts) {
  return getEnabledAudioInserts(inserts).length > 0
}
