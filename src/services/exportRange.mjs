const isFiniteNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))

const normalizeRangeBound = (value, fallback = null) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

export function resolveExportRange({
  rangeMode = 'full',
  inPoint = null,
  outPoint = null,
  selectedClipIds = [],
  clips = [],
  getTimelineEndTime = () => 0,
} = {}) {
  const safeMode = String(rangeMode || 'full')

  if (safeMode === 'inout') {
    if (!isFiniteNumber(inPoint) || !isFiniteNumber(outPoint)) {
      throw new Error('Export range is set to In/Out, but both In and Out points must be defined.')
    }
    const start = Math.min(Number(inPoint), Number(outPoint))
    const end = Math.max(Number(inPoint), Number(outPoint))
    if (!(end > start)) {
      throw new Error('Export range is set to In/Out, but the range is empty.')
    }
    return { start, end, mode: safeMode }
  }

  if (safeMode === 'selection') {
    const selectedIds = new Set((Array.isArray(selectedClipIds) ? selectedClipIds : []).filter(Boolean))
    const selected = (Array.isArray(clips) ? clips : []).filter((clip) => clip && selectedIds.has(clip.id))
    if (selected.length === 0) {
      throw new Error('Export range is set to Selection, but no clips are currently selected.')
    }
    const start = Math.min(...selected.map((clip) => normalizeRangeBound(clip.startTime, 0)))
    const end = Math.max(...selected.map((clip) => {
      const clipStart = normalizeRangeBound(clip.startTime, 0)
      const clipDuration = Math.max(0, normalizeRangeBound(clip.duration, 0))
      return clipStart + clipDuration
    }))
    if (!(end > start)) {
      throw new Error('Export range is set to Selection, but the selected clips produce an empty range.')
    }
    return { start, end, mode: safeMode }
  }

  const start = 0
  const end = Math.max(0, Number(getTimelineEndTime?.()) || 0)
  return { start, end, mode: 'full' }
}

export function getSelectionScopedExportClips({
  clips = [],
  selectedClipIds = [],
  rangeStart = 0,
  rangeEnd = 0,
} = {}) {
  const safeStart = Math.max(0, Number(rangeStart) || 0)
  const safeEnd = Math.max(safeStart, Number(rangeEnd) || 0)
  const selectedIds = new Set((Array.isArray(selectedClipIds) ? selectedClipIds : []).filter(Boolean))
  const clipList = Array.isArray(clips) ? clips : []
  const selectedClips = clipList.filter((clip) => clip && selectedIds.has(clip.id))
  const globalOverlayClips = clipList.filter((clip) => {
    if (!clip) return false
    if (clip.type !== 'adjustment') return false
    const clipStart = Number(clip.startTime) || 0
    const clipEnd = clipStart + Math.max(0, Number(clip.duration) || 0)
    return clipEnd > safeStart && clipStart < safeEnd
  })

  const merged = new Map()
  for (const clip of [...selectedClips, ...globalOverlayClips]) {
    if (clip?.id && !merged.has(clip.id)) {
      merged.set(clip.id, clip)
    }
  }
  return [...merged.values()]
}

export default resolveExportRange
