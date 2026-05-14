const approxLte = (a, b, epsilon = 1e-6) => a <= b + epsilon

export const getClipCoverageSpans = ({ segments, clipStart, clipEnd }) => {
  const overlaps = []
  for (const segment of segments || []) {
    if (segment.end > clipStart && segment.start < clipEnd) {
      overlaps.push({
        start: Math.max(segment.start, clipStart),
        end: Math.min(segment.end, clipEnd),
      })
    }
  }

  overlaps.sort((a, b) => a.start - b.start)
  const merged = []
  for (const overlap of overlaps) {
    if (!merged.length || overlap.start > merged[merged.length - 1].end + 1e-6) {
      merged.push({ ...overlap })
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, overlap.end)
    }
  }
  return merged
}

export const findMissingClipCoverage = ({ segments, clips }) => {
  const missing = []
  for (const clip of clips || []) {
    if (!clip) continue
    const clipStart = Number(clip.startTime) || 0
    const clipEnd = clipStart + Math.max(0, Number(clip.duration) || 0)
    const coverage = getClipCoverageSpans({ segments, clipStart, clipEnd })
    let cursor = clipStart
    let missingRange = null
    for (const span of coverage) {
      if (span.start > cursor + 1e-6) {
        missingRange = { start: cursor, end: span.start }
        break
      }
      cursor = Math.max(cursor, span.end)
      if (approxLte(clipEnd, cursor)) break
    }
    if (!missingRange && cursor < clipEnd - 1e-6) {
      missingRange = { start: cursor, end: clipEnd }
    }
    if (missingRange) {
      missing.push({
        clip,
        missingRange,
        coverage,
      })
    }
  }
  return missing
}

export const validateSegmentsCoverClips = ({ segments, clips }) => {
  const missingClips = findMissingClipCoverage({ segments, clips })
  return {
    ok: missingClips.length === 0,
    missingClips,
  }
}

