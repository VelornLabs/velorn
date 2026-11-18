// Places for a music video: a named location with one picture and a note,
// kept beside the cast. A shot names its place with a "Place:" line in the
// script, and that place's picture is sent with the shot's keyframe so the
// room looks the same from shot to shot.
//
// Tested 2026-11-11 with FLUX.2 klein: the room and the character both held
// across three shots. Wide shots tend to copy the place picture's camera
// angle. See docs/DIRECTOR_DIRECTION.md.

export function placeSlug(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function normalizePlaces(saved) {
  return (Array.isArray(saved) ? saved : [])
    .map((entry, index) => {
      const label = String(entry?.label || '').trim()
      return {
        id: String(entry?.id || `place-${Date.now()}-${index}`),
        label,
        slug: placeSlug(entry?.slug || label),
        assetId: entry?.assetId ?? null,
        notes: String(entry?.notes || '').trim(),
        pendingJobTag: String(entry?.pendingJobTag || ''),
      }
    })
    .filter((entry) => entry.assetId || entry.label || entry.pendingJobTag)
}

export function newPlace({ label = '', assetId = null, notes = '', pendingJobTag = '' } = {}, existing = []) {
  const name = String(label || '').trim() || `Place ${existing.length + 1}`
  let slug = placeSlug(name) || `place_${existing.length + 1}`
  const taken = new Set(existing.map((entry) => entry.slug))
  for (let n = 2; taken.has(slug); n += 1) slug = `${placeSlug(name) || 'place'}_${n}`
  return { id: `place-${Date.now()}-${existing.length}`, label: name, slug, assetId, notes: String(notes || '').trim(), pendingJobTag }
}

// A file name turned into a place name: "cave_living-room.png" -> "cave living room".
export function placeNameFromFile(fileName) {
  return String(fileName || '').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// The place a script shot asks for, matched by short name or by name.
export function findPlace(raw, places) {
  const wanted = placeSlug(raw)
  if (!wanted) return null
  const list = Array.isArray(places) ? places : []
  return list.find((entry) => entry.slug === wanted)
    || list.find((entry) => placeSlug(entry.label) === wanted)
    || null
}

// The keyframe queue has two picture slots. People come first; the place takes
// a slot that is left over.
export function withPlacePicture(peopleAssetIds, placeAssetId) {
  const people = (Array.isArray(peopleAssetIds) ? peopleAssetIds : []).filter(Boolean).slice(0, 2)
  if (!placeAssetId || people.includes(placeAssetId)) return { assetIds: people, placeUsed: false }
  if (people.length >= 2) return { assetIds: people, placeUsed: false }
  return { assetIds: [...people, placeAssetId], placeUsed: true }
}

// Added to the end of the keyframe text when the place's picture is attached.
export const PLACE_HINT_START = 'Keep the same place as'
export function placeHint(place) {
  return place?.label ? `${PLACE_HINT_START} the reference picture of ${place.label}.` : ''
}

// What the script writer is told about the places.
export function placesBriefBlock(places) {
  const list = (Array.isArray(places) ? places : []).filter((entry) => entry?.slug)
  if (list.length === 0) return ''
  return [
    'Places: add a "Place: <short name>" line to every shot filmed in one of these, using these exact short names:',
    ...list.map((entry) => `  - ${entry.slug}: ${entry.label}${entry.notes ? ` (${entry.notes})` : ''}`),
    'Leave the Place: line out for a shot filmed anywhere else. Still describe the location in the Keyframe prompt.',
    // The three rules below come from the 2026-11-11 test and the two-picture limit.
    'Inside one place, change the camera position from shot to shot and say where the camera is in the Keyframe prompt (for example "from behind the armchair", "low by the fire", "close on the face"), so the shots do not all look like the same picture.',
    'A shot can carry two reference pictures. With two people in a shot the place picture is not sent, so describe the place fully in words there, and prefer one person per shot inside a place.',
    'Give each place one opening shot with nobody in it (a b_roll shot with its Place: line), early in the video.',
  ].join('\n')
}
