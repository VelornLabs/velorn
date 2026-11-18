import test from 'node:test'
import assert from 'node:assert/strict'
import { readAccessSetup, accessSetupPreferences, activeAccessMode } from './connectedAgentAccess.mjs'

test('setup hints are strict, provider-scoped and never carry credentials or authority', () => {
  for (const value of [null, undefined, {}, { accessSetups: 'full' }]) {
    assert.deepEqual(readAccessSetup(value, 'codex'), { mode: 'chat', shareImagesAndView: false })
  }
  const settings = { accessSetups: { codex: { mode: 'full', shareImagesAndView: 'true', token: 'SECRET', autoApproveEdits: true },
    lmstudio: { mode: 'full', shareImagesAndView: true }, foreign: { mode: 'full' } } }
  assert.deepEqual(readAccessSetup(settings, 'codex'), { mode: 'full', shareImagesAndView: false })
  assert.deepEqual(readAccessSetup(settings, 'lmstudio'), { mode: 'full', shareImagesAndView: true })
  const next = accessSetupPreferences(settings, 'codex', { mode: 'full', shareImagesAndView: true, token: 'SECRET' })
  assert.deepEqual(next, { codex: { mode: 'full', shareImagesAndView: true }, lmstudio: { mode: 'full', shareImagesAndView: true },
    luna: { mode: 'chat', shareImagesAndView: false } })
  assert.equal(JSON.stringify(next).includes('SECRET'), false)
  assert.equal(settings.accessSetups.codex.shareImagesAndView, 'true')
})

test('funded Luna uses the same setup modes without storing live permission grants', () => {
  for (const mode of ['unknown', null]) {
    assert.deepEqual(readAccessSetup({ accessSetups: { luna: { mode, shareImagesAndView: true } } }, 'luna'),
      { mode: 'chat', shareImagesAndView: true })
  }
  assert.deepEqual(readAccessSetup({ accessSetups: { luna: { mode: 'full', shareImagesAndView: true } } }, 'luna'), { mode: 'full', shareImagesAndView: true })
  const settings = { accessSetups: { codex: { mode: 'full', shareImagesAndView: true }, lmstudio: { mode: 'work', shareImagesAndView: true } } }
  const next = accessSetupPreferences(settings, 'luna', { mode: 'work', shareImagesAndView: true, autoApproveEdits: true, token: 'SECRET' })
  assert.deepEqual(next, { ...settings.accessSetups, luna: { mode: 'work', shareImagesAndView: true } })
  assert.deepEqual(settings.accessSetups, { codex: { mode: 'full', shareImagesAndView: true }, lmstudio: { mode: 'work', shareImagesAndView: true } })
  assert.equal(JSON.stringify(next).includes('SECRET'), false)
  assert.equal(Object.hasOwn(next.luna, 'autoApproveEdits'), false)
})

test('active mode depends only on live flags, never a remembered full-access setup', () => {
  assert.equal(activeAccessMode({ preferredSetup: { mode: 'full' } }), 'chat')
  assert.equal(activeAccessMode({ toolsEnabled: true }), 'custom')
  assert.equal(activeAccessMode({ toolsEnabled: true, researchEnabled: true }), 'work')
  assert.equal(activeAccessMode({ toolsEnabled: true, researchEnabled: true, fullAccessEnabled: true }), 'full')
})
