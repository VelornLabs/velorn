const path = require('path')
const { Worker } = require('worker_threads')
const { AUDIO_ANALYSIS_LIMITS, resolveAudioAnalysisSources, normalizeAudioAnalysisOptions } = require('./audioAnalysisCore.cjs')

function failure(code, error) { return { success: false, code, error } }

function createAudioAnalysisService({
  ffmpegPath,
  ffprobePath,
  workerPath = path.join(__dirname, 'audioAnalysisWorker.cjs'),
  dspPath = path.join(__dirname, '..', 'src', 'utils', 'audioAnalysisDsp.mjs'),
  jobTimeoutMs = AUDIO_ANALYSIS_LIMITS.jobTimeoutMs,
  WorkerClass = Worker,
  killProcess = (pid) => process.kill(pid, 'SIGKILL'),
} = {}) {
  let active = null

  function analyze(request = {}, owner) {
    if (active) return Promise.resolve(failure('AUDIO_ANALYSIS_BUSY', 'Audio analysis is already running. Wait for it to finish and try again.'))
    let inputPaths
    let options
    try {
      inputPaths = resolveAudioAnalysisSources(request?.source)
      options = normalizeAudioAnalysisOptions(request?.options)
    } catch (error) {
      return Promise.resolve(failure(error.code || 'AUDIO_ANALYSIS_INVALID_REQUEST', error.message))
    }
    if (owner?.isDestroyed?.()) return Promise.resolve(failure('AUDIO_ANALYSIS_CANCELLED', 'The audio analysis window has closed.'))
    return new Promise((resolve) => {
      const job = { ownerId: owner?.id, worker: null, pids: new Set(), cancelled: null, finishing: false, timer: null, cancelTimer: null }
      active = job
      const killChildren = () => {
        for (const pid of job.pids) { try { killProcess(pid) } catch { /* Already exited. */ } }
      }
      const finish = (result) => {
        if (job.finishing) return
        job.finishing = true
        clearTimeout(job.timer)
        clearTimeout(job.cancelTimer)
        owner?.removeListener?.('destroyed', ownerClosed)
        owner?.removeListener?.('render-process-gone', ownerClosed)
        killChildren()
        // Keep the busy slot until worker teardown finishes, including timeout
        // or cancellation; repeated clicks can never overlap native decoders.
        const terminated = job.worker ? job.worker.terminate() : undefined
        Promise.resolve(terminated).catch(() => {}).finally(() => {
          if (active === job) active = null
          resolve(job.cancelled || result)
        })
      }
      job.cancel = (result = failure('AUDIO_ANALYSIS_CANCELLED', 'Audio analysis was cancelled.')) => {
        if (job.finishing || job.cancelled) return
        job.cancelled = result
        try { job.worker?.postMessage({ type: 'cancel' }) } catch { /* Worker exited. */ }
        killChildren()
        // Let the worker observe cancellation and reap FFmpeg first. The main
        // thread still owns a hard fallback if the worker is in synchronous DSP.
        job.cancelTimer = setTimeout(() => finish(result), 500)
      }
      const ownerClosed = () => job.cancel()
      owner?.once?.('destroyed', ownerClosed)
      owner?.once?.('render-process-gone', ownerClosed)
      job.timer = setTimeout(() => job.cancel(failure('AUDIO_ANALYSIS_TIMEOUT', 'Audio analysis timed out. Try a shorter range.')), jobTimeoutMs)
      try {
        job.worker = new WorkerClass(workerPath, {
          workerData: { inputPaths, options, ffmpegPath, ffprobePath, dspPath },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
        })
        job.worker.on('message', (message) => {
          if (message?.type === 'child-start' && Number.isSafeInteger(message.pid) && message.pid > 0) {
            job.pids.add(message.pid)
            if (job.cancelled || job.finishing) killChildren()
          } else if (message?.type === 'child-end') {
            job.pids.delete(message.pid)
          } else if (message?.type === 'result') {
            finish(message.result?.success === true && message.result.analysis
              ? message.result : failure(message.result?.code || 'AUDIO_ANALYSIS_FAILED', message.result?.error || 'Audio analysis failed.'))
          }
        })
        job.worker.once('error', (error) => finish(failure('AUDIO_ANALYSIS_WORKER_FAILED', `Audio analysis failed: ${error.message}`)))
        job.worker.once('exit', (code) => finish(failure('AUDIO_ANALYSIS_WORKER_FAILED', `Audio analysis stopped unexpectedly (code ${code}).`)))
      } catch (error) {
        finish(failure('AUDIO_ANALYSIS_WORKER_FAILED', `Could not start audio analysis: ${error.message}`))
      }
    })
  }

  return {
    analyze,
    cancelOwner(ownerId) { if (active?.ownerId === ownerId) active.cancel() },
    cancelAll() { active?.cancel() },
  }
}

function registerAudioAnalysisHandlers({ ipcMain, app, ...options }) {
  const service = createAudioAnalysisService(options)
  ipcMain.handle('media:analyzeAudio', (event, request) => service.analyze(request, event.sender))
  app?.on('will-quit', () => service.cancelAll())
  return service
}

module.exports = { createAudioAnalysisService, registerAudioAnalysisHandlers }
