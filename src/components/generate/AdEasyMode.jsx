import { useEffect, useMemo, useState } from 'react'
import { Film, Loader2 } from 'lucide-react'

const STEPS = [
  { id: 'brief', label: 'Brief' },
  { id: 'direction', label: 'Creative' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'references', label: 'References' },
  { id: 'script', label: 'Script Plan' },
  { id: 'keyframes', label: 'Keyframes' },
  { id: 'videos', label: 'Videos' },
  { id: 'done', label: 'Complete' },
]

const FORMAT_OPTIONS = [
  { id: 'beauty_spot', label: 'Beauty Spot' },
  { id: 'product_demo', label: 'Product Demo' },
  { id: 'fashion_lifestyle', label: 'Lifestyle' },
  { id: 'tech_demo', label: 'Technical Demo' },
]

const ASPECT_RATIO_OPTIONS = [
  { id: 'vertical_9x16', label: '9:16', helper: 'Portrait: 720x1280 or 1080x1920.' },
  { id: 'landscape_16x9', label: '16:9', helper: 'Landscape: 1280x720 or 1920x1080.' },
  { id: 'square_1x1', label: '1:1', helper: 'Square: 720x720 or 1080x1080.' },
]
const PLATFORM_OPTIONS = ASPECT_RATIO_OPTIONS

const TONE_OPTIONS = [
  { id: 'premium-calm', label: 'Premium Calm', text: 'premium calm' },
  { id: 'social-fast', label: 'Social Fast', text: 'fast social' },
  { id: 'emotional-cinematic', label: 'Emotional', text: 'emotional cinematic' },
  { id: 'technical-clean', label: 'Technical', text: 'technical clean' },
]

const VIDEO_MODEL_OPTIONS = [
  { id: 'ltx23-i2v', label: 'LTX 2.3', helper: 'Default. Good for people-heavy shots and longer takes.' },
  { id: 'wan22-i2v', label: 'WAN 2.2', helper: 'Good alternate for product motion and physical demo shots.' },
]

const SHOT_COUNT_OPTIONS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 24]
const COMMERCIAL_LENGTH_OPTIONS = [6, 15, 30, 60]
const RESOLUTION_OPTIONS = [
  { id: '720p', label: '720p' },
  { id: '1080p', label: '1080p' },
]
const FPS_OPTIONS = [24, 25, 30]
const KEYFRAME_BUSY_STATUSES = new Set(['queued', 'paused', 'uploading', 'configuring', 'queuing', 'running', 'saving'])
const VIDEO_BUSY_STATUSES = KEYFRAME_BUSY_STATUSES
const AD_EASY_MODE_DRAFT_STORAGE_KEY = 'comfystudio-ad-easy-mode-draft-v1'
const DEFAULT_AD_EASY_MODE_DRAFT = Object.freeze({
  brand: 'Gold Bond',
  product: 'Dry Skin Relief Lotion',
  colors: 'Natural neutral colors, warm bathroom light',
  audience: 'People with dry winter skin who want fast relief',
  promise: 'Soft, healthy-looking skin without a greasy finish.',
  talentDirection: '',
  format: 'beauty_spot',
  platform: 'vertical_9x16',
  tone: 'premium-calm',
  resolutionPreset: '720p',
  videoFps: 24,
  commercialLength: 30,
  shotCount: 8,
  videoWorkflowId: 'ltx23-i2v',
  productAssetId: '',
  talentAssetId: '',
  noVisibleTalent: false,
  directorScript: '',
})

function normalizeDraftOption(value, options, fallback) {
  const normalized = String(value || '').trim()
  return options.some((option) => option?.id === normalized) ? normalized : fallback
}

function normalizeDraftNumber(value, allowedValues, fallback) {
  const parsed = Number(value)
  return allowedValues.includes(parsed) ? parsed : fallback
}

function normalizeAdEasyModeDraft(rawDraft = {}) {
  const raw = rawDraft && typeof rawDraft === 'object' ? rawDraft : {}
  return {
    brand: String(raw.brand || DEFAULT_AD_EASY_MODE_DRAFT.brand),
    product: String(raw.product || DEFAULT_AD_EASY_MODE_DRAFT.product),
    colors: String(raw.colors || DEFAULT_AD_EASY_MODE_DRAFT.colors),
    audience: String(raw.audience || DEFAULT_AD_EASY_MODE_DRAFT.audience),
    promise: String(raw.promise || DEFAULT_AD_EASY_MODE_DRAFT.promise),
    talentDirection: String(raw.talentDirection || ''),
    format: normalizeDraftOption(raw.format, FORMAT_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.format),
    platform: normalizeDraftOption(raw.platform, PLATFORM_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.platform),
    tone: normalizeDraftOption(raw.tone, TONE_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.tone),
    resolutionPreset: normalizeDraftOption(raw.resolutionPreset, RESOLUTION_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.resolutionPreset),
    videoFps: normalizeDraftNumber(raw.videoFps, FPS_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.videoFps),
    commercialLength: normalizeDraftNumber(raw.commercialLength, COMMERCIAL_LENGTH_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.commercialLength),
    shotCount: normalizeDraftNumber(raw.shotCount, SHOT_COUNT_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.shotCount),
    videoWorkflowId: normalizeDraftOption(raw.videoWorkflowId, VIDEO_MODEL_OPTIONS, DEFAULT_AD_EASY_MODE_DRAFT.videoWorkflowId),
    productAssetId: String(raw.productAssetId || ''),
    talentAssetId: String(raw.talentAssetId || ''),
    noVisibleTalent: Boolean(raw.noVisibleTalent),
    directorScript: String(raw.directorScript || ''),
  }
}

function loadAdEasyModeDraft() {
  if (typeof localStorage === 'undefined') return DEFAULT_AD_EASY_MODE_DRAFT
  try {
    const raw = localStorage.getItem(AD_EASY_MODE_DRAFT_STORAGE_KEY)
    if (!raw) return DEFAULT_AD_EASY_MODE_DRAFT
    return normalizeAdEasyModeDraft(JSON.parse(raw))
  } catch (_) {
    return DEFAULT_AD_EASY_MODE_DRAFT
  }
}

function getSuggestedShotCount(length) {
  const seconds = Number(length) || 30
  if (seconds <= 6) return 3
  if (seconds <= 15) return 6
  if (seconds <= 30) return 10
  return 20
}

function getShotHint(length) {
  const seconds = Number(length) || 30
  if (seconds <= 6) return 'Suggested: 2-4 shots for a 6 second ad.'
  if (seconds <= 15) return 'Suggested: 4-8 shots for a 15 second ad.'
  if (seconds <= 30) return 'Suggested: 8-12 shots for a 30 second ad.'
  return 'Suggested: 16-24 shots for a 60 second ad.'
}

function formatShotTime(index, count, totalSeconds) {
  const start = Math.round((index * totalSeconds) / count)
  const end = Math.round(((index + 1) * totalSeconds) / count)
  return `${start}-${Math.max(end, start + 1)}s`
}

function getShotDuration(count, totalSeconds) {
  const duration = Math.max(2, Math.min(5, Number(totalSeconds || 30) / Math.max(1, Number(count) || 1)))
  return Number(duration.toFixed(1))
}

function resolveOutputResolution(platform, resolutionPreset) {
  const is1080 = resolutionPreset === '1080p'
  if (platform === 'landscape_16x9') {
    return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
  }
  if (platform === 'square_1x1') {
    return is1080 ? { width: 1080, height: 1080 } : { width: 720, height: 720 }
  }
  return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }
}

function formatResolutionLabel(resolution) {
  if (!resolution) return ''
  return `${resolution.width}x${resolution.height}`
}

function getAssetUrl(asset) {
  return asset?.url || asset?.thumbnailUrl || asset?.proxyUrl || asset?.path || ''
}

function getVideoVariantWorkflowKey(variantKey, workflowId) {
  const key = String(variantKey || '').trim()
  const workflow = String(workflowId || '').trim()
  return key && workflow ? `${key}::${workflow}` : ''
}

function compact(text, fallback) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value || fallback
}

function buildShotTemplates(data) {
  const brandProduct = compact(`${data.brand} ${data.product}`, 'the product')
  const audience = compact(data.audience, 'the target customer')
  const promise = compact(data.promise, 'the main product benefit')
  const colors = compact(data.colors, 'clean brand colors')
  const talentMode = data.noVisibleTalent ? 'none' : 'lifestyle model'
  const talentLine = data.noVisibleTalent
    ? 'Talent mode: none'
    : `Talent mode: ${talentMode}`

  return [
    {
      title: 'Hook: show the problem',
      adBeat: 'hook',
      productMode: 'context',
      shotType: 'Close-up',
      keyframe: `Single commercial keyframe of ${audience} experiencing the problem ${brandProduct} solves, ${colors}, no text.`,
      motion: `Start from the keyframe and show a clear problem moment with ${data.toneText} pacing.`,
      camera: 'Subtle push-in',
    },
    {
      title: 'Product reveal',
      adBeat: 'product reveal',
      productMode: 'hero',
      shotType: 'Hero product',
      keyframe: `Premium hero product shot of ${brandProduct}, readable shape and packaging, ${colors}, no text.`,
      motion: 'Slow reveal motion, keep the product centered and readable.',
      camera: 'Slow dolly in',
    },
    {
      title: 'Texture and benefit',
      adBeat: 'demo',
      productMode: 'macro detail',
      shotType: 'Macro close-up',
      keyframe: `Macro detail showing texture, material, formula, or finish for ${data.product}, premium lighting, no text.`,
      motion: `Gentle macro movement that visually supports: ${promise}.`,
      camera: 'Locked macro with micro push-in',
    },
    {
      title: 'Product in use',
      adBeat: 'demo',
      productMode: 'in-hand',
      shotType: 'Medium close-up',
      keyframe: `Natural use moment for ${brandProduct}, believable scale, ${talentLine.toLowerCase()}, ${colors}, no text.`,
      motion: 'Show the product being used clearly and naturally.',
      camera: 'Handheld but controlled',
    },
    {
      title: 'Lifestyle proof',
      adBeat: 'proof',
      productMode: 'lifestyle',
      shotType: 'Medium shot',
      keyframe: `Lifestyle proof moment for ${audience}, product visible, aspirational but believable, no text.`,
      motion: `Show the payoff feeling after using the product: ${promise}.`,
      camera: 'Smooth tracking shot',
    },
    {
      title: 'Benefit beat',
      adBeat: 'benefit',
      productMode: 'hero',
      shotType: 'Insert shot',
      keyframe: `Clean visual proof of the core benefit for ${brandProduct}, simple composition with space for editor-native overlay, no rendered text.`,
      motion: `Hold on the benefit visual long enough to read the story: ${promise}.`,
      camera: 'Locked insert with slight parallax',
    },
    {
      title: 'Talent reaction',
      adBeat: 'testimonial',
      productMode: 'lifestyle',
      shotType: 'Medium close-up',
      keyframe: data.noVisibleTalent
        ? `Hands-only product moment for ${brandProduct}, no visible face, clean background, no text.`
        : `Natural talent reaction after using ${brandProduct}, wardrobe and identity consistent with reference, no text.`,
      motion: data.noVisibleTalent
        ? 'Hands interact with the product naturally, no face visible.'
        : 'Talent gives a subtle satisfied reaction, no exaggerated acting.',
      camera: 'Gentle handheld close-up',
    },
    {
      title: 'Product detail proof',
      adBeat: 'proof',
      productMode: 'macro detail',
      shotType: 'Close-up',
      keyframe: `Detailed premium product proof shot for ${brandProduct}, label or form clear, no text.`,
      motion: 'Slow motion across the product detail, keep packaging consistent.',
      camera: 'Lateral slider move',
    },
    {
      title: 'Usage context',
      adBeat: 'demo',
      productMode: 'context',
      shotType: 'Medium wide',
      keyframe: `Believable setting where ${audience} would use ${brandProduct}, product present and easy to understand, no text.`,
      motion: 'Show the product naturally in its use environment.',
      camera: 'Slow pan',
    },
    {
      title: 'CTA setup',
      adBeat: 'CTA',
      productMode: 'packshot',
      shotType: 'Locked packshot',
      keyframe: `Clean packshot setup for ${brandProduct}, generous negative space for editor-native CTA text, no rendered text.`,
      motion: 'Hold steady so the final CTA can be added in the editor.',
      camera: 'Locked packshot',
      endCard: `${data.brand || 'Brand'}, ${data.product || 'Product'}, Learn more`,
    },
    {
      title: 'Alternate product angle',
      adBeat: 'proof',
      productMode: 'packaging',
      shotType: 'Three-quarter product',
      keyframe: `Three-quarter angle of ${brandProduct}, product shape and packaging readable, clean background, no text.`,
      motion: 'Subtle orbit that keeps the product readable.',
      camera: 'Small orbit',
    },
    {
      title: 'Before/after suggestion',
      adBeat: 'proof',
      productMode: 'result',
      shotType: 'Split-free proof shot',
      keyframe: `Tasteful single-frame result suggestion for ${promise}, no split screen, no before-after collage, no text.`,
      motion: 'Move from problem detail into result feeling without a split screen.',
      camera: 'Slow push-in',
    },
    {
      title: 'Material detail',
      adBeat: 'proof',
      productMode: 'macro detail',
      shotType: 'Extreme close-up',
      keyframe: `Extreme close-up of product material, formula, texture, finish, or packaging detail for ${brandProduct}, no text.`,
      motion: 'Premium macro movement across the material detail.',
      camera: 'Macro slider',
    },
    {
      title: 'Brand moment',
      adBeat: 'brand',
      productMode: 'hero',
      shotType: 'Wide product composition',
      keyframe: `Brand-forward composition for ${brandProduct}, ${colors}, premium commercial lighting, no text.`,
      motion: 'Slow cinematic camera move that reinforces brand feeling.',
      camera: 'Slow crane or dolly',
    },
    {
      title: 'Customer moment',
      adBeat: 'lifestyle',
      productMode: 'lifestyle',
      shotType: 'Medium shot',
      keyframe: `Relatable customer moment for ${audience}, product in scene, natural environment, no text.`,
      motion: 'Natural lifestyle movement, product remains visible.',
      camera: 'Steady handheld',
    },
    {
      title: 'Problem callback',
      adBeat: 'problem',
      productMode: 'context',
      shotType: 'Close-up',
      keyframe: `Clean callback to the original problem, now with ${brandProduct} as the clear solution, no text.`,
      motion: 'Show the transition from problem to product solution.',
      camera: 'Subtle rack focus',
    },
    {
      title: 'Trust cue',
      adBeat: 'proof',
      productMode: 'label',
      shotType: 'Insert shot',
      keyframe: `Subtle trust cue for ${brandProduct}: clean label, routine, texture, or careful use detail, no text.`,
      motion: 'Small motion that makes the trust cue easy to read visually.',
      camera: 'Locked insert',
    },
    {
      title: 'Secondary benefit',
      adBeat: 'benefit',
      productMode: 'hero',
      shotType: 'Close-up',
      keyframe: `Secondary benefit visual for ${brandProduct}, supports ${promise}, clean composition, no text.`,
      motion: 'Short visual beat supporting the main product promise.',
      camera: 'Gentle push-in',
    },
    {
      title: 'Use case',
      adBeat: 'demo',
      productMode: 'in-use',
      shotType: 'Medium close-up',
      keyframe: `Clear use case shot for ${brandProduct}, understandable action, believable scale, no text.`,
      motion: 'Show one simple action from start to finish.',
      camera: 'Controlled handheld',
    },
    {
      title: 'End card hold',
      adBeat: 'end card',
      productMode: 'packshot',
      shotType: 'Locked packshot',
      keyframe: `Final clean packshot for ${brandProduct}, product centered, safe empty space for editor-native text, no rendered text.`,
      motion: 'Hold steady for final brand impression.',
      camera: 'Locked packshot',
      endCard: `${data.brand || 'Brand'}, ${data.product || 'Product'}, Shop now`,
    },
    {
      title: 'Packaging close-up',
      adBeat: 'proof',
      productMode: 'packaging',
      shotType: 'Close-up',
      keyframe: `Close-up product packaging shot for ${brandProduct}, readable form and label area, no text.`,
      motion: 'Slow glide across packaging, no fake typography.',
      camera: 'Slider close-up',
    },
    {
      title: 'Emotional payoff',
      adBeat: 'payoff',
      productMode: 'lifestyle',
      shotType: 'Wide shot',
      keyframe: `Emotional payoff moment for ${audience}, product story feels complete, premium commercial style, no text.`,
      motion: 'Slow cinematic payoff movement.',
      camera: 'Wide slow push',
    },
    {
      title: 'Final reminder',
      adBeat: 'CTA',
      productMode: 'hero',
      shotType: 'Hero product',
      keyframe: `Final reminder shot of ${brandProduct}, simple brand-safe composition, no rendered text.`,
      motion: 'Short restrained product hero motion.',
      camera: 'Subtle dolly',
    },
    {
      title: 'Logo-safe finish',
      adBeat: 'end card',
      productMode: 'packshot',
      shotType: 'Locked packshot',
      keyframe: `Logo-safe final frame for ${brandProduct}, clean negative space for native end card typography, no text in image.`,
      motion: 'Hold steady with very subtle light movement.',
      camera: 'Locked end card',
      endCard: `${data.brand || 'Brand'}, ${data.product || 'Product'}, Try it today`,
    },
  ]
}

function buildDirectorScript(data) {
  const shotCount = Math.max(3, Math.min(Number(data.shotCount) || 8, 24))
  const shotDuration = getShotDuration(shotCount, data.commercialLength)
  const shots = buildShotTemplates(data).slice(0, shotCount)
  return [
    `Scene 1: ${compact(data.brand, 'Brand')} ${compact(data.product, 'Product')} Commercial`,
    `Scene context: ${compact(data.formatLabel, 'Product ad')} for ${compact(data.audience, 'the target audience')}. Visual rules: ${compact(data.colors, 'clean brand colors')}. Tone: ${compact(data.toneText, 'premium calm')}.`,
    '',
    ...shots.map((shot, index) => [
      `Shot ${index + 1}: ${shot.title}`,
      `Ad beat: ${shot.adBeat}`,
      `Product mode: ${shot.productMode}`,
      `Talent mode: ${data.noVisibleTalent ? 'none' : shot.talentMode || 'lifestyle model'}`,
      `Shot type: ${shot.shotType}`,
      `Keyframe prompt: ${shot.keyframe}`,
      `Motion prompt: ${shot.motion}`,
      `Camera: ${shot.camera}`,
      index === 0 ? `Text overlay: ${compact(data.promise, 'Main benefit')}` : '',
      shot.endCard ? `End card: ${shot.endCard}` : '',
      `Duration: ${shotDuration}`,
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

function buildExternalLlmPrompt(data, currentScript) {
  return [
    'Write a ComfyStudio Director Mode product ad script using this exact structure.',
    '',
    'Return only the script. Do not include explanation, markdown, or notes.',
    '',
    `Brand: ${compact(data.brand, 'Brand')}`,
    `Product: ${compact(data.product, 'Product')}`,
    `Audience: ${compact(data.audience, 'target customer')}`,
    `Promise: ${compact(data.promise, 'main product benefit')}`,
    `Visual rules: ${compact(data.colors, 'clean brand colors')}`,
    `Format: ${compact(data.formatLabel, 'Product Ad')}`,
    `Aspect ratio: ${compact(data.aspectRatioLabel, data.platform || '9:16')}`,
    `Tone: ${compact(data.toneText, 'premium calm')}`,
    `Commercial length: ${Number(data.commercialLength) || 30} seconds`,
    `Shot count: ${Number(data.shotCount) || 8}`,
    `Output resolution: ${data.resolutionLabel}`,
    `Frames per second: ${Number(data.videoFps) || 24} fps`,
    `Talent: ${data.noVisibleTalent ? 'No visible talent' : compact(data.talentDirection, 'Use talent only where it helps the product story')}`,
    '',
    'Required structure for every shot:',
    'Shot N: Short title',
    'Ad beat: hook | product reveal | demo | proof | benefit | CTA | end card',
    'Product mode: hero | macro detail | in-hand | lifestyle | packshot | packaging | result',
    'Talent mode: none | hand model | lifestyle model | spokesperson | testimonial',
    'Shot type: close-up / medium shot / wide shot / packshot / insert / macro',
    'Keyframe prompt: one still image prompt, no rendered text',
    'Motion prompt: image-to-video motion from that exact keyframe',
    'Camera: simple camera movement',
    'Duration: 2 to 5 seconds',
    '',
    'Rules:',
    '- Use one block per shot.',
    '- Keep prompts visually specific and production-ready.',
    '- Do not ask ComfyStudio to render text into images. Reserve space for editor-native text instead.',
    '- Avoid split screens, collages, storyboard grids, before/after panels, watermarks, captions, random letters, and fake typography.',
    '- Keep product packaging and talent identity consistent with references when references are available.',
    '- Avoid overpromising claims.',
    '',
    'Current editable script draft to improve or follow:',
    '',
    currentScript || buildDirectorScript(data),
  ].join('\n')
}

function flattenPlanShots(plan) {
  const rows = []
  for (const scene of plan || []) {
    for (const shot of scene?.shots || []) {
      rows.push({ scene, shot })
    }
  }
  return rows
}

export default function AdEasyMode({
  assets,
  generationQueue,
  yoloActivePlan,
  yoloQueueVariants,
  yoloStoryboardAssetMap,
  yoloStoryboardReadyCount,
  yoloActivePlanIsStale,
  yoloDependencyCheckInProgress,
  yoloScript,
  setYoloScript,
  setYoloStyleNotes,
  setYoloAdBrandName,
  setYoloAdProductName,
  setYoloAdColorPalette,
  setYoloAdLogoConstraints,
  setYoloAdSpokespersonRole,
  setYoloAdWardrobeNotes,
  setYoloAdProductAssetId,
  setYoloAdModelAssetId,
  setYoloAdFormatPreset,
  setYoloAdPlatformPreset,
  setYoloAdStoryboardSource,
  setYoloAdStoryboardTier,
  setYoloAdVideoSource,
  setYoloAdVideoTier,
  setYoloAdLocalVideoWorkflowId,
  setYoloTargetDuration,
  setYoloShotsPerScene,
  setYoloAnglesPerShot,
  setYoloTakesPerAngle,
  setYoloVideoFps,
  setResolution,
  setImageResolution,
  handleBuildActiveYoloPlan,
  handleQueueYoloStoryboards,
  handleQueueYoloShotStoryboard,
  handleQueueYoloVideos,
  handleQueueYoloShotVideo,
  handleYoloShotImageBeatChange,
  handleYoloShotVideoBeatChange,
  handleYoloShotTakesChange,
  handleAssembleAdTimeline,
}) {
  const initialDraft = useMemo(() => loadAdEasyModeDraft(), [])
  const [step, setStep] = useState('brief')
  const [brand, setBrand] = useState(initialDraft.brand)
  const [product, setProduct] = useState(initialDraft.product)
  const [colors, setColors] = useState(initialDraft.colors)
  const [audience, setAudience] = useState(initialDraft.audience)
  const [promise, setPromise] = useState(initialDraft.promise)
  const [talentDirection, setTalentDirection] = useState(initialDraft.talentDirection)
  const [format, setFormat] = useState(initialDraft.format)
  const [platform, setPlatform] = useState(initialDraft.platform)
  const [tone, setTone] = useState(initialDraft.tone)
  const [resolutionPreset, setResolutionPreset] = useState(initialDraft.resolutionPreset)
  const [videoFps, setVideoFps] = useState(initialDraft.videoFps)
  const [commercialLength, setCommercialLength] = useState(initialDraft.commercialLength)
  const [shotCount, setShotCount] = useState(initialDraft.shotCount)
  const [videoWorkflowId, setVideoWorkflowId] = useState(initialDraft.videoWorkflowId)
  const [productAssetId, setProductAssetId] = useState(initialDraft.productAssetId)
  const [talentAssetId, setTalentAssetId] = useState(initialDraft.talentAssetId)
  const [noVisibleTalent, setNoVisibleTalent] = useState(initialDraft.noVisibleTalent)
  const [directorScript, setDirectorScript] = useState(initialDraft.directorScript || yoloScript || '')
  const [selectedShotIndex, setSelectedShotIndex] = useState(0)
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(0)
  const [keyframeStatus, setKeyframeStatus] = useState('Ready to generate one keyframe.')
  const [videoStatus, setVideoStatus] = useState('Ready to generate one video.')
  const [timelineStatus, setTimelineStatus] = useState('')
  const [timelineStatusOk, setTimelineStatusOk] = useState(true)
  const [llmCopyStatus, setLlmCopyStatus] = useState('')
  const [isQueuingKeyframes, setIsQueuingKeyframes] = useState(false)
  const [isQueuingVideos, setIsQueuingVideos] = useState(false)
  const [isAssemblingTimeline, setIsAssemblingTimeline] = useState(false)

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    const draft = {
      brand,
      product,
      colors,
      audience,
      promise,
      talentDirection,
      format,
      platform,
      tone,
      resolutionPreset,
      videoFps,
      commercialLength,
      shotCount,
      videoWorkflowId,
      productAssetId,
      talentAssetId,
      noVisibleTalent,
      directorScript,
      updatedAt: new Date().toISOString(),
    }
    try {
      localStorage.setItem(AD_EASY_MODE_DRAFT_STORAGE_KEY, JSON.stringify(draft))
    } catch (_) {
      // Ignore storage failures so the form still works in private or restricted contexts.
    }
  }, [
    audience,
    brand,
    colors,
    commercialLength,
    directorScript,
    format,
    noVisibleTalent,
    platform,
    product,
    productAssetId,
    promise,
    resolutionPreset,
    shotCount,
    talentAssetId,
    talentDirection,
    tone,
    videoFps,
    videoWorkflowId,
  ])

  const imageAssets = useMemo(() => (assets || []).filter((asset) => asset?.type === 'image'), [assets])
  const videoAssetMap = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video' || asset?.yolo?.stage !== 'video') continue
      if (asset?.yolo?.mode === 'music') continue
      const workflowScopedKey = getVideoVariantWorkflowKey(asset?.yolo?.variantKey, asset?.yolo?.workflowId)
      if (workflowScopedKey) map.set(workflowScopedKey, asset)
      if (asset?.yolo?.key) map.set(asset.yolo.key, asset)
      if (asset?.yolo?.variantKey && !asset?.yolo?.workflowId) map.set(asset.yolo.variantKey, asset)
    }
    return map
  }, [assets])
  const planShots = useMemo(() => flattenPlanShots(yoloActivePlan), [yoloActivePlan])
  const storyboardJobMap = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.yolo?.mode === 'music') continue
      if (job?.yolo?.stage !== 'storyboard' || !job?.yolo?.key) continue
      map.set(job.yolo.key, job)
    }
    return map
  }, [generationQueue])
  const videoJobMap = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.yolo?.mode === 'music') continue
      if (job?.yolo?.stage !== 'video') continue
      const workflowScopedKey = getVideoVariantWorkflowKey(job?.yolo?.variantKey, job?.yolo?.workflowId)
      if (workflowScopedKey) map.set(workflowScopedKey, job)
      if (job?.yolo?.key) map.set(job.yolo.key, job)
      if (job?.yolo?.variantKey && !job?.yolo?.workflowId) map.set(job.yolo.variantKey, job)
    }
    return map
  }, [generationQueue])

  const selectedTone = TONE_OPTIONS.find((option) => option.id === tone) || TONE_OPTIONS[0]
  const selectedFormat = FORMAT_OPTIONS.find((option) => option.id === format) || FORMAT_OPTIONS[0]
  const selectedVideoWorkflow = VIDEO_MODEL_OPTIONS.find((option) => option.id === videoWorkflowId) || VIDEO_MODEL_OPTIONS[0]
  const selectedAspectRatio = ASPECT_RATIO_OPTIONS.find((option) => option.id === platform) || ASPECT_RATIO_OPTIONS[0]
  const outputResolution = useMemo(
    () => resolveOutputResolution(platform, resolutionPreset),
    [platform, resolutionPreset]
  )
  const outputResolutionLabel = formatResolutionLabel(outputResolution)

  const currentData = {
    brand,
    product,
    colors,
    audience,
    promise,
    talentDirection,
    format,
    formatLabel: selectedFormat.label,
    platform,
    aspectRatioLabel: selectedAspectRatio.label,
    tone,
    toneText: selectedTone.text,
    resolutionPreset,
    resolutionLabel: outputResolutionLabel,
    videoFps,
    commercialLength,
    shotCount,
    noVisibleTalent,
  }

  const generatedScript = useMemo(() => buildDirectorScript(currentData), [
    brand,
    product,
    colors,
    audience,
    promise,
    talentDirection,
    format,
    platform,
    tone,
    resolutionPreset,
    outputResolutionLabel,
    videoFps,
    commercialLength,
    shotCount,
    noVisibleTalent,
  ])
  const externalLlmPrompt = useMemo(
    () => buildExternalLlmPrompt(currentData, directorScript || generatedScript),
    [currentData, directorScript, generatedScript]
  )

  const buildEasyModeStyleNotes = () => ([
    selectedFormat.label,
    selectedTone.text,
    colors,
    `Aspect ratio: ${selectedAspectRatio.label}`,
    `Output resolution: ${outputResolutionLabel}`,
    `FPS: ${Number(videoFps) || 24}`,
    productAssetId ? 'Use the product reference as the packaging/product anchor.' : '',
    talentAssetId && !noVisibleTalent ? 'Use the talent reference as the identity/wardrobe anchor.' : '',
  ].filter(Boolean).join('. '))

  const applyToDirector = (scriptOverride = directorScript || generatedScript) => {
    const script = scriptOverride || generatedScript
    setYoloAdBrandName(brand)
    setYoloAdProductName(product)
    setYoloAdColorPalette(colors)
    setYoloAdLogoConstraints(promise)
    setYoloAdSpokespersonRole(noVisibleTalent ? 'No visible talent' : talentDirection)
    setYoloAdWardrobeNotes(noVisibleTalent ? '' : talentDirection)
    setYoloAdProductAssetId(productAssetId || null)
    setYoloAdModelAssetId(noVisibleTalent ? null : (talentAssetId || null))
    setYoloAdFormatPreset(format)
    setYoloAdPlatformPreset(platform)
    setYoloAdStoryboardSource('cloud')
    setYoloAdStoryboardTier('quality')
    setYoloAdVideoSource('local')
    setYoloAdVideoTier('quality')
    setYoloAdLocalVideoWorkflowId(videoWorkflowId)
    setYoloTargetDuration(Number(commercialLength) || 30)
    setYoloShotsPerScene(Number(shotCount) || 8)
    setYoloAnglesPerShot(1)
    setYoloTakesPerAngle(1)
    setYoloVideoFps(Number(videoFps) || 24)
    setResolution(outputResolution)
    setImageResolution(outputResolution)
    setYoloStyleNotes(buildEasyModeStyleNotes())
    setYoloScript(script)
  }

  const handleVideoWorkflowChange = (workflowId) => {
    setVideoWorkflowId(workflowId)
    setYoloAdVideoSource('local')
    setYoloAdVideoTier('quality')
    setYoloAdLocalVideoWorkflowId(workflowId)
  }

  const goTo = (nextStep) => {
    if (nextStep === 'script') {
      setDirectorScript(generatedScript)
      applyToDirector(generatedScript)
    }
    setStep(nextStep)
  }

  const copyExternalLlmPrompt = async () => {
    setLlmCopyStatus('')
    try {
      await navigator.clipboard.writeText(externalLlmPrompt)
      setLlmCopyStatus('Copied prompt')
    } catch (_) {
      setLlmCopyStatus('Select and copy manually')
    }
  }

  const buildPlanOptions = (script, styleNotes) => ({
    scriptOverride: script,
    styleNotesOverride: styleNotes,
    targetDurationOverride: Number(commercialLength) || 30,
    shotsPerSceneOverride: Number(shotCount) || 8,
    anglesPerShotOverride: 1,
    takesPerAngleOverride: 1,
    productAssetIdOverride: productAssetId || '',
    modelAssetIdOverride: noVisibleTalent ? '' : (talentAssetId || ''),
    productNameOverride: product,
    brandNameOverride: brand,
    colorPaletteOverride: colors,
    logoConstraintsOverride: promise,
    spokespersonRoleOverride: noVisibleTalent ? 'No visible talent' : talentDirection,
    wardrobeNotesOverride: noVisibleTalent ? '' : talentDirection,
    formatPresetOverride: format,
    platformPresetOverride: platform,
  })

  const handleUpdatePlanOnly = () => {
    const script = directorScript || generatedScript
    const styleNotes = buildEasyModeStyleNotes()
    applyToDirector(script)
    const plan = handleBuildActiveYoloPlan(buildPlanOptions(script, styleNotes))
    if (Array.isArray(plan) && plan.length > 0) {
      setSelectedShotIndex(0)
      setSelectedVideoIndex(0)
      setKeyframeStatus('Plan updated without queueing keyframes.')
      setVideoStatus('Plan updated. You can create videos from the existing keyframes.')
      if (yoloStoryboardReadyCount > 0) {
        setStep('keyframes')
      }
    } else {
      setKeyframeStatus('Could not update the plan. Check the script format and try again.')
    }
  }

  const handleBuildPlan = async () => {
    const script = directorScript || generatedScript
    const styleNotes = buildEasyModeStyleNotes()
    applyToDirector(script)
    setIsQueuingKeyframes(true)
    setKeyframeStatus('Building the plan and queueing keyframes...')
    try {
      const plan = handleBuildActiveYoloPlan(buildPlanOptions(script, styleNotes))
      if (Array.isArray(plan) && plan.length > 0) {
        setSelectedShotIndex(0)
        setSelectedVideoIndex(0)
        setStep('keyframes')
        const queuedCount = await handleQueueYoloStoryboards({
          planOverride: plan,
          skipStaleCheck: true,
          skipConfirm: true,
          sourceLabel: 'Ad Easy Mode keyframe pass',
          productAssetIdOverride: productAssetId || '',
          modelAssetIdOverride: noVisibleTalent ? '' : (talentAssetId || ''),
          resolutionOverride: outputResolution,
        })
        setKeyframeStatus(
          queuedCount > 0
            ? `Queued ${queuedCount} keyframe job${queuedCount === 1 ? '' : 's'}. They will appear here as each shot finishes.`
            : 'No new keyframe jobs were queued. Check the queue or existing keyframes.'
        )
      } else {
        setKeyframeStatus('Could not build the plan. Check the script format and try again.')
      }
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleRegenerateAllKeyframes = async () => {
    if (planShots.length === 0) return
    setIsQueuingKeyframes(true)
    setKeyframeStatus('Queueing regeneration for all keyframes...')
    try {
      const queuedCount = await handleQueueYoloStoryboards({
        planOverride: yoloActivePlan,
        skipStaleCheck: true,
        skipConfirm: true,
        allowExistingDoneKeys: true,
        sourceLabel: 'Ad Easy Mode keyframe regeneration pass',
        productAssetIdOverride: productAssetId || '',
        modelAssetIdOverride: noVisibleTalent ? '' : (talentAssetId || ''),
        resolutionOverride: outputResolution,
      })
      setKeyframeStatus(
        queuedCount > 0
          ? `Queued ${queuedCount} keyframe regeneration job${queuedCount === 1 ? '' : 's'}.`
          : 'No keyframe regeneration jobs were queued. Check whether those shots are already running.'
      )
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleRegenerateAllVideos = async () => {
    if (planShots.length === 0) return
    setIsQueuingVideos(true)
    setVideoStatus(`Queueing ${selectedVideoWorkflow.label} for all shot videos...`)
    setStep('videos')
    try {
      const queuedCount = await handleQueueYoloVideos({
        planOverride: yoloActivePlan,
        skipStaleCheck: true,
        skipConfirm: true,
        allowExistingDoneKeys: true,
        targetWorkflowIds: [videoWorkflowId],
        sourceLabel: `Ad Easy Mode ${selectedVideoWorkflow.label} video regeneration pass`,
        resolutionOverride: outputResolution,
      })
      setVideoStatus(
        queuedCount > 0
          ? `Queued ${queuedCount} ${selectedVideoWorkflow.label} video job${queuedCount === 1 ? '' : 's'}.`
          : 'No video jobs were queued. Check for running shots or missing keyframes.'
      )
    } finally {
      setIsQueuingVideos(false)
    }
  }

  const updateLength = (value) => {
    const nextLength = Number(value) || 30
    const nextCount = getSuggestedShotCount(nextLength)
    setCommercialLength(nextLength)
    setShotCount(nextCount)
    const nextScript = buildDirectorScript({ ...currentData, commercialLength: nextLength, shotCount: nextCount })
    setDirectorScript(nextScript)
    applyToDirector(nextScript)
    setYoloTargetDuration(nextLength)
    setYoloShotsPerScene(nextCount)
  }

  const updateShotCount = (value) => {
    const nextCount = Number(value) || 8
    setShotCount(nextCount)
    const nextScript = buildDirectorScript({ ...currentData, shotCount: nextCount })
    setDirectorScript(nextScript)
    applyToDirector(nextScript)
    setYoloShotsPerScene(nextCount)
  }

  const selectedShotRow = planShots[selectedShotIndex] || planShots[0] || null
  const selectedVideoRow = planShots[selectedVideoIndex] || planShots[0] || null

  const getFirstVariantForShot = (sceneId, shotId) => (
    (yoloQueueVariants || []).find((variant) => variant.sceneId === sceneId && variant.shotId === shotId) || null
  )

  const getVideoAssetForVariant = (variant, workflowId = videoWorkflowId) => {
    if (!variant?.key) return null
    const workflowScopedKey = getVideoVariantWorkflowKey(variant.key, workflowId)
    return (workflowScopedKey ? videoAssetMap.get(workflowScopedKey) : null) || videoAssetMap.get(variant.key) || null
  }

  const getVideoJobForVariant = (variant, workflowId = videoWorkflowId) => {
    if (!variant?.key) return null
    const workflowScopedKey = getVideoVariantWorkflowKey(variant.key, workflowId)
    return (workflowScopedKey ? videoJobMap.get(workflowScopedKey) : null) || videoJobMap.get(variant.key) || null
  }

  const getKeyframeCardState = (variant, asset) => {
    if (asset) return { state: 'ready', label: 'Keyframe ready', job: null }
    const job = variant ? storyboardJobMap.get(variant.key) : null
    if (job?.status === 'error') return { state: 'error', label: 'Keyframe failed', job }
    if (job && KEYFRAME_BUSY_STATUSES.has(job.status)) {
      const label = job.status === 'queued'
        ? 'Queued'
        : job.status === 'saving'
          ? 'Saving keyframe'
          : 'Generating keyframe'
      return { state: 'generating', label, job }
    }
    return { state: 'pending', label: 'Keyframe pending', job }
  }

  const getVideoCardState = (variant, asset, hasKeyframe) => {
    if (asset) return { state: 'ready', label: 'Video ready', job: null }
    const job = getVideoJobForVariant(variant)
    if (job?.status === 'error') return { state: 'error', label: 'Video failed', job }
    if (job && VIDEO_BUSY_STATUSES.has(job.status)) {
      const label = job.status === 'queued'
        ? 'Queued'
        : job.status === 'saving'
          ? 'Saving video'
          : 'Generating video'
      return { state: 'generating', label, job }
    }
    if (!hasKeyframe) return { state: 'blocked', label: 'Needs keyframe', job: null }
    return { state: 'pending', label: 'Ready to queue', job }
  }

  const keyframeGeneratingCount = planShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
    const cardState = getKeyframeCardState(variant, asset)
    return count + (cardState.state === 'generating' ? 1 : 0)
  }, 0)
  const videoGeneratingCount = planShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    const asset = getVideoAssetForVariant(variant)
    const hasKeyframe = variant ? yoloStoryboardAssetMap?.has(variant.key) : false
    const cardState = getVideoCardState(variant, asset, hasKeyframe)
    return count + (cardState.state === 'generating' ? 1 : 0)
  }, 0)
  const videoReadyCount = planShots.reduce((count, { scene, shot }) => {
    const variant = getFirstVariantForShot(scene.id, shot.id)
    const asset = getVideoAssetForVariant(variant)
    return count + (asset ? 1 : 0)
  }, 0)

  const handleAssembleTimeline = async () => {
    if (!handleAssembleAdTimeline) return
    setIsAssemblingTimeline(true)
    setTimelineStatus('')
    setTimelineStatusOk(true)
    try {
      const result = await handleAssembleAdTimeline({
        workflowId: videoWorkflowId,
        workflowLabel: selectedVideoWorkflow.label,
        resolution: outputResolution,
      })
      setTimelineStatus(result?.message || 'Timeline assembled.')
      setTimelineStatusOk(result?.ok !== false)
    } catch (error) {
      setTimelineStatus(`Could not assemble timeline: ${error?.message || 'Unknown error'}`)
      setTimelineStatusOk(false)
    } finally {
      setIsAssemblingTimeline(false)
    }
  }

  const stepIndex = STEPS.findIndex((item) => item.id === step)

  const renderStepNav = () => (
    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">Ad Creation Easy Mode</div>
      <div className="mt-3 grid grid-cols-2 gap-1 md:grid-cols-4 xl:grid-cols-8">
        {STEPS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setStep(item.id)}
            disabled={(item.id === 'keyframes' || item.id === 'videos') && planShots.length === 0}
            className={`rounded-lg border px-2 py-1.5 text-left text-[10px] transition-colors ${
              item.id === step
                ? 'border-sf-accent bg-sf-accent/15 text-sf-accent'
                : index < stepIndex
                  ? 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary'
                  : 'border-sf-dark-700 bg-sf-dark-950/40 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-secondary'
            }`}
          >
            <div className="text-[9px] uppercase tracking-wider opacity-70">Step {index + 1}</div>
            <div className="font-medium">{item.label}</div>
          </button>
        ))}
      </div>
    </div>
  )

  const renderChoiceButton = (isSelected, label, onClick, helper = '', key = label) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      title={helper}
      className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
        isSelected
          ? 'border-sf-accent bg-sf-accent/15 text-sf-accent'
          : 'border-sf-dark-600 bg-sf-dark-900/70 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
      }`}
    >
      <div className="font-medium">{label}</div>
      {helper ? <div className="mt-1 text-[10px] text-sf-text-muted">{helper}</div> : null}
    </button>
  )

  const renderActions = (back, next, nextLabel) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button
        type="button"
        onClick={() => setStep(back)}
        className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary"
      >
        Back
      </button>
      <button
        type="button"
        onClick={() => goTo(next)}
        className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover"
      >
        {nextLabel}
      </button>
    </div>
  )

  return (
    <div className="space-y-4">
      {renderStepNav()}

      {step === 'brief' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">ComfyStudio asks</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Let's start with the product.</h2>
            <p className="mt-1 text-xs text-sf-text-muted">Answer what you know. Blank fields can be filled in later from the editable script.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-xs text-sf-text-secondary">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Brand name</span>
              <input value={brand} onChange={(e) => setBrand(e.target.value)} className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none" />
            </label>
            <label className="text-xs text-sf-text-secondary">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Product</span>
              <input value={product} onChange={(e) => setProduct(e.target.value)} className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none" />
            </label>
            <label className="text-xs text-sf-text-secondary">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Audience</span>
              <input value={audience} onChange={(e) => setAudience(e.target.value)} className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none" />
            </label>
            <label className="text-xs text-sf-text-secondary md:col-span-2">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">What should people remember?</span>
              <textarea value={promise} onChange={(e) => setPromise(e.target.value)} rows={3} className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none" />
            </label>
            <label className="text-xs text-sf-text-secondary">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Commercial length</span>
              <select value={commercialLength} onChange={(e) => updateLength(e.target.value)} className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none">
                {COMMERCIAL_LENGTH_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={() => goTo('direction')} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover">Next: Creative Direction</button>
          </div>
        </div>
      )}

      {step === 'direction' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">ComfyStudio asks</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">What kind of ad should this become?</h2>
            <p className="mt-1 text-xs text-sf-text-muted">These choices become structured Director settings, not a freeform chatbot prompt.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Format</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {FORMAT_OPTIONS.map((option) => renderChoiceButton(format === option.id, option.label, () => setFormat(option.id)))}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Tone</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {TONE_OPTIONS.map((option) => renderChoiceButton(tone === option.id, option.label, () => setTone(option.id)))}
              </div>
            </div>
            <label className="text-xs text-sf-text-secondary md:col-span-2">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Visual style / rules</span>
              <input value={colors} onChange={(e) => setColors(e.target.value)} className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none" />
            </label>
            <label className="text-xs text-sf-text-secondary md:col-span-2">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Optional talent or voice direction</span>
              <textarea value={talentDirection} onChange={(e) => setTalentDirection(e.target.value)} rows={3} placeholder="Example: friendly skincare expert, calm female voiceover, no visible spokesperson" className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none" />
            </label>
          </div>
          {renderActions('brief', 'delivery', 'Next: Delivery')}
        </div>
      )}

      {step === 'delivery' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Delivery settings</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Where should the ad fit?</h2>
            <p className="mt-1 text-xs text-sf-text-muted">These settings control frame shape, output size, and motion timing for keyframes and video renders.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Aspect ratio</div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {ASPECT_RATIO_OPTIONS.map((option) => renderChoiceButton(
                  platform === option.id,
                  option.label,
                  () => {
                    setPlatform(option.id)
                    const nextResolution = resolveOutputResolution(option.id, resolutionPreset)
                    setResolution(nextResolution)
                    setImageResolution(nextResolution)
                  },
                  option.helper,
                  `aspect-${option.id}`
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Output resolution</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {RESOLUTION_OPTIONS.map((option) => renderChoiceButton(
                  resolutionPreset === option.id,
                  option.label,
                  () => {
                    setResolutionPreset(option.id)
                    const nextResolution = resolveOutputResolution(platform, option.id)
                    setResolution(nextResolution)
                    setImageResolution(nextResolution)
                  },
                  option.id === '720p' ? 'Faster and lighter.' : 'Sharper output, more work for local video.',
                  `resolution-${option.id}`
                ))}
              </div>
              <div className="mt-2 text-[10px] text-sf-text-muted">
                Current frame size: <span className="text-sf-text-secondary">{outputResolutionLabel}</span>
              </div>
            </div>
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Frames per second</div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {FPS_OPTIONS.map((fpsOption) => renderChoiceButton(
                  videoFps === fpsOption,
                  `${fpsOption} fps`,
                  () => {
                    setVideoFps(fpsOption)
                    setYoloVideoFps(fpsOption)
                  },
                  fpsOption === 24 ? 'Cinematic default.' : fpsOption === 25 ? 'PAL-friendly delivery.' : 'Smoother motion.',
                  `fps-${fpsOption}`
                ))}
              </div>
            </div>
          </div>
          {renderActions('direction', 'references', 'Next: References')}
        </div>
      )}

      {step === 'references' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">ComfyStudio asks</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Do you have product or talent references?</h2>
            <p className="mt-1 text-xs text-sf-text-muted">Optional, but best results come from product sheets and character sheets with multiple angles.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="text-sm font-semibold text-sf-text-primary">Product reference</div>
              <p className="mt-1 text-[11px] text-sf-text-muted">Recommended: product sheet with front, side, label, packaging, and in-hand/use context.</p>
              <select value={productAssetId} onChange={(e) => setProductAssetId(e.target.value)} className="mt-3 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none">
                <option value="">No product asset selected</option>
                {imageAssets.map((asset) => <option key={`easy-product-${asset.id}`} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-sf-text-primary">Talent reference</div>
                <label className="flex items-center gap-1.5 text-[10px] text-sf-text-muted">
                  <input type="checkbox" checked={noVisibleTalent} onChange={(e) => setNoVisibleTalent(e.target.checked)} />
                  No visible talent
                </label>
              </div>
              <p className="mt-1 text-[11px] text-sf-text-muted">Recommended: character sheet with front, side, 3/4 view, expressions, and wardrobe.</p>
              <select disabled={noVisibleTalent} value={talentAssetId} onChange={(e) => setTalentAssetId(e.target.value)} className="mt-3 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none disabled:opacity-50">
                <option value="">No talent asset selected</option>
                {imageAssets.map((asset) => <option key={`easy-talent-${asset.id}`} value={asset.id}>{asset.name}</option>)}
              </select>
            </div>
          </div>
          {renderActions('delivery', 'script', 'Build Script Plan')}
        </div>
      )}

      {step === 'script' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Script plan</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Proposed script and storyboard plan.</h2>
            <p className="mt-1 text-xs text-sf-text-muted">This script is structured Director text. You can edit it manually before building the plan.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Commercial length</div>
              <div className="mt-1 text-xs text-sf-text-primary">{commercialLength} seconds</div>
            </div>
            <label className="text-xs text-sf-text-secondary">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">How many shots?</span>
              <select value={shotCount} onChange={(e) => updateShotCount(e.target.value)} className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none">
                {SHOT_COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count} shots</option>)}
              </select>
              <span className="mt-1 block text-[10px] text-sf-text-muted">{getShotHint(commercialLength)}</span>
            </label>
            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Model route</div>
              <div className="mt-1 text-xs text-sf-text-primary">Nano Banana 2 keyframes + video model chosen in Step 7</div>
            </div>
          </div>
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Optional: use your own LLM</div>
                <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-sf-text-muted">
                  No ComfyStudio API key or setup required. Copy this prompt into ChatGPT, Claude, Gemini, or another LLM, then paste the result back into the editable Director Script below.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {llmCopyStatus && <span className="text-[10px] text-sf-text-muted">{llmCopyStatus}</span>}
                <button
                  type="button"
                  onClick={copyExternalLlmPrompt}
                  className="rounded-lg border border-sf-accent/50 bg-sf-accent/10 px-3 py-2 text-xs text-sf-accent transition-colors hover:bg-sf-accent/20"
                >
                  Copy LLM Prompt
                </button>
              </div>
            </div>
            <textarea
              readOnly
              value={externalLlmPrompt}
              rows={7}
              spellCheck={false}
              onFocus={(event) => event.target.select()}
              onClick={(event) => event.target.select()}
              className="mt-3 w-full resize-y rounded-lg border border-sf-dark-700 bg-sf-dark-950/70 px-3 py-2 font-mono text-[10px] leading-5 text-sf-text-secondary focus:border-sf-accent focus:outline-none"
            />
          </div>
          <textarea
            value={directorScript || generatedScript}
            onChange={(e) => {
              setDirectorScript(e.target.value)
              setYoloScript(e.target.value)
            }}
            rows={18}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 font-mono text-[11px] leading-5 text-sf-text-primary focus:border-sf-accent focus:outline-none"
          />
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100/90">
            Double-check the Director Script before continuing. The next step uses this script to create keyframe jobs, so make sure the shot order, prompts, timing, and references look right.
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setStep('references')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => { const next = generatedScript; setDirectorScript(next); applyToDirector(next) }} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Regenerate script from brief</button>
              <button type="button" onClick={handleUpdatePlanOnly} disabled={isQueuingKeyframes || isQueuingVideos} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50">Update Plan Only</button>
              <button type="button" onClick={handleBuildPlan} disabled={isQueuingKeyframes || yoloDependencyCheckInProgress} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                {isQueuingKeyframes ? 'Queueing Keyframes...' : 'Looks Good - Create Keyframes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'keyframes' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Storyboard review</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">
              {keyframeGeneratingCount > 0
                ? `Generating keyframes (${yoloStoryboardReadyCount}/${planShots.length} ready).`
                : yoloStoryboardReadyCount > 0
                  ? 'Review your generated keyframes.'
                  : 'Keyframes are queued for generation.'}
            </h2>
            <p className="mt-1 text-xs text-sf-text-muted">
              Completed shots will appear here one by one. You can select a shot, edit its keyframe prompt, and regenerate just that shot.
            </p>
          </div>
          {planShots.length === 0 ? (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">Build the script plan first.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
                {planShots.map(({ scene, shot }, index) => {
                  const variant = getFirstVariantForShot(scene.id, shot.id)
                  const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
                  const url = getAssetUrl(asset)
                  const cardState = getKeyframeCardState(variant, asset)
                  return (
                    <button
                      key={`easy-keyframe-${scene.id}-${shot.id}`}
                      type="button"
                      onClick={() => setSelectedShotIndex(index)}
                      className={`overflow-hidden rounded-xl border text-left transition-colors ${
                        selectedShotIndex === index ? 'border-sf-accent bg-sf-accent/10' : 'border-sf-dark-700 bg-sf-dark-900/70 hover:border-sf-dark-500'
                      }`}
                    >
                      <div className={`relative flex h-28 items-center justify-center overflow-hidden ${
                        cardState.state === 'generating'
                          ? 'bg-gradient-to-br from-sf-accent/20 via-sf-dark-800 to-purple-500/20'
                          : cardState.state === 'error'
                            ? 'bg-red-950/30'
                            : 'bg-sf-dark-800'
                      }`}>
                        {url ? (
                          <img src={url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <>
                            {cardState.state === 'generating' && (
                              <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                            )}
                            <span className={`relative text-[10px] ${
                              cardState.state === 'error' ? 'text-red-200' : 'text-sf-text-muted'
                            }`}>
                              {cardState.label}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="p-2">
                        <div className="text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.id}</div>
                        <div className="mt-1 line-clamp-2 text-[10px] text-sf-text-muted">{shot.imageBeat || shot.beat}</div>
                        {cardState.job?.progress > 0 && (
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                            <div className="h-full rounded-full bg-sf-accent" style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                          </div>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
              {selectedShotRow && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-sf-text-primary">Shot {selectedShotIndex + 1}: {selectedShotRow.shot.id}</div>
                      <div className="text-[10px] text-sf-text-muted">{selectedShotRow.scene.id}</div>
                    </div>
                    <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">Nano Banana 2 keyframe</span>
                  </div>
                  <label className="mt-3 block text-xs text-sf-text-secondary">
                    <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Edit shot keyframe prompt</span>
                    <textarea
                      value={selectedShotRow.shot.imageBeat || selectedShotRow.shot.beat || ''}
                      onChange={(e) => handleYoloShotImageBeatChange(selectedShotRow.scene.id, selectedShotRow.shot.id, e.target.value)}
                      rows={4}
                      className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
                    />
                  </label>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" disabled={isQueuingKeyframes || yoloDependencyCheckInProgress} onClick={() => { setKeyframeStatus(`Queued keyframe regeneration for Shot ${selectedShotIndex + 1}.`); void handleQueueYoloShotStoryboard(selectedShotRow.scene.id, selectedShotRow.shot.id, { resolutionOverride: outputResolution }) }} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Regenerate Selected Shot</button>
                    <button type="button" disabled={isQueuingKeyframes || yoloDependencyCheckInProgress || planShots.length === 0} onClick={handleRegenerateAllKeyframes} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50">Regenerate All</button>
                    <button type="button" onClick={() => { setYoloTakesPerAngle(3); handleYoloShotTakesChange(selectedShotRow.scene.id, selectedShotRow.shot.id, 3); setKeyframeStatus('Variation mode set to 3 takes. Click regenerate to queue three seed variations for the selected shot.') }} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Make 3 Variations</button>
                    <span className="text-[10px] text-sf-text-muted">{keyframeStatus}</span>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setStep('script')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
                <div className="flex gap-2">
                  <button type="button" disabled={yoloDependencyCheckInProgress} onClick={() => { setKeyframeStatus('Queued keyframes for all planned shots.'); void handleQueueYoloStoryboards({ resolutionOverride: outputResolution }) }} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:opacity-50">Queue All Keyframes</button>
                  <button type="button" disabled={yoloStoryboardReadyCount === 0} onClick={() => setStep('videos')} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                    Next: Choose Video Model
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'videos' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Video review</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">
              {videoGeneratingCount > 0
                ? 'Generating shot videos.'
                : 'Review the shot videos.'}
            </h2>
            <p className="mt-1 text-xs text-sf-text-muted">Completed videos will appear here one by one. You can select a shot video, edit only its motion prompt, then regenerate just that clip.</p>
          </div>
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2 text-xs text-sf-text-secondary">
            {planShots.length} shots / {commercialLength}s / Nano Banana 2 keyframes / {selectedVideoWorkflow.label} video
          </div>
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Video model pass</div>
                <div className="mt-1 text-sm font-semibold text-sf-text-primary">Viewing {selectedVideoWorkflow.label}</div>
                <p className="mt-1 text-xs text-sf-text-muted">Use the same keyframes to create another complete model pass for comparison in editing.</p>
              </div>
              <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">{outputResolutionLabel} / {videoFps} fps</span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {VIDEO_MODEL_OPTIONS.map((option) => renderChoiceButton(videoWorkflowId === option.id, option.label, () => handleVideoWorkflowChange(option.id), option.helper))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!handleAssembleAdTimeline || videoReadyCount === 0 || yoloActivePlanIsStale || isAssemblingTimeline}
                onClick={handleAssembleTimeline}
                title={videoReadyCount === 0 ? 'Generate at least one ready video first.' : 'Place the ready ad videos on a timeline track using the shot order and durations.'}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isAssemblingTimeline ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                Assemble Timeline
              </button>
              <button type="button" disabled={isQueuingVideos || yoloDependencyCheckInProgress || yoloStoryboardReadyCount === 0} onClick={handleRegenerateAllVideos} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                {isQueuingVideos ? `Queueing ${selectedVideoWorkflow.label}...` : `Generate All With ${selectedVideoWorkflow.label}`}
              </button>
              <span className="text-[10px] text-sf-text-muted">{videoStatus}</span>
            </div>
            {timelineStatus && (
              <div className={`mt-3 rounded-lg border p-3 text-xs ${
                timelineStatusOk
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                  : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-100'
              }`}>
                {timelineStatus}
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {planShots.map(({ scene, shot }, index) => {
              const variant = getFirstVariantForShot(scene.id, shot.id)
              const asset = getVideoAssetForVariant(variant)
              const url = getAssetUrl(asset)
              const hasKeyframe = variant ? yoloStoryboardAssetMap?.has(variant.key) : false
              const cardState = getVideoCardState(variant, asset, hasKeyframe)
              return (
                <button
                  key={`easy-video-${scene.id}-${shot.id}`}
                  type="button"
                  onClick={() => setSelectedVideoIndex(index)}
                  className={`overflow-hidden rounded-xl border text-left transition-colors ${
                    selectedVideoIndex === index ? 'border-sf-accent bg-sf-accent/10' : 'border-sf-dark-700 bg-sf-dark-900/70 hover:border-sf-dark-500'
                  }`}
                >
                  <div className={`relative flex h-28 items-center justify-center overflow-hidden ${
                    cardState.state === 'generating'
                      ? 'bg-gradient-to-br from-sf-accent/20 via-sf-dark-800 to-purple-500/20'
                      : cardState.state === 'error'
                        ? 'bg-red-950/30'
                        : 'bg-sf-dark-800'
                  }`}>
                    {url ? (
                      <video src={url} className="h-full w-full object-cover" muted />
                    ) : (
                      <>
                        {cardState.state === 'generating' && (
                          <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                        )}
                        <span className={`relative text-[10px] ${
                          cardState.state === 'error' ? 'text-red-200' : 'text-sf-text-muted'
                        }`}>
                          {cardState.label}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.id}</div>
                    <div className="mt-1 text-[10px] text-sf-text-muted">{cardState.label}</div>
                    {cardState.job?.progress > 0 && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                        <div className="h-full rounded-full bg-sf-accent" style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
          {selectedVideoRow && (
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-800/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-sf-text-primary">Shot {selectedVideoIndex + 1} Video: {selectedVideoRow.shot.id}</div>
                  <div className="text-[10px] text-sf-text-muted">{selectedVideoRow.scene.id}</div>
                </div>
                <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">{selectedVideoWorkflow.label}</span>
              </div>
              <label className="mt-3 block text-xs text-sf-text-secondary">
                <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Edit shot motion prompt</span>
                <textarea
                  value={selectedVideoRow.shot.videoBeat || selectedVideoRow.shot.beat || ''}
                  onChange={(e) => handleYoloShotVideoBeatChange(selectedVideoRow.scene.id, selectedVideoRow.shot.id, e.target.value)}
                  rows={4}
                  className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={isQueuingVideos || yoloDependencyCheckInProgress} onClick={() => { setVideoStatus(`Queued ${selectedVideoWorkflow.label} video regeneration for Shot ${selectedVideoIndex + 1}.`); void handleQueueYoloShotVideo(selectedVideoRow.scene.id, selectedVideoRow.shot.id, { planOverride: yoloActivePlan, skipStaleCheck: true, targetWorkflowIds: [videoWorkflowId], resolutionOverride: outputResolution }) }} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Regenerate Shot With {selectedVideoWorkflow.label}</button>
                <button type="button" onClick={() => { setYoloTakesPerAngle(3); handleYoloShotTakesChange(selectedVideoRow.scene.id, selectedVideoRow.shot.id, 3); setVideoStatus('Variation mode set to 3 takes. Click regenerate to queue three video seed variations after keyframes exist.') }} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Make 3 Variations</button>
                <span className="text-[10px] text-sf-text-muted">{videoStatus}</span>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => setStep('keyframes')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Back</button>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('done')} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover">Approve Videos and Finish</button>
            </div>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Complete</div>
            <h2 className="mt-1 text-lg font-semibold text-sf-text-primary">Your ad is complete.</h2>
            <p className="mt-1 text-xs text-sf-text-muted">You can still return to Keyframes or Videos to regenerate individual shots.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setStep('keyframes')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Open Keyframes</button>
            <button type="button" onClick={() => setStep('videos')} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary">Open Videos</button>
            <button type="button" onClick={() => setStep('brief')} className="rounded-lg bg-sf-accent px-3 py-2 text-xs text-white hover:bg-sf-accent-hover">Start Another Easy Ad</button>
          </div>
        </div>
      )}
    </div>
  )
}
