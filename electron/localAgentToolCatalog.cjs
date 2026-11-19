'use strict'

const { validateCatalog } = require('./connectedAgentMcpGateway.cjs')

const CORE_NAMES = Object.freeze([
  'get_project',
  'get_timeline',
  'get_assets',
  'create_timeline',
  'switch_timeline',
  'rename_timeline',
  'inspect_clip',
  'trim_clips',
  'move_clips',
  'update_text_clip',
  'set_clip_keyframes',
  'set_clip_label_color',
  'add_timeline_markers',
  'delete_clips',
  'undo',
  'redo',
])
const RESERVED_NAMES = new Set(['discover_velorn_tools', 'read_velorn_tool_result', 'call_velorn_tool'])
const LIMITS = Object.freeze({ queryChars: 256 })
const DISCOVERY_TOOL = Object.freeze({ type: 'function', function: {
  name: 'discover_velorn_tools',
  description: 'Optional documentation lookup for tools already available to call directly. Also supplies their direct function schemas on the next step. Never executes an action or changes permissions. After lookup, call the requested function, not this helper again.',
  parameters: { type: 'object', properties: {
    names: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true, description: 'Exact names of available tools to look up.' },
    query: { type: 'string', minLength: 1, maxLength: 256, description: 'Search names and descriptions when exact names are not supplied. If names are supplied, those exact names take precedence.' },
  }, additionalProperties: false, anyOf: [{ required: ['names'] }, { required: ['query'] }] },
} })
const CALL_TOOL = Object.freeze({ type: 'function', function: {
  name: 'call_velorn_tool',
  description: 'Call any named Velorn tool immediately with its native arguments object. No discovery or loading step is required; the selected access mode and native argument validation apply.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'Exact native tool name from the available-tool list.' },
    arguments: { type: 'object', additionalProperties: true, description: 'Native tool arguments as a JSON object, not a string. Use the typed signature; optional full documentation is available through discover_velorn_tools.' },
  }, required: ['name', 'arguments'], additionalProperties: false },
} })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fault = (code, message) => Object.assign(new Error(message), { code, publicMessage: message })
const searchText = value => value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
const copy = value => JSON.parse(JSON.stringify(value))
const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment'])
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const SCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_VALUES = new Set(['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'contentSchema'])

// Compact schema annotations, not schema semantics. Traverse only JSON Schema
// positions: a property named "description" or keys inside const/default/enum
// values are user data and must remain exactly as supplied by the server.
function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema)
  if (!object(schema)) return schema
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]) => {
    if (ANNOTATIONS.has(key)) return []
    if (SCHEMA_MAPS.has(key) && object(value)) return [[key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactSchema(child)]))]]
    if (SCHEMA_LISTS.has(key) && Array.isArray(value)) return [[key, value.map(compactSchema)]]
    if (SCHEMA_VALUES.has(key)) return [[key, compactSchema(value)]]
    if (key === 'dependencies' && object(value)) return [[key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, Array.isArray(child) ? copy(child) : compactSchema(child)]))]]
    return [[key, copy(value)]]
  }))
}

function compactToolDefinition(tool) {
  const description = (tool.description || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]
  return { type: 'function', function: { name: tool.name, description, parameters: compactSchema(tool.inputSchema) } }
}

function argumentType(schema) {
  if (!object(schema)) return 'any'
  if (schema.type === 'array') {
    if (schema.items?.type === 'object' && Array.isArray(schema.items.required) && schema.items.required.length) {
      return `[{${schema.items.required.map(name => `${name}!:${argumentType(schema.items.properties?.[name])}`).join(',')}}]`
    }
    return `[${argumentType(schema.items)}]`
  }
  if (Array.isArray(schema.type)) return schema.type.join('|')
  if (schema.type) return schema.type
  const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.const !== undefined) return valueType(schema.const)
  if (Array.isArray(schema.enum)) return [...new Set(schema.enum.map(valueType))].join('|')
  const variants = schema.oneOf || schema.anyOf
  if (Array.isArray(variants)) return [...new Set(variants.map(argumentType))].join('|')
  return 'any'
}

function toolSignature(tool) {
  const required = new Set(tool.inputSchema.required || [])
  return Object.entries(tool.inputSchema.properties || {}).map(([name, schema]) => `${name}${required.has(name) ? '!' : '?'}:${argumentType(schema)}`).join(', ')
}

function createLocalToolCatalog(catalog, initialToolNames = []) {
  const validated = validateCatalog(catalog)
  const entries = new Map()
  for (const tool of validated) {
    if (RESERVED_NAMES.has(tool.name)) throw fault('INVALID_TOOL_CATALOG', `The Velorn tool catalog uses a reserved helper name: ${tool.name}.`)
    entries.set(tool.name, { tool, definition: compactToolDefinition(tool) })
  }
  // Retain the legacy argument's validation for callers, but it no longer
  // selects capabilities: every tool is present in the first request.
  if (!Array.isArray(initialToolNames)
    || initialToolNames.some(name => typeof name !== 'string' || !entries.has(name))
    || new Set(initialToolNames).size !== initialToolNames.length) {
    throw fault('INVALID_INITIAL_TOOL_SELECTION', 'Initial local tools must be distinct exact names from the current Velorn catalog.')
  }
  const directNames = CORE_NAMES.filter(name => entries.has(name))
  const documented = new Set()
  const instructions = 'Every native Velorn tool is available immediately. Call a directly supplied function or use call_velorn_tool with {"name":"exact_native_name","arguments":{...}}. No tool discovery or loading step is required. The list below gives other tools and their native argument signatures: ! means required, ? means optional, [type] means an array, and object means a JSON object. Supply the named arguments, not this signature text. Full constraints and argument documentation are available through optional discover_velorn_tools; lookup never executes an action or changes availability or permissions. Native tools retain their original validation and the selected access mode. Follow CURRENT ACCESS above.\n'
    + validated.filter(tool => !directNames.includes(tool.name)).map(tool => `${tool.name}(${toolSignature(tool)}): ${entries.get(tool.name).definition.function.description}`).join('\n')
  // Do not repeat the entire catalog in every helper result. All names remain
  // available through the router, independent of direct schema presentation.
  const state = () => ({ totalCount: entries.size, requiresDiscovery: false })
  const failure = (code, message, extra = {}) => ({ available: false, isError: true, schemasChanged: false, actionExecuted: false,
    activated: [], count: 0, ...state(), error: { code, message }, ...extra })
  return {
    instructions,
    tools: () => copy(directNames.map(name => entries.get(name).definition)),
    routerTool: () => {
      const router = copy(CALL_TOOL)
      router.function.parameters.properties.name.enum = [...entries.keys()]
      return router
    },
    has: name => entries.has(name),
    discover(args) {
      if (!object(args) || Object.keys(args).some(key => !['names', 'query'].includes(key))) return failure('INVALID_DISCOVERY_ARGUMENTS', 'Supply distinct exact names or a search query. Exact names take precedence when both are supplied.')
      if (Object.hasOwn(args, 'query') && (typeof args.query !== 'string' || args.query.length > LIMITS.queryChars)) return failure('INVALID_DISCOVERY_ARGUMENTS', 'Supply a search query of at most 256 characters.')
      // Lookup is not an action: an accompanying search phrase does not make
      // exact tool names ambiguous. Never apply this normalization to action args.
      if (Array.isArray(args.names) && args.names.length > 0
        && typeof args.query === 'string') {
        args = { names: args.names }
      } else if (Array.isArray(args.names) && args.names.length === 0
        && typeof args.query === 'string' && args.query.trim()) {
        args = { query: args.query }
      }
      if (Object.hasOwn(args, 'names') === Object.hasOwn(args, 'query')) return failure('INVALID_DISCOVERY_ARGUMENTS', 'Supply distinct exact names or a nonempty search query.')
      let selected, matchCount
      if (Object.hasOwn(args, 'names')) {
        if (!Array.isArray(args.names) || args.names.length < 1
          || args.names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
          || new Set(args.names).size !== args.names.length) return failure('INVALID_DISCOVERY_ARGUMENTS', 'Supply distinct exact names of available tools.')
        const unknown = args.names.filter(name => !entries.has(name))
        if (unknown.length) return failure('UNKNOWN_TOOL', 'Some requested names are not in the current Velorn catalog. Check the supplied tools; no action was executed.', { unknown })
        selected = args.names.slice(); matchCount = selected.length
      } else {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > LIMITS.queryChars) return failure('INVALID_DISCOVERY_ARGUMENTS', 'Supply a nonempty search query of at most 256 characters.')
        const query = searchText(args.query), words = query.split(' ')
        if (!query) return failure('INVALID_DISCOVERY_ARGUMENTS', 'Supply a search query containing a tool name or descriptive word.')
        const matches = validated.filter(tool => words.every(word => searchText(`${tool.name} ${tool.description || ''}`).includes(word)))
          .sort((a, b) => Number(searchText(b.name) === query) - Number(searchText(a.name) === query)
            || Number(searchText(b.name).includes(query)) - Number(searchText(a.name).includes(query)))
        if (!matches.length) return failure('NO_MATCH', 'No Velorn tools match that query. Use exact names of available tools or a simpler query.')
        matchCount = matches.length; selected = matches.map(tool => tool.name)
      }
      const newlyDirect = selected.filter(name => !directNames.includes(name))
      // A requested function gets its complete native argument documentation,
      // including defaults and units. Only the initial broad catalog is compact.
      for (const name of newlyDirect) {
        const entry = entries.get(name)
        entry.definition = { type: 'function', function: { name, description: entry.tool.description, parameters: entry.tool.inputSchema } }
      }
      directNames.push(...newlyDirect)
      const alreadyDocumented = selected.filter(name => documented.has(name))
      const tools = selected.filter(name => !documented.has(name)).map(name => copy(entries.get(name).tool))
      selected.forEach(name => documented.add(name))
      return { available: true, schemasChanged: newlyDirect.length > 0, actionExecuted: false, activated: [], count: selected.length, ...state(), matchCount, moreMatches: false,
        directFunctions: selected, alreadyDocumented, tools,
        nextAction: `Call ${selected.join(' or ')} directly using its supplied function schema. Do not repeat documentation lookup to execute it.`,
        message: 'These tools were already callable. Their direct schemas are now supplied too; repeated documentation is omitted. No action was executed and no permission changed.' }
    },
  }
}

module.exports = { createLocalToolCatalog, compactToolDefinition, CALL_TOOL, DISCOVERY_TOOL, CORE_NAMES, LIMITS }
