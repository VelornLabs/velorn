'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { cases, finalRoundtripCase, getSnapshot, authoredSnapshot, canUndoDeletion } = require('../scripts/local-agent-direct-baseline-cases.cjs')
const clone = value => JSON.parse(JSON.stringify(value))
function seed() {
  let start = 0
  const clips = [3, 4, 4, 3, 3, 3].map((duration, i) => {
    const c = { id: `clip-${i + 1}`, type: 'video', assetId: `asset-${i + 1}`, trackId: 'picture-track',
      startTime: start, duration, trimStart: 0, trimEnd: duration, sourceDuration: 10, speed: 1, sourceTimeScale: 1 }
    start += duration
    return c
  })
  clips.push({ id: 'clip-7', type: 'audio', trackId: 'music-track', startTime: 0, duration: 20 },
    { id: 'clip-8', type: 'text', trackId: 'title-track', startTime: 0, duration: 3,
      text: 'SEE IT DIFFERENTLY', textProperties: { text: 'SEE IT DIFFERENTLY', fontSize: 70 }, keyframes: {} },
    { id: 'clip-9', type: 'text', trackId: 'title-track', startTime: 16, duration: 4, textProperties: { text: 'Made in Velorn' } })
  return { id: 'timeline-test', name: 'Existing sequence', width: 1920, height: 1080, fps: 24, duration: 20,
    clipCount: 9, clips, tracks: [{ id: 'picture-track' }, { id: 'title-track' }, { id: 'music-track' }],
    markers: [], transitions: [], transitionCount: 0, context: { revision: 1 } }
}
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const read = value => ({ name: 'get_timeline', arguments: {}, result: result(value) })
const write = (name, args = {}) => ({ name, arguments: { ...args, previewOnly: false }, result: result({ success: true }) })
const events = (before, after, ...writes) => [read(before), ...writes, read(after)]
const target = (s, id = 'clip-6') => s.clips.find(c => c.id === id)
const pass = assertions => assert.deepEqual(assertions.filter(a => !a.passed), [])

test('ten fixed cases are diagnostic-only data; complete MCP snapshots are decoded', () => {
  assert.equal(cases.length, 10)
  assert.deepEqual(cases.map(c => c.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(new Set(cases.map(c => c.name)).size, 10)
  assert.ok(cases.every(c => typeof c.prompt === 'string' && typeof c.verify === 'function'))
  assert.deepEqual(getSnapshot(result(seed())), seed())
  assert.equal(getSnapshot({ isError: true, ...result(seed()) }), null)
  const before = seed(), after = clone(before)
  after.context.revision++
  pass(cases[0].verify(before, after, [read(before)]))
})

test('all ten intended state outcomes and the exact single Undo are accepted', () => {
  let current = seed()
  const records = []
  for (const c of cases) {
    const before = clone(current), after = clone(current)
    let writes = []
    if (c.prerequisite) assert.equal(c.prerequisite(before, records), true, c.name)
    switch (c.id) {
      case 2: target(after).duration = target(after).trimEnd = 2.5; writes = [write('trim_clips')]; break
      case 4: target(after).duration = target(after).trimEnd = 3; writes = [write('trim_clips')]; break
      case 5:
        for (const [id, start] of [['clip-1', 0], ['clip-4', 3], ['clip-3', 6], ['clip-2', 10], ['clip-5', 14], ['clip-6', 17]]) target(after, id).startTime = start
        writes = [write('move_clips')]; break
      case 6:
        target(after, 'clip-8').text = target(after, 'clip-8').textProperties.text = 'LOCAL AGENT BASELINE'
        writes = [write('update_text_clip')]; break
      case 7:
        target(after, 'clip-8').keyframes.opacity = [0, 0.5, 2.5, 3].map((time, i) => ({ time, value: [0, 100, 100, 0][i], easing: 'linear' }))
        writes = [write('set_clip_keyframes')]; break
      case 8:
        target(after, 'clip-2').labelColor = '#f97316'
        after.markers.push({ id: 'new-marker', name: 'Local baseline check', time: 4, color: '#ffff00' })
        writes = [write('set_clip_label_color'), write('add_timeline_markers')]; break
      case 9:
        after.clips = after.clips.filter(c => c.id !== 'clip-8'); after.clipCount--
        writes = [write('delete_clips', { clipIds: ['clip-8'], ripple: false })]; break
      case 10:
        Object.assign(after, clone(records[8].before)); writes = [write('undo')]; break
    }
    const calls = events(before, after, ...writes)
    pass(c.verify(before, after, calls, records))
    records.push({ name: c.name, before, after, events: calls })
    current = after
  }
  assert.equal(target(current, 'clip-8').textProperties.text, 'LOCAL AGENT BASELINE')
  assert.equal(current.markers.length, 1)
  assert.equal(target(current, 'clip-2').startTime, 10)
})

test('native state success does not erase missing model readback or collateral damage', () => {
  const before = seed(), after = clone(before)
  target(after).duration = target(after).trimEnd = 2.5
  let checks = cases[1].verify(before, after, [read(before), write('trim_clips')])
  assert.equal(checks.find(a => /absolute timing/.test(a.name)).passed, true)
  assert.equal(checks.find(a => /read back/.test(a.name)).passed, false)
  target(after, 'clip-1').duration = 2
  checks = cases[1].verify(before, after, events(before, after, write('trim_clips')))
  assert.equal(checks.find(a => /Only last-picture/.test(a.name)).passed, false)
  const sliced = clone(before); sliced.clips.pop(); sliced.clipLimitApplied = true
  assert.equal(cases[0].verify(before, sliced, [read(sliced)])[0].passed, false)
})

test('repetition requires its established starting state; marker duplicates fail', () => {
  const before = seed(), after = clone(before)
  target(after).duration = target(after).trimEnd = 2.5
  assert.equal(cases[2].verify(before, after, events(before, after)).find(a => /starting state/.test(a.name)).passed, false)
  target(after, 'clip-2').labelColor = '#f97316'
  after.markers = [{ id: 'a', time: 4, name: 'Local baseline check' }, { id: 'b', time: 4, name: 'Local baseline check' }]
  assert.equal(cases[7].verify(before, after, events(before, after)).find(a => /Exactly one/.test(a.name)).passed, false)
})

test('Undo cannot run after failed deletion, repeated edits, changed state or without evidence', () => {
  const before = seed(), after = clone(before)
  after.clips = after.clips.filter(c => c.id !== 'clip-8'); after.clipCount--
  const record = { name: cases[8].name, before, after, events: events(before, after, write('delete_clips', { clipIds: ['clip-8'], ripple: false })) }
  assert.equal(canUndoDeletion(after, [record]), true)
  assert.equal(canUndoDeletion(after, []), false)
  assert.equal(canUndoDeletion(before, [record]), false)
  assert.equal(canUndoDeletion(after, [{ ...record, after: before }]), false)
  assert.equal(canUndoDeletion(after, [{ ...record, events: [...record.events, write('update_text_clip')] }]), false)
  const changed = clone(after); target(changed).duration = 2
  assert.equal(canUndoDeletion(changed, [record]), false)
  const checks = cases[9].verify(after, before, events(after, before, write('undo'), write('undo')), [record])
  assert.equal(checks.find(a => /Exactly one Undo/.test(a.name)).passed, false)
  assert.deepEqual(authoredSnapshot(before), authoredSnapshot(clone(before)))
})

test('final roundtrip requires one actual delete, intermediate inspection and one actual Undo', () => {
  const before = seed(), deleted = clone(before), restored = clone(before)
  deleted.clips = deleted.clips.filter(c => c.id !== 'clip-8'); deleted.clipCount--
  const deletion = { ...write('delete_clips', { clipIds: ['clip-8'], ripple: false }),
    result: result({ success: true, result: { deletedCount: 1, deletedClipIds: ['clip-8'], ripple: false } }) }
  const undo = { ...write('undo'), result: result({ success: true, result: { applied: true, success: true } }) }
  const calls = [read(before), deletion, read(deleted), undo, read(restored)]
  assert.equal(finalRoundtripCase.prerequisite(before), true)
  pass(finalRoundtripCase.verify(before, restored, calls))
  assert.ok(finalRoundtripCase.verify(before, restored, [read(before), deletion, undo, read(restored)]).some(a => !a.passed && /between/.test(a.name)))
  assert.ok(finalRoundtripCase.verify(before, restored, [...calls, undo, read(restored)]).some(a => !a.passed && /Exactly one native Undo/.test(a.name)))
  assert.ok(finalRoundtripCase.verify(before, restored, [read(before), read(restored)]).some(a => !a.passed && /native non-ripple/.test(a.name)))
})
