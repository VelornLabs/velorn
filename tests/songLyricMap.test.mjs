// The Song step's lyric lines: adding a line the listening missed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLineBelow, removeLine } from '../src/utils/songLyricMap.mjs'

const lines = () => [
  { start: 1, end: 3, text: 'one' },
  { start: 8, end: 10, text: 'two' },
  { start: 10, end: 12, text: 'three' },
]
const parts = [{ kind: 'verse', firstLine: 0 }, { kind: 'chorus', firstLine: 2 }]

test('a line added below starts in the gap, and the parts and marks after it move down', () => {
  const before = lines()
  const added = addLineBelow(before, parts, [0, 2], 0, 60)
  assert.equal(added.at, 1)
  assert.deepEqual(added.lines.map((line) => [line.start, line.end, line.text]), [[1, 3, 'one'], [3, 6, ''], [8, 10, 'two'], [10, 12, 'three']])
  assert.deepEqual(added.parts, [{ kind: 'verse', firstLine: 0 }, { kind: 'chorus', firstLine: 3 }])
  assert.deepEqual(added.unsure, [0, 3])
  assert.deepEqual(before, lines()) // the lines given are not changed
  // Taking it out again gives back what there was.
  const back = removeLine(added.lines, added.parts, added.unsure, added.at)
  assert.deepEqual([back.lines, back.parts, back.unsure], [lines(), parts, [0, 2]])
})

test('with no gap it goes halfway to the next line, and after the last line it follows on', () => {
  const tight = addLineBelow(lines(), parts, [], 1, 60)
  assert.deepEqual(tight.lines.slice(1, 3).map((line) => [line.start, line.end]), [[8, 9], [9, 10]])
  assert.deepEqual(tight.parts.map((part) => part.firstLine), [0, 3])
  const last = addLineBelow(lines(), parts, [], 2, 60)
  assert.deepEqual([last.at, last.lines[3].start, last.lines[3].end], [3, 12, 15])
  // Lines stay in order even when two start almost together.
  const close = addLineBelow([{ start: 5, end: 5.1, text: 'a' }, { start: 5.2, end: 6, text: 'b' }], [], [], 0)
  assert.ok(close.lines[0].start < close.lines[1].start && close.lines[1].start <= close.lines[2].start)
  assert.equal(addLineBelow(lines(), parts, [], 9).at, -1)
})
