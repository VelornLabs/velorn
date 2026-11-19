'use strict'

// Compatibility for public tool blocks which an OpenAI-compatible server did
// not convert to tool_calls. This is a decoder, never a code evaluator, and its
// caller must not also dispatch structured tool_calls from the same response.
const LIMITS = Object.freeze({ bytes: 256 * 1024, depth: 64 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = reason => { throw new Error(reason) }
const blank = value => value.replace(/[^\r\n]/g, ' ')

function literalMask(content) {
  let fence = null
  return content.split(/(?<=\n)/).map(line => {
    if (/^[ \t]{0,3}>/.test(line) || /^(?: {4}|\t)/.test(line)) return blank(line)
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd())
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return blank(line)
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) { fence = marker[1]; return blank(line) }
    return line
  }).join('')
    .replace(/(?<![\\`])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)
    .replace(/"(?:\\.|[^"\\\r\n])*"|(?<![\p{L}\p{N}])'(?:\\.|[^'\\\r\n])*'|“[^”\r\n]*”|‘[^’\r\n]*’/gu, blank)
}

function stripPublicReasoning(content) {
  if (typeof content !== 'string') return content
  // Some templates put reasoning tags in content rather than a separate
  // reasoning field. Exclude those spans, including incomplete reasoning.
  const masked = literalMask(content)
  const toolSpans = [...masked.matchAll(/<tool_call\s*>[\s\S]*?<\/tool_call\s*>|\[TOOL_REQUEST\][\s\S]*?\[END_TOOL_REQUEST\]/gi)]
    .map(match => [match.index, match.index + match[0].length])
  const tags = /(?<!\\)<(\/?)(think|thinking|analysis|reasoning)\s*>/gi
  const spans = [], nesting = []
  let opening = null
  let match
  while ((match = tags.exec(masked))) {
    // A literal title/string operand is data, including any reasoning-looking
    // tags in that operand. Never strip or rewrite an operation's values.
    if (!nesting.length && toolSpans.some(([start, end]) => match.index >= start && match.index < end)) continue
    const name = match[2].toLowerCase()
    if (!match[1]) {
      if (!nesting.length) opening = match.index
      nesting.push(name)
    } else if (nesting.at(-1) === name) {
      nesting.pop()
      if (!nesting.length) { spans.push([opening, tags.lastIndex]); opening = null }
    }
  }
  if (opening !== null) spans.push([opening, content.length])
  if (!spans.length) return content
  let visible = '', cursor = 0
  for (const [start, end] of spans) { visible += content.slice(cursor, start); cursor = end }
  return visible + content.slice(cursor)
}

function parseJson(text, maxDepth) {
  let value
  try { value = JSON.parse(text) } catch { fail('The tool block contains invalid or incomplete JSON.') }
  const values = [value]
  while (values.length) {
    const item = values.pop()
    if (typeof item === 'number' && !Number.isFinite(item)) fail('The tool block contains a non-finite number.')
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) values.push(child)
  }
  // JSON.parse silently accepts duplicate object keys. They are ambiguous for
  // a mutation, so retain exact JSON syntax but reject duplicate operands.
  const tokens = /"(?:\\.|[^"\\])*"|[\[\]{}]|[^\s"\[\]{}]+/g
  const stack = []
  let match
  while ((match = tokens.exec(text))) {
    const token = match[0]
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null)
      if (stack.length > maxDepth) fail('The tool block exceeds the nesting limit.')
    } else if (token === '}' || token === ']') stack.pop()
    else if (token[0] === '"' && /^\s*:/.test(text.slice(tokens.lastIndex))) {
      const key = JSON.parse(token), keys = stack.at(-1)
      if (keys?.has(key)) fail('The tool block contains duplicate argument fields.')
      keys?.add(key)
    }
  }
  return value
}

function xmlValue(text, schema, maxDepth) {
  const type = schema?.type
  const types = Array.isArray(type) ? type : [type]
  if (types.length > 1 && types.includes('string')) fail('The XML parameter has an ambiguous schema type.')
  const decoded = (type === 'string' ? text : text.trim()).replace(/&(lt|gt|quot|apos|amp);/g, (_, entity) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[entity])
  if (type === 'string') return decoded
  if (!types.every(item => ['object', 'array', 'number', 'integer', 'boolean', 'null'].includes(item))) fail('The XML parameter has no unambiguous schema type.')
  const value = parseJson(decoded, maxDepth)
  const matches = types.some(item => item === 'null' ? value === null
    : item === 'object' ? object(value)
      : item === 'array' ? Array.isArray(value)
        : item === 'integer' ? Number.isSafeInteger(value)
          : item === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === 'boolean')
  if (!matches) fail('The XML parameter does not match its advertised type.')
  return value
}

function catalogMap(tools) {
  const catalog = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const definition = tool?.type === 'function' ? tool.function : tool
    if (typeof definition?.name !== 'string') continue
    catalog.set(definition.name, definition.parameters || definition.inputSchema || {})
  }
  return catalog
}

function parseBlock(body, catalog, maxDepth) {
  if (body.trimStart().startsWith('<function')) {
    const match = /^\s*<function=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/function>\s*$/.exec(body)
    if (!match) fail('The XML function block is incomplete or ambiguous.')
    const name = match[1], schema = catalog.get(name)
    if (!schema) fail('The tool block names a tool not advertised for this response.')
    const args = {}, fields = new Set()
    let remaining = match[2]
    while (remaining.trim()) {
      const parameter = /^\s*<parameter=([A-Za-z0-9_.-]+)>([\s\S]*?)<\/parameter>/.exec(remaining)
      if (!parameter) fail('The XML parameter block is incomplete or ambiguous.')
      const key = parameter[1]
      if (fields.has(key)) fail('The XML function contains duplicate parameters.')
      fields.add(key)
      if (/<\/?(?:parameter|function)(?:[\s=>]|$)/i.test(parameter[2])) fail('The XML parameter contains nested tool syntax.')
      const property = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : object(schema.additionalProperties) ? schema.additionalProperties : null
      const value = xmlValue(parameter[2], property, maxDepth)
      Object.defineProperty(args, key, { value, enumerable: true, configurable: true, writable: true })
      remaining = remaining.slice(parameter[0].length)
    }
    return { name, arguments: args }
  }
  const call = parseJson(body.trim(), maxDepth)
  if (!object(call) || typeof call.name !== 'string' || !Object.hasOwn(call, 'arguments')
    || Object.keys(call).some(key => !['name', 'arguments', 'id'].includes(key))) fail('The JSON tool block must contain one name and arguments object.')
  if (!catalog.has(call.name)) fail('The tool block names a tool not advertised for this response.')
  const args = typeof call.arguments === 'string' ? parseJson(call.arguments, maxDepth) : call.arguments
  if (!object(args)) fail('The tool arguments must be a JSON object.')
  return { name: call.name, arguments: args }
}

function parsePublicToolResponse(content, advertisedTools, options = {}) {
  if (typeof content !== 'string') return { type: 'text', text: '' }
  const limits = { ...LIMITS, ...options }
  if (Buffer.byteLength(content) > limits.bytes) return { type: 'malformed', reason: 'The public response exceeds the tool decoder limit.' }
  const visible = stripPublicReasoning(content), masked = literalMask(visible)
  const starts = /(?<!\\)(?:<\/?tool_call(?=[\s/>]|$)|<\/?function(?=[\s=>]|$)|\[(?:END_)?TOOL_REQUEST(?=[\]\s]|$))/gi
  const catalog = catalogMap(advertisedTools), calls = [], spans = []
  let match
  try {
    while ((match = starts.exec(masked))) {
      // Only standalone blocks represent operations. Inline prose examples are
      // ordinary text, just like quoted, fenced, and indented code examples.
      if (masked.slice(masked.lastIndexOf('\n', match.index - 1) + 1, match.index).trim()) continue
      const square = match[0] === '[TOOL_REQUEST'
      const opening = square ? /^\[TOOL_REQUEST\]/ : /^<tool_call\s*>/i
      const opened = opening.exec(visible.slice(match.index))
      if (!opened) fail('The public tool block has an incomplete or unexpected delimiter.')
      const start = match.index + opened[0].length
      const closing = square ? /\[END_TOOL_REQUEST\]/g : /<\/tool_call\s*>/gi
      closing.lastIndex = start
      const close = closing.exec(masked)
      if (!close) fail('The public tool block has no closing delimiter.')
      const inner = masked.slice(start, close.index)
      if (/<\/?tool_call(?=[\s/>]|$)|\[(?:END_)?TOOL_REQUEST\]/i.test(inner)) fail('The public response contains nested or conflicting tool blocks.')
      const end = closing.lastIndex
      const lineEnd = masked.indexOf('\n', end)
      if (masked.slice(end, lineEnd < 0 ? undefined : lineEnd).trim()) fail('The public tool block has ambiguous trailing content.')
      calls.push(parseBlock(visible.slice(start, close.index), catalog, limits.depth))
      if (calls.length > (limits.calls ?? Infinity)) fail('The public response exceeds the tool-call limit.')
      spans.push([match.index, end]); starts.lastIndex = end
    }
    if (!calls.length) return { type: 'text', text: visible }
    let text = '', cursor = 0
    for (const [start, end] of spans) { text += visible.slice(cursor, start); cursor = end }
    return { type: 'calls', calls, text: (text + visible.slice(cursor)).trim() }
  } catch (error) { return { type: 'malformed', reason: error.message } }
}

module.exports = { parsePublicToolResponse, stripPublicReasoning, LIMITS }
