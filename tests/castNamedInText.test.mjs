// Director: people a shot's words name get their picture sent, even when the script's Artist line leaves them out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findCastNamedInText } from '../src/config/musicVideoShotConfig.js'

const cast = [
  { id: 'a', slug: 'runa', label: 'Runa' },
  { id: 'b', slug: 'szwagier', label: 'szwagier' },
  { id: 'c', slug: 'rose', label: 'Rose' },
  { id: 'd', slug: 'big-jake', label: 'Big Jake' },
  { id: 'e', slug: 'zoë', label: 'Zoë' },
]
const ids = (text) => findCastNamedInText(text, cast).map((entry) => entry.id)

test('cast members named in the words are found, in the order they are named', () => {
  assert.deepEqual(ids("In the timber house, Runa's brother-in-law demonstrates a guarded stance while Runa watches."), ['a'])
  assert.deepEqual(ids('Big Jake steadies the boat while Runa steps in. Szwagier waits on the shore.'), ['d', 'a', 'b'])
  assert.deepEqual(ids('BIG  JAKE and Zoë by the fire'), ['d', 'e'])
})

test('an ordinary word that happens to be a name is not a person', () => {
  assert.deepEqual(ids('a rose on the table, and the szwagier of the story'), [])
  assert.deepEqual(ids('Runaway horses; Roses in a vase; Zoës'), [])
  assert.deepEqual(ids(''), [])
  assert.deepEqual(findCastNamedInText('Runa', null), [])
})
