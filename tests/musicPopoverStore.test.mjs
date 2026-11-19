import assert from 'node:assert/strict'
import test from 'node:test'

let instance = 0

async function createFixture(t, savedState) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const entries = new Map()
  if (savedState !== undefined) {
    entries.set('velorn-music-popover', JSON.stringify({ state: savedState, version: 0 }))
  }
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  const store = (await import(`../src/stores/musicPopoverStore.js?fixture=${++instance}`)).default
  return { store, readSaved: () => JSON.parse(entries.get('velorn-music-popover')).state }
}

test('new music forms default to YuE2 Automatic without losing the custom / ACE-Step duration', async t => {
  const { store } = await createFixture(t)
  assert.equal(store.getState().backend, 'yue2')
  assert.equal(store.getState().yue2LengthMode, 'automatic')
  assert.equal(store.getState().yue2CustomDurationSeconds, 30)
  assert.equal(store.getState().durationSeconds, 30)
})

test('legacy saved seconds do not select Custom maximum implicitly', async t => {
  const { store, readSaved } = await createFixture(t, {
    backend: 'yue2', durationSeconds: 42, tags: 'saved style', lyrics: '[verse]\nSaved song',
    sessionPromptIds: ['legacy-prompt'],
  })
  assert.equal(store.getState().yue2LengthMode, 'automatic')
  assert.equal(store.getState().yue2CustomDurationSeconds, 42)
  assert.equal(store.getState().durationSeconds, 42)
  assert.equal(store.getState().tags, 'saved style')
  assert.equal(store.getState().lyrics, '[verse]\nSaved song')
  assert.deepEqual(store.getState().sessionPromptIds, ['legacy-prompt'])
  store.getState().setMusicField('yue2LengthMode', 'custom')
  assert.equal(store.getState().yue2CustomDurationSeconds, 42)
  assert.equal(readSaved().yue2LengthMode, 'custom')
  assert.equal(readSaved().yue2CustomDurationSeconds, 42)
  assert.equal(readSaved().durationSeconds, 42)
})

test('explicit custom preference persists with its seconds and Automatic keeps them available', async t => {
  const { store, readSaved } = await createFixture(t, {
    backend: 'yue2', yue2LengthMode: 'custom', yue2CustomDurationSeconds: 360, durationSeconds: 27,
  })
  assert.equal(store.getState().yue2LengthMode, 'custom')
  assert.equal(store.getState().yue2CustomDurationSeconds, 360)
  assert.equal(store.getState().durationSeconds, 27)
  store.getState().setMusicField('yue2LengthMode', 'automatic')
  assert.equal(readSaved().yue2LengthMode, 'automatic')
  assert.equal(readSaved().yue2CustomDurationSeconds, 360)
  assert.equal(readSaved().durationSeconds, 27)
  await store.persist.rehydrate()
  assert.equal(store.getState().yue2LengthMode, 'automatic')
  assert.equal(store.getState().yue2CustomDurationSeconds, 360)
  assert.equal(store.getState().durationSeconds, 27)
  store.getState().setMusicField('yue2LengthMode', 'custom')
  assert.equal(store.getState().yue2CustomDurationSeconds, 360)
})

test('unknown persisted modes fall back to Automatic and preserve ACE-Step settings', async t => {
  const { store } = await createFixture(t, {
    backend: 'ace-step', yue2LengthMode: 'exact', durationSeconds: 27,
    bpm: 117, keyScale: 'D minor', timeSignature: '3',
  })
  assert.equal(store.getState().yue2LengthMode, 'automatic')
  assert.equal(store.getState().backend, 'ace-step')
  assert.equal(store.getState().durationSeconds, 27)
  assert.equal(store.getState().yue2CustomDurationSeconds, 27)
  assert.equal(store.getState().bpm, 117)
  assert.equal(store.getState().keyScale, 'D minor')
  assert.equal(store.getState().timeSignature, '3')
})

test('model switches and edits retain separate custom maximum and ACE-Step duration preferences', async t => {
  const { store, readSaved } = await createFixture(t)
  const set = store.getState().setMusicField
  set('yue2LengthMode', 'custom')
  set('yue2CustomDurationSeconds', 300)
  set('backend', 'ace-step')
  assert.equal(store.getState().durationSeconds, 30)
  set('durationSeconds', 14)
  set('backend', 'yue2')
  assert.equal(store.getState().yue2CustomDurationSeconds, 300)
  assert.equal(store.getState().durationSeconds, 14)
  assert.equal(readSaved().yue2CustomDurationSeconds, 300)
  assert.equal(readSaved().durationSeconds, 14)
})
