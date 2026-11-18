export const DISMISSED_RUNS_KEY = 'velorn-generation-dismissed-v1'
export const canDismissRun = job => ['done', 'error', 'cancelled'].includes(job?.status)
export const runVisibilityKey = job => JSON.stringify([job.projectKey || '', job.endpoint || '', job.runId || job.id])
export const isRunDismissed = (job, keys) => canDismissRun(job) && keys.includes(runVisibilityKey(job))
export function readDismissedRuns(storage) {
  try {
    const data = JSON.parse(storage.getItem(DISMISSED_RUNS_KEY) || '[]')
    return Array.isArray(data) ? data.filter(key => typeof key === 'string').slice(-5000) : []
  } catch { return [] }
}
export function updateDismissedRuns(keys, jobs, dismiss = true) {
  const result = new Set(keys)
  for (const job of jobs) {
    if (dismiss && canDismissRun(job)) result.add(runVisibilityKey(job))
    else if (!dismiss) result.delete(runVisibilityKey(job))
  }
  return [...result].slice(-5000)
}
export function runTimestamp(job, now = new Date(), locale) {
  const value = job.startedAt || job.createdAt
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const day = date.toDateString() === now.toDateString() ? 'Today' : date.toLocaleDateString(locale, {
    month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  return { iso: date.toISOString(), label: `${day}, ${time}`, title: `${job.startedAt ? 'Started' : 'Created'}: ${date.toLocaleString(locale)}` }
}
