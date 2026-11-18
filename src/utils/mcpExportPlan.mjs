import { DELIVERY_PRESETS, resolveDeliveryPresetSettings, resolveDeliveryResolution } from './exportDeliveryPresets.mjs'
import { validateCustomExportPresetSettings } from './exportPresetLibrary.mjs'
import { LEGACY_EXPORT_PRESETS } from './exportLegacyPresets.mjs'
import { resolveRtx4kDimensions } from '../config/rtxVideoUpscaleConfig.js'

const STANDARD_SIZES = { 'HD 1080p': [1920, 1080], 'HD 720p': [1280, 720], '4K UHD': [3840, 2160],
  'Vertical 1080': [1080, 1920], Square: [1080, 1080], 'Instagram 4:5': [1080, 1350], 'Cinematic 21:9': [2560, 1080] }
const LEGACY_SIZES = { h264_hd: [1920, 1080], h264_1080p: [1920, 1080], h264_720p: [1280, 720],
  h264_square_1080: [1080, 1080], h264_1x1_1080: [1080, 1080], h264_square_720: [720, 720], h264_1x1_720: [720, 720],
  h264_vertical_1080: [1080, 1920], h264_9x16_1080: [1080, 1920], h264_vertical_720: [720, 1280], h264_9x16_720: [720, 1280] }
export const MCP_EXPORT_SETTING_KEYS = Object.keys(validateCustomExportPresetSettings({ format: 'mp4' }).settings)
const positive = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a finite positive number`)
  return value
}
export const sanitizeExportFilename = value => String(value || 'Velorn_export').trim()
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/^\.+|\.+$/g, '').slice(0, 120) || 'Velorn_export'

/** Pure resolved settings. The same preset validation and delivery algorithms
 * as the Export workspace are authoritative; no model or node configuration. */
export function resolveMcpExportPlan(payload = {}, timeline = {}, customPresets = []) {
  payload = { ...payload,
    rangeStart: payload.rangeStart ?? payload.startSeconds,
    rangeEnd: payload.rangeEnd ?? payload.endSeconds }
  const source = { width: timeline.width || 1920, height: timeline.height || 1080, fps: timeline.fps || 24 }
  positive(source.width, 'Timeline width'); positive(source.height, 'Timeline height'); positive(source.fps, 'Timeline FPS')
  let settings = { format: 'mp4' }
  if (payload.presetId) {
    const preset = [...DELIVERY_PRESETS, ...LEGACY_EXPORT_PRESETS, ...customPresets].find(entry => entry.id === payload.presetId)
    if (!preset) throw new Error(`Export preset not found: ${payload.presetId}`)
    settings = resolveDeliveryPresetSettings(preset, source)
  } else {
    const target = payload.target || 'h264_hd'
    if (LEGACY_SIZES[target]) {
      const [customWidth, customHeight] = LEGACY_SIZES[target]
      settings = { ...settings, resolution: 'custom', customWidth, customHeight }
    } else if (target === 'h264_project') settings.resolution = 'project'
    else if (target === 'h264_review_proxy') settings = { ...settings, resolution: 'timeline-half', crf: 24, preset: 'veryfast', useProxyMedia: true }
    else throw new Error(`Unsupported export target: ${target}. Use list_export_presets or a legacy H.264 target.`)
  }
  if (payload.overrides != null && (typeof payload.overrides !== 'object' || Array.isArray(payload.overrides))) throw new Error('Export overrides must be an object')
  for (const key of Object.keys(payload.overrides || {})) if (!MCP_EXPORT_SETTING_KEYS.includes(key)) throw new Error(`Unsupported export override: ${key}`)
  const direct = Object.fromEntries(MCP_EXPORT_SETTING_KEYS.filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]))
  // Selecting a format chooses its compatible codecs, unless explicitly set.
  const overrides = { ...direct, ...(payload.overrides || {}) }
  if (Object.hasOwn(overrides, 'format') && overrides.format !== settings.format) {
    const defaults = { mp4: ['h264', 'aac'], webm: ['vp9', 'opus'], prores: ['prores', 'aac'], audio: ['h264', 'wav'], gif: ['h264', 'aac'], 'png-seq': ['h264', 'aac'] }
    const codecs = defaults[overrides.format]
    if (codecs) settings = { ...settings, videoCodec: codecs[0], audioCodec: codecs[1], transparent: false, useHardwareEncoder: false, postProcessUpscale: 'none' }
  }
  settings = { ...settings, ...overrides }
  const legacyResolution = {
    '1080p': [1920, 1080], '720p': [1280, 720], square_1080: [1080, 1080], square_720: [720, 720], square: [1080, 1080],
    '1x1': [1080, 1080], vertical_1080: [1080, 1920], vertical_720: [720, 1280], '9x16': [1080, 1920],
  }[settings.resolution]
  if (legacyResolution) [settings.resolution, settings.customWidth, settings.customHeight] = ['custom', ...legacyResolution]
  if (settings.resolution === 'timeline_half') settings.resolution = 'timeline-half'
  if (payload.aspectRatio && payload.width == null && payload.height == null) {
    const ratio = String(payload.aspectRatio)
    if (!['16:9', '1:1', '1x1', 'square', '9:16', '9x16', 'vertical'].includes(ratio)) throw new Error('Unsupported export aspect ratio')
    const small = settings.customHeight === 720 || settings.customWidth === 720
    const dimensions = ['1:1', '1x1', 'square'].includes(ratio) ? (small ? [720, 720] : [1080, 1080])
      : ['9:16', '9x16', 'vertical'].includes(ratio) ? (small ? [720, 1280] : [1080, 1920]) : (small ? [1280, 720] : [1920, 1080])
    ;[settings.resolution, settings.customWidth, settings.customHeight] = ['custom', ...dimensions]
  }
  if (payload.width != null || payload.height != null) {
    settings.resolution = 'custom'
    settings.customWidth = payload.width ?? source.width
    settings.customHeight = payload.height ?? source.height
  }
  const explicitFps = settings.fps !== undefined && settings.fps !== 'project' ? Number(settings.fps) : null
  if (explicitFps !== null && (!Number.isFinite(explicitFps) || explicitFps < 1 || explicitFps > 240)) throw new Error('Export FPS must be between 1 and 240')
  const checked = validateCustomExportPresetSettings({ ...settings, fps: 'project' })
  if (!checked.ok) throw new Error(checked.error)
  // Do not silently accept incompatible requested features that the UI would
  // disable. Defaults can normalize, but explicit requests must be truthful.
  for (const key of ['transparent', 'useHardwareEncoder', 'postProcessUpscale']) {
    if (Object.hasOwn(overrides, key) && overrides[key] !== checked.settings[key]) throw new Error(`${key} is not supported with the selected export format`)
  }
  settings = checked.settings
  if (explicitFps !== null) settings.fps = explicitFps
  const visualOnly = ['gif', 'png-seq'].includes(settings.format)
  if (visualOnly && (overrides.useHardwareEncoder === true || overrides.postProcessUpscale === 'rtx-4k')) throw new Error('GIF and PNG sequence exports do not support hardware video encoding or RTX post-processing')
  const normalizeDimension = value => visualOnly ? Math.max(1, Math.round(value)) : Math.max(2, Math.round(value / 2) * 2)
  let size = resolveDeliveryResolution(settings.resolution, source)
  if (!size) {
    let dimensions = settings.resolution === 'custom' ? [settings.customWidth, settings.customHeight] : STANDARD_SIZES[settings.resolution]
    const scale = { 'timeline-half': 0.5, 'timeline-third': 1 / 3, 'timeline-quarter': 0.25 }[settings.resolution]
    if (!dimensions) dimensions = [source.width * (scale || 1), source.height * (scale || 1)]
    size = { width: normalizeDimension(dimensions[0]), height: normalizeDimension(dimensions[1]) }
  }
  const fps = settings.fps === 'project' ? source.fps : settings.fps
  const duration = positive(timeline.duration, 'Timeline duration')
  const range = payload.range ?? (payload.rangeStart != null || payload.rangeEnd != null ? 'custom' : 'full')
  if (!['full', 'inout', 'custom'].includes(range)) throw new Error('Export range must be full, inout, or custom')
  if (range !== 'custom' && (payload.rangeStart != null || payload.rangeEnd != null)) throw new Error('Explicit range boundaries require range: custom')
  let rangeStart = 0, rangeEnd = duration
  if (range === 'inout') {
    if (timeline.inPoint == null || timeline.outPoint == null) throw new Error('Set both timeline In and Out points before an In/Out export')
    rangeStart = Math.min(timeline.inPoint, timeline.outPoint); rangeEnd = Math.max(timeline.inPoint, timeline.outPoint)
  } else if (range === 'custom') {
    rangeStart = payload.rangeStart ?? 0; rangeEnd = payload.rangeEnd ?? duration
  }
  if (![rangeStart, rangeEnd].every(value => typeof value === 'number' && Number.isFinite(value)) || rangeStart < 0 || rangeEnd <= rangeStart) throw new Error('Export range must have finite, increasing, non-negative boundaries')
  if (rangeEnd - rangeStart < 1 / fps - 1e-8) throw new Error('Export range must contain at least one output frame')
  const framing = payload.deliveryFraming ?? payload.framing ?? (size.width <= size.height ? 'fill' : 'fit')
  if (!['fit', 'fill', 'cover', 'center_crop', 'center-crop'].includes(framing)) throw new Error('Export framing must be fit or fill')
  const extension = settings.format === 'audio' ? ({ aac: 'm4a', mp3: 'mp3', wav: 'wav' }[settings.audioCodec])
    : ({ mp4: 'mp4', webm: 'webm', prores: 'mov', gif: 'gif', 'png-seq': '' }[settings.format])
  const filename = sanitizeExportFilename(payload.filename || timeline.name || 'Velorn_export')
  const options = { ...settings, filename, videoCodec: visualOnly ? null : settings.videoCodec,
    audioCodec: visualOnly ? null : settings.audioCodec, width: size.width, height: size.height, fps,
    sourceTimelineWidth: source.width, sourceTimelineHeight: source.height, rangeStart, rangeEnd,
    includeAudio: visualOnly ? false : settings.includeAudio, normalizeAudio: !visualOnly && settings.includeAudio && settings.normalizeAudio,
    useHardwareEncoder: !visualOnly && !settings.transparent && settings.useHardwareEncoder,
    useDirectFramePipe: !visualOnly && settings.useDirectFramePipe,
    postProcessUpscale: visualOnly || settings.transparent ? 'none' : settings.postProcessUpscale,
    keyframeInterval: settings.keyframeMode === 'auto' ? null : settings.keyframeInterval,
    deliveryFraming: framing === 'fit' ? 'fit' : 'fill', useCachedRenders: false, fastSeek: false }
  const deliveredSize = options.postProcessUpscale === 'rtx-4k' ? resolveRtx4kDimensions(size.width, size.height) : size
  return { presetId: payload.presetId || null, range, filename, extension, settings, options,
    finalDelivery: { width: settings.format === 'audio' ? null : deliveredSize.width,
      height: settings.format === 'audio' ? null : deliveredSize.height, fps: settings.format === 'audio' ? null : fps,
      durationSeconds: rangeEnd - rangeStart, includeAudio: options.includeAudio,
      postProcess: options.postProcessUpscale, note: 'options.width/height describe the source render; finalDelivery describes the delivered output.' },
    outputPath: payload.outputPath || null, estimatedFrames: Math.ceil((rangeEnd - rangeStart) * fps) }
}
