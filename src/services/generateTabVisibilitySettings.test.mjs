import assert from 'node:assert/strict'
import test from 'node:test'

const STORAGE_KEY = 'velorn-show-generate-tab'
let moduleVersion = 0

function freshSettings() {
  return import(`./generateTabVisibilitySettings.mjs?test=${++moduleVersion}`)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function installBrowserMocks({
  localValue = null,
  electronValue = null,
  getSettingImpl,
  setSettingImpl,
  localReadError,
  localWriteError,
} = {}) {
  const values = new Map()
  if (localValue !== null) values.set(STORAGE_KEY, localValue)
  const events = []
  const electronReads = []
  const electronWrites = []
  globalThis.localStorage = {
    getItem: (key) => {
      if (localReadError) throw localReadError
      return values.get(key) ?? null
    },
    setItem: (key, value) => {
      if (localWriteError) throw localWriteError
      values.set(key, value)
    },
  }
  globalThis.window = {
    electronAPI: {
      getSetting: async (key) => {
        electronReads.push(key)
        return getSettingImpl ? getSettingImpl(key) : electronValue
      },
      setSetting: async (key, value) => {
        electronWrites.push({ key, value })
        return setSettingImpl ? setSettingImpl(key, value) : { success: true }
      },
    },
    dispatchEvent: (event) => events.push(event),
  }
  return { values, events, electronReads, electronWrites }
}

test.afterEach(() => {
  delete globalThis.localStorage
  delete globalThis.window
})

test('shows Generate by default without writing a preference', async () => {
  const { values, electronReads, electronWrites, events } = installBrowserMocks()
  const settings = await freshSettings()
  assert.equal(settings.getShowGenerateTab(), true)
  assert.equal(await settings.hydrateShowGenerateTab(), true)
  assert.equal(values.size, 0)
  assert.deepEqual(electronReads, ['showGenerateTab'])
  assert.deepEqual(electronWrites, [])
  assert.deepEqual(events, [])
})

test('defaults to visible without a browser or storage', async () => {
  const settings = await freshSettings()
  assert.equal(settings.getShowGenerateTab(), true)
  assert.equal(await settings.hydrateShowGenerateTab(), true)
})

test('normalizes supported local values and ignores invalid values', async () => {
  const { values } = installBrowserMocks()
  const settings = await freshSettings()
  for (const value of [true, 'true', 1, '1']) {
    values.set(STORAGE_KEY, value)
    assert.equal(settings.getShowGenerateTab(), true)
  }
  for (const value of [false, 'false', 0, '0']) {
    values.set(STORAGE_KEY, value)
    assert.equal(settings.getShowGenerateTab(), false)
  }
  for (const value of [null, undefined, '', 'no', 'FALSE', {}, []]) {
    values.set(STORAGE_KEY, value)
    assert.equal(settings.getShowGenerateTab(), true)
  }
})

test('hydrates the native preference and mirrors it locally without announcing a user change', async () => {
  const { values, events, electronWrites } = installBrowserMocks({ localValue: 'true', electronValue: false })
  const settings = await freshSettings()
  assert.equal(await settings.hydrateShowGenerateTab(), false)
  assert.equal(settings.getShowGenerateTab(), false)
  assert.equal(values.get(STORAGE_KEY), 'false')
  assert.deepEqual(events, [])
  assert.deepEqual(electronWrites, [])
})

test('hydrates a native visible preference over a hidden local value', async () => {
  const { values } = installBrowserMocks({ localValue: 'false', electronValue: '1' })
  const settings = await freshSettings()
  assert.equal(await settings.hydrateShowGenerateTab(), true)
  assert.equal(values.get(STORAGE_KEY), 'true')
})

test('invalid and unavailable native preferences preserve the local value', async () => {
  for (const electronValue of [null, undefined, '', 'invalid', {}]) {
    installBrowserMocks({ localValue: 'false', electronValue })
    const settings = await freshSettings()
    assert.equal(await settings.hydrateShowGenerateTab(), false)
  }
  installBrowserMocks({ localValue: 'false', getSettingImpl: () => { throw new Error('unavailable') } })
  const settings = await freshSettings()
  assert.equal(await settings.hydrateShowGenerateTab(), false)
})

test('persists reversible choices using only the Generate keys and exact events', async () => {
  const { values, events, electronWrites } = installBrowserMocks()
  values.set('velorn-show-discover-tab', 'false')
  const settings = await freshSettings()
  assert.equal(await settings.setShowGenerateTab(false), false)
  assert.equal(settings.getShowGenerateTab(), false)
  assert.equal(values.get(STORAGE_KEY), 'false')
  assert.equal(await settings.setShowGenerateTab(true), true)
  assert.equal(settings.getShowGenerateTab(), true)
  assert.equal(values.get(STORAGE_KEY), 'true')
  assert.equal(values.get('velorn-show-discover-tab'), 'false')
  assert.deepEqual(electronWrites, [
    { key: 'showGenerateTab', value: false },
    { key: 'showGenerateTab', value: true },
  ])
  assert.deepEqual(events.map(({ type, detail }) => ({ type, detail })), [
    { type: settings.GENERATE_TAB_VISIBILITY_CHANGED_EVENT, detail: { show: false } },
    { type: settings.GENERATE_TAB_VISIBILITY_CHANGED_EVENT, detail: { show: true } },
  ])
  assert.equal(settings.GENERATE_TAB_VISIBILITY_CHANGED_EVENT, 'velorn-generate-tab-visibility-changed')
})

test('a fresh renderer reads the persisted local choice without Electron', async () => {
  installBrowserMocks()
  delete window.electronAPI
  const firstRenderer = await freshSettings()
  await firstRenderer.setShowGenerateTab(false)
  const nextRenderer = await freshSettings()
  assert.equal(nextRenderer.getShowGenerateTab(), false)
  assert.equal(await nextRenderer.hydrateShowGenerateTab(), false)
})

test('reads subsequent local storage changes after successful persistence', async () => {
  const { values } = installBrowserMocks()
  const settings = await freshSettings()
  await settings.setShowGenerateTab(false)
  values.set(STORAGE_KEY, 'true')
  assert.equal(settings.getShowGenerateTab(), true)
  values.set(STORAGE_KEY, 'false')
  assert.equal(settings.getShowGenerateTab(), false)
  values.delete(STORAGE_KEY)
  assert.equal(settings.getShowGenerateTab(), true)
})

test('a fresh renderer recovers the native choice after local storage is cleared', async () => {
  let nativeValue = null
  const { values } = installBrowserMocks({
    getSettingImpl: () => nativeValue,
    setSettingImpl: (_key, value) => { nativeValue = value; return { success: true } },
  })
  const firstRenderer = await freshSettings()
  await firstRenderer.setShowGenerateTab(false)
  values.clear()
  const nextRenderer = await freshSettings()
  assert.equal(await nextRenderer.hydrateShowGenerateTab(), false)
  assert.equal(values.get(STORAGE_KEY), 'false')
})

test('native write errors and failure receipts retain the local and current-session choice', async () => {
  for (const setSettingImpl of [
    () => { throw new Error('unavailable') },
    () => ({ success: false, error: 'read only' }),
  ]) {
    const { values, events } = installBrowserMocks({ electronValue: true, setSettingImpl })
    const settings = await freshSettings()
    assert.equal(await settings.setShowGenerateTab(false), false)
    assert.equal(await settings.hydrateShowGenerateTab(), false)
    assert.equal(values.get(STORAGE_KEY), 'false')
    assert.deepEqual(events[0].detail, { show: false })
  }
})

test('an unreadable or unwritable local store retains a native hydrated value in memory', async () => {
  for (const localValue of [null, 'true']) {
    installBrowserMocks({ localValue, electronValue: false, localWriteError: new Error('quota') })
    const settings = await freshSettings()
    assert.equal(await settings.hydrateShowGenerateTab(), false)
    assert.equal(settings.getShowGenerateTab(), false)
  }
  installBrowserMocks({
    electronValue: false,
    localReadError: new Error('denied'),
    localWriteError: new Error('denied'),
  })
  const settings = await freshSettings()
  assert.equal(await settings.hydrateShowGenerateTab(), false)
  assert.equal(settings.getShowGenerateTab(), false)
})

test('storage failures preserve reversible choices for the current session', async () => {
  const { values, events } = installBrowserMocks({
    localValue: 'true',
    localWriteError: new Error('quota'),
    setSettingImpl: () => { throw new Error('unavailable') },
  })
  const settings = await freshSettings()
  await settings.setShowGenerateTab(false)
  assert.equal(values.get(STORAGE_KEY), 'true')
  assert.equal(settings.getShowGenerateTab(), false)
  assert.equal(await settings.hydrateShowGenerateTab(), false)
  await settings.setShowGenerateTab(true)
  assert.equal(settings.getShowGenerateTab(), true)
  assert.equal(events.length, 2)
})

test('missing storage and a throwing storage accessor remain usable for the session', async () => {
  for (const throwOnAccess of [false, true]) {
    delete globalThis.localStorage
    if (throwOnAccess) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => { throw new Error('denied') },
      })
    }
    const settings = await freshSettings()
    assert.equal(settings.getShowGenerateTab(), true)
    assert.equal(await settings.setShowGenerateTab(false), false)
    assert.equal(settings.getShowGenerateTab(), false)
    assert.equal(await settings.hydrateShowGenerateTab(), false)
  }
})

test('a late native hydration cannot overwrite a newer choice', async () => {
  const read = deferred()
  const { values } = installBrowserMocks({ localValue: 'true', getSettingImpl: () => read.promise })
  const settings = await freshSettings()
  const hydration = settings.hydrateShowGenerateTab()
  await settings.setShowGenerateTab(false)
  read.resolve(true)
  assert.equal(await hydration, false)
  assert.equal(settings.getShowGenerateTab(), false)
  assert.equal(values.get(STORAGE_KEY), 'false')
})

test('a late rejected hydration preserves the newer choice even with storage unavailable', async () => {
  const read = deferred()
  installBrowserMocks({
    localValue: 'true',
    getSettingImpl: () => read.promise,
    localWriteError: new Error('denied'),
  })
  const settings = await freshSettings()
  const hydration = settings.hydrateShowGenerateTab()
  await settings.setShowGenerateTab(false)
  read.reject(new Error('unavailable'))
  assert.equal(await hydration, false)
  assert.equal(settings.getShowGenerateTab(), false)
})

test('updates and announces immediately while native saving is pending, without rehydrating stale native data', async () => {
  const write = deferred()
  const { events, electronReads } = installBrowserMocks({ electronValue: true, setSettingImpl: () => write.promise })
  const settings = await freshSettings()
  const saving = settings.setShowGenerateTab(false)
  assert.equal(settings.getShowGenerateTab(), false)
  assert.deepEqual(events[0].detail, { show: false })
  assert.equal(await settings.hydrateShowGenerateTab(), false)
  assert.deepEqual(electronReads, [])
  write.resolve({ success: true })
  assert.equal(await saving, false)
})
