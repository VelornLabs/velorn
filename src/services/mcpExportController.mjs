import { DELIVERY_PRESETS, resolveDeliveryPresetSettings } from '../utils/exportDeliveryPresets.mjs'
import { LEGACY_EXPORT_PRESETS } from '../utils/exportLegacyPresets.mjs'
import { readExportPresetLibrary, updateExportPresetLibrary, validateExportPresetName, validateCustomExportPresetSettings } from '../utils/exportPresetLibrary.mjs'
import { resolveMcpExportPlan } from '../utils/mcpExportPlan.mjs'
import { buildExportReadinessPlan, EXPORT_READINESS_WARNING_COPY } from '../utils/exportReadiness.mjs'
import { runExportReadinessCheck } from './exportReadiness.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status)
const newId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const requireSuccess = result => { if (!result?.ok) throw new Error(result?.error || 'Preset operation failed'); return result }
const requestKey = payload => {
  const normalize = value => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  return JSON.stringify(normalize(Object.fromEntries(Object.entries(payload)
    .filter(([key]) => !['previewOnly', 'expectedContext', 'exportPlanToken'].includes(key)))))
}

/** Dependency-injected controller keeps previews, stale guards, sequential
 * lifecycle, and failure behavior testable without running a real export. */
export function createMcpExportController({ getProject, getTimeline, getAssets, getApi,
  captureContext, assertContext, storage, notifyPresets = () => {}, sleep = delay,
  beginBatchActivity = () => null } = {}) {
  const batches = new Map()
  const previews = new Map()
  const rememberPreview = (kind, payload, snap, prepared) => {
    for (const [token, record] of previews) if (record.expiresAt < Date.now()) previews.delete(token)
    while (previews.size >= 20) previews.delete(previews.keys().next().value)
    const token = newId('export-plan')
    previews.set(token, { kind, requestKey: requestKey(payload), snap, prepared, expiresAt: Date.now() + 15 * 60 * 1000 })
    return token
  }
  const readPreview = (kind, payload) => {
    if (!payload.exportPlanToken) return null
    const record = previews.get(payload.exportPlanToken)
    if (!record || record.kind !== kind || record.expiresAt < Date.now()) throw new Error('Export preview expired or was already applied. Preview again before exporting.')
    if (record.requestKey !== requestKey(payload)) throw new Error('Export arguments changed after preview. Create a new preview for these settings.')
    assertContext(record.snap.context, 'reviewed export plan')
    return record
  }
  const api = () => {
    const value = getApi()
    if (!value?.runExportInWorker || !value?.getExportJobs) throw new Error('Export job tools require the current Velorn desktop app. Restart after updating.')
    return value
  }
  const library = () => requireSuccess(readExportPresetLibrary(storage))
  function activeSettings(project, timeline) {
    const parent = project.getCurrentTimelineSettings?.() || project.currentProject?.settings || {}
    if (!timeline.compoundEditContext) return parent
    const child = timeline.getActiveDocumentData?.() || timeline.compoundEditContext.originalChildDocument
    if (!child || ![child.width, child.height, child.fps].every(value => Number.isFinite(value) && value > 0)) throw new Error('The active compound has invalid export dimensions or frame rate. Return to the parent timeline and inspect the compound.')
    return { ...parent, width: child.width, height: child.height, fps: child.fps }
  }
  function snapshot() {
    const project = getProject(), timeline = getTimeline(), assets = getAssets()
    if (!project.currentProject || typeof project.currentProjectHandle !== 'string' || !project.currentProjectHandle) throw new Error('Open a saved project and timeline before exporting.')
    const settings = activeSettings(project, timeline)
    const duration = timeline.getTimelineEndTime?.() ?? Math.max(0, ...(timeline.clips || []).map(clip => Number(clip.startTime) + Number(clip.duration)))
    return { context: captureContext(), projectPath: project.currentProjectHandle,
      info: { ...settings, duration, inPoint: timeline.inPoint, outPoint: timeline.outPoint,
        name: timeline.compoundEditContext?.compoundName || project.currentProject.name },
      activeDocument: { kind: timeline.compoundEditContext ? 'compound' : 'timeline',
        compoundClipId: timeline.compoundEditContext?.compoundClipId || null, width: settings.width, height: settings.height, fps: settings.fps },
      state: clone({ timeline: { clips: timeline.clips || [], tracks: timeline.tracks || [], transitions: timeline.transitions || [],
        timelineFps: settings.fps || timeline.timelineFps, masterAudioVolume: timeline.masterAudioVolume, masterAudioInserts: timeline.masterAudioInserts || [] },
      assets: assets.assets || [] }) }
  }
  async function readiness(snap, plan) {
    const input = buildExportReadinessPlan({ ...snap.state.timeline, assets: snap.state.assets,
      projectHandle: snap.projectPath, timelineFps: snap.info.fps,
      rangeStart: plan.options.rangeStart, rangeEnd: plan.options.rangeEnd,
      includeAudio: plan.options.includeAudio, format: plan.options.format, useProxyMedia: plan.options.useProxyMedia })
    const result = await runExportReadinessCheck(input, { api: getApi(), isCurrent: () => {
      try { assertContext(snap.context, 'export preflight'); return true } catch { return false }
    } })
    if (!result) throw new Error('The project or timeline changed during export preflight. Preview again.')
    return { ...result, advisory: true, blocked: false, warnings: result.warnings.map(warning => ({ ...warning,
      title: EXPORT_READINESS_WARNING_COPY[warning.code]?.[0],
      detail: EXPORT_READINESS_WARNING_COPY[warning.code]?.[1]?.replace('{{name}}', warning.name || '') })) }
  }
  async function prepare(snap, payload) {
    const bridge = api()
    const plan = resolveMcpExportPlan(payload, snap.info, library().presets)
    plan.activeDocument = snap.activeDocument
    const folder = await bridge.pathJoin(snap.projectPath, 'renders')
    const suffix = plan.extension ? `.${plan.extension}` : ''
    if (plan.outputPath != null && (typeof plan.outputPath !== 'string' || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(plan.outputPath) || plan.outputPath.includes('\0'))) throw new Error('Export outputPath must be an absolute local path')
    plan.outputPath = plan.outputPath || await bridge.pathJoin(folder, `${plan.filename}_${newId('delivery')}${suffix}`)
    if (plan.extension && !plan.outputPath.toLowerCase().endsWith(suffix)) throw new Error(`Export outputPath must end in ${suffix}`)
    if (await bridge.exists(plan.outputPath)) throw new Error(`Export destination already exists; choose a new filename: ${plan.outputPath}`)
    plan.options.outputPath = plan.outputPath
    let postProcess = null, sourceOutputPath = plan.outputPath
    if (plan.options.postProcessUpscale === 'rtx-4k') {
      if (bridge.platform !== 'win32' || plan.options.format !== 'mp4' || plan.options.transparent) throw new Error('RTX 4K post-processing requires an opaque MP4 export on Windows.')
      const runtime = await bridge.checkRtxVideoUpscaleRuntime?.()
      if (!runtime?.ready) throw new Error(runtime?.error || 'The optional NVIDIA RTX runtime is not ready. Install it from Export first.')
      sourceOutputPath = await bridge.pathJoin(folder, `.velorn-rtx-source-${newId('mcp')}.mp4`)
      postProcess = { type: 'rtx-4k', outputPath: plan.outputPath, sourceWidth: plan.options.width,
        sourceHeight: plan.options.height, videoCodec: plan.options.videoCodec, quality: plan.settings.rtxUpscaleQuality }
    }
    plan.readiness = await readiness(snap, plan)
    // Preview is read-only; native apply prepares these exact parents, not
    // merely the default project renders directory.
    plan.outputDirectories = []
    for (const destination of new Set([sourceOutputPath, plan.outputPath])) {
      const directory = await bridge.pathJoin(destination, '..')
      if (plan.outputDirectories.some(item => item.path === directory)) continue
      plan.outputDirectories.push({ path: directory, createOnApply: !await bridge.exists(directory) })
    }
    assertContext(snap.context, 'export preflight')
    return { plan, folder, job: { owner: 'mcp', projectPath: snap.projectPath, outputPath: sourceOutputPath,
      options: { ...plan.options, outputPath: sourceOutputPath }, postProcess, state: snap.state } }
  }
  async function start(prepared, batchId = null, expectedContext = null) {
    const bridge = api()
    const status = await bridge.getExportJobs()
    if (status.activeJobId) throw new Error(`Export already in progress (${status.activeJobId}). Wait for completion; no other render was interrupted.`)
    if (expectedContext) assertContext(expectedContext, 'export startup')
    const jobId = newId('mcp-export')
    const result = await bridge.runExportInWorker({ ...prepared.job, jobId, batchId })
    if (result?.success === false && result.code === 'EXPORT_NOT_STARTED'
      && result.outcome === 'not-started' && result.workerStarted === false && result.phase === 'destination'
      && result.jobId === jobId && result.outputPath === prepared.plan.outputPath) {
      throw Object.assign(new Error(result.error || 'The export destination could not be prepared.'), { exportRefusal: result })
    }
    if (result?.success === false || result?.error || result?.jobId !== jobId) throw new Error(result?.error || 'The export worker did not acknowledge its job ID')
    return jobId
  }
  async function refreshPrepared(snap, prepared) {
    for (const item of prepared) {
      if (await api().exists(item.plan.outputPath)) throw new Error(`Export destination already exists; preview a different output path: ${item.plan.outputPath}`)
      item.plan.readiness = await readiness(snap, item.plan)
    }
    assertContext(snap.context, 'reviewed export plan')
  }
  async function waitForJob(jobId) {
    // Native terminal records prevent missed fast-completion events. There is
    // no arbitrary render timeout and no retry of a busy worker.
    while (true) {
      const status = await api().getExportJobs()
      const job = status.jobs.find(entry => entry.jobId === jobId)
      if (!job) throw new Error('Export status was lost. Inspect the output before starting another render.')
      if (terminal(job.status)) return job
      await sleep(500)
    }
  }
  const publicBatch = batch => clone({ batchId: batch.batchId, status: batch.status, context: batch.context,
    snapshotPolicy: 'All targets use the authored timeline snapshot captured when this batch was approved.',
    queuePersistence: 'Pending targets exist in this renderer session only; active/completed jobs are tracked natively until app exit.',
    pauseRequested: batch.pauseRequested, cancelRequested: batch.cancelRequested, error: batch.error,
    targets: batch.items.map(({ plan, jobId, status, error }) => ({ plan, jobId, status, error })) })
  async function runBatch(batch, preparedActivity = null) {
    if (batch.processing) return
    batch.processing = true
    batch.status = 'running'
    let activity = preparedActivity
    try {
      // One lease spans every native job and the gaps between jobs. Resuming a
      // paused batch acquires a new lease; internal continuation never re-enters
      // the external MCP action guard.
      activity ||= beginBatchActivity({ batchId: batch.batchId, status: 'Preparing export batch…',
        cancel: () => actions.control_export_batch({ batchId: batch.batchId, operation: 'cancel', previewOnly: false }) })
      for (const item of batch.items) {
        if (item.status !== 'queued') continue
        if (batch.cancelRequested) { item.status = 'cancelled'; continue }
        if (batch.pauseRequested) { batch.status = 'paused'; break }
        try {
          activity?.update?.({ batchId: batch.batchId,
            status: `Preparing export ${batch.items.indexOf(item) + 1} of ${batch.items.length}…`, progress: null })
          item.status = 'starting'
          item.jobId = await start(item.prepared, batch.batchId)
          item.status = 'running'
          // Cancellation could have arrived during asynchronous startup.
          if (batch.cancelRequested) await api().cancelExportJob(item.jobId)
          const done = await waitForJob(item.jobId)
          item.status = done.status; item.error = done.error
          if (done.status !== 'completed' && batch.stopOnError && !batch.cancelRequested) {
            batch.status = done.status === 'cancelled' ? 'cancelled' : 'failed'
            batch.error = done.error
            break
          }
        } catch (error) {
          item.status = 'failed'; item.error = error.message
          if (batch.stopOnError) { batch.status = 'failed'; batch.error = error.message; break }
        }
      }
      if (batch.cancelRequested) {
        batch.status = 'cancelled'
        for (const item of batch.items) if (item.status === 'queued') item.status = 'cancelled'
      } else if (batch.status === 'running') {
        batch.status = batch.items.some(item => item.status === 'failed') ? 'failed'
          : batch.items.some(item => item.status === 'cancelled') ? 'cancelled' : 'completed'
      }
      if (terminal(batch.status)) {
        for (const item of batch.items) if (item.status === 'queued') {
          item.status = 'skipped'
          item.error = `Not started because this batch ${batch.status === 'failed' ? 'failed' : 'was cancelled'}.`
        }
      }
    } finally {
      batch.processing = false
      activity?.end?.()
    }
  }
  const actions = {
    list_export_presets() {
      const timeline = activeSettings(getProject(), getTimeline())
      return { builtIn: [...DELIVERY_PRESETS, ...LEGACY_EXPORT_PRESETS].map(preset => ({ ...preset, settings: resolveDeliveryPresetSettings(preset, timeline) })),
        custom: library().presets, formats: ['mp4', 'webm', 'prores', 'audio', 'png-seq', 'gif'] }
    },
    save_export_preset(payload = {}) { return mutatePreset('save', payload) },
    rename_export_preset(payload = {}) { return mutatePreset('rename', payload) },
    delete_export_preset(payload = {}) { return mutatePreset('delete', payload) },
    async check_export_readiness(payload = {}) {
      assertContext(payload.expectedContext, 'export readiness')
      const snap = snapshot()
      const plan = resolveMcpExportPlan(payload, snap.info, library().presets)
      plan.activeDocument = snap.activeDocument
      return { context: snap.context, plan, ...(await readiness(snap, plan)) }
    },
    async export_timeline(payload = {}) {
      assertContext(payload.expectedContext, 'export')
      const reviewed = readPreview('single', payload)
      const snap = reviewed?.snap || snapshot(), prepared = reviewed?.prepared[0] || await prepare(snap, payload)
      if (payload.previewOnly !== false) {
        const exportPlanToken = payload.exportPlanToken || rememberPreview('single', payload, snap, [prepared])
        return { previewOnly: true, context: snap.context, plan: clone(prepared.plan), exportPlanToken,
          suggestedApplyPayload: { exportPlanToken } }
      }
      if (reviewed) {
        // Consume before the first await so simultaneous apply calls cannot
        // both start the same approved render.
        previews.delete(payload.exportPlanToken)
        await refreshPrepared(snap, [prepared])
      }
      assertContext(snap.context, 'export')
      try {
        const jobId = await start(prepared, null, snap.context)
        return { started: true, jobId, outputPath: prepared.plan.outputPath, context: snap.context, plan: prepared.plan }
      } catch (error) {
        if (!error.exportRefusal) throw error
        return { ...error.exportRefusal, started: false,
          message: 'Export did not start: the destination could not be prepared. Inspect the destination, then create a fresh preview before trying again.' }
      }
    },
    async export_delivery_batch(payload = {}) {
      let batch = null, cancelled = false, handedOff = false
      const checkCancelled = () => { if (cancelled) throw new Error('Export cancelled') }
      // A real apply locks before preflight's first await, not only after the
      // first worker starts. Previews do not claim an export activity lease.
      const activity = payload.previewOnly === false ? beginBatchActivity({ status: 'Preparing export batch…',
        cancel: async () => {
          cancelled = true
          if (batch) await actions.control_export_batch({ batchId: batch.batchId, operation: 'cancel', previewOnly: false })
        } }) : null
      try {
        assertContext(payload.expectedContext, 'export batch')
        const reviewed = readPreview('batch', payload)
        const targets = payload.targets || payload.presets
        const limit = payload.limit ?? 12
        if (!Number.isInteger(limit) || limit < 1 || limit > 12 || !Array.isArray(targets) || !targets.length || targets.length > limit) throw new Error('Supply 1–12 delivery targets, within the requested batch limit.')
        if (payload.outputPath) throw new Error('Set a distinct outputPath on each batch target, not on the whole batch.')
        const snap = reviewed?.snap || snapshot(), prepared = reviewed?.prepared || []
        for (const [index, target] of (reviewed ? [] : targets).entries()) {
          let item
          if (typeof target === 'string') {
            const alias = { '16:9': 'h264_hd', '1:1': 'h264_square_1080', '9:16': 'h264_vertical_1080' }[target]
            item = alias || target.startsWith('h264_') ? { target: alias || target } : { presetId: target }
          } else if (target && typeof target === 'object' && !Array.isArray(target)) item = target
          else throw new Error('Each batch target must be a preset/target ID or export settings object.')
          prepared.push(await prepare(snap, { ...payload, ...item,
            overrides: { ...(payload.overrides || {}), ...(item.overrides || {}) },
            filename: item.filename || `${payload.filenamePrefix || payload.filename || snap.info.name || 'Velorn'}_${index + 1}` }))
          checkCancelled()
        }
        if (new Set(prepared.map(item => item.plan.outputPath)).size !== prepared.length) throw new Error('Batch targets must have distinct output paths.')
        if (payload.previewOnly !== false) {
          const exportPlanToken = payload.exportPlanToken || rememberPreview('batch', payload, snap, prepared)
          return { previewOnly: true, context: snap.context, targets: prepared.map(item => clone(item.plan)), exportPlanToken,
            suggestedApplyPayload: { exportPlanToken } }
        }
        if (reviewed) {
          previews.delete(payload.exportPlanToken)
          await refreshPrepared(snap, prepared)
          checkCancelled()
        }
        assertContext(snap.context, 'export batch')
        if ((await api().getExportJobs()).activeJobId) throw new Error('Another export is already running. Wait before starting the batch.')
        checkCancelled()
        assertContext(snap.context, 'export batch')
        batch = { batchId: newId('mcp-batch'), context: snap.context, status: 'queued', processing: false,
          pauseRequested: false, cancelRequested: false, stopOnError: payload.stopOnError !== false, error: null,
          items: prepared.map(item => ({ prepared: item, plan: item.plan, jobId: null, status: 'queued', error: null })) }
        // Never evict live batches or retain unbounded authored snapshots.
        for (const [id, previous] of batches) if (terminal(previous.status) && batches.size >= 20) batches.delete(id)
        if (batches.size >= 20) throw new Error('Too many active export batches in this renderer session.')
        batches.set(batch.batchId, batch)
        handedOff = true
        void runBatch(batch, activity).catch(error => { batch.status = 'failed'; batch.error = error.message })
        return { started: true, ...publicBatch(batch) }
      } finally {
        if (!handedOff) activity?.end?.()
      }
    },
    async get_export_status(payload = {}) {
      const status = await api().getExportJobs()
      if (payload.jobId) {
        const job = status.jobs.find(entry => entry.jobId === payload.jobId)
        if (!job) throw new Error('Export job was not found in this app session.')
        return { job, activeJobId: status.activeJobId }
      }
      if (payload.batchId) {
        const batch = batches.get(payload.batchId)
        if (!batch) throw new Error('Batch was not found in this renderer session. Native jobs can still be listed.')
        return publicBatch(batch)
      }
      return { ...status, batches: [...batches.values()].map(publicBatch) }
    },
    async cancel_export(payload = {}) {
      if (!payload.jobId) throw new Error('An explicit export jobId is required; the current UI export will never be guessed.')
      const { job } = await actions.get_export_status(payload)
      if (job.owner !== 'mcp') throw new Error('UI exports cannot be cancelled by this MCP tool.')
      if (payload.previewOnly !== false) return { previewOnly: true, job, wouldCancel: !terminal(job.status) }
      return api().cancelExportJob(payload.jobId)
    },
    async control_export_batch(payload = {}) {
      const batch = batches.get(payload.batchId)
      if (!batch) throw new Error('Batch was not found in this renderer session.')
      if (!['pause', 'resume', 'cancel'].includes(payload.operation)) throw new Error('Batch operation must be pause, resume, or cancel.')
      if (payload.previewOnly !== false) return { previewOnly: true, operation: payload.operation, batch: publicBatch(batch) }
      if (terminal(batch.status)) throw new Error('This batch has already finished.')
      if (payload.operation === 'pause') batch.pauseRequested = true
      if (payload.operation === 'resume') {
        batch.pauseRequested = false
        void runBatch(batch).catch(error => { batch.status = 'failed'; batch.error = error.message })
      }
      if (payload.operation === 'cancel') {
        batch.cancelRequested = true
        const active = batch.items.find(item => item.status === 'running')
        if (active?.jobId) await api().cancelExportJob(active.jobId)
        if (!batch.processing) {
          batch.status = 'cancelled'
          for (const item of batch.items) if (item.status === 'queued') item.status = 'cancelled'
        }
      }
      return publicBatch(batch)
    },
    async inspect_export_file(payload = {}) {
      let filePath = payload.filePath || payload.path || payload.outputPath
      if (!filePath && payload.jobId) filePath = (await actions.get_export_status({ jobId: payload.jobId })).job.outputPath
      if (!filePath) {
        const projectPath = getProject().currentProjectHandle
        const jobs = (await api().getExportJobs()).jobs
        filePath = jobs.find(job => job.projectPath === projectPath && job.status === 'completed')?.outputPath
      }
      if (!filePath) throw new Error('Provide an absolute filePath or completed export jobId.')
      return api().inspectExportFileNative({ ...payload, filePath })
    },
  }
  function mutatePreset(type, payload) {
    assertContext(payload.expectedContext, 'export preset change')
    const presets = library().presets
    const preset = presets.find(entry => entry.id === payload.id)
    if (type !== 'save' && !preset) throw new Error('Custom export preset not found. Built-in presets are read-only.')
    if (type !== 'delete') requireSuccess(validateExportPresetName(payload.name, presets, type === 'rename' ? payload.id : null))
    const settings = type === 'save' ? requireSuccess(validateCustomExportPresetSettings(payload.settings)).settings : undefined
    if (payload.expectedPreset && JSON.stringify(payload.expectedPreset) !== JSON.stringify(preset)) throw new Error('The preset changed after preview. Preview again.')
    if (payload.previewOnly !== false) return { previewOnly: true, operation: type, before: preset || null, name: payload.name, settings,
      expectedPreset: preset || null, context: captureContext(), suggestedApplyPayload: preset ? { expectedPreset: preset } : {} }
    // Existing operation performs another storage read and exact target CAS.
    const result = requireSuccess(updateExportPresetLibrary({ type, id: payload.id, name: payload.name, settings, expected: preset }, storage))
    notifyPresets()
    return { updated: true, operation: type, ...result }
  }
  // This is a UI lifecycle hook, not an MCP action. Cancelling just the active
  // native job would let stopOnError:false batches immediately render the next
  // target. Mark the owning batch first, using the same public cancellation
  // path, including its startup-race handling. After a renderer reload the
  // session batch is gone; the UI can still cancel the orphaned native job.
  Object.defineProperty(actions, 'cancelBatchFromUi', {
    value: async (activeJob) => {
      if (activeJob?.owner !== 'mcp' || !activeJob?.batchId) return false
      const batch = batches.get(activeJob.batchId)
      if (!batch || terminal(batch.status)) return false
      await actions.control_export_batch({ batchId: batch.batchId, operation: 'cancel', previewOnly: false })
      return true
    },
  })
  return actions
}
