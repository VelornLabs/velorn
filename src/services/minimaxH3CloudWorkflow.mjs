// MiniMax H3 in the cloud for a music video shot, through ComfyUI's paid
// "MiniMax H3 Reference to Video" node (Comfy credits).
//
// The keyframe and the shot's part of the song both go in as references. H3
// cannot mix an exact first frame with reference audio, so the clip looks like
// the keyframe but does not start on that exact picture.
//
// Why through ComfyUI and not Comfy Router: the Router's H3 refuses audio
// (tested 2026-11-11), and nothing else on the Router gave lip sync Jaime
// accepted. See docs/DIRECTOR_DIRECTION.md.
import { h3MotionWords, h3SceneWords } from './minimaxH3LocalWorkflow.mjs'

export const MINIMAX_H3_CLOUD_WORKFLOW_ID = 'minimax-h3-r2v'
// Prices are Comfy's list prices on 2026-11-11, shown as a guide only.
export const MINIMAX_H3_CLOUD_LEVELS = Object.freeze([
  { id: 'standard', label: 'Standard', resolution: '768P', usdPerSecond: 0.1287, helper: '768p. About $0.13 a second.' },
  { id: 'high', label: 'High', resolution: '2K', usdPerSecond: 0.1859, helper: '2K. About $0.19 a second.' },
])
export const MINIMAX_H3_CLOUD_SECONDS = Object.freeze({ min: 4, max: 15 })

export function normalizeH3CloudLevel(value) {
  return MINIMAX_H3_CLOUD_LEVELS.some((level) => level.id === value) ? value : 'standard'
}

// The node takes whole seconds, 4 to 15. Round up so the clip never ends
// before the shot does.
export function h3CloudSeconds(seconds) {
  const wanted = Math.ceil((Number(seconds) || 5) - 1e-6)
  return Math.max(MINIMAX_H3_CLOUD_SECONDS.min, Math.min(MINIMAX_H3_CLOUD_SECONDS.max, wanted))
}

export function h3CloudPriceUsd(seconds, levelId) {
  const level = MINIMAX_H3_CLOUD_LEVELS.find((entry) => entry.id === normalizeH3CloudLevel(levelId))
  return Math.round(level.usdPerSecond * h3CloudSeconds(seconds) * 100) / 100
}

const RATIOS = [['21:9', 21 / 9], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['9:16', 9 / 16]]
function closestRatio(width, height) {
  const wanted = (Number(width) || 16) / (Number(height) || 9)
  return RATIOS.reduce((best, entry) => (Math.abs(entry[1] - wanted) < Math.abs(best[1] - wanted) ? entry : best))[0]
}

const FIXED_REFERENCES = 'Use <Picture 1> as the exact character, clothes, objects, place and framing reference. Use <Audio 1> exactly as it is; the singer performs it with precise mouth timing.'
const FIXED_CLOSING = 'One continuous shot, no cuts, no text, no new characters or objects.'

// Same idea as the local shot text: start from the words that made the
// keyframe, then the script's action.
export function buildH3CloudShotPrompt({ keyframePrompt = '', motionPrompt = '' } = {}) {
  const scene = h3SceneWords(keyframePrompt)
  const motion = h3MotionWords(motionPrompt)
  return [
    FIXED_REFERENCES,
    scene ? `${scene}.` : '',
    motion && !/[.!?"]$/.test(motion) ? `${motion}.` : motion,
    FIXED_CLOSING,
  ].filter(Boolean).join(' ')
}

// `inputAudio` must already be cut to this shot's part of the song: the node
// uses the whole file it is given.
export function modifyMinimaxH3CloudWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    keyframePrompt = '',
    inputImage = '',
    inputAudio = '',
    duration = 5,
    width = 1280,
    height = 720,
    seed = Math.floor(Math.random() * 2000000000),
    level = 'standard',
    filenamePrefix = '',
  } = options
  if (!inputImage) throw new Error('This shot needs its keyframe first.')
  if (!inputAudio) throw new Error('This shot needs the song. Add the song in the Song step.')
  const graph = JSON.parse(JSON.stringify(workflow))
  const chosen = MINIMAX_H3_CLOUD_LEVELS.find((entry) => entry.id === normalizeH3CloudLevel(level))
  const node = Object.values(graph).find((entry) => entry?.class_type === 'MinimaxHailuo03ReferenceNode')
  if (!node) throw new Error('The cloud MiniMax H3 workflow is missing its video node.')
  const loader = (key) => (Array.isArray(node.inputs[key]) ? graph[String(node.inputs[key][0])] : null)
  const picture = loader('model.reference_images.image_1')
  const song = loader('model.reference_audios.audio_1')
  if (!picture?.inputs || !song?.inputs) throw new Error('The cloud MiniMax H3 workflow is missing its picture or song input.')

  node.inputs.model = 'MiniMax H3'
  node.inputs['model.prompt'] = buildH3CloudShotPrompt({ keyframePrompt, motionPrompt: prompt })
  node.inputs['model.resolution'] = chosen.resolution
  node.inputs['model.ratio'] = closestRatio(width, height)
  node.inputs['model.duration'] = h3CloudSeconds(duration)
  node.inputs.seed = Math.abs(Math.floor(Number(seed) || 0)) % 4294967296
  node.inputs.watermark = false
  picture.inputs.image = inputImage
  song.inputs.audio = inputAudio
  for (const entry of Object.values(graph)) {
    if (entry?.class_type === 'SaveVideo' && filenamePrefix) entry.inputs.filename_prefix = filenamePrefix
  }
  return graph
}

// ---------- MiniMax H3 Max Lip Sync ----------
// The cloud model the Videos step uses. It takes only the keyframe and this
// shot's part of the song: the audio drives the mouth, so it cannot drift into
// invented sound the way the Reference kind above did (half a clip, tested
// 2026-11-11). It starts on the exact keyframe. It takes no prompt, so the
// shot is a performance from the still: no script action, no camera move.
export const MINIMAX_H3_LIP_SYNC_WORKFLOW_ID = 'minimax-h3-lip-sync'
export const MINIMAX_H3_LIP_SYNC = Object.freeze({ resolution: '768P', minSeconds: 5, maxSeconds: 899, usdPerSecond: { low: 0.1144, high: 0.1373 } })

// The clip is as long as the audio it is given, and the node needs at least
// five seconds. A shorter shot gets five seconds of song; the extra is cut on
// the timeline.
export function h3LipSyncSeconds(seconds) {
  const wanted = Number(seconds) || MINIMAX_H3_LIP_SYNC.minSeconds
  return Math.max(MINIMAX_H3_LIP_SYNC.minSeconds, Math.min(MINIMAX_H3_LIP_SYNC.maxSeconds, Math.round(wanted * 100) / 100))
}

export function h3LipSyncPriceUsd(seconds) {
  const length = h3LipSyncSeconds(seconds)
  const cents = (rate) => Math.round(rate * length * 100) / 100
  return { low: cents(MINIMAX_H3_LIP_SYNC.usdPerSecond.low), high: cents(MINIMAX_H3_LIP_SYNC.usdPerSecond.high) }
}

// `inputAudio` must already be cut to this shot's part of the song.
export function modifyMinimaxH3LipSyncWorkflow(workflow, options = {}) {
  const { inputImage = '', inputAudio = '', seed = 42, filenamePrefix = '' } = options
  if (!inputImage) throw new Error('This shot needs its keyframe first.')
  if (!inputAudio) throw new Error('This shot needs the song. Add the song in the Song step.')
  const graph = JSON.parse(JSON.stringify(workflow))
  const node = Object.values(graph).find((entry) => entry?.class_type === 'MinimaxHailuo03MaxLipSyncNode')
  if (!node) throw new Error('The cloud lip sync workflow is missing its video node.')
  const loader = (key) => (Array.isArray(node.inputs[key]) ? graph[String(node.inputs[key][0])] : null)
  const picture = loader('model.image')
  const song = loader('model.audio')
  if (!picture?.inputs || !song?.inputs) throw new Error('The cloud lip sync workflow is missing its picture or song input.')
  node.inputs.model = 'MiniMax H3 Max'
  node.inputs['model.resolution'] = MINIMAX_H3_LIP_SYNC.resolution
  node.inputs['model.transcription'] = false
  node.inputs['model.seed'] = Math.abs(Math.floor(Number(seed) || 0)) % 2147483648
  picture.inputs.image = inputImage
  song.inputs.audio = inputAudio
  for (const entry of Object.values(graph)) {
    if (entry?.class_type === 'SaveVideo' && filenamePrefix) entry.inputs.filename_prefix = filenamePrefix
  }
  return graph
}
