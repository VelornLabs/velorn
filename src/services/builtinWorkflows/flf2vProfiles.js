// FLF2V workflow profile registry + auto-detect for user-imported JSON.
//
// A "profile" describes how to inject per-job values (start/end frames,
// dimensions, prompts, fps, seed, filename) into a ComfyUI API-format
// workflow JSON. Two kinds:
//   - Bundled: shipped with the app, hand-tuned (e.g. WAN 2.2 14B).
//   - Imported: parsed from a user JSON file. Schema is auto-detected
//     from class_type / input names. Best-effort — if detection is
//     ambiguous the profile is still returned but the import UI flags
//     a warning.
//
// Each profile exposes the same surface so Flf2vDraftCard doesn't care:
//   { id, label, kind, workflowJson, mutation, detectWarnings }
//
// mutation is a small object of `(workflow, ctx) => void` setters. Only
// the ones the workflow actually needs must be present.

import {
  WAN22_FLF2V_WORKFLOW_JSON,
  WAN22_FLF2V_NODES as WN,
} from './wan22Flf2v'

// --- Bundled profiles -------------------------------------------------------

const wan22Mutate = {
  setStartImage: (wf, name) => { wf[WN.LOAD_START].inputs.image = name },
  setEndImage:   (wf, name) => { wf[WN.LOAD_END].inputs.image = name },
  setWidth:      (wf, w)    => { wf[WN.WAN_FLF2V].inputs.width = w },
  setHeight:     (wf, h)    => { wf[WN.WAN_FLF2V].inputs.height = h },
  setLength:     (wf, len)  => { wf[WN.WAN_FLF2V].inputs.length = len },
  setPositivePrompt: (wf, t) => { wf[WN.CLIP_POS].inputs.text = t },
  setNegativePrompt: (wf, t) => { wf[WN.CLIP_NEG].inputs.text = t },
  setFps:        (wf, fps)  => { wf[WN.CREATE_VIDEO].inputs.fps = fps },
  setSeeds:      (wf, seed) => {
    wf[WN.KSAMPLER_1].inputs.noise_seed = seed
    wf[WN.KSAMPLER_2].inputs.noise_seed = seed
  },
  setFilenamePrefix: (wf, p) => { wf[WN.SAVE_VIDEO].inputs.filename_prefix = p },
}

const WAN22_FLF2V_PROFILE = Object.freeze({
  id: 'wan22-flf2v',
  label: 'WAN 2.2 14B (local)',
  description: 'Default bundled workflow. Wan 2.2 14B high/low noise with 4-step lightx2v LoRA. 24GB+ VRAM recommended.',
  kind: 'local',
  workflowJson: WAN22_FLF2V_WORKFLOW_JSON,
  mutation: wan22Mutate,
  detectWarnings: [],
})

export const BUNDLED_FLF2V_PROFILES = Object.freeze([WAN22_FLF2V_PROFILE])

// --- Auto-detect for imported workflows -------------------------------------

// Walk a workflow graph and bucket nodes by class_type + a heuristic title
// or input-field scan. Returns enough info to wire setters without knowing
// the specific node IDs ahead of time.
function indexNodes(workflowJson) {
  const buckets = {
    loadImage: [],          // LoadImage nodes
    clipText: [],           // CLIPTextEncode nodes
    wanFLF2V: [],           // WanFirstLastFrameToVideo or WanFunInpaintToVideo
    byteDanceFLF2V: [],     // ByteDance2FirstLastFrameNode (Seedance)
    createVideo: [],        // CreateVideo
    ksampler: [],           // KSampler / KSamplerAdvanced
    saveVideo: [],          // SaveVideo
  }
  for (const [id, node] of Object.entries(workflowJson || {})) {
    if (!node || typeof node !== 'object') continue
    const ct = node.class_type
    if (!ct) continue
    const title = String(node?._meta?.title || '').toLowerCase()
    if (ct === 'LoadImage') buckets.loadImage.push({ id, node, title })
    else if (ct === 'CLIPTextEncode') buckets.clipText.push({ id, node, title })
    else if (ct === 'WanFirstLastFrameToVideo' || ct === 'WanFunInpaintToVideo') buckets.wanFLF2V.push({ id, node, title })
    else if (/FirstLastFrame/i.test(ct)) buckets.byteDanceFLF2V.push({ id, node, title })
    else if (ct === 'CreateVideo') buckets.createVideo.push({ id, node, title })
    else if (ct === 'KSampler' || ct === 'KSamplerAdvanced') buckets.ksampler.push({ id, node, title })
    else if (ct === 'SaveVideo') buckets.saveVideo.push({ id, node, title })
  }
  return buckets
}

// Pick a CLIPTextEncode node id for positive/negative based on title.
function pickClipText(clips, want) {
  if (!clips.length) return null
  const exact = clips.find((c) => c.title.includes(want))
  if (exact) return exact.id
  // Fallback: first / last
  return want === 'positive' ? clips[0]?.id : clips[clips.length - 1]?.id
}

// Try to detect a WanFLF2V-style schema. Returns mutation + warnings.
function detectWanFlf2v(workflowJson) {
  const warnings = []
  const b = indexNodes(workflowJson)
  if (b.loadImage.length < 2) warnings.push(`Expected 2 LoadImage nodes, found ${b.loadImage.length}.`)
  if (!b.wanFLF2V.length) warnings.push('No WanFirstLastFrameToVideo node found.')
  if (!b.createVideo.length) warnings.push('No CreateVideo node found.')
  if (!b.saveVideo.length) warnings.push('No SaveVideo node found.')

  // Detect which LoadImage is start vs end by inspecting WanFLF2V wiring
  let startId = b.loadImage[0]?.id || null
  let endId = b.loadImage[1]?.id || null
  if (b.wanFLF2V.length) {
    const wan = b.wanFLF2V[0].node
    const si = wan.inputs?.start_image
    const ei = wan.inputs?.end_image
    if (Array.isArray(si)) startId = String(si[0])
    if (Array.isArray(ei)) endId = String(ei[0])
  }

  const wanId = b.wanFLF2V[0]?.id || null
  const fpsId = b.createVideo[0]?.id || null
  const saveId = b.saveVideo[0]?.id || null
  const seedIds = b.ksampler.map((k) => k.id)
  const posId = pickClipText(b.clipText, 'positive')
  const negId = pickClipText(b.clipText, 'negative')

  return {
    mutation: {
      setStartImage: startId ? (wf, name) => { wf[startId].inputs.image = name } : null,
      setEndImage:   endId   ? (wf, name) => { wf[endId].inputs.image = name } : null,
      setWidth:      wanId   ? (wf, w)    => { wf[wanId].inputs.width = w } : null,
      setHeight:     wanId   ? (wf, h)    => { wf[wanId].inputs.height = h } : null,
      setLength:     wanId   ? (wf, len)  => { wf[wanId].inputs.length = len } : null,
      setPositivePrompt: posId ? (wf, t) => { wf[posId].inputs.text = t } : null,
      setNegativePrompt: negId ? (wf, t) => { wf[negId].inputs.text = t } : null,
      setFps:        fpsId   ? (wf, fps)  => { wf[fpsId].inputs.fps = fps } : null,
      setSeeds:      seedIds.length ? (wf, seed) => {
        for (const sid of seedIds) wf[sid].inputs.noise_seed = seed
      } : null,
      setFilenamePrefix: saveId ? (wf, p) => { wf[saveId].inputs.filename_prefix = p } : null,
    },
    warnings,
    meta: { startId, endId, wanId, fpsId, saveId, seedIds, posId, negId },
  }
}

// Detect cloud-style single-node FLF2V (Seedance, etc.). For now we just
// hand back what we know and let the caller decide. Many cloud fields don't
// match the WAN-style mutation surface so this is a partial fit.
function detectCloudFlf2v(workflowJson) {
  const warnings = ['Cloud workflow detected — only frame injection is wired automatically. Edit the workflow JSON directly for prompt/dimension changes.']
  const b = indexNodes(workflowJson)
  let startId = b.loadImage[0]?.id || null
  let endId = b.loadImage[1]?.id || null
  if (b.byteDanceFLF2V.length) {
    const cloud = b.byteDanceFLF2V[0].node
    const ff = cloud.inputs?.first_frame
    const lf = cloud.inputs?.last_frame
    if (Array.isArray(ff)) startId = String(ff[0])
    if (Array.isArray(lf)) endId = String(lf[0])
  }
  return {
    mutation: {
      setStartImage: startId ? (wf, name) => { wf[startId].inputs.image = name } : null,
      setEndImage:   endId   ? (wf, name) => { wf[endId].inputs.image = name } : null,
      setWidth:      null, setHeight: null, setLength: null,
      setPositivePrompt: null, setNegativePrompt: null,
      setFps: null, setSeeds: null,
      setFilenamePrefix: b.saveVideo[0]
        ? (wf, p) => { wf[b.saveVideo[0].id].inputs.filename_prefix = p }
        : null,
    },
    warnings,
    meta: { startId, endId, cloudId: b.byteDanceFLF2V[0]?.id || null },
  }
}

export function detectProfileFromJson(workflowJson, sourceName = 'imported') {
  if (!workflowJson || typeof workflowJson !== 'object') {
    throw new Error('Workflow JSON must be an object')
  }
  const looksCloud = indexNodes(workflowJson).byteDanceFLF2V.length > 0
  const detected = looksCloud ? detectCloudFlf2v(workflowJson) : detectWanFlf2v(workflowJson)
  const id = `imported:${sourceName}:${Date.now()}`
  return {
    id,
    label: sourceName,
    description: looksCloud
      ? 'Imported cloud FLF2V workflow (e.g. Seedance).'
      : 'Imported local FLF2V workflow (auto-detected schema).',
    kind: looksCloud ? 'cloud' : 'local',
    workflowJson,
    mutation: detected.mutation,
    detectWarnings: detected.warnings,
  }
}

// --- Persistence ------------------------------------------------------------

const LS_KEY = 'comfystudio.flf2v.selectedWorkflow'

export function loadSelectedProfileId() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

export function saveSelectedProfileId(record) {
  try {
    if (record) localStorage.setItem(LS_KEY, JSON.stringify(record))
    else localStorage.removeItem(LS_KEY)
  } catch (_) { /* ignore quota errors */ }
}

// --- Per-profile prompt overrides -----------------------------------------
// Lets the user save their modified prompt + negative prompt as the new
// defaults for a given workflow profile (bundled or imported). Keyed by
// profile id; survives restarts. Clear with clearProfilePromptOverrides().

const LS_PROMPT_OVERRIDES_KEY = 'comfystudio.flf2v.promptOverrides'

function readOverridesMap() {
  try {
    const raw = localStorage.getItem(LS_PROMPT_OVERRIDES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

export function loadProfilePromptOverrides(profileId) {
  if (!profileId) return null
  const map = readOverridesMap()
  return map[profileId] || null
}

export function saveProfilePromptOverrides(profileId, { prompt, negativePrompt } = {}) {
  if (!profileId) return
  const map = readOverridesMap()
  if (prompt == null && negativePrompt == null) {
    delete map[profileId]
  } else {
    map[profileId] = {
      prompt: typeof prompt === 'string' ? prompt : '',
      negativePrompt: typeof negativePrompt === 'string' ? negativePrompt : '',
    }
  }
  try {
    localStorage.setItem(LS_PROMPT_OVERRIDES_KEY, JSON.stringify(map))
  } catch (_) { /* ignore quota errors */ }
}

export function clearProfilePromptOverrides(profileId) {
  if (!profileId) return
  const map = readOverridesMap()
  if (!(profileId in map)) return
  delete map[profileId]
  try {
    localStorage.setItem(LS_PROMPT_OVERRIDES_KEY, JSON.stringify(map))
  } catch (_) { /* ignore quota errors */ }
}

// Find a profile by id. For 'imported:*' ids, callers must look the
// imported profile up themselves — this only resolves bundled ids.
export function getBundledProfile(id) {
  return BUNDLED_FLF2V_PROFILES.find((p) => p.id === id) || null
}
