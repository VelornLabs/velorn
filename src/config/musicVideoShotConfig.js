/**
 * Music-video shot configuration.
 *
 * This is the shared contract between Director Mode (which plans the shot list)
 * and the ComfyUI workflow modifier (which turns a planned shot into node inputs).
 *
 * Shape kept intentionally close to topazVideoUpscaleConfig so the same plumbing
 * (registry / gallery / dependency packs) recognizes it.
 */

export const MUSIC_VIDEO_SHOT_WORKFLOW_ID = 'music-video-shot-ltx23'
export const VOCAL_EXTRACT_WORKFLOW_ID = 'vocal-extract-melband'

/**
 * Shot-type taxonomy.
 *
 * Director Mode's planner tags every shot with exactly one shot_type.
 * The workflow modifier uses it to flip LoRA on/off flags, nudge the prompt
 * suffix, and decide whether the shot needs to sit on a vocal beat.
 */
export const MUSIC_VIDEO_SHOT_TYPE_OPTIONS = Object.freeze([
  {
    id: 'performance',
    label: 'Performance (close)',
    description: 'Singer visible, lip-syncing, vocals critical. Talking-head LoRA on.',
    talkingHeadLoraOn: true,
    talkingHeadLoraStrength: 0.5,
    cameraLoraOn: false,
    cameraLoraStrength: 0.3,
    defaultImageStrength: 0.8,
    promptSuffix: 'The artist performs, lip-syncing naturally to the attached vocals. Believable facial performance.',
    needsVocalAlignment: true,
  },
  {
    id: 'performance_wide',
    label: 'Performance (wide)',
    description: 'Singer visible at distance. Looser lip-sync. Talking-head LoRA softer.',
    talkingHeadLoraOn: true,
    talkingHeadLoraStrength: 0.3,
    cameraLoraOn: false,
    cameraLoraStrength: 0.3,
    defaultImageStrength: 0.82,
    promptSuffix: 'The artist performs in a wider shot, natural body motion, lip-sync present but not emphasized.',
    needsVocalAlignment: true,
  },
  {
    id: 'b_roll',
    label: 'B-roll / cutaway',
    description: 'Environment, objects, or non-performer subjects. No lip-sync needed.',
    talkingHeadLoraOn: false,
    talkingHeadLoraStrength: 0,
    cameraLoraOn: false,
    cameraLoraStrength: 0.3,
    defaultImageStrength: 0.92,
    promptSuffix: 'B-roll cutaway. Focus on the environment, action, or objects described in the director script.',
    needsVocalAlignment: false,
  },
])

/**
 * Creative presets surfaced in Director Mode so the user doesn't face a blank page.
 * Each preset seeds default shot-type distribution, b-roll ratio, and average shot length.
 */
export const MUSIC_VIDEO_CREATIVE_PRESETS = Object.freeze([
  {
    id: 'performance',
    label: 'Performance',
    description: 'Mostly the artist performing. Minimal narrative. Stage / studio / abstract environments.',
    bRollRatio: 0.15,
    performanceWideRatio: 0.2,
    avgShotLengthSeconds: 3.5,
    narrativeIntensity: 10,
    requiresConcept: false,
  },
  {
    id: 'narrative',
    label: 'Narrative',
    description: 'Story-driven. Needs a concept sentence. Mix of performance shots woven into the story.',
    bRollRatio: 0.4,
    performanceWideRatio: 0.25,
    avgShotLengthSeconds: 3,
    narrativeIntensity: 75,
    requiresConcept: true,
  },
  {
    id: 'vibes',
    label: 'Vibes',
    description: 'Abstract / moody. Heavy on locations and texture. Minimal narrative.',
    bRollRatio: 0.7,
    performanceWideRatio: 0.2,
    avgShotLengthSeconds: 3.5,
    narrativeIntensity: 20,
    requiresConcept: false,
  },
  {
    id: 'tour_diary',
    label: 'Tour diary',
    description: 'Candid / observational / handheld aesthetic. Mixed locations and moments.',
    bRollRatio: 0.5,
    performanceWideRatio: 0.3,
    avgShotLengthSeconds: 2.5,
    narrativeIntensity: 30,
    requiresConcept: false,
  },
])

export const MUSIC_VIDEO_CAMERA_MOVE_OPTIONS = Object.freeze([
  { id: 'locked', label: 'Locked-off', scriptLine: 'Camera: Locked-off tripod frame, minimal movement.' },
  { id: 'push-in', label: 'Push in', scriptLine: 'Camera: Slow push-in toward the subject, shallow focus.' },
  { id: 'pull-out', label: 'Pull out', scriptLine: 'Camera: Slow pull-out, revealing more of the environment.' },
  { id: 'pan-left', label: 'Pan left', scriptLine: 'Camera: Smooth pan left following the action.' },
  { id: 'tilt-up', label: 'Tilt up', scriptLine: 'Camera: Slow tilt up from detail to face or skyline.' },
  { id: 'orbit', label: 'Orbit', scriptLine: 'Camera: Gentle orbit around the subject with cinematic parallax.' },
  { id: 'handheld', label: 'Handheld', scriptLine: 'Camera: Subtle handheld drift, natural documentary energy.' },
])

export const MUSIC_VIDEO_SHOT_SIZE_OPTIONS = Object.freeze([
  { id: 'wide', label: 'Wide', scriptLine: 'Keyframe prompt: Wide establishing composition with the performer or subject clearly placed in the environment.' },
  { id: 'medium', label: 'Medium', scriptLine: 'Keyframe prompt: Medium shot, waist-up framing, expressive body language and readable setting.' },
  { id: 'close-up', label: 'Close-up', scriptLine: 'Keyframe prompt: Close-up portrait framing with strong facial expression and shallow depth of field.' },
  { id: 'detail', label: 'Detail', scriptLine: 'Keyframe prompt: Tight insert detail shot of hands, object, texture, instrument, or symbolic visual motif.' },
])

export const MUSIC_VIDEO_ENERGY_OPTIONS = Object.freeze([
  { id: 'calm', label: 'Calm', scriptLine: 'Motion prompt: Calm restrained movement, slow breathing pace, minimal camera energy.' },
  { id: 'building', label: 'Building', scriptLine: 'Motion prompt: Building emotional intensity, slightly stronger gesture and camera motion on the beat.' },
  { id: 'intense', label: 'Intense', scriptLine: 'Motion prompt: High emotional intensity, urgent performance energy, sharper movement accents on the music.' },
])

export const MUSIC_VIDEO_PERFORMANCE_MODE_OPTIONS = Object.freeze([
  { id: 'lip-sync', label: 'Lip sync', scriptLine: 'Shot type: performance\nMotion prompt: The artist lip-syncs naturally to the vocal line with believable facial performance.' },
  { id: 'wide-performance', label: 'Wide performance', scriptLine: 'Shot type: performance_wide\nMotion prompt: The artist performs in a wider frame with body movement and looser lip-sync.' },
  { id: 'b-roll', label: 'B-roll', scriptLine: 'Shot type: b_roll\nMotion prompt: No performer singing on camera. Focus on environment, action, symbolic detail, or texture.' },
  { id: 'narrative', label: 'Narrative', scriptLine: 'Motion prompt: Story-driven action that illustrates the lyric without literal lip-sync.' },
])

export const MUSIC_VIDEO_STYLE_CARD_OPTIONS = Object.freeze([
  {
    id: 'neon-noir',
    label: 'Neon noir',
    notes: 'Neon noir: rain-slick streets, cyan/magenta practical light, high contrast, shallow focus, reflective glass, moody night interiors.',
  },
  {
    id: 'tour-diary',
    label: 'Handheld tour diary',
    notes: 'Handheld tour diary: candid observational footage, imperfect framing, backstage textures, natural grain, fast venue-to-van transitions.',
  },
  {
    id: 'warm-35mm',
    label: 'Warm 35mm film',
    notes: 'Warm 35mm film: golden practical light, soft halation, gentle grain, warm skin tones, classic music-video lensing.',
  },
  {
    id: 'dream-pop',
    label: 'Dream pop haze',
    notes: 'Dream pop haze: pastel color wash, soft bloom, slow floating camera, abstract light leaks, surreal reflective environments.',
  },
])

export const MUSIC_VIDEO_SHOT_DEFAULTS = Object.freeze({
  shotType: 'performance',
  creativePreset: 'performance',
  avgShotLengthSeconds: 3.5,
  bRollRatio: 0.2,
  fps: 25,
  width: 1280,
  height: 736,
  imageStrength: 0.7,
  useVocalsOnly: false,
  enablePromptEnhancer: false,
  lipSyncIllustrateLyrics: false,
  minShotLengthSeconds: 1.5,
  maxShotLengthSeconds: 15,
})

/**
 * Input-audio kind. Director Mode asks this once per project at import time.
 * - 'vocal_stem': user provided a clean vocal stem → pass through, USE VOCALS ONLY = false.
 * - 'mixed_track': user provided a full mix → run vocal-extract-melband once as preprocessing,
 *   save stem as a project asset, then feed the stem to every shot with USE VOCALS ONLY = false.
 * - 'instrumental': no vocals at all → skip lip-sync, all shots become b_roll / performance_wide.
 */
export const MUSIC_VIDEO_AUDIO_KIND_OPTIONS = Object.freeze([
  {
    id: 'mixed_track',
    label: 'Finished song (full mix)',
    description: 'Full song with music and vocals together. We will run vocal isolation once.',
    requiresVocalExtraction: true,
  },
  {
    id: 'vocal_stem',
    label: 'Vocal stem (isolated vocals)',
    description: 'A clean vocal-only file. No preprocessing needed.',
    requiresVocalExtraction: false,
  },
  {
    id: 'instrumental',
    label: 'Instrumental (no vocals)',
    description: 'Music only. Lip-sync will be disabled for all shots.',
    requiresVocalExtraction: false,
  },
])

/**
 * Canonical music-video shot-type aliases accepted by the script parser.
 * Lets users type informal synonyms ("wide performance", "B-roll") that still
 * resolve cleanly to one of the three canonical shot types.
 */
export const MUSIC_VIDEO_SHOT_TYPE_ALIASES = Object.freeze({
  performance: [
    'performance', 'perf', 'performance close', 'performance (close)',
    'close-up performance', 'close performance', 'singing close',
    'lip sync', 'lip-sync', 'lipsync', 'singer close', 'artist close',
  ],
  performance_wide: [
    'performance_wide', 'performance wide', 'performance (wide)',
    'wide performance', 'wide singing', 'wide shot performance', 'singer wide',
    'artist wide', 'full body performance',
  ],
  b_roll: [
    'b_roll', 'b-roll', 'broll', 'b roll', 'cutaway', 'cut-away',
    'environment', 'insert', 'establishing', 'no vocals', 'no lip sync',
    'non-performance', 'non performance',
  ],
})

/**
 * Director script template surfaced in the Script sub-tab as the
 * "Start from template" seed. Demonstrates every optional field so users
 * don't have to guess the grammar. Aligned with the ad-mode template's feel
 * but tuned for a music-video rhythm.
 */
export const MUSIC_VIDEO_SCRIPT_TEMPLATE = `Shot 1: Highway flight
Start at: 0:00
Shot type: b_roll
Keyframe prompt: Neon-lit city streets flying past a rain-streaked car window at night, motion blur on distant headlights, cool cyan and magenta light bleed.
Motion prompt: Camera drifts forward along the window, neon reflections slide diagonally across the glass, rain catches the light.
Camera: Handheld forward dolly, slight roll
Length: 3

Shot 2: First verse close-up
Start at: 0:03
Artist: rose
Lyric moment: "You paint your eyelids with correction fluid moons"
Shot type: performance
Keyframe prompt: Close-up of the singer in the driver's seat, interior dim, a single warm key light across the face, eyes fixed forward on the road.
Motion prompt: Singer lip-syncs the line naturally, a subtle head tilt and a single slow blink, no big motion.
Camera: Locked medium close-up, shallow focus
Length: 4

Shot 3: Pre-chorus build
Start at: 0:07
Artist: jake
Lyric moment: "Swollen sound inside my head"
Shot type: performance_wide
Keyframe prompt: Three-quarter wide of the singer framed by the car interior, blurred neon signs streaming past through the rear window.
Motion prompt: Gentle forward lean, shoulder sway on the downbeat, hand taps the wheel once on the accent.
Camera: Slow push-in from the passenger side, shallow focus
Length: 3

Shot 4: Chorus duet
Start at: 0:10
Artist: both
Lyric moment: "We're only halfway home"
Shot type: performance_wide
Keyframe prompt: Two-shot of both singers side by side in the front seats, warm interior glow, windshield reflecting neon streaks.
Motion prompt: Both sing together, heads angled slightly toward each other on the held note, subtle sway on the beat.
Camera: Locked two-shot, shallow focus
Length: 3

Shot 5: Exit cut
Start at: 0:13
Shot type: b_roll
Keyframe prompt: Overhead shot of the empty highway at night, taillights trailing red streaks into vanishing point.
Motion prompt: Camera holds steady, taillights extend and fade as the car pulls away.
Camera: Locked overhead, static
Length: 2

# Tip: "Start at:" is authoritative — if you paste an SRT, use the real
# timing from it. "Artist:" matches your Cast roster by slug ("rose",
# "jake") or by "both" / "all" / "band" to feature every cast member.
# The script is the creative source of truth: put story, setting, wardrobe,
# lighting, color palette, continuity, and camera style directly in each
# Keyframe prompt and Motion prompt.
# You can also drop [Rose] / [Jake] / [Rose, Jake] tag lines above verses
# in the lyrics and shots pick up the nearest tag automatically.`

export const MUSIC_VIDEO_LYRICS_SOURCE_OPTIONS = Object.freeze([
  {
    id: 'paste',
    label: 'Paste lyrics',
    description: 'Paste the song lyrics. Recommended — most accurate timing.',
  },
  {
    id: 'asr_fallback',
    label: 'Auto-transcribe (fallback)',
    description: 'Run ASR on the vocal stem. Only use this if you do not have written lyrics.',
  },
  {
    id: 'none',
    label: 'No lyrics',
    description: 'Skip lyric grounding. Shots will rely on vocal-density detection only.',
  },
])

/** Validated in-place so downstream code can trust the structure. */
export function getMusicVideoShotTypeOption(shotTypeId = '') {
  return MUSIC_VIDEO_SHOT_TYPE_OPTIONS.find((option) => option.id === shotTypeId) || null
}

export function getMusicVideoCreativePreset(presetId = '') {
  return MUSIC_VIDEO_CREATIVE_PRESETS.find((preset) => preset.id === presetId) || null
}

export function getMusicVideoAudioKindOption(kindId = '') {
  return MUSIC_VIDEO_AUDIO_KIND_OPTIONS.find((option) => option.id === kindId) || null
}

/**
 * Clamp a planned shot length to allowed range without silently dropping the value.
 * Returns the effective length plus whether it was clamped (for UI surfacing).
 */
export function clampMusicVideoShotLength(lengthSeconds = 0) {
  const numeric = Number(lengthSeconds)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { length: MUSIC_VIDEO_SHOT_DEFAULTS.avgShotLengthSeconds, clamped: true }
  }
  const min = MUSIC_VIDEO_SHOT_DEFAULTS.minShotLengthSeconds
  const max = MUSIC_VIDEO_SHOT_DEFAULTS.maxShotLengthSeconds
  if (numeric < min) return { length: min, clamped: true }
  if (numeric > max) return { length: max, clamped: true }
  return { length: numeric, clamped: false }
}

/**
 * Normalize a shot object coming from the planner (or loaded from persisted state)
 * into the exact shape the workflow modifier expects. Extra keys are preserved.
 */
export function normalizeMusicVideoShot(rawShot = {}) {
  const shotTypeOption = getMusicVideoShotTypeOption(rawShot?.shotType) || getMusicVideoShotTypeOption(MUSIC_VIDEO_SHOT_DEFAULTS.shotType)
  const { length } = clampMusicVideoShotLength(rawShot?.length)
  const audioStart = Number(rawShot?.audioStart)
  const safeAudioStart = Number.isFinite(audioStart) && audioStart >= 0 ? audioStart : 0

  return {
    ...rawShot,
    shotType: shotTypeOption.id,
    length,
    audioStart: safeAudioStart,
    shotPrompt: String(rawShot?.shotPrompt || '').trim(),
    referenceImagePrompt: String(rawShot?.referenceImagePrompt || '').trim(),
    referenceImageAssetId: rawShot?.referenceImageAssetId || null,
    referenceImageComfyFilename: rawShot?.referenceImageComfyFilename || null,
    imageStrength: Number.isFinite(Number(rawShot?.imageStrength))
      ? Math.max(0, Math.min(1, Number(rawShot?.imageStrength)))
      : MUSIC_VIDEO_SHOT_DEFAULTS.imageStrength,
    seed: Number.isFinite(Number(rawShot?.seed))
      ? Math.round(Number(rawShot?.seed))
      : null,
  }
}

/**
 * Derive distribution targets for the shot-list planner from a preset + user overrides.
 * Used to nudge the LLM when it's generating the shot list.
 */
export function getMusicVideoShotDistributionTargets({
  presetId = MUSIC_VIDEO_SHOT_DEFAULTS.creativePreset,
  bRollRatioOverride = null,
  performanceWideRatioOverride = null,
} = {}) {
  const preset = getMusicVideoCreativePreset(presetId) || getMusicVideoCreativePreset(MUSIC_VIDEO_SHOT_DEFAULTS.creativePreset)
  const bRollRatio = clampRatio(bRollRatioOverride, preset.bRollRatio)
  const performanceWideRatio = clampRatio(performanceWideRatioOverride, preset.performanceWideRatio)
  const remainingPerformance = Math.max(0, 1 - bRollRatio - performanceWideRatio)
  return {
    performance: remainingPerformance,
    performance_wide: performanceWideRatio,
    b_roll: bRollRatio,
  }
}

function clampRatio(override, fallback) {
  const value = Number(override)
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

/**
 * Resolve a free-form shot-type string from the director script onto one of
 * the three canonical shot types. Returns null if no match, so callers can
 * apply their own fallback (typically 'performance').
 */
export function resolveMusicVideoShotTypeFromText(rawValue = '') {
  const normalized = String(rawValue || '')
    .toLowerCase()
    .replace(/[_\-()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  if (MUSIC_VIDEO_SHOT_TYPE_OPTIONS.some((option) => option.id === normalized.replace(/\s+/g, '_'))) {
    return normalized.replace(/\s+/g, '_')
  }
  for (const [canonicalId, aliases] of Object.entries(MUSIC_VIDEO_SHOT_TYPE_ALIASES)) {
    for (const alias of aliases) {
      const aliasNormalized = String(alias || '').toLowerCase().replace(/[_\-()]/g, ' ').replace(/\s+/g, ' ').trim()
      if (!aliasNormalized) continue
      if (normalized === aliasNormalized) return canonicalId
      if (normalized.includes(aliasNormalized)) return canonicalId
    }
  }
  return null
}

/**
 * Normalize raw lyrics text into a list of non-empty lines we can match
 * Lyric moment hints against. Keeps order stable so line index maps to song
 * time proportionally.
 *
 * This returns strings for backward compat; new callers that need `[Name]`
 * tag info alongside each line should use `parseLyricsWithTags` instead.
 */
export function parseLyricLines(rawLyrics = '') {
  return String(rawLyrics || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Cast roster role taxonomy — used only as an optional label on cast entries
 * today. Planner doesn't branch on role yet; surfaced in the UI so users can
 * note who's a lead vs backing vs instrumentalist for their own reference.
 *
 * `never_sings` is reserved for a future planner rule that would exclude a
 * cast member from performance shots automatically. For now it's documentation.
 */
export const MUSIC_VIDEO_CAST_ROLE_OPTIONS = Object.freeze([
  { id: 'lead', label: 'Lead vocal' },
  { id: 'co_lead', label: 'Co-lead vocal' },
  { id: 'backing', label: 'Backing vocal' },
  { id: 'instrumentalist', label: 'Instrumentalist' },
  { id: 'never_sings', label: 'Never sings' },
  { id: 'other', label: 'Other' },
])

/**
 * "both", "all", "band", etc. in an Artist: field or [...] lyric tag all
 * mean "every cast member appears in this shot".
 */
export const CAST_COLLECTIVE_KEYWORDS = Object.freeze(new Set([
  'both', 'all', 'band', 'everyone', 'group', 'whole band', 'full band',
]))

/**
 * Turn a user-typed name (from a cast-member form or an Artist: override)
 * into a stable lowercase slug. Slugs are how scripts and lyric tags refer to
 * cast members — case-insensitive match, non-alphanumeric chars collapsed to
 * hyphens.
 */
export function normalizeCastSlug(input = '') {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * Split a raw Artist: value or [tag] content into an ordered list of names.
 *
 * Handles these grammars:
 *   "rose"               → ["rose"]
 *   "rose, jake"         → ["rose", "jake"]
 *   "rose & jake"        → ["rose", "jake"]
 *   "rose and jake"      → ["rose", "jake"]
 *   "rose ft jake"       → ["rose", "jake"]
 *   "both" / "all" / etc → ["*"]  (special marker for "expand to full cast")
 *
 * Lowercased for consistency. Slug conversion happens at resolve time, not
 * here — keeping the raw form makes warning messages readable.
 */
export function splitCastNameList(raw = '') {
  const text = String(raw || '').trim().toLowerCase()
  if (!text) return []
  if (CAST_COLLECTIVE_KEYWORDS.has(text)) return ['*']
  const parts = text
    .split(/\s*(?:,|&|\+|\band\b|\bfeat\.?\b|\bfeaturing\b|\bft\.?\b|\bwith\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 1 && CAST_COLLECTIVE_KEYWORDS.has(parts[0])) return ['*']
  return parts
}

/**
 * Resolve a list of names (as returned by splitCastNameList) against a cast
 * roster. Matches by slug first, then case-insensitive label.
 *
 * Input:
 *   names = ["rose", "jake"]        (or ["*"] for collective)
 *   cast  = [{id, slug, label, assetId, role}, ...]
 *
 * Output:
 *   { members: CastMember[], unresolved: string[] }
 *
 * "*" expands to the full cast in order. Unknown names are collected into
 * `unresolved` so the UI can surface a warning ("You typed 'jack' but your
 * cast only has 'jake'").
 */
export function resolveCastMembersFromNameList(names, cast = []) {
  const safeCast = Array.isArray(cast) ? cast : []
  if (!Array.isArray(names) || names.length === 0) {
    return { members: [], unresolved: [] }
  }
  if (names.length === 1 && names[0] === '*') {
    return { members: [...safeCast], unresolved: [] }
  }
  const members = []
  const unresolved = []
  for (const rawName of names) {
    const name = String(rawName || '').trim().toLowerCase()
    if (!name) continue
    const slug = normalizeCastSlug(name)
    const match = safeCast.find((entry) => {
      const entrySlug = String(entry?.slug || '').toLowerCase()
      const entryLabel = String(entry?.label || '').toLowerCase()
      return entrySlug === slug
        || entrySlug === name
        || entryLabel === name
        || entryLabel === slug.replace(/-/g, ' ')
    })
    if (match) {
      // De-dup: if the same cast member is listed twice ("rose, rose") we
      // still only include them once so the duet slots don't waste a ref.
      if (!members.some((m) => m?.id === match.id)) members.push(match)
    } else {
      unresolved.push(rawName)
    }
  }
  return { members, unresolved }
}

/**
 * Common lyric section markers we want to ignore when parsing [...] tags.
 * `[Verse 1]`, `[Chorus]`, `[Bridge]` should NOT be interpreted as artist
 * tags — they're structural. Everything else inside brackets is treated as
 * a cast name (or a collective keyword like `[Both]`).
 */
const LYRIC_SECTION_TOKENS = new Set([
  'verse', 'pre-chorus', 'pre chorus', 'prechorus',
  'chorus', 'bridge', 'outro', 'intro', 'hook',
  'refrain', 'interlude', 'break', 'breakdown', 'drop',
  'instrumental', 'solo', 'coda', 'tag', 'post-chorus', 'post chorus',
])

function isLyricSectionLabel(text) {
  const t = String(text || '').toLowerCase().trim()
  if (!t) return true
  if (LYRIC_SECTION_TOKENS.has(t)) return true
  if (/^(?:verse|chorus|bridge|hook|pre-?chorus|post-?chorus)\s*\d+$/.test(t)) return true
  // "[x2]", "[2x]", "[Repeat]" and similar multiplier markers
  if (/^(?:\d+x|x\s*\d+|repeat(?:\s*\d+)?)$/.test(t)) return true
  return false
}

/**
 * Structured lyrics parser.
 *
 * Input:  raw lyrics text, optionally annotated with `[Name]` tags.
 * Output: array of { text, tags } where tags is the ordered name list
 *         (already lowercased) active when that line was written.
 *
 * Tag stickiness: a `[Rose]` line on its own applies to every subsequent
 * line until the next `[Name]` tag. `[Verse 1]`, `[Chorus]` etc. are treated
 * as section markers and do NOT change the active tag.
 *
 * Example:
 *   [Rose]
 *   Line 1
 *   Line 2
 *   [Jake]
 *   Line 3
 *   [Rose, Jake]
 *   Line 4
 * →
 *   [
 *     { text: 'Line 1', tags: ['rose'] },
 *     { text: 'Line 2', tags: ['rose'] },
 *     { text: 'Line 3', tags: ['jake'] },
 *     { text: 'Line 4', tags: ['rose', 'jake'] },
 *   ]
 */
export function parseLyricsWithTags(rawLyrics = '') {
  const raw = String(rawLyrics || '').replace(/\r\n/g, '\n')
  const rawLines = raw.split('\n')
  const out = []
  let currentTags = []
  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (!line) continue
    const bracketMatch = line.match(/^\[([^\]]+)\]$/)
    if (bracketMatch) {
      const content = bracketMatch[1].trim()
      if (isLyricSectionLabel(content)) continue
      currentTags = splitCastNameList(content)
      continue
    }
    out.push({ text: line, tags: [...currentTags] })
  }
  return out
}

/**
 * Fuzzy-match a Lyric moment hint (e.g. surrounded by quotes, maybe a
 * partial line) to a position in the pasted lyrics. Returns the 0-based
 * line index or -1 if no confident match.
 *
 * Matching strategy:
 *   1. Exact line match after light normalization (case-insensitive, punct/whitespace-collapsed).
 *   2. Any line that contains the hint as a substring (same normalization).
 *   3. Any line that shares >= 4 consecutive words with the hint.
 * The first strategy to yield a hit wins.
 */
export function findLyricLineIndex(hint = '', lyricLines = []) {
  const normalize = (value) => String(value || '')
    .replace(/["'""'']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  const needle = normalize(hint)
  if (!needle || !Array.isArray(lyricLines) || lyricLines.length === 0) return -1
  const haystack = lyricLines.map((line) => normalize(line))

  const exactIdx = haystack.findIndex((line) => line === needle)
  if (exactIdx !== -1) return exactIdx

  const substringIdx = haystack.findIndex((line) => line.includes(needle) || needle.includes(line))
  if (substringIdx !== -1) return substringIdx

  const needleWords = needle.split(' ').filter(Boolean)
  if (needleWords.length >= 4) {
    for (let windowSize = Math.min(6, needleWords.length); windowSize >= 4; windowSize -= 1) {
      for (let start = 0; start + windowSize <= needleWords.length; start += 1) {
        const window = needleWords.slice(start, start + windowSize).join(' ')
        const idx = haystack.findIndex((line) => line.includes(window))
        if (idx !== -1) return idx
      }
    }
  }
  return -1
}

/**
 * Estimate where in the song (seconds from start) a given lyric line begins,
 * based on linear distribution across the song's `audioDurationSeconds`.
 *
 * This is intentionally naive — only used as a last-resort fallback when the
 * user hasn't supplied an SRT/LRC and the script hasn't pinned a shot with
 * Start at:. Real timings come from parseTimedLyrics / Start at: parsing.
 */
export function estimateLyricLineStartSeconds(lineIndex, totalLines, audioDurationSeconds) {
  const total = Math.max(1, Number(totalLines) || 1)
  const duration = Math.max(0, Number(audioDurationSeconds) || 0)
  const idx = Math.max(0, Math.min(total - 1, Number(lineIndex) || 0))
  if (duration <= 0) return 0
  return Number(((idx / total) * duration).toFixed(2))
}

// ===========================================================================
// Timed lyrics (SRT / LRC) parsing + time-string helpers
// ===========================================================================
//
// Phase 8 pivots timing ownership from the planner (linear-estimation guesses)
// to the LLM that wrote the script. The LLM gets an SRT or LRC as input and
// produces shots with explicit `Start at:` and `Length:` fields; the app's
// job is just to parse the SRT so we can (a) cross-check the LLM's timings
// against the truth, and (b) fall back to SRT lookup when the script only
// supplied a `Lyric moment:` and no `Start at:`.

/**
 * Parse a loose time string into seconds (float).
 *
 * Accepts all of:
 *   "15"            → 15
 *   "15s"           → 15
 *   "15.5"          → 15.5
 *   "0:15"          → 15
 *   "0:15.5"        → 15.5
 *   "1:23"          → 83
 *   "1:23,500"      → 83.5   (SRT-style comma decimal)
 *   "01:23.500"     → 83.5
 *   "00:01:23,500"  → 83.5
 *   "1h02m03s"      → 3723   (rare, but tolerate it)
 *
 * Returns null when the string doesn't look like a time at all, which is the
 * signal for the planner to fall back to other strategies. An empty / null
 * input also returns null (not 0) so "unset" and "time == 0" stay distinct.
 */
export function parseTimeSpecToSeconds(rawInput = '') {
  const raw = String(rawInput || '').trim()
  if (!raw) return null

  // SRT/LRC sometimes use comma as decimal (e.g. "00:00:15,500"); normalize.
  const normalized = raw.replace(',', '.')

  // HH:MM:SS[.mmm] or MM:SS[.mmm]
  const colonMatch = normalized.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?(?:\.(\d+))?$/)
  if (colonMatch) {
    const a = Number(colonMatch[1])
    const b = Number(colonMatch[2])
    const c = colonMatch[3] !== undefined ? Number(colonMatch[3]) : null
    const fractionTail = colonMatch[4] ? Number(`0.${colonMatch[4]}`) : 0
    if (c !== null) {
      // Three-component form: HH:MM:SS[.mmm]
      const seconds = a * 3600 + b * 60 + c + fractionTail
      return Number.isFinite(seconds) ? seconds : null
    }
    // Two-component form: MM:SS[.mmm] — treat the second slot as seconds
    // (and fold any trailing .mmm into it; the alternate regex capture
    // already handles MM:SS.mmm because .mmm is part of the seconds group).
    const seconds = a * 60 + b + fractionTail
    return Number.isFinite(seconds) ? seconds : null
  }

  // Bare numeric with optional unit suffix (defaults to seconds).
  // Matches "15", "15.5", "15s", "15.5s", "90m" (minutes), "1h".
  const unitMatch = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (unitMatch) {
    const n = Number(unitMatch[1])
    if (!Number.isFinite(n)) return null
    const unit = (unitMatch[2] || 's').toLowerCase()
    if (unit === 'ms') return n / 1000
    if (unit === 's') return n
    if (unit === 'm') return n * 60
    if (unit === 'h') return n * 3600
  }

  // "1h02m03s" / "1m30s" compound form (best-effort).
  const compoundMatch = normalized.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/i)
  if (compoundMatch && (compoundMatch[1] || compoundMatch[2] || compoundMatch[3])) {
    const h = Number(compoundMatch[1] || 0)
    const m = Number(compoundMatch[2] || 0)
    const s = Number(compoundMatch[3] || 0)
    const seconds = h * 3600 + m * 60 + s
    return Number.isFinite(seconds) ? seconds : null
  }

  return null
}

/**
 * Format seconds into the UI-friendly "m:ss" / "h:mm:ss" used in coverage
 * summaries, the LLM prompt, and the scene-shot display.
 *
 *   7       → "0:07"
 *   83.5    → "1:23.5"
 *   3723    → "1:02:03"
 */
export function formatSecondsAsMMSS(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total - h * 3600 - m * 60
  const secsInt = Math.floor(s)
  const frac = s - secsInt
  // Preserve up to two decimal places when fractional, else show whole seconds.
  let secStr = String(secsInt).padStart(2, '0')
  if (frac > 0) {
    const fracStr = frac.toFixed(2).slice(1).replace(/0+$/, '') // ".45" or ".5"
    if (fracStr !== '.') secStr = `${secStr}${fracStr}`
  }
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${secStr}`
  return `${m}:${secStr}`
}

/**
 * Auto-detect whether a blob of text looks like SRT, LRC, or neither.
 *
 * SRT markers: an arrow timecode line like "00:00:08,500 --> 00:00:12,300".
 * LRC markers: timestamp tags at the line start like "[00:08.50]Lyric line".
 *
 * If both patterns appear we prefer SRT (richer — it carries end times).
 */
export function detectTimedLyricsFormat(rawText = '') {
  const text = String(rawText || '')
  if (!text.trim()) return 'empty'
  if (/^\s*\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}/m.test(text)) {
    return 'srt'
  }
  if (/^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/m.test(text)) {
    return 'lrc'
  }
  return 'unknown'
}

function parseSrtBlob(rawText) {
  // SRT blocks are separated by blank lines. Each block:
  //   N
  //   HH:MM:SS,mmm --> HH:MM:SS,mmm
  //   One or more lines of text
  //
  // We're forgiving: the leading index line and the trailing blank line are
  // both optional, and we accept '.' or ',' as the decimal separator.
  const blocks = String(rawText)
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
  const lines = []
  for (const block of blocks) {
    const bodyLines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (bodyLines.length === 0) continue
    const arrowIdx = bodyLines.findIndex((l) => /-->/.test(l))
    if (arrowIdx === -1) continue
    const arrowLine = bodyLines[arrowIdx]
    const [leftRaw, rightRaw] = arrowLine.split('-->').map((s) => s.trim())
    const startSec = parseTimeSpecToSeconds(leftRaw)
    const endSec = parseTimeSpecToSeconds(rightRaw)
    if (startSec === null) continue
    const textLines = bodyLines.slice(arrowIdx + 1)
    const text = textLines.join(' ').trim()
    if (!text) continue
    lines.push({
      index: lines.length + 1,
      startSec: Number(startSec.toFixed(3)),
      endSec: endSec !== null ? Number(endSec.toFixed(3)) : null,
      text,
    })
  }
  return lines
}

function parseLrcBlob(rawText) {
  // LRC lines look like "[00:08.50]Lyric text" or "[00:08.50][00:20.10]Text"
  // (dup-timestamp for chorus reuse). Header/meta tags like [ar:], [ti:],
  // [offset:+200] are also in brackets. We ignore meta, honor offset (in ms).
  const lines = []
  let offsetMs = 0
  const rawLines = String(rawText).replace(/\r\n/g, '\n').split('\n')
  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (!line) continue

    const offsetMatch = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i)
    if (offsetMatch) {
      const n = Number(offsetMatch[1])
      if (Number.isFinite(n)) offsetMs = n
      continue
    }

    // Meta tags: [ar:Artist], [ti:Title], [al:Album], [by:], [length:mm:ss].
    if (/^\[[a-zA-Z]+:[^\]]*\]$/.test(line) && !/^\[\d{1,2}:/.test(line)) continue

    // Extract all leading timestamp tags on the line.
    const tagRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
    const stamps = []
    let lastTagEnd = 0
    let match
    while ((match = tagRegex.exec(line)) !== null) {
      if (match.index !== lastTagEnd) break
      const mm = Number(match[1])
      const ss = Number(match[2])
      const frac = match[3] ? Number(`0.${match[3].padEnd(3, '0')}`) : 0
      stamps.push(mm * 60 + ss + frac + offsetMs / 1000)
      lastTagEnd = match.index + match[0].length
    }
    if (stamps.length === 0) continue

    const text = line.slice(lastTagEnd)
      // Enhanced LRC word-level tags look like "<00:12.34>word"; strip them.
      .replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '')
      .trim()
    if (!text) continue

    for (const stamp of stamps) {
      lines.push({
        index: 0,
        startSec: Number(stamp.toFixed(3)),
        endSec: null,
        text,
      })
    }
  }

  // LRC doesn't give end times. Sort by start and infer end as the next
  // line's start (last line stays null — the planner treats that as
  // "unknown end" and uses the shot's own Length: for coverage math).
  lines.sort((a, b) => a.startSec - b.startSec)
  for (let i = 0; i < lines.length - 1; i += 1) {
    lines[i].endSec = lines[i + 1].startSec
  }
  return lines.map((l, idx) => ({ ...l, index: idx + 1 }))
}

/**
 * Public entry point for timed-lyric parsing. Returns:
 *   {
 *     format: 'srt' | 'lrc' | 'empty' | 'unknown',
 *     lines:  [{ index, startSec, endSec, text }],
 *     error:  string | null,
 *   }
 *
 * `error` is only non-null when the format looked like SRT/LRC but we
 * couldn't extract a single line — i.e. it's user-facing "fix your paste"
 * signal, not a routine miss.
 */
export function parseTimedLyrics(rawText = '') {
  const format = detectTimedLyricsFormat(rawText)
  if (format === 'empty') return { format, lines: [], error: null }
  if (format === 'unknown') return { format, lines: [], error: null }
  try {
    const lines = format === 'srt' ? parseSrtBlob(rawText) : parseLrcBlob(rawText)
    if (lines.length === 0) {
      return {
        format,
        lines: [],
        error: `Detected ${format.toUpperCase()} format but could not extract any lines. Check that each block has a timecode and text.`,
      }
    }
    return { format, lines, error: null }
  } catch (err) {
    return {
      format,
      lines: [],
      error: err instanceof Error ? err.message : String(err || 'Failed to parse timed lyrics'),
    }
  }
}

/**
 * Fuzzy-match a Lyric moment hint against timed lyric entries.
 *
 * Reuses findLyricLineIndex's three-tier strategy (exact → substring →
 * 4+ consecutive words) but returns the whole timed entry so the planner
 * gets startSec directly. Returns null when no confident match.
 */
export function findTimedLyricLineByText(hint = '', timedLines = []) {
  if (!Array.isArray(timedLines) || timedLines.length === 0) return null
  const texts = timedLines.map((l) => l?.text || '')
  const idx = findLyricLineIndex(hint, texts)
  if (idx < 0 || idx >= timedLines.length) return null
  return timedLines[idx]
}

/**
 * Given a list of ranges [{start, end}], return the complementary gap ranges
 * inside [0, songDuration]. Overlapping or touching ranges are merged first.
 * Ranges with end <= start are ignored. Gaps shorter than `minGapSeconds`
 * are collapsed into their neighbors.
 */
export function computeCoverageGaps(ranges = [], songDuration = 0, minGapSeconds = 0.5) {
  const duration = Math.max(0, Number(songDuration) || 0)
  if (duration <= 0) return []
  const cleaned = (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({
      start: Math.max(0, Math.min(duration, Number(r?.start) || 0)),
      end: Math.max(0, Math.min(duration, Number(r?.end) || 0)),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)

  // Merge overlaps.
  const merged = []
  for (const range of cleaned) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  // Collect gaps: before the first range, between ranges, and after the last.
  const gaps = []
  let cursor = 0
  for (const range of merged) {
    if (range.start - cursor >= minGapSeconds) {
      gaps.push({ start: cursor, end: range.start })
    }
    cursor = Math.max(cursor, range.end)
  }
  if (duration - cursor >= minGapSeconds) {
    gaps.push({ start: cursor, end: duration })
  }
  return gaps
}
