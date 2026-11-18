'use strict'
// A first, plain check on the description of a Velorn network job. It runs in
// Velorn on BOTH computers: before the job leaves the person who wrote it, and
// again on the host before anything is accepted. The host's check is the one
// that counts.
//
// It is a word list, so it is easy to word around and it will sometimes refuse
// something innocent. It is a floor, not the whole answer: the host can also
// read every job and can ask to approve each one. It does not look at pictures.
//
// Rule: nudity and sexual acts are refused. Revealing clothes or a flirty mood,
// the level of an ordinary music video, are fine (SUGGESTIVE below is allowed on
// its own). Anything that sexualises a minor, suggestive words included, is
// refused with its own reason and no further detail.
const EXPLICIT = ['nude', 'nudes', 'nudity', 'naked', 'nsfw', 'porn', 'porno', 'pornographic', 'pornography', 'xxx', 'hentai', 'erotic', 'erotica',
  'sex', 'sexual', 'sexually', 'intercourse', 'orgasm', 'masturbate', 'masturbating', 'masturbation', 'blowjob', 'handjob', 'cumshot', 'creampie',
  'topless', 'bottomless', 'undress', 'undressed', 'undressing', 'unclothed', 'stripping', 'striptease', 'stripper', 'fetish', 'bdsm', 'bondage',
  'genitals', 'genitalia', 'penis', 'vagina', 'vulva', 'nipple', 'nipples', 'breasts', 'boobs', 'tits', 'buttocks', 'anus', 'anal', 'cock', 'pussy',
  'horny', 'aroused', 'arousal', 'lewd', 'upskirt', 'camel toe', 'cameltoe', 'onlyfans', 'prostitute', 'hooker', 'deepfake nude']
const SUGGESTIVE = ['sexy', 'lingerie', 'seductive', 'seduce', 'thong', 'cleavage', 'twerk', 'twerking', 'sensual', 'provocative']
const MINOR = ['child', 'children', 'kid', 'kids', 'minor', 'minors', 'underage', 'under age', 'teen', 'teens', 'teenage', 'teenager', 'preteen', 'pre teen',
  'toddler', 'baby', 'infant', 'schoolgirl', 'schoolboy', 'school girl', 'school boy', 'little girl', 'little boy', 'young girl', 'young boy', 'loli', 'lolicon', 'shota', 'shotacon', 'jailbait']
// A few of the plainest ways of spelling around a list.
const LOOKALIKE = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' }

function normalize(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[0134578@$!]/g, character => LOOKALIKE[character] || character)
    .replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim()
}
const has = (words, text) => words.some(word => new RegExp(`(?:^| )${word.replace(/ /g, ' ?')}(?: |$)`).test(text))
// Letters spaced or dotted apart ("n u d e", "a n.u.d.e") are read as one run,
// and a listed word anywhere inside such a run counts.
const runs = text => (` ${text} `.match(/(?: [a-z]){3,}(?= )/g) || []).map(run => run.replace(/ /g, ''))
const spelled = (words, text) => { const found = runs(text); return found.length > 0 && words.some(word => word.length >= 3 && !word.includes(' ') && found.some(run => run.includes(word))) }

// { ok: true } or { ok: false, code, reason }. The reason never repeats the description.
function checkPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, code: 'GPU_SHARE_FILTER_EMPTY', reason: 'There is no description to check.' }
  const text = normalize(prompt)
  const explicit = has(EXPLICIT, text) || spelled(EXPLICIT, text), minor = has(MINOR, text) || spelled(MINOR, text)
  if (minor && (explicit || has(SUGGESTIVE, text) || spelled(SUGGESTIVE, text))) return { ok: false, code: 'GPU_SHARE_FILTER_MINOR', reason: 'This description is not allowed on the Velorn network.' }
  if (explicit) return { ok: false, code: 'GPU_SHARE_FILTER_EXPLICIT', reason: 'Sexually explicit descriptions are not allowed on the Velorn network.' }
  return { ok: true }
}

module.exports = { checkPrompt }
