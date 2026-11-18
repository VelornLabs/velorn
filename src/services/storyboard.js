import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import { isExportBusy } from '../stores/exportActivityStore'
import { assertAssetRemovalAllowsMcp } from './assetRemovalPlan.mjs'
import { normalizeStoryboard, planStoryboardEdit } from '../utils/storyboard.mjs'
import { inspectProductionRun, PRODUCTION_RUN_OPERATIONS } from '../utils/productionRun.mjs'

// The active store owns current edits. Reading must never save, switch timelines,
// close a compound, decode media, or resurrect the stale saved active document.
export function getProductionTimelines(projectState, timelineState) {
  const project = projectState.currentProject
  const activeId = projectState.currentTimelineId || project?.currentTimelineId
  const live = timelineState.compoundEditContext?.parentDocument || timelineState
  return (project?.timelines || []).map(timeline => {
    const active = timeline.id === activeId
    const settings = {
      width: timeline.width || timeline.settings?.width || project?.settings?.width || 1920,
      height: timeline.height || timeline.settings?.height || project?.settings?.height || 1080,
      fps: (active && (live.timelineFps || live.fps)) || timeline.fps || timeline.settings?.fps || project?.settings?.fps || 24,
    }
    return { ...timeline, ...settings, settings: { ...timeline.settings, ...settings },
      ...(active ? { clips: live.clips || [], tracks: live.tracks || [], transitions: live.transitions || [] } : {}) }
  })
}

const makeId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const fail = (message, code) => { throw Object.assign(new Error(message), { code }) }

// Dependency injection is for synthetic tests; the exported app methods below
// always share the editor's real project/assets/timeline stores and history.
export function createStoryboardService({ projectStore = useProjectStore, assetsStore = useAssetsStore,
  timelineStore = useTimelineStore, exportBusy = isExportBusy, assertRemoval = assertAssetRemovalAllowsMcp,
  idFactory = makeId } = {}) {
  const previews = new Map()
  const getState = () => {
    const state = projectStore.getState()
    if (!state.currentProject) fail('Open a project before using Storyboard.', 'STORYBOARD_NO_PROJECT')
    return state
  }
  const revision = () => projectStore.getState().storyboardRevision || 0
  const getBoard = () => normalizeStoryboard(getState().currentProject.storyboard)
  const plan = (state, edit, factory = idFactory) => planStoryboardEdit(state.currentProject.storyboard,
    edit, assetsStore.getState().assets, { idFactory: factory,
      timelines: getProductionTimelines(state, timelineStore.getState()) })
  const getRun = () => {
    const state = getState(), board = getBoard(), timeline = timelineStore.getState()
    return { run: board.productionRun || null,
      inspection: inspectProductionRun(board.productionRun, { board, assets: assetsStore.getState().assets,
        timelines: getProductionTimelines(state, timeline) }),
      activeTimelineId: state.currentTimelineId || state.currentProject.currentTimelineId || null,
      compoundFocused: Boolean(timeline.compoundEditContext),
      guidance: 'Records are reported metadata, not verified job status or execution permission. Inspect the backend before retrying uncertain work. Timeline edits remain separate previewed actions; export is optional and only on request.' }
  }
  const writable = () => {
    const state = getState()
    if (state.isLoading) fail('Wait for the project to finish opening before editing Storyboard.', 'STORYBOARD_BUSY')
    if (exportBusy()) fail('Finish or cancel the export before editing Storyboard.', 'EXPORT_IN_PROGRESS')
    assertRemoval('edit_storyboard')
    if (timelineStore.getState().compoundEditContext) fail('Leave compound Open Contents before editing Storyboard.', 'STORYBOARD_COMPOUND_FOCUS')
    return state
  }
  const request = payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Storyboard edit must be an object.')
    // Transport guards are not authored board fields. The domain still rejects
    // every unknown operation field; no paths or arbitrary metadata are copied.
    const { previewOnly, previewToken, expectedContext, ...edit } = payload
    return edit
  }
  const preview = payload => {
    const state = writable(), edit = request(payload)
    const result = plan(state, edit)
    const token = makeId('storyboard-preview')
    previews.set(token, { project: state.currentProject, handle: state.currentProjectHandle,
      revision: revision(), before: canonical(state.currentProject.storyboard), payload: canonical(edit),
      runPlan: PRODUCTION_RUN_OPERATIONS.includes(edit.operation) ? canonical(result.run) : null,
      reviewFingerprint: edit.operation === 'review_production_stage'
        ? result.board.production.reviews.find(review => review.stage === edit.stage)?.fingerprint : null,
      createdId: edit.operation === 'add_shot' ? result.shotId : edit.operation === 'attach_take' ? result.takeId
        : edit.operation === 'add_cast_member' ? result.memberId : edit.operation === 'add_location' ? result.locationId : null })
    while (previews.size > 50) previews.delete(previews.keys().next().value)
    return { ...result, revision: revision(), previewOnly: true,
      suggestedApplyPayload: { ...JSON.parse(JSON.stringify(edit)), previewOnly: false, previewToken: token } }
  }
  const apply = payload => {
    const state = writable(), edit = request(payload)
    let preview
    if (payload.previewToken != null) {
      preview = previews.get(payload.previewToken)
      previews.delete(payload.previewToken) // Every presented token is one-use, even on rejection.
      if (!preview || preview.project !== state.currentProject || preview.handle !== state.currentProjectHandle
        || preview.revision !== revision() || preview.before !== canonical(state.currentProject.storyboard)
        || preview.payload !== canonical(edit)) {
        fail('Storyboard preview is stale or already used. Preview this edit again before applying it.', 'STORYBOARD_PREVIEW_STALE')
      }
    }
    // Re-plan from live stores, including asset existence and media types; do
    // not commit a cached preview after an asset was removed or changed.
    const result = plan(state, edit, preview?.createdId ? () => preview.createdId : idFactory)
    if (preview?.runPlan && canonical(result.run) !== preview.runPlan) {
      fail('Production link or inputs changed after preview. Inspect and preview again.', 'STORYBOARD_PREVIEW_STALE')
    }
    if (preview?.reviewFingerprint && result.board.production.reviews.find(review => review.stage === edit.stage)?.fingerprint !== preview.reviewFingerprint) {
      fail('Production references changed after this review preview. Preview the current stage again before applying it.', 'STORYBOARD_PREVIEW_STALE')
    }
    if (result.changed) {
      if (!state.setStoryboardWithHistory(result.board)) fail('Storyboard changed before the edit could be applied. Please try again.', 'STORYBOARD_CHANGED')
      previews.clear()
    }
    return { ...result, board: getBoard(), revision: revision(), previewOnly: false }
  }
  return { getStoryboard: getBoard, getStoryboardRevision: revision, getProductionRun: getRun,
    previewStoryboardEdit: preview, applyStoryboardEdit: apply }
}

const service = createStoryboardService()
export const getStoryboard = service.getStoryboard
export const getStoryboardRevision = service.getStoryboardRevision
export const getProductionRun = service.getProductionRun
export const previewStoryboardEdit = service.previewStoryboardEdit
export const applyStoryboardEdit = service.applyStoryboardEdit
