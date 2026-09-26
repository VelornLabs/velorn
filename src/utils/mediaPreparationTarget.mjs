// Queued work can finish after an asset was removed/relinked or a project was
// closed. Its cache may safely remain on disk, but must not update another asset.
const activeTargets = new Map()

function sourceIdentity(asset) {
  return JSON.stringify([
    asset?.id, asset?.type, asset?.path, asset?.absolutePath,
    asset?.url, asset?.settings?.hasAlpha,
  ])
}

export function createMediaPreparationTarget({ projectDir, assetId, kind, projectStore, assetsStore, deferClaim = false }) {
  const key = JSON.stringify([projectDir, assetId, kind])
  const token = Symbol(key)
  const initialAsset = assetsStore.getState().assets.find(asset => asset.id === assetId)
  const identity = sourceIdentity(initialAsset)
  let invalidated = !initialAsset || projectStore.getState().currentProjectHandle !== projectDir
  let claimed = false
  const claim = () => {
    if (invalidated) return false
    claimed = true
    activeTargets.set(key, token)
    return true
  }
  if (!deferClaim) claim()
  const unsubscribe = projectStore.subscribe(state => {
    if (state.currentProjectHandle !== projectDir) invalidated = true
  })

  return {
    asset: initialAsset,
    claim,
    isCurrent: () => !invalidated
      && (!claimed || activeTargets.get(key) === token)
      && projectStore.getState().currentProjectHandle === projectDir
      && identity === sourceIdentity(assetsStore.getState().assets.find(asset => asset.id === assetId)),
    release: () => {
      invalidated = true
      unsubscribe()
      if (claimed && activeTargets.get(key) === token) activeTargets.delete(key)
    },
  }
}
