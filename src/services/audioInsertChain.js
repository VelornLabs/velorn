// Builds Web Audio node chains from audio insert lists (utils/audioInserts).
// CRITICAL PARITY CONTRACT: this module is the ONLY place insert DSP is
// defined, and it must work identically on the live AudioContext
// (AudioLayerRenderer) and the export OfflineAudioContext (exporter.js).
// Never mirror these effects in FFmpeg filters — different algorithms would
// make the export sound different from the preview.

import { getEnabledAudioInserts } from '../utils/audioInserts'

const dbToLinear = (db) => Math.pow(10, (Number(db) || 0) / 20)

// --- Synthesized impulse responses ----------------------------------------
// Exponentially decaying decorrelated noise, one-pole low-passed for damping.
// Deterministic enough for our purposes (per-render random phase is fine —
// reverb character is defined by decay/damping, not the noise seed), no
// bundled binary assets, works offline.

const REVERB_IR_SETTINGS = {
  room: { decaySeconds: 0.7, damping: 0.35 },
  hall: { decaySeconds: 2.4, damping: 0.55 },
  plate: { decaySeconds: 1.3, damping: 0.12 },
}

// Cache per context so live playback doesn't regenerate buffers on every
// graph rebuild. WeakMap keys on the context; entries die with it.
const irCache = new WeakMap()

function getImpulseResponse(context, preset) {
  const settings = REVERB_IR_SETTINGS[preset] || REVERB_IR_SETTINGS.room
  let byPreset = irCache.get(context)
  if (!byPreset) {
    byPreset = new Map()
    irCache.set(context, byPreset)
  }
  const cacheKey = `${preset}:${context.sampleRate}`
  const cached = byPreset.get(cacheKey)
  if (cached) return cached

  const sampleRate = context.sampleRate
  const length = Math.max(1, Math.round(settings.decaySeconds * sampleRate))
  const buffer = context.createBuffer(2, length, sampleRate)
  // -60 dB at the tail end of the decay window
  const decayRate = 6.907755 / settings.decaySeconds // ln(1000)

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    let lowpassState = 0
    const damping = Math.max(0, Math.min(0.98, settings.damping))
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate
      const noise = Math.random() * 2 - 1
      // One-pole low-pass for high-frequency damping of the tail
      lowpassState = lowpassState * damping + noise * (1 - damping)
      data[i] = lowpassState * Math.exp(-decayRate * t)
    }
  }

  byPreset.set(cacheKey, buffer)
  return buffer
}

// --- Node builders ----------------------------------------------------------

function buildCompressor(context, insert) {
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = insert.thresholdDb
  compressor.knee.value = insert.kneeDb
  compressor.ratio.value = insert.ratio
  compressor.attack.value = Math.max(0, insert.attackMs / 1000)
  compressor.release.value = Math.max(0.01, insert.releaseMs / 1000)

  const makeup = context.createGain()
  makeup.gain.value = dbToLinear(insert.makeupDb)
  compressor.connect(makeup)

  return {
    input: compressor,
    output: makeup,
    nodes: [compressor, makeup],
    reductionNode: compressor,
  }
}

function buildLimiter(context, insert) {
  // DynamicsCompressorNode as a hard-ish limiter: max ratio, no knee,
  // fastest attack the node supports.
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = insert.ceilingDb
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = Math.max(0.01, insert.releaseMs / 1000)

  return {
    input: limiter,
    output: limiter,
    nodes: [limiter],
    reductionNode: limiter,
  }
}

function buildReverb(context, insert) {
  const input = context.createGain()
  const sum = context.createGain()

  const dry = context.createGain()
  dry.gain.value = Math.max(0, 1 - insert.wet)
  input.connect(dry)
  dry.connect(sum)

  const convolver = context.createConvolver()
  convolver.buffer = getImpulseResponse(context, insert.preset)
  const wet = context.createGain()
  wet.gain.value = Math.max(0, insert.wet)
  input.connect(convolver)
  convolver.connect(wet)
  wet.connect(sum)

  return {
    input,
    output: sum,
    nodes: [input, dry, convolver, wet, sum],
    reductionNode: null,
  }
}

const BUILDERS = {
  compressor: buildCompressor,
  limiter: buildLimiter,
  reverb: buildReverb,
}

/**
 * Build a processing chain from an insert list. Disabled inserts are skipped.
 *
 * Returns { input, output, nodes, meters, dispose }:
 * - Connect the signal to `input`, take it from `output`. With no enabled
 *   inserts both are the same pass-through GainNode.
 * - `meters` = [{ id, type, getReductionDb }] for comp/limiter GR readouts.
 * - `dispose()` disconnects every node in the chain.
 */
export function buildInsertChain(context, inserts) {
  const enabled = getEnabledAudioInserts(inserts)

  const input = context.createGain()
  let tail = input
  const nodes = [input]
  const meters = []

  for (const insert of enabled) {
    const builder = BUILDERS[insert.type]
    if (!builder) continue
    try {
      const stage = builder(context, insert)
      tail.connect(stage.input)
      tail = stage.output
      nodes.push(...stage.nodes)
      if (stage.reductionNode) {
        const node = stage.reductionNode
        meters.push({
          id: insert.id,
          type: insert.type,
          getReductionDb: () => {
            try {
              return Number(node.reduction) || 0
            } catch (_) {
              return 0
            }
          },
        })
      }
    } catch (err) {
      console.warn(`Failed to build ${insert.type} insert, skipping:`, err)
    }
  }

  return {
    input,
    output: tail,
    nodes,
    meters,
    dispose: () => {
      for (const node of nodes) {
        try {
          node.disconnect()
        } catch (_) { /* already disconnected */ }
      }
    },
  }
}
