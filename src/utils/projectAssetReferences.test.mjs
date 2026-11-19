import test from 'node:test'
import assert from 'node:assert/strict'
import { collectAssetReferences, getProjectAssetReferences, getCompoundAssetDeletionGuard } from './projectAssetReferences.mjs'

const compound = (id, clips) => ({ id, type: 'compound', compound: { version: 1, document: { clips } } })
const projectState = { currentTimelineId: 'main', currentProject: { timelines: [
  { id: 'main', clips: [{ assetId: 'stale-saved-clip' }] },
  { id: 'other', clips: [compound('other-compound', [{ assetId: 'other-source' }])] },
] } }
const parentClips = [{ id: 'outside', assetId: 'outside-source' }, compound('open-compound', [{ assetId: 'old-child' }]), compound('sibling', [{ assetId: 'sibling-source' }])]

test('collects embedded media, deep effect masks and plural references without a depth cutoff', () => {
  const child = { assetId: 'video', effects: [{ settings: { mask: { metadata: { sourceAssetId: 'mask' } } } }], referenceAssetIds: ['reference'] }
  const data = compound('compound', [child])
  data.circular = data
  assert.deepEqual([...collectAssetReferences(data)].sort(), ['mask', 'reference', 'video'])
})

test('uses live root clips and includes compounds on other project timelines', () => {
  assert.deepEqual([...getProjectAssetReferences(projectState, { clips: parentClips })].sort(), ['old-child', 'other-source', 'outside-source', 'sibling-source'])
})

test('open contents keeps parent/sibling references and uses the current editable child', () => {
  const state = { clips: [{ assetId: 'new-child', effects: [{ maskAssetId: 'child-mask' }] }], compoundEditContext: { compoundClipId: 'open-compound', parentDocument: { clips: parentClips } } }
  assert.deepEqual([...getProjectAssetReferences(projectState, state)].sort(), ['child-mask', 'new-child', 'other-source', 'outside-source', 'sibling-source'])
  assert.deepEqual([...getProjectAssetReferences(projectState, state, { compoundOnly: true })].sort(), ['child-mask', 'new-child', 'other-source', 'sibling-source'])
})

test('deletion guard protects descendant sources/masks without changing normal clip deletion policy', () => {
  const state = { clips: [{ assetId: 'ordinary' }, compound('compound', [{ assetId: 'video', effects: [{ settings: { maskAssetId: 'mask' } }] }])] }
  assert.equal(getCompoundAssetDeletionGuard(['ordinary'], {}, state).ok, true)
  assert.deepEqual(getCompoundAssetDeletionGuard(['video', 'mask', 'video', 'unused'], {}, state).assetIds, ['video', 'mask'])
  assert.equal(getCompoundAssetDeletionGuard(['other-source'], projectState, state).ok, false)
})

test('storyboard song, references and every take protect Trash but not project-only removal', () => {
  const project = { currentProject: { storyboard: { version: 1, songAssetId: 'song', shots: [
    { referenceAssetIds: ['reference'], takes: [{ assetId: 'chosen' }, { assetId: 'alternate' }] },
  ] }, timelines: [] } }
  assert.deepEqual([...getProjectAssetReferences(project, {})].sort(), ['alternate', 'chosen', 'reference', 'song'])
  assert.deepEqual([...getProjectAssetReferences(project, {}, { compoundOnly: true })], [])
  assert.equal(getCompoundAssetDeletionGuard(['chosen'], project, {}).ok, true)
  project.currentProject.storyboard.version = 99
  assert.equal(getProjectAssetReferences(project, {}).has('song'), true, 'Future boards retain conservative file protection')
})
