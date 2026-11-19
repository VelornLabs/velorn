import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { getStoryboard, getStoryboardRevision, getProductionRun, previewStoryboardEdit, applyStoryboardEdit } from './storyboard'
import { assertMcpContext, captureMcpContext } from './mcpContext'
import { collectAssetReferences } from '../utils/projectAssetReferences.mjs'
import { getProductionGuide } from '../utils/production.mjs'
import { getStoryboardPresentation } from '../utils/storyboard.mjs'
import { PRODUCTION_RUN_OPERATIONS } from '../utils/productionRun.mjs'
import { getProductionRecipe } from '../utils/productionRecipe.mjs'

function summarizeAsset(assetId, asset) {
  if (!asset) return { id: assetId, missing: true }
  const number = value => Number.isFinite(value) ? value : null
  return {
    id: assetId,
    name: String(asset.name || '').slice(0, 2000),
    type: typeof asset.type === 'string' ? asset.type.slice(0, 100) : null,
    duration: number(asset.duration ?? asset.settings?.duration),
    width: number(asset.width ?? asset.settings?.width),
    height: number(asset.height ?? asset.settings?.height),
    missing: false,
  }
}

export function getMcpStoryboard() {
  const board = getStoryboard()
  const ids = new Set(board.songAssetId ? [board.songAssetId] : [])
  for (const id of board.referenceAssetIds || []) ids.add(id)
  for (const shot of board.shots) {
    if (shot.storyboardAssetId) ids.add(shot.storyboardAssetId)
    for (const id of shot.referenceAssetIds) ids.add(id)
    for (const take of shot.takes) ids.add(take.assetId)
  }
  collectAssetReferences(board.production, ids)
  collectAssetReferences(board.productionRun, ids)
  const projectAssets = useAssetsStore.getState().assets
  const assets = new Map(projectAssets.map(asset => [asset.id, asset]))
  return { board, presentation: getStoryboardPresentation(board, projectAssets),
    revision: getStoryboardRevision(), context: captureMcpContext(),
    assets: [...ids].map(id => summarizeAsset(id, assets.get(id))) }
}

export function getMcpProductionGuide() {
  const board = getStoryboard()
  const assets = useAssetsStore.getState().assets
  return { guide: { ...getProductionGuide(board, assets), recipe: getProductionRecipe() },
    productionRun: getProductionRun(), presentation: getStoryboardPresentation(board, assets),
    revision: getStoryboardRevision(), context: captureMcpContext() }
}

export function getMcpProductionRun() {
  const board = getStoryboard()
  return { ...getProductionRun(), presentation: getStoryboardPresentation(board, useAssetsStore.getState().assets),
    revision: getStoryboardRevision(), context: captureMcpContext() }
}

export function editMcpProductionRun(payload = {}) {
  if (!PRODUCTION_RUN_OPERATIONS.includes(payload.operation)) throw new Error('Unsupported production run operation.')
  return editMcpStoryboard(payload)
}

// Snapshot publication must remain available even when a future board schema
// cannot be edited by this build. Never replace or silently normalize that data.
export function getMcpStoryboardSummary() {
  const project = useProjectStore.getState().currentProject
  if (!project) return null
  try {
    const board = getStoryboard()
    const guide = board.production ? getProductionGuide(board, useAssetsStore.getState().assets) : null
    return { available: true, persisted: project.storyboard != null, version: board.version,
      revision: getStoryboardRevision(), title: board.title, shotCount: board.shots.length,
      takeCount: board.shots.reduce((count, shot) => count + shot.takes.length, 0),
      selectedTakeCount: board.shots.filter(shot => shot.selectedTakeId != null).length,
      productionRun: board.productionRun ? { version: board.productionRun.version,
        attemptCount: board.productionRun.attempts.length, bindingCount: board.productionRun.bindings.length,
        nextAction: board.productionRun.nextAction, exportRequired: false } : null,
      production: guide ? { version: board.production.version, type: board.production.type,
        nextStage: guide.nextStage, stages: guide.stages.map(stage => ({ id: stage.id, state: stage.state })) } : null,
      statusCounts: Object.fromEntries(['planned', 'in-progress', 'review', 'approved']
        .map(status => [status, board.shots.filter(shot => shot.status === status).length])) }
  } catch (error) {
    return { available: false, persisted: project.storyboard != null,
      version: project.storyboard?.version ?? null, revision: getStoryboardRevision(),
      error: error.message }
  }
}

export function editMcpStoryboard(payload = {}) {
  assertMcpContext(payload.expectedContext, 'Storyboard edit')
  if (payload.previewOnly !== false) {
    const context = captureMcpContext()
    const result = previewStoryboardEdit(payload)
    return { ...result, context, suggestedApplyPayload: {
      ...result.suggestedApplyPayload, previewOnly: false, expectedContext: context,
    } }
  }
  if (!payload.previewToken || !payload.expectedContext) {
    throw new Error('Preview the Storyboard edit first, then apply its unchanged previewToken and expectedContext.')
  }
  const result = applyStoryboardEdit(payload)
  return { ...result, context: captureMcpContext() }
}

export const MCP_STORYBOARD_ACTIONS = { get_storyboard: getMcpStoryboard,
  get_production_guide: getMcpProductionGuide, edit_storyboard: editMcpStoryboard,
  get_production_run: getMcpProductionRun, edit_production_run: editMcpProductionRun }
