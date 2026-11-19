// In-memory native authority: terminal state survives renderer reloads. Never
// infer ownership from whichever export happens to be running at the moment.
class ExportJobRegistry {
  constructor({ limit = 100, now = () => new Date().toISOString(), onChange = () => {}, onCompleted = () => {} } = {}) {
    this.jobs = new Map()
    this.batchOrigins = new Map()
    this.activeId = null
    this.limit = limit
    this.now = now
    this.revision = 0
    this.onChange = onChange
    this.onCompleted = onCompleted
  }
  // Publish only the active job, never the (potentially large) retained history.
  // Monotonic revisions let renderer rehydration ignore an older IPC reply that
  // arrives after a newer live update. Notification failure cannot strand a job.
  activity() { return { revision: this.revision, activeJob: this.get(this.activeId) } }
  publishActivity() {
    this.revision += 1
    try { this.onChange(this.activity()) } catch { /* getter rehydrates after renderer teardown */ }
  }
  begin({ jobId, owner = 'ui', senderId, projectPath, outputPath, batchId = null }) {
    if (this.activeId) throw new Error('Export already in progress')
    if (this.jobs.has(jobId)) throw new Error('Export job ID has already been used')
    const job = { jobId, owner: owner === 'mcp' ? 'mcp' : 'ui', senderId,
      projectPath, outputPath, batchId, status: 'running', progress: null,
      startedAt: this.now(), finishedAt: null, result: null, error: null }
    if (job.owner === 'mcp' && this.batchOrigins.has(batchId)) job.origin = this.batchOrigins.get(batchId)
    this.jobs.set(jobId, job)
    this.activeId = jobId
    while (this.jobs.size > this.limit) this.jobs.delete(this.jobs.keys().next().value)
    this.publishActivity()
    return this.get(jobId)
  }
  progress(jobId, progress) {
    const job = this.jobs.get(jobId)
    if (!job || this.activeId !== jobId || !['running', 'cancelling'].includes(job.status)) return false
    job.progress = structuredClone(progress)
    this.publishActivity()
    return true
  }
  finish(jobId, { result, error } = {}) {
    const job = this.jobs.get(jobId)
    if (!job || !['running', 'cancelling'].includes(job.status)) return false
    const message = error == null ? null : String(error?.message || error)
    job.status = message ? (/^(export|rtx upscale) cancelled$/i.test(message.trim()) ? 'cancelled' : 'failed') : 'completed'
    job.error = message
    job.result = result ?? null
    job.finishedAt = this.now()
    if (job.status === 'completed') this.persistCompleted(job)
    if (this.activeId === jobId) this.activeId = null
    this.publishActivity()
    return true
  }
  requestCancel(jobId, senderId) {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Export job was not found')
    if (job.owner !== 'mcp' || job.senderId !== senderId) throw new Error('This export is not owned by this MCP session; it cannot be cancelled here')
    if (!['running', 'cancelling'].includes(job.status)) return { cancelRequested: false, job: this.get(jobId) }
    if (this.activeId !== jobId) throw new Error('The active export does not match this job')
    if (job.status !== 'cancelling') {
      job.status = 'cancelling'
      this.publishActivity()
    }
    return { cancelRequested: true, job: this.get(jobId) }
  }
  // The native main-window UI may cancel either a UI or MCP export. Caller
  // authorization belongs to the IPC handler; agent cancellation above keeps
  // its stricter job-and-session ownership check.
  requestCancelActive() {
    const job = this.jobs.get(this.activeId)
    if (!job || !['running', 'cancelling'].includes(job.status)) return { cancelRequested: false, job: null }
    if (job.status !== 'cancelling') {
      job.status = 'cancelling'
      this.publishActivity()
    }
    return { cancelRequested: true, job: this.get(job.jobId) }
  }
  get(jobId) {
    const job = this.jobs.get(jobId)
    return job ? structuredClone(job) : null
  }
  list() { return [...this.jobs.keys()].reverse().map(id => this.get(id)) }
  persistCompleted(job) {
    // Storage failure must not undo a successful export or strand its worker.
    try { Promise.resolve(this.onCompleted(structuredClone(job))).catch(() => {}) } catch {}
  }
  // Called only by the native connected-agent dispatcher, never from tool
  // arguments or status queries. Existing exports cannot be claimed later.
  associateAgentResult(name, result, origin) {
    if (!['export_timeline', 'export_delivery_batch'].includes(name) || result?.isError
      || !origin || ![origin.chatId, origin.turnId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id))) return
    let value
    try { value = JSON.parse(result.content.find(item => item.type === 'text').text) } catch { return }
    if (!value || value.success === false || value.previewOnly === true) return
    value = value.result || value
    if (value.started !== true || value.previewOnly === true) return
    const safeOrigin = { chatId: origin.chatId, turnId: origin.turnId }
    if (name === 'export_delivery_batch' && typeof value.batchId === 'string') {
      if (!this.batchOrigins.has(value.batchId)) this.batchOrigins.set(value.batchId, safeOrigin)
      while (this.batchOrigins.size > this.limit) this.batchOrigins.delete(this.batchOrigins.keys().next().value)
      for (const job of this.jobs.values()) if (job.owner === 'mcp' && job.batchId === value.batchId && !job.origin) {
        job.origin = this.batchOrigins.get(value.batchId)
        if (job.status === 'completed') this.persistCompleted(job)
      }
    } else {
      const job = this.jobs.get(value.jobId)
      if (job?.owner === 'mcp' && !job.origin) {
        job.origin = safeOrigin
        if (job.status === 'completed') this.persistCompleted(job)
      }
    }
  }
}

module.exports = { ExportJobRegistry }
