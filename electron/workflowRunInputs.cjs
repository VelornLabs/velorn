'use strict'

// Shared by all agent providers. Resolve names from the inspected graph, never
// by splitting a guessed node ID (subgraphs can contain colons/underscores).
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value)
const key = (nodeId, input) => JSON.stringify([nodeId, input])
const alias = (nodeId, input) => `node_${nodeId.replace(/[^A-Za-z0-9_]/g, '_')}_${input.replace(/[^A-Za-z0-9_]/g, '_')}`
const fail = message => Object.assign(new Error(message), { code: 'SAVED_WORKFLOW_INVALID_OVERRIDES', publicMessage: message })

function inputCatalog(graph, bindings) {
  const named = new Map(), media = new Map()
  const add = (name, targets) => {
    if (!targets?.length) return
    const previous = named.get(name) || []
    named.set(name, [...new Map([...previous, ...targets].map(t => [key(t.nodeId, t.input), t])).values()])
  }
  for (const [nodeId, node] of Object.entries(graph)) for (const [input, value] of Object.entries(node.inputs)) {
    if (scalar(value)) add(alias(nodeId, input), [{ nodeId, input }])
  }
  for (const name of ['prompt', 'negativePrompt']) {
    const b = bindings[name]
    if (b) add(name, [{ nodeId: b.nodeId, input: b.inputKey }])
  }
  for (const b of bindings.assets) media.set(b.fieldId, { nodeId: b.nodeId, input: b.inputKey, assetType: b.assetType })
  return { named, media }
}

async function resolveRunInputs(graph, bindings, { inputOverrides = [], templateParameters, assetBindings = [], resolveAsset } = {}) {
  const count = value => value && typeof value === 'object' ? Object.keys(value).length : 0
  if (count(inputOverrides) + count(templateParameters) + count(assetBindings) > 128) throw fail('Too many input changes: use at most 128 entries.')
  if (count(assetBindings) > 16) throw fail('Use at most 16 reference assets per generation.')
  const { named, media } = inputCatalog(graph, bindings)
  const changes = [], assets = [], seen = new Set()
  const add = change => {
    const target = key(change.nodeId, change.input)
    if (seen.has(target)) throw fail(`Input ${change.nodeId}.${change.input} was supplied more than once. Use one value per input.`)
    seen.add(target); changes.push(change)
  }
  const addAsset = async (target, assetId) => {
    if (assets.length >= 16) throw fail('Use at most 16 reference assets per generation.')
    if (typeof assetId !== 'string' || !assetId) throw fail('Reference media must identify an existing project asset ID.')
    if (typeof resolveAsset !== 'function') throw fail('Project-reference preparation is unavailable. Use an already uploaded ComfyUI filename in an exact node override, or restart Velorn.')
    const resolved = await resolveAsset({ assetId, assetType: target.assetType })
    add({ nodeId: target.nodeId, input: target.input, value: resolved.value })
    assets.push({ ...target, ...resolved, assetId })
  }
  const objectInputs = async values => {
    for (const [name, value] of Object.entries(values)) {
      if (media.has(name)) { await addAsset(media.get(name), value); continue }
      const targets = named.get(name)
      if (!targets?.length) throw fail(`Unknown workflow input "${name}". Use the namedInputs returned by inspect_velorn_workflow, or [{nodeId, input, value}].`)
      if (targets.length !== 1) throw fail(`Workflow input "${name}" is ambiguous. Use an exact {nodeId, input, value} entry.`)
      add({ ...targets[0], value })
    }
  }
  if (Array.isArray(inputOverrides)) {
    for (const entry of inputOverrides) {
      if (!plain(entry) || Object.keys(entry).some(k => !['nodeId', 'input', 'value'].includes(k))
        || typeof entry.nodeId !== 'string' || typeof entry.input !== 'string' || !Object.hasOwn(entry, 'value')) {
        throw fail('Each inputOverrides list entry must contain nodeId (string), input (string), and value. Example: [{"nodeId":"1","input":"seed","value":42}].')
      }
      add(entry)
    }
  } else if (plain(inputOverrides)) await objectInputs(inputOverrides)
  else throw fail('inputOverrides must be a named settings object or an array of {nodeId, input, value} entries.')
  if (templateParameters !== undefined) {
    if (!plain(templateParameters)) throw fail('templateParameters must be an object keyed by inspected parameter field IDs.')
    await objectInputs(templateParameters)
  }
  if (!Array.isArray(assetBindings)) throw fail('assetBindings must be an array of {nodeId, input, assetId} entries.')
  for (const entry of assetBindings) {
    if (!plain(entry) || Object.keys(entry).some(k => !['nodeId', 'input', 'assetId'].includes(k))) throw fail('assetBindings entries accept only nodeId, input, and assetId.')
    const target = [...media.values()].find(t => t.nodeId === entry.nodeId && t.input === entry.input)
    if (!target) throw fail('assetBindings must target an inspected media input, not an arbitrary workflow input.')
    await addAsset(target, entry.assetId)
  }
  if (changes.length > 128) throw fail('Too many input changes: use at most 128 entries.')
  return { changes, assets }
}

function describeRunInputs(graph, bindings) {
  const { named, media } = inputCatalog(graph, bindings)
  return {
    namedInputs: [...named].filter(([, targets]) => targets.length === 1).map(([name, [target]]) => ({ name, ...target })),
    referenceInputs: [...media].map(([name, target]) => ({ name, ...target, value: 'project asset ID (uploaded only on apply)' })),
    example: { inputOverrides: bindings.prompt ? { prompt: 'Your prompt' } : {}, previewOnly: true },
    note: 'inputOverrides accepts these named inputs or [{nodeId,input,value}]. Reference names accept project asset IDs; exact scalar media overrides accept already uploaded ComfyUI filenames. templateParameters uses the same named input IDs. Preview never uploads or queues.',
  }
}

module.exports = { resolveRunInputs, describeRunInputs }
