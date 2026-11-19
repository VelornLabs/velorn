import { createDefaultStoryboard, normalizeStoryboard } from './storyboard.mjs'
import { createProduction } from './production.mjs'

const defaultBoardTitle = createDefaultStoryboard().title
const defaultProduction = createProduction('music-video')
const hasText = value => value.trim().length > 0

function hasProductionContent(production) {
  if (!production) return false
  if (['cast', 'locations', 'shotDirections', 'reviews'].some(key => production[key].length > 0)) return true
  if (['concept', 'visualStyle', 'audience', 'mustInclude'].some(key => hasText(production[key]))) return true
  // The earlier guided form could save its untouched music-video defaults.
  // Explicit choices (including a different production type) still count.
  return ['type', 'targetDurationSeconds', 'songStartSeconds', 'approach', 'delegation', 'castMode', 'locationMode']
    .some(key => production[key] !== defaultProduction[key])
}

/**
 * Whether the saved board warrants a workspace in normal project navigation.
 * Reads only: normalization validates a separate value, never replaces the
 * original. Unknown/corrupt saved data stays discoverable for the read-only
 * warning instead of being mistaken for an empty board and hidden.
 */
export function hasStoryboardContent(raw) {
  if (raw == null) return false
  try {
    const board = normalizeStoryboard(raw)
    const title = board.title.trim()
    if (board.shots.length > 0 || board.referenceAssetIds?.length > 0 || board.songAssetId
      || hasText(board.brief) || (title && title !== defaultBoardTitle)) return true
    if (hasProductionContent(board.production)) return true
    const run = board.productionRun
    return Boolean(run && (hasText(run.notes) || hasText(run.nextAction) || run.attempts.length > 0 || run.bindings.length > 0))
  } catch {
    return true
  }
}

const identityValue = value => (typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isFinite(value))

/**
 * Transient UI identity, not a new project-file field or persisted preference.
 * Compare with strict equality. A browser directory handle is its own stable
 * session key; path strings and durable metadata survive immutable edits.
 * Anonymous handle-less projects fall back to object identity so unrelated
 * projects never share a manual empty-board override just because names match.
 */
export function getStoryboardProjectKey(project, handle) {
  if (!project || typeof project !== 'object') return null
  if (typeof handle === 'string' && handle.length > 0) return `path:${handle}`
  if (handle && typeof handle === 'object') return handle
  if (typeof project.path === 'string' && project.path.length > 0) return `path:${project.path}`
  if (identityValue(project.id)) return `id:${JSON.stringify(project.id)}`
  const created = project.created ?? project.createdAt
  if (identityValue(created)) return `created:${JSON.stringify(created)}`
  return project
}
