// Cuts text into pieces the built-in voice model can speak one at a time.
// The model handles a sentence or two well and loses the thread on long runs,
// so sentences are kept whole and packed together up to `max` characters; a
// single sentence longer than that is cut at a comma, or failing that a space.
export function splitForSpeech(text, max = 280) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [clean]
  const pieces = []
  const add = part => { const value = part.trim(); if (value) pieces.push(value) }
  let current = ''
  for (const sentence of sentences) {
    if ((current + sentence).length <= max) { current += sentence; continue }
    add(current); current = ''
    let rest = sentence
    while (rest.length > max) {
      const window = rest.slice(0, max)
      const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '))
      const cut = comma > max * 0.4 ? comma + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : max
      add(rest.slice(0, cut)); rest = rest.slice(cut)
    }
    current = rest
  }
  add(current)
  return pieces
}
