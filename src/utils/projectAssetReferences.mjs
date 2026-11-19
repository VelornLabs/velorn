// Asset references can live in masks/effects as well as the clip's primary
// assetId. Walk the document data, not only its visible top-level clips.
export function collectAssetReferences(value, assetIds = new Set(), seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return assetIds
  seen.add(value)
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey.endsWith('assetid') && typeof entry === 'string' && entry.trim()) {
      assetIds.add(entry.trim())
    } else if (normalizedKey.endsWith('assetids') && Array.isArray(entry)) {
      entry.forEach((id) => { if (typeof id === 'string' && id.trim()) assetIds.add(id.trim()) })
    }
    if (entry && typeof entry === 'object') collectAssetReferences(entry, assetIds, seen)
  }
  return assetIds
}

export function getProjectAssetReferences(projectState = {}, timelineState = {}, { compoundOnly = false } = {}) {
  const assetIds = new Set()
  const project = projectState.currentProject
  // Storyboard references protect files from Trash, while project-only removal
  // remains available under the existing (compound-only) deletion guard.
  // Collect even unsupported future boards conservatively; never normalize or
  // discard unknown authored data just to inspect its references.
  if (!compoundOnly) collectAssetReferences(project?.storyboard, assetIds)
  const currentTimelineId = projectState.currentTimelineId || project?.currentTimelineId
  const context = timelineState.compoundEditContext
  const collectClips = (clips, insideCompound = false) => {
    for (const clip of Array.isArray(clips) ? clips : []) {
      if (!compoundOnly || insideCompound) collectAssetReferences(clip, assetIds)
      else if (clip?.type === 'compound') collectAssetReferences(clip, assetIds)
    }
  }

  for (const timeline of project?.timelines || []) {
    if (!currentTimelineId || timeline?.id !== currentTimelineId) collectClips(timeline?.clips)
  }
  if (context) {
    // The active store contains the child document. Account for the rest of
    // its parent timeline too, without calling validation/serialization (the
    // child may currently contain an edit that Back correctly refuses).
    collectClips((context.parentDocument?.clips || []).filter((clip) => clip?.id !== context.compoundClipId))
    collectClips(timelineState.clips, true)
  } else {
    collectClips(timelineState.clips)
  }
  return assetIds
}

export function getCompoundAssetDeletionGuard(assetIds, projectState, timelineState) {
  const referenced = getProjectAssetReferences(projectState, timelineState, { compoundOnly: true })
  const blockedAssetIds = [...new Set(assetIds || [])].filter((id) => referenced.has(id))
  return blockedAssetIds.length
    ? { ok: false, assetIds: blockedAssetIds, reason: 'This media is used inside a compound clip. Open Contents and remove its uses before deleting the asset or its folder.' }
    : { ok: true, assetIds: [] }
}
