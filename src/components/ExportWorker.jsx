import { useEffect, useRef } from 'react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import exportTimeline from '../services/exporter'

const isElectron = () => typeof window !== 'undefined' && window.electronAPI != null

export default function ExportWorker() {
  const started = useRef(false)

  useEffect(() => {
    if (!isElectron() || !window.electronAPI.onExportJob || started.current) return
    started.current = true

    window.electronAPI.onExportJob(async (job) => {
      const { projectPath, outputPath, options, state: jobState } = job
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
          selectedClipIds: jobState.timeline?.selectedClipIds ?? prev.selectedClipIds,
        }))
        useAssetsStore.setState((prev) => ({
          ...prev,
          assets: assetsWithUrls.length > 0 ? assetsWithUrls : prev.assets,
        }))

        console.log('[ExportWorker] Starting exportTimeline', { outputPath, width: options?.width, height: options?.height, fps: options?.fps })
        const result = await exportTimeline(
          { ...options, outputPath },
          (progress) => {
            if (progress?.progress % 20 < 5) console.log('[ExportWorker] Progress', progress?.progress, progress?.status)
            window.electronAPI.sendExportProgress?.(progress)
          }
        )
        console.log('[ExportWorker] Export complete', result)
        window.electronAPI.sendExportComplete?.(result)
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
