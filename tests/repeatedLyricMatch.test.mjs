import test from 'node:test'
import assert from 'node:assert/strict'
import { findTimedLyricLineByText } from '../src/config/musicVideoShotConfig.js'

// A song that sings one line twice, as most songs do.
const lines = [
  { text: 'Oh, my love,', startSec: 1.2 },
  { text: "we've had a share of tears.", startSec: 6.9 },
  { text: 'Oh, my friends,', startSec: 14.5 },
  { text: "we've had our hopes and fears.", startSec: 20.3 },
  { text: 'Oh, my friends', startSec: 27.5 },
  { text: "It's been a long, hard year", startSec: 33.8 },
]

test('a repeated line is matched to the repeat nearest the script time', () => {
  assert.equal(findTimedLyricLineByText('Oh, my friends', lines, { nearSeconds: 18 }).startSec, 14.5)
  assert.equal(findTimedLyricLineByText('Oh, my friends', lines, { nearSeconds: 27 }).startSec, 27.5)
  // Punctuation and capitals do not stop two lines counting as the same line.
  assert.equal(findTimedLyricLineByText('oh my friends,', lines, { nearSeconds: 30 }).startSec, 27.5)
})

test('without a script time it behaves as before: the first match', () => {
  assert.equal(findTimedLyricLineByText('Oh, my friends', lines).startSec, 14.5)
  assert.equal(findTimedLyricLineByText('Oh, my friends', lines, { nearSeconds: null }).startSec, 14.5)
})

test('a line sung once is found wherever the script time points', () => {
  assert.equal(findTimedLyricLineByText("It's been a long, hard year", lines, { nearSeconds: 2 }).startSec, 33.8)
  assert.equal(findTimedLyricLineByText('a line that is not in the song at all', lines, { nearSeconds: 10 }), null)
  assert.equal(findTimedLyricLineByText('Oh, my friends', [], { nearSeconds: 10 }), null)
})
