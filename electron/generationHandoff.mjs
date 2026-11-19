// Shared by native MCP planning and the renderer. Staging is a durable request,
// not a best-effort UI event; queue approval belongs to one exact staged state.
const LTX_WORKFLOWS = new Set(['ltx23-i2v', 'ltx23-ia2v', 'ltx23-id-lora', 'ltx23-t2v'])
export const supportsExplicitGenerationDuration = workflowId => LTX_WORKFLOWS.has(workflowId)

const present = value => value !== undefined && value !== null && value !== ''
const positive = (value, label) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive finite number.`)
  return number
}

export function buildStagedGenerationSettings(args = {}, assets = []) {
  const workflowId = String(args.workflowId || 'ltx23-i2v')
  const settings = {}
  const requestedDuration = args.durationSeconds ?? args.duration
  if (present(requestedDuration)) {
    settings.durationSeconds = positive(requestedDuration, 'Generation duration')
    if (LTX_WORKFLOWS.has(workflowId) && settings.durationSeconds < 1) throw new Error('LTX duration must be at least 1 second.')
    if (['ltx23-i2v', 'ltx23-t2v'].includes(workflowId) && !Number.isInteger(settings.durationSeconds)) {
      throw new Error('This LTX workflow uses whole-second durations. Choose an explicit whole number of seconds.')
    }
  }
  if (present(args.fps)) {
    settings.fps = positive(args.fps, 'Generation FPS')
    if (!Number.isInteger(settings.fps)) throw new Error('Generation FPS must be a whole number.')
  }
  if (args.resolution) {
    const width = positive(args.resolution.width, 'Output width')
    const height = positive(args.resolution.height, 'Output height')
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Output dimensions must be whole pixels.')
    if (LTX_WORKFLOWS.has(workflowId) && (width < 256 || height < 256)) throw new Error('LTX output dimensions must be at least 256 pixels.')
    settings.resolution = { width, height }
  }
  if (present(args.audioStartSeconds) && !args.audioAssetId) throw new Error('Provide audioAssetId with audioStartSeconds; timeline time does not select conditioning audio.')
  if (args.audioAssetId) {
    if (workflowId !== 'ltx23-ia2v') throw new Error('Explicit conditioning-audio ranges are supported by ltx23-ia2v only. Other workflows must use their own reviewed audio route.')
    const asset = assets.find(item => item?.id === args.audioAssetId)
    if (!asset || asset.type !== 'audio') throw new Error('audioAssetId must identify an existing project audio asset.')
    const sourceDurationSeconds = positive(asset.duration ?? asset.settings?.duration, 'Conditioning-audio source duration')
    const startSeconds = Number(args.audioStartSeconds ?? 0)
    if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error('audioStartSeconds must be a finite non-negative source time.')
    if (!settings.durationSeconds) throw new Error('Provide durationSeconds when staging a conditioning-audio range.')
    if (startSeconds + settings.durationSeconds > sourceDurationSeconds + 1e-6) throw new Error('The requested conditioning-audio range exceeds the known audio asset duration.')
    settings.audio = { assetId: asset.id, assetName: asset.name || '', startSeconds,
      durationSeconds: settings.durationSeconds, sourceDurationSeconds,
      source: 'explicit_audio_asset_range', timelineAudioMatched: false }
  } else if (workflowId === 'ltx23-ia2v') {
    // Never inherit a previous song merely because a timeline picture was staged.
    settings.audio = null
  }
  return settings
}

export function getStagedGenerationMismatches(frame, actual = {}) {
  if (frame?.source !== 'mcp' || !frame?.generationSettings) return []
  const requested = frame.generationSettings
  const mismatches = []
  if (frame.workflowId !== actual.workflowId) mismatches.push('workflow')
  if (frame.category !== actual.category) mismatches.push('category')
  if (typeof frame.prompt === 'string' && frame.prompt !== actual.prompt) mismatches.push('prompt')
  if (typeof frame.negativePrompt === 'string' && frame.negativePrompt !== actual.negativePrompt) mismatches.push('negative prompt')
  if (present(requested.durationSeconds) && requested.durationSeconds !== actual.duration) mismatches.push('duration')
  if (present(requested.fps) && requested.fps !== actual.fps) mismatches.push('FPS')
  if (requested.resolution && (requested.resolution.width !== actual.resolution?.width || requested.resolution.height !== actual.resolution?.height)) mismatches.push('resolution')
  if (requested.audio && (requested.audio.assetId !== actual.conditioningAudio?.assetId
    || requested.audio.startSeconds !== actual.conditioningAudio?.startSeconds
    || requested.audio.durationSeconds !== actual.conditioningAudio?.durationSeconds)) mismatches.push('conditioning audio')
  return mismatches
}

export function describeConditioningAudio({ workflowId, asset, duration, frame } = {}) {
  if (!asset) return null
  const sourceDuration = Number(asset.duration ?? asset.settings?.duration)
  const sourceDurationSeconds = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : null
  if (workflowId !== 'ltx23-ia2v') return {
    assetId: asset.id, assetName: asset.name || '', startSeconds: null, durationSeconds: null,
    sourceDurationSeconds, source: 'selected_audio_asset_workflow_defined_range', timelineAudioMatched: false,
  }
  const staged = frame?.workflowId === workflowId ? frame?.generationSettings?.audio : null
  const explicitRange = workflowId === 'ltx23-ia2v' && staged?.assetId === asset.id
  const startSeconds = explicitRange ? staged.startSeconds : 0
  const durationSeconds = Number(duration)
  return { assetId: asset.id, assetName: asset.name || '', startSeconds, durationSeconds,
    sourceDurationSeconds,
    rangeWithinKnownSource: Number.isFinite(sourceDuration) && sourceDuration > 0
      && startSeconds + durationSeconds <= sourceDuration + 1e-6,
    source: explicitRange ? 'explicit_audio_asset_range' : 'selected_audio_asset_from_start',
    timelineAudioMatched: false }
}

const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const frameIdentities = new WeakMap()
let nextFrameIdentity = 0
export function getPreparedFrameIdentity(frame) {
  if (!frame || typeof frame !== 'object') return null
  if (!frameIdentities.has(frame)) frameIdentities.set(frame, `prepared-frame-${++nextFrameIdentity}`)
  return frameIdentities.get(frame)
}

export function createPreparedGenerationReviews({ now = Date.now, token = () => globalThis.crypto.randomUUID(), maxAgeMs = 300000 } = {}) {
  const records = new Map()
  const identity = (snapshot, context) => stable({ snapshot, context })
  const check = (previewToken, snapshot, context) => {
    const record = records.get(previewToken)
    if (!record || now() - record.createdAt > maxAgeMs) throw new Error('Preview the prepared generation again; its queue approval is missing, expired or already used.')
    if (record.identity !== identity(snapshot, context)) throw new Error('Prepared generation settings, inputs or project changed after preview. Preview again; nothing was queued.')
    return record
  }
  return {
    preview(snapshot, context, previousToken) {
      if (previousToken) { check(previousToken, snapshot, context); return previousToken }
      for (const [key, record] of records) if (now() - record.createdAt > maxAgeMs) records.delete(key)
      while (records.size >= 32) records.delete(records.keys().next().value)
      const previewToken = token()
      records.set(previewToken, { createdAt: now(), identity: identity(snapshot, context) })
      return previewToken
    },
    consume(previewToken, snapshot, context) {
      check(previewToken, snapshot, context)
      records.delete(previewToken)
    },
  }
}
