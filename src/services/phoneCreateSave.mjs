// Saves pictures and clips that were made from the paired phone into the open
// project as soon as they are finished, so nobody has to open the Create tab
// within the 24 hours Comfy keeps a result. Nothing here sends or repeats a
// request: it only collects a finished result, once, through the same import
// the Create tab uses.
import { RESULT_KEPT_MS } from './createFlow.mjs'

const KINDS = ['image', 'video']

// Finished phone requests of the open project that the project does not hold yet. Oldest first.
export function phoneJobsToSave(jobs, now) {
  if (!Array.isArray(jobs)) return []
  return jobs.filter(job => job?.create === true && job.fromPhone === true && KINDS.includes(job.kind)
    && job.status === 'COMPLETED' && !job.importedAssetId && !job.needsReconnect && typeof job.jobId === 'string'
    && Number.isFinite(job.createdAt) && now - job.createdAt >= 0 && now - job.createdAt < RESULT_KEPT_MS)
    .sort((a, b) => a.createdAt - b.createdAt)
}

// Phone requests Comfy has not finished yet. The phone page asks about them
// while its Create panel is open, but a phone can be locked or put away, so the
// computer keeps asking too. Asking is free and never sends a request again.
export function phoneJobsToFollow(jobs, now) {
  if (!Array.isArray(jobs)) return []
  return jobs.filter(job => job?.create === true && job.fromPhone === true && KINDS.includes(job.kind)
    && (job.status === 'IN_QUEUE' || job.status === 'IN_PROGRESS') && job.canRefresh && !job.needsReconnect && typeof job.jobId === 'string'
    && Number.isFinite(job.createdAt) && now - job.createdAt >= 0 && now - job.createdAt < RESULT_KEPT_MS)
    .sort((a, b) => a.createdAt - b.createdAt)
}

// `run()` may be called as often as anything changes. It resolves to how many
// phone requests are still being made, so the caller can look again sooner. One pass runs at a time;
// a result that cannot be saved is tried a few more times, spaced out, and then left
// for the Create tab or the person.
export function createPhoneCreateSaver({ getApi, importJob, now = Date.now, maxAttempts = 3, retryMs = 60000 }) {
  const attempts = new Map()
  let running = false, again = false, following = 0
  return async function run() {
    if (running) { again = true; return following }
    running = true
    try {
      do {
        again = false
        const api = getApi()
        if (!api?.list) return following
        let listed = await api.list({})
        if (!listed?.success) return following
        const unfinished = phoneJobsToFollow(listed.jobs, now()).slice(0, 4)
        if (unfinished.length && api.refresh) {
          for (const job of unfinished) if (!(job.retryAfterMs > 0)) { try { await api.refresh({ jobId: job.jobId }) } catch { /* Asked again on the next pass. */ } }
          const fresh = await api.list({})
          if (fresh?.success) listed = fresh
        }
        following = phoneJobsToFollow(listed.jobs, now()).length
        for (const job of phoneJobsToSave(listed.jobs, now())) {
          const tried = attempts.get(job.jobId) || { count: 0, at: 0 }
          if (tried.count >= maxAttempts || (tried.count > 0 && now() - tried.at < retryMs)) continue
          attempts.set(job.jobId, { count: tried.count + 1, at: now() })
          let saved
          try { saved = await importJob(job.jobId) } catch { saved = null }
          if (saved?.success === true) attempts.delete(job.jobId)
        }
      } while (again)
    } catch { /* The next change or tick tries again. */ }
    finally { running = false }
    return following
  }
}
