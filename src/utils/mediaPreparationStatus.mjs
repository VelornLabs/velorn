const count = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

// Labels originate in native work; never reveal an absolute path in this surface.
const fileLabel = (value) => typeof value === 'string'
  ? value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'Media file'
  : 'Media file'

function readSnapshot(snapshot) {
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs.filter((job) => job && typeof job === 'object') : []
  return {
    jobs,
    activeCount: count(snapshot?.activeCount, jobs.filter((job) => job.status === 'encoding').length),
    queuedCount: count(snapshot?.queuedCount, jobs.filter((job) => job.status === 'queued').length),
    total: count(snapshot?.total),
    completed: count(snapshot?.completed),
    failed: count(snapshot?.failed),
    cancelledCount: count(snapshot?.cancelledCount),
  }
}

const countersReset = (previous, next) => previous && ['total', 'completed', 'failed', 'cancelledCount']
  .some((key) => next[key] < previous[key])

const emptyBaseline = () => ({ completed: 0, failed: 0, cancelledCount: 0 })

export function createMediaPreparationStatusState() {
  return { snapshot: null, baseline: emptyBaseline(), view: null, summaryId: 0 }
}

export function updateMediaPreparationStatus(state, rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') return state
  const snapshot = readSnapshot(rawSnapshot)
  const busy = snapshot.activeCount + snapshot.queuedCount > 0
  const wasBusy = state.view?.mode === 'busy'
  let baseline = state.baseline
  if (countersReset(state.snapshot, snapshot)) baseline = emptyBaseline()
  else if (busy && !wasBusy) baseline = state.snapshot || emptyBaseline()
  const failed = Math.max(0, snapshot.failed - baseline.failed)

  if (busy) {
    const active = snapshot.jobs.find((job) => job.status === 'encoding')
    const current = active || snapshot.jobs.find((job) => job.status === 'queued')
    const progress = active && Number.isFinite(active.progress) ? Math.max(0, Math.min(1, active.progress)) : null
    const processor = snapshot.activeCount === 0 ? null
      : !active?.encoder ? 'Checking hardware'
        : active.hardware === true ? 'GPU' : active.hardware === false ? 'CPU' : 'Checking hardware'
    const processorDescription = processor === 'GPU'
      ? 'Using hardware-accelerated encoding.'
      : processor === 'CPU'
        ? active.fallbackReason
          ? 'Hardware encoding was unavailable or could not finish. Continuing with the CPU; original media is unchanged.'
          : 'Using CPU encoding; original media is unchanged.'
        : 'Checking which encoder is available for this media.'
    const counts = [
      snapshot.activeCount > 0 && `${snapshot.activeCount} active`,
      snapshot.queuedCount > 0 && `${snapshot.queuedCount} queued`,
    ].filter(Boolean).join(' · ')
    return {
      snapshot, baseline, summaryId: state.summaryId,
      view: {
        mode: 'busy',
        title: current?.kind === 'proxy' ? 'Creating proxies' : 'Optimizing playback',
        label: current ? fileLabel(current.label) : 'Preparing media',
        counts, processor, processorDescription, progress,
        failureNote: failed > 0 ? `${failed} failed. Originals remain available for editing.` : null,
      },
    }
  }

  if (!wasBusy) return { ...state, snapshot }
  const completed = Math.max(0, snapshot.completed - baseline.completed)
  const cancelled = Math.max(0, snapshot.cancelledCount - baseline.cancelledCount)
  const view = failed > 0
    ? { mode: 'summary', tone: 'warning', title: 'Some media could not be prepared', detail: `${failed} failed. Originals remain available for editing.` }
    : completed > 0
      ? { mode: 'summary', tone: 'success', title: 'Media preparation complete', detail: cancelled > 0 ? 'Remaining jobs stopped; originals are unchanged.' : 'Prepared media is ready for playback.' }
      : { mode: 'summary', tone: 'neutral', title: 'Media preparation stopped', detail: 'Originals remain available for editing.' }
  return { snapshot, baseline, view, summaryId: state.summaryId + 1 }
}

export function dismissMediaPreparationSummary(state, summaryId) {
  return state.view?.mode === 'summary' && state.summaryId === summaryId ? { ...state, view: null } : state
}

// Subscribe before requesting the snapshot. A slower initial response must not
// replace a newer live update, and neither source may update an unmounted panel.
export function subscribeToMediaPreparationStatus(api, onSnapshot) {
  let disposed = false
  let receivedEvent = false
  const unsubscribe = api?.onMediaPreparationStatus?.((snapshot) => {
    if (disposed) return
    receivedEvent = true
    onSnapshot(snapshot)
  })
  try {
    Promise.resolve(api?.getMediaPreparationStatus?.()).then((snapshot) => {
      if (!disposed && !receivedEvent && snapshot) onSnapshot(snapshot)
    }).catch(() => {})
  } catch (_) {
    // Older/browser-only bridges may not support the initial status request.
  }
  return () => {
    disposed = true
    if (typeof unsubscribe === 'function') unsubscribe()
  }
}
