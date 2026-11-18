// Global renderer bridge for generation runs that were registered by Velorn's
// native broker.  GenerateWorkspace still owns its legacy queue; this module
// deliberately does not mount it, restore it, or ask ComfyUI to run anything.
//
// A run is only trustworthy when it has a native run id and ComfyUI prompt id.
// Direct shell / embedded-ComfyUI work can be shown as external only after the
// native broker has explicitly observed it.  That distinction is important:
// this surface must never imply that Velorn can safely cancel, import, or
// recreate arbitrary ComfyUI work it did not submit or adopt.

import useGenerationMonitorStore from '../stores/generationMonitorStore'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { comfyui } from './comfyui'
import { importAsset, isElectron } from './fileSystem'
import { isExportBusy } from '../stores/exportActivityStore'
import { markPromptHandledByApp } from './comfyPromptGuard'
import { openApiWorkflowInComfyUi } from './workflowSetupManager'
import { captureMcpContext } from './mcpContext'
import { generationQueueOwner } from './generationQueueStatus.mjs'

const DEFAULT_POLL_MS = 12000
// Keep the same bounded descriptor ceiling as the native run ledger.  A
// smaller renderer-only cap would make a completed multi-output run look
// fully imported after only its first batch had been seen.
const MAX_OUTPUTS_PER_RUN = 512
const MAX_HANDLED_RUNS = 500
const importTasks = new Map()
const handledRunIds = new Set()
const autoImportAttemptedRunIds = new Set()
let activeBridge = null

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi|m4v|gif)$/i
const AUDIO_EXT = /\.(mp3|wav|ogg|flac|aac|m4a|opus)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i

function runsApi(api = globalThis.window?.electronAPI) {
  const candidate = api?.generationRuns
  return candidate && typeof candidate === 'object' ? candidate : null
}

function cleanText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

function cleanOutput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const filename = cleanText(raw.filename || raw.file || raw.name, 240)
  // ComfyUI's /view endpoint takes the filename and subfolder separately.
  // A filename containing a path is therefore both ambiguous and unsafe.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') return null
  const rawSubfolder = cleanText(raw.subfolder || raw.subFolder || '', 400)
  if (rawSubfolder.startsWith('/') || rawSubfolder.startsWith('\\') || /^[A-Za-z]:/.test(rawSubfolder)
    || rawSubfolder.split(/[\\/]+/).some(part => part === '..')) return null
  const type = cleanText(raw.type || raw.outputType || 'output', 24).toLowerCase()
  if (type !== 'output') return null
  const requestedKind = cleanText(raw.mediaType || raw.kind || '', 24).toLowerCase()
  const mediaType = VIDEO_EXT.test(filename) ? 'video'
      : AUDIO_EXT.test(filename) ? 'audio'
        : IMAGE_EXT.test(filename) ? 'image'
          : ['video', 'audio', 'image'].includes(requestedKind) ? requestedKind : null
  if (!mediaType) return null
  return {
    filename,
    subfolder: rawSubfolder,
    type,
    nodeId: cleanText(raw.nodeId, 80) || null,
    mediaType,
  }
}

function outputSignature(output) {
  return `${output.mediaType}:${output.filename}|${output.subfolder || ''}|${output.type || 'output'}|${output.nodeId || ''}`
}

function currentContext() {
  try {
    return captureMcpContext()
  } catch (_) {
    return null
  }
}

function generationRunsOwner() {
  const { currentProjectHandle, currentProject } = useProjectStore.getState()
  const context = currentContext()
  return {
    ...generationQueueOwner(currentProjectHandle, currentProject),
    // Native records are a deliberately app-wide ledger. Keep the active
    // capture context alongside that scope for renderer-only diagnostics,
    // while every record still carries its own projectKey for import safety.
    scope: 'application',
    session: context?.session || null,
    activeProjectKey: context?.projectKey || null,
  }
}

function normalizedEndpoint(value) {
  const source = cleanText(value, 2000).replace(/\/+$/, '')
  if (!source) return null
  try {
    const url = new URL(source)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return url.origin.toLowerCase()
  } catch (_) {
    return null
  }
}

function endpointMatchesCurrent(run) {
  const runEndpoint = normalizedEndpoint(run?.endpoint)
  const currentEndpoint = normalizedEndpoint(comfyui.getHttpBase?.())
  return Boolean(runEndpoint && currentEndpoint && runEndpoint === currentEndpoint)
}

function assertRunEndpoint(run, initial = false) {
  if (!endpointMatchesCurrent(run)) {
    const error = new Error(initial
      ? 'The configured ComfyUI connection does not match the server that produced this run. Reconnect to that server before importing its outputs.'
      : 'The configured ComfyUI connection changed while importing. No further outputs were added.')
    error.code = 'GENERATION_RUN_ENDPOINT_CHANGED'
    throw error
  }
}

function projectMatchesRun(run, context = currentContext()) {
  const expected = cleanText(run?.projectKey, 8192)
  // A run without a captured project is intentionally not auto-importable.
  // Matching only names would risk placing media into a different project.
  return Boolean(expected && context?.projectKey && expected === context.projectKey)
}

function rememberHandledRun(run) {
  const runId = cleanText(run?.runId || run?.id, 180)
  if (runId) {
    handledRunIds.add(runId)
    if (handledRunIds.size > MAX_HANDLED_RUNS) {
      const oldest = handledRunIds.values().next().value
      if (oldest) handledRunIds.delete(oldest)
    }
  }
  // Registered runs use the same ComfyUI instance as the embedded auto-import
  // listener. Claim their prompt ids immediately so that listener cannot race
  // this project's explicit import action.
  if (['agent', 'velorn'].includes(String(run?.origin || '').toLowerCase()) || run?.adopted === true) {
    markPromptHandledByApp(run?.promptId)
  }
}

function publishSnapshot(snapshot, owner = generationRunsOwner()) {
  const normalized = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const runs = Array.isArray(normalized.runs) ? normalized.runs : []
  useGenerationMonitorStore.getState().publishRuns({
    runs,
    owner,
    updatedAt: normalized.updatedAt,
    available: normalized.success !== false,
    observation: normalized.observation || normalized.observe || null,
  })
  for (const run of useGenerationMonitorStore.getState().runs) rememberHandledRun(run)
  return useGenerationMonitorStore.getState().runs
}

async function refreshGenerationRuns(api = globalThis.window?.electronAPI) {
  const native = runsApi(api)
  if (!native?.list) return { success: false, error: 'Generation-run tracking is unavailable in this app session.' }
  try {
    const snapshot = await native.list({ includeOtherProjects: true })
    if (snapshot?.success !== false && Array.isArray(snapshot?.runs)) publishSnapshot(snapshot)
    else useGenerationMonitorStore.getState().setRunsAvailability(false)
    return snapshot
  } catch (error) {
    useGenerationMonitorStore.getState().setRunsAvailability(false)
    return { success: false, error: cleanText(error?.message || error, 300) || 'Generation-run tracking is unavailable.' }
  }
}

function shouldAutoImportRun(run) {
  if (!run || !['done', 'completed'].includes(String(run.status || '').toLowerCase())) return false
  if (!Array.isArray(run.outputs) || run.outputs.length === 0) return false
  const importState = String(run.importState?.state || run.importState || '').toLowerCase()
  // A durable partial receipt is not a completed import. A current-session
  // retry may need to recover its remaining output after a prior save or
  // acknowledgement interruption. `failed` remains deliberately manual.
  if (['failed', 'imported'].includes(importState)) return false
  if (run.outputsTruncated === true && Array.isArray(run.resultAssetIds)
    && run.resultAssetIds.length >= run.outputs.length) return false
  if (autoImportAttemptedRunIds.has(run.runId || run.id)) return false
  if (run.autoImport === false || isExportBusy()) return false
  return run.origin === 'agent' || run.adopted === true
}

function rememberAutoImportAttempt(runId) {
  if (!runId) return
  autoImportAttemptedRunIds.add(runId)
  if (autoImportAttemptedRunIds.size > MAX_HANDLED_RUNS) {
    const oldest = autoImportAttemptedRunIds.values().next().value
    if (oldest) autoImportAttemptedRunIds.delete(oldest)
  }
}

async function maybeAutoImport(snapshot) {
  const context = currentContext()
  if (!context || isExportBusy()) return
  const runs = useGenerationMonitorStore.getState().runs
  for (const run of runs) {
    if (!shouldAutoImportRun(run) || !projectMatchesRun(run, context)) continue
    const runId = run.runId || run.id
    if (!runId || importTasks.has(runId)) continue
    // Completion itself is the user-approved consequence of an agent run; the
    // actual import is still restricted to that run's captured project.
    rememberAutoImportAttempt(runId)
    void importGenerationRunResults(runId, { previewOnly: false, automatic: true })
  }
}

/**
 * Start the app-global native generation-run subscription.  It is idempotent
 * so App can mount it once and hot reloads/tests can dispose it safely.
 */
export function startGenerationRuns({ api = globalThis.window?.electronAPI, pollMs = DEFAULT_POLL_MS } = {}) {
  if (activeBridge) return activeBridge.dispose
  const bridgeApi = runsApi(api)
  if (!bridgeApi?.list || !bridgeApi?.onChanged) {
    // Browser/dev builds without the newer preload should remain usable.
    return () => {}
  }

  let disposed = false
  let receivedEvent = false
  let pollTimer = null
  const apply = (snapshot) => {
    if (disposed || !snapshot) return
    if (snapshot.success === false) {
      useGenerationMonitorStore.getState().setRunsAvailability(false)
      return
    }
    receivedEvent = true
    publishSnapshot(snapshot)
    void maybeAutoImport(snapshot)
  }
  const unsubscribe = bridgeApi.onChanged(apply)
  const refresh = async () => {
    try {
      // Notifications are app-wide; fetch the same scope during recovery so
      // a project switch cannot make older tracked runs disappear from the
      // global drawer. Importing remains project-key gated below.
      const snapshot = await bridgeApi.list({ includeOtherProjects: true })
      if (!disposed && (!receivedEvent || snapshot?.updatedAt)) apply(snapshot)
    } catch (_) {
      // A disconnected native bridge is not an empty ComfyUI queue.
      useGenerationMonitorStore.getState().setRunsAvailability(false)
    }
  }
  void refresh()
  const safePollMs = Math.max(5000, Math.min(60000, Number(pollMs) || DEFAULT_POLL_MS))
  pollTimer = globalThis.setInterval?.(refresh, safePollMs) || null

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (pollTimer) globalThis.clearInterval?.(pollTimer)
    if (typeof unsubscribe === 'function') unsubscribe()
    useGenerationMonitorStore.getState().clearRuns()
    activeBridge = null
  }
  activeBridge = { dispose }
  return dispose
}

export function stopGenerationRuns() {
  activeBridge?.dispose?.()
}

function findRun(runId) {
  const key = cleanText(runId, 180)
  if (!key) return null
  return useGenerationMonitorStore.getState().runs.find(run => run.runId === key || run.id === key) || null
}

function existingOutputAsset(run, output) {
  // A corrected media type must not change an already-imported file's identity.
  const identity = value => String(value || '').replace(/^(image|video|audio):/, '')
  const signature = identity(outputSignature(output))
  return (useAssetsStore.getState().assets || []).find((asset) => (
    asset?.source === 'velorn-generation-run'
    && String(asset?.generationRun?.runId || '') === String(run.runId || run.id || '')
    && identity(asset?.generationRun?.outputSignature) === signature
  )) || null
}

function existingOutputCoverage(run, outputs = []) {
  const assetIds = []
  let matchedCount = 0
  for (const output of outputs) {
    const asset = existingOutputAsset(run, output)
    if (!asset || asset.type !== output.mediaType) continue
    matchedCount += 1
    const id = cleanText(asset.id, 512)
    if (id && !assetIds.includes(id)) assetIds.push(id)
  }
  return { matchedCount, assetIds }
}

function receiptAssetIds(run, outputs) {
  // The native receipt is durable across a renderer restart, while matching
  // project assets lets us recover from a save-success / acknowledgement-fail
  // interruption. Send the union on every explicit retry; native then unions
  // it again defensively rather than replacing an earlier partial receipt.
  const ids = []
  for (const value of [...(Array.isArray(run?.resultAssetIds) ? run.resultAssetIds : []), ...existingOutputCoverage(run, outputs).assetIds]) {
    const id = cleanText(value, 512)
    if (id && !ids.includes(id)) ids.push(id)
    if (ids.length >= MAX_OUTPUTS_PER_RUN) break
  }
  return ids
}

function ensureRunFolder() {
  const segments = ['Generated', 'Agent runs']
  let parentId = null
  for (const name of segments) {
    const assets = useAssetsStore.getState()
    const existing = (assets.folders || []).find((folder) => (
      (folder?.parentId || null) === parentId
      && String(folder?.name || '').trim().toLowerCase() === name.toLowerCase()
    ))
    const folder = existing || assets.addFolder?.({ name, parentId })
    parentId = folder?.id || parentId
  }
  return parentId || null
}

async function downloadOutput(output) {
  if (output.mediaType === 'video') {
    return await comfyui.downloadVideo(output.filename, output.subfolder, output.type)
  }
  if (output.mediaType === 'image') {
    return await comfyui.downloadImage(output.filename, output.subfolder, output.type)
  }
  const url = comfyui.getMediaUrl(output.filename, output.subfolder, output.type)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${output.filename} (${response.status}).`)
  const blob = await response.blob()
  return new File([blob], output.filename, { type: blob.type || 'audio/mpeg' })
}

function runOutputPlan(run, context = currentContext()) {
  const outputs = (Array.isArray(run?.outputs) ? run.outputs : [])
    .map(cleanOutput)
    .filter(Boolean)
    .slice(0, MAX_OUTPUTS_PER_RUN)
  const unique = []
  const seen = new Set()
  for (const output of outputs) {
    const signature = outputSignature(output)
    if (seen.has(signature)) continue
    seen.add(signature)
    const existing = existingOutputAsset(run, output)
    unique.push({ ...output, signature, alreadyImported: Boolean(existing), needsTypeRepair: Boolean(existing && existing.type !== output.mediaType) })
  }
  const project = useProjectStore.getState().currentProject
  const reportedOutputCount = Number.isFinite(Number(run?.outputCount ?? run?.totalOutputs))
    ? Math.max(unique.length, Math.min(1_000_000, Math.floor(Number(run.outputCount ?? run.totalOutputs))))
    : unique.length
  const outputsTruncated = run?.outputsTruncated === true || run?.outputTruncated === true
    || run?.outputDescriptorsTruncated === true || reportedOutputCount > unique.length
  return {
    runId: run?.runId || run?.id || null,
    projectName: project?.name || null,
    projectMatches: projectMatchesRun(run, context),
    outputs: unique,
    importableCount: unique.filter(output => !output.alreadyImported).length,
    repairableCount: unique.filter(output => output.needsTypeRepair).length,
    outputCount: reportedOutputCount,
    outputsTruncated,
  }
}

function assertActiveRunProject(run, projectHandle) {
  const currentHandle = useProjectStore.getState().currentProjectHandle
  if (!projectHandle || currentHandle !== projectHandle || !projectMatchesRun(run, currentContext())) {
    const error = new Error('The active project changed while importing. No further outputs were added.')
    error.code = 'GENERATION_RUN_PROJECT_CHANGED'
    throw error
  }
}

async function recipeForSidecar(run, api) {
  const native = runsApi(api)
  if (!native?.recipe || !run?.runId || run.recipeAvailable !== true) return null
  try {
    const result = await native.recipe({ runId: run.runId })
    if (result?.success === false) return null
    const workflow = safeApiWorkflow(result?.workflow || result?.apiWorkflow || result?.recipe?.workflow)
    if (!workflow) return null
    // Historical identity only, never a path or permission to replay today's
    // library contents. The redacted graph remains the recipe for this run.
    const savedReference = typeof result?.workflowId === 'string' && result.workflowId.length <= 200
      && /^(?:my-workflow:[A-Za-z0-9][A-Za-z0-9_.-]*|tpl-mcp-[a-z0-9][a-z0-9-]{0,47})$/.test(result.workflowId)
      && /^[a-f0-9]{64}$/.test(result.sourceGraphFingerprint || '') && /^[a-f0-9]{64}$/.test(result.resolvedFingerprint || '')
      ? { workflowId: result.workflowId, sourceGraphFingerprint: result.sourceGraphFingerprint, resolvedFingerprint: result.resolvedFingerprint }
      : {}
    return {
      workflow,
      ...savedReference,
      fingerprint: cleanText(result?.fingerprint, 128) || null,
      redacted: result?.redacted === true,
      cannotExactReplay: result?.cannotExactReplay === true,
      note: cleanText(result?.note, 500) || null,
    }
  } catch (_) {
    // A media import remains useful even when an older run has no recipe.
    return null
  }
}

async function writeRecipeSidecar({ projectHandle, assetInfo, run, output, recipe, api, assertCurrent }) {
  if (!recipe?.workflow || !assetInfo?.path || !api?.pathJoin || !api?.writeFile) return null
  const relativeSidecar = `${assetInfo.path}.velorn-workflow.json`
  const sidecarPath = await api.pathJoin(projectHandle, relativeSidecar)
  assertCurrent()
  const payload = {
    version: 1,
    source: 'velorn-generation-run',
    savedAt: new Date().toISOString(),
    run: {
      id: run.runId,
      origin: run.origin || 'external',
      promptId: run.promptId || null,
      label: run.workflowLabel || null,
      output: {
        filename: output.filename,
        subfolder: output.subfolder || '',
        type: output.type || 'output',
        nodeId: output.nodeId || null,
        mediaType: output.mediaType,
      },
    },
    recipe,
  }
  const written = await api.writeFile(sidecarPath, JSON.stringify(payload, null, 2), { encoding: 'utf8' })
  assertCurrent()
  if (!written?.success) throw new Error(written?.error || 'Could not save this output’s workflow recipe.')
  return relativeSidecar
}

async function markAutomaticImportFailed(run, runId, reason, api) {
  const native = runsApi(api)
  if (!native?.control || !runId) return null
  try {
    const result = await native.control({
      operation: 'mark-import-failed',
      runId,
      error: cleanText(reason, 400) || 'Velorn could not import the completed generation output.',
      previewOnly: false,
    })
    if (result?.success !== false) await refreshGenerationRuns(api)
    return result
  } catch (_) {
    return null
  }
}

/**
 * Preview/import completed registered-run output.  Preview is deliberately the
 * default and performs no download, filesystem write, asset change, or native
 * acknowledgement.  Apply only occurs with previewOnly:false.
 */
export async function importGenerationRunResults(runId, { previewOnly = true, automatic = false, api = globalThis.window?.electronAPI } = {}) {
  const run = findRun(runId)
  if (!run) return { success: false, previewOnly: true, error: 'That generation run is no longer available in this session.' }
  const context = currentContext()
  const plan = runOutputPlan(run, context)
  const base = {
    success: true,
    action: 'import_comfyui_run_outputs',
    runId: plan.runId,
    previewOnly: previewOnly !== false,
    origin: run.origin || 'external',
    projectName: plan.projectName,
    projectMatches: plan.projectMatches,
    outputs: plan.outputs.map(({ signature, ...output }) => output),
    importableCount: plan.importableCount,
    repairableCount: plan.repairableCount,
    outputCount: plan.outputCount,
    outputsTruncated: plan.outputsTruncated,
  }
  if (previewOnly !== false) {
    return {
      ...base,
      message: plan.projectMatches
        ? `${plan.importableCount} verified outputs can be imported; ${plan.repairableCount} existing asset types need repair in place.`
        : 'Preview only. Reopen the project that started this run before importing its outputs.',
    }
  }
  if (!isElectron()) return { ...base, success: false, previewOnly: false, error: 'Importing registered runs is available in the desktop app.' }
  if (isExportBusy()) return { ...base, success: false, previewOnly: false, error: 'Wait for the active export to finish before importing generation outputs.' }
  if (!plan.projectMatches) return { ...base, success: false, previewOnly: false, error: 'Reopen the project that started this run before importing its outputs.' }
  if (!plan.runId) return { ...base, success: false, previewOnly: false, error: 'This run has no stable identifier.' }
  if (importTasks.has(plan.runId)) return await importTasks.get(plan.runId)

  const task = (async () => {
    // This prevents the ambient ComfyUI auto-importer from adding the same
    // files midway through a deliberate run import.
    rememberHandledRun(run)
    const projectHandle = useProjectStore.getState().currentProjectHandle
    if (!projectHandle) throw new Error('Open the run’s original project before importing outputs.')
    assertActiveRunProject(run, projectHandle)
    assertRunEndpoint(run, true)
    // A recipe is read from the native broker only after the caller has
    // explicitly applied import. Preview mode above stays completely inert.
    const recipe = await recipeForSidecar(run, api)
    assertActiveRunProject(run, projectHandle)
    const folderId = plan.importableCount > 0 ? ensureRunFolder() : null
    const importedAssets = []
    const repairedAssetIds = []
    const failures = []
    const outputFailures = []
    for (const output of plan.outputs) {
      assertActiveRunProject(run, projectHandle)
      assertRunEndpoint(run)
      try {
        if (output.alreadyImported) {
          const existing = existingOutputAsset(run, output)
          if (existing && existing.type !== output.mediaType) {
            if (!['video', 'audio'].includes(output.mediaType) || !api?.getVideoFps || !api?.pathJoin
              || !existing.path || /^(?:[\\/]|[A-Za-z]:)/.test(existing.path) || existing.path.split(/[\\/]+/).includes('..')) {
              throw new Error('This existing output needs media inspection before its type can be repaired.')
            }
            const filePath = await api.pathJoin(projectHandle, existing.path)
            const info = await api.getVideoFps(filePath)
            assertActiveRunProject(run, projectHandle); assertRunEndpoint(run)
            if (!info?.success || !(Number(info.duration) > 0) || (output.mediaType === 'video' && !info.videoCodec)) {
              throw new Error('Could not verify the existing media file. It was not reimported or duplicated.')
            }
            if (existingOutputAsset(run, output) !== existing) throw new Error('The existing asset changed during inspection. Retry the import.')
            const updates = { type: output.mediaType, duration: info.duration,
              generationRun: { ...existing.generationRun, outputSignature: output.signature } }
            for (const key of ['width', 'height', 'fps', 'hasAudio', 'videoCodec', 'audioCodec', 'pixelFormat', 'videoProfile', 'hasAlpha']) {
              if (info[key] != null) updates[key] = info[key]
            }
            useAssetsStore.getState().updateAsset(existing.id, updates)
            repairedAssetIds.push(existing.id)
          }
          continue
        }
        const file = await downloadOutput(output)
        assertActiveRunProject(run, projectHandle)
        assertRunEndpoint(run)
        const category = output.mediaType === 'image' ? 'images' : output.mediaType
        const assetInfo = await importAsset(projectHandle, file, category)
        assertActiveRunProject(run, projectHandle)
        let recipeSidecar = null
        try {
          recipeSidecar = await writeRecipeSidecar({
            projectHandle,
            assetInfo,
            run,
            output,
            recipe,
            api,
            assertCurrent: () => assertActiveRunProject(run, projectHandle),
          })
        } catch (error) {
          if (error?.code === 'GENERATION_RUN_PROJECT_CHANGED') throw error
          failures.push({ filename: `${output.filename} recipe`, error: cleanText(error?.message || error, 300) || 'Could not save the workflow recipe.' })
        }
        assertActiveRunProject(run, projectHandle)
        const asset = useAssetsStore.getState().addAsset({
          ...assetInfo,
          name: output.filename,
          type: assetInfo?.type || output.mediaType,
          url: assetInfo?.url || URL.createObjectURL(file),
          folderId,
          isImported: true,
          source: 'velorn-generation-run',
          promptId: run.promptId || null,
          sourceNodeId: output.nodeId || null,
          generationRun: {
            version: 1,
            runId: plan.runId,
            origin: run.origin || 'external',
            workflowId: run.workflowId || null,
            workflowLabel: run.workflowLabel || run.label || null,
            promptId: run.promptId || null,
            outputSignature: output.signature,
            filename: output.filename,
            subfolder: output.subfolder || '',
            outputType: output.type || 'output',
            nodeId: output.nodeId || null,
            recipeAvailable: run.recipeAvailable === true,
            recipeSidecar,
          },
        })
        if (asset) importedAssets.push(asset)
      } catch (error) {
        if (error?.code === 'GENERATION_RUN_PROJECT_CHANGED' || error?.code === 'GENERATION_RUN_ENDPOINT_CHANGED') throw error
        const failure = { filename: output.filename, error: cleanText(error?.message || error, 300) || 'Import failed.' }
        failures.push(failure)
        outputFailures.push(failure)
      }
    }
    if (importedAssets.length > 0 || repairedAssetIds.length > 0) {
      assertActiveRunProject(run, projectHandle)
      const saved = await useProjectStore.getState().saveProject()
      assertActiveRunProject(run, projectHandle)
      if (!saved) throw new Error('Outputs were added, but Velorn could not save the project. Keep the project open and save it before closing.')
    }
    const resultAssetIds = importedAssets.map(asset => asset?.id).filter(Boolean)
    const coverage = existingOutputCoverage(run, plan.outputs)
    const reconciledAssetIds = receiptAssetIds(run, plan.outputs)
    const allRepresentedOutputsImported = plan.outputs.length > 0 && coverage.matchedCount === plan.outputs.length
    const fullyImported = allRepresentedOutputsImported && !plan.outputsTruncated && outputFailures.length === 0
    let acknowledgement = null
    let acknowledgementFailure = null
    const native = runsApi(api)
    // A retry after a save-success / acknowledgement-fail interruption has no
    // newly created asset IDs. Re-send every known receipt, including assets
    // already in this project, so native bookkeeping can recover without
    // duplicating media. Native unions IDs and reports a partial state until
    // every represented descriptor is reconciled.
    if (reconciledAssetIds.length > 0 && outputFailures.length === 0 && typeof native?.control === 'function') {
      try {
        assertActiveRunProject(run, projectHandle)
        acknowledgement = await native.control({ operation: 'mark-imported', runId: plan.runId, resultAssetIds: reconciledAssetIds, previewOnly: false })
        assertActiveRunProject(run, projectHandle)
        if (acknowledgement?.success === false) throw new Error(acknowledgement.error || 'Velorn could not record the import acknowledgement.')
      } catch (error) {
        if (error?.code === 'GENERATION_RUN_PROJECT_CHANGED') throw error
        acknowledgementFailure = { filename: 'Run record', error: cleanText(error?.message || error, 300) || 'The project imported outputs, but the run record was not updated.' }
        failures.push(acknowledgementFailure)
      }
    }
    assertActiveRunProject(run, projectHandle)
    if (acknowledgement?.success === true) {
      useGenerationMonitorStore.getState().markRunImported(
        plan.runId,
        acknowledgement?.run?.resultAssetIds || reconciledAssetIds,
        acknowledgement?.run?.importState || (fullyImported ? 'imported' : 'partial'),
      )
    }
    // An automatic run is permitted one best-effort output import. If a media
    // import or durable acknowledgement actually fails, make that visible and
    // stop polling-driven retries. A deliberately truncated descriptor set is
    // represented by native's partial state instead of being mislabeled as a
    // failed media import.
    if (automatic && (outputFailures.length > 0 || acknowledgementFailure)) {
      await markAutomaticImportFailed(run, plan.runId, [...outputFailures, acknowledgementFailure].filter(Boolean).map(item => item.error).join(' '), api)
    }
    return {
      ...base,
      previewOnly: false,
      automatic,
      importedAssetIds: resultAssetIds,
      importedCount: resultAssetIds.length,
      repairedAssetIds,
      repairedCount: repairedAssetIds.length,
      reconciledAssetIds,
      reconciledCount: reconciledAssetIds.length,
      complete: fullyImported && acknowledgement?.run?.importState !== 'partial',
      failures,
      acknowledged: acknowledgement?.success === true,
      message: failures.length > 0
        ? `Imported ${resultAssetIds.length} output${resultAssetIds.length === 1 ? '' : 's'}; ${failures.length} item${failures.length === 1 ? '' : 's'} need attention.`
        : !fullyImported
          ? `Imported ${resultAssetIds.length} output${resultAssetIds.length === 1 ? '' : 's'}; this run still has outputs to reconcile.`
          : repairedAssetIds.length > 0
            ? `Imported ${resultAssetIds.length} outputs and repaired ${repairedAssetIds.length} existing asset types without duplicating their files.`
          : resultAssetIds.length === 0
            ? `Verified ${reconciledAssetIds.length} imported output${reconciledAssetIds.length === 1 ? '' : 's'} in this project.`
            : `Imported ${resultAssetIds.length} output${resultAssetIds.length === 1 ? '' : 's'} into this project.`,
    }
  })().catch(async (error) => {
    const message = cleanText(error?.message || error, 400) || 'Could not import generation outputs.'
    if (automatic && !['GENERATION_RUN_PROJECT_CHANGED', 'GENERATION_RUN_ENDPOINT_CHANGED'].includes(error?.code)) {
      await markAutomaticImportFailed(run, plan.runId, message, api)
    }
    return { ...base, success: false, previewOnly: false, automatic, error: message }
  })
    .finally(() => importTasks.delete(plan.runId))
  importTasks.set(plan.runId, task)
  return await task
}

export async function adoptGenerationRun(promptId, { label = null, api = globalThis.window?.electronAPI } = {}) {
  const native = runsApi(api)
  const id = cleanText(promptId, 512)
  const context = currentContext()
  if (!native?.adopt || !id || !context?.projectKey) {
    return { success: false, error: 'This external run cannot be adopted in the current app session.' }
  }
  const result = await native.adopt({ promptId: id, label: cleanText(label, 192) || undefined, previewOnly: false })
  if (result?.success !== false) await refreshGenerationRuns(api)
  return result
}

export async function controlGenerationRun(runId, operation, { api = globalThis.window?.electronAPI } = {}) {
  const native = runsApi(api)
  const run = findRun(runId)
  if (!native?.control || !run?.runId || !cleanText(operation, 40)) {
    return { success: false, error: 'This run cannot be controlled in the current app session.' }
  }
  const result = await native.control({ operation: cleanText(operation, 40), runId: run.runId, previewOnly: false })
  if (result?.success !== false) await refreshGenerationRuns(api)
  return result
}

function safeApiWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const serialized = JSON.stringify(value)
    if (!serialized || serialized.length > 5 * 1024 * 1024) return null
    return JSON.parse(serialized)
  } catch (_) {
    return null
  }
}

export async function openGenerationRunRecipe(runId, { api = globalThis.window?.electronAPI } = {}) {
  const native = runsApi(api)
  const run = findRun(runId)
  if (!native?.recipe || !run?.runId) return { success: false, error: 'This run recipe is unavailable.' }
  const result = await native.recipe({ runId: run.runId })
  if (result?.success === false) return result
  const workflow = safeApiWorkflow(result?.apiWorkflow || result?.workflow || result?.recipe?.apiWorkflow)
  if (!workflow) return { success: false, error: 'Velorn could not verify a safe API workflow recipe for this run.' }
  return await openApiWorkflowInComfyUi(workflow, { label: cleanText(run.workflowLabel || run.label || 'Generation run', 120) })
}

export function setGenerationRunsObservation(enabled, { api = globalThis.window?.electronAPI } = {}) {
  const native = runsApi(api)
  if (enabled !== true) {
    useGenerationMonitorStore.getState().setObservation(null)
    return Promise.resolve({ success: true, enabled: false, message: 'External ComfyUI observation is hidden. No runs were changed.' })
  }
  if (!native?.observe) return Promise.resolve({ success: false, error: 'External-run observation is unavailable in this app session.' })
  return Promise.resolve(native.observe({})).then(async (result) => {
    if (result?.success === false) return result
    useGenerationMonitorStore.getState().setObservation({
      enabled: true,
      endpoint: cleanText(result?.endpoint, 600) || null,
      jobs: Array.isArray(result?.jobs) ? result.jobs.slice(0, 128) : [],
      updatedAt: result?.updatedAt || Date.now(),
    })
    await refreshGenerationRuns(api)
    return result
  })
}

export async function refreshGenerationRunObservation({ api = globalThis.window?.electronAPI } = {}) {
  const native = runsApi(api)
  const observation = useGenerationMonitorStore.getState().observation
  // Native recovery for a temporarily unknown prompt is intentionally tied to
  // its read-only observe call. Refresh must therefore make that call even
  // when the optional External jobs section is hidden. It never adopts,
  // imports, cancels, or reveals those jobs unless the user opted in below.
  let observationError = null
  let observed = null
  if (native?.observe) {
    try {
      observed = await native.observe({})
      if (observed?.success === false) observationError = cleanText(observed.error || 'The ComfyUI recovery check was unavailable.', 300)
      else if (observation?.enabled === true) {
        useGenerationMonitorStore.getState().setObservation({
          enabled: true,
          endpoint: cleanText(observed?.endpoint, 600) || null,
          jobs: Array.isArray(observed?.jobs) ? observed.jobs.slice(0, 128) : [],
          updatedAt: observed?.updatedAt || Date.now(),
        })
      }
    } catch (error) {
      observationError = cleanText(error?.message || error, 300) || 'The ComfyUI recovery check was unavailable.'
    }
  }
  const refreshed = await refreshGenerationRuns(api)
  if (refreshed?.success === false) return refreshed
  return {
    ...refreshed,
    observation: observed || null,
    observationError,
    message: observationError
      ? `Generation queue refreshed; ${observationError}`
      : 'Generation queue refreshed.',
  }
}
