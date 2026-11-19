// Where a music video shot sits in the song, and on its timeline layer.
//
// Found 2026-11-13 on a slow show tune: one sung line lasted 16 seconds. The
// script put a singing shot six seconds into that line, but the planner sent
// it to the line's first word, on top of the two shots before it, and left a
// hole where it should have been.

// A singing shot is normally moved to the first word of its line, because a
// script's own time is often a little off. But when the script's time is well
// inside a long line, the script means "this part of the line", so it stays.
export const LONG_LINE_SECONDS = 3

export function scriptTimeBelongsInsideLine(scriptStart, line, timedLines = []) {
  const wanted = Number(scriptStart)
  const lineStart = Number(line?.startSec)
  if (scriptStart === null || scriptStart === undefined || !Number.isFinite(wanted) || !Number.isFinite(lineStart)) return false
  if (wanted - lineStart < LONG_LINE_SECONDS) return false
  // The line lasts until the next one starts (or its own end, if it has one).
  const laterStarts = (Array.isArray(timedLines) ? timedLines : [])
    .map((other) => Number(other?.startSec))
    .filter((start) => Number.isFinite(start) && start > lineStart)
  const lineEnd = Number.isFinite(Number(line?.endSec)) && Number(line.endSec) > lineStart
    ? Number(line.endSec)
    : (laterStarts.length ? Math.min(...laterStarts) : Infinity)
  return wanted < lineEnd
}

// Clips on one layer must not sit on top of each other. Where a clip runs into
// the next one, it is cut short to end where the next begins. A clip that would
// be left shorter than `minDuration` keeps that much, and the next clip starts
// where it was told to: its place in the song matters more than a tidy edge.
export function trimOverlapsOnLayer(rows = [], minDuration = 0.5) {
  const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) => (a.row.startTime - b.row.startTime) || (a.index - b.index))
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const current = ordered[i].row
    const next = ordered[i + 1].row
    const room = next.startTime - current.startTime
    if (current.startTime + current.duration > next.startTime + 1e-6) current.duration = Math.max(minDuration, room)
  }
  return rows
}

// The ready cut: one layer that plays as a finished video, for people who do
// not want to edit. Asked for on 2026-11-13.
//
//  - Every sung line gets one take. The takes alternate (main, extra, main,
//    extra) so the look changes from line to line; with a few lines, a random
//    pick often lands on the same look every time.
//  - Shots from the main script with no singing stay where the script put them.
//  - Each gap is filled with shots that have nobody singing in them (place
//    shots, story shots, details), cut to fit. A sung line is never covered.
//
// Each row is { startTime, duration, role, sync, spare } where role is 'main',
// 'take' or 'fill', sync is true when the lips follow the song, and spare is
// how many more seconds the clip's file has after its end. Rows are copied,
// never changed. Shots left over are simply not used, as in any edit.
export const SAME_LINE_SECONDS = 0.3
export const SMALLEST_FILL_SECONDS = 0.4

export function buildReadyCut(rows = [], { songDuration = 0, minDuration = 0.5 } = {}) {
  const byStart = (a, b) => a.startTime - b.startTime
  const main = rows.filter((row) => row.role === 'main').sort(byStart)
  const takes = rows.filter((row) => row.role === 'take').sort(byStart)
  const fills = rows.filter((row) => row.role === 'fill').sort(byStart)

  const cut = []
  const takenTakes = new Set()
  let line = 0
  for (const row of main) {
    if (!row.sync) { cut.push({ ...row }); continue }
    // The same line, sung in each extra take.
    const same = takes.filter((take) => take.sync && !takenTakes.has(take) && Math.abs(take.startTime - row.startTime) <= SAME_LINE_SECONDS)
    same.forEach((take) => takenTakes.add(take))
    const choices = [row, ...same]
    cut.push({ ...choices[line % choices.length] })
    line += 1
  }
  // A line that only an extra take has (its main shot was never made).
  for (const take of takes) {
    if (takenTakes.has(take) || !take.sync) continue
    const end = take.startTime + take.duration
    if (!cut.some((row) => row.startTime < end - 1e-6 && take.startTime < row.startTime + row.duration - 1e-6)) cut.push({ ...take })
  }
  cut.sort(byStart)
  trimOverlapsOnLayer(cut, minDuration)

  // A sliver too short to fill would flash black. The clip before it plays a
  // little longer if it has more to show (`spare` seconds); failing that, a
  // clip with no singing starts that much sooner.
  for (let i = 0; i < cut.length - 1; i += 1) {
    const before = cut[i]
    const after = cut[i + 1]
    const sliver = after.startTime - (before.startTime + before.duration)
    if (sliver <= 1e-6 || sliver >= SMALLEST_FILL_SECONDS) continue
    if ((Number(before.spare) || 0) >= sliver - 1e-6) { before.duration += sliver; before.spare -= sliver }
    else if (!after.sync && (Number(after.spare) || 0) >= sliver - 1e-6) { after.startTime -= sliver; after.duration += sliver; after.spare -= sliver }
  }

  // The gaps, start to end of the song.
  const end = Math.max(Number(songDuration) || 0, ...cut.map((row) => row.startTime + row.duration), 0)
  const gaps = []
  let cursor = 0
  for (const row of cut) {
    if (row.startTime - cursor >= SMALLEST_FILL_SECONDS) gaps.push([cursor, row.startTime])
    cursor = Math.max(cursor, row.startTime + row.duration)
  }
  if (end - cursor >= SMALLEST_FILL_SECONDS) gaps.push([cursor, end])

  const unused = fills.slice()
  for (const [gapStart, gapEnd] of gaps) {
    let at = gapStart
    while (gapEnd - at >= SMALLEST_FILL_SECONDS && unused.length > 0) {
      // The shot the script put at this moment, if there is one; each shot is used once.
      const overlap = (row) => Math.min(gapEnd, at + row.duration, row.startTime + row.duration) - Math.max(at, row.startTime)
      let pick = 0
      unused.forEach((row, index) => { if (overlap(row) > overlap(unused[pick]) + 1e-6) pick = index })
      const [row] = unused.splice(pick, 1)
      const duration = Math.min(row.duration, gapEnd - at)
      cut.push({ ...row, startTime: at, duration })
      at += duration
    }
  }
  return cut.sort(byStart)
}
