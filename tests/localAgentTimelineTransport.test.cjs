'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createToolResultStore, LIMITS } = require('../electron/localAgentToolResults.cjs')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { parseModelTransport, decodeReadable } = require('./helpers/localAgentTransport.cjs')

function fixture({ count = 9, padding = 3000 } = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({ id: 'timeline-test', name: 'Test', duration: 30,
    clipCount: count, clipLimitApplied: false, tracks: [{ id: 'video', type: 'video' }],
    clips: Array.from({ length: count }, (_, i) => ({ id: `clip-${i + 1}`, type: 'video', trackId: 'video',
      computedTiming: { version: 1, timeline: { status: 'available', startSeconds: i, durationSeconds: 1, endSeconds: i + 1 },
        source: { status: 'unsupported', reason: 'active-speed-ramp', midpointSeconds: null } },
      keyframes: { retained: 'x'.repeat(padding) }, metadata: { original: i } })),
  }, null, 2) }] }
}
const pack = (store, result, name = 'get_timeline') => parseModelTransport(store.packForModel(result, 'read-one', { toolName: name }))
function readAll(store, resultId, representation) {
  let raw = '', pages = []
  for (let i = 0; i < 100; i++) {
    const page = store.readForModel({ resultId, representation })
    pages.push(page); raw += page.raw
    if (page.endOfResult) return { raw, pages }
  }
  throw Error('Unbounded result paging')
}

test('compact overview includes all rows while full received MCP detail remains exactly retrievable', () => {
  const store = createToolResultStore(), result = fixture(), raw = JSON.stringify(result)
  const header = pack(store, raw), overview = JSON.parse(header.body)
  assert.ok(header.totalChars > LIMITS.timelineInlineChars)
  assert.equal(header.kind, 'local-tool-result-overview')
  assert.equal(header.complete, false)
  assert.equal(header.pagingAvailable, true)
  assert.match(header.resultId, /^result_[a-f0-9-]{36}$/)
  assert.equal(header.detailedResultIncluded, false)
  assert.equal(header.overviewComplete, true)
  assert.equal(header.bodyChars, header.body.length)
  assert.ok(header.body.length < LIMITS.inlineChars)
  assert.equal(header.nextOffset, 0)
  assert.equal(header.detailRepresentation, 'readable')
  assert.equal(overview.coverage.allTimelineClipsIncluded, true)
  assert.deepEqual(overview.clips.map(c => c.id), Array.from({ length: 9 }, (_, i) => `clip-${i + 1}`))
  assert.equal(overview.clips[8].computedTiming.timeline.endSeconds, 9)
  assert.equal(overview.clips[8].computedTiming.source.midpointSeconds, null)
  assert.equal(overview.clips[0].keyframes, undefined)
  assert.equal(store.availability().availableResults[0].nextUnreadOffset, 0)
  const readable = readAll(store, header.resultId, 'readable')
  assert.equal(readable.pages[0].offset, 0)
  assert.ok(readable.pages[0].deliveryProgress.newChars > 0)
  assert.deepEqual(JSON.parse(decodeReadable(readable.raw).content[0].text), JSON.parse(result.content[0].text))
  const original = readAll(store, header.resultId, 'original')
  assert.equal(original.pages[0].offset, 0)
  assert.equal(original.raw, raw)
  store.dispose()
})

test('compacted get_timeline detail between 12 and 24 KiB remains complete and lossless inline', () => {
  const result = fixture({ padding: 2000 }), raw = JSON.stringify(result)
  assert.ok(raw.length > LIMITS.inlineChars)

  const genericStore = createToolResultStore()
  const generic = JSON.parse(genericStore.pack(result, 'generic'))
  assert.equal(generic.kind, 'local-tool-result-excerpt')
  assert.equal(generic.pagingAvailable, true)
  genericStore.dispose()

  const store = createToolResultStore(), header = pack(store, result)
  assert.ok(header.body.length > LIMITS.inlineChars)
  assert.ok(header.body.length <= LIMITS.timelineInlineChars)
  assert.equal(header.kind, 'local-tool-result-complete')
  assert.equal(header.complete, true)
  assert.equal(header.truncated, false)
  assert.equal(header.pagingAvailable, false)
  assert.equal(header.resultId, null)
  assert.equal(header.nextOffset, null)
  assert.deepEqual(JSON.parse(header.result.content[0].text), JSON.parse(result.content[0].text))
  assert.deepEqual(store.stats(), { storedBytes: 0, resultCount: 0, disposed: false })
  assert.equal(store.availability().pagingAvailable, false)
  store.dispose()
})

test('overview never consumes detail offsets; archive resets exact retained representations', () => {
  const store = createToolResultStore(), result = fixture(), header = pack(store, result)
  const before = store.stats().storedBytes
  assert.equal(store.compactReferenceForModel('read-one').resultId, header.resultId)
  store.readForModel({ resultId: header.resultId })
  store.archiveForModel(header.resultId)
  assert.equal(store.availability().availableResults[0].nextUnreadOffset, 0)
  assert.equal(readAll(store, header.resultId, 'original').raw, JSON.stringify(result))
  assert.deepEqual(JSON.parse(decodeReadable(readAll(store, header.resultId, 'readable').raw).content[0].text), JSON.parse(result.content[0].text))
  assert.equal(store.stats().storedBytes, before)
  store.dispose()
})

test('raw-only retention still exposes the readable fallback format and exact data after overview', () => {
  const raw = JSON.stringify(fixture())
  const charge = Math.max(raw.length * 2, Buffer.byteLength(raw)) + 1024
  const store = createToolResultStore({ maxStoredBytes: charge })
  const header = pack(store, raw)
  assert.equal(header.kind, 'local-tool-result-overview')
  assert.equal(header.readableFallback, 'original-mcp-json')
  assert.equal(header.nextOffset, 0)
  assert.equal(header.totalChars, raw.length)
  assert.equal(store.stats().storedBytes, charge)
  assert.equal(readAll(store, header.resultId, 'readable').raw, raw)
  assert.equal(readAll(store, header.resultId, 'original').raw, raw)
  store.dispose()
})

test('only exact get_timeline requests gain an overview, not snapshots or arbitrary tools', () => {
  for (const name of [undefined, 'get_project', 'edit_trim', 'get_timeline_other']) {
    const store = createToolResultStore()
    const header = parseModelTransport(store.packForModel(fixture(), 'read-one', { toolName: name }))
    assert.equal(header.kind, 'local-tool-result-excerpt')
    assert.equal(header.nextOffset, LIMITS.excerptChars)
    store.dispose()
  }
})

test('small complete results and readable results that already fit remain lossless inline', () => {
  for (const result of [fixture({ count: 1, padding: 0 }), fixture({ count: 1, padding: 3000 })]) {
    const store = createToolResultStore(), header = pack(store, result)
    assert.equal(header.kind, 'local-tool-result-complete')
    assert.deepEqual(JSON.parse(header.result.content[0].text), JSON.parse(result.content[0].text))
    store.dispose()
  }
})

test('capacity, oversized overview and malformed native result retain existing explicit fallback', () => {
  const cases = [
    [createToolResultStore({ maxStoredBytes: 100 }), fixture()],
    [createToolResultStore(), fixture({ count: 100, padding: 100 })],
    [createToolResultStore(), { content: [{ type: 'text', text: 'malformed'.repeat(2000) }] }],
    [createToolResultStore(), { ...fixture(), isError: true }],
    [createToolResultStore(), { ...fixture(), structuredContent: { success: false } }],
  ]
  for (const [store, result] of cases) {
    const header = pack(store, result)
    assert.equal(header.kind, 'local-tool-result-excerpt')
    assert.equal(header.complete, false)
    assert.notEqual(header.overviewComplete, true)
    store.dispose()
  }
})

test('sliced native timeline lists every returned clip but cannot claim whole-timeline coverage', () => {
  const store = createToolResultStore(), result = fixture(), detail = JSON.parse(result.content[0].text)
  detail.clipCount = 25; detail.clipLimitApplied = true
  result.content[0].text = JSON.stringify(detail)
  const overview = JSON.parse(pack(store, result).body)
  assert.deepEqual(overview.coverage, { returnedClips: 9, totalClips: 25, allTimelineClipsIncluded: false,
    allReturnedClipsListed: true, clipLimitApplied: true })
  store.dispose()
})

test('actual adapter sends overview then exact full detail without rerunning the native inspection', async () => {
  const original = fixture(), calls = [], bodies = []
  let resultId, assembled = ''
  const reply = message => new Response(JSON.stringify({ choices: [{ message,
    finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }))
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const result = await sendLocalWithTools({ model: 'any-model', endpoint: 'http://127.0.0.1:1234/v1', context: '{}', images: [],
    messages: [{ role: 'user', content: 'Inspect; do not edit.' }] }, {
    toolSession: { listTools: async () => [{ name: 'get_timeline', description: 'Inspect', inputSchema: { type: 'object', properties: {} } }],
      callTool: async (...args) => { calls.push(args); return original } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body)
      assert.ok(bodies.length < 10)
      if (bodies.length === 1) return reply({ tool_calls: [call('read-one', 'get_timeline', {})] })
      const transport = parseModelTransport(body.messages.at(-1).content)
      assert.equal(body.messages.at(-1).role, 'tool')
      if (bodies.length === 2) {
        assert.equal(transport.kind, 'local-tool-result-overview')
        assert.equal(JSON.parse(transport.body).clips.length, 9)
        resultId = transport.resultId
      } else {
        assembled += transport.raw
        if (bodies.length === 3) assert.equal(transport.offset, 0)
        if (transport.endOfResult) return reply({ content: 'Read the full detail without changes.' })
      }
      return reply({ tool_calls: [call(`page-${bodies.length}`, 'read_velorn_tool_result', { resultId, representation: 'original' })] })
    },
  })
  assert.equal(result.success, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'get_timeline')
  assert.equal(assembled, JSON.stringify(original))
})
