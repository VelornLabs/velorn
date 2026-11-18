import { validThinkingLevel } from './connectedAgentReasoning.mjs'
import { sanitizeAgentToolReceipts, sanitizeAgentLocalDiagnostics } from './connectedAgentReceipts.mjs'

// Read-only, renderer-safe context for the optional creative-review assistant.
// Nothing here loads media, writes a project, queues generation, or contacts a
// provider. The caller explicitly chooses the provider and any image bytes.
import { normalizeStoryboard } from './storyboard.mjs'
import { getStoryboardPresentation, parseStoryboardShotLabel } from './storyboardPresentation.mjs'
import { getStoryboardProjectKey } from './storyboardWorkspace.mjs'

export const CONNECTED_AGENT_LIMITS = Object.freeze({ contextCharacters: 60000, contextBytes: 96 * 1024, text: 12000,
  messages: 60, historyCharacters: 96000, storedCharacters: 120000, images: 4, shots: 200 })

const array = value => Array.isArray(value) ? value : []
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && !/^(?:https?|file|blob|data):/i.test(value) ? value : null
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const uniqueIds = (values, max = 200) => [...new Set(array(values).map(safeId).filter(Boolean))].slice(0, max)
const sourceUrlPattern = /(?:data:[^\s"'<>]+|(?:https?|file|blob|comfystudio|velorn):\/\/[^\s"'<>]+)/gi
// Bound metadata by the existing message budget, not an eight-source quota.
// Even the shortest accepted HTTPS URL consumes more than 12 characters.
const sourceUrlLimit = Math.ceil(CONNECTED_AGENT_LIMITS.text / 12)

/** Display-only record of the requested model ID, never server-confirmed identity.
 * Preserve safe IDs exactly: '' means an explicit default, while undefined
 * means unrecorded/unsafe. Do not turn a malformed value into a different ID.
 */
export function sanitizeConnectedAgentRequestedModel(value) {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9._:/@+-]/.test(value)
    || /\/\/|^[A-Za-z]:\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
    || /^(?:https?|file|blob|data|javascript|vbscript):/i.test(value)
    || /(?:^|[/:@])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|token|credential|cookie|session|jwt):/i.test(value)
    || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|hf_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/i.test(value)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) return undefined
  return value
}

/** Inert display references only, not URL-fetch authorization or DNS validation.
 * Native research tools independently validate and resolve every requested URL.
 */
export function sanitizeConnectedAgentSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\<>\x00-\x1f\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase()
    if (host.endsWith('.') || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|localdomain|corp|test|invalid|example|onion|arpa)$/.test(host)) return null
    const decoded = decodeURIComponent(url.href)
    if (/[\x00-\x1f\x7f\\]/.test(decoded)
      || /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|hf_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|Bearer\s|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i.test(decoded)
      || /[/?&#;](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|token|signature|credential|session|cookie|jwt)[=:]/i.test(decoded)) return null
    // Public video, search and documentation links use ordinary query fields.
    // Retain navigation data, but never credentials, signed access URLs or
    // nested URLs/paths disguised as a query parameter.
    if (url.search.length > 1024 || [...url.searchParams].length > 32) return null
    for (const [key, entry] of url.searchParams) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)
        || /(?:token|secret|password|passwd|signature|credential|authorization|api.?key|access.?key|session|cookie|jwt|x-amz|x-goog|^sig$|^key$|^auth$|^code$)/i.test(key)
        || entry.length > 512 || /[\x00-\x1f\x7f\\]/.test(entry)
        || /(?:[a-z][a-z0-9+.-]*:\/\/|^(?:\/|~\/|[a-z][a-z0-9+.-]*:)|Bearer\s|\b(?:password|secret|token|api[_-]?key)\s*[=:])/i.test(entry)) return null
      if (['download', 'raw'].includes(key) && !/^(?:true|false|0|1)$/.test(entry)) return null
    }
    if (url.hash && (!/^#[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(url.hash)
      || /(?:token|password|secret|auth|signature|credential|session|cookie)/i.test(url.hash))) return null
    return url.href.length <= 2048 ? url.href : null
  } catch { return null }
}

function sourceToken(raw, prefix = '') {
  let candidate = raw.replace(/[)\]}.!,;:]+$/, '')
  // Markdown delimiters belong to the surrounding prose, not the URL. Only
  // strip a delimiter that actually opened immediately before this token;
  // public paths ending in an underscore/asterisk retain their literal value.
  const delimiter = prefix.match(/(\*{1,3}|_{1,3}|`+|~~)[([{<]*$/)?.[1]
  if (delimiter && candidate.endsWith(delimiter)) candidate = candidate.slice(0, -delimiter.length).replace(/[)\]}.!,;:]+$/, '')
  return { candidate, url: sanitizeConnectedAgentSourceUrl(candidate), suffix: raw.slice(candidate.length) }
}

const localComfyRoot = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/
export function containsLocalComfyAddress(value) {
  if (typeof value !== 'string') return false
  const text = value.slice(0, CONNECTED_AGENT_LIMITS.storedCharacters)
  return [...text.matchAll(sourceUrlPattern)].some(match => {
    const { candidate } = sourceToken(match[0], text.slice(Math.max(0, match.index - 16), match.index))
    const port = localComfyRoot.exec(candidate)?.[1]
    return port && Number(port) <= 65535
  })
}

// This proof is supplied only by the native optionalSetup.inspect bridge, not
// the model's reply/tool text. It creates ordinary historical display prose,
// never a URL allowlist, network authority, or a clickable local endpoint.
function verifiedComfyDisplay(status) {
  const port = status?.configuredPort
  if (status?.success !== true || status.integration !== 'comfyui' || status.state !== 'ready'
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !array(status.connections).some(connection => connection?.port === port
      && connection.httpBase === `http://127.0.0.1:${port}`)) return null
  return { port, text: `local ComfyUI (127.0.0.1:${port})` }
}

export function collectConnectedAgentSourceUrls(value) {
  if (typeof value !== 'string') return []
  const urls = []
  for (const match of value.slice(0, CONNECTED_AGENT_LIMITS.text).matchAll(sourceUrlPattern)) {
    const { url } = sourceToken(match[0], value.slice(Math.max(0, match.index - 16), match.index))
    if (url && !urls.includes(url)) urls.push(url)
    if (urls.length === sourceUrlLimit) break
  }
  return urls
}

/** Best-effort defense in depth for free text, never a credentials vault. */
export function redactConnectedAgentText(value, max = CONNECTED_AGENT_LIMITS.text, { allowPublicUrls = false, sourceUrls, verifiedComfySetup } = {}) {
  if (typeof value !== 'string') return ''
  const limit = Number.isInteger(max) && max > 0 ? Math.min(max, CONNECTED_AGENT_LIMITS.historyCharacters) : CONNECTED_AGENT_LIMITS.text
  const allowed = sourceUrls === undefined ? null : new Set(array(sourceUrls).slice(0, sourceUrlLimit).map(sanitizeConnectedAgentSourceUrl).filter(Boolean))
  const retained = []
  const display = verifiedComfyDisplay(verifiedComfySetup)
  const isVerifiedRoot = candidate => display && Number(localComfyRoot.exec(candidate)?.[1]) === display.port
  const text = value.slice(0, CONNECTED_AGENT_LIMITS.storedCharacters)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // A verified local destination loses hyperlink syntax as well as its
    // scheme. Labels and every other value still go through redaction below.
    .replace(/\[([^\]\r\n]{0,200})\]\((http:\/\/127\.0\.0\.1:[0-9]+\/?)\)/g,
      (whole, label, url) => isVerifiedRoot(url) ? `${label} — ${display.text}` : whole)
    .replace(/<(http:\/\/127\.0\.0\.1:[0-9]+\/?)>/g,
      (whole, url) => isVerifiedRoot(url) ? display.text : whole)
    .replace(sourceUrlPattern, (raw, offset, input) => {
      const { candidate, url, suffix } = sourceToken(raw, input.slice(Math.max(0, offset - 16), offset))
      if (isVerifiedRoot(candidate)) return `${display.text}${suffix}`
      if (allowPublicUrls !== true || !url || (allowed && !allowed.has(url))) return `[link omitted]${suffix}`
      let index = retained.indexOf(url)
      if (index < 0) {
        if (retained.length === sourceUrlLimit) return `[link omitted]${suffix}`
        index = retained.push(url) - 1
      }
      // Input control bytes were removed above. Protect only validated URLs
      // from the ordinary path/credential passes, without placeholder spoofing.
      return `\x01${index}\x02${suffix}`
    })
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization|endpoint|base[_ -]?url)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[private value omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi, '[credential omitted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, '[credential omitted]')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^"'\n]*\1/g, '[path omitted]')
    .replace(/(^|[\s(\[{=:])(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^\s"'<>\])}]+/g, '$1[path omitted]')
  let result = '', cursor = 0
  for (const match of text.matchAll(/\x01(\d+)\x02/g)) {
    result += text.slice(cursor, match.index).slice(0, limit - result.length)
    const url = retained[Number(match[1])]
    result += (url.length <= limit - result.length ? url : '[link omitted]').slice(0, limit - result.length)
    cursor = match.index + match[0].length
  }
  return (result + text.slice(cursor)).slice(0, limit)
}

// Saved planning data survives changing chats/providers. It is not a transcript,
// authenticated approval, a current spending preference, or verified job state.
// In particular, a legacy scaffold alone must not select a 45-second project.
function savedProjectBrief(board, assets) {
  const production = board.production
  const run = board.productionRun
  const text = (value, max) => redactConnectedAgentText(value, max).trim()
  const meaningfulProduction = Boolean(production && (
    ['concept', 'visualStyle', 'audience', 'mustInclude'].some(key => production[key]?.trim())
    || production.approach !== 'undecided' || production.castMode !== 'undecided' || production.locationMode !== 'undecided'
    || production.cast.length || production.locations.length || production.shotDirections.length
    || production.targetDurationSeconds !== 45 || production.songStartSeconds !== 0
  ))
  const songAssetId = safeId(board.songAssetId)
  const songMatches = array(assets).filter(asset => asset?.id === songAssetId)
  const song = songAssetId && songMatches.length === 1 ? songMatches[0] : null
  const songDuration = finite(song?.duration ?? song?.settings?.duration)
  const songCompatible = song?.type === 'audio' || (song?.type === 'video' && (song.hasAudio === true || song.settings?.hasAudio === true))
  // Existing projects do not record whether the scaffold's 45 seconds was
  // explicitly chosen. A later concept edit cannot establish that provenance.
  const targetDurationStatus = meaningfulProduction
    ? production.targetDurationSeconds === 45 ? 'default-valued-unconfirmed' : 'saved-unverified'
    : production ? 'default-only-unconfirmed' : 'not-saved'
  const sourceRange = songAssetId && meaningfulProduction ? {
    startSeconds: finite(production.songStartSeconds), durationSeconds: finite(production.targetDurationSeconds),
    status: targetDurationStatus,
    withinSource: songCompatible && songDuration !== null
      ? production.songStartSeconds + production.targetDurationSeconds <= songDuration + 0.05 : null,
  } : null
  const runNotes = text(run?.notes, 1400), nextAction = text(run?.nextAction, 700)
  const recentRecipes = array(run?.attempts).slice(-3).map(attempt => ({
    attemptId: safeId(attempt.attemptId), shotId: safeId(attempt.shotId),
    model: text(attempt.recipe.model, 160), workflow: text(attempt.recipe.workflow, 160),
    reportedState: attempt.state, note: text(attempt.note, 240),
    referenceAssetIds: uniqueIds(attempt.recipe.referenceAssetIds, 3),
    inputAssetIds: uniqueIds(attempt.recipe.inputAssetIds, 3),
    songAssetId: safeId(attempt.recipe.songAssetId),
    audioStartSeconds: finite(attempt.recipe.audioStartSeconds), audioDurationSeconds: finite(attempt.recipe.audioDurationSeconds),
  }))
  const hasCreativeIntent = Boolean(meaningfulProduction || board.brief.trim() || songAssetId
    || board.referenceAssetIds?.length || runNotes || nextAction || run?.attempts.length || run?.bindings.length
    || board.shots.some(shot => shot.description.trim() || !/^Shot\s+\d+$/i.test(shot.title)
      || shot.referenceAssetIds.length || shot.takes.length || shot.storyboardAssetId))
  return {
    source: 'saved-project-metadata', authority: 'context-only-not-permission', hasCreativeIntent,
    productionSettingsStatus: meaningfulProduction ? 'saved-unverified' : production ? 'default-only-unconfirmed' : 'not-saved',
    type: meaningfulProduction ? production.type : null,
    targetDurationSeconds: meaningfulProduction ? finite(production.targetDurationSeconds) : null,
    targetDurationStatus,
    approach: meaningfulProduction && production.approach !== 'undecided' ? production.approach : null,
    audience: text(production?.audience, 700), mustInclude: text(production?.mustInclude, 1000),
    castMode: meaningfulProduction && production.castMode !== 'undecided' ? production.castMode : null,
    locationMode: meaningfulProduction && production.locationMode !== 'undecided' ? production.locationMode : null,
    song: songAssetId ? { assetId: songAssetId, title: text(song?.name, 200),
      missing: !song, compatible: song ? songCompatible : null, durationSeconds: songDuration, sourceRange } : null,
    productionRun: run ? { notes: runNotes, nextAction, attemptCount: run.attempts.length, bindingCount: run.bindings.length,
      recordsAreUnverified: true, recentRecipes } : null,
  }
}

/**
 * A detached allowlisted snapshot, not a dump of stores or the project. The
 * identity helper is deliberately used only to check that a project exists:
 * its return value can contain an absolute path and must never be sent out.
 * `timeline` accepts the current timeline plus live playhead/selection fields.
 */
export function buildConnectedAgentContext({ project, handle, assets = [], timeline = null,
  activeTab = 'editor', visibleShotIds = [] } = {}) {
  const context = { project: { name: '' }, storyboard: { title: '', brief: '', concept: '', visualStyle: '',
    cast: [], locations: [], shots: [] }, editor: { activeTab: redactConnectedAgentText(activeTab, 80), timeline: null },
  visibleShotIds: [], warnings: [] }
  if (getStoryboardProjectKey(project, handle) == null) {
    context.warnings.push('No project is open.')
    return context
  }
  context.project.name = redactConnectedAgentText(project.name, 200)
  let board
  try { board = normalizeStoryboard(project.storyboard) } catch {
    // Fail closed on duplicate or malformed labels: guessing an ordinal could
    // highlight a different saved shot. The original document remains intact.
    context.warnings.push('Storyboard data is unavailable or unsupported; no shot references were resolved.')
  }
  if (board) {
    const media = array(assets).filter(asset => safeId(asset?.id)).map(asset => ({
      id: asset.id, type: asset.type, name: redactConnectedAgentText(asset.name, 200),
    }))
    const presentation = getStoryboardPresentation(board, media)
    const entity = (entry, idKey) => ({ id: safeId(entry[idKey]), name: redactConnectedAgentText(entry.displayLabel || entry.name, 200),
      description: redactConnectedAgentText(entry.description, 600),
      referenceAssetIds: uniqueIds(entry.references?.map(reference => reference.assetId), 4),
      missingReferenceAssetIds: uniqueIds(entry.references?.filter(reference => reference.missing).map(reference => reference.assetId), 4),
      referenceCount: entry.references?.length || 0 })
    context.projectBrief = savedProjectBrief(board, assets)
    context.storyboard = {
      title: redactConnectedAgentText(board.title, 200), brief: redactConnectedAgentText(board.brief, 3000),
      concept: redactConnectedAgentText(board.production?.concept, 2000),
      visualStyle: redactConnectedAgentText(board.production?.visualStyle, 1000),
      referenceAssetIds: uniqueIds(board.referenceAssetIds, 8),
      cast: presentation.cast.map(entry => ({ ...entity(entry, 'memberId'), role: redactConnectedAgentText(entry.role, 200) })),
      locations: presentation.locations.map(entry => entity(entry, 'locationId')),
      shots: presentation.shots.filter(shot => safeId(shot.shotId)).slice(0, CONNECTED_AGENT_LIMITS.shots).map(shot => ({
        shotId: shot.shotId, label: shot.label, title: redactConnectedAgentText(shot.title, 200),
        description: redactConnectedAgentText(shot.description, 600), durationSeconds: finite(shot.durationSeconds),
        stillAssetId: shot.stillMissing ? null : safeId(shot.stillAssetId),
      })),
    }
  }
  if (timeline && typeof timeline === 'object') {
    context.editor.timeline = { id: safeId(timeline.id), name: redactConnectedAgentText(timeline.name, 200),
      playheadSeconds: finite(timeline.playheadSeconds ?? timeline.playheadPosition),
      selectedClipIds: uniqueIds(timeline.selectedClipIds, 50) }
  }
  let omitted = 0
  const encoder = new TextEncoder()
  const oversized = () => {
    const serialized = JSON.stringify(context)
    return serialized.length > CONNECTED_AGENT_LIMITS.contextCharacters - 1500
      || encoder.encode(serialized).byteLength > CONNECTED_AGENT_LIMITS.contextBytes - 2000
  }
  while (oversized() && context.storyboard.shots.length) {
    context.storyboard.shots.pop()
    omitted++
  }
  if (omitted) context.warnings.push(`${omitted} additional shots omitted from this bounded context.`)
  // Entity references and run memory can fill the envelope even on a board
  // with no shots. Keep its brief, names and identities; trim detail first.
  let briefOmitted = false
  const entities = [...context.storyboard.cast, ...context.storyboard.locations]
  for (const entity of [...entities].reverse()) {
    if (!oversized()) break
    entity.description = entity.description.slice(0, 160)
    entity.referenceAssetIds = entity.referenceAssetIds.slice(0, 1)
    entity.missingReferenceAssetIds = entity.missingReferenceAssetIds.slice(0, 1)
    briefOmitted = true
  }
  for (const entity of [...entities].reverse()) {
    if (!oversized()) break
    entity.name = entity.name.slice(0, 80)
    entity.description = entity.description.slice(0, 80)
    if (entity.role) entity.role = entity.role.slice(0, 80)
    briefOmitted = true
  }
  while (oversized() && context.projectBrief?.productionRun?.recentRecipes.length) {
    context.projectBrief.productionRun.recentRecipes.shift()
    briefOmitted = true
  }
  // JSON escaping can expand authored strings. Keep an aggregate final guard,
  // rather than relying on individual character limits adding up favorably.
  while (oversized() && (context.storyboard.cast.length || context.storyboard.locations.length)) {
    if (context.storyboard.locations.length) context.storyboard.locations.pop()
    else context.storyboard.cast.pop()
    briefOmitted = true
  }
  if (briefOmitted) context.warnings.push('Some saved planning detail was omitted from this bounded context; inspect the production guide and run for the full record.')
  const known = new Set(context.storyboard.shots.map(shot => shot.shotId))
  // Visible-card knowledge is supplied by the view, never assumed from the
  // entire board or from the current tab alone.
  context.visibleShotIds = uniqueIds(visibleShotIds, CONNECTED_AGENT_LIMITS.images).filter(id => known.has(id))
  return context
}

function shotIndex(contextOrShots) {
  const shots = array(Array.isArray(contextOrShots) ? contextOrShots : contextOrShots?.storyboard?.shots)
  const byId = new Map(), byNumber = new Map(), duplicateIds = new Set(), duplicateNumbers = new Set()
  for (const shot of shots) {
    if (!safeId(shot?.shotId)) continue
    let number
    try { number = parseStoryboardShotLabel(shot.label) } catch { continue }
    if (byId.has(shot.shotId)) duplicateIds.add(shot.shotId)
    if (byNumber.has(number)) duplicateNumbers.add(number)
    byId.set(shot.shotId, shot)
    byNumber.set(number, shot)
  }
  for (const id of duplicateIds) byId.delete(id)
  for (const number of duplicateNumbers) {
    // Neither marker IDs nor text labels may target an ambiguous label.
    for (const [id, shot] of byId) if (Number(shot.label.slice(5)) === number) byId.delete(id)
    byNumber.delete(number)
  }
  for (const [number, shot] of byNumber) if (!byId.has(shot.shotId)) byNumber.delete(number)
  return { byId, byNumber }
}

const shotReferences = text => typeof text === 'string'
  ? [...text.slice(0, CONNECTED_AGENT_LIMITS.text).matchAll(/\bshot[ \t]+0*([1-9]\d{0,5})(?![\w]|\.\d)/gi)] : []

/** Shot 7 and Shot 07 resolve only to the saved Shot 07, never title/position. */
export function parseConnectedAgentShotReferences(text, contextOrShots) {
  const { byNumber } = shotIndex(contextOrShots)
  return [...new Set(shotReferences(text).map(match => byNumber.get(Number(match[1]))?.shotId).filter(Boolean))]
}

/** Treat model markers as untrusted suggestions; validate against this snapshot. */
export function formatConnectedAgentResponse(value, contextOrShots, options = {}) {
  const { byId } = shotIndex(contextOrShots), shotIds = new Set()
  const text = (typeof value === 'string' ? value : '').slice(0, options.allowPublicUrls === true ? CONNECTED_AGENT_LIMITS.storedCharacters : CONNECTED_AGENT_LIMITS.text)
    .replace(/\[\[\s*shot:([^\]\r\n]*)\]\]/gi, (_marker, id) => {
      const shot = byId.get(id)
      if (!shot) return '[unavailable shot]'
      shotIds.add(shot.shotId)
      return shot.label
    })
    .replace(/\[\[\s*shot:[^\r\n]*(?:\]\]|$)/gi, '[unavailable shot]')
  const clean = redactConnectedAgentText(text, CONNECTED_AGENT_LIMITS.text, options)
  const sourceUrls = options.allowPublicUrls === true ? collectConnectedAgentSourceUrls(clean) : []
  return { text: clean, shotIds: [...shotIds], ...(sourceUrls.length ? { sourceUrls } : {}) }
}

/** Metadata only: caller must separately and explicitly prepare image bytes. */
export function selectConnectedAgentImageCandidates({ context, prompt = '', visibleShotIds } = {}) {
  const { byId } = shotIndex(context)
  // An explicit unknown shot must not silently substitute unrelated visible
  // images. No references means only the caller-reported visible cards qualify.
  const explicit = /\bshot[ \t]+\d/i.test(typeof prompt === 'string' ? prompt : '')
  const ids = explicit ? parseConnectedAgentShotReferences(prompt, context)
    : uniqueIds(visibleShotIds ?? context?.visibleShotIds)
  return ids.map(id => byId.get(id)).filter(shot => shot && safeId(shot.stillAssetId))
    .slice(0, CONNECTED_AGENT_LIMITS.images).map(shot => ({ shotId: shot.shotId, label: shot.label, assetId: shot.stillAssetId }))
}

// Object-valued project keys (browser directory handles or anonymous drafts)
// have no portable persistent identifier. Keep their histories in memory for
// the renderer session rather than leak a handle or collide on project names.
const objectHistories = new WeakMap()
const fallbackHistories = new Map()
const storageHistories = new WeakMap()
const providerId = value => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,79}$/.test(value) ? value : null
function fingerprint(value) {
  return [2166136261, 2246822507, 3266489909, 668265263].map(seed => {
    let hash = seed
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
    return hash.toString(16).padStart(8, '0')
  }).join('')
}
export function getConnectedAgentHistoryKey(projectKey, provider) {
  if (typeof projectKey !== 'string' || !projectKey || !providerId(provider)) return null
  return `velorn.connected-agent.history.v1.${provider}.${fingerprint(projectKey)}`
}

export function sanitizeConnectedAgentMessages(messages) {
  const clean = array(messages).slice(-CONNECTED_AGENT_LIMITS.messages).filter(message => message
    && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string').map(message => {
    // sourceUrls is bounded display-retention metadata, never research/tool
    // permission. The caller still controls URL disclosure in provider history.
    const sourceUrls = [...new Set(array(message.sourceUrls).slice(0, sourceUrlLimit).map(sanitizeConnectedAgentSourceUrl).filter(Boolean))]
    const text = redactConnectedAgentText(message.text, CONNECTED_AGENT_LIMITS.text, { allowPublicUrls: sourceUrls.length > 0, sourceUrls })
    const present = collectConnectedAgentSourceUrls(text)
    const requestedModel = message.role === 'assistant' ? sanitizeConnectedAgentRequestedModel(message.requestedModel) : undefined
    const toolReceipts = message.role === 'assistant' ? sanitizeAgentToolReceipts(message.toolReceipts) : undefined
    const localDiagnostics = message.role === 'assistant' ? sanitizeAgentLocalDiagnostics(message.localDiagnostics) : undefined
    return { role: message.role, text,
      ...(typeof message.turnId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(message.turnId) ? { turnId: message.turnId } : {}),
      ...(message.role === 'assistant' && ['failed', 'reply-unavailable'].includes(message.deliveryStatus) ? { deliveryStatus: message.deliveryStatus } : {}),
      ...(toolReceipts ? { toolReceipts } : {}),
      ...(localDiagnostics ? { localDiagnostics } : {}),
      ...(Array.isArray(message.shotIds) ? { shotIds: uniqueIds(message.shotIds) } : {}),
      ...(present.length ? { sourceUrls: present } : {}),
      ...(requestedModel !== undefined ? { requestedModel } : {}),
      ...(message.role === 'assistant' && validThinkingLevel(message.requestedReasoningEffort) ? { requestedReasoningEffort: message.requestedReasoningEffort } : {}),
    }
  })
  while (JSON.stringify(clean).length > CONNECTED_AGENT_LIMITS.historyCharacters && clean.length) clean.shift()
  return clean
}

/**
 * Dependency-injected storage, no global localStorage access. Every call names
 * both project AND provider; there is intentionally no migration/merge API.
 * Unknown message fields (context, images, endpoint, key, requests) are dropped.
 */
export function createConnectedAgentHistoryStore({ storage = null } = {}) {
  // Distinct injected browser profiles/test stores must never share fallbacks.
  const hasStorageObject = storage && (typeof storage === 'object' || typeof storage === 'function')
  if (hasStorageObject && !storageHistories.has(storage)) storageHistories.set(storage, { messages: new Map(), cleared: new Set() })
  const local = hasStorageObject ? storageHistories.get(storage) : { messages: fallbackHistories, cleared: new Set() }
  const keyFor = (projectKey, provider) => {
    if (!providerId(provider) || projectKey == null) return null
    if (typeof projectKey === 'object') {
      if (!objectHistories.has(projectKey)) objectHistories.set(projectKey, new Map())
      return { memory: objectHistories.get(projectKey), key: provider, persistent: false }
    }
    const key = getConnectedAgentHistoryKey(projectKey, provider)
    return key ? { memory: local.messages, key, persistent: true } : null
  }
  const read = (projectKey, provider) => {
    const slot = keyFor(projectKey, provider)
    if (!slot) return []
    if (slot.persistent && local.cleared.has(slot.key)) return []
    if (slot.persistent && storage?.getItem) {
      let raw
      try {
        raw = storage.getItem(slot.key)
      } catch { /* Unavailable local storage still allows a session conversation. */ }
      if (raw != null) {
        if (typeof raw !== 'string' || raw.length > CONNECTED_AGENT_LIMITS.storedCharacters) return []
        try {
          const value = JSON.parse(raw)
          return value?.version === 1 ? sanitizeConnectedAgentMessages(value.messages) : []
        } catch { return [] }
      }
    }
    return sanitizeConnectedAgentMessages(slot.memory.get(slot.key))
  }
  const write = (projectKey, provider, messages) => {
    const slot = keyFor(projectKey, provider)
    if (!slot) return []
    const clean = sanitizeConnectedAgentMessages(messages)
    if (slot.persistent) local.cleared.delete(slot.key)
    slot.memory.set(slot.key, clean)
    if (slot.persistent && storage?.setItem) {
      try { storage.setItem(slot.key, JSON.stringify({ version: 1, messages: clean })) } catch { /* Session-only fallback. */ }
    }
    return sanitizeConnectedAgentMessages(clean)
  }
  const clear = (projectKey, provider) => {
    const slot = keyFor(projectKey, provider)
    if (!slot) return
    slot.memory.delete(slot.key)
    if (slot.persistent) local.cleared.add(slot.key)
    if (slot.persistent && storage?.removeItem) {
      try { storage.removeItem(slot.key) } catch { /* Nothing else to clear. */ }
    }
  }
  return { read, write, clear }
}
