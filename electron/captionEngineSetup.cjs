'use strict'

const { randomUUID, createHash } = require('node:crypto')
const { WHISPER_MODELS, ENGINE_BINARY_DOWNLOADS, MODEL_BASE_URL, VAD_MODEL_URL } = require('./captionWhisper.js')
const modelIds = Object.keys(WHISPER_MODELS)
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code, error) => ({ success: false, code, error })

// Device-local setup only. No model-selected URL, path, executable or shell command.
// Jobs are session-only and never resumed/retried automatically after restart.
function createCaptionEngineSetup({ service, platform = process.platform, arch = process.arch,
  confirmInstall = async () => false, assertCurrent = async () => {}, now = Date.now }) {
  const previews = new Map(), jobs = new Map()
  let active = null
  function plan(modelId) {
    const status = service.getStatus()
    const binary = ENGINE_BINARY_DOWNLOADS[platform]
    const supported = Boolean(status.binaryPath || (binary && (arch === 'x64' || (platform === 'darwin' && arch === 'arm64'))))
    const installed = (status.models || []).some(model => model.id === modelId)
    const downloads = []
    if (!status.binaryPath && binary) downloads.push({ kind: 'engine', url: binary.url, approxBytes: binary.approxBytes })
    if (!installed) downloads.push({ kind: 'model', url: MODEL_BASE_URL + WHISPER_MODELS[modelId].file,
      approxBytes: WHISPER_MODELS[modelId].approxMB * 1000000 })
    if (!status.vadModelInstalled) downloads.push({ kind: 'speech-detector', url: VAD_MODEL_URL, approxBytes: null, optional: true })
    return { modelId, label: WHISPER_MODELS[modelId].label, platform, arch, supported,
      engineInstalled: Boolean(status.binaryPath), modelInstalled: installed,
      ready: Boolean(status.binaryPath && installed), downloads,
      knownApproxDownloadBytes: downloads.reduce((sum, item) => sum + (item.approxBytes || 0), 0),
      hasUnknownDownloadSize: downloads.some(item => item.approxBytes === null),
      destination: 'Velorn application data / caption-engine (not ComfyUI or the project)',
      note: 'Sizes are estimates; optional speech-detector size and unpacked disk usage are not included. Installation does not select a UI preference or start transcription.',
      busy: Boolean(status.installInFlight || status.transcribeInFlight) }
  }
  function status(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['jobId', 'modelId'].includes(key))) return fail('CAPTION_SETUP_ARGUMENTS', 'Use only modelId or jobId.')
    const modelId = args.modelId ?? jobs.get(args.jobId)?.modelId ?? 'base'
    if (!modelIds.includes(modelId)) return fail('CAPTION_SETUP_MODEL', 'Choose an available caption model ID.')
    if (args.jobId !== undefined && (typeof args.jobId !== 'string' || !jobs.has(args.jobId))) return fail('CAPTION_SETUP_UNKNOWN_JOB', 'This install job is unknown in this app session. Inspect installed models; do not assume success or retry automatically.')
    const current = service.getStatus()
    return { success: true, ...plan(modelId),
      availableModels: modelIds.map(id => ({ id, label: WHISPER_MODELS[id].label, approxMB: WHISPER_MODELS[id].approxMB,
        installed: (current.models || []).some(model => model.id === id) })),
      job: args.jobId ? { ...jobs.get(args.jobId) } : active ? { ...jobs.get(active) } : null,
      jobs: [...jobs.values()].slice(-10).map(job => ({ ...job })),
      sessionOnly: true, pollWith: 'get_caption_engine_status' }
  }
  async function install(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['modelId', 'previewOnly', 'previewToken', 'expectedContext'].includes(key))
      || (args.previewOnly !== undefined && typeof args.previewOnly !== 'boolean')) return fail('CAPTION_SETUP_ARGUMENTS', 'Invalid caption setup arguments.')
    const modelId = args.modelId ?? 'base'
    if (!modelIds.includes(modelId)) return fail('CAPTION_SETUP_MODEL', 'Choose an available caption model ID.')
    const detail = plan(modelId)
    if (!detail.supported) return fail('CAPTION_SETUP_UNSUPPORTED', 'No compatible pinned caption engine download is available for this platform/architecture.')
    if (args.previewOnly !== false) {
      for (const [key, value] of previews) if (value.expires < now()) previews.delete(key)
      while (previews.size >= 20) previews.delete(previews.keys().next().value)
      const previewToken = randomUUID()
      previews.set(previewToken, { fingerprint: fingerprint(detail), expires: now() + 5 * 60000 })
      return { success: true, previewOnly: true, plan: detail,
        warnings: ['Downloads engine/model files to this device. Disk installation is not undoable through timeline Undo.', 'A native confirmation is required before downloading. Existing files are reused.'],
        suggestedApplyPayload: { modelId, previewOnly: false, previewToken }, pollWith: 'get_caption_engine_status' }
    }
    const preview = previews.get(args.previewToken)
    if (!preview || preview.expires < now() || preview.fingerprint !== fingerprint(detail)) return fail('CAPTION_SETUP_STALE', 'Preview caption setup again: the plan expired or installed files/state changed.')
    previews.delete(args.previewToken)
    if (active || detail.busy) return fail('CAPTION_SETUP_BUSY', 'Caption installation or transcription is already running. Poll status first.')
    if (!detail.downloads.length) return { success: true, ready: true, modelId, message: 'Already installed. No download or transcription started.' }
    const jobId = `caption-install-${randomUUID()}`
    active = jobId
    const job = { jobId, modelId, state: 'awaiting-confirmation', phase: 'confirmation', percent: null, startedAt: now() }
    jobs.set(jobId, job)
    while (jobs.size > 20) jobs.delete(jobs.keys().next().value)
    // Return a receipt immediately: downloads and even human confirmation may
    // outlive MCP's per-call deadline. Read polling never starts/retries work.
    Promise.resolve().then(async () => {
      let unsubscribe
      try {
        await assertCurrent()
        if (!await confirmInstall(detail)) { job.state = 'declined'; job.phase = 'declined'; return }
        await assertCurrent()
        if (fingerprint(plan(modelId)) !== preview.fingerprint) throw new Error('Plan changed during confirmation; preview again.')
        job.state = 'running'; job.phase = 'install'
        unsubscribe = service.onProgress?.(event => {
          job.phase = ['download-binary', 'extract', 'download-model', 'download-vad', 'done', 'error'].includes(event.phase) ? event.phase : 'install'
          job.percent = Number.isFinite(event.percent) ? Math.max(0, Math.min(100, event.percent)) : null
          for (const key of ['receivedBytes', 'totalBytes']) if (Number.isFinite(event[key]) && event[key] >= 0) job[key] = event[key]
        })
        const result = await service.install({ modelId })
        const verified = plan(modelId)
        if (result?.success !== true || !verified.ready) throw new Error('Install failed or required files are still missing.')
        job.state = 'completed'; job.phase = 'done'; job.percent = 100
        job.note = 'Engine and selected model are present. Continue with transcribe_captions using this modelId; transcription verifies runtime execution.'
        if (verified.downloads.some(item => item.kind === 'speech-detector')) job.note += ' Optional speech detector was not installed.'
      } catch {
        job.state = 'failed'; job.phase = 'error'
        job.error = 'Caption setup could not finish or its authorization/context changed. Inspect engine status and the caption setup UI before explicitly retrying.'
      } finally { unsubscribe?.(); job.finishedAt = now(); active = null }
    })
    return { success: true, jobId, modelId, state: job.state, pollWith: 'get_caption_engine_status',
      note: 'Wait for completed status before transcription. Closing chat does not undo already approved downloads. App restart loses this job receipt; inspect installed files then.' }
  }
  return { status, install }
}
module.exports = { createCaptionEngineSetup }
