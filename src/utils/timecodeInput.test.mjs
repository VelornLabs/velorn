import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTimecodeInput } from './timecodeInput.mjs'

const at = (text, current = 0, fps = 24) => parseTimecodeInput(text, fps, current)

test('full and partial timecodes fill from the right', () => {
  assert.equal(at('00:00:02:12'), 2.5)
  assert.equal(at('01:00:00:00'), 3600)
  assert.equal(at('3:00'), 3)
  assert.equal(at('1:02:00'), 62)
  assert.equal(at('12'), 0.5)
})

test('digits without separators pair up from the right', () => {
  assert.equal(at('212'), 2.5)
  assert.equal(at('010000'), 60)
  assert.equal(at('1000000'), 3600)
})

test('keypad separators work and overflowing fields carry', () => {
  assert.equal(at('2.12'), 2.5)
  assert.equal(at('0;0;2;12'), 2.5)
  assert.equal(at('0:48'), 2, '48 frames at 24 fps is two seconds')
})

test('a sign moves from the current time', () => {
  assert.equal(at('+12', 10), 10.5)
  assert.equal(at('-12', 10), 9.5)
  assert.equal(at('+1:00', 10), 11)
  assert.equal(at('-20:00', 10), 0, 'never before the start')
})

test('fractional frame rates use their timecode rate', () => {
  assert.equal(parseTimecodeInput('1:00', 23.976, 0), 1)
  assert.equal(parseTimecodeInput('30', 30, 0), 1)
})

test('anything that is not a time is rejected', () => {
  for (const text of ['', '  ', 'abc', '1:2:3:4:5', '+', '1x2', '--3']) assert.equal(at(text), null, text)
})
