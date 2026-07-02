import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Clipboard,
  Edit3,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  MapPin,
  Mic,
  Play,
  Plus,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react'
import {
  buildShortFilmVideoPrompt,
  buildShortFilmDialogueMotionPrompt,
  ELEVENLABS_TTS_WORKFLOW_ID,
  SHORT_FILM_DIALOGUE_MOUTH_GUIDANCE,
  SHORT_FILM_KEYFRAME_WORKFLOW_OPTIONS,
  SHORT_FILM_VIDEO_RESOLUTION_OPTIONS,
} from '../../config/shortFilmConfig'

const DRAFT_STORAGE_KEY = 'comfystudio-short-film-easy-mode-draft-v1'

const STEPS = [
  { id: 'story', label: 'Story', number: '1' },
  { id: 'characters', label: 'Characters', number: '2' },
  { id: 'locations', label: 'Locations', number: '3' },
  { id: 'script', label: 'Script', number: '4' },
  { id: 'voices', label: 'Voices', number: '5' },
  { id: 'shotPlan', label: 'Shot Plan', number: '6' },
  { id: 'keyframes', label: 'Keyframes', number: '7' },
  { id: 'videos', label: 'Videos', number: '8' },
  { id: 'assemble', label: 'Assemble', number: '9' },
]

const ASPECT_RATIO_OPTIONS = [
  { id: 'landscape_16x9', label: '16:9', helper: 'Traditional short film frame.' },
  { id: 'vertical_9x16', label: '9:16', helper: 'Vertical social short.' },
  { id: 'square_1x1', label: '1:1', helper: 'Square social frame.' },
]

const RESOLUTION_OPTIONS = SHORT_FILM_VIDEO_RESOLUTION_OPTIONS

const FPS_OPTIONS = [24, 25, 30]

const VOICE_WORKFLOW_OPTIONS = [
  {
    id: 'text_to_speech',
    label: 'Text to Speech',
    helper: 'One character line at a time with a locked voice profile.',
  },
  {
    id: 'text_to_dialogue',
    label: 'Text to Dialogue',
    helper: 'Multi-character scene dialogue from one screenplay section.',
  },
  {
    id: 'speech_to_speech',
    label: 'Speech to Speech',
    helper: 'Use a guide performance and convert it into the cast voice.',
  },
]

const ELEVENLABS_VOICE_OPTIONS = [
  'Jessica (female, american)',
  'Laura (female, american)',
  'Sarah (female, american)',
  'River (non-binary, american)',
  'Roger (male, american)',
  'Callum (male, american)',
  'Eric (male, american)',
  'Liam (male, american)',
  'George (male, british)',
  'Charlie (male, australian)',
]

const DEFAULT_SCREENPLAY = `INT. ROADSIDE MOTEL ROOM - NIGHT

James stands beside a buzzing neon window, holding a room key that is not his.

JAMES:
This is not the room I paid for.

MARA:
Nobody pays for the room they actually get.

The bathroom light flickers. Something knocks once from inside the wall.

JAMES:
Did you hear that?

MARA:
I was hoping you would pretend you did not.`

const DEFAULT_DRAFT = Object.freeze({
  step: 'story',
  title: 'Room 12',
  premise: 'Two strangers realize they have been checked into the same motel room, but the room remembers one of them.',
  creativeDirection: 'Grounded supernatural thriller, one motel location, tense but slightly funny, practical lighting, no glossy sci-fi.',
  runtimeSeconds: 60,
  aspectRatio: 'landscape_16x9',
  resolutionPreset: '720p',
  videoFps: 24,
  screenplay: DEFAULT_SCREENPLAY,
  voiceWorkflow: 'text_to_speech',
  keyframeWorkflow: 'nano-banana-2',
})

const DEFAULT_CHARACTERS = Object.freeze([
  {
    id: 'character-james',
    slug: 'james',
    name: 'James',
    role: 'Lead',
    visualNotes: 'Early 30s, tired denim jacket, anxious but trying to stay composed.',
    referenceAssetId: '',
    voicePreset: 'Roger (male, american)',
    voiceNotes: 'American male, grounded, dry, tense but not theatrical.',
  },
  {
    id: 'character-mara',
    slug: 'mara',
    name: 'Mara',
    role: 'Co-lead',
    visualNotes: 'Late 20s, black raincoat, calm expression, knows more than she says.',
    referenceAssetId: '',
    voicePreset: 'Laura (female, american)',
    voiceNotes: 'American female, quiet confidence, subtle menace, natural pace.',
  },
])

const DEFAULT_LOCATIONS = Object.freeze([
  {
    id: 'location-room-12',
    slug: 'room_12',
    name: 'Room 12',
    description: 'Small roadside motel room with amber table lamp, rain on the window, old floral bedspread, buzzing bathroom light.',
    heroAssetId: '',
    wideAssetId: '',
    reverseAssetId: '',
    detailAssetId: '',
  },
  {
    id: 'location-hallway',
    slug: 'second_floor_hallway',
    name: 'Second floor hallway',
    description: 'Narrow exterior motel walkway, blue neon spill, wet concrete, numbered doors receding into darkness.',
    heroAssetId: '',
    wideAssetId: '',
    reverseAssetId: '',
    detailAssetId: '',
  },
])

function normalizeOption(value, options, fallback) {
  const normalized = String(value || '').trim()
  return options.some((option) => option?.id === normalized) ? normalized : fallback
}

function normalizeNumber(value, allowedValues, fallback) {
  const parsed = Number(value)
  return allowedValues.includes(parsed) ? parsed : fallback
}

function normalizeStep(stepId) {
  return STEPS.some((step) => step.id === stepId) ? stepId : DEFAULT_DRAFT.step
}

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim()
  return text || fallback
}

function normalizeCharacters(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : DEFAULT_CHARACTERS
  return source.map((entry, index) => ({
    id: String(entry?.id || `character-${Date.now()}-${index}`),
    slug: normalizeText(entry?.slug, `character_${index + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
    name: normalizeText(entry?.name, `Character ${index + 1}`),
    role: normalizeText(entry?.role, 'Character'),
    visualNotes: String(entry?.visualNotes || ''),
    referenceAssetId: String(entry?.referenceAssetId || ''),
    voicePreset: normalizeText(entry?.voicePreset, 'Roger (male, american)'),
    voiceNotes: String(entry?.voiceNotes || ''),
  }))
}

function normalizeLocations(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : DEFAULT_LOCATIONS
  return source.map((entry, index) => ({
    id: String(entry?.id || `location-${Date.now()}-${index}`),
    slug: normalizeText(entry?.slug, `location_${index + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
    name: normalizeText(entry?.name, `Location ${index + 1}`),
    description: String(entry?.description || ''),
    heroAssetId: String(entry?.heroAssetId || ''),
    wideAssetId: String(entry?.wideAssetId || ''),
    reverseAssetId: String(entry?.reverseAssetId || ''),
    detailAssetId: String(entry?.detailAssetId || ''),
  }))
}

function normalizeDraft(rawDraft = {}) {
  const raw = rawDraft && typeof rawDraft === 'object' ? rawDraft : {}
  return {
    step: normalizeStep(raw.step),
    title: normalizeText(raw.title, DEFAULT_DRAFT.title),
    premise: normalizeText(raw.premise, DEFAULT_DRAFT.premise),
    creativeDirection: normalizeText(raw.creativeDirection, DEFAULT_DRAFT.creativeDirection),
    runtimeSeconds: Math.max(15, Math.min(600, Number(raw.runtimeSeconds) || DEFAULT_DRAFT.runtimeSeconds)),
    aspectRatio: normalizeOption(raw.aspectRatio, ASPECT_RATIO_OPTIONS, DEFAULT_DRAFT.aspectRatio),
    resolutionPreset: normalizeOption(raw.resolutionPreset, RESOLUTION_OPTIONS, DEFAULT_DRAFT.resolutionPreset),
    videoFps: normalizeNumber(raw.videoFps, FPS_OPTIONS, DEFAULT_DRAFT.videoFps),
    screenplay: String(raw.screenplay || DEFAULT_DRAFT.screenplay),
    voiceWorkflow: normalizeOption(raw.voiceWorkflow, VOICE_WORKFLOW_OPTIONS, DEFAULT_DRAFT.voiceWorkflow),
    keyframeWorkflow: normalizeOption(raw.keyframeWorkflow, SHORT_FILM_KEYFRAME_WORKFLOW_OPTIONS, DEFAULT_DRAFT.keyframeWorkflow),
  }
}

function loadDraft() {
  if (typeof localStorage === 'undefined') {
    return {
      draft: DEFAULT_DRAFT,
      characters: normalizeCharacters(DEFAULT_CHARACTERS),
      locations: normalizeLocations(DEFAULT_LOCATIONS),
      shotPlan: [],
    }
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    return {
      draft: normalizeDraft(parsed.draft || parsed),
      characters: normalizeCharacters(parsed.characters),
      locations: normalizeLocations(parsed.locations),
      shotPlan: Array.isArray(parsed.shotPlan) ? parsed.shotPlan : [],
    }
  } catch (_) {
    return {
      draft: DEFAULT_DRAFT,
      characters: normalizeCharacters(DEFAULT_CHARACTERS),
      locations: normalizeLocations(DEFAULT_LOCATIONS),
      shotPlan: [],
    }
  }
}

function resolveOutputResolution(aspectRatio, resolutionPreset) {
  const is1080 = resolutionPreset === '1080p'
  if (aspectRatio === 'vertical_9x16') {
    return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }
  }
  if (aspectRatio === 'square_1x1') {
    return is1080 ? { width: 1080, height: 1080 } : { width: 720, height: 720 }
  }
  return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
}

function formatResolutionLabel(resolution) {
  if (!resolution) return ''
  return `${resolution.width}x${resolution.height}`
}

function getAssetUrl(asset) {
  return asset?.url || asset?.thumbnailUrl || asset?.proxyUrl || asset?.path || ''
}

function getAssetName(asset) {
  return asset?.name || asset?.filename || asset?.label || 'Untitled asset'
}

function buttonClass(selected) {
  return selected
    ? 'border-sf-accent bg-sf-accent/20 text-sf-text-primary ring-1 ring-sf-accent/40'
    : 'border-sf-dark-600 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
}

function hasNoDialogueInstruction(screenplay = '') {
  const text = String(screenplay || '').toLowerCase()
  return /\b(?:absolutely\s+)?no\s+(?:spoken\s+)?dialogue\b/.test(text)
    || /\bwithout\s+(?:any\s+)?(?:spoken\s+)?dialogue\b/.test(text)
    || /\bno\s+spoken\s+lines?\b/.test(text)
    || /\bsilent\s+film\b/.test(text)
}

function compactShotText(value = '', maxLength = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`
}

function parseShotDuration(value = '', fallback = 5) {
  const match = String(value || '').match(/\b(?:duration|length)\s*:\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\b/i)
  const parsed = match ? Number(match[1]) : Number(fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(30, Math.round(parsed)))
}

function inferShotType(title = '', body = '') {
  const text = `${title} ${body}`.toLowerCase()
  if (/\b(drone|aerial|establishing|wide|epic)\b/.test(text)) return 'wide'
  if (/\b(close-up|close up|portrait|detail)\b/.test(text)) return 'close-up'
  if (/\b(insert|details?)\b/.test(text)) return 'insert'
  if (/\b(cutaway|environment|waterfall|temple|bridge)\b/.test(text)) return 'cutaway'
  if (/\b(dance|celebration|children|running|action)\b/.test(text)) return 'action'
  return 'shot'
}

function parseExplicitShotList(screenplay, { locations = [] } = {}) {
  const lines = String(screenplay || '').split(/\r?\n/)
  const blocks = []
  let current = null

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim()
    const headingMatch = line.match(/^SHOT\s+([0-9]+|[A-Z]+)\s*(?:[-:.)]|\u2013|\u2014)+\s*(.*?)\s*$/i)
    if (headingMatch) {
      if (current) blocks.push(current)
      current = {
        title: headingMatch[2] || `Shot ${blocks.length + 1}`,
        lines: [],
      }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) blocks.push(current)

  if (blocks.length === 0) return null

  const primaryLocation = locations[0] || normalizeLocations(DEFAULT_LOCATIONS)[0]

  return blocks.map((block, index) => {
    const bodyLines = block.lines.map((line) => line.trim()).filter(Boolean)
    const bodyText = bodyLines.join(' ')
    const cameraLine = bodyLines.find((line) => /^(?:camera|camera movement)\s*:/i.test(line)) || ''
    const visualLines = bodyLines.filter((line) => !/^(?:camera|camera movement|duration|length)\s*:/i.test(line))
    const visualText = visualLines.join(' ')
    const title = compactShotText(block.title || `Shot ${index + 1}`, 120)
    const keyframe = compactShotText([title, visualText].filter(Boolean).join('. '))
    const motion = compactShotText([
      cameraLine.replace(/^(?:camera|camera movement)\s*:\s*/i, ''),
      visualText,
    ].filter(Boolean).join(' '))

    return {
      id: `shot-${String(index + 1).padStart(3, '0')}`,
      scene: 'Provided shot list',
      title,
      type: inferShotType(title, bodyText),
      locationSlug: primaryLocation.slug,
      characterSlug: '',
      dialogueId: '',
      keyframe: keyframe || `${title}, cinematic production still.`,
      motion: motion || `${title}, cinematic motion matching the provided shot list.`,
      duration: parseShotDuration(bodyText, 5),
    }
  })
}

function parseDialogueLines(screenplay, characters) {
  if (hasNoDialogueInstruction(screenplay)) return []

  const lines = String(screenplay || '').split(/\r?\n/)
  const characterByName = new Map()
  for (const character of characters) {
    characterByName.set(character.name.toLowerCase(), character)
    characterByName.set(character.slug.toLowerCase(), character)
  }

  const result = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] || ''
    const colonMatch = raw.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{1,32})\s*:\s*(.+?)\s*$/)
    if (colonMatch) {
      const speakerText = colonMatch[1].trim()
      const character = characterByName.get(speakerText.toLowerCase())
      if (!character) continue
      result.push({
        id: `dialogue-${result.length + 1}`,
        speaker: character.name,
        slug: character.slug,
        text: colonMatch[2].trim(),
      })
      continue
    }

    const speakerLine = raw.trim()
    const speakerCandidate = speakerLine.replace(/:$/, '').trim()
    if (!speakerCandidate || speakerCandidate.length > 32 || speakerCandidate !== speakerCandidate.toUpperCase()) continue
    const possibleCharacter = characterByName.get(speakerCandidate.toLowerCase())
    if (!possibleCharacter) continue
    const dialogueParts = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const text = lines[next].trim()
      if (!text) break
      if (text === text.toUpperCase() && text.length <= 32) break
      dialogueParts.push(text)
      index = next
    }
    if (dialogueParts.length > 0) {
      result.push({
        id: `dialogue-${result.length + 1}`,
        speaker: possibleCharacter.name,
        slug: possibleCharacter.slug,
        text: dialogueParts.join(' '),
      })
    }
  }
  return result
}

function createShotPlan({ screenplay, characters, locations, runtimeSeconds }) {
  const explicitShotList = parseExplicitShotList(screenplay, { locations })
  if (Array.isArray(explicitShotList) && explicitShotList.length > 0) {
    return explicitShotList
  }

  const dialogueLines = parseDialogueLines(screenplay, characters)
  const primaryLocation = locations[0] || normalizeLocations(DEFAULT_LOCATIONS)[0]
  const hallwayLocation = locations[1] || primaryLocation
  const shots = [
    {
      id: 'shot-001',
      scene: 'Scene 1',
      title: 'Establish the room',
      type: 'wide',
      locationSlug: primaryLocation.slug,
      characterSlug: '',
      dialogueId: '',
      keyframe: `${primaryLocation.name}, wide establishing frame, practical light, clear geography, film still composition.`,
      motion: 'Slow push in from the doorway while the room tone and neon flicker establish the mood.',
      duration: 4,
    },
  ]

  dialogueLines.forEach((line, index) => {
    const startNumber = shots.length + 1
    const closeDuration = Math.max(3, Math.min(6, Math.round(Number(runtimeSeconds || 60) / Math.max(12, dialogueLines.length * 2))))
    shots.push({
      id: `shot-${String(startNumber).padStart(3, '0')}`,
      scene: 'Scene 1',
      title: `${line.speaker} dialogue`,
      type: index % 3 === 0 ? 'medium close-up' : 'close-up',
      locationSlug: primaryLocation.slug,
      characterSlug: line.slug,
      dialogueId: line.id,
      keyframe: `${line.speaker} in ${primaryLocation.name}, matching wardrobe and lighting, dialogue coverage, cinematic close framing.`,
      motion: buildShortFilmDialogueMotionPrompt(line.speaker),
      duration: closeDuration,
    })
    if (index % 2 === 0) {
      const reactionCharacter = characters.find((character) => character.slug !== line.slug) || characters[0]
      shots.push({
        id: `shot-${String(startNumber + 1).padStart(3, '0')}`,
        scene: 'Scene 1',
        title: `${reactionCharacter?.name || 'Character'} reaction`,
        type: 'reaction',
        locationSlug: primaryLocation.slug,
        characterSlug: reactionCharacter?.slug || '',
        dialogueId: '',
        keyframe: `${reactionCharacter?.name || 'Character'} listening inside ${primaryLocation.name}, same lighting, restrained reaction shot.`,
        motion: 'Hold on a quiet reaction while the other character finishes speaking off screen.',
        duration: 3,
      })
    }
  })

  shots.push({
    id: `shot-${String(shots.length + 1).padStart(3, '0')}`,
    scene: 'Scene 1',
    title: 'Exterior pressure release',
    type: 'cutaway',
    locationSlug: hallwayLocation.slug,
    characterSlug: '',
    dialogueId: '',
    keyframe: `${hallwayLocation.name}, empty space, wet surfaces, practical neon color, suspenseful negative space.`,
    motion: 'A slow drift across the empty location, letting the atmosphere carry the transition into the next beat.',
    duration: 4,
  })

  return shots
}

function buildLlmBrief({ draft, characters, locations }) {
  const castLines = characters.map((character) => (
    `  - ${character.slug}: ${character.name} (${character.role}). Visual: ${character.visualNotes || 'No notes yet.'} Voice: ${character.voiceNotes || character.voicePreset || 'Use a natural voice.'}`
  ))
  const locationLines = locations.map((location) => (
    `  - ${location.slug}: ${location.name}. ${location.description || 'No description yet.'}`
  ))

  return `You are writing and directing a short film for Velorn.

Return a production-ready short film script and shot plan that can be parsed into dialogue audio, keyframes, videos, and an editor timeline.

Project title: ${draft.title}
Target runtime: about ${draft.runtimeSeconds}s
Output: ${draft.aspectRatio.replace('landscape_', '').replace('vertical_', '').replace('square_', '')}, ${draft.resolutionPreset}, ${draft.videoFps}fps

Premise:
${draft.premise}

Creative direction:
${draft.creativeDirection}

Cast slugs:
${castLines.join('\n')}

Allowed location slugs:
${locationLines.join('\n')}

Rules:
1. The script is the source of truth. Put story, tone, wardrobe, location, lighting, continuity, dialogue, and camera intent directly into the script and shot plan.
2. Use only the character slugs and location slugs listed above unless a new one is absolutely required.
3. Dialogue must clearly identify the speaking character.
4. Keep generated video shots between 2 and 8 seconds.
5. Every shot should include: Scene, Shot title, Start estimate, Length, Location slug, Characters visible, Dialogue audio if any, Shot type, Keyframe prompt, Motion prompt, and Camera.
6. Include reaction shots, wide shots, inserts, and cutaways where useful so the edit has coverage.
7. Do not include transitions unless the story explicitly needs one.
8. For any shot with Dialogue audio, the Motion prompt must explicitly request readable speech motion: ${SHORT_FILM_DIALOGUE_MOUTH_GUIDANCE} Do not use vague phrases like "subtle facial motion" for speaking shots.

Required format:

Scene 1: [scene title]
Location: [location_slug]

Action:
[short screenplay action]

Dialogue:
[character_slug]: "[line]"

Shot 1: [shot title]
Start estimate: 0:00
Length: 4
Location: [location_slug]
Characters visible: [character_slug, character_slug, or none]
Dialogue audio: [character_slug line text, or none]
Shot type: [wide | close-up | two-shot | reaction | insert | cutaway]
Keyframe prompt: [opening still prompt with location, character, wardrobe, lighting, palette, composition]
Motion prompt: [for dialogue shots, clear visible mouth opening and lip/jaw/cheek movement synced to the words; for non-dialogue shots, performance, camera movement, blocking, atmosphere]
Camera: [lens/framing/movement]

(Continue until the short film is covered.)`
}

function FieldLabel({ children }) {
  return <label className="text-[10px] uppercase tracking-wide text-sf-text-muted">{children}</label>
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-sf-text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold text-sf-text-primary">{value}</div>
    </div>
  )
}

function AssetSelect({ value, onChange, assets, placeholder = 'Choose reference image' }) {
  return (
    <select
      value={value || ''}
      onChange={(event) => onChange(event.target.value)}
      className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
    >
      <option value="">{placeholder}</option>
      {assets.map((asset) => (
        <option key={asset.id} value={asset.id}>{getAssetName(asset)}</option>
      ))}
    </select>
  )
}

function ReferencePreview({ asset }) {
  const url = getAssetUrl(asset)
  if (!url) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-sf-dark-600 bg-sf-dark-950 text-sf-text-muted">
        <ImageIcon className="h-5 w-5" />
      </div>
    )
  }
  return (
    <div className="aspect-video overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950">
      <img src={url} alt={getAssetName(asset)} className="h-full w-full object-cover" />
    </div>
  )
}

export default function ShortFilmEasyMode({
  assets = [],
  generationQueue = [],
  onQueueVoices,
  onQueueKeyframes,
  onQueueVideos,
  setResolution,
  setImageResolution,
  setYoloVideoFps,
}) {
  const initial = useMemo(() => loadDraft(), [])
  const [draft, setDraft] = useState(initial.draft)
  const [characters, setCharacters] = useState(initial.characters)
  const [locations, setLocations] = useState(initial.locations)
  const [shotPlan, setShotPlan] = useState(initial.shotPlan)
  const [briefStatus, setBriefStatus] = useState('')
  const [voiceStatus, setVoiceStatus] = useState('')
  const [keyframeStatus, setKeyframeStatus] = useState('')
  const [videoStatus, setVideoStatus] = useState('')
  const [selectedVideoShotId, setSelectedVideoShotId] = useState('')
  const [videoPromptOverrides, setVideoPromptOverrides] = useState({})
  const [editingShotId, setEditingShotId] = useState('')

  const imageAssets = useMemo(
    () => assets.filter((asset) => asset?.type === 'image'),
    [assets]
  )
  const outputResolution = useMemo(
    () => resolveOutputResolution(draft.aspectRatio, draft.resolutionPreset),
    [draft.aspectRatio, draft.resolutionPreset]
  )
  const outputResolutionLabel = formatResolutionLabel(outputResolution)
  const dialogueLines = useMemo(
    () => parseDialogueLines(draft.screenplay, characters),
    [characters, draft.screenplay]
  )
  const llmBrief = useMemo(
    () => buildLlmBrief({ draft, characters, locations }),
    [characters, draft, locations]
  )
  const voiceJobByDialogueId = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.workflowId !== ELEVENLABS_TTS_WORKFLOW_ID) continue
      if (job?.shortFilm?.kind !== 'dialogue-voice') continue
      if (job.shortFilm.title && job.shortFilm.title !== draft.title) continue
      const dialogueId = String(job.shortFilm.dialogueId || '')
      if (!dialogueId) continue
      const previous = map.get(dialogueId)
      if (!previous || Number(job.createdAt || 0) >= Number(previous.createdAt || 0)) {
        map.set(dialogueId, job)
      }
    }
    return map
  }, [draft.title, generationQueue])
  const keyframeJobByShotId = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.shortFilm?.kind !== 'shot-keyframe') continue
      if (job.shortFilm.title && job.shortFilm.title !== draft.title) continue
      const shotId = String(job.shortFilm.shotId || '')
      if (!shotId) continue
      const previous = map.get(shotId)
      if (!previous || Number(job.createdAt || 0) >= Number(previous.createdAt || 0)) {
        map.set(shotId, job)
      }
    }
    return map
  }, [draft.title, generationQueue])
  const keyframeAssetByShotId = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'image') continue
      if (asset?.shortFilm?.kind !== 'shot-keyframe') continue
      if (asset.shortFilm.title && asset.shortFilm.title !== draft.title) continue
      const shotId = String(asset.shortFilm.shotId || '')
      if (!shotId) continue
      map.set(shotId, asset)
    }
    return map
  }, [assets, draft.title])
  const voiceAssetByDialogueId = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'audio') continue
      if (asset?.shortFilm?.kind !== 'dialogue-voice') continue
      if (asset.shortFilm.title && asset.shortFilm.title !== draft.title) continue
      const dialogueId = String(asset.shortFilm.dialogueId || '')
      if (!dialogueId) continue
      map.set(dialogueId, asset)
    }
    return map
  }, [assets, draft.title])
  const videoJobByShotId = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.shortFilm?.kind !== 'shot-video') continue
      if (job.shortFilm.title && job.shortFilm.title !== draft.title) continue
      const shotId = String(job.shortFilm.shotId || '')
      if (!shotId) continue
      const previous = map.get(shotId)
      if (!previous || Number(job.createdAt || 0) >= Number(previous.createdAt || 0)) {
        map.set(shotId, job)
      }
    }
    return map
  }, [draft.title, generationQueue])
  const videoAssetByShotId = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video') continue
      if (asset?.shortFilm?.kind !== 'shot-video') continue
      if (asset.shortFilm.title && asset.shortFilm.title !== draft.title) continue
      const shotId = String(asset.shortFilm.shotId || '')
      if (!shotId) continue
      map.set(shotId, asset)
    }
    return map
  }, [assets, draft.title])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      draft,
      characters,
      locations,
      shotPlan,
    }))
  }, [characters, draft, locations, shotPlan])

  useEffect(() => {
    setResolution?.(outputResolution)
    setImageResolution?.(outputResolution)
    setYoloVideoFps?.(Number(draft.videoFps) || 24)
  }, [draft.videoFps, outputResolution, setImageResolution, setResolution, setYoloVideoFps])

  const currentStepIndex = Math.max(0, STEPS.findIndex((entry) => entry.id === draft.step))
  const currentVoiceWorkflow = VOICE_WORKFLOW_OPTIONS.find((option) => option.id === draft.voiceWorkflow) || VOICE_WORKFLOW_OPTIONS[0]

  const updateDraft = (patch) => setDraft((prev) => ({ ...prev, ...patch }))
  const goNext = () => {
    const nextStep = STEPS[Math.min(STEPS.length - 1, currentStepIndex + 1)]
    if (nextStep) updateDraft({ step: nextStep.id })
  }
  const goBack = () => {
    const nextStep = STEPS[Math.max(0, currentStepIndex - 1)]
    if (nextStep) updateDraft({ step: nextStep.id })
  }

  const updateCharacter = (id, patch) => {
    setCharacters((prev) => prev.map((character) => (
      character.id === id ? { ...character, ...patch } : character
    )))
  }

  const addCharacter = () => {
    setCharacters((prev) => [
      ...prev,
      {
        id: `character-${Date.now()}`,
        slug: `character_${prev.length + 1}`,
        name: `Character ${prev.length + 1}`,
        role: 'Supporting',
        visualNotes: '',
        referenceAssetId: '',
        voicePreset: 'Roger (male, american)',
        voiceNotes: '',
      },
    ])
  }

  const removeCharacter = (id) => {
    setCharacters((prev) => (prev.length <= 1 ? prev : prev.filter((character) => character.id !== id)))
  }

  const updateLocation = (id, patch) => {
    setLocations((prev) => prev.map((location) => (
      location.id === id ? { ...location, ...patch } : location
    )))
  }

  const addLocation = () => {
    setLocations((prev) => [
      ...prev,
      {
        id: `location-${Date.now()}`,
        slug: `location_${prev.length + 1}`,
        name: `Location ${prev.length + 1}`,
        description: '',
        heroAssetId: '',
        wideAssetId: '',
        reverseAssetId: '',
        detailAssetId: '',
      },
    ])
  }

  const removeLocation = (id) => {
    setLocations((prev) => (prev.length <= 1 ? prev : prev.filter((location) => location.id !== id)))
  }

  const copyBrief = async () => {
    try {
      await navigator.clipboard?.writeText(llmBrief)
      setBriefStatus('Copied LLM brief.')
    } catch (_) {
      setBriefStatus('Could not copy automatically. Select the brief text and copy it manually.')
    }
  }

  const generateShotPlan = () => {
    const nextPlan = createShotPlan({
      screenplay: draft.screenplay,
      characters,
      locations,
      runtimeSeconds: draft.runtimeSeconds,
    })
    setShotPlan(nextPlan)
    updateDraft({ step: dialogueLines.length > 0 ? 'voices' : 'shotPlan' })
  }

  const clearShotPlan = () => {
    setShotPlan([])
    setEditingShotId('')
    setSelectedVideoShotId('')
  }

  const updateShotPlanShot = (shotId, patch) => {
    const normalizedShotId = String(shotId || '')
    if (!normalizedShotId) return
    setShotPlan((prev) => prev.map((shot) => (
      shot.id === normalizedShotId ? { ...shot, ...patch } : shot
    )))
  }

  const queueVoices = async () => {
    if (draft.voiceWorkflow !== 'text_to_speech') {
      setVoiceStatus('Only Text to Speech is wired right now. Text to Dialogue and Speech to Speech are good future options, but this pass creates one editable clip per line.')
      return
    }

    if (typeof onQueueVoices !== 'function') {
      setVoiceStatus('Voice queue is not available in this build yet.')
      return
    }

    setVoiceStatus('Queueing dialogue voice clips...')
    try {
      const result = await onQueueVoices({
        title: draft.title,
        voiceWorkflow: draft.voiceWorkflow,
        dialogueLines,
        characters,
      })
      setVoiceStatus(result?.message || 'Voice queue updated.')
    } catch (error) {
      setVoiceStatus(error?.message || 'Could not queue voices.')
    }
  }

  const queueKeyframes = async () => {
    const plan = shotPlan.length > 0
      ? shotPlan
      : createShotPlan({ screenplay: draft.screenplay, characters, locations, runtimeSeconds: draft.runtimeSeconds })

    if (plan.length === 0) {
      setKeyframeStatus('Generate or refresh the shot plan before creating keyframes.')
      return
    }

    if (typeof onQueueKeyframes !== 'function') {
      setKeyframeStatus('Keyframe queue is not available in this build yet.')
      return
    }

    setKeyframeStatus('Queueing short-film keyframes...')
    try {
      const result = await onQueueKeyframes({
        title: draft.title,
        keyframeWorkflow: draft.keyframeWorkflow,
        shotPlan: plan,
        characters,
        locations,
        resolution: outputResolution,
        fps: draft.videoFps,
      })
      setKeyframeStatus(result?.message || 'Keyframe queue updated.')
    } catch (error) {
      setKeyframeStatus(error?.message || 'Could not queue keyframes.')
    }
  }

  const queueVideos = async () => {
    const plan = shotPlan.length > 0
      ? shotPlan
      : createShotPlan({ screenplay: draft.screenplay, characters, locations, runtimeSeconds: draft.runtimeSeconds })

    if (plan.length === 0) {
      setVideoStatus('Generate or refresh the shot plan before creating videos.')
      return
    }

    if (typeof onQueueVideos !== 'function') {
      setVideoStatus('Video queue is not available in this build yet.')
      return
    }

    setVideoStatus('Queueing short-film video shots...')
    try {
      const result = await onQueueVideos({
        title: draft.title,
        shotPlan: plan,
        dialogueLines,
        characters,
        locations,
        resolution: outputResolution,
        fps: draft.videoFps,
      })
      setVideoStatus(result?.message || 'Video queue updated.')
    } catch (error) {
      setVideoStatus(error?.message || 'Could not queue videos.')
    }
  }

  const getShortFilmShotContext = (shot) => {
    const dialogue = shot?.dialogueId ? dialogueLines.find((entry) => entry.id === shot.dialogueId) : null
    const character = characters.find((entry) => entry.slug === (shot?.characterSlug || dialogue?.slug)) || null
    const location = locations.find((entry) => entry.slug === shot?.locationSlug) || null
    const voiceAsset = shot?.dialogueId ? voiceAssetByDialogueId.get(String(shot.dialogueId)) : null
    return {
      dialogue,
      character,
      location,
      voiceAsset,
      usesAudio: Boolean(voiceAsset),
    }
  }

  const getDefaultVideoPrompt = (shot) => {
    const context = getShortFilmShotContext(shot)
    return buildShortFilmVideoPrompt({
      title: draft.title,
      shot,
      character: context.character,
      location: context.location,
      dialogue: context.dialogue,
      usesAudio: context.usesAudio,
    })
  }

  const getEditableVideoPrompt = (shot) => {
    const shotId = String(shot?.id || '')
    if (shotId && Object.prototype.hasOwnProperty.call(videoPromptOverrides, shotId)) {
      return videoPromptOverrides[shotId]
    }
    return getDefaultVideoPrompt(shot)
  }

  const updateVideoPromptOverride = (shotId, value) => {
    const normalizedShotId = String(shotId || '')
    if (!normalizedShotId) return
    setVideoPromptOverrides((prev) => ({
      ...prev,
      [normalizedShotId]: value,
    }))
  }

  const resetVideoPromptOverride = (shot) => {
    const shotId = String(shot?.id || '')
    if (!shotId) return
    setVideoPromptOverrides((prev) => {
      const next = { ...prev }
      delete next[shotId]
      return next
    })
  }

  const queueSelectedVideo = async (shot) => {
    if (!shot) return
    const plan = shotPlan.length > 0
      ? shotPlan
      : createShotPlan({ screenplay: draft.screenplay, characters, locations, runtimeSeconds: draft.runtimeSeconds })
    const shotId = String(shot.id || '')
    if (!shotId) return
    setVideoStatus(`Queueing rerun for ${shot.title || shotId}...`)
    try {
      const result = await onQueueVideos?.({
        title: draft.title,
        shotPlan: plan,
        dialogueLines,
        characters,
        locations,
        resolution: outputResolution,
        fps: draft.videoFps,
        shotIds: [shotId],
        promptOverrides: { [shotId]: getEditableVideoPrompt(shot) },
        force: true,
      })
      setVideoStatus(result?.message || 'Selected shot queued.')
    } catch (error) {
      setVideoStatus(error?.message || 'Could not queue selected shot.')
    }
  }

  const renderStoryStep = () => (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sf-text-primary">Define the short film.</h2>
        <p className="mt-1 text-sm text-sf-text-secondary">
          This builds the LLM brief. After the script exists, the script becomes the source of truth.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <FieldLabel>Title</FieldLabel>
          <input
            value={draft.title}
            onChange={(event) => updateDraft({ title: event.target.value })}
            className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sm text-sf-text-primary outline-none focus:border-sf-accent"
          />
          <div className="mt-3">
            <FieldLabel>Premise</FieldLabel>
            <textarea
              value={draft.premise}
              onChange={(event) => updateDraft({ premise: event.target.value })}
              rows={5}
              className="mt-1 w-full resize-none rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sm text-sf-text-primary outline-none focus:border-sf-accent"
            />
          </div>
        </div>

        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <FieldLabel>Creative direction</FieldLabel>
          <textarea
            value={draft.creativeDirection}
            onChange={(event) => updateDraft({ creativeDirection: event.target.value })}
            rows={6}
            className="mt-1 w-full resize-none rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sm text-sf-text-primary outline-none focus:border-sf-accent"
          />
          <p className="mt-2 text-xs text-sf-text-muted">
            Tone, genre, pacing, and style live here so the LLM has direction before it writes the actual script.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <FieldLabel>Runtime</FieldLabel>
            <input
              type="number"
              value={draft.runtimeSeconds}
              min={15}
              max={600}
              onChange={(event) => updateDraft({ runtimeSeconds: Number(event.target.value) || 60 })}
              className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sm text-sf-text-primary outline-none focus:border-sf-accent"
            />
          </div>
          <div>
            <FieldLabel>Aspect ratio</FieldLabel>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {ASPECT_RATIO_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => updateDraft({ aspectRatio: option.id })}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${buttonClass(draft.aspectRatio === option.id)}`}
                  title={option.helper}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>Resolution</FieldLabel>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {RESOLUTION_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => updateDraft({ resolutionPreset: option.id })}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${buttonClass(draft.resolutionPreset === option.id)}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>FPS</FieldLabel>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {FPS_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => updateDraft({ videoFps: option })}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${buttonClass(draft.videoFps === option)}`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-secondary">
          Output will be prepared as <span className="font-semibold text-sf-text-primary">{outputResolutionLabel}</span> at <span className="font-semibold text-sf-text-primary">{draft.videoFps}fps</span>.
        </div>
      </div>
    </div>
  )

  const renderCharactersStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-sf-text-primary">Cast characters.</h2>
          <p className="mt-1 text-sm text-sf-text-secondary">
            Character slugs keep faces, wardrobe, dialogue, and voice profiles connected.
          </p>
        </div>
        <button
          type="button"
          onClick={addCharacter}
          className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
        >
          <UserPlusIcon />
          Add Character
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {characters.map((character) => {
          const refAsset = imageAssets.find((asset) => asset.id === character.referenceAssetId)
          return (
            <div key={character.id} className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <FieldLabel>Character</FieldLabel>
                  <input
                    value={character.name}
                    onChange={(event) => updateCharacter(character.id, { name: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sm font-semibold text-sf-text-primary outline-none focus:border-sf-accent"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeCharacter(character.id)}
                  className="rounded-lg border border-sf-dark-700 p-2 text-sf-text-muted hover:border-red-500/60 hover:text-red-300"
                  disabled={characters.length <= 1}
                  title="Remove character"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel>Slug</FieldLabel>
                  <input
                    value={character.slug}
                    onChange={(event) => updateCharacter(character.id, { slug: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                  />
                </div>
                <div>
                  <FieldLabel>Role</FieldLabel>
                  <input
                    value={character.role}
                    onChange={(event) => updateCharacter(character.id, { role: event.target.value })}
                    className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                  />
                </div>
              </div>
              <div className="mt-3">
                <FieldLabel>Visual notes</FieldLabel>
                <textarea
                  value={character.visualNotes}
                  onChange={(event) => updateCharacter(character.id, { visualNotes: event.target.value })}
                  rows={3}
                  className="mt-1 w-full resize-none rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                />
              </div>
              <div className="mt-3 space-y-3">
                <ReferencePreview asset={refAsset} />
                <div>
                  <FieldLabel>Face / wardrobe reference</FieldLabel>
                  <AssetSelect
                    value={character.referenceAssetId}
                    onChange={(value) => updateCharacter(character.id, { referenceAssetId: value })}
                    assets={imageAssets}
                    placeholder="Choose character image"
                  />
                  <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <div>
                      <FieldLabel>Voice preset</FieldLabel>
                      <select
                        value={character.voicePreset}
                        onChange={(event) => updateCharacter(character.id, { voicePreset: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      >
                        {character.voicePreset && !ELEVENLABS_VOICE_OPTIONS.includes(character.voicePreset) && (
                          <option value={character.voicePreset}>{character.voicePreset}</option>
                        )}
                        {ELEVENLABS_VOICE_OPTIONS.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-[10px] text-sf-text-muted">Matches the bundled ElevenLabs voice selector.</p>
                    </div>
                    <div>
                      <FieldLabel>Voice notes</FieldLabel>
                      <input
                        value={character.voiceNotes}
                        onChange={(event) => updateCharacter(character.id, { voiceNotes: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const renderLocationsStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-sf-text-primary">Build location sheets.</h2>
          <p className="mt-1 text-sm text-sf-text-secondary">
            Each location can carry reference angles so keyframes stay in the same world.
          </p>
        </div>
        <button
          type="button"
          onClick={addLocation}
          className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
        >
          <Plus className="h-4 w-4" />
          Add Location
        </button>
      </div>

      <div className="space-y-3">
        {locations.map((location) => {
          const refs = [
            ['heroAssetId', 'Hero'],
            ['wideAssetId', 'Wide'],
            ['reverseAssetId', 'Reverse'],
            ['detailAssetId', 'Detail'],
          ]
          return (
            <div key={location.id} className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[0.9fr_0.7fr]">
                  <div>
                    <FieldLabel>Location name</FieldLabel>
                    <input
                      value={location.name}
                      onChange={(event) => updateLocation(location.id, { name: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sm font-semibold text-sf-text-primary outline-none focus:border-sf-accent"
                    />
                  </div>
                  <div>
                    <FieldLabel>Slug</FieldLabel>
                    <input
                      value={location.slug}
                      onChange={(event) => updateLocation(location.id, { slug: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeLocation(location.id)}
                  className="rounded-lg border border-sf-dark-700 p-2 text-sf-text-muted hover:border-red-500/60 hover:text-red-300"
                  disabled={locations.length <= 1}
                  title="Remove location"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3">
                <FieldLabel>Continuity description</FieldLabel>
                <textarea
                  value={location.description}
                  onChange={(event) => updateLocation(location.id, { description: event.target.value })}
                  rows={3}
                  className="mt-1 w-full resize-none rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {refs.map(([fieldId, label]) => {
                  const asset = imageAssets.find((entry) => entry.id === location[fieldId])
                  return (
                    <div key={fieldId}>
                      <ReferencePreview asset={asset} />
                      <div className="mt-2">
                        <FieldLabel>{label} reference</FieldLabel>
                        <AssetSelect
                          value={location[fieldId]}
                          onChange={(value) => updateLocation(location.id, { [fieldId]: value })}
                          assets={imageAssets}
                          placeholder={`Choose ${label.toLowerCase()} image`}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const renderScriptStep = () => (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sf-text-primary">Write or paste the script.</h2>
        <p className="mt-1 text-sm text-sf-text-secondary">
          Copy the brief into an LLM, paste the returned screenplay here, then generate a coverage review.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-sf-text-primary">LLM brief</h3>
              <p className="mt-1 text-xs text-sf-text-muted">Includes premise, creative direction, cast, locations, and required format.</p>
            </div>
            <button
              type="button"
              onClick={copyBrief}
              className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
            >
              <Clipboard className="h-4 w-4" />
              Copy Brief
            </button>
          </div>
          {briefStatus && <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-secondary">{briefStatus}</div>}
          <textarea
            readOnly
            value={llmBrief}
            rows={18}
            className="mt-3 w-full resize-none rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-sf-text-primary outline-none"
          />
        </div>
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-sf-text-primary">Screenplay / director script</h3>
              <p className="mt-1 text-xs text-sf-text-muted">This becomes the source of truth for voices, shots, keyframes, and assembly.</p>
            </div>
            <button
              type="button"
              onClick={generateShotPlan}
              className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
            >
              <Wand2 className="h-4 w-4" />
              Generate Shot Plan
            </button>
          </div>
          <textarea
            value={draft.screenplay}
            onChange={(event) => updateDraft({ screenplay: event.target.value })}
            rows={22}
            className="mt-3 w-full resize-none rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 font-mono text-xs leading-relaxed text-sf-text-primary outline-none focus:border-sf-accent"
          />
        </div>
      </div>
    </div>
  )

  const renderVoicesStep = () => (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sf-text-primary">Generate character voices.</h2>
        <p className="mt-1 text-sm text-sf-text-secondary">
          Dialogue lines are routed through each character voice profile. Text to Speech creates one editable audio clip per line.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <FieldLabel>Audio workflow</FieldLabel>
          <div className="mt-2 space-y-2">
            {VOICE_WORKFLOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => updateDraft({ voiceWorkflow: option.id })}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${buttonClass(draft.voiceWorkflow === option.id)}`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Volume2 className="h-4 w-4 text-sf-accent" />
                  {option.label}
                </div>
                <div className="mt-1 text-xs text-sf-text-muted">{option.helper}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
            Text to Speech is wired to the ElevenLabs ComfyUI workflow. The other voice modes are placeholders for later.
          </div>
        </div>

        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-sf-text-primary">Dialogue lines</h3>
              <p className="mt-1 text-xs text-sf-text-muted">{dialogueLines.length} detected line{dialogueLines.length === 1 ? '' : 's'} from the script.</p>
            </div>
            <button
              type="button"
              onClick={queueVoices}
              className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs font-semibold text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary"
            >
              <Mic className="h-4 w-4" />
              Queue Voices
            </button>
          </div>
          {voiceStatus && <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-secondary">{voiceStatus}</div>}
          <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
            {dialogueLines.length === 0 ? (
              <div className="rounded-lg border border-dashed border-sf-dark-600 bg-sf-dark-950 px-3 py-6 text-center text-xs text-sf-text-muted">
                No dialogue detected yet. Use CHARACTER: "line" or screenplay speaker blocks.
              </div>
            ) : dialogueLines.map((line, index) => {
              const character = characters.find((entry) => entry.slug === line.slug)
              const voiceJob = voiceJobByDialogueId.get(line.id)
              const voiceJobLabel = voiceJob?.status === 'done'
                ? 'voice ready'
                : voiceJob?.status === 'error'
                  ? 'failed'
                  : voiceJob?.status
                    ? voiceJob.status
                    : ''
              const voiceJobClass = voiceJob?.status === 'done'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : voiceJob?.status === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-200'
                  : 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
              return (
                <div key={line.id} className="rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-sf-text-primary">{index + 1}. {line.speaker}</div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {voiceJobLabel && (
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${voiceJobClass}`}>
                          {voiceJobLabel}
                        </span>
                      )}
                      <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-[10px] text-sf-text-muted">{character?.voicePreset || currentVoiceWorkflow.label}</span>
                    </div>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-sf-text-secondary">"{line.text}"</p>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )

  const renderShotPlanStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-sf-text-primary">Review visual coverage.</h2>
          <p className="mt-1 text-sm text-sf-text-secondary">
            This is the script as a production checklist: wides, close-ups, reactions, inserts, and cutaways.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={clearShotPlan}
            disabled={shotPlan.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs font-semibold text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
            Clear Plan
          </button>
          <button
            type="button"
            onClick={generateShotPlan}
            className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
          >
            <Wand2 className="h-4 w-4" />
            Rebuild From Script
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Stat label="Planned shots" value={shotPlan.length || 0} />
        <Stat label="Dialogue lines" value={dialogueLines.length || 0} />
        <Stat label="Locations" value={locations.length || 0} />
      </div>

      <div className="space-y-2">
        {shotPlan.length === 0 ? (
          <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-900/80 px-4 py-8 text-center text-sm text-sf-text-muted">
            Generate a shot plan after pasting the screenplay.
          </div>
        ) : shotPlan.map((shot, index) => {
          const location = locations.find((entry) => entry.slug === shot.locationSlug)
          const character = characters.find((entry) => entry.slug === shot.characterSlug)
          const dialogue = dialogueLines.find((entry) => entry.id === shot.dialogueId)
          const isEditing = editingShotId === shot.id
          return (
            <div key={shot.id} className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-sf-text-muted">Shot {index + 1} / {shot.scene}</div>
                  <h3 className="mt-1 font-semibold text-sf-text-primary">{shot.title}</h3>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                    <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-sf-text-muted">{shot.type}</span>
                    <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-sf-text-muted">{location?.name || shot.locationSlug}</span>
                    <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-sf-text-muted">{shot.duration}s</span>
                    {character && <span className="rounded-full border border-sf-accent/50 px-2 py-0.5 text-sf-accent">{character.name}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingShotId(isEditing ? '' : shot.id)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {isEditing ? 'Done' : 'Edit'}
                </button>
              </div>
              {isEditing && (
                <div className="mt-4 border-t border-sf-dark-700 pt-4">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label className="block">
                      <FieldLabel>Shot title</FieldLabel>
                      <input
                        value={shot.title || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { title: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Shot type</FieldLabel>
                      <input
                        value={shot.type || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { type: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Duration</FieldLabel>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={shot.duration || 4}
                        onChange={(event) => updateShotPlanShot(shot.id, { duration: Math.max(1, Math.min(30, Number(event.target.value) || 1)) })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Location</FieldLabel>
                      <select
                        value={shot.locationSlug || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { locationSlug: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      >
                        {locations.map((entry) => (
                          <option key={entry.slug} value={entry.slug}>{entry.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="block">
                      <FieldLabel>Character reference</FieldLabel>
                      <select
                        value={shot.characterSlug || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { characterSlug: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      >
                        <option value="">No specific character</option>
                        {characters.map((entry) => (
                          <option key={entry.slug} value={entry.slug}>{entry.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <FieldLabel>Dialogue audio</FieldLabel>
                      <select
                        value={shot.dialogueId || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { dialogueId: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      >
                        <option value="">No dialogue audio</option>
                        {dialogueLines.map((line) => (
                          <option key={line.id} value={line.id}>{line.speaker}: {line.text}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <label className="block">
                      <FieldLabel>Keyframe prompt</FieldLabel>
                      <textarea
                        value={shot.keyframe || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { keyframe: event.target.value })}
                        rows={5}
                        className="mt-1 w-full resize-y rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs leading-relaxed text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Motion prompt</FieldLabel>
                      <textarea
                        value={shot.motion || ''}
                        onChange={(event) => updateShotPlanShot(shot.id, { motion: event.target.value })}
                        rows={5}
                        className="mt-1 w-full resize-y rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-xs leading-relaxed text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </label>
                  </div>
                </div>
              )}
              {dialogue && <p className="mt-3 text-xs text-sf-text-secondary">Dialogue audio: "{dialogue.text}"</p>}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3">
                  <FieldLabel>Keyframe prompt</FieldLabel>
                  <p className="mt-1 text-xs leading-relaxed text-sf-text-secondary">{shot.keyframe}</p>
                </div>
                <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3">
                  <FieldLabel>Motion prompt</FieldLabel>
                  <p className="mt-1 text-xs leading-relaxed text-sf-text-secondary">{shot.motion}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const renderKeyframesStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-sf-text-primary">Create keyframes.</h2>
          <p className="mt-1 text-sm text-sf-text-secondary">
            Each approved shot gets one starting image using character refs plus location sheet refs.
          </p>
        </div>
        <button
          type="button"
          onClick={queueKeyframes}
          className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
        >
          <Wand2 className="h-4 w-4" />
          Create Keyframes
        </button>
      </div>

      <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
        <FieldLabel>Keyframe renderer</FieldLabel>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {SHORT_FILM_KEYFRAME_WORKFLOW_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => updateDraft({ keyframeWorkflow: option.id })}
              className={`rounded-lg border p-3 text-left transition-colors ${buttonClass(draft.keyframeWorkflow === option.id)}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-sf-text-primary">{option.label}</div>
                <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-[10px] text-sf-text-muted">{option.runtimeLabel}</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-sf-text-muted">{option.description}</p>
            </button>
          ))}
        </div>
      </div>

      {keyframeStatus && (
        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950 px-4 py-3 text-sm text-sf-text-secondary">
          {keyframeStatus}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(shotPlan.length > 0 ? shotPlan : createShotPlan({ screenplay: draft.screenplay, characters, locations, runtimeSeconds: draft.runtimeSeconds }).slice(0, 6)).map((shot, index) => {
          const keyframeJob = keyframeJobByShotId.get(shot.id)
          const keyframeAsset = keyframeAssetByShotId.get(shot.id)
          const label = keyframeAsset || keyframeJob?.status === 'done'
            ? 'ready'
            : keyframeJob?.status === 'error'
              ? 'failed'
              : keyframeJob?.status || 'pending'
          const labelClass = label === 'ready'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            : label === 'failed'
              ? 'border-red-500/40 bg-red-500/10 text-red-200'
              : label === 'pending'
                ? 'border-sf-dark-600 text-sf-text-muted'
                : 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
          const keyframeAssetUrl = getAssetUrl(keyframeAsset)
          return (
            <div key={shot.id || index} className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-sf-text-primary">Shot {index + 1}</div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] ${labelClass}`}>{label}</span>
              </div>
              {keyframeAssetUrl && (
                <div className="mt-3 aspect-video overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950">
                  <img src={keyframeAssetUrl} alt={getAssetName(keyframeAsset)} className="h-full w-full object-cover" />
                </div>
              )}
              <p className="mt-2 text-xs leading-relaxed text-sf-text-secondary">{shot.keyframe}</p>
            </div>
          )
        })}
      </div>
    </div>
  )

  const renderVideosStep = () => {
    const plan = shotPlan.length > 0
      ? shotPlan
      : createShotPlan({ screenplay: draft.screenplay, characters, locations, runtimeSeconds: draft.runtimeSeconds })
    const readyCount = plan.filter((shot) => (
      videoAssetByShotId.get(shot.id) || videoJobByShotId.get(shot.id)?.status === 'done'
    )).length
    const selectedShot = plan.find((shot) => shot.id === selectedVideoShotId) || plan[0] || null
    const selectedShotIndex = selectedShot ? Math.max(0, plan.findIndex((shot) => shot.id === selectedShot.id)) : -1
    const selectedShotContext = selectedShot ? getShortFilmShotContext(selectedShot) : null
    const selectedKeyframeAsset = selectedShot ? keyframeAssetByShotId.get(selectedShot.id) : null
    const selectedNeedsVoice = Boolean(selectedShot?.dialogueId && !selectedShotContext?.voiceAsset)
    const selectedPrompt = selectedShot ? getEditableVideoPrompt(selectedShot) : ''
    const selectedHasCustomPrompt = Boolean(selectedShot?.id && Object.prototype.hasOwnProperty.call(videoPromptOverrides, selectedShot.id))

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-sf-text-primary">Generate shot videos.</h2>
            <p className="mt-1 text-sm text-sf-text-secondary">
              LTX 2.3 uses each approved keyframe as the first frame. Dialogue shots use the matching generated voice clip when it exists.
            </p>
          </div>
          <button
            type="button"
            onClick={queueVideos}
            className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90"
          >
            <Play className="h-4 w-4" />
            Queue Videos
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <Stat label="Video model" value="LTX 2.3" />
          <Stat label="Ready videos" value={`${readyCount}/${plan.length || 0}`} />
          <Stat label="FPS" value={draft.videoFps} />
        </div>

        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <FieldLabel>Video render size</FieldLabel>
              <div className="mt-1 text-sm font-semibold text-sf-text-primary">{outputResolutionLabel}</div>
              <p className="mt-1 text-xs text-sf-text-muted">
                New LTX 2.3 video jobs use this size. Use 720p for speed, 1080p for cleaner final shots.
              </p>
            </div>
            <div className="grid min-w-[220px] grid-cols-2 gap-2">
              {RESOLUTION_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => updateDraft({ resolutionPreset: option.id })}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(draft.resolutionPreset === option.id)}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {videoStatus && (
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950 px-4 py-3 text-sm text-sf-text-secondary">
            {videoStatus}
          </div>
        )}

        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
          <div className="flex items-center gap-2 font-semibold text-sf-text-primary">
            <CheckCircle2 className="h-4 w-4 text-sf-accent" />
            Routing principle
          </div>
          <p className="mt-2 text-sm leading-relaxed text-sf-text-secondary">
            Silent shots queue as LTX 2.3 image-to-video. Dialogue shots queue as LTX 2.3 image-and-audio-to-video once their voice clips are ready.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {plan.map((shot, index) => {
            const keyframeAsset = keyframeAssetByShotId.get(shot.id)
            const voiceAsset = shot.dialogueId ? voiceAssetByDialogueId.get(String(shot.dialogueId)) : null
            const videoJob = videoJobByShotId.get(shot.id)
            const videoAsset = videoAssetByShotId.get(shot.id)
            const isSelected = selectedShot?.id === shot.id
            const label = (videoAsset || videoJob?.status === 'done')
              ? 'ready'
              : videoJob?.status === 'error'
                ? 'failed'
                : videoJob?.status || (keyframeAsset ? 'pending' : 'needs keyframe')
            const labelClass = label === 'ready'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : label === 'failed'
                ? 'border-red-500/40 bg-red-500/10 text-red-200'
                : label === 'needs keyframe'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  : label === 'pending'
                    ? 'border-sf-dark-600 text-sf-text-muted'
                    : 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
            const keyframeUrl = getAssetUrl(keyframeAsset)
            const videoUrl = getAssetUrl(videoAsset)
            return (
              <div
                key={shot.id || index}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedVideoShotId(shot.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedVideoShotId(shot.id)
                  }
                }}
                className={`cursor-pointer rounded-xl border p-4 transition-colors ${
                  isSelected
                    ? 'border-sf-accent bg-sf-accent/10'
                    : 'border-sf-dark-700 bg-sf-dark-900/80 hover:border-sf-dark-500'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.title}</div>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${labelClass}`}>{label}</span>
                </div>
                {(videoUrl || keyframeUrl) && (
                  <div className="mt-3 aspect-video overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950">
                    {videoUrl ? (
                      <video src={videoUrl} className="h-full w-full object-cover" muted playsInline controls />
                    ) : (
                      <img src={keyframeUrl} alt={getAssetName(keyframeAsset)} className="h-full w-full object-cover" />
                    )}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-sf-text-muted">{shot.duration || 4}s</span>
                  <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 text-sf-text-muted">{shot.type || 'shot'}</span>
                  {shot.dialogueId && (
                    <span className={`rounded-full border px-2 py-0.5 ${voiceAsset ? 'border-emerald-500/40 text-emerald-200' : 'border-amber-500/40 text-amber-200'}`}>
                      {voiceAsset ? 'voice ready' : 'needs voice'}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-sf-text-secondary">{shot.motion}</p>
              </div>
            )
          })}
        </div>

        {selectedShot && (
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
              Not happy with a short-film shot? Select it above, edit the full video prompt here, then rerun just that shot as an alternate take.
            </div>
            <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-sf-text-primary">
                  Shot {selectedShotIndex + 1}: {selectedShot.title || selectedShot.id}
                </h3>
                <div className="mt-1 text-[10px] text-sf-text-muted">
                  {[
                    selectedShotContext?.usesAudio ? 'Dialogue LTX 2.3' : 'LTX 2.3',
                    outputResolutionLabel,
                    `${draft.videoFps} fps`,
                    `${selectedShot.duration || 4}s`,
                    selectedShot.type,
                  ].filter(Boolean).join(' / ')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => queueSelectedVideo(selectedShot)}
                disabled={!selectedKeyframeAsset || selectedNeedsVoice || typeof onQueueVideos !== 'function'}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Run Selected Shot
              </button>
            </div>
            {(!selectedKeyframeAsset || selectedNeedsVoice) && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {!selectedKeyframeAsset
                  ? 'This shot needs a keyframe before video can run.'
                  : 'This dialogue shot needs its generated voice clip before video can run.'}
              </div>
            )}
            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_280px]">
              <label className="block text-xs text-sf-text-secondary">
                <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Edit full video prompt</span>
                <textarea
                  value={selectedPrompt}
                  onChange={(event) => updateVideoPromptOverride(selectedShot.id, event.target.value)}
                  rows={9}
                  className="mt-2 w-full resize-y rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 font-mono text-xs leading-relaxed text-sf-text-primary outline-none focus:border-sf-accent"
                  placeholder="Describe the exact visual motion, speech, and sound for this one rerun..."
                />
              </label>
              <div className="space-y-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3 text-xs text-sf-text-secondary">
                <div>
                  <FieldLabel>Shot info</FieldLabel>
                  <div className="mt-2 space-y-1">
                    <div>Keyframe: {selectedKeyframeAsset ? 'ready' : 'missing'}</div>
                    {selectedShot.dialogueId && <div>Voice: {selectedShotContext?.voiceAsset ? 'ready' : 'missing'}</div>}
                    {selectedShotContext?.dialogue?.text && (
                      <div className="italic text-sf-text-muted">"{selectedShotContext.dialogue.text}"</div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => resetVideoPromptOverride(selectedShot)}
                  disabled={!selectedHasCustomPrompt}
                  className="w-full rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Reset To Default Prompt
                </button>
                <p className="text-[11px] leading-relaxed text-sf-text-muted">
                  This does not rewrite the screenplay or shot plan. It only changes the next render queued from this selected-shot panel.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderAssembleStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-sf-text-primary">Assemble the edit.</h2>
          <p className="mt-1 text-sm text-sf-text-secondary">
            When implemented, this creates a named timeline with picture, dialogue, ambience, and sound effect tracks.
          </p>
        </div>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-3 py-2 text-xs font-semibold text-sf-text-muted"
        >
          <Layers className="h-4 w-4" />
          Assemble Edit
        </button>
      </div>
      <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
        <div className="space-y-3">
          {[
            ['Picture', shotPlan.length || 8, 'bg-sf-accent/30 border-sf-accent/40'],
            ['VO - James', dialogueLines.filter((line) => line.slug === 'james').length || 2, 'bg-emerald-500/20 border-emerald-400/40'],
            ['VO - Mara', dialogueLines.filter((line) => line.slug === 'mara').length || 2, 'bg-pink-500/20 border-pink-400/40'],
            ['Room Tone / SFX', 4, 'bg-amber-500/20 border-amber-400/40'],
          ].map(([label, count, className]) => (
            <div key={label} className="grid grid-cols-[120px_1fr] items-center gap-3">
              <div className="text-xs font-semibold text-sf-text-secondary">{label}</div>
              <div className="flex gap-1 overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-1">
                {Array.from({ length: Number(count) || 1 }).map((_, index) => (
                  <div
                    key={index}
                    className={`h-7 min-w-[44px] rounded border ${className}`}
                    style={{ width: `${48 + ((index % 3) * 18)}px` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  const renderCurrentStep = () => {
    if (draft.step === 'story') return renderStoryStep()
    if (draft.step === 'characters') return renderCharactersStep()
    if (draft.step === 'locations') return renderLocationsStep()
    if (draft.step === 'script') return renderScriptStep()
    if (draft.step === 'voices') return renderVoicesStep()
    if (draft.step === 'shotPlan') return renderShotPlanStep()
    if (draft.step === 'keyframes') return renderKeyframesStep()
    if (draft.step === 'videos') return renderVideosStep()
    return renderAssembleStep()
  }

  return (
    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950">
      <div className="border-b border-sf-dark-700 p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {STEPS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => updateDraft({ step: entry.id })}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                draft.step === entry.id
                  ? 'border-sf-accent bg-sf-accent/20 text-sf-text-primary'
                  : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
              }`}
            >
              <div className="text-[10px] uppercase tracking-wide text-sf-text-muted">Step {entry.number}</div>
              <div className="mt-1 text-xs font-semibold">{entry.label}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1fr_320px]">
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={goBack}
              disabled={currentStepIndex <= 0}
              className="rounded-lg border border-sf-dark-700 px-3 py-2 text-xs font-semibold text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={currentStepIndex >= STEPS.length - 1}
              className="rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white hover:bg-sf-accent/90 disabled:opacity-40"
            >
              Next
            </button>
          </div>
          {renderCurrentStep()}
        </div>

        <aside className="border-t border-sf-dark-700 p-5 lg:border-l lg:border-t-0">
          <div className="space-y-3">
            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <h3 className="text-sm font-semibold text-sf-text-primary">Current concept</h3>
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between gap-3"><span className="text-sf-text-muted">TITLE</span><span className="text-right text-sf-text-secondary">{draft.title}</span></div>
                <div className="flex justify-between gap-3"><span className="text-sf-text-muted">CAST</span><span className="text-right text-sf-text-secondary">{characters.length} character{characters.length === 1 ? '' : 's'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-sf-text-muted">LOCATIONS</span><span className="text-right text-sf-text-secondary">{locations.length} location{locations.length === 1 ? '' : 's'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-sf-text-muted">VOICES</span><span className="text-right text-sf-text-secondary">{currentVoiceWorkflow.label}</span></div>
                <div className="flex justify-between gap-3"><span className="text-sf-text-muted">OUTPUT</span><span className="text-right text-sf-text-secondary">{outputResolutionLabel} · {draft.videoFps}fps</span></div>
              </div>
            </div>

            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <h3 className="text-sm font-semibold text-sf-text-primary">Working principle</h3>
              <p className="mt-2 text-xs leading-relaxed text-sf-text-muted">
                The script drives story, dialogue, timing, and shot choice. Characters provide faces and voices. Location sheets provide the visual world memory.
              </p>
            </div>

            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <h3 className="text-sm font-semibold text-sf-text-primary">Model routing</h3>
              <div className="mt-3 space-y-2">
                <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-sf-text-primary">
                    <Film className="h-3.5 w-3.5 text-sf-accent" />
                    LTX 2.3
                  </div>
                  <p className="mt-1 text-[11px] text-sf-text-muted">Default for short generated video shots.</p>
                </div>
                <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-sf-text-primary">
                    <Mic className="h-3.5 w-3.5 text-emerald-400" />
                    Comfy ElevenLabs
                  </div>
                  <p className="mt-1 text-[11px] text-sf-text-muted">Text-to-speech dialogue clips through the bundled ElevenLabs ComfyUI workflow.</p>
                </div>
                <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-sf-text-primary">
                    <MapPin className="h-3.5 w-3.5 text-amber-300" />
                    Location sheets
                  </div>
                  <p className="mt-1 text-[11px] text-sf-text-muted">Reference images for consistent spaces and angles.</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/80 p-4">
              <h3 className="text-sm font-semibold text-sf-text-primary">Open implementation notes</h3>
              <p className="mt-2 text-xs leading-relaxed text-sf-text-muted">
                Voices, keyframes, and video renders are wired. Timeline assembly is the next pass.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function UserPlusIcon() {
  return <Plus className="h-4 w-4" />
}
