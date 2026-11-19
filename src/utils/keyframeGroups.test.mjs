import test from 'node:test'
import assert from 'node:assert/strict'
import { groupPassBySongPart, groupShotsByPass } from './keyframeGroups.mjs'

const shots = [
  { pass: 'Main sequence', start: 0 }, { pass: 'Main sequence', start: 7 }, { pass: 'Main sequence', start: 21 },
  { pass: 'Performance pass', start: 6 }, { pass: 'Story b-roll', start: 30 }, { pass: 'Main sequence', start: 36 },
  { pass: 'performance pass', start: 2 },
]
const parts = [
  { label: 'Chorus', kind: 'chorus', start: 6, end: 20 },
  { label: 'Verse 1', kind: 'verse', start: 20, end: 34 },
  { label: 'Chorus', kind: 'chorus', start: 35, end: 50 },
]

test('shots are grouped by pass in the order the script introduces them', () => {
  const passes = groupShotsByPass(shots, (shot) => shot.pass)
  assert.deepEqual(passes.map((pass) => [pass.label, pass.indexes]), [
    ['Main sequence', [0, 1, 2, 5]], ['Performance pass', [3, 6]], ['Story b-roll', [4]],
  ])
  assert.deepEqual(groupShotsByPass([{}, {}], () => '').map((pass) => [pass.label, pass.indexes]), [['Shots', [0, 1]]])
})

test('a pass is split into the parts of the song, in time order', () => {
  const main = groupShotsByPass(shots, (shot) => shot.pass)[0]
  const sections = groupPassBySongPart(main.indexes, shots, parts, (shot) => shot.start)
  assert.deepEqual(sections.map((section) => [section.label, section.indexes]), [
    ['Before the first line', [0]], ['Chorus', [1]], ['Verse 1', [2]], ['Chorus', [5]],
  ])
  const performance = groupShotsByPass(shots, (shot) => shot.pass)[1]
  assert.deepEqual(groupPassBySongPart(performance.indexes, shots, parts, (shot) => shot.start).map((section) => section.indexes), [[6], [3]])
})

test('without song parts or times a pass stays one plain list', () => {
  assert.deepEqual(groupPassBySongPart([0, 1], shots, [], (shot) => shot.start), [{ key: 'all', label: '', kind: '', start: null, indexes: [0, 1] }])
  assert.deepEqual(groupPassBySongPart([0, 1], [{}, {}], parts, (shot) => shot.start).map((section) => section.indexes), [[0, 1]])
  assert.deepEqual(groupPassBySongPart([], shots, parts, (shot) => shot.start), [])
})
