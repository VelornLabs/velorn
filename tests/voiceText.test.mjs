// Text is cut into pieces the built-in voice model can speak, without losing or reordering words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitForSpeech } from '../src/services/voiceText.mjs'

const words = text => text.split(/\s+/).filter(Boolean)

test('short text stays in one piece and empty text gives none', () => {
  assert.deepEqual(splitForSpeech("Hey what's up? This is what I sound like. Pretty cool, huh?"), ["Hey what's up? This is what I sound like. Pretty cool, huh?"])
  assert.deepEqual(splitForSpeech('   '), [])
  assert.deepEqual(splitForSpeech(null), [])
  assert.deepEqual(splitForSpeech('no punctuation at all'), ['no punctuation at all'])
})

test('long text is cut between sentences, every piece within the limit, nothing lost', () => {
  const text = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1}, and it has a few words in it.`).join(' ')
  const pieces = splitForSpeech(text, 200)
  assert.ok(pieces.length > 5)
  for (const piece of pieces) { assert.ok(piece.length <= 200, piece); assert.match(piece, /\.$/) }
  assert.deepEqual(words(pieces.join(' ')), words(text))
})

test('one very long sentence is cut at a comma, or a space, never mid-word', () => {
  const commas = Array.from({ length: 40 }, (_, i) => `item ${i + 1}`).join(', ') + '.'
  const byComma = splitForSpeech(commas, 100)
  for (const piece of byComma.slice(0, -1)) assert.match(piece, /,$/)
  assert.deepEqual(words(byComma.join(' ')), words(commas))
  const plain = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
  const bySpace = splitForSpeech(plain, 60)
  for (const piece of bySpace) assert.ok(piece.length <= 60)
  assert.deepEqual(words(bySpace.join(' ')), words(plain))
  // A single unbroken run still comes out whole in total.
  assert.equal(splitForSpeech('x'.repeat(500), 100).join(''), 'x'.repeat(500))
})
