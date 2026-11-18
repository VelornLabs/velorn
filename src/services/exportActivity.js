import useExportActivityStore, { isExportBusy, receiveExportActivity } from '../stores/exportActivityStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import videoCache from './videoCache'

// Start before other application keyboard handlers. Blocking pointer input alone
// does not block the window/document shortcuts or a held J/K/L transport key.
export function startExportActivityBridge({ api = globalThis.window?.electronAPI, windowTarget = globalThis.window,
  documentTarget = globalThis.document } = {}) {
  let disposed = false
  let wasBusy = false
  const pausePlayback = () => {
    if (!isExportBusy()) return
    if (!wasBusy) {
      wasBusy = true
      // Canvas preview uses detached pooled videos, absent from the DOM query.
      // Pause them before transport updates can unmount the preview and skip
      // its passive pause effect. Keep the cache; never auto-resume on exit.
      videoCache.pauseAll()
      // Thumbnail and workflow-card videos don't use either transport store.
      // Pause these too; do not resume them automatically after export.
      for (const media of documentTarget?.querySelectorAll?.('video, audio') || []) media.pause?.()
    }
    const timeline = useTimelineStore.getState()
    if (timeline.isPlaying || timeline.shuttleMode || timeline.playAround) timeline.shuttlePause?.()
    const assets = useAssetsStore.getState()
    if (assets.isPlaying) assets.setIsPlaying(false)
  }
  const removeState = useExportActivityStore.subscribe(() => {
    if (!isExportBusy()) wasBusy = false
    pausePlayback()
  })
  const removeTimeline = useTimelineStore.subscribe(pausePlayback)
  const removeAssets = useAssetsStore.subscribe(pausePlayback)
  const removeNative = api?.onExportActivity?.(snapshot => { if (!disposed) receiveExportActivity(snapshot) })
  // Subscribe before reading: a slower initial read must not overwrite a newer
  // begin/completion event. Monotonic revisions make both orders safe.
  Promise.resolve(api?.getExportActivity?.()).then(snapshot => {
    if (!disposed && snapshot) receiveExportActivity(snapshot)
  }).catch(error => console.warn('[Export] Could not restore export activity:', error))
  const blockShortcut = event => {
    if (!isExportBusy()) return
    // Buttons in the progress dialog/window controls retain native keyboard
    // activation. Stop propagation before editor window/document listeners.
    const allowed = event.target?.closest?.('[data-export-allowed="true"]')
    const activation = allowed && ['Tab', 'Enter', ' ', 'Spacebar'].includes(event.key)
    event.stopImmediatePropagation()
    if (!activation) event.preventDefault()
  }
  windowTarget?.addEventListener('keydown', blockShortcut, true)
  windowTarget?.addEventListener('keyup', blockShortcut, true)
  const blockInteraction = event => {
    if (!isExportBusy() || event.target?.closest?.('[data-export-allowed="true"]')) return
    event.stopImmediatePropagation()
    event.preventDefault()
  }
  const blockedEvents = ['pointerdown', 'click', 'dblclick', 'contextmenu', 'wheel', 'drop', 'dragover']
  for (const name of blockedEvents) windowTarget?.addEventListener(name, blockInteraction, { capture: true, passive: false })
  const pauseMedia = event => { if (isExportBusy()) event.target?.pause?.() }
  windowTarget?.addEventListener('play', pauseMedia, true)
  pausePlayback()
  return () => {
    disposed = true
    removeNative?.(); removeState(); removeTimeline(); removeAssets()
    windowTarget?.removeEventListener('keydown', blockShortcut, true)
    windowTarget?.removeEventListener('keyup', blockShortcut, true)
    for (const name of blockedEvents) windowTarget?.removeEventListener(name, blockInteraction, true)
    windowTarget?.removeEventListener('play', pauseMedia, true)
  }
}
