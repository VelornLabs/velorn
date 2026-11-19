'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createToolResultStore, LIMITS, PAGE_TOOL, compactJsonText, formatModelHelperResult } = require('../electron/localAgentToolResults.cjs')

const result = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra })
const large = (extra = {}) => result('Timeline data. '.repeat(10000), extra)
const packed = (store, value = large(), callId = 'timeline_call') => JSON.parse(store.pack(value, callId))
function reconstruct(store, envelope, maxChars = LIMITS.pageChars) {
  let offset = 0, raw = ''
  while (offset !== null) {
    const page = store.read({ resultId: envelope.resultId, offset, maxChars })
    assert.equal(page.offset, offset)
    assert.equal(page.raw.length, page.endOffset - offset)
    assert.ok(page.raw.length <= maxChars)
    assert.equal(page.totalChars, envelope.totalChars)
    assert.equal(page.complete, false, 'No single page of a large original is a complete result')
    assert.equal(page.truncated, true)
    assert.equal(page.completeness, 'slice-of-original-result')
    assert.equal(page.endOfResult, page.nextOffset === null)
    raw += page.raw
    offset = page.nextOffset
  }
  return raw
}

test('small MCP results are explicitly complete and preserve all original fields, metadata and errors', () => {
  const store = createToolResultStore()
  for (const value of [result('OK'), result('Denied', { isError: true, error: { code: 'DENIED' } }),
    result('No claims', { isError: false, success: false, structuredContent: { unexpected: [1, 2] }, _meta: { custom: 'keep' } }),
    result('Original fields cannot override the transport receipt', { kind: 'original-kind', complete: false, pagingAvailable: true, result: { keep: 'nested' } })]) {
    const raw = JSON.stringify(value, null, 2)
    for (const original of [raw, value]) {
      const wrapper = JSON.parse(store.pack(original, 'small'))
      assert.deepEqual(wrapper, { kind: 'local-tool-result-complete', format: 'mcp-json', complete: true,
        truncated: false, pagingAvailable: false, result: value })
    }
  }
  assert.deepEqual(store.stats(), { storedBytes: 0, resultCount: 0, disposed: false })
})

test('the inline boundary is inclusive and oversized results are explicitly incomplete', () => {
  const store = createToolResultStore()
  const overhead = JSON.stringify(result('')).length
  const exact = JSON.stringify(result('a'.repeat(LIMITS.inlineChars - overhead)))
  assert.equal(exact.length, LIMITS.inlineChars)
  assert.deepEqual(JSON.parse(store.pack(exact, 'exact')).result, JSON.parse(exact))
  assert.equal(JSON.parse(store.pack(exact, 'exact')).complete, true)
  const envelope = packed(store, result('a'.repeat(LIMITS.inlineChars + 1 - overhead)))
  assert.equal(envelope.kind, 'local-tool-result-excerpt')
  assert.equal(envelope.complete, false); assert.equal(envelope.truncated, true)
  assert.equal(envelope.needsReview, true); assert.equal(envelope.pagingAvailable, true)
  assert.equal(envelope.totalChars, LIMITS.inlineChars + 1)
  assert.equal(envelope.excerpt.length, LIMITS.excerptChars)
  assert.equal(envelope.nextOffset, LIMITS.excerptChars)
  assert.match(envelope.notice, /not a complete result or proof of success/)
  assert.equal(Object.hasOwn(envelope, 'success'), false)
})

test('a 100KB-plus timeline result reconstructs exactly without dropping duplicate structuredContent or metadata', () => {
  const store = createToolResultStore()
  const timeline = { tracks: Array.from({ length: 1000 }, (_, index) => ({ id: `clip-${index}`, start: index / 3,
    source: `project-relative/clip-${index}.mp4`, label: 'A detailed editable timeline clip '.repeat(3) })) }
  const original = result(JSON.stringify(timeline), { structuredContent: timeline, _meta: { revision: 42 }, extra: { keep: true } })
  const raw = JSON.stringify(original)
  assert.ok(Buffer.byteLength(raw) > 100000)
  const envelope = packed(store, raw)
  assert.equal(envelope.excerpt, raw.slice(0, LIMITS.excerptChars))
  assert.equal(reconstruct(store, envelope), raw)
  assert.deepEqual(JSON.parse(reconstruct(store, envelope)), original)
  const continuation = store.read({ resultId: envelope.resultId, offset: envelope.nextOffset })
  assert.equal(continuation.raw, raw.slice(LIMITS.excerptChars, LIMITS.excerptChars + LIMITS.pageChars))
})

test('Unicode and split surrogate pairs reconstruct without normalization or loss', () => {
  const store = createToolResultStore()
  const raw = JSON.stringify(result('🎬漢字e\u0301\\\n'.repeat(3000)))
  const envelope = packed(store, raw)
  assert.equal(reconstruct(store, envelope, 37), raw)
  const ending = store.read({ resultId: envelope.resultId, offset: raw.length })
  assert.equal(ending.raw, ''); assert.equal(ending.endOfResult, true)
  assert.equal(ending.complete, false); assert.equal(ending.nextOffset, null)
})

test('source error signals are preserved without interpreting text as proof of success', () => {
  const store = createToolResultStore()
  for (const extra of [{ isError: true }, { isError: false }, { success: false, error: { secretDetails: 'available in original only' } }, {}]) {
    const original = large(extra)
    const envelope = packed(store, original)
    assert.equal(envelope.sourceIsError, typeof extra.isError === 'boolean' ? extra.isError : null)
    assert.equal(envelope.sourceSuccess, typeof extra.success === 'boolean' ? extra.success : null)
    assert.equal(envelope.sourceErrorPresent, Object.hasOwn(extra, 'error'))
    assert.equal(envelope.needsReview, true)
    const page = store.read({ resultId: envelope.resultId })
    assert.equal(page.sourceIsError, envelope.sourceIsError)
    assert.equal(page.sourceSuccess, envelope.sourceSuccess)
    assert.equal(page.sourceErrorPresent, envelope.sourceErrorPresent)
    assert.deepEqual(JSON.parse(reconstruct(store, envelope)), original)
  }
  const innerFailure = packed(store, result(JSON.stringify({ success: false, error: 'Denied', data: 'x'.repeat(14000) })))
  assert.equal(innerFailure.sourceIsError, null, 'Only explicit outer metadata is interpreted')
  assert.equal(innerFailure.sourceSuccess, null)
  assert.equal(innerFailure.needsReview, true)
})

test('opaque IDs are isolated to one store, never derived from tool arguments or call IDs', () => {
  const a = createToolResultStore(), b = createToolResultStore()
  const first = packed(a), second = packed(a)
  assert.match(first.resultId, /^result_[a-f0-9-]{36}$/)
  assert.notEqual(first.resultId, second.resultId)
  assert.equal(first.resultId.includes(first.toolCallId), false)
  assert.throws(() => b.read({ resultId: first.resultId }), { code: 'LOCAL_TOOL_RESULT_NOT_FOUND' })
  for (const resultId of [undefined, null, 1, {}, '__proto__', 'private-path-token', 'result_00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => a.read({ resultId }), error => error.code === 'LOCAL_TOOL_RESULT_NOT_FOUND' && !error.message.includes('private-path-token'))
  }
})

test('paging rejects unsafe bounds, coercions and unknown arguments rather than silently clamping them', () => {
  const store = createToolResultStore(), envelope = packed(store)
  for (const offset of [-1, 0.5, NaN, Infinity, '0', null, envelope.totalChars + 1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.read({ resultId: envelope.resultId, offset }), { code: 'LOCAL_TOOL_RESULT_ARGUMENTS' })
  }
  for (const maxChars of [-1, 0, 1.1, NaN, Infinity, '100', null, LIMITS.pageChars + 1]) {
    assert.throws(() => store.read({ resultId: envelope.resultId, maxChars }), { code: 'LOCAL_TOOL_RESULT_ARGUMENTS' })
  }
  for (const args of [null, [], { resultId: envelope.resultId, path: '/not-allowed' }]) {
    assert.throws(() => store.read(args), { code: 'LOCAL_TOOL_RESULT_ARGUMENTS' })
  }
  assert.equal(store.read({ resultId: envelope.resultId, maxChars: 1 }).raw.length, 1)
})

test('model reader owns page sizing and continues from the first unread character without losing data', () => {
  assert.deepEqual(Object.keys(PAGE_TOOL.function.parameters.properties), ['resultId', 'offset', 'position', 'representation'])
  assert.deepEqual(PAGE_TOOL.function.parameters.properties.position.enum, ['start', 'next', 'end'])
  assert.equal(PAGE_TOOL.function.parameters.additionalProperties, false)
  assert.deepEqual(PAGE_TOOL.function.parameters.required, ['resultId'])
  const store = createToolResultStore()
  const original = result('🎬漢字\\\n'.repeat(6000), { isError: true, structuredContent: { exact: 'keep this copy too' } })
  const raw = JSON.stringify(original), envelope = packed(store, raw)
  let reconstructed = envelope.excerpt, previous = envelope.nextOffset, pages = 0
  while (previous !== null) {
    const page = store.readForModel({ resultId: envelope.resultId, maxChars: 2000 })
    assert.equal(page.offset, previous)
    assert.equal(page.raw, raw.slice(previous, previous + LIMITS.pageChars))
    assert.equal(page.raw.length, Math.min(LIMITS.pageChars, raw.length - previous))
    assert.equal(page.complete, false)
    assert.equal(page.truncated, true)
    assert.equal(page.needsReview, true)
    assert.equal(page.sourceIsError, true)
    assert.equal(page.deliveryProgress.newChars, page.raw.length)
    reconstructed += page.raw; previous = page.nextOffset; pages++
  }
  assert.equal(pages, Math.ceil((raw.length - LIMITS.excerptChars) / LIMITS.pageChars))
  assert.equal(reconstructed, raw)
  assert.deepEqual(JSON.parse(reconstructed), original)
  const done = store.readForModel({ resultId: envelope.resultId })
  assert.equal(done.raw, '')
  assert.equal(done.offset, raw.length)
  assert.equal(done.nextOffset, null)
  assert.equal(done.deliveryProgress.newChars, 0)
  assert.equal(done.deliveryProgress.allCharsDelivered, true)
  assert.equal(done.complete, false, 'Already-delivered data must not turn an empty page into a complete original result')
})

test('model reader preserves explicit seeks and validates legacy page sizes before applying host policy', () => {
  const store = createToolResultStore(), envelope = packed(store)
  for (const maxChars of [1, 2000, LIMITS.pageChars]) {
    const page = store.readForModel({ resultId: envelope.resultId, offset: 2000, maxChars })
    assert.equal(page.offset, 2000)
    assert.equal(page.endOffset, 2000 + LIMITS.pageChars)
    assert.equal(page.raw.length, LIMITS.pageChars)
  }
  const seek = store.readForModel({ resultId: envelope.resultId, offset: 40000 })
  assert.equal(seek.offset, 40000)
  assert.equal(seek.deliveryProgress.nextUnreadOffset, 14000)
  assert.equal(store.readForModel({ resultId: envelope.resultId }).offset, 14000, 'Automatic continuation fills the first delivery gap')
  for (const args of [null, [], { resultId: envelope.resultId, unexpected: true },
    ...[-1, 0, 1.1, NaN, Infinity, '2000', null, LIMITS.pageChars + 1].map(maxChars => ({ resultId: envelope.resultId, maxChars })),
    ...[-1, 0.5, NaN, Infinity, '0', null, envelope.totalChars + 1].map(offset => ({ resultId: envelope.resultId, offset }))]) {
    assert.throws(() => store.readForModel(args), { code: 'LOCAL_TOOL_RESULT_ARGUMENTS' })
  }
  assert.throws(() => store.readForModel({ resultId: 'result_00000000-0000-0000-0000-000000000000' }), { code: 'LOCAL_TOOL_RESULT_NOT_FOUND' })
  const other = createToolResultStore()
  assert.throws(() => other.readForModel({ resultId: envelope.resultId }), { code: 'LOCAL_TOOL_RESULT_NOT_FOUND' })
  store.dispose()
  assert.throws(() => store.readForModel({ resultId: envelope.resultId }), { code: 'LOCAL_TOOL_RESULT_DISPOSED' })
})

test('model reader lets bounded positions override redundant offsets and rejects invalid positions', () => {
  const store = createToolResultStore(), envelope = packed(store)
  assert.equal(store.readForModel({ resultId: envelope.resultId, position: 'start', offset: envelope.totalChars }).offset, 0)
  assert.equal(store.readForModel({ resultId: envelope.resultId, position: 'next', offset: 0 }).offset, LIMITS.pageChars)
  const end = store.readForModel({ resultId: envelope.resultId, position: 'end', offset: 0 })
  assert.equal(end.offset, Math.max(0, envelope.totalChars - LIMITS.pageChars))
  assert.equal(end.endOffset, envelope.totalChars)
  assert.equal(end.requestedPosition, 'end')
  assert.equal(end.requestedSelectionComplete, true)
  assert.match(end.nextAction, /answer now; do not request position:end again/)
  for (const position of ['', 'tail', 'END', null, 0, false, {}, []]) {
    assert.throws(() => store.readForModel({ resultId: envelope.resultId, position }), { code: 'LOCAL_TOOL_RESULT_ARGUMENTS' })
  }
})

test('images must first pass through the existing vision guard; text markers remain valid', () => {
  const store = createToolResultStore()
  for (const original of [{ content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }] },
    result('metadata', { structuredContent: { hidden: { type: 'image', data: 'YQ==' } } }),
    result('data:image/png;base64,YQ=='), result('metadata', { nested: { type: 'image_url', image_url: { url: 'anything' } } })]) {
    assert.throws(() => store.pack(original, 'image'), { code: 'LOCAL_TOOL_RESULT_IMAGE' })
  }
  const safe = result('Tool image omitted: image sharing is off. Do not claim to have seen it.')
  assert.deepEqual(JSON.parse(store.pack(JSON.stringify(safe), 'image_omitted')).result, safe)
  const imageClipMetadata = result('Image clip metadata is not image bytes.', { structuredContent: { clips: [{ type: 'image', path: 'media/still.png' }] } })
  assert.deepEqual(JSON.parse(store.pack(imageClipMetadata, 'image_metadata')).result, imageClipMetadata)
  assert.equal(store.stats().resultCount, 0)
})

test('page failures give bounded machine-readable recovery metadata without echoing untrusted values', () => {
  const store = createToolResultStore()
  let empty
  try { store.read({ resultId: '/private/path?secret=token' }) } catch (error) { empty = store.errorResult(error) }
  assert.equal(empty.error.code, 'LOCAL_TOOL_RESULT_NOT_FOUND')
  assert.equal(empty.pagingAvailable, false)
  assert.deepEqual(empty.availableResults, [])
  assert.match(empty.nextAction, /Complete results already contain their full result object/)
  assert.doesNotMatch(JSON.stringify(empty), /private\/path|secret|token/)
  const envelope = packed(store)
  let invalid
  try { store.read({ resultId: envelope.resultId, offset: envelope.totalChars + 1 }) } catch (error) { invalid = store.errorResult(error) }
  assert.equal(invalid.error.code, 'LOCAL_TOOL_RESULT_ARGUMENTS')
  assert.equal(invalid.requestedResult.resultId, envelope.resultId)
  assert.equal(invalid.requestedResult.totalChars, envelope.totalChars)
  assert.equal(invalid.requestedResult.nextUnreadOffset, LIMITS.excerptChars)
  assert.equal(invalid.requestedResult.maxChars, LIMITS.pageChars)
  assert.match(invalid.error.message, /Omit offset to read the next unread page/)
  assert.match(invalid.error.message, /Velorn manages the bounded page size/)
  assert.doesNotMatch(invalid.error.message, /maxChars|page size from|1 to 12000/)
  assert.doesNotMatch(JSON.stringify(invalid), /Timeline data/)
  for (let i = 0; i < 6; i++) packed(store, large(), `extra_${i}`)
  const forged = store.errorResult(new Error('/secret/internal/error'))
  assert.equal(forged.error.code, 'LOCAL_TOOL_RESULT_UNAVAILABLE')
  assert.equal(forged.availableResults.length, 4)
  assert.equal(forged.otherResultCount, 3)
  assert.doesNotMatch(JSON.stringify(forged), /secret|internal/)
  store.dispose()
  assert.equal(store.availability().pagingAvailable, false)
  assert.equal(store.availability().availableResultCount, 0)
})

test('page delivery progress counts only new characters, including overlaps, gaps and empty tail reads', () => {
  const store = createToolResultStore(), envelope = packed(store, result('x'.repeat(15000)))
  const read = (offset, maxChars) => store.read({ resultId: envelope.resultId, offset, maxChars })
  const repeatedExcerpt = read(0, 3000)
  assert.equal(repeatedExcerpt.deliveryProgress.newChars, 0)
  assert.equal(repeatedExcerpt.deliveryProgress.nextUnreadOffset, 3000)
  assert.equal(read(2000, 3000).deliveryProgress.newChars, 2000)
  assert.equal(read(8000, 3000).deliveryProgress.newChars, 3000)
  assert.equal(read(5000, 3000).deliveryProgress.nextUnreadOffset, 11000)
  const end = read(11000, 12000)
  assert.equal(end.deliveryProgress.newChars, envelope.totalChars - 11000)
  assert.equal(end.deliveryProgress.allCharsDelivered, true)
  assert.equal(end.complete, false, 'Delivered pages do not change an individual slice into a full result')
  assert.equal(read(0, 12000).deliveryProgress.newChars, 0)
  assert.equal(read(envelope.totalChars, 1).deliveryProgress.newChars, 0)
})

test('memory and entry caps never evict old pages or disguise discarded data as a complete result', () => {
  const store = createToolResultStore()
  const original = large({ isError: true })
  const first = packed(store, original)
  let last
  for (let index = 0; index < 60; index++) {
    last = packed(store, original, `call_${index}`)
    assert.ok(store.stats().storedBytes <= LIMITS.storedBytes)
    assert.ok(store.stats().resultCount <= LIMITS.results)
  }
  assert.equal(last.pagingAvailable, false); assert.equal(last.resultId, null)
  assert.equal(last.complete, false); assert.equal(last.truncated, true); assert.equal(last.sourceIsError, true)
  assert.equal(last.retrievalError.code, 'LOCAL_TOOL_RESULT_CAPACITY')
  assert.match(last.retrievalError.message, /original action may already have completed/)
  assert.equal(reconstruct(store, first), JSON.stringify(original))
  const single = createToolResultStore({ maxResults: 1 })
  assert.equal(packed(single).pagingAvailable, true)
  assert.equal(packed(single).pagingAvailable, false)
  const tiny = createToolResultStore({ maxStoredBytes: 1 })
  assert.equal(packed(tiny).pagingAvailable, false)
  assert.equal(tiny.stats().storedBytes, 0)
})

test('malformed input and end-of-turn disposal never leak or keep restorable pages', () => {
  const store = createToolResultStore(), envelope = packed(store)
  const cyclic = result('cyclic'); cyclic.self = cyclic
  for (const input of ['not JSON', null, [], {}, { content: 'text' }, cyclic]) {
    assert.throws(() => store.pack(input, 'bad'), { code: 'LOCAL_TOOL_RESULT_INVALID' })
  }
  for (const id of [null, '', '../path', 'x'.repeat(129)]) assert.throws(() => store.pack(result('text'), id), { code: 'LOCAL_TOOL_RESULT_INVALID' })
  store.dispose(); store.dispose()
  assert.deepEqual(store.stats(), { storedBytes: 0, resultCount: 0, disposed: true })
  assert.throws(() => store.read({ resultId: envelope.resultId }), { code: 'LOCAL_TOOL_RESULT_DISPOSED' })
  assert.throws(() => store.pack(result('text'), 'late'), { code: 'LOCAL_TOOL_RESULT_DISPOSED' })
  for (const options of [{ maxStoredBytes: 0 }, { maxStoredBytes: LIMITS.storedBytes + 1 }, { maxResults: '1' }]) {
    assert.throws(() => createToolResultStore(options), { code: 'LOCAL_TOOL_RESULT_INVALID' })
  }
})

const modelParts = value => {
  const newline = value.indexOf('\n\n')
  return { header: JSON.parse(newline < 0 ? value : value.slice(0, newline)), body: newline < 0 ? '' : value.slice(newline + 2) }
}

test('tail offsets are exposed and position end reads the bounded final page of each representation', () => {
  const store = createToolResultStore()
  const original = result(`${'middle '.repeat(6000)}UNIQUE_FINAL_VALUE`)
  const raw = JSON.stringify(original), first = modelParts(store.packForModel(original, 'tail_page'))
  assert.equal(first.header.complete, false)
  assert.equal(first.header.tailOffset, first.header.totalChars - LIMITS.pageChars)
  assert.ok(first.header.tailOffset > first.header.nextOffset)

  const available = store.availability().availableResults[0]
  assert.equal(available.resultId, first.header.resultId)
  assert.equal(available.tailOffset, first.header.tailOffset)
  assert.equal(available.totalChars, first.header.totalChars)

  const readableTail = store.readForModel({ resultId: first.header.resultId, position: 'end' })
  assert.equal(readableTail.representation, 'readable')
  assert.equal(readableTail.offset, first.header.tailOffset)
  assert.equal(readableTail.endOffset, first.header.totalChars)
  assert.equal(readableTail.raw.length, LIMITS.pageChars)
  assert.match(readableTail.raw, /UNIQUE_FINAL_VALUE/)
  assert.equal(readableTail.nextOffset, null)
  assert.equal(readableTail.endOfResult, true)
  assert.equal(readableTail.requestedSelectionComplete, true)
  assert.equal(readableTail.deliveryProgress.allCharsDelivered, false, 'A tail seek must not disguise the unread middle gap')

  const originalTail = store.readForModel({ resultId: first.header.resultId, representation: 'original', position: 'end' })
  assert.equal(originalTail.representation, 'original')
  assert.equal(originalTail.offset, raw.length - LIMITS.pageChars)
  assert.equal(originalTail.endOffset, raw.length)
  assert.equal(originalTail.raw, raw.slice(-LIMITS.pageChars))
  assert.equal(originalTail.nextOffset, null)
  assert.equal(originalTail.endOfResult, true)
})

test('readable JSON text compacts whitespace without changing unsafe numbers, duplicate keys, strings or free text', () => {
  const text = '{\n "large": 9007199254740993, "decimal": 1.2300, "k": 1, "k": 2, "escaped": "a \\n \\u0020 \\\""\n}'
  assert.equal(compactJsonText(text), '{"large":9007199254740993,"decimal":1.2300,"k":1,"k":2,"escaped":"a \\n \\u0020 \\\""}')
  for (const value of [' not JSON\n ', ' {invalid} ', '  "a JSON string"\n', ' 9007199254740993\n', ' false ', '[1,]']) assert.equal(compactJsonText(value), value)
  const store = createToolResultStore()
  const output = modelParts(store.packForModel(result(text, { custom: { preserve: 'metadata' } }), 'numbers'))
  assert.equal(output.header.complete, true)
  assert.match(output.body, /9007199254740993/)
  assert.match(output.body, /1\.2300/)
  // Exact MCP serialization can be selected when token-preserving readability
  // is not useful; opaque non-text fields are never selectively dropped.
  assert.match(output.body, /metadata/)
})

test('readable paged output preserves semantic fields and exact original serialization remains independently retrievable', () => {
  const store = createToolResultStore()
  const value = result(JSON.stringify({ clips: Array.from({ length: 200 }, (_, n) => ({ id: `clip-${n}`, start: n / 24, note: 'string with spaces' })) }, null, 2),
    { isError: false, unknown: { nested: ['preserved', 123] } })
  const original = JSON.stringify(value, null, 2), first = modelParts(store.packForModel(original, 'timeline'))
  assert.equal(first.header.format, 'readable-mcp-v1')
  assert.equal(first.header.complete, false)
  assert.equal(first.header.sourceIsError, false)
  let readable = first.body, page
  do {
    page = store.readForModel({ resultId: first.header.resultId })
    assert.equal(page.representation, 'readable')
    assert.equal(page.completeness, 'slice-of-readable-result')
    const formatted = modelParts(formatModelHelperResult(page))
    assert.equal(formatted.body, page.raw)
    assert.equal(formatted.header.bodyChars, page.raw.length)
    assert.equal(Object.hasOwn(formatted.header, 'raw'), false)
    readable += page.raw
  } while (page.nextOffset !== null)
  assert.match(readable, /"unknown":\{"nested":\["preserved",123\]\}/)
  assert.ok(readable.includes(compactJsonText(value.content[0].text)))
  let restored = '', offset = 0
  do {
    page = store.readForModel({ resultId: first.header.resultId, representation: 'original', offset })
    assert.equal(page.representation, 'original')
    restored += page.raw; offset = page.nextOffset
  } while (offset !== null)
  assert.equal(restored, original)
  assert.throws(() => store.readForModel({ resultId: first.header.resultId, representation: 'guessed' }), { code: 'LOCAL_TOOL_RESULT_ARGUMENTS' })
})

test('readable projection remains complete at the old small-result boundary and preserves failure metadata', () => {
  const store = createToolResultStore(), overhead = JSON.stringify(result('')).length
  const original = result('x'.repeat(LIMITS.inlineChars - overhead))
  const projected = modelParts(store.packForModel(original, 'boundary'))
  assert.equal(projected.header.complete, true)
  assert.equal(projected.header.truncated, false)
  assert.equal(projected.header.bodyChars, projected.body.length)
  assert.equal(projected.header.pagingAvailable, false)
  assert.ok(projected.body.endsWith(JSON.stringify(original)))
  for (const fields of [{ isError: true }, { success: false }, { error: { code: 'DENIED' } }]) {
    const failure = modelParts(store.packForModel(large(fields), 'failed'))
    assert.equal(failure.header.sourceIsError, fields.isError ?? null)
    assert.equal(failure.header.sourceSuccess, fields.success ?? null)
    assert.equal(failure.header.sourceErrorPresent, Object.hasOwn(fields, 'error'))
    assert.equal(store.compactReferenceForModel('failed'), null)
    assert.equal(store.archiveForModel(failure.header.resultId), null)
  }
  const helper = { kind: 'local-tool-result-page-error', isError: true, complete: false, error: { code: 'NO_RESULT' } }
  assert.deepEqual(JSON.parse(formatModelHelperResult(helper)), helper)
})

test('model projection storage is charged and constrained by the original capacity, with an explicit shared-original fallback', () => {
  const value = large(), raw = JSON.stringify(value), originalCharge = Math.max(raw.length * 2, Buffer.byteLength(raw)) + 1024
  const room = createToolResultStore(), projected = modelParts(room.packForModel(value, 'room'))
  assert.ok(room.stats().storedBytes > originalCharge)
  assert.ok(room.stats().storedBytes <= LIMITS.storedBytes)
  const constrained = createToolResultStore({ maxStoredBytes: originalCharge })
  const fallback = modelParts(constrained.packForModel(value, 'fallback'))
  assert.equal(fallback.header.readableFallback, 'original-mcp-json')
  assert.equal(constrained.stats().storedBytes, originalCharge)
  assert.equal(fallback.body, raw.slice(0, LIMITS.excerptChars))
  assert.equal(constrained.readForModel({ resultId: fallback.header.resultId }).raw, raw.slice(LIMITS.excerptChars, LIMITS.excerptChars + LIMITS.pageChars))
  const tiny = createToolResultStore({ maxStoredBytes: 1 }), unavailable = modelParts(tiny.packForModel(value, 'no-room'))
  assert.equal(unavailable.header.complete, false)
  assert.equal(unavailable.header.pagingAvailable, false)
  assert.equal(unavailable.header.retrievalError.code, 'LOCAL_TOOL_RESULT_CAPACITY')
  assert.equal(tiny.compactReferenceForModel('no-room'), null)
  assert.ok(projected.header.resultId)
})

test('archived read-only candidates preserve exact originals and reset delivery only on committed archive transitions', () => {
  const store = createToolResultStore(), initial = modelParts(store.packForModel(large(), 'read'))
  const first = store.readForModel({ resultId: initial.header.resultId })
  const before = store.availability().availableResults[0].nextUnreadOffset
  const reference = store.compactReferenceForModel('read')
  assert.equal(reference.resultId, initial.header.resultId)
  assert.equal(modelParts(reference.content).header.archived, true)
  const prepared = store.archiveForModel(reference.resultId, { commit: false })
  assert.deepEqual(prepared, reference)
  assert.equal(store.availability().availableResults[0].nextUnreadOffset, before)
  assert.deepEqual(store.archiveForModel(reference.resultId, { commit: true }), prepared)
  assert.equal(store.availability().availableResults[0].nextUnreadOffset, 0)
  const reread = store.readForModel({ resultId: reference.resultId })
  assert.equal(reread.offset, 0)
  assert.equal(reread.deliveryProgress.newChars, LIMITS.pageChars)
  assert.equal(first.offset, LIMITS.excerptChars)
  store.archiveForModel(reference.resultId, { commit: true })
  assert.equal(store.availability().availableResults[0].nextUnreadOffset, 0)
  assert.equal(store.archiveForModel('not-retained'), null)
})
