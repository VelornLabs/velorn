// Read-only presentation and stable label allocation. Never loads/decodes media
// and never writes an old project merely because its reference page is opened.
export const MAX_SHOT_NUMBER = 999999
const fail = message => { throw new Error(`Storyboard: ${message}`) }
export const formatStoryboardShotLabel = number => `Shot ${String(number).padStart(2, '0')}`
export function parseStoryboardShotLabel(label) {
  if (typeof label !== 'string' || !/^Shot (?:0[1-9]|[1-9]\d{1,5})$/.test(label)) fail('label must be a stable Shot 01-style label.')
  const number = Number(label.slice(5))
  if (number > MAX_SHOT_NUMBER) fail('Shot label is outside the supported range.')
  return number
}

export function getStoryboardLabelAllocation(board) {
  const labels = new Map()
  const used = new Set()
  let next = 1
  for (const shot of board?.shots || []) {
    if (shot.label === undefined) continue
    const number = parseStoryboardShotLabel(shot.label)
    if (used.has(number)) fail('Shot labels must not contain duplicates.')
    used.add(number)
    labels.set(shot.id, shot.label)
    next = Math.max(next, number + 1)
  }
  if (board?.nextShotNumber !== undefined) {
    if (!Number.isSafeInteger(board.nextShotNumber) || board.nextShotNumber < next || board.nextShotNumber > MAX_SHOT_NUMBER + 1) {
      fail('nextShotNumber must be an unused positive shot number above all saved labels.')
    }
    next = board.nextShotNumber
  }
  for (const shot of board?.shots || []) {
    if (labels.has(shot.id)) continue
    if (next > MAX_SHOT_NUMBER) fail('No unused shot labels remain.')
    labels.set(shot.id, formatStoryboardShotLabel(next++))
  }
  return { labels, nextShotNumber: next }
}

export function getStoryboardShotLabel(board, shotOrId) {
  const shotId = typeof shotOrId === 'string' ? shotOrId : shotOrId?.id
  return getStoryboardLabelAllocation(board).labels.get(shotId) || 'Shot'
}

export function materializeStoryboardShotLabels(board, allocation) {
  let next = allocation.nextShotNumber
  const shots = board.shots.map(shot => {
    let label = allocation.labels.get(shot.id)
    if (!label) {
      if (next > MAX_SHOT_NUMBER) fail('No unused shot labels remain.')
      label = formatStoryboardShotLabel(next++)
    }
    return { ...shot, label }
  })
  return { ...board, shots,
    ...(shots.length || allocation.labels.size || board.nextShotNumber !== undefined ? { nextShotNumber: next } : {}) }
}

export function getStoryboardShotVisual(shot, assets = []) {
  // Presence is intentional: null means no frame; a missing explicit asset
  // stays missing rather than silently displaying a different reference.
  if (Object.hasOwn(shot || {}, 'storyboardAssetId')) {
    const asset = assets.find(entry => entry.id === shot.storyboardAssetId)
    return asset?.type === 'image' ? { assetId: asset.id, source: 'storyboard', asset, type: 'image' } : null
  }
  const selected = shot?.takes?.find(take => take.id === shot.selectedTakeId)
  const candidates = [...(selected ? [{ assetId: selected.assetId, source: 'selected-take' }] : []),
    ...(shot?.referenceAssetIds || []).map(assetId => ({ assetId, source: 'reference' })),
    ...(shot?.takes || []).map(take => ({ assetId: take.assetId, source: 'take' }))]
  for (const candidate of candidates) {
    const asset = assets.find(entry => entry.id === candidate.assetId)
    if (asset?.type === 'image') return { ...candidate, asset, type: 'image' }
  }
  return null
}

// Display-only disambiguation: never rewrite authored names or assign counters
// while reading. A repeated asset ID keeps the same label in every section.
function displayLabels(entries) {
  const unique = new Map(entries.map(entry => [entry.id, entry]))
  const groups = new Map()
  for (const entry of unique.values()) {
    const key = entry.name.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  const labels = new Map()
  for (const group of groups.values()) {
    if (group.length === 1) { labels.set(group[0].id, group[0].name); continue }
    let length = 6
    while (new Set(group.map(entry => entry.id.slice(-length))).size !== group.length) length++
    for (const entry of group) labels.set(entry.id, `${entry.name} · ${entry.id.length > length ? '…' : ''}${entry.id.slice(-length)}`)
  }
  return labels
}

export function getStoryboardPresentation(board, assets = []) {
  const { labels } = getStoryboardLabelAllocation(board)
  const media = new Map(assets.map(asset => [asset.id, asset]))
  const members = board?.production?.cast || [], places = board?.production?.locations || []
  const referenceIds = [...new Set([...(board?.referenceAssetIds || []),
    ...[...members, ...places].flatMap(entity => entity.referenceAssetIds),
    ...(board?.shots || []).flatMap(shot => shot.referenceAssetIds)])]
  const referenceName = assetId => String(media.get(assetId)?.name || assetId).slice(0, 200)
  const referenceLabels = displayLabels(referenceIds.map(id => ({ id, name: referenceName(id) })))
  const castLabels = displayLabels(members.map(member => ({ id: member.id, name: member.name.trim() || 'Unnamed character' })))
  const locationLabels = displayLabels(places.map(location => ({ id: location.id, name: location.name.trim() || 'Unnamed location' })))
  const reference = assetId => {
    const asset = media.get(assetId)
    const name = referenceName(assetId)
    return { assetId, name, displayLabel: referenceLabels.get(assetId) || name, type: asset?.type || null, missing: !asset }
  }
  const cast = members.map(member => ({ memberId: member.id, name: member.name, displayLabel: castLabels.get(member.id),
    role: member.role, description: member.description, references: member.referenceAssetIds.map(reference) }))
  const locations = places.map(location => ({ locationId: location.id, name: location.name, displayLabel: locationLabels.get(location.id),
    description: location.description, references: location.referenceAssetIds.map(reference) }))
  const grouped = new Set([...cast, ...locations].flatMap(entity => entity.references.map(entry => entry.assetId)))
  const shots = (board?.shots || []).map(shot => {
    const still = getStoryboardShotVisual(shot, assets)
    const explicit = Object.hasOwn(shot, 'storyboardAssetId')
    const stillAssetId = explicit ? shot.storyboardAssetId : still?.assetId || null
    if (stillAssetId) grouped.add(stillAssetId)
    const selected = shot.takes.find(take => take.id === shot.selectedTakeId)
    return { shotId: shot.id, label: labels.get(shot.id), title: shot.title, description: shot.description,
      durationSeconds: shot.durationSeconds, stillAssetId, stillSource: explicit ? 'storyboard' : still?.source || null,
      stillMissing: Boolean(stillAssetId && !still), stillName: stillAssetId ? reference(stillAssetId).name : null,
      selectedTakeAssetId: selected?.assetId || null, references: shot.referenceAssetIds.map(reference) }
  })
  const generalIds = [...new Set([...(board?.referenceAssetIds || []),
    ...(board?.shots || []).flatMap(shot => shot.referenceAssetIds).filter(assetId => !grouped.has(assetId))])]
  return { shots, cast, locations, references: generalIds.map(reference) }
}
