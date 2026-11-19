'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parsePublicToolResponse: parse, stripPublicReasoning } = require('../electron/localAgentToolResponse.cjs')

const catalog = [{ type: 'function', function: { name: 'inspect_clip', parameters: { type: 'object', properties: {
  clipId: { type: 'string' }, includeClips: { type: 'boolean' }, limit: { type: 'integer' }, time: { type: 'number' },
  clipIds: { type: 'array', items: { type: 'string' } }, values: { type: 'object' }, nullable: { type: ['number', 'null'] },
} } } }, { name: 'get_timeline', inputSchema: { type: 'object', properties: {} } }]
const call = '<tool_call>{"name":"get_timeline","arguments":{}}</tool_call>'
const xml = parameters => `<tool_call>\n<function=inspect_clip>\n${parameters}\n</function>\n</tool_call>`
const field = (name, value) => `<parameter=${name}>${value}</parameter>`

test('decodes standalone JSON and default-template blocks without altering operands', () => {
  for (const content of [call, '[TOOL_REQUEST]{"name":"get_timeline","arguments":{}}[END_TOOL_REQUEST]']) {
    assert.deepEqual(parse(content, catalog), { type: 'calls', calls: [{ name: 'get_timeline', arguments: {} }], text: '' })
  }
  assert.deepEqual(parse('<tool_call>{"name":"inspect_clip","arguments":"{\\"clipId\\":\\"clip-6\\"}"}</tool_call>', catalog).calls,
    [{ name: 'inspect_clip', arguments: { clipId: 'clip-6' } }])
})

test('decodes XML parameters solely by the advertised schema type', () => {
  const content = xml([field('clipId', 'clip-6'), field('includeClips', 'false'), field('limit', '12'), field('time', '19.5'),
    field('clipIds', '["clip-6"]'), field('values', '{"duration":2.5}'), field('nullable', 'null')].join('\n'))
  assert.deepEqual(parse(content, catalog), { type: 'calls', calls: [{ name: 'inspect_clip', arguments: {
    clipId: 'clip-6', includeClips: false, limit: 12, time: 19.5, clipIds: ['clip-6'], values: { duration: 2.5 }, nullable: null,
  } }], text: '' })
  assert.equal(parse(xml(field('clipId', 'true')), catalog).calls[0].arguments.clipId, 'true')
  assert.equal(parse(xml(field('clipId', '  literal spaces  ')), catalog).calls[0].arguments.clipId, '  literal spaces  ')
  assert.equal(parse(xml(field('clipId', '&lt;clip&amp;6&gt;')), catalog).calls[0].arguments.clipId, '<clip&6>')
})

test('preserves prose around separate explicit blocks and supports multiple complete calls', () => {
  const result = parse(`I will inspect it.\n${call}\nThen inspect again.\n${call}`, catalog)
  assert.equal(result.type, 'calls'); assert.equal(result.calls.length, 2)
  assert.equal(result.text, 'I will inspect it.\n\nThen inspect again.')
})

test('normal prose and literal code or quoted examples remain text', () => {
  for (const content of ['Everything is complete.', `\`${call}\``, `\`\`\`xml\n${call}\n\`\`\``, `~~~\n${call}\n~~~`,
    `> ${call}`, `    ${call}`, `"${call.replaceAll('"', '\\"')}"`, `‘${call}’`, `“${call}”`,
    `Example: ${call}`, `\\${call}`, 'The parameter <function=inspect_clip> is a literal example.']) {
    assert.deepEqual(parse(content, catalog), { type: 'text', text: content })
  }
})

test('ignores reasoning spans without reading or exposing their fake operations', () => {
  assert.deepEqual(parse(`<think>\n${call}\n</think>Done.`, catalog), { type: 'text', text: 'Done.' })
  assert.deepEqual(parse(`<analysis>${call}</analysis>\n${call}`, catalog), { type: 'calls', calls: [{ name: 'get_timeline', arguments: {} }], text: '' })
  assert.deepEqual(parse(`<think>not public\n${call}`, catalog), { type: 'text', text: '' })
  assert.deepEqual(parse('`<think>literal</think>`', catalog), { type: 'text', text: '`<think>literal</think>`' })
  assert.deepEqual(parse(xml(field('clipId', '<think>literal operand</think>')), catalog).calls,
    [{ name: 'inspect_clip', arguments: { clipId: '<think>literal operand</think>' } }])
  assert.deepEqual(parse(`<think><think>nested</think>\n${call}\n</think>Done.`, catalog), { type: 'text', text: 'Done.' })
  assert.deepEqual(parse(`<think><analysis>nested</analysis>\n${call}\n</think>Done.`, catalog), { type: 'text', text: 'Done.' })
  assert.deepEqual(parse(`<think><analysis>mismatched</think>\n${call}`, catalog), { type: 'text', text: '' })
})

test('rejects incomplete and ambiguous blocks without returning any partial calls', () => {
  for (const malformed of [
    '<tool_call>', '<tool_call', '</tool_call>', '[TOOL_REQUEST]{}', '[END_TOOL_REQUEST]', '[TOOL_REQUEST',
    '<function=get_timeline></function>', '<function=',
    '<tool_call>{"name":"get_timeline","arguments":{}</tool_call>',
    '<tool_call>{"name":"get_timeline","arguments":{},"function":{"name":"inspect_clip"}}</tool_call>',
    '<tool_call>{"name":"get_timeline","name":"inspect_clip","arguments":{}}</tool_call>',
    '<tool_call>{"name":"get_timeline","arguments":{"clipId":"a","clipId":"b"}}</tool_call>',
    '<tool_call>{"name":"inspect_clip","arguments":{"time":1e999}}</tool_call>',
    `<tool_call>${call}</tool_call>`, `${call} and apply another thing`,
    '<tool_call>{"name":"get_timeline"}</tool_call>', '<tool_call>{"name":"get_timeline","arguments":[]}</tool_call>',
    xml(`${field('clipId', 'a')}${field('clipId', 'b')}`), xml('<parameter=clipId>missing end'),
    xml(field('includeClips', 'yes')), xml(field('limit', '2.5')), xml(field('limit', '')), xml(field('time', '1e999')),
    xml(field('clipIds', '["clip-6"')), xml(field('values', '{"clipId":"a","clipId":"b"}')),
    xml(field('clipId', '<parameter=limit>1</parameter>')),
  ]) {
    const result = parse(`${call}\n${malformed}`, catalog)
    assert.equal(result.type, 'malformed', malformed)
    assert.equal(result.calls, undefined)
  }
})

test('does not invent aliases, discover unadvertised tools, or guess missing field types', () => {
  for (const content of ['<tool_call>{"name":"read_timeline","arguments":{}}</tool_call>',
    xml(field('unknownField', '2')), xml(field('includeClips', '"false"'))]) {
    assert.equal(parse(content, catalog).type, 'malformed')
  }
  assert.equal(parse(call, []).type, 'malformed')
  const ambiguous = [{ name: 'inspect_clip', inputSchema: { properties: { clipId: { type: ['string', 'number'] } } } }]
  assert.equal(parse(xml(field('clipId', '2')), ambiguous).type, 'malformed')
})

test('tool delimiters in JSON strings do not truncate argument values', () => {
  const args = { clipId: 'literal </tool_call> and [END_TOOL_REQUEST]' }
  assert.deepEqual(parse(`<tool_call>${JSON.stringify({ name: 'inspect_clip', arguments: args })}</tool_call>`, catalog).calls,
    [{ name: 'inspect_clip', arguments: args }])
})

test('bounded calls, bytes, and JSON nesting never return partial operations', () => {
  assert.equal(parse(`${call}\n${call}`, catalog, { calls: 1 }).type, 'malformed')
  assert.equal(parse(call, catalog, { bytes: 10 }).type, 'malformed')
  const nested = `<tool_call>${JSON.stringify({ name: 'inspect_clip', arguments: { values: { nested: {} } } })}</tool_call>`
  assert.equal(parse(nested, catalog, { depth: 3 }).type, 'malformed')
})

test('default decoder accepts more than forty-eight complete calls within its byte budget', () => {
  const result = parse(Array(60).fill(call).join('\n'), catalog)
  assert.equal(result.type, 'calls')
  assert.equal(result.calls.length, 60)
})

test('prototype-like keys remain data rather than modifying decoder objects', () => {
  const result = parse('<tool_call>{"name":"inspect_clip","arguments":{"__proto__":{"polluted":true}}}</tool_call>', catalog)
  assert.equal(result.type, 'calls')
  assert.equal(Object.hasOwn(result.calls[0].arguments, '__proto__'), true)
  assert.equal({}.polluted, undefined)
})

test('structured-call accompanying content can be sanitized without parsing any action', () => {
  assert.equal(stripPublicReasoning('<think>private</think>Checking the clip.'), 'Checking the clip.')
  assert.equal(stripPublicReasoning('`<think>example</think>`'), '`<think>example</think>`')
  assert.equal(stripPublicReasoning(null), null)
  assert.equal(stripPublicReasoning(undefined), undefined)
})
