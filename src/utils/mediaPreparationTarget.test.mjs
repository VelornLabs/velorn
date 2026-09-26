import assert from 'node:assert/strict'
import test from 'node:test'
import { createMediaPreparationTarget } from './mediaPreparationTarget.mjs'

function fixture() {
  let project = { currentProjectHandle: '/project' }
  let assets = [{ id: 'video', type: 'video', path: 'assets/one.mp4', url: 'file:///one.mp4' }]
  const subscribers = new Set()
  return {
    options: { projectDir: '/project', assetId: 'video', kind: 'playback',
      projectStore: { getState: () => project, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) } },
      assetsStore: { getState: () => ({ assets }) } },
    switchProject(value) { project = { currentProjectHandle: value }; subscribers.forEach(fn => fn(project)) },
    updateAsset(update) { assets = [{ ...assets[0], ...update }] },
    removeAsset() { assets = [] },
    get listeners() { return subscribers.size },
  }
}

test('cache result accepts status/metadata updates but not source replacement', () => {
  const f = fixture(), target = createMediaPreparationTarget(f.options)
  assert.equal(target.isCurrent(), true)
  f.updateAsset({ playbackCacheStatus: 'encoding', name: 'renamed' })
  assert.equal(target.isCurrent(), true)
  f.updateAsset({ path: 'assets/relinked.mp4' })
  assert.equal(target.isCurrent(), false)
  target.release()
  assert.equal(f.listeners, 0)
})

test('switching away and back cannot let an old queued job update a reopened project', () => {
  const f = fixture(), target = createMediaPreparationTarget(f.options)
  f.switchProject('/other')
  f.switchProject('/project')
  assert.equal(target.isCurrent(), false)
  target.release()
})

test('deleted assets and released jobs cannot receive cache results', () => {
  const f = fixture(), target = createMediaPreparationTarget(f.options)
  f.removeAsset()
  assert.equal(target.isCurrent(), false)
  target.release()
  assert.equal(target.isCurrent(), false)
})

test('new job supersedes old job without older cleanup invalidating it; tiers remain independent', () => {
  const f = fixture(), old = createMediaPreparationTarget(f.options)
  const current = createMediaPreparationTarget(f.options)
  const proxy = createMediaPreparationTarget({ ...f.options, kind: 'proxy' })
  assert.equal(old.isCurrent(), false)
  assert.equal(current.isCurrent(), true)
  assert.equal(proxy.isCurrent(), true)
  old.release()
  assert.equal(current.isCurrent(), true)
  current.release(); proxy.release()
  assert.equal(f.listeners, 0)
})

test('wrong initial project and missing asset never become eligible', () => {
  const f = fixture()
  f.switchProject('/other')
  const target = createMediaPreparationTarget(f.options)
  f.switchProject('/project')
  assert.equal(target.isCurrent(), false)
  target.release()
  f.removeAsset()
  const missing = createMediaPreparationTarget(f.options)
  assert.equal(missing.isCurrent(), false)
  missing.release()
})

test('no-op proxy preflight cannot supersede an active forced rebuild', () => {
  const f = fixture()
  const rebuilding = createMediaPreparationTarget({ ...f.options, kind: 'proxy' })
  const noOp = createMediaPreparationTarget({ ...f.options, kind: 'proxy', deferClaim: true })
  assert.equal(rebuilding.isCurrent(), true)
  noOp.release()
  assert.equal(rebuilding.isCurrent(), true)
  const replacement = createMediaPreparationTarget({ ...f.options, kind: 'proxy', deferClaim: true })
  assert.equal(rebuilding.isCurrent(), true)
  replacement.claim()
  assert.equal(rebuilding.isCurrent(), false)
  replacement.release(); rebuilding.release()
})
