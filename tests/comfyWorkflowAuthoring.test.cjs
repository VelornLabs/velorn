'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { discover, inspect, paths, validate, dispatch, tools } = require('../electron/comfyWorkflowAuthoring.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const schema = (required, output = [], extra = {}) => ({ input: { required }, output, ...extra })
const info = {
  Loader: schema({ model: [['local.safetensors', 'second.safetensors']] }, ['MODEL']),
  Sampler: schema({ model: ['MODEL'], steps: ['INT', { default: 20, min: 1, max: 100 }], cfg: ['FLOAT', { min: 0 }],
    enabled: ['BOOLEAN'], prompt: ['STRING'] }, ['LATENT']),
  Decode: schema({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE'], { display_name: 'Decode Latent', category: 'latent' }),
  Vae: schema({}, ['VAE']),
  Save: schema({ images: ['IMAGE'] }, [], { output_node: true }),
  WidgetTrap: schema({ selection: [['MODEL', 'IMAGE']] }, ['IMAGE']),
  Paid: schema({ model: ['MODEL'] }, ['IMAGE'], { api_node: true }),
  Dynamic: schema({ anything: ['*'] }, ['*']),
  Upload: schema({ image: [['old.png'], { image_upload: true }] }, ['IMAGE']),
}
const graph = () => ({
  1: { class_type: 'Loader', inputs: { model: 'local.safetensors' } },
  2: { class_type: 'Sampler', inputs: { model: ['1', 0], steps: 20, cfg: 1.5, enabled: true, prompt: 'a scene' } },
  3: { class_type: 'Decode', inputs: { samples: ['2', 0], vae: ['4', 0] } },
  4: { class_type: 'Vae', inputs: {} },
  5: { class_type: 'Save', inputs: { images: ['3', 0] } },
})
const read = async () => ({ info, endpoint: 'http://127.0.0.1:8189' })
const decode = result => JSON.parse(result.content[0].text)

test('search uses live class/category names, socket types and honest pagination', () => {
  assert.deepEqual(discover(info, { query: 'decode latent' }).items.map(r => r.classType), ['Decode'])
  assert.deepEqual(discover(info, { accepts: 'MODEL', excludeApi: true }).items.map(r => r.classType), ['Sampler'])
  const first = discover(info, { limit: 2 }); assert.equal(first.nextOffset, 2)
  assert.equal(discover(info, { offset: 2, limit: 50 }).items.length, first.total - 2)
  assert.equal(discover(info, { query: 'Loader' }).items[0].apiNode, null)
})

test('inspection exposes required fields, output indices, model options and paging', () => {
  const result = inspect(info, { classType: 'Sampler' })
  assert.equal(result.inputs.find(i => i.name === 'steps').min, 1)
  assert.equal(result.inputs.find(i => i.name === 'steps').required, true)
  assert.deepEqual(result.outputs[0], { index: 0, name: 'LATENT', type: 'LATENT', isList: false })
  assert.equal(inspect(info, { classType: 'Loader', optionsLimit: 1 }).inputs[0].options.nextOffset, 1)
  assert.deepEqual(inspect(info, { classType: 'Loader', inputName: 'model', optionsOffset: 1 }).inputs[0].options.items, ['second.safetensors'])
  assert.deepEqual(inspect(info, { classType: 'Loader', optionQuery: 'local' }).inputs[0].options.items, ['local.safetensors'])
  assert.equal(inspect(info, { classType: 'missing' }).success, false)
  assert.equal(inspect(info, { classType: 'Loader', inputName: 'typo' }).success, false)
})

test('paths cannot route through widgets; report all supporting required inputs', () => {
  const result = paths(info, { fromType: 'MODEL', toType: 'IMAGE', excludeApi: true })
  assert.equal(result.paths.length, 1)
  assert.deepEqual(result.paths[0].map(e => e.classType), ['Sampler', 'Decode'])
  assert.deepEqual(result.paths[0][1].otherRequiredInputs, ['vae'])
  assert.equal(paths(info, { fromType: 'MODEL', toType: 'IMAGE', excludeApi: true, maxDepth: 1 }).paths.length, 0)
  assert.equal(paths(info, { fromType: 'NONEXISTENT', toType: 'IMAGE' }).paths.length, 0)
})

test('valid graph passes without changing the graph or schema', () => {
  const g = graph(), before = JSON.stringify({ g, info })
  const result = validate(info, g)
  assert.equal(result.valid, true)
  assert.equal(result.checked, true)
  assert.equal(result.errorCount, 0)
  assert.equal(JSON.stringify({ g, info }), before)
})

test('schema errors report exact node/field and valid model options', () => {
  const g = graph()
  g[1].inputs.model = 'invented.safetensors'
  g[2].inputs.steps = 0
  g[2].inputs.enabled = 'true'
  delete g[2].inputs.cfg
  g[3].inputs.samples = ['1', 0]
  g[3].inputs.vae = ['4', 9]
  g[5].inputs.images = ['404', 0]
  const result = validate(info, g)
  for (const code of ['INVALID_OPTION', 'OUT_OF_RANGE', 'VALUE_TYPE', 'MISSING_INPUT', 'TYPE_MISMATCH', 'OUTPUT_INDEX', 'DANGLING_LINK']) {
    assert.ok(result.errors.some(e => e.code === code), code)
  }
  const e = result.errors.find(e => e.code === 'INVALID_OPTION')
  assert.equal(e.nodeId, '1'); assert.equal(e.field, 'model')
  assert.deepEqual(e.validOptions, ['local.safetensors', 'second.safetensors'])
  assert.equal(result.valid, false)
})

test('defaults do not hide missing required inputs; optional inputs need not be present', () => {
  const g = graph(); delete g[2].inputs.steps
  assert.ok(validate(info, g).errors.some(e => e.field === 'steps' && e.code === 'MISSING_INPUT'))
  const extended = { ...info, Loader: { ...info.Loader, input: { ...info.Loader.input, optional: { extra: ['STRING'] } } } }
  assert.equal(validate(extended, graph()).valid, true)
})

test('missing node, missing output, cycles, malformed graphs and source nodes are not passes', () => {
  const g = graph(); g[1].class_type = 'Invented'
  assert.ok(validate(info, g).errors.some(e => e.code === 'MISSING_NODE'))
  const cyclic = { a: { class_type: 'Dynamic', inputs: { anything: ['b', 0] } }, b: { class_type: 'Dynamic', inputs: { anything: ['a', 0] } } }
  assert.ok(validate(info, cyclic).errors.some(e => e.code === 'CYCLE'))
  assert.ok(validate(info, cyclic).errors.some(e => e.code === 'NO_OUTPUT_NODE'))
  assert.throws(() => validate(info, {}))
  const bad = graph(); bad[1] = null
  assert.ok(validate(info, bad).errors.some(e => e.code === 'INVALID_NODE'))
})

test('dynamic schemas, wildcard links, staged uploads and unknown inputs are advisory warnings', () => {
  const g = { a: { class_type: 'Upload', inputs: { image: 'new-upload.png' } }, b: { class_type: 'Save', inputs: { images: ['a', 0], dynamic_extra: 42 } } }
  const r = validate(info, g)
  assert.equal(r.valid, true)
  assert.ok(r.warnings.some(e => e.code === 'ASSET_NOT_VERIFIED'))
  assert.ok(r.warnings.some(e => e.code === 'UNKNOWN_INPUT'))
  const dynamic = graph(); dynamic[1] = { class_type: 'Dynamic', inputs: { anything: 'x' } }
  assert.ok(validate(info, dynamic).warnings.some(e => e.code === 'RUNTIME_TYPE_CHECK'))
})

test('offline/malformed catalog never reports validation passed', async () => {
  for (const reader of [null, async () => { throw new Error('offline') }, async () => ({ info: {} }), async () => ({ info: { error: 'bad response' } })]) {
    const r = await dispatch('validate_comfyui_workflow', { workflow: graph() }, reader)
    assert.equal(r.success, false); assert.equal(r.valid, null); assert.equal(r.checked, false)
  }
})

test('Comfy V3 reference groups and dynamic video codecs are not mistaken for missing sockets', () => {
  const live = { ...info,
    H3: schema({ refs: ['COMFY_AUTOGROW_V3', { template: { input: { required: { ref: ['IMAGE'] } }, prefix: 'ref_', min: 0, max: 3 } }] }, ['VIDEO']),
    Video: schema({ video: ['VIDEO'], format: ['COMFY_DYNAMICCOMBO_V3', { options: [
      { key: 'auto', inputs: { required: { codec: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: { required: {} } }] }] } } },
    ] }] }, [], { output_node: true }),
  }
  const g = { a: { class_type: 'Upload', inputs: { image: 'new.png' } },
    b: { class_type: 'H3', inputs: { 'refs.ref_0': ['a', 0] } },
    c: { class_type: 'Video', inputs: { video: ['b', 0], format: 'auto', 'format.codec': 'auto' } } }
  const r = validate(live, g)
  assert.equal(r.valid, true, JSON.stringify(r))
  assert.ok(!r.warnings.some(e => e.code === 'UNKNOWN_INPUT'))
  assert.ok(inspect(live, { classType: 'H3' }).inputs[0].template)
  g.c.inputs['format.codec'] = 'bad'
  assert.ok(validate(live, g).errors.some(e => e.field === 'format.codec' && e.code === 'INVALID_OPTION'))
  g.b.inputs['refs.ref_0'] = ['b', 0]
  assert.ok(validate(live, g).errors.some(e => e.field === 'refs.ref_0' && e.code === 'TYPE_MISMATCH'))
})

test('invalid parameters cannot become writes or unbounded requests', async () => {
  let reads = 0
  for (const [name, args] of [['inspect_comfyui_node', {}], ['discover_comfyui_nodes', { limit: 10000 }], ['find_comfyui_node_paths', { fromType: 'A', toType: 'B', maxDepth: 99 }], ['discover_comfyui_nodes', { port: 1234 }]]) {
    assert.equal((await dispatch(name, args, async () => { reads++; return read() })).success, false)
  }
  assert.equal(reads, 0)
})

test('public MCP routes all four read-only tools without a project or renderer action', async () => {
  let writes = 0
  const server = createComfyStudioMcpServer({ readComfyNodeCatalog: read, performAction: () => { writes++; throw new Error('unexpected write') } })
  const args = { discover_comfyui_nodes: { query: 'Decode' }, inspect_comfyui_node: { classType: 'Decode' },
    find_comfyui_node_paths: { fromType: 'LATENT', toType: 'IMAGE' }, validate_comfyui_workflow: { workflow: graph() } }
  for (const t of tools) {
    assert.ok(server.tools.some(v => v.name === t.name))
    const result = await server.callTool(t.name, args[t.name])
    assert.notEqual(result.isError, true)
    assert.equal(decode(result).endpoint, 'http://127.0.0.1:8189')
  }
  assert.equal(writes, 0)
  const broken = graph(); broken[1].inputs.model = 'typo'
  const result = await server.callTool('validate_comfyui_workflow', { workflow: broken })
  assert.equal(result.isError, undefined)
  assert.equal(decode(result).valid, false)
})

test('reads resolve the current endpoint on each call and do not silently use a default', async () => {
  let port = 8189
  const server = createComfyStudioMcpServer({ readComfyNodeCatalog: async () => ({ info, endpoint: `http://127.0.0.1:${port}` }) })
  assert.match(decode(await server.callTool('discover_comfyui_nodes', {})).endpoint, /8189/)
  port = 8192
  assert.match(decode(await server.callTool('discover_comfyui_nodes', {})).endpoint, /8192/)
})

test('large schemas are recoverable by input selection rather than silent truncation', async () => {
  const large = { Big: schema({ first: ['STRING', { default: 'a'.repeat(40000) }], second: ['STRING', { default: 'b'.repeat(40000) }] }) }
  const reader = async () => ({ info: large, endpoint: 'http://127.0.0.1:8189' })
  const r = await dispatch('inspect_comfyui_node', { classType: 'Big' }, reader)
  assert.equal(r.error.code, 'AUTHORING_RESULT_TOO_LARGE')
  const selected = await dispatch('inspect_comfyui_node', { classType: 'Big', inputName: 'second' }, reader)
  assert.equal(selected.success, true)
  assert.equal(selected.inputs[0].default.length, 40000)
})

test('Comfy V3 COMBO link types stay advisory instead of rejecting string outputs', () => {
  const live = { Text: schema({}, ['STRING']), Sink: schema({ choice: ['COMBO', { options: ['x'] }] }, [], { output_node: true }) }
  const r = validate(live, { a: { class_type: 'Text', inputs: {} }, b: { class_type: 'Sink', inputs: { choice: ['a', 0] } } })
  assert.equal(r.valid, true)
  assert.ok(r.warnings.some(e => e.code === 'RUNTIME_TYPE_CHECK'))
})
