const test = require('node:test')
const assert = require('node:assert/strict')

const { clearTrackedWindowIfCurrent } = require('../electron/windowLifecycle.cjs')

test('keeps a replacement Velorn window when an older window closes late', () => {
  const oldWindow = { id: 'old-window' }
  const replacementWindow = { id: 'replacement-window' }

  assert.equal(
    clearTrackedWindowIfCurrent(replacementWindow, oldWindow),
    replacementWindow
  )
})

test('clears the tracked Velorn window when that exact window closes', () => {
  const currentWindow = { id: 'current-window' }

  assert.equal(clearTrackedWindowIfCurrent(currentWindow, currentWindow), null)
})
