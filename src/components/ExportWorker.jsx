import { useEffect, useRef } from 'react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import exportTimeline from '../services/exporter'
import { runRtxVideoUpscale } from '../services/rtxVideoUpscale'

const isElectron = () => typeof window !== 'undefined' && window.electronAPI != null

export default function ExportWorker() {
  const started = useRef(false)

  useEffect(() => {
    if (!isElectron() || !window.electronAPI.onExportJob || started.current) return
    started.current = true

    window.electronAPI.onExportJob(async (job) => {
      const { projectPath, outputPath, options, postProcess, state: jobState } = job
      console.log('[ExportWorker] Job received', { projectPath: !!projectPath, outputPath: !!outputPath, assetsCount: jobState?.assets?.length, clipsCount: jobState?.timeline?.clips?.length })
      if (!projectPath || !outputPath || !jobState) {
        window.electronAPI.sendExportError?.('Invalid export job')
        return
      }

      try {
        const assetsWithUrls = []
        for (const asset of jobState.assets || []) {
          let url = asset.url
          if (asset.path && window.electronAPI.pathJoin && window.electronAPI.getFileUrlDirect) {
            try {
              const filePath = await window.electronAPI.pathJoin(projectPath, asset.path)
              url = await window.electronAPI.getFileUrlDirect(filePath)
            } catch (e) {
              console.warn('[ExportWorker] Could not resolve file URL for', asset.name, e)
            }
          }
          assetsWithUrls.push({ ...asset, url: url || asset.url })
        }
        console.log('[ExportWorker] Resolved assets', assetsWithUrls.filter(a => a.url).length, '/', assetsWithUrls.length)

        useProjectStore.setState({ currentProjectHandle: projectPath })
        useTimelineStore.setState((prev) => ({
          ...prev,
          clips: jobState.timeline?.clips ?? prev.clips,
          tracks: jobState.timeline?.tracks ?? prev.tracks,
          transitions: jobState.timeline?.transitions ?? prev.transitions,
        }))
        useAssetsStore.setState((prev) => ({
          ...prev,
          assets: assetsWithUrls.length > 0 ? assetsWithUrls : prev.assets,
        }))

        console.log('[ExportWorker] Starting exportTimeline', { outputPath, width: options?.width, height: options?.height, fps: options?.fps })
        const abortController = new AbortController()
        window.electronAPI.onExportCancel?.(() => {
          console.log('[ExportWorker] Cancel requested; aborting export')
          abortController.abort()
        })
        const result = await exportTimeline(
          { ...options, outputPath, signal: abortController.signal },
          (progress) => {
            if (progress?.progress % 20 < 5) console.log('[ExportWorker] Progress', progress?.progress, progress?.status)
            if (postProcess?.type === 'rtx-4k') {
              window.electronAPI.sendExportProgress?.({
                ...progress,
                progress: typeof progress?.progress === 'number' ? progress.progress * 0.6 : progress?.progress,
                status: `Source render - ${progress?.status || 'Rendering timeline'}`,
              })
            } else {
              window.electronAPI.sendExportProgress?.(progress)
            }
          },
          { offscreen: true }
        )
        let finalResult = result
        if (postProcess?.type === 'rtx-4k') {
          let upscaleComplete = false
          try {
            console.log('[ExportWorker] Starting direct RTX 4K post-process', {
              sourcePath: outputPath,
              finalPath: postProcess.outputPath,
              quality: postProcess.quality,
            })
            const upscaleResult = await runRtxVideoUpscale({
              inputPath: outputPath,
              outputPath: postProcess.outputPath,
              sourceWidth: postProcess.sourceWidth || options?.width,
              sourceHeight: postProcess.sourceHeight || options?.height,
              videoCodec: postProcess.videoCodec || options?.videoCodec,
              quality: postProcess.quality,
              signal: abortController.signal,
              onStatus: (status) => {
                window.electronAPI.sendExportProgress?.({
                  frame: status?.frame,
                  totalFrames: status?.totalFrames,
                  etaSeconds: status?.etaSeconds,
                  progress: 60 + ((Number(status?.progress) || 0) * 0.4),
                  status: status?.statusMessage || 'Running direct NVIDIA RTX 4K upscale...',
                })
              },
            })
            upscaleComplete = true
            finalResult = {
              ...result,
              ...upscaleResult,
              outputPath: postProcess.outputPath,
              sourceExport: result,
              encoderUsed: `${result?.encoderUsed || 'timeline export'} + NVIDIA RTX Video Super Resolution`,
            }
          } catch (error) {
            if (abortController.signal.aborted || error?.name === 'AbortError') throw error
            throw new Error(`${error?.message || 'RTX upscale failed'} The normal source render was kept at ${outputPath}.`)
          } finally {
            if ((upscaleComplete || abortController.signal.aborted) && window.electronAPI?.deleteFile) {
              const cleanup = await window.electronAPI.deleteFile(outputPath).catch(() => null)
              if (cleanup?.success === false) {
                console.warn('[ExportWorker] Could not delete RTX source render', cleanup.error)
              }
            }
          }
        }
        // Stringify: the worker's console reaches export-worker.log via the
        // console-message event, which flattens objects to "[object Object]".
        console.log('[ExportWorker] Export complete', JSON.stringify(finalResult))
        window.electronAPI.sendExportComplete?.(finalResult)
      } catch (err) {
        const errMsg = err && typeof err === 'object' && err instanceof Event
          ? `Export error (${err.type}): ${err.target?.error?.message || err.target?.statusText || 'see console'}`
          : (err?.message || (typeof err === 'string' ? err : String(err)))
        console.error('[ExportWorker] Export failed', err, errMsg)
        window.electronAPI.sendExportError?.(errMsg)
      }
    })
    window.electronAPI.sendExportWorkerReady?.()
  }, [])

  return null
}
