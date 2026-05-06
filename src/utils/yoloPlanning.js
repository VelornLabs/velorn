const DEFAULT_ANGLE_PRESETS = [
  'Wide shot',
  'Medium shot',
  'Close-up',
  'Low angle',
  'High angle',
  'Over-the-shoulder',
  'POV',
  'Tracking shot',
]

const SCENE_HEADING_PATTERN = /^(?:scene\s+\d+|sc\s*\d+|#\s*scene|\d+\.|coverage\s+\d+|pass\s+\d+)\b/i
const SHOT_HEADING_PATTERN = /^(?:shot\s+\d+|sh\s*\d+)\b/i
const STRUCTURED_FIELD_PATTERNS = Object.freeze([
  { key: 'sceneContext', pattern: /^scene\s+context\s*:\s*(.*)$/i },
  { key: 'coverageType', pattern: /^(?:coverage\s*type|coverage\s*pass|pass\s*type)\s*:\s*(.*)$/i },
  { key: 'coverageLabel', pattern: /^(?:coverage\s*label|coverage)\s*:\s*(.*)$/i },
  { key: 'shotType', pattern: /^(?:shot\s*type|framing)\s*:\s*(.*)$/i },
  { key: 'keyframePrompt', pattern: /^(?:keyframe\s*prompt|image\s*action|opening\s*frame|keyframe)\s*:\s*(.*)$/i },
  { key: 'motionPrompt', pattern: /^(?:motion\s*prompt|video\s*action|video\s*prompt|motion)\s*:\s*(.*)$/i },
  { key: 'camera', pattern: /^(?:camera|camera\s*direction|camera\s*setup)\s*:\s*(.*)$/i },
  // `length` is a music-video-friendly alias for duration. Ad scripts still
  // write `Duration:` and both route to the same shot field, so the downstream
  // parser/normalizer doesn't need to care which was used.
  { key: 'duration', pattern: /^(?:duration|length)(?:\s*\(s\))?\s*:\s*(.*)$/i },
  { key: 'takes', pattern: /^takes?\s*:\s*(.*)$/i },
  { key: 'adBeat', pattern: /^(?:ad\s*beat|commercial\s*beat|beat)\s*:\s*(.*)$/i },
  { key: 'productMode', pattern: /^(?:product\s*mode|product\s*view|product)\s*:\s*(.*)$/i },
  { key: 'talentMode', pattern: /^(?:talent\s*mode|talent|spokesperson\s*mode)\s*:\s*(.*)$/i },
  { key: 'textOverlay', pattern: /^(?:text\s*overlay|overlay\s*text|caption|claim)\s*:\s*(.*)$/i },
  { key: 'endCard', pattern: /^(?:end\s*card|endcard|cta\s*card)\s*:\s*(.*)$/i },
  { key: 'dialogue', pattern: /^(?:dialogue|voice\s*line|voiceover\s*line|spoken\s*line)\s*:\s*(.*)$/i },
  // Music-video-only: the specific lyric line this shot should sit on. The
  // ad path never sets this; the music planner reads it out when present to
  // pin audioStart to the right moment in the song.
  { key: 'lyricMoment', pattern: /^(?:lyric\s*(?:moment|cue|line)?|lyrics?)\s*:\s*(.*)$/i },
  // Music-video-only: per-shot artist override that picks a cast member by
  // slug/label (e.g. "rose", "jake", "both", "all"). Ignored when the cast
  // roster is empty or when no match is found — the planner then falls back
  // to the lyric-tag resolver and finally to the default (first cast entry).
  { key: 'artist', pattern: /^(?:artist|singer|performer|cast|vocalist)\s*:\s*(.*)$/i },
  // Music-video-only: explicit audio offset (Phase 8). Accepted forms include
  // "0:15", "15s", "00:00:15,500" — see parseTimeSpecToSeconds in
  // musicVideoShotConfig.js. When present, the music planner pins audioStart
  // to this value verbatim, skipping the Lyric moment / SRT-fuzzy fallback.
  { key: 'startAt', pattern: /^(?:start\s*at|audio\s*start|start)\s*:\s*(.*)$/i },
])

function parseSceneHeadingLine(line = '') {
  const text = String(line || '').trim()
  if (!text || !SCENE_HEADING_PATTERN.test(text)) {
    return { isHeading: false, label: '' }
  }
  const label = text
    .replace(/^(?:scene\s+\d+|sc\s*\d+|#\s*scene|\d+\.|coverage\s+\d+|pass\s+\d+)\s*[:\-]?\s*/i, '')
    .trim()
  return { isHeading: true, label }
}

function parseCoverageHeadingLine(line = '') {
  const text = String(line || '').trim()
  const match = text.match(/^(?:coverage|pass)\s+(\d+)\s*[:\-]?\s*(.*)$/i)
  if (!match) return { isHeading: false, label: '' }
  return {
    isHeading: true,
    index: Number(match[1]) || null,
    label: sanitizeSnippet(String(match[2] || '').trim(), 100),
  }
}

function getSceneLines(sceneText = '') {
  return String(sceneText)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function getSceneBodyText(sceneText = '') {
  const lines = getSceneLines(sceneText)
  if (lines.length === 0) return ''

  const { isHeading, label } = parseSceneHeadingLine(lines[0])
  if (!isHeading) return lines.join(' ')

  const bodyLines = lines.slice(1).filter(Boolean)
  if (bodyLines.length > 0) return bodyLines.join(' ')
  return label
}

function getSceneLabel(sceneText = '') {
  const firstLine = getSceneLines(sceneText)[0] || ''
  const { isHeading, label } = parseSceneHeadingLine(firstLine)
  return isHeading ? label : ''
}

function parseShotHeadingLine(line = '') {
  const text = String(line || '').trim()
  if (!text || !SHOT_HEADING_PATTERN.test(text)) {
    return { isHeading: false, label: '' }
  }
  const label = text
    .replace(/^(?:shot\s+\d+|sh\s*\d+)\s*[:\-]?\s*/i, '')
    .trim()
  return { isHeading: true, label }
}

function matchStructuredFieldLine(line = '') {
  const text = String(line || '').trim()
  for (const entry of STRUCTURED_FIELD_PATTERNS) {
    const match = text.match(entry.pattern)
    if (!match) continue
    return {
      key: entry.key,
      value: String(match[1] || '').trim(),
    }
  }
  return null
}

function splitScriptIntoScenes(script = '') {
  const normalized = String(script || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const explicitScenes = normalized
    .split(/\n(?=\s*(?:scene\s+\d+|sc\s*\d+|#\s*scene|\d+\.|coverage\s+\d+|pass\s+\d+)\b)/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
  if (explicitScenes.length > 1) return explicitScenes

  const paragraphScenes = normalized
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
  if (paragraphScenes.length > 1) return paragraphScenes

  return [normalized]
}

function splitSceneIntoBeats(sceneText = '') {
  const lines = getSceneLines(sceneText)
  const nonHeadingLines = lines.filter((line, index) => !(index === 0 && parseSceneHeadingLine(line).isHeading))
  const lineBeats = nonHeadingLines.length > 0 ? nonHeadingLines : lines
  if (lineBeats.length > 1) return lineBeats

  const sentenceBeats = getSceneBodyText(sceneText)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  if (sentenceBeats.length > 0) return sentenceBeats

  return [String(getSceneBodyText(sceneText) || sceneText).trim()]
}

function sanitizeSnippet(text = '', maxLength = 180) {
  const compact = String(text).replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength - 3)}...`
}

function extractKeyframeMoment(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const sequenceSplit = compact
    .split(/\b(?:then|after|before|while|as soon as|followed by)\b/i)
    .map((part) => part.trim())
    .filter(Boolean)
  const firstSequence = sequenceSplit[0] || compact
  const firstSentence = firstSequence.split(/(?<=[.!?])\s+/)[0] || firstSequence
  return firstSentence.trim()
}

function seededUnit(seed) {
  const x = Math.sin(Number(seed) * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

function randomizedShotDurationSeconds(baseSeed, sceneIndex, shotIndex) {
  const unit = seededUnit(baseSeed + sceneIndex * 101 + shotIndex * 37)
  const min = 2
  const max = 5
  const duration = min + (max - min) * unit
  return Number(duration.toFixed(2))
}

function parseOptionalShotDurationSeconds(value, fallback, options = {}) {
  const text = String(value || '').trim()
  if (!text) return fallback
  const match = text.match(/(\d+(?:\.\d+)?)/)
  if (!match) return fallback
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed)) return fallback
  const min = Math.max(0.1, Number(options.minShotDurationSeconds) || 2)
  const max = Math.max(min, Number(options.maxShotDurationSeconds) || 5)
  return Number(Math.min(max, Math.max(min, parsed)).toFixed(2))
}

function parseOptionalShotTakes(value, fallback) {
  const text = String(value || '').trim()
  if (!text) return fallback
  const match = text.match(/(\d+)/)
  if (!match) return fallback
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(4, Math.max(1, Math.round(parsed)))
}

function buildStructuredSceneSummary(sceneLabel, sceneContext, fallbackText = '') {
  return sanitizeSnippet(
    [sceneLabel ? `${sceneLabel}.` : '', sceneContext || fallbackText]
      .filter(Boolean)
      .join(' '),
    280
  )
}

function normalizeCoverageType(value = '', fallbackText = '') {
  const text = [value, fallbackText].filter(Boolean).join(' ').toLowerCase()
  if (!text.trim()) return ''
  if (/\b(?:main|master|primary|scripted)\b/.test(text)) return 'main_sequence'
  if (/\bperformance\b/.test(text)) return 'performance_pass'
  if (/\b(?:story|narrative|cutaway|cutaways)\b/.test(text)) return 'story_broll'
  if (/\b(?:detail|insert|macro|texture|textural)\b/.test(text)) return 'detail_broll'
  if (/\b(?:environment|environmental|place|places|atmosphere|world|location)\b/.test(text)) return 'environmental_broll'
  return sanitizeSnippet(String(value || '').trim().replace(/\s+/g, '_').toLowerCase(), 60)
}

function buildSceneCoverageMeta(scene = {}) {
  const explicitType = String(scene.coverageType || '').trim()
  const explicitLabel = sanitizeSnippet(scene.coverageLabel || '', 100)
  const sectionLabel = sanitizeSnippet(scene.coverageSectionLabel || '', 100)
  const headingLabel = sanitizeSnippet(scene.label || '', 100)
  const contextText = [
    explicitType,
    explicitLabel,
    sectionLabel,
    headingLabel,
    Array.isArray(scene.contextLines) ? scene.contextLines.join(' ') : '',
  ].filter(Boolean).join(' ')
  const type = normalizeCoverageType(explicitType, contextText)
  const genericLabels = new Set([
    'main sequence',
    'main scripted sequence',
    'performance pass',
    'story b-roll',
    'story broll',
    'environmental b-roll',
    'environmental broll',
    'detail inserts',
    'detail b-roll',
    'detail broll',
  ])
  const isGenericExplicitLabel = explicitLabel
    && sectionLabel
    && genericLabels.has(explicitLabel.toLowerCase())
  const label = (isGenericExplicitLabel ? sectionLabel : explicitLabel)
    || sectionLabel
    || (type ? headingLabel : '')
  return { type, label }
}

export function parseStructuredDirectorScript(script = '', options = {}) {
  const normalized = String(script || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return null

  const takesPerAngle = Math.max(1, Number(options.takesPerAngle) || 1)
  const targetDurationSeconds = Math.max(5, Number(options.targetDurationSeconds) || 30)
  const minShotDurationSeconds = Math.max(0.1, Number(options.minShotDurationSeconds) || 2)
  const maxShotDurationSeconds = Math.max(minShotDurationSeconds, Number(options.maxShotDurationSeconds) || 5)
  const variationSeed = Math.max(0, Number(options.variationSeed) || 0)
  const styleNotes = sanitizeSnippet(options.styleNotes || '', 220)
  const anglePresets = Array.isArray(options.anglePresets) && options.anglePresets.length > 0
    ? options.anglePresets
    : DEFAULT_ANGLE_PRESETS
  const lines = normalized.split('\n')

  const scenes = []
  let currentScene = null
  let currentShot = null
  let coverageContext = null
  let activeField = ''
  let sawStructuredField = false

  const ensureScene = () => {
    if (currentScene) return currentScene
    currentScene = {
      label: '',
      coverageType: coverageContext?.coverageType || '',
      coverageLabel: coverageContext?.coverageLabel || coverageContext?.label || '',
      coverageSectionIndex: coverageContext?.index || null,
      coverageSectionLabel: coverageContext?.label || '',
      rawLines: [],
      contextLines: [],
      shots: [],
    }
    return currentScene
  }

  const appendToActiveField = (target, fieldName, value) => {
    const text = String(value || '').trim()
    if (!text) return
    const existing = String(target[fieldName] || '').trim()
    target[fieldName] = existing ? `${existing} ${text}` : text
  }

  const appendSceneContextLine = (scene, value) => {
    const text = String(value || '').trim()
    if (!text) return
    scene.contextLines.push(text)
  }

  const flushShot = () => {
    if (!currentScene || !currentShot) return

    const shotIndex = currentScene.shots.length
    const shotId = `S${scenes.length + 1}_SH${shotIndex + 1}`
    const fallbackAngle = anglePresets[(variationSeed + scenes.length * 2 + shotIndex) % anglePresets.length]
    const fallbackDuration = randomizedShotDurationSeconds(variationSeed + targetDurationSeconds, scenes.length, shotIndex)
    const shotContext = sanitizeSnippet(currentShot.notes || currentShot.label || currentScene.contextLines.join(' '), 220)
    const imageBeat = sanitizeSnippet(
      currentShot.keyframePrompt || shotContext || currentScene.contextLines.join(' '),
      220
    )
    const videoBeat = sanitizeSnippet(
      currentShot.motionPrompt || currentShot.keyframePrompt || shotContext || currentScene.contextLines.join(' '),
      220
    )
    const shotType = sanitizeSnippet(currentShot.shotType || currentShot.label || fallbackAngle, 90)
    const cameraDirection = sanitizeSnippet(currentShot.camera || '', 160)
    const sceneCoverage = buildSceneCoverageMeta(currentScene)
    const shotCoverageType = normalizeCoverageType(
      currentShot.coverageType,
      [currentShot.coverageLabel, sceneCoverage.type, sceneCoverage.label].filter(Boolean).join(' ')
    )
    const shotCoverageLabel = sanitizeSnippet(
      currentShot.coverageLabel || sceneCoverage.label || '',
      100
    )

    currentScene.shots.push({
      id: shotId,
      index: shotIndex + 1,
      beat: videoBeat,
      imageBeat,
      videoBeat,
      durationSeconds: parseOptionalShotDurationSeconds(currentShot.duration, fallbackDuration, {
        minShotDurationSeconds,
        maxShotDurationSeconds,
      }),
      takesPerAngle: parseOptionalShotTakes(currentShot.takes, takesPerAngle),
      angles: [shotType || fallbackAngle],
      cameraPresetId: 'auto',
      shotType,
      cameraDirection,
      // Ad-specific commercial grammar. These are pass-through metadata for
      // prompt composition, chip UX, lip-sync routing, and native text layers.
      adBeat: sanitizeSnippet(currentShot.adBeat || '', 120),
      coverageType: shotCoverageType || sceneCoverage.type,
      coverageLabel: shotCoverageLabel,
      coverageSectionIndex: currentScene.coverageSectionIndex || null,
      coverageSectionLabel: sanitizeSnippet(currentScene.coverageSectionLabel || '', 100),
      productMode: sanitizeSnippet(currentShot.productMode || '', 120),
      talentMode: sanitizeSnippet(currentShot.talentMode || '', 120),
      textOverlay: sanitizeSnippet(currentShot.textOverlay || '', 220),
      endCard: sanitizeSnippet(currentShot.endCard || '', 260),
      dialogue: sanitizeSnippet(currentShot.dialogue || '', 260),
      // Music-video-only pass-through. The ad flow never sets lyricMoment; the
      // music planner reads it downstream to align audioStart to a lyric.
      lyricMoment: sanitizeSnippet(currentShot.lyricMoment || '', 220),
      // Music-video-only pass-through. Resolved to actual cast asset ids in
      // the music planner (src/components/GenerateWorkspace.jsx).
      artistRaw: sanitizeSnippet(currentShot.artist || '', 120),
      // Music-video-only pass-through (Phase 8). The music planner calls
      // parseTimeSpecToSeconds on this to pin audioStart, bypassing the
      // Lyric-moment fuzzy lookup when it's present and parseable.
      startAtRaw: sanitizeSnippet(currentShot.startAt || '', 32),
      // Keyframe + motion prompts kept raw so the music planner can compose
      // separate shotPrompt (motion) and referenceImagePrompt (keyframe) from them.
      keyframePromptRaw: sanitizeSnippet(currentShot.keyframePrompt || '', 320),
      motionPromptRaw: sanitizeSnippet(currentShot.motionPrompt || '', 320),
      locked: false,
    })

    currentShot = null
    activeField = ''
  }

  const flushScene = () => {
    if (!currentScene) return
    flushShot()
    if (currentScene.shots.length === 0) {
      currentScene = null
      activeField = ''
      return
    }

    const sceneIndex = scenes.length
    const sceneId = `S${sceneIndex + 1}`
    const sceneContext = sanitizeSnippet(currentScene.contextLines.join(' '), 280)
    const sceneSummary = buildStructuredSceneSummary(currentScene.label, sceneContext, currentScene.rawLines.join(' '))
    const sceneCoverage = buildSceneCoverageMeta(currentScene)

    scenes.push({
      id: sceneId,
      index: sceneIndex + 1,
      rawText: currentScene.rawLines.join('\n'),
      contextText: sceneContext,
      summary: sceneSummary,
      styleNotes,
      coverageType: sceneCoverage.type,
      coverageLabel: sceneCoverage.label,
      coverageSectionIndex: currentScene.coverageSectionIndex || null,
      coverageSectionLabel: sanitizeSnippet(currentScene.coverageSectionLabel || '', 100),
      shots: currentScene.shots.map((shot, shotIndex) => ({
        ...shot,
        coverageType: shot.coverageType || sceneCoverage.type,
        coverageLabel: shot.coverageLabel || sceneCoverage.label,
        coverageSectionIndex: shot.coverageSectionIndex || currentScene.coverageSectionIndex || null,
        coverageSectionLabel: shot.coverageSectionLabel || currentScene.coverageSectionLabel || '',
        id: `${sceneId}_SH${shotIndex + 1}`,
        index: shotIndex + 1,
      })),
    })

    currentScene = null
    activeField = ''
  }

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim()
    if (!line) {
      activeField = ''
      continue
    }

    const coverageHeading = parseCoverageHeadingLine(line)
    if (coverageHeading.isHeading) {
      flushScene()
      coverageContext = {
        index: coverageHeading.index,
        label: coverageHeading.label,
        coverageType: '',
        coverageLabel: '',
      }
      activeField = ''
      continue
    }

    const sceneHeading = parseSceneHeadingLine(line)
    if (sceneHeading.isHeading) {
      flushScene()
      currentScene = {
        label: sceneHeading.label,
        coverageType: coverageContext?.coverageType || '',
        coverageLabel: coverageContext?.coverageLabel || coverageContext?.label || '',
        coverageSectionIndex: coverageContext?.index || null,
        coverageSectionLabel: coverageContext?.label || '',
        rawLines: [line],
        contextLines: [],
        shots: [],
      }
      continue
    }

    const structuredField = matchStructuredFieldLine(line)
    if (
      structuredField
      && !currentShot
      && !currentScene
      && coverageContext
      && (structuredField.key === 'coverageType' || structuredField.key === 'coverageLabel')
    ) {
      sawStructuredField = true
      activeField = structuredField.key
      appendToActiveField(coverageContext, structuredField.key, structuredField.value)
      continue
    }

    if (
      !currentShot
      && !currentScene
      && coverageContext
      && (activeField === 'coverageType' || activeField === 'coverageLabel')
    ) {
      appendToActiveField(coverageContext, activeField, line)
      continue
    }

    const scene = ensureScene()
    scene.rawLines.push(line)

    const shotHeading = parseShotHeadingLine(line)
    if (shotHeading.isHeading) {
      flushShot()
      currentShot = {
        label: shotHeading.label,
        shotType: '',
        keyframePrompt: '',
        motionPrompt: '',
        camera: '',
        duration: '',
        takes: '',
        adBeat: '',
        productMode: '',
        talentMode: '',
        textOverlay: '',
        endCard: '',
        dialogue: '',
        coverageType: '',
        coverageLabel: '',
        // Music-video-only (null-op for ads). Collected by the shared
        // structured-field matcher — see STRUCTURED_FIELD_PATTERNS above.
        lyricMoment: '',
        artist: '',
        startAt: '',
        notes: '',
      }
      continue
    }

    if (structuredField) {
      sawStructuredField = true
      activeField = structuredField.key
      if (currentShot) {
        appendToActiveField(currentShot, structuredField.key, structuredField.value)
      } else if (structuredField.key === 'coverageType' || structuredField.key === 'coverageLabel') {
        appendToActiveField(scene, structuredField.key, structuredField.value)
      } else {
        appendSceneContextLine(scene, structuredField.value)
      }
      continue
    }

    if (currentShot) {
      if (activeField && activeField !== 'sceneContext') {
        appendToActiveField(currentShot, activeField, line)
      } else {
        appendToActiveField(currentShot, 'notes', line)
      }
      continue
    }

    if (activeField === 'coverageType' || activeField === 'coverageLabel') {
      appendToActiveField(scene, activeField, line)
    } else {
      scene.contextLines.push(line)
    }
  }

  flushScene()

  if (!sawStructuredField || scenes.length === 0) return null
  return scenes
}

export function buildYoloPlanFromScript(script = '', options = {}) {
  const shotsPerScene = Math.max(1, Number(options.shotsPerScene) || 3)
  const anglesPerShot = Math.max(1, Number(options.anglesPerShot) || 2)
  const takesPerAngle = Math.max(1, Number(options.takesPerAngle) || 1)
  const targetDurationSeconds = Math.max(5, Number(options.targetDurationSeconds) || 30)
  const variationSeed = Math.max(0, Number(options.variationSeed) || 0)
  const styleNotes = sanitizeSnippet(options.styleNotes || '', 220)
  const anglePresets = Array.isArray(options.anglePresets) && options.anglePresets.length > 0
    ? options.anglePresets
    : DEFAULT_ANGLE_PRESETS

  const structuredPlan = parseStructuredDirectorScript(script, {
    takesPerAngle,
    targetDurationSeconds,
    variationSeed,
    styleNotes,
    anglePresets,
  })
  if (Array.isArray(structuredPlan) && structuredPlan.length > 0) {
    return structuredPlan
  }

  const sceneBlocks = splitScriptIntoScenes(script)
  if (sceneBlocks.length === 0) return []

  return sceneBlocks.map((sceneText, sceneIndex) => {
    const sceneId = `S${sceneIndex + 1}`
    const sceneLabel = getSceneLabel(sceneText)
    const sceneBody = getSceneBodyText(sceneText)
    const beats = splitSceneIntoBeats(sceneText)
    const beatOffset = beats.length > 0 ? variationSeed % beats.length : 0
    const sceneSummaryBase = sceneBody || beats[0] || sceneText
    const sceneSummary = sanitizeSnippet(
      [sceneLabel ? `${sceneLabel}.` : '', sceneSummaryBase]
        .filter(Boolean)
        .join(' '),
      280
    )

    const shots = Array.from({ length: shotsPerScene }, (_, shotIndex) => {
      const beat = beats[(beatOffset + shotIndex) % beats.length] || sceneSummary
      const shotId = `${sceneId}_SH${shotIndex + 1}`
      const angleOffset = (variationSeed + sceneIndex * 2 + shotIndex) % anglePresets.length
      const angles = Array.from({ length: anglesPerShot }, (_, angleIndex) => (
        anglePresets[(angleOffset + angleIndex) % anglePresets.length]
      ))

      return {
        id: shotId,
        index: shotIndex + 1,
        beat: sanitizeSnippet(beat, 220), // Legacy field
        imageBeat: sanitizeSnippet(beat, 220), // Storyboard keyframe moment
        videoBeat: sanitizeSnippet(beat, 220), // Video action/motion beat
        durationSeconds: randomizedShotDurationSeconds(variationSeed + targetDurationSeconds, sceneIndex, shotIndex),
        takesPerAngle,
        angles,
        locked: false,
      }
    })

    return {
      id: sceneId,
      index: sceneIndex + 1,
      rawText: sceneText,
      contextText: sceneBody,
      summary: sceneSummary,
      styleNotes,
      shots,
    }
  })
}

export function flattenYoloPlanVariants(plan = []) {
  const variants = []

  for (const scene of plan || []) {
    const sceneBody = String(scene?.contextText || getSceneBodyText(scene?.rawText || scene?.summary || '')).trim()
    const strictConsistency = String(scene?.styleNotes || '').toLowerCase().includes('consistency mode: strict')
    // Pass identity (master / alt_performance / environmental_broll / detail_broll)
    // is stamped onto the scene by buildYoloMusicPlan. Pass it through so the
    // queue layer can tag generated assets with their origin pass.
    const scenePass = scene?.pass && typeof scene.pass === 'object' ? scene.pass : null
    const sceneCoverage = {
      type: sanitizeSnippet(scene?.coverageType || '', 80),
      label: sanitizeSnippet(scene?.coverageLabel || '', 100),
      sectionIndex: Number(scene?.coverageSectionIndex) || null,
      sectionLabel: sanitizeSnippet(scene?.coverageSectionLabel || '', 100),
    }

    for (const shot of scene?.shots || []) {
      const takes = Math.max(1, Number(shot?.takesPerAngle) || 1)
      const angles = Array.isArray(shot?.angles) && shot.angles.length > 0
        ? shot.angles
        : DEFAULT_ANGLE_PRESETS.slice(0, 1)
      const imageBeat = String(shot?.imageBeat || shot?.beat || '').trim()
      const videoBeat = String(shot?.videoBeat || shot?.beat || '').trim()
      const cameraDirection = String(shot?.cameraDirection || '').trim()
      const adBeat = sanitizeSnippet(shot?.adBeat || '', 120)
      const productMode = sanitizeSnippet(shot?.productMode || '', 120)
      const talentMode = sanitizeSnippet(shot?.talentMode || '', 120)
      const textOverlay = sanitizeSnippet(shot?.textOverlay || '', 220)
      const endCard = sanitizeSnippet(shot?.endCard || '', 260)
      const dialogue = sanitizeSnippet(shot?.dialogue || '', 260)
      const coverage = {
        type: sanitizeSnippet(shot?.coverageType || sceneCoverage.type || '', 80),
        label: sanitizeSnippet(shot?.coverageLabel || sceneCoverage.label || '', 100),
        sectionIndex: Number(shot?.coverageSectionIndex || sceneCoverage.sectionIndex) || null,
        sectionLabel: sanitizeSnippet(shot?.coverageSectionLabel || sceneCoverage.sectionLabel || '', 100),
      }

      for (const angle of angles) {
        for (let take = 1; take <= takes; take += 1) {
          const key = `${scene.id}|${shot.id}|${angle}|T${take}`
          const isAdShot = Boolean(adBeat || productMode || talentMode || textOverlay || endCard || dialogue)
          const videoPrompt = [
            sceneBody ? `${sceneBody}.` : scene.summary,
            productMode ? `Product mode: ${productMode}.` : '',
            talentMode ? `Talent mode: ${talentMode}.` : '',
            dialogue ? `Dialogue cue for performance timing: "${dialogue}".` : '',
            videoBeat,
            `Compose with a ${String(angle || 'medium shot').toLowerCase()} camera setup.`,
            cameraDirection ? `Camera direction: ${cameraDirection}.` : '',
            strictConsistency
              ? 'Maintain strict continuity with adjacent shots: same person identity, same wardrobe, and same key props/actions from the script.'
              : 'Maintain continuity with adjacent shots and preserve key props/actions from the script.',
            isAdShot ? '' : scene.styleNotes,
            take > 1
              ? (
                strictConsistency
                  ? 'Create a micro-variation only (timing/expression), but keep identity, wardrobe, and staging locked.'
                  : 'Create an alternate variation while keeping staging and continuity consistent.'
              )
              : '',
          ]
            .filter(Boolean)
            .join(' ')
          const keyframeMoment = extractKeyframeMoment(imageBeat || scene?.summary || sceneBody)
          const storyboardPrompt = [
            `Single cinematic keyframe still for ${scene.id} ${shot.id}.`,
            sceneBody ? `Scene context: ${sceneBody}.` : '',
            adBeat ? `Commercial beat: ${adBeat}.` : '',
            productMode ? `Product mode: ${productMode}.` : '',
            talentMode ? `Talent mode: ${talentMode}.` : '',
            keyframeMoment ? `Capture this exact moment: ${keyframeMoment}.` : '',
            `Camera framing: ${String(angle || 'medium shot').toLowerCase()}.`,
            cameraDirection ? `Camera treatment: ${cameraDirection}.` : '',
            textOverlay ? `Reserve clean negative space for editor-native text overlay: "${textOverlay}". Do not render the words into the image.` : '',
            endCard ? `End-card intent: reserve a clean packshot/brand-safe layout for editor-native typography: "${endCard}". Do not render the words into the image.` : '',
            'Render one image only: one frame, one moment, one continuous camera view.',
            'Do not create split-screen, collage, diptych, triptych, storyboard grid, comic panels, or multiple images in one frame.',
            'Do not depict a before/after sequence or montage in a single image.',
            'Show one primary subject instance only unless the script explicitly requires extra characters.',
            'No on-screen text, no captions, no subtitles, no labels, no watermarks.',
            strictConsistency
              ? 'Keep the same person identity and wardrobe fully locked to references.'
              : 'Keep character identity and wardrobe reasonably consistent with adjacent shots.',
            scene.styleNotes,
            'Hard rule: do not render overlay words, end-card words, captions, subtitles, labels, watermarks, random letters, or fake typography in the image.',
          ]
            .filter(Boolean)
            .join(' ')

          variants.push({
            key,
            sceneId: scene.id,
            shotId: shot.id,
            angle,
            take,
            durationSeconds: shot.durationSeconds,
            prompt: sanitizeSnippet(videoPrompt, 1100),
            videoPrompt: sanitizeSnippet(videoPrompt, 1100),
            storyboardPrompt: sanitizeSnippet(storyboardPrompt, 1100),
            adBeat,
            productMode,
            talentMode,
            textOverlay,
            endCard,
            dialogue,
            // Music-video-only pass-throughs. Unset for ads. The queue code
            // reads resolvedArtistAssetIds (ordered list of up to 2 cast asset
            // ids) in music mode to override the default-artist reference.
            resolvedArtistAssetIds: Array.isArray(shot?.resolvedArtistAssetIds)
              ? shot.resolvedArtistAssetIds.filter(Boolean).slice(0, 2)
              : [],
            // Origin pass: { type, altSlotId, altLabel }. Null for ad mode and
            // legacy plans that pre-date pass tagging. Consumers of this field
            // must tolerate null and fall back to the pre-pass behavior.
            pass: scenePass,
            coverage: coverage.type || coverage.label ? coverage : null,
          })
        }
      }
    }
  }

  return variants
}
