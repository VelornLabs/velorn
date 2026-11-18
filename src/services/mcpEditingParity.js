import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { captureMcpContext, assertMcpContext } from './mcpContext'
import { EFFECT_TYPES, getEffectTypeDefinition } from '../utils/effects'
import { getMultiClipSelection } from '../utils/multiClipInspector'
import { getMultiClipEffectGroups } from '../utils/multiClipEffects'
import { resolveMcpEditingTargets } from '../utils/mcpEditingPlan'
import { isCompoundLocked, isCompoundCacheBusy, validateCompoundDocument } from '../utils/compoundDocument.mjs'

const previews = new Map()
const TTL = 10 * 60 * 1000
const clean = value => JSON.parse(JSON.stringify(value))
const stripControls = ({ previewOnly, previewToken, expectedContext, ...request }) => request
const requireOk = result => { if (!result?.ok) throw new Error(result?.reason || result?.error || 'This edit cannot be applied safely.'); return result }
const singleClipId = payload => {
  if (payload.clipId) return payload.clipId
  const selected = useTimelineStore.getState().selectedClipIds || []
  if (selected.length !== 1) throw new Error('Provide clipId or select exactly one clip.')
  return selected[0]
}
const requireProject = () => {
  if (!useProjectStore.getState().currentProject) throw new Error('Open a project before editing its timeline.')
}

function assetFor(payload) {
  const assets = useAssetsStore.getState().assets || []
  const id = payload.assetId || payload.replacementAssetId, name = payload.assetName || payload.replacementAssetName
  let candidates = id ? assets.filter(asset => asset.id === id) : name ? assets.filter(asset => asset.name === name) : []
  if (!id && !name && (payload.latestGenerated || payload.latestReplacement || payload.latest)) {
    candidates = assets.filter(asset => ['video', 'image', 'audio'].includes(asset.type)
      && (!payload.type || asset.type === payload.type)
      && (!payload.workflowId || [asset.workflowId, asset.settings?.workflowId, asset.metadata?.workflowId].includes(payload.workflowId))
      && !['queued', 'running', 'generating', 'failed', 'error'].includes(asset.generationStatus || asset.status))
      .sort((a, b) => new Date(b.createdAt || b.created || 0) - new Date(a.createdAt || a.created || 0)).slice(0, 1)
  }
  if (candidates.length !== 1) throw new Error('Choose one unambiguous existing project asset by assetId or assetName.')
  return candidates[0]
}

function prepare(tool, payload) {
  const state = useTimelineStore.getState(), request = stripControls(payload)
  if (['set_clip_style', 'set_clip_color', 'edit_clip_effects'].includes(tool)) {
    const clips = resolveMcpEditingTargets(state, request)
    return { ...request, clipIds: clips.map(clip => clip.id), kind: tool === 'edit_clip_effects' ? 'effects' : 'style' }
  }
  if (tool === 'paste_clip_attributes') return { ...request, kind: 'paste' }
  if (tool === 'trim_clips') return { ...request, kind: 'trim' }
  if (tool === 'edit_trim') return { ...request, kind: 'edit_trim', ...(request.mode === 'roll' ? {} : { clipId: singleClipId(request) }) }
  if (tool.endsWith('transition') || tool === 'remove_transitions') return { ...request, kind: 'transition', operation: tool === 'add_transition' ? 'add' : tool === 'update_transition' ? 'update' : 'remove' }
  if (tool === 'edit_source') {
    const asset = assetFor(request)
    return { mode: request.mode, asset: request.includeAudio === false || request.includeEmbeddedAudio === false ? { ...asset, audioEnabled: false } : asset,
      inPoint: request.sourceInSeconds ?? request.inPoint, outPoint: request.sourceOutSeconds ?? request.outPoint,
      sourceDuration: asset.duration ?? asset.settings?.duration, trackId: request.trackId, audioTrackId: request.audioTrackId,
      startSeconds: request.mode === 'append' ? undefined : request.startSeconds ?? state.playheadPosition }
  }
  if (tool === 'replace_clip_with_asset') {
    const clipId = singleClipId(request), clip = state.clips.find(clip => clip.id === clipId)
    if (!clip) throw new Error('The replacement clip no longer exists.')
    if (request.preserveDuration === false || request.fitToAssetDuration || request.useAssetDuration || request.durationSeconds !== undefined) throw new Error('Smart Replace preserves timeline duration. Trim explicitly before replacing instead of fitting the replacement implicitly.')
    return { clipId, asset: assetFor(request), sourceInSeconds: request.sourceInSeconds ?? (request.preserveTrim === true || request.resetTrim === false ? clip.trimStart || 0 : 0) }
  }
  if (tool === 'create_compound') {
    const settings = useProjectStore.getState().getCurrentTimelineSettings()
    return { clipIds: request.clipIds || state.selectedClipIds, name: request.name || 'Compound', width: settings.width, height: settings.height }
  }
  if (tool === 'uncompound') return { clipId: singleClipId(request) }
  throw new Error(`Unsupported editing tool ${tool}.`)
}

const nativeMethods = {
  edit_source: ['previewSourceEdit', 'applySourceEdit'],
  replace_clip_with_asset: ['previewSmartReplace', 'applySmartReplace'],
  create_compound: ['previewCreateCompound', 'applyCreateCompound'],
  uncompound: ['previewUncompound', 'applyUncompound'],
}

function execute(tool, payload = {}) {
  requireProject()
  assertMcpContext(payload.expectedContext, tool)
  const state = useTimelineStore.getState(), previewOnly = payload.previewOnly !== false
  const methods = nativeMethods[tool] || ['previewMcpEditing', 'applyMcpEditing']
  let record
  if (payload.previewToken) {
    record = previews.get(payload.previewToken)
    if (!record || record.tool !== tool || record.expires < Date.now()) throw new Error('This edit preview expired. Preview again.')
    assertMcpContext(record.context, tool)
    // Tokens authorize only their exact reviewed operands, never a caller patch.
    const incoming = stripControls(payload)
    if (Object.keys(incoming).length && JSON.stringify(incoming) !== JSON.stringify(record.input)) throw new Error('Edit arguments changed after preview. Preview again.')
  } else {
    const request = prepare(tool, payload)
    const preview = requireOk(state[methods[0]](request))
    record = { tool, request, input: stripControls(payload), preview, context: captureMcpContext(), expires: Date.now() + TTL }
  }
  const publicPreview = clean({ ...record.preview, token: undefined })
  if (previewOnly) {
    for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key)
    while (previews.size >= 64) previews.delete(previews.keys().next().value)
    const previewToken = payload.previewToken || globalThis.crypto.randomUUID()
    previews.set(previewToken, record)
    return { success: true, action: tool, previewOnly: true, changed: false, wouldChange: record.preview.changed,
      plan: publicPreview, previewToken, context: record.context,
      suggestedApplyPayload: { ...record.input, previewOnly: false, previewToken, expectedContext: record.context } }
  }
  assertMcpContext(record.context, tool)
  const result = requireOk(useTimelineStore.getState()[methods[1]](record.request, record.preview.token))
  if (payload.previewToken) previews.delete(payload.previewToken)
  const aliases = tool === 'set_clip_style' || tool === 'set_clip_color'
    ? { clipCount: result.summary?.changedCount || 0, clips: result.summary?.after || [] }
    : tool === 'trim_clips' ? { trimmedCount: result.summary?.changedCount || 0, clips: result.summary?.after || [] }
      : tool === 'replace_clip_with_asset' ? { clip: useTimelineStore.getState().clips.find(clip => clip.id === record.request.clipId), preserveDuration: true, resetTrim: record.request.sourceInSeconds === 0 }
        : tool === 'add_transition' ? { created: result.changed, transition: result.summary?.transition }
          : tool === 'update_transition' ? { updated: result.changed, transition: result.summary?.transition }
            : tool === 'remove_transitions' ? { removedCount: result.summary?.removedTransitionIds?.length || 0, removedTransitionIds: result.summary?.removedTransitionIds } : {}
  return { success: true, action: tool, previewOnly: false, ...clean(result), ...clean(aliases), context: captureMcpContext() }
}

function compoundFor(payload = {}) {
  const state = useTimelineStore.getState(), context = state.compoundEditContext
  const id = payload.clipId || context?.compoundClipId || singleClipId(payload)
  const clips = context?.parentDocument.clips || state.clips
  const matches = clips.filter(clip => clip.id === id && clip.type === 'compound')
  if (matches.length !== 1) throw new Error('Choose one existing compound clip.')
  const clip = matches[0]
  const document = context?.compoundClipId === id ? state.getActiveDocumentData() : clip.compound?.document
  requireOk(validateCompoundDocument(document))
  return { state, clip, document, context }
}

function inspectCompound(payload = {}) {
  const { clip, document, context } = compoundFor(payload)
  return { success: true, action: 'inspect_compound', context: captureMcpContext(), clip: clean({ ...clip, compound: undefined }),
    isOpen: context?.compoundClipId === clip.id, document: clean(document),
    parentClipId: context?.compoundClipId || null }
}

function navigateCompound(tool, payload = {}) {
  requireProject()
  assertMcpContext(payload.expectedContext, tool)
  const state = useTimelineStore.getState()
  if (state.isPlaying) throw new Error('Pause playback before changing compound context.')
  let clip, changed = false
  if (tool === 'close_compound') {
    if (state.compoundEditContext) {
      if (state.clips.some(isCompoundCacheBusy)) throw new Error('Wait for child render jobs before returning to the parent.')
      requireOk(validateCompoundDocument(state.getActiveDocumentData()))
    }
  } else {
    if (state.compoundEditContext) throw new Error('Return to the parent timeline first.')
    const value = compoundFor(payload); clip = value.clip
    const track = state.tracks.find(track => track.id === clip.trackId)
    if (isCompoundLocked(clip) || isCompoundLocked(track) || isCompoundCacheBusy(clip)) throw new Error('Unlock the compound and wait for its render jobs.')
    if (tool === 'rename_compound') {
      if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 160) throw new Error('Enter a name between 1 and 160 characters.')
      changed = clip.name !== payload.name.trim()
    }
  }
  const context = captureMcpContext()
  if (payload.previewOnly !== false) return { success: true, action: tool, previewOnly: true, context,
    plan: { clipId: clip?.id || state.compoundEditContext?.compoundClipId, name: payload.name, wouldChange: changed,
      navigationOnly: tool !== 'rename_compound' },
    suggestedApplyPayload: { ...payload, ...(clip ? { clipId: clip.id } : {}), previewOnly: false, expectedContext: context } }
  const result = tool === 'open_compound' ? state.openCompound(clip.id, clip)
    : tool === 'close_compound' ? state.closeCompound() : state.renameCompound(clip.id, payload.name, clip)
  return { success: true, action: tool, previewOnly: false, ...clean(requireOk(result)), context: captureMcpContext() }
}

function inspectEffects(payload = {}) {
  const state = useTimelineStore.getState()
  const clips = resolveMcpEditingTargets(state, payload, undefined, { readOnly: true }), selection = getMultiClipSelection(state.clips, state.tracks, clips.map(clip => clip.id))
  return { success: true, context: captureMcpContext(), clips: clean(clips.map(clip => ({ clipId: clip.id, effects: clip.effects || [] }))),
    sharedGroups: clean(getMultiClipEffectGroups(selection, getEffectTypeDefinition)),
    supportedTypes: clean(EFFECT_TYPES.filter(effect => Array.isArray(effect.params))) }
}

export const MCP_EDITING_ACTIONS = Object.freeze({
  ...Object.fromEntries(['set_clip_style', 'set_clip_color', 'edit_clip_effects', 'paste_clip_attributes', 'trim_clips', 'edit_trim',
    'edit_source', 'replace_clip_with_asset', 'create_compound', 'uncompound', 'add_transition', 'update_transition', 'remove_transitions']
    .map(tool => [tool, payload => execute(tool, payload)])),
  inspect_compound: inspectCompound,
  inspect_clip_effects: inspectEffects,
  open_compound: payload => navigateCompound('open_compound', payload),
  close_compound: payload => navigateCompound('close_compound', payload),
  rename_compound: payload => navigateCompound('rename_compound', payload),
})
