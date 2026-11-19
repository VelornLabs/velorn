// Timed-lyric helpers for the music video song screen. The lyrics travel as
// an SRT string (what the Director plan already reads); these helpers turn it
// into lines, let the screen nudge and fix them, and turn it back.

const round2 = (value) => Math.round(value * 100) / 100
const UNSURE_CONFIDENCE = 0.15

function parseSrtTime(text) {
  const match = String(text || '').trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!match) return null
  const [, hh, mm, ss, ms] = match
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000
}

function formatSrtTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000))
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)},${pad(total % 1000, 3)}`
}

export function parseSrtLines(srt) {
  const lines = []
  for (const block of String(srt || '').replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n').map((row) => row.trim()).filter(Boolean)
    const timingIndex = rows.findIndex((row) => row.includes('-->'))
    if (timingIndex < 0) continue
    const [from, to] = rows[timingIndex].split('-->')
    const start = parseSrtTime(from)
    const end = parseSrtTime(to)
    const text = rows.slice(timingIndex + 1).join(' ').trim()
    if (start === null || end === null || !text) continue
    lines.push({ start, end: Math.max(end, start + 0.1), text })
  }
  return lines.sort((a, b) => a.start - b.start)
}

export function formatSrtLines(lines) {
  return (lines || [])
    .map((line, index) => `${index + 1}\n${formatSrtTime(line.start)} --> ${formatSrtTime(line.end)}\n${line.text}\n`)
    .join('\n')
}

// Reads either an SRT file or a song map (JSON with rows of start/end/text
// and an optional confidence). Returns the lines and which ones to check.
export function readLyricFile(text) {
  const source = String(text || '').trim()
  if (source.startsWith('{') || source.startsWith('[')) {
    let data = null
    try { data = JSON.parse(source) } catch { return { lines: [], unsure: [], error: 'This file could not be read.' } }
    const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : Array.isArray(data?.lines) ? data.lines : []
    const kept = rows
      .map((row) => ({ start: Number(row?.start), end: Number(row?.end), text: String(row?.text || '').trim(), conf: Number(row?.conf) }))
      .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.text)
      .sort((a, b) => a.start - b.start)
    return {
      lines: kept.map(({ start, end, text: lineText }) => ({ start, end: Math.max(end, start + 0.1), text: lineText })),
      unsure: kept.map((row, index) => (Number.isFinite(row.conf) && row.conf < UNSURE_CONFIDENCE ? index : -1)).filter((index) => index >= 0),
      error: kept.length ? null : 'No timed lyrics were found in this file.',
    }
  }
  const lines = parseSrtLines(source)
  return { lines, unsure: [], error: lines.length ? null : 'No timed lyrics were found in this file.' }
}

export function shiftAllLines(lines, deltaSeconds) {
  const delta = Number(deltaSeconds) || 0
  return (lines || []).map((line) => {
    const start = Math.max(0, round2(line.start + delta))
    return { ...line, start, end: Math.max(start + 0.1, round2(line.end + delta)) }
  })
}

// Moves one line so it starts at `seconds`, keeping its length, and keeps it
// between its neighbours so the order never changes.
export function setLineStart(lines, index, seconds) {
  const list = (lines || []).map((line) => ({ ...line }))
  const line = list[index]
  if (!line) return list
  const previous = list[index - 1]
  const next = list[index + 1]
  const length = Math.max(0.5, line.end - line.start)
  let start = Math.max(0, Number(seconds) || 0)
  if (previous) start = Math.max(start, previous.start + 0.1)
  if (next) start = Math.min(start, next.start - 0.1)
  line.start = round2(start)
  line.end = round2(next ? Math.min(start + length, Math.max(start + 0.1, next.start)) : start + length)
  if (previous && previous.end > line.start) previous.end = line.start
  return list
}

export function setLineText(lines, index, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return lines
  return (lines || []).map((line, lineIndex) => (lineIndex === index ? { ...line, text: clean } : line))
}

const lyricKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()

// A line sung three or more times is treated as chorus.
export function findChorusLines(lines) {
  const counts = new Map()
  for (const line of lines || []) {
    const key = lyricKey(line.text)
    if (key) counts.set(key, (counts.get(key) || 0) + 1)
  }
  return (lines || []).map((line) => (counts.get(lyricKey(line.text)) || 0) >= 3)
}

// Stretches of singing for the song strip: lines closer than `maxGap` seconds
// join into one stretch, and a stretch splits where chorus turns into verse.
export function buildSongSections(lines, { maxGap = 2.5 } = {}) {
  const chorus = findChorusLines(lines)
  const sections = []
  ;(lines || []).forEach((line, index) => {
    const kind = chorus[index] ? 'chorus' : 'verse'
    const last = sections[sections.length - 1]
    if (last && last.kind === kind && line.start - last.end <= maxGap) {
      last.end = Math.max(last.end, line.end)
      last.lastLine = index
    } else {
      if (last && line.start - last.end <= maxGap) last.end = Math.min(last.end, line.start)
      sections.push({ kind, start: line.start, end: line.end, firstLine: index, lastLine: index })
    }
  })
  return sections
}

export function findLineAt(lines, seconds) {
  let current = -1
  for (let index = 0; index < (lines || []).length; index += 1) {
    if (lines[index].start <= seconds) current = index
    else break
  }
  return current
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---------- song parts (verse, chorus, ...) ----------
// A part is { kind, firstLine }: it covers the lines from `firstLine` up to
// the next part. Velorn guesses them; the user corrects them.

export const SONG_PART_KINDS = ['verse', 'chorus', 'bridge', 'intro', 'outro']

export function guessSongParts(lines) {
  return buildSongSections(lines).map((section) => ({ kind: section.kind, firstLine: section.firstLine }))
}

// Returns usable parts for `lineCount` lines, or null when the saved parts do
// not fit these lyrics (so the caller falls back to a fresh guess).
export function normalizeSongParts(parts, lineCount) {
  if (!Array.isArray(parts) || !(lineCount > 0)) return null
  const seen = new Set()
  const clean = parts
    .map((part) => ({ kind: SONG_PART_KINDS.includes(part?.kind) ? part.kind : 'verse', firstLine: Number(part?.firstLine) }))
    .filter((part) => Number.isInteger(part.firstLine) && part.firstLine >= 0 && part.firstLine < lineCount)
    .sort((a, b) => a.firstLine - b.firstLine)
    .filter((part) => (seen.has(part.firstLine) ? false : seen.add(part.firstLine)))
  if (!clean.length || clean[0].firstLine !== 0) return null
  return clean
}

export function findPartOfLine(parts, lineIndex) {
  let found = -1
  ;(parts || []).forEach((part, index) => { if (part.firstLine <= lineIndex) found = index })
  return found
}

export function setPartKind(parts, partIndex, kind) {
  if (!SONG_PART_KINDS.includes(kind)) return parts
  return (parts || []).map((part, index) => (index === partIndex ? { ...part, kind } : part))
}

// "New part starts here": the new part begins as the same kind as the one it
// was cut from, ready to be renamed.
export function startPartAtLine(parts, lineIndex) {
  const list = parts || []
  if (!(lineIndex > 0) || list.some((part) => part.firstLine === lineIndex)) return list
  const owner = findPartOfLine(list, lineIndex)
  if (owner < 0) return list
  return [...list.slice(0, owner + 1), { kind: list[owner].kind, firstLine: lineIndex }, ...list.slice(owner + 1)]
}

export function joinPartWithAbove(parts, partIndex) {
  if (!(partIndex > 0)) return parts
  return (parts || []).filter((_, index) => index !== partIndex)
}

// Parts with their line range, times and a display name ("Verse 2").
export function describeSongParts(lines, parts) {
  const list = parts || []
  const totals = {}
  for (const part of list) totals[part.kind] = (totals[part.kind] || 0) + 1
  const counters = {}
  return list.map((part, index) => {
    const lastLine = (index + 1 < list.length ? list[index + 1].firstLine : (lines || []).length) - 1
    counters[part.kind] = (counters[part.kind] || 0) + 1
    const name = part.kind.charAt(0).toUpperCase() + part.kind.slice(1)
    return {
      ...part,
      lastLine,
      start: lines[part.firstLine]?.start ?? 0,
      end: lines[lastLine]?.end ?? 0,
      label: part.kind === 'verse' && totals.verse > 1 ? `${name} ${counters.verse}` : name,
    }
  })
}

// "2:29.4", "149.4" or "2:29" -> seconds. Returns null when it is not a time.
export function parseClockInput(text) {
  const source = String(text || '').trim().replace(',', '.')
  const match = source.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const seconds = Number(match[1] || 0) * 60 + Number(match[2])
  return Number.isFinite(seconds) ? seconds : null
}

export function formatClockTenths(seconds) {
  const total = Math.max(0, Math.round((Number(seconds) || 0) * 10) / 10)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`
}

// Removing a line: the lines after it move up one place, so the parts and the
// "check this one" marks that point at line numbers move with them. A part
// that loses its only line disappears.
export function removeLine(lines, parts, unsure, index) {
  const list = lines || []
  if (!(index >= 0 && index < list.length)) return { lines: list, parts: parts || [], unsure: unsure || [] }
  const nextLines = list.filter((_, lineIndex) => lineIndex !== index)
  const seen = new Set()
  const nextParts = (parts || [])
    .map((part) => ({ ...part, firstLine: part.firstLine > index ? part.firstLine - 1 : part.firstLine }))
    .filter((part) => part.firstLine < nextLines.length)
    .reverse()
    .filter((part) => (seen.has(part.firstLine) ? false : seen.add(part.firstLine)))
    .reverse()
  const nextUnsure = (unsure || []).filter((entry) => entry !== index).map((entry) => (entry > index ? entry - 1 : entry))
  return { lines: nextLines, parts: nextParts, unsure: nextUnsure }
}
