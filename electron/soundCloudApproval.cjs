'use strict'
// Sound tab cloud models that run as ComfyUI partner nodes (Sonilo, Fish Audio,
// HeyGen). The Sound tab shows the price on its Generate button, so a person's
// click there approves the request, the same way a Create request is approved.
//
// That only holds for the exact workflows the Sound tab builds. This file
// recognises them, strictly, and works out the most each could cost from its own
// price list, never from anything the screen says. Anything else, however
// similar, gets the native confirmation as before. Pure: no disk, no network.
const BUTTON_APPROVAL_USD = 2
const TEXT_MAX = 3000
const SONILO_PROMPT_MAX = 2000

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysAre = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const node = (value, classType, keys) => keysAre(value, ['class_type', 'inputs']) && value.class_type === classType && keysAre(value.inputs, keys)
const link = (value, from) => Array.isArray(value) && value.length === 2 && value[0] === from && value[1] === 0
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const seed = value => Number.isSafeInteger(value) && value >= 0
const save = (value, from, prefix) => node(value, 'SaveAudioMP3', ['audio', 'filename_prefix', 'quality'])
  && link(value.inputs.audio, from) && value.inputs.filename_prefix === prefix && value.inputs.quality === 'V0'
const seconds = value => Number.isInteger(value) && value >= 10 && value <= 360
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 120

function sonilo(workflow) {
  if (!keysAre(workflow, ['1', '2']) || !save(workflow[2], '1', 'audio/velorn_sonilo')) return null
  const first = workflow[1]
  // Instrumental: $0.0025 a second.
  if (node(first, 'SoniloTextToMusic', ['prompt', 'duration', 'seed'])) {
    const { prompt, duration } = first.inputs
    return text(prompt, SONILO_PROMPT_MAX) && seconds(duration) && seed(first.inputs.seed) ? { label: 'Sonilo', maxUsd: duration * 0.0025 } : null
  }
  // With lyrics: $0.0032175 a second.
  if (node(first, 'SoniloMusic15', ['prompt', 'duration', 'duration.seconds', 'seed'])) {
    const { prompt, duration } = first.inputs, length = first.inputs['duration.seconds']
    return text(prompt, SONILO_PROMPT_MAX) && duration === 'custom' && seconds(length) && seed(first.inputs.seed) ? { label: 'Sonilo', maxUsd: length * 0.0032175 } : null
  }
  return null
}

function heygen(workflow) {
  if (!keysAre(workflow, ['1', '2']) || !save(workflow[2], '1', 'audio/velorn_heygen')) return null
  const first = workflow[1]
  if (!node(first, 'HeyGenTextToSpeechNode', ['text', 'voice', 'custom_voice_id', 'speed', 'ssml', 'seed'])) return null
  const inputs = first.inputs
  if (!text(inputs.text, TEXT_MAX) || !name(inputs.voice) || inputs.custom_voice_id !== '' || inputs.speed !== 1 || inputs.ssml !== false || !seed(inputs.seed)) return null
  // Priced on the recording: $0.00095 a second. Nobody speaks slower than five
  // characters a second, so that is the longest this text can run.
  return { label: 'HeyGen', maxUsd: Math.max(10, inputs.text.length / 5) * 0.00095 }
}

const FISH = { 's2.1-pro': 21.45, 'drama-3': 35.75 } // dollars for a million bytes of text
function fish(workflow) {
  if (!keysAre(workflow, ['1', '2', '3']) || !save(workflow[3], '2', 'audio/velorn_fish')) return null
  if (!node(workflow[1], 'FishAudioVoiceSelector', ['voice']) || !name(workflow[1].inputs.voice)) return null
  const second = workflow[2]
  if (!node(second, 'FishAudioTextToSpeech', ['text', 'model', 'model.voices.voice0', 'model.temperature', 'model.top_p', 'model.speed', 'model.volume', 'model.normalize', 'seed'])) return null
  const inputs = second.inputs
  if (!text(inputs.text, TEXT_MAX) || !Object.hasOwn(FISH, inputs.model) || !link(inputs['model.voices.voice0'], '1') || inputs['model.temperature'] !== 0.7
    || inputs['model.top_p'] !== 0.7 || inputs['model.speed'] !== 1 || inputs['model.volume'] !== 0 || inputs['model.normalize'] !== true || !seed(inputs.seed)) return null
  return { label: 'Fish Audio', maxUsd: Buffer.byteLength(inputs.text, 'utf8') * FISH[inputs.model] / 1e6 }
}

// { label, maxUsd } when `workflow` is one of the Sound tab's own cloud requests
// and cannot cost more than a click may approve; null otherwise.
function soundCloudApproval(workflow) {
  try {
    const found = sonilo(workflow) || heygen(workflow) || fish(workflow)
    return found && Number.isFinite(found.maxUsd) && found.maxUsd > 0 && found.maxUsd <= BUTTON_APPROVAL_USD
      ? { label: found.label, maxUsd: Math.ceil(found.maxUsd * 10000) / 10000 } : null
  } catch { return null }
}

module.exports = { soundCloudApproval, BUTTON_APPROVAL_USD }
