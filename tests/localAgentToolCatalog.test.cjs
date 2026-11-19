'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalToolCatalog, compactToolDefinition, CALL_TOOL, DISCOVERY_TOOL, CORE_NAMES, LIMITS } = require('../electron/localAgentToolCatalog.cjs')
const tool = (name, description = `Description for ${name}`, extra = {}) => ({ name, description,
  inputSchema: { type: 'object', properties: { value: { type: 'string', enum: ['a', 'b'], description: 'Full argument documentation.' } }, additionalProperties: false }, ...extra })
const names = local => local.tools().map(item => item.function.name)
const availableNames = local => local.routerTool().function.parameters.properties.name.enum

test('every native tool is callable in the first request through direct schemas or the always-available router', () => {
  const catalog = [...CORE_NAMES.map(name => tool(name)), ...Array.from({ length: 170 }, (_, i) => tool(`action_${i}`))]
  const local = createLocalToolCatalog(catalog)
  assert.deepEqual(names(local), CORE_NAMES)
  assert.deepEqual(availableNames(local), catalog.map(item => item.name))
  assert.ok(names(local).includes('create_timeline'))
  assert.ok(names(local).includes('switch_timeline'))
  assert.match(local.instructions, /No tool discovery or loading step is required/)
  assert.doesNotMatch(local.instructions, /up to four|replaces previous|capability index/)
  for (const item of catalog) assert.equal(local.has(item.name), true)
  assert.equal(local.has('unknown'), false)
  assert.equal(local.has('discover_velorn_tools'), false)
  assert.equal(local.has('call_velorn_tool'), false)
})

test('optional lookup adds direct schemas without changing capabilities and avoids duplicate documentation', () => {
  const catalog = [tool('get_timeline'), tool('edit_timeline', 'Edit the timeline. Preserve all later documentation.'), tool('render_preview')]
  const local = createLocalToolCatalog(catalog), documented = new Set(), direct = new Set(names(local))
  for (const requested of [['edit_timeline', 'get_timeline'], ['render_preview'], ['get_timeline', 'edit_timeline']]) {
    const result = local.discover({ names: requested })
    assert.equal(result.available, true)
    assert.equal(result.schemasChanged, requested.some(name => !direct.has(name)))
    assert.equal(result.actionExecuted, false)
    assert.equal(result.requiresDiscovery, false)
    assert.deepEqual(result.activated, [])
    assert.equal(result.active, undefined, 'Do not repeat the entire tool index in each result.')
    assert.deepEqual(result.tools, requested.filter(name => !documented.has(name)).map(name => catalog.find(item => item.name === name)))
    assert.deepEqual(result.alreadyDocumented, requested.filter(name => documented.has(name)))
    assert.deepEqual(result.directFunctions, requested)
    assert.equal(result.count, requested.length)
    assert.match(result.nextAction, /directly/)
    requested.forEach(name => { direct.add(name); documented.add(name) })
    assert.deepEqual(names(local), [...direct])
    assert.deepEqual(availableNames(local), catalog.map(item => item.name))
  }
})

test('legacy initial selection neither limits tools nor retains a four-name ceiling', () => {
  const catalog = Array.from({ length: 8 }, (_, i) => tool(`initial_${i}`))
  const local = createLocalToolCatalog(catalog, catalog.slice(0, 7).map(item => item.name))
  assert.deepEqual(names(local), [])
  assert.deepEqual(availableNames(local), catalog.map(item => item.name))
  local.discover({ names: ['initial_7'] })
  assert.deepEqual(availableNames(local), catalog.map(item => item.name))
  for (const initial of [null, {}, ['unknown'], ['initial_0', 'initial_0'], [1]]) assert.throws(() => createLocalToolCatalog(catalog, initial), { code: 'INVALID_INITIAL_TOOL_SELECTION' })
})

test('compaction preserves every argument, default and structural constraint', () => {
  const schema = { type: 'object', description: 'Documentation.', additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z]+$', default: 'test', enum: ['test', 'other'], description: 'Exact name.' },
      length: { type: 'number', minimum: 0, exclusiveMaximum: 20, multipleOf: 0.5, default: 3, description: 'Seconds.' },
      enabled: { type: 'boolean', const: true },
      clips: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'object', required: ['clipId'], properties: { clipId: { type: 'string', description: 'Existing ID.' } }, additionalProperties: false } },
    }, required: ['name', 'length'], dependentRequired: { enabled: ['name'] }, oneOf: [{ required: ['clips'], description: 'Clip list.' }, { required: ['enabled'] }],
  }
  const input = tool('custom_edit', 'Edit selected clips. More usage details.', { inputSchema: schema })
  const expected = structuredClone(schema)
  delete expected.description
  delete expected.properties.name.description
  delete expected.properties.length.description
  delete expected.properties.clips.items.properties.clipId.description
  delete expected.oneOf[0].description
  assert.deepEqual(compactToolDefinition(input), { type: 'function', function: { name: 'custom_edit', description: 'Edit selected clips.', parameters: expected } })
  assert.deepEqual(createLocalToolCatalog([input]).discover({ names: ['custom_edit'] }).tools, [input])
})

test('annotations are removed only at schema positions, not from argument names or literal data', () => {
  const literal = { description: 'user supplied', title: 'keep', examples: ['keep'], $comment: 'keep' }
  const input = tool('literal_fields', 'Use literal fields.', { inputSchema: {
    type: 'object', title: 'Schema title', examples: [{ ignored: true }], $comment: 'Schema prose',
    properties: {
      description: { type: 'string', default: 'keep', description: 'Field prose' },
      title: { type: 'object', const: literal }, examples: { type: 'array', default: [literal], items: { enum: [literal] } }, $comment: { type: 'string' },
    }, default: literal, const: literal, enum: [literal], required: ['description', 'title', 'examples', '$comment'], dependentRequired: { title: ['description'] }, 'x-extension': literal,
  } })
  const schema = compactToolDefinition(input).function.parameters
  assert.deepEqual(Object.keys(schema.properties), ['description', 'title', 'examples', '$comment'])
  assert.equal(schema.properties.description.description, undefined)
  assert.equal(schema.properties.description.default, 'keep')
  for (const key of ['default', 'const', 'x-extension']) assert.deepEqual(schema[key], literal)
  assert.deepEqual(schema.enum, [literal])
  assert.deepEqual(schema.properties.examples.default, [literal])
  assert.deepEqual(schema.properties.examples.items.enum, [literal])
  assert.deepEqual(schema.dependentRequired, { title: ['description'] })
  for (const key of ['title', 'examples', '$comment']) assert.equal(schema[key], undefined)
})

test('nested schema keywords preserve references and validation while compacting annotations', () => {
  const child = { type: 'string', description: 'Documentation', minLength: 1 }, expected = { type: 'string', minLength: 1 }
  const schema = { type: 'object', $id: 'https://example.invalid/schema', $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { description: child }, definitions: { old: child }, patternProperties: { '^x': child }, dependentSchemas: { value: child },
    additionalProperties: false, unevaluatedProperties: child, propertyNames: child, allOf: [child], anyOf: [child], oneOf: [child], not: child, if: child, then: child, else: child,
    items: [child], prefixItems: [child], additionalItems: false, contains: child, unevaluatedItems: child, contentSchema: child,
    dependencies: { list: ['description'], object: child }, $ref: '#/$defs/description',
  }
  const actual = compactToolDefinition(tool('nested', 'Nested schemas.', { inputSchema: schema })).function.parameters
  for (const key of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) assert.deepEqual(Object.values(actual[key]), [expected])
  for (const key of ['unevaluatedProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'contains', 'unevaluatedItems', 'contentSchema']) assert.deepEqual(actual[key], expected)
  for (const key of ['allOf', 'anyOf', 'oneOf', 'items', 'prefixItems']) assert.deepEqual(actual[key], [expected])
  assert.deepEqual(actual.dependencies, { list: ['description'], object: expected })
  for (const key of ['$id', '$schema', '$ref', 'additionalProperties', 'additionalItems']) assert.deepEqual(actual[key], schema[key])
})

test('short descriptions retain the whole first sentence without an arbitrary character cutoff', () => {
  const first = 'A '.repeat(150) + 'complete sentence.', input = tool('long_description', first + ' More detailed instructions.')
  const local = createLocalToolCatalog([input])
  assert.ok(local.instructions.includes(first))
  assert.equal(compactToolDefinition(input).function.description, first)
  assert.equal(local.discover({ names: ['long_description'] }).tools[0].description, input.description)
})

test('callers cannot mutate input catalog, returned definitions or full documentation', () => {
  const catalog = [tool('get_timeline')], original = structuredClone(catalog[0]), local = createLocalToolCatalog(catalog)
  catalog[0].inputSchema.properties.value.type = 'number'
  const expected = compactToolDefinition(original)
  assert.deepEqual(local.tools(), [expected])
  local.tools()[0].function.parameters.properties.value.type = 'boolean'
  local.discover({ names: ['get_timeline'] }).tools[0].inputSchema.properties.value.type = 'boolean'
  local.discover({ names: ['get_timeline'] }).directFunctions.push('fake')
  local.routerTool().function.parameters.properties.name.enum.push('fake')
  assert.deepEqual(local.tools(), [expected])
  assert.deepEqual(local.discover({ names: ['get_timeline'] }).alreadyDocumented, ['get_timeline'])
  assert.deepEqual(names(local), ['get_timeline'])
  assert.deepEqual(availableNames(local), ['get_timeline'])
})

test('query returns all matches and exact lookup accepts more than four tools', () => {
  const catalog = [tool('get_timeline'), ...Array.from({ length: 6 }, (_, i) => tool(`timeline_action_${i}`, 'Inspect a clip boundary'))]
  const local = createLocalToolCatalog(catalog)
  assert.deepEqual(local.discover({ query: 'get_timeline' }).tools.map(item => item.name), ['get_timeline'])
  const matches = local.discover({ query: 'CLIP boundary' })
  assert.equal(matches.count, 6)
  assert.equal(matches.matchCount, 6)
  assert.equal(matches.moreMatches, false)
  assert.equal(local.discover({ names: catalog.map(item => item.name) }).count, 7)
  assert.deepEqual(availableNames(local), catalog.map(item => item.name))
  assert.equal(local.discover({ query: 'unknown-something' }).error.code, 'NO_MATCH')
})

test('invalid or unknown lookup never dispatches, guesses, or changes available tools', () => {
  const local = createLocalToolCatalog([tool('known'), tool('other')]), before = local.tools()
  for (const args of [undefined, null, [], {}, { names: [] }, { names: 'known' }, { names: ['known', 'known'] }, { names: [1] },
    { query: '' }, { query: 1 }, { query: 'x'.repeat(257) }, { query: '___---' }, { query: 'known', extra: true }, { names: ['other', 'unknown'] }, { names: ['discover_velorn_tools'] }]) {
    const result = local.discover(args)
    assert.equal(result.available, false, JSON.stringify(args))
    assert.equal(result.isError, true)
    assert.equal(result.schemasChanged, false)
    assert.equal(result.actionExecuted, false)
    assert.deepEqual(result.activated, [])
    assert.deepEqual(local.tools(), before)
  }
})

test('exact names take precedence over a supplied query without mutating caller arguments', () => {
  const local = createLocalToolCatalog([tool('edit_timeline'), tool('render_preview')])
  for (const query of ['', ' \t\n', ' '.repeat(LIMITS.queryChars), 'drone city street buildings above', 'render_preview']) {
    const args = Object.freeze({ names: Object.freeze(['edit_timeline']), query }), before = structuredClone(args)
    const result = local.discover(args)
    assert.equal(result.available, true)
    assert.deepEqual(result.directFunctions, ['edit_timeline'])
    assert.deepEqual(args, before)
  }
  const args = Object.freeze({ names: Object.freeze([]), query: 'render_preview' })
  assert.equal(local.discover(args).available, true)
  assert.deepEqual(args, { names: [], query: 'render_preview' })
  for (const invalid of [{ names: [], query: '' }, { names: null, query: 'render_preview' }, { names: ['edit_timeline'], query: null },
    { names: ['edit_timeline'], query: ' '.repeat(257) }, { names: ['edit_timeline'], query: '', extra: true }]) assert.equal(local.discover(invalid).error.code, 'INVALID_DISCOVERY_ARGUMENTS')
})

test('tools exceeding old individual-schema, combined-schema and name-index caps remain available', () => {
  const large = Array.from({ length: 4 }, (_, i) => tool(CORE_NAMES[i], 'Large schema.', { inputSchema: { type: 'object', properties: { value: { type: 'string', const: 'x'.repeat(25000) } } } }))
  const local = createLocalToolCatalog(large)
  assert.ok(Buffer.byteLength(JSON.stringify(local.tools())) > 64 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(local.tools()[0])) > 20 * 1024)
  assert.deepEqual(local.discover({ names: large.map(item => item.name) }).tools, large)
  const many = Array.from({ length: 400 }, (_, i) => tool(`action_${String(i).padStart(3, '0')}_${'x'.repeat(50)}`))
  assert.ok(Buffer.byteLength(many.map(item => item.name).join('\n')) > 20 * 1024)
  assert.deepEqual(availableNames(createLocalToolCatalog(many)), many.map(item => item.name))
})

test('invalid catalogs and reserved helper collisions still fail before use', () => {
  for (const reserved of ['discover_velorn_tools', 'read_velorn_tool_result', 'call_velorn_tool']) assert.throws(() => createLocalToolCatalog([tool(reserved)]), { code: 'INVALID_TOOL_CATALOG' })
  for (const invalid of [[], null, [tool('duplicate'), tool('duplicate')], [tool('invalid.name')], [tool('bad', '', { inputSchema: { type: 'array' } })]]) assert.throws(() => createLocalToolCatalog(invalid))
})

test('lookup helper allows exact names plus a query without a four-tool limit', () => {
  assert.equal(DISCOVERY_TOOL.function.name, 'discover_velorn_tools')
  assert.match(DISCOVERY_TOOL.function.description, /Optional documentation lookup/)
  assert.equal(DISCOVERY_TOOL.function.parameters.properties.names.maxItems, undefined)
  assert.equal(DISCOVERY_TOOL.function.parameters.additionalProperties, false)
  assert.equal(DISCOVERY_TOOL.function.parameters.anyOf.length, 2)
  assert.equal(DISCOVERY_TOOL.function.parameters.oneOf, undefined)
})

test('every native tool is immediately routable with complete optional documentation', () => {
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const server = createComfyStudioMcpServer({ performAction: () => assert.fail('Catalog inspection must not execute an action') }), local = createLocalToolCatalog(server.tools)
  assert.ok(server.tools.length > 100)
  assert.deepEqual(names(local), CORE_NAMES)
  assert.deepEqual(availableNames(local), server.tools.map(item => item.name))
  assert.equal(local.has('create_timeline'), true)
  assert.equal(local.has('switch_timeline'), true)
  assert.deepEqual(local.discover({ names: server.tools.map(item => item.name) }).tools, server.tools)
  for (const item of server.tools) {
    assert.equal(local.has(item.name), true)
    if (CORE_NAMES.includes(item.name)) assert.deepEqual(local.tools().find(entry => entry.function.name === item.name), compactToolDefinition(item))
    else assert.ok(local.instructions.includes(`${item.name}(`), item.name)
  }
})

test('router accepts a native arguments object and enumerates all catalog names without granting access', () => {
  const catalog = [tool('create_timeline'), tool('switch_timeline')], local = createLocalToolCatalog(catalog)
  const router = local.routerTool()
  assert.equal(router.function.name, 'call_velorn_tool')
  assert.deepEqual(router.function.parameters.properties.name.enum, ['create_timeline', 'switch_timeline'])
  assert.equal(router.function.parameters.properties.arguments.type, 'object')
  assert.equal(router.function.parameters.properties.arguments.additionalProperties, true)
  assert.deepEqual(router.function.parameters.required, ['name', 'arguments'])
  assert.equal(router.function.parameters.additionalProperties, false)
  assert.equal(CALL_TOOL.function.parameters.properties.name.enum, undefined)
  assert.match(router.function.description, /native argument validation/)
  assert.match(local.instructions, /original validation and the selected access mode/)
})

test('typed index preserves required markers and required array-item object fields', () => {
  const local = createLocalToolCatalog([tool('queue_custom', 'Queue a batch.', { inputSchema: { type: 'object', properties: {
    jobs: { type: 'array', items: { type: 'object', properties: { workflowId: { type: 'string' }, prompt: { type: 'string' }, seed: { type: 'integer' } }, required: ['workflowId', 'prompt'] } },
    previewOnly: { type: 'boolean', default: true },
  }, required: ['jobs'] } })])
  assert.match(local.instructions, /queue_custom\(jobs!:\[\{workflowId!:string,prompt!:string\}\], previewOnly\?:boolean\): Queue a batch\./)
  assert.equal(local.has('queue_custom'), true)
  assert.equal(local.discover({ names: ['queue_custom'] }).schemasChanged, true)
})
