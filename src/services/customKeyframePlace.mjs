// A person's own keyframe workflow can have a picture input just for the place
// a shot is filmed in: a LoadImage node named VELORN_PLACE_IMAGE.
//
// With that node, the two reference inputs carry people only and the place
// always arrives in its own input, even on a shot with two people. Without it,
// nothing changes: the place shares the two reference inputs when one is free.

export const CUSTOM_PLACE_IMAGE_ENDPOINT = 'VELORN_PLACE_IMAGE'

// `referenceIds` and `referenceFilenames` are the two reference slots, in
// order: the picture ids the shot asked for, and the files sent to ComfyUI.
export function splitPlaceFromReferences({
  referenceIds = [],
  referenceFilenames = [],
  placeAssetId = '',
  hasPlaceInput = false,
} = {}) {
  const files = Array.isArray(referenceFilenames) ? referenceFilenames : []
  if (!hasPlaceInput || !placeAssetId) return { referenceFilenames: files, sendPlace: false }
  const ids = Array.isArray(referenceIds) ? referenceIds : []
  // The place leaves the people's inputs, and the people close ranks.
  const people = files.filter((name, index) => name && ids[index] !== placeAssetId)
  return { referenceFilenames: people, sendPlace: true }
}

// A picture input that a shot does not use must not feed an old leftover
// picture into the result. This switches such inputs off for one run.
//
// The unused Load Image nodes are taken out. Anything that cannot work without
// them goes too (the resize, the encode), and a node that merely accepts them
// as an extra, such as Set Reference Latent, carries on without. If that would
// take out a node that must stay (the one that saves the picture), nothing is
// changed at all: the workflow runs exactly as the person built it.
//
// `nodeInfo` is ComfyUI's own description of each node type, which says which
// inputs are optional.
export function switchOffUnusedPictureInputs(workflow, unusedNodeIds = [], nodeInfo = {}, keepNodeIds = []) {
  const unchanged = { workflow, switchedOff: [] }
  const unused = (Array.isArray(unusedNodeIds) ? unusedNodeIds : []).map(String).filter((id) => workflow?.[id])
  if (!workflow || unused.length === 0) return unchanged

  const gone = new Set(unused)
  const loose = [] // [nodeId, inputName] links that can simply be let go
  const isOptional = (node, inputName) => Boolean(nodeInfo?.[node?.class_type]?.input?.optional
    && Object.prototype.hasOwnProperty.call(nodeInfo[node.class_type].input.optional, inputName))

  let changed = true
  while (changed) {
    changed = false
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (gone.has(nodeId) || !node || typeof node !== 'object') continue
      for (const [inputName, value] of Object.entries(node.inputs || {})) {
        if (!Array.isArray(value) || !gone.has(String(value[0]))) continue
        if (isOptional(node, inputName)) continue
        gone.add(nodeId)
        changed = true
        break
      }
    }
  }
  if (keepNodeIds.map(String).some((id) => gone.has(id))) return unchanged

  const next = {}
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (gone.has(nodeId)) continue
    const copy = JSON.parse(JSON.stringify(node))
    for (const [inputName, value] of Object.entries(copy?.inputs || {})) {
      if (Array.isArray(value) && gone.has(String(value[0]))) {
        delete copy.inputs[inputName]
        loose.push([nodeId, inputName])
      }
    }
    next[nodeId] = copy
  }
  return { workflow: next, switchedOff: unused, loose }
}
