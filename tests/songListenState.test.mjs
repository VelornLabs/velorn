import test from 'node:test'
import assert from 'node:assert/strict'
import { LISTEN_IDLE, createSongListenState, firstListenFor } from '../src/services/songListenState.mjs'

test('the listening state outlives the screen that started it', () => {
  const state = createSongListenState()
  state.write('song-1', { status: 'listening', step: 'voice', percent: 0, error: '' })
  state.write('song-1', (current) => ({ ...current, step: 'words', percent: 40 }))
  // A rebuilt screen reads the same thing.
  assert.deepEqual(state.read('song-1'), { status: 'listening', step: 'words', percent: 40, error: '' })
})

test('another song reads as idle', () => {
  const state = createSongListenState()
  state.write('song-1', { status: 'listening', step: 'voice', percent: 10, error: '' })
  assert.equal(state.read('song-2'), LISTEN_IDLE)
  assert.equal(state.read(''), LISTEN_IDLE)
})

test('a late answer about an earlier song does not wipe out the current one', () => {
  const state = createSongListenState()
  state.write('song-1', { status: 'listening', step: 'voice', percent: 0, error: '' })
  state.write('song-2', { status: 'listening', step: 'voice', percent: 5, error: '' })
  state.write('song-1', LISTEN_IDLE)
  assert.equal(state.read('song-2').status, 'listening')
})

test('listeners hear about changes and can stop', () => {
  const state = createSongListenState()
  let calls = 0
  const stop = state.subscribe(() => { calls += 1 })
  state.write('song-1', { ...LISTEN_IDLE, status: 'listening' })
  stop()
  state.write('song-1', LISTEN_IDLE)
  assert.equal(calls, 1)
})

test('each song is listened to once without being asked', () => {
  assert.equal(firstListenFor('only-once'), true)
  assert.equal(firstListenFor('only-once'), false)
  assert.equal(firstListenFor(''), false)
})
