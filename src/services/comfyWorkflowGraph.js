function toGraphNodeId(value) {
  const raw = String(value ?? '').trim()
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

function isLinkValue(value, nodeIdSet) {
  if (!Array.isArray(value) || value.length !== 2) return false
  const upstreamId = String(value[0] ?? '').trim()
  if (!upstreamId || !nodeIdSet.has(upstreamId)) return false
  const slot = value[1]
  return Number.isInteger(slot) || (typeof slot === 'string' && slot.length > 0)
}

function getInputSpec(nodeSchema = null, inputName = '') {
  if (!nodeSchema || !inputName) return null
  return (
    nodeSchema?.input?.required?.[inputName]
    || nodeSchema?.input?.optional?.[inputName]
    || null
  )
}

function getSpecType(inputSpec = null) {
  if (!Array.isArray(inputSpec) || inputSpec.length === 0) return '*'
  const base = inputSpec[0]
  if (Array.isArray(base)) return base
  return base ?? '*'
}

function getPortType(inputSpec = null) {
  const type = getSpecType(inputSpec)
  if (Array.isArray(type)) return 'COMBO'
  return type || '*'
}

function inputSpecHasControlAfterGenerate(inputSpec = null) {
  return Boolean(Array.isArray(inputSpec) && inputSpec[1]?.control_after_generate)
}

function inputSpecHasWidget(inputSpec = null) {
  const specType = getSpecType(inputSpec)
  if (Array.isArray(specType)) return true
  return ['BOOLEAN', 'COMBO', 'FLOAT', 'INT', 'STRING'].includes(String(specType || '').toUpperCase())
}

function getDefaultWidgetValue(inputSpec = null) {
  if (!Array.isArray(inputSpec)) return null
  const specType = getSpecType(inputSpec)
  const options = inputSpec[1] && typeof inputSpec[1] === 'object' ? inputSpec[1] : {}
  if (Object.prototype.hasOwnProperty.call(options, 'default')) return cloneJsonValue(options.default)
  if (Array.isArray(specType)) return cloneJsonValue(specType[0] ?? null)
  switch (String(specType || '').toUpperCase()) {
    case 'BOOLEAN':
      return false
    case 'FLOAT':
    case 'INT':
      return 0
    case 'STRING':
      return ''
    default:
      return null
  }
}

function resolveLinkedWidgetValue(inputValue, apiWorkflow = {}, nodeIdSet = new Set()) {
  if (!isLinkValue(inputValue, nodeIdSet)) return undefined
  const sourceNode = apiWorkflow?.[String(inputValue[0])]
  if (!sourceNode?.inputs || typeof sourceNode.inputs !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(sourceNode.inputs, 'value')) {
    return cloneJsonValue(sourceNode.inputs.value)
  }
  for (const value of Object.values(sourceNode.inputs)) {
    if (!isLinkValue(value, nodeIdSet)) return cloneJsonValue(value)
  }
  return undefined
}

function getOrderedInputNames(nodeSchema = null, inputs = {}) {
  const requiredOrder = Array.isArray(nodeSchema?.input_order?.required) ? nodeSchema.input_order.required : []
  const optionalOrder = Array.isArray(nodeSchema?.input_order?.optional) ? nodeSchema.input_order.optional : []
  const declared = [...requiredOrder, ...optionalOrder]
  const seen = new Set()
  const ordered = []

  for (const name of declared) {
    if (seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }

  for (const name of Object.keys(inputs || {})) {
    if (seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }

  return ordered
}

function cloneJsonValue(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function computeNodeDepths(nodeIds = [], incomingByNode = new Map()) {
  const memo = new Map()
  const visiting = new Set()

  const visit = (nodeId) => {
    if (memo.has(nodeId)) return memo.get(nodeId)
    if (visiting.has(nodeId)) return 0
    visiting.add(nodeId)

    const parents = Array.from(incomingByNode.get(nodeId) || [])
    const depth = parents.length === 0
      ? 0
      : Math.max(...parents.map((parentId) => visit(parentId) + 1))

    visiting.delete(nodeId)
    memo.set(nodeId, depth)
    return depth
  }

  for (const nodeId of nodeIds) {
    visit(nodeId)
  }

  return memo
}

function buildNodePositions(nodeIds = [], incomingByNode = new Map()) {
  const depthMap = computeNodeDepths(nodeIds, incomingByNode)
  const indexByDepth = new Map()
  const positions = new Map()

  for (const nodeId of nodeIds) {
    const depth = depthMap.get(nodeId) || 0
    const row = indexByDepth.get(depth) || 0
    indexByDepth.set(depth, row + 1)
    positions.set(nodeId, [
      40 + depth * 420,
      40 + row * 220,
    ])
  }

  return positions
}

function estimateNodeSize(linkInputs = [], outputs = [], widgetValues = []) {
  const visibleRows = Math.max(linkInputs.length, outputs.length, 1)
  const height = 70 + (visibleRows * 24) + (widgetValues.length * 18)
  const width = 320 + Math.min(80, widgetValues.length * 6)
  return [width, Math.max(100, height)]
}

function getGraphNodeId(graphIdByNodeId = null, nodeId) {
  const key = String(nodeId ?? '').trim()
  return graphIdByNodeId?.get(key) ?? toGraphNodeId(key)
}

function buildGraphNodeIdMap(nodeIds = []) {
  const numericIds = nodeIds
    .map((nodeId) => Number(nodeId))
    .filter((nodeId) => Number.isInteger(nodeId) && nodeId > 0)
  const hasNonNumericIds = nodeIds.some((nodeId) => !/^\d+$/.test(String(nodeId ?? '').trim()))
  const hasDuplicateNumericIds = new Set(numericIds).size !== numericIds.length

  if (!hasNonNumericIds && !hasDuplicateNumericIds) {
    return new Map(nodeIds.map((nodeId) => [String(nodeId), Number(nodeId)]))
  }

  let nextGraphId = 1
  return new Map(nodeIds.map((nodeId) => [String(nodeId), nextGraphId++]))
}

function buildWorkflowLinks(apiWorkflow = {}, objectInfo = {}, graphIdByNodeId = null) {
  const nodeIds = Object.keys(apiWorkflow || {})
  const nodeIdSet = new Set(nodeIds)
  const linkInputsByNode = new Map()
  const outputLinksByNode = new Map()
  const incomingByNode = new Map(nodeIds.map((nodeId) => [nodeId, new Set()]))
  const links = []
  let nextLinkId = 1

  for (const targetNodeId of nodeIds) {
    const nodeDef = apiWorkflow?.[targetNodeId] || {}
    const nodeSchema = objectInfo?.[nodeDef.class_type] || null

    for (const [inputName, inputValue] of Object.entries(nodeDef.inputs || {})) {
      if (!isLinkValue(inputValue, nodeIdSet)) continue

      const originNodeId = String(inputValue[0])
      const originSlot = /^\d+$/.test(String(inputValue[1])) ? Number(inputValue[1]) : inputValue[1]
      const inputSpec = getInputSpec(nodeSchema, inputName)
      const link = {
        id: nextLinkId++,
        origin_id: getGraphNodeId(graphIdByNodeId, originNodeId),
        origin_slot: originSlot,
        target_id: getGraphNodeId(graphIdByNodeId, targetNodeId),
        target_slot: inputName,
        type: getPortType(inputSpec),
      }

      links.push(link)

      const targetInputs = linkInputsByNode.get(targetNodeId) || []
      targetInputs.push({
        name: inputName,
        type: getPortType(inputSpec),
        link: link.id,
      })
      linkInputsByNode.set(targetNodeId, targetInputs)

      const sourceSlots = outputLinksByNode.get(originNodeId) || new Map()
      const slotLinks = sourceSlots.get(originSlot) || []
      slotLinks.push(link.id)
      sourceSlots.set(originSlot, slotLinks)
      outputLinksByNode.set(originNodeId, sourceSlots)

      incomingByNode.get(targetNodeId)?.add(originNodeId)
    }
  }

  return {
    links,
    linkInputsByNode,
    outputLinksByNode,
    incomingByNode,
    lastLinkId: nextLinkId - 1,
  }
}

function buildOutputPorts(nodeSchema = null, nodeOutputLinks = new Map()) {
  const outputTypes = Array.isArray(nodeSchema?.output) ? nodeSchema.output : []
  const outputNames = Array.isArray(nodeSchema?.output_name) ? nodeSchema.output_name : []
  const linkedSlots = Array.from(nodeOutputLinks.keys()).map((slot) => Number(slot)).filter(Number.isFinite)
  const maxLinkedSlot = linkedSlots.length > 0 ? Math.max(...linkedSlots) : -1
  const totalSlots = Math.max(outputTypes.length, outputNames.length, maxLinkedSlot + 1, 0)
  const outputs = []

  for (let slotIndex = 0; slotIndex < totalSlots; slotIndex += 1) {
    const outputType = outputTypes[slotIndex] ?? '*'
    outputs.push({
      name: outputNames[slotIndex] || `output_${slotIndex}`,
      type: outputType,
      slot_index: slotIndex,
      links: nodeOutputLinks.get(slotIndex) || null,
    })
  }

  return outputs
}

function buildWidgetValues(nodeDef = {}, nodeSchema = null, nodeIdSet = new Set(), apiWorkflow = {}) {
  const orderedNames = getOrderedInputNames(nodeSchema, nodeDef.inputs || {})
  const used = new Set()
  const values = []

  for (const inputName of orderedNames) {
    if (!(inputName in (nodeDef.inputs || {}))) continue
    const inputValue = nodeDef.inputs[inputName]
    const inputSpec = getInputSpec(nodeSchema, inputName)
    if (isLinkValue(inputValue, nodeIdSet)) {
      if (inputSpecHasWidget(inputSpec)) {
        const linkedValue = resolveLinkedWidgetValue(inputValue, apiWorkflow, nodeIdSet)
        values.push(linkedValue !== undefined ? linkedValue : getDefaultWidgetValue(inputSpec))
        if (inputSpecHasControlAfterGenerate(inputSpec)) {
          values.push('fixed')
        }
      }
      used.add(inputName)
      continue
    }
    values.push(cloneJsonValue(inputValue))
    if (inputSpecHasControlAfterGenerate(inputSpec)) {
      values.push('fixed')
    }
    used.add(inputName)
  }

  for (const [inputName, inputValue] of Object.entries(nodeDef.inputs || {})) {
    if (used.has(inputName)) continue
    const inputSpec = getInputSpec(nodeSchema, inputName)
    if (isLinkValue(inputValue, nodeIdSet)) {
      if (inputSpecHasWidget(inputSpec)) {
        const linkedValue = resolveLinkedWidgetValue(inputValue, apiWorkflow, nodeIdSet)
        values.push(linkedValue !== undefined ? linkedValue : getDefaultWidgetValue(inputSpec))
        if (inputSpecHasControlAfterGenerate(inputSpec)) {
          values.push('fixed')
        }
      }
      continue
    }
    values.push(cloneJsonValue(inputValue))
    if (inputSpecHasControlAfterGenerate(inputSpec)) {
      values.push('fixed')
    }
  }

  return values
}

export function convertApiWorkflowToComfyGraph(apiWorkflow = {}, objectInfo = {}) {
  const nodeIds = Object.keys(apiWorkflow || {}).sort((left, right) => {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber
    }
    return String(left).localeCompare(String(right))
  })
  const nodeIdSet = new Set(nodeIds)
  const graphIdByNodeId = buildGraphNodeIdMap(nodeIds)
  const {
    links,
    linkInputsByNode,
    outputLinksByNode,
    incomingByNode,
    lastLinkId,
  } = buildWorkflowLinks(apiWorkflow, objectInfo, graphIdByNodeId)
  const positions = buildNodePositions(nodeIds, incomingByNode)

  const nodes = nodeIds.map((nodeId, index) => {
    const nodeDef = apiWorkflow[nodeId] || {}
    const nodeSchema = objectInfo?.[nodeDef.class_type] || null
    const orderedInputNames = getOrderedInputNames(nodeSchema, nodeDef.inputs || {})
    const inputOrder = new Map(orderedInputNames.map((inputName, inputIndex) => [inputName, inputIndex]))
    const linkInputs = (linkInputsByNode.get(nodeId) || []).sort((left, right) => {
      const leftOrder = inputOrder.get(left.name)
      const rightOrder = inputOrder.get(right.name)
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
      if (leftOrder !== undefined) return -1
      if (rightOrder !== undefined) return 1
      return left.name.localeCompare(right.name)
    })
    const outputs = buildOutputPorts(nodeSchema, outputLinksByNode.get(nodeId) || new Map())
    const widgetValues = buildWidgetValues(nodeDef, nodeSchema, nodeIdSet, apiWorkflow)
    const position = positions.get(nodeId) || [40, 40 + index * 220]

    return {
      id: getGraphNodeId(graphIdByNodeId, nodeId),
      type: nodeDef.class_type,
      pos: position,
      size: estimateNodeSize(linkInputs, outputs, widgetValues),
      flags: {},
      order: index,
      mode: 0,
      inputs: linkInputs,
      outputs,
      title: nodeDef?._meta?.title || nodeSchema?.display_name || nodeDef.class_type,
      properties: {
        'Node name for S&R': nodeDef.class_type,
      },
      widgets_values: widgetValues,
    }
  })

  const numericNodeIds = nodeIds
    .map((nodeId) => getGraphNodeId(graphIdByNodeId, nodeId))
    .filter((nodeId) => Number.isFinite(nodeId))

  return {
    version: 1,
    config: {},
    state: {
      lastGroupid: 0,
      lastNodeId: numericNodeIds.length > 0 ? Math.max(...numericNodeIds) : nodes.length,
      lastLinkId,
      lastRerouteId: 0,
    },
    groups: [],
    nodes,
    links,
    reroutes: [],
    extra: {},
  }
}

export async function buildComfyGraphFromApiWorkflow(apiWorkflow = {}, objectInfo = {}) {
  return convertApiWorkflowToComfyGraph(apiWorkflow, objectInfo)
}

// ─────────────────────────────────────────────────────────────────────
// Batch output classification
// ─────────────────────────────────────────────────────────────────────

// Node class_types that strongly indicate the SaveImage sibling/downstream
// is producing a frame sequence for an animation rather than a batch of
// independent variations. These are all "video-adjacent" workflows:
// AnimateDiff, VideoHelperSuite, ControlGIF, IPAdapter-with-temporal,
// AD/ADE custom node family, etc.
const ANIMATION_UPSTREAM_HINTS = [
  /^animatediff/i,
  /^ade_/i,
  /^ad_/i,
  /^vhs_/i,
  /^videohelpersuite/i,
  /^video\s/i,
  /^controlgif/i,
  /^animatelcm/i,
  /^lcm.*video/i,
  /^hotshot/i,
  /^cogvideo/i,
  /^svd/i,
  /^stable\s?video/i,
  /^imagetovideo/i,
  /^videolinearccfgguidance/i,
  /^ipadapter.*video/i,
  /^ipadapter.*anim/i,
  /^ipadaptertemporal/i,
  /^ltx/i,
  /^wan2?/i,
  /^framewise/i,
  /^imagebatchto/i,
  /^imagefrombatch/i,
  /^loadvideo/i,
  /^loadimages/i,
  /^loadimageslist/i,
  /^repeatimagebatch/i,
  /^imageduplicate/i,
  /^concatframes/i,
]

// Nodes that directly produce or save animated output themselves.
// If ComfyUI returns an animated file from one of these nodes, it's
// already a video/GIF — we don't need to stitch anything.
const ALREADY_ANIMATED_NODE_CLASSES = new Set([
  'SaveAnimatedPNG',
  'SaveAnimatedWEBP',
  'SaveWEBM',
  'SaveVideo',
  'VHS_VideoCombine',
  'VHS_SaveVideo',
  'VHS_SaveAnimatedWEBP',
  'CreateVideo',
  'SaveAudio',
])

function isAnimationHintedClass(classType) {
  if (!classType) return false
  const s = String(classType)
  return ANIMATION_UPSTREAM_HINTS.some((re) => re.test(s))
}

// Walk upstream of `nodeId` in the prompt (API-format) workflow to see
// whether any ancestor node's class_type looks animation-oriented.
// Bounded BFS so pathological graphs can't hang us.
function hasAnimationUpstream(apiWorkflow, nodeId, maxDepth = 8, maxVisited = 200) {
  if (!apiWorkflow || !nodeId || !apiWorkflow[nodeId]) return false
  const visited = new Set()
  const queue = [{ id: String(nodeId), depth: 0 }]
  while (queue.length > 0) {
    const { id, depth } = queue.shift()
    if (visited.has(id)) continue
    visited.add(id)
    if (visited.size > maxVisited) return false
    if (depth > maxDepth) continue
    const node = apiWorkflow[id]
    if (!node || typeof node !== 'object') continue
    if (depth > 0 && isAnimationHintedClass(node.class_type)) return true
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {}
    for (const key of Object.keys(inputs)) {
      const ref = inputs[key]
      // Input connections in API format are [srcNodeId, outputIndex]
      if (Array.isArray(ref) && ref.length >= 1 && ref[0] != null) {
        const srcId = String(ref[0])
        if (!visited.has(srcId)) queue.push({ id: srcId, depth: depth + 1 })
      }
    }
  }
  return false
}

// Extract the numeric suffix of a filename, e.g.
//   "ComfyUI_00017_.png"  → 17
//   "my_frame_0005.png"   → 5
//   "shot_1_frame_0012.png" → 12  (uses the *last* run of digits)
// Returns null if the filename does not end with digits.
function parseNumericFrameIndex(filename) {
  if (typeof filename !== 'string') return null
  // Strip extension first so trailing underscores/dots around the
  // number don't trip us up.
  const base = filename.replace(/\.[^./\\]+$/, '')
  const match = base.match(/(\d+)(?=[^\d]*$)/)
  if (!match) return null
  const n = parseInt(match[1], 10)
  return Number.isFinite(n) ? n : null
}

// Groups detected outputs by the node they came from, preserving order.
function groupOutputsByNode(filesByNode) {
  const groups = new Map()
  if (!filesByNode) return groups
  const entries = filesByNode instanceof Map
    ? Array.from(filesByNode.entries())
    : Object.entries(filesByNode)
  for (const [nodeId, files] of entries) {
    if (!Array.isArray(files) || files.length === 0) continue
    groups.set(String(nodeId), files.slice())
  }
  return groups
}

/**
 * Classify a completed prompt's output files as a single file, a batch
 * of variations, or a frame sequence that should be stitched to video.
 *
 * Inputs:
 *   - apiWorkflow : the API-format prompt dict (history[id].prompt[2] or
 *     history[id].prompt when already unwrapped). Pass null/empty to
 *     disable graph-based hints.
 *   - filesByNode : { [nodeId]: [ { filename, subfolder, type, classType? }, ... ] }
 *     Only include image-type files here (callers should pre-filter out
 *     videos — if ComfyUI already returned a video, stitching is moot).
 *
 * Options:
 *   - minFramesForSequence (default 8): require at least this many files
 *     before we'll even consider stitching.
 *   - requireAnimationHint (default true): require an animation-oriented
 *     upstream node class to promote to sequence. Set false to be more
 *     eager (risk: misclassify batch-of-variations as sequence).
 *
 * Returns one of:
 *   { kind: 'single', files: [file] }
 *   { kind: 'batch',  files: [file, ...], reason }
 *   { kind: 'sequence', nodeId, files: [file, ...], indices, reason }
 *
 * The `files` array in `sequence` is sorted ascending by detected frame
 * index so callers can feed it straight to ffmpeg.
 */
export function classifyBatchOutputs(apiWorkflow, filesByNode, options = {}) {
  const {
    minFramesForSequence = 8,
    requireAnimationHint = true,
  } = options

  const groups = groupOutputsByNode(filesByNode)
  const totalFiles = Array.from(groups.values()).reduce((n, arr) => n + arr.length, 0)

  if (totalFiles === 0) {
    return { kind: 'batch', files: [], reason: 'no-files' }
  }
  if (totalFiles === 1) {
    const onlyFile = Array.from(groups.values())[0][0]
    return { kind: 'single', files: [onlyFile], reason: 'single-file' }
  }

  // We only promote to "sequence" if a SINGLE node produced all (or at
  // least a dominant run of) the files. If two different SaveImage nodes
  // each emit 10 files, those are clearly independent batches, not one
  // sequence.
  let bestNodeId = null
  let bestFiles = []
  for (const [nodeId, files] of groups) {
    if (files.length > bestFiles.length) {
      bestNodeId = nodeId
      bestFiles = files
    }
  }

  if (!bestNodeId || bestFiles.length < minFramesForSequence) {
    return {
      kind: 'batch',
      files: Array.from(groups.values()).flat(),
      reason: `below-frame-threshold (${bestFiles.length} < ${minFramesForSequence})`,
    }
  }

  // Already-animated class shouldn't be re-stitched.
  const bestNode = apiWorkflow && apiWorkflow[bestNodeId]
  const bestClassType = bestNode && bestNode.class_type
  if (bestClassType && ALREADY_ANIMATED_NODE_CLASSES.has(bestClassType)) {
    return {
      kind: 'batch',
      files: Array.from(groups.values()).flat(),
      reason: `already-animated-node (${bestClassType})`,
    }
  }

  // Require contiguous, zero-padded numeric suffix. Tolerate a small
  // amount of gaps (e.g. ComfyUI skipping indices) but insist on a
  // monotonically-increasing unique set.
  const indexed = bestFiles
    .map((file) => ({ file, index: parseNumericFrameIndex(file?.filename) }))
    .filter((entry) => entry.index != null)

  if (indexed.length < minFramesForSequence) {
    return {
      kind: 'batch',
      files: Array.from(groups.values()).flat(),
      reason: 'insufficient-indexed-files',
    }
  }

  // Sort by index and verify uniqueness + reasonable tightness.
  indexed.sort((a, b) => a.index - b.index)
  const first = indexed[0].index
  const last = indexed[indexed.length - 1].index
  const span = last - first + 1
  const uniqueIndices = new Set(indexed.map((e) => e.index))
  // At least 80% density — filenames like 0,1,2,...,15 would be 100%;
  // filenames like 0,2,4,...,30 would still be above 50% and that's
  // fine; we only reject very sparse numbering.
  const density = uniqueIndices.size / Math.max(1, span)

  if (uniqueIndices.size !== indexed.length) {
    return {
      kind: 'batch',
      files: Array.from(groups.values()).flat(),
      reason: 'duplicate-indices',
    }
  }

  if (density < 0.5) {
    return {
      kind: 'batch',
      files: Array.from(groups.values()).flat(),
      reason: `sparse-indices (density=${density.toFixed(2)})`,
    }
  }

  // Optional graph-based gate: only promote to sequence if the workflow
  // graph itself contains animation-oriented machinery. This is what
  // separates a real sequence ("AnimateDiff → SaveImage emitting 16
  // frames") from a plain batch ("KSampler with batch_size=16 →
  // SaveImage emitting 16 variations").
  if (requireAnimationHint) {
    const hinted = hasAnimationUpstream(apiWorkflow, bestNodeId)
    if (!hinted) {
      return {
        kind: 'batch',
        files: Array.from(groups.values()).flat(),
        reason: 'no-animation-hint-upstream',
      }
    }
  }

  return {
    kind: 'sequence',
    nodeId: bestNodeId,
    nodeClassType: bestClassType || null,
    files: indexed.map((e) => e.file),
    indices: indexed.map((e) => e.index),
    reason: 'contiguous-numeric-sequence',
  }
}
