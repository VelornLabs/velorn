import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSongSections, findChorusLines, findLineAt, formatClock, formatSrtLines, parseSrtLines,
  readLyricFile, setLineStart, setLineText, shiftAllLines,
} from './songLyricMap.mjs'

const SRT = `1
00:00:06,400 --> 00:00:08,700
First chorus line

2
00:00:09,900 --> 00:00:12,200
Second chorus line

3
00:00:20,000 --> 00:00:23,000
A verse line
`

test('SRT text round-trips through lines', () => {
  const lines = parseSrtLines(SRT)
  assert.deepEqual(lines.map((line) => line.start), [6.4, 9.9, 20])
  assert.equal(lines[2].text, 'A verse line')
  assert.deepEqual(parseSrtLines(formatSrtLines(lines)), lines)
})

test('broken blocks are skipped instead of failing the whole file', () => {
  const lines = parseSrtLines(`1\nnot a time\nhello\n\n2\n00:00:01,000 --> 00:00:02,000\nkept`)
  assert.deepEqual(lines, [{ start: 1, end: 2, text: 'kept' }])
})

test('a song map file marks low-confidence lines to check', () => {
  const result = readLyricFile(JSON.stringify({ rows: [
    { start: 1, end: 2, text: 'sure', conf: 0.8 },
    { start: 3, end: 4, text: 'not sure', conf: 0.01 },
  ] }))
  assert.equal(result.error, null)
  assert.equal(result.lines.length, 2)
  assert.deepEqual(result.unsure, [1])
})

test('an SRT file has no lines to check and an empty file reports an error', () => {
  assert.deepEqual(readLyricFile(SRT).unsure, [])
  assert.match(readLyricFile('nothing here').error, /No timed lyrics/)
  assert.match(readLyricFile('{broken').error, /could not be read/)
})

test('moving all lyrics shifts every line and never goes below zero', () => {
  const lines = parseSrtLines(SRT)
  assert.deepEqual(shiftAllLines(lines, 0.1).map((line) => line.start), [6.5, 10, 20.1])
  assert.equal(shiftAllLines(lines, -30)[0].start, 0)
})

test('fixing one line keeps its length and stays between its neighbours', () => {
  const lines = parseSrtLines(SRT)
  const moved = setLineStart(lines, 1, 11)
  assert.equal(moved[1].start, 11)
  assert.equal(moved[1].end, 13.3)
  assert.equal(setLineStart(lines, 1, 1)[1].start, 6.5)
  assert.equal(setLineStart(lines, 1, 99)[1].start, 19.9)
  assert.equal(lines[1].start, 9.9)
})

test('fixing a line trims the previous line instead of overlapping it', () => {
  const lines = [{ start: 1, end: 5, text: 'a' }, { start: 6, end: 8, text: 'b' }]
  const moved = setLineStart(lines, 1, 3)
  assert.equal(moved[0].end, 3)
  assert.equal(moved[1].start, 3)
})

test('editing words ignores an empty edit', () => {
  const lines = parseSrtLines(SRT)
  assert.equal(setLineText(lines, 0, '  New   words ')[0].text, 'New words')
  assert.equal(setLineText(lines, 0, '   '), lines)
})

test('lines sung three times are chorus, and the strip splits chorus from verse', () => {
  const lines = [
    { start: 0, end: 2, text: 'Hook line' }, { start: 2.5, end: 4, text: 'Hook line!' },
    { start: 5, end: 7, text: 'A verse' }, { start: 20, end: 22, text: 'hook line' },
  ]
  assert.deepEqual(findChorusLines(lines), [true, true, false, true])
  const sections = buildSongSections(lines)
  assert.deepEqual(sections.map((section) => [section.kind, section.start, section.end]), [
    ['chorus', 0, 4], ['verse', 5, 7], ['chorus', 20, 22],
  ])
})

test('the current line is the last one that has started', () => {
  const lines = parseSrtLines(SRT)
  assert.equal(findLineAt(lines, 0), -1)
  assert.equal(findLineAt(lines, 10), 1)
  assert.equal(findLineAt(lines, 500), 2)
  assert.equal(formatClock(149.8), '2:29')
})

import {
  describeSongParts, findPartOfLine, formatClockTenths, guessSongParts, joinPartWithAbove,
  normalizeSongParts, parseClockInput, setPartKind, startPartAtLine,
} from './songLyricMap.mjs'

const SONG = [
  { start: 0, end: 2, text: 'Hook line' }, { start: 2.5, end: 4, text: 'Hook line' },
  { start: 5, end: 7, text: 'First verse' }, { start: 7.5, end: 9, text: 'More verse' },
  { start: 20, end: 22, text: 'Hook line' }, { start: 30, end: 33, text: 'Second verse' },
]

test('the first guess at parts follows repeated lines and gaps', () => {
  assert.deepEqual(guessSongParts(SONG), [
    { kind: 'chorus', firstLine: 0 }, { kind: 'verse', firstLine: 2 },
    { kind: 'chorus', firstLine: 4 }, { kind: 'verse', firstLine: 5 },
  ])
})

test('saved parts that do not fit the lyrics are thrown away', () => {
  assert.equal(normalizeSongParts([{ kind: 'verse', firstLine: 2 }], 6), null)
  assert.equal(normalizeSongParts('nope', 6), null)
  assert.deepEqual(normalizeSongParts([{ kind: 'odd', firstLine: 0 }, { kind: 'chorus', firstLine: 9 }, { kind: 'bridge', firstLine: 3 }, { kind: 'outro', firstLine: 3 }], 6),
    [{ kind: 'verse', firstLine: 0 }, { kind: 'bridge', firstLine: 3 }])
})

test('a part can be renamed, started on a line, and joined with the one above', () => {
  const parts = guessSongParts(SONG)
  assert.equal(setPartKind(parts, 1, 'bridge')[1].kind, 'bridge')
  assert.equal(setPartKind(parts, 1, 'nonsense'), parts)
  const split = startPartAtLine(parts, 3)
  assert.deepEqual(split.map((part) => part.firstLine), [0, 2, 3, 4, 5])
  assert.equal(split[2].kind, 'verse')
  assert.equal(startPartAtLine(parts, 2), parts)
  assert.equal(startPartAtLine(parts, 0), parts)
  assert.deepEqual(joinPartWithAbove(split, 2).map((part) => part.firstLine), [0, 2, 4, 5])
  assert.equal(joinPartWithAbove(parts, 0), parts)
  assert.equal(findPartOfLine(parts, 3), 1)
})

test('parts are described with their lines, times and numbered verses', () => {
  const described = describeSongParts(SONG, guessSongParts(SONG))
  assert.deepEqual(described.map((part) => part.label), ['Chorus', 'Verse 1', 'Chorus', 'Verse 2'])
  assert.deepEqual([described[1].firstLine, described[1].lastLine, described[1].start, described[1].end], [2, 3, 5, 9])
  assert.equal(describeSongParts(SONG, [{ kind: 'verse', firstLine: 0 }])[0].label, 'Verse')
})

test('typed times are understood in the usual ways', () => {
  assert.equal(parseClockInput('2:29.4'), 149.4)
  assert.equal(parseClockInput('149,4'), 149.4)
  assert.equal(parseClockInput('0:07'), 7)
  assert.equal(parseClockInput('soon'), null)
  assert.equal(formatClockTenths(149.44), '2:29.4')
  assert.equal(formatClockTenths(7), '0:07.0')
})

import { removeLine } from './songLyricMap.mjs'

test('removing a line moves the parts and marks that follow it', () => {
  const parts = guessSongParts(SONG)
  const result = removeLine(SONG, parts, [1, 5], 1)
  assert.equal(result.lines.length, 5)
  assert.deepEqual(result.parts.map((part) => [part.kind, part.firstLine]), [['chorus', 0], ['verse', 1], ['chorus', 3], ['verse', 4]])
  assert.deepEqual(result.unsure, [4])
})

test('removing the only line of a part removes the part, and the last line can go', () => {
  const parts = guessSongParts(SONG)
  const middle = removeLine(SONG, parts, [], 4)
  assert.deepEqual(middle.parts.map((part) => [part.kind, part.firstLine]), [['chorus', 0], ['verse', 2], ['verse', 4]])
  const last = removeLine(SONG, parts, [5], 5)
  assert.deepEqual(last.parts.map((part) => part.firstLine), [0, 2, 4])
  assert.deepEqual(last.unsure, [])
  assert.equal(removeLine(SONG, parts, [], 99).lines, SONG)
})
