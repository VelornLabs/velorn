import test from 'node:test'
import assert from 'node:assert/strict'
import { scriptTimeBelongsInsideLine, trimOverlapsOnLayer } from '../src/utils/musicVideoPlacement.mjs'

const lines = [{ startSec: 0.3, text: 'Paper lanterns in my window' }, { startSec: 17.6, text: 'The city hums a lullaby' }, { startSec: 22.1, text: 'I keep your name in my pocket' }]

test('a shot placed well inside a long sung line keeps the script time', () => {
  assert.equal(scriptTimeBelongsInsideLine(6, lines[0], lines), true)
})
test('a script time that is only a little off still goes to the first word', () => {
  assert.equal(scriptTimeBelongsInsideLine(1.2, lines[0], lines), false)
  assert.equal(scriptTimeBelongsInsideLine(18, lines[1], lines), false)
})
test('a script time past the end of the line does not count as inside it', () => {
  assert.equal(scriptTimeBelongsInsideLine(18, lines[0], lines), false)
  assert.equal(scriptTimeBelongsInsideLine(9, { startSec: 0.3, endSec: 8 }, lines), false)
})
test('the last line has no next line, so any later time is inside it', () => {
  assert.equal(scriptTimeBelongsInsideLine(27, lines[2], lines), true)
})
test('no script time, or a line without a time, changes nothing', () => {
  assert.equal(scriptTimeBelongsInsideLine(null, lines[0], lines), false)
  assert.equal(scriptTimeBelongsInsideLine(6, { text: 'x' }, lines), false)
})

test('a clip that runs into the next one is cut to end where the next begins', () => {
  const rows = [{ startTime: 14, duration: 4 }, { startTime: 17.62, duration: 3 }, { startTime: 22.12, duration: 3 }, { startTime: 24, duration: 3 }]
  trimOverlapsOnLayer(rows, 0.5)
  assert.deepEqual(rows.map((r) => Number(r.duration.toFixed(2))), [3.62, 3, 1.88, 3])
})
test('clips that do not touch are left alone, whatever order they arrive in', () => {
  const rows = [{ startTime: 10, duration: 2 }, { startTime: 0, duration: 3 }]
  trimOverlapsOnLayer(rows, 0.5)
  assert.deepEqual(rows, [{ startTime: 10, duration: 2 }, { startTime: 0, duration: 3 }])
})
test('a clip is never cut below the shortest allowed length', () => {
  const rows = [{ startTime: 0, duration: 3 }, { startTime: 0.2, duration: 5 }]
  trimOverlapsOnLayer(rows, 0.5)
  assert.equal(rows[0].duration, 0.5)
})

// ---- the ready cut ----
import { buildReadyCut } from '../src/utils/musicVideoPlacement.mjs'

// The Rock Opera demo of 2026-11-13: four sung lines, one extra take, seven place shots.
const demo = () => [
  ...[[0, 0.58, false], [0.58, 4, true], [7.58, 3.42, true], [11, 3.5, false], [14.5, 5.5, true], [20, 1.54, false], [21.54, 5, true], [27, 3, false]]
    .map(([startTime, duration, sync], i) => ({ id: `main${i + 1}`, role: 'main', startTime, duration, sync })),
  ...[[0.58, 3.88], [7.58, 3.67], [14.5, 5.21], [21.54, 5.42]]
    .map(([startTime, duration], i) => ({ id: `take${i + 1}`, role: 'take', startTime, duration, sync: true })),
  ...[[0, 4], [4, 4], [8, 4], [12, 4.5], [16.5, 4], [20.5, 4], [24.5, 5.5]]
    .map(([startTime, duration], i) => ({ id: `place${i + 1}`, role: 'fill', startTime, duration, sync: false })),
]
const noOverlap = (cut) => cut.every((row, i) => i === 0 || cut[i - 1].startTime + cut[i - 1].duration <= row.startTime + 1e-6)

test('ready cut: the sung lines alternate between the main take and the extra take', () => {
  const cut = buildReadyCut(demo(), { songDuration: 30 })
  assert.deepEqual(cut.filter((row) => row.sync).map((row) => row.id), ['main2', 'take2', 'main5', 'take4'])
})

test('ready cut: a sung clip never moves, and nothing overlaps', () => {
  const rows = demo()
  const cut = buildReadyCut(rows, { songDuration: 30 })
  assert.ok(noOverlap(cut))
  for (const row of cut.filter((r) => r.sync)) assert.equal(row.startTime, rows.find((r) => r.id === row.id).startTime)
  // The extra take of line 2 is longer than the main one; it is cut where the next shot starts.
  assert.equal(cut.find((row) => row.id === 'take2').duration, 11 - 7.58)
})

test('ready cut: gaps are filled with place shots cut to fit, each used once', () => {
  const cut = buildReadyCut(demo(), { songDuration: 30 })
  const fills = cut.filter((row) => row.role === 'fill')
  // The gap after line 1 (4.58 to 7.58) gets the place shot the script put there.
  assert.deepEqual(fills.map((row) => [row.id, row.startTime, row.duration]), [['place2', 4.58, 3], ['place7', 26.96, 0.04]].filter(([, , d]) => d >= 0.4))
  assert.equal(new Set(fills.map((row) => row.id)).size, fills.length)
  // From the first second to the last, something is always on screen except slivers under 0.4 s.
  let cursor = 0
  for (const row of cut) { assert.ok(row.startTime - cursor < 0.4 + 1e-6); cursor = row.startTime + row.duration }
})

test('ready cut: a long gap takes several place shots, and stops when they run out', () => {
  const cut = buildReadyCut([
    { id: 'a', role: 'main', startTime: 0, duration: 2, sync: true },
    { id: 'b', role: 'main', startTime: 12, duration: 2, sync: true },
    { id: 'p1', role: 'fill', startTime: 0, duration: 4, sync: false },
    { id: 'p2', role: 'fill', startTime: 5, duration: 4, sync: false },
  ], { songDuration: 14 })
  assert.deepEqual(cut.map((row) => [row.id, row.startTime, row.duration]), [['a', 0, 2], ['p1', 2, 4], ['p2', 6, 4], ['b', 12, 2]])
})

test('ready cut: with no extra take it is the main shots plus fillers, and the rows given are left alone', () => {
  const rows = demo().filter((row) => row.role !== 'take')
  const before = JSON.stringify(rows)
  const cut = buildReadyCut(rows, { songDuration: 30 })
  assert.equal(cut.filter((row) => row.role === 'main').length, 8)
  assert.equal(JSON.stringify(rows), before)
})

test('ready cut: a sliver too short to fill is closed, so the picture never flashes black', () => {
  const rows = [
    { id: 'a', role: 'main', startTime: 0, duration: 4.96, sync: true, spare: 0.4 },
    { id: 'b', role: 'main', startTime: 5, duration: 3, sync: false, spare: 0 },
    { id: 'c', role: 'main', startTime: 8.1, duration: 2, sync: true, spare: 0 },
    { id: 'd', role: 'main', startTime: 10.2, duration: 2, sync: false, spare: 1 },
  ]
  const cut = buildReadyCut(rows, { songDuration: 12.2 })
  const near = (a, b) => Math.abs(a - b) < 1e-6
  // a plays a little longer; c is sung and b has nothing more, so that sliver stays; d starts sooner.
  assert.ok(near(cut[0].duration, 5))
  assert.ok(near(cut[2].startTime, 8.1))
  assert.ok(near(cut[3].startTime, 10.1) && near(cut[3].duration, 2.1))
})
