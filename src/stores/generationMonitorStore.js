import { create } from 'zustand'

function sanitizeMonitorJob(job = {}) {
  return {
    id: job.id,
    workflowId: job.workflowId || '',
    workflowLabel: job.workflowLabel || job.workflowName || job.workflowId || 'Generation',
    category: job.category || '',
    status: job.status || 'queued',
    progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
    promptId: job.promptId || null,
    node: job.node ?? null,
    error: job.error || '',
    prompt: String(job.prompt || '').slice(0, 240),
    createdAt: Number(job.createdAt) || Date.now(),
    startedAt: Number(job.startedAt) || null,
    completedAt: Number(job.completedAt) || null,
    elapsedMs: Number(job.elapsedMs) || null,
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds.filter(Boolean).slice(0, 12) : [],
    restoredFromLedger: Boolean(job.restoredFromLedger),
  }
}

const useGenerationMonitorStore = create((set) => ({
  jobs: [],
  activeJobId: null,
  isConnected: false,
  updatedAt: 0,
  publishQueue: ({ jobs = [], activeJobId = null, isConnected = false } = {}) => {
    set({
      jobs: Array.isArray(jobs) ? jobs.map(sanitizeMonitorJob) : [],
      activeJobId,
      isConnected: Boolean(isConnected),
      updatedAt: Date.now(),
    })
  },
  reset: () => set({
    jobs: [],
    activeJobId: null,
    isConnected: false,
    updatedAt: Date.now(),
  }),
}))

export default useGenerationMonitorStore
