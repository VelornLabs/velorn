// Groups the shots of a music video script for the keyframe (and later video)
// screens: first by pass (main sequence, performance pass, b-roll, ...), then
// inside a pass by the part of the song each shot falls in.
//
// Shots are referred to by their position in the flat shot list, because the
// rest of the screen (selection, run, replace) works with those positions.

// One entry per pass, in the order the script introduces them.
export function groupShotsByPass(shots, getLabel) {
  const passes = []
  const byKey = new Map()
  ;(shots || []).forEach((entry, index) => {
    const label = String(getLabel?.(entry) || '').trim() || 'Shots'
    const key = label.toLowerCase()
    let pass = byKey.get(key)
    if (!pass) {
      pass = { key, label, indexes: [] }
      byKey.set(key, pass)
      passes.push(pass)
    }
    pass.indexes.push(index)
  })
  return passes
}

function partAt(parts, seconds) {
  let found = -1
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].start <= seconds + 0.05) found = index
    else break
  }
  return found
}

// Splits one pass into runs of shots that sit in the same part of the song.
// `parts` come from describeSongParts ({ label, kind, start, end }). Shots are
// taken in time order; without parts or times there is one unnamed section.
export function groupPassBySongPart(indexes, shots, parts, getStart) {
  const list = Array.isArray(indexes) ? indexes : []
  const songParts = Array.isArray(parts) ? parts : []
  const startOf = (index) => {
    const value = Number(getStart?.(shots[index]))
    return Number.isFinite(value) ? value : null
  }
  if (!songParts.length || list.every((index) => startOf(index) === null)) {
    return list.length ? [{ key: 'all', label: '', kind: '', start: null, indexes: [...list] }] : []
  }
  const ordered = [...list].sort((a, b) => (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity) || a - b)
  const sections = []
  for (const index of ordered) {
    const start = startOf(index)
    const partIndex = start === null ? -2 : partAt(songParts, start)
    const last = sections[sections.length - 1]
    if (last && last.partIndex === partIndex) { last.indexes.push(index); continue }
    const part = partIndex >= 0 ? songParts[partIndex] : null
    sections.push({
      key: `${partIndex}-${sections.length}`,
      partIndex,
      label: part ? part.label : partIndex === -1 ? 'Before the first line' : 'No time set',
      kind: part ? part.kind : '',
      start: part ? part.start : start,
      indexes: [index],
    })
  }
  return sections
}
