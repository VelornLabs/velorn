// MCP-facing job store for workflow dependency installs. The actual work is
// the headless electron-main IPC (workflowSetup:install — git clone + pip +
// streamed model downloads); this module wraps it in a job+poll pattern
// because installs run far past the 60s MCP renderer bridge timeout.
//
// Single active job at a time: the main-side installer is sequential and its
// progress broadcast is a single shared channel, so attribution would be
// ambiguous with concurrent installs. A UI-driven install (Settings panel /
// Generate tab) running at the same time can interleave progress events —
// known limitation, the merged numbers stay approximately right.
import { checkWorkflowDependencies } from './workflowDependencies'
import {
  buildWorkflowInstallPlanWithImportedPromotion,
  enrichWorkflowDependencyResult,
} from './workflowSetupManager'

const COMFY_ROOT_PATH_SETTING_KEY = 'comfyRootPath'
const MAX_FINISHED_JOBS = 10
// Same shape packDataToRecipe enforces at recipe creation — re-checked here
// because plans can carry recipes from older persisted entries.
const REPO_URL_RE = /^https:\/\/(github|gitlab)\.com\/[^/]+\/[^/]+$/i
const PROGRESS_KEYS = [
  'stage', 'status', 'message', 'currentLabel', 'taskType', 'currentTaskIndex',
  'totalTasks', 'completedTasks', 'taskPercent', 'overallPercent',
  'bytesDownloaded', 'totalBytes',
]

const jobs = new Map()
let activeJobId = null
let progressSubscribed = false

function sanitizeRelativePath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || /^[a-z]:/i.test(normalized)) return null
  if (normalized.split('/').some((segment) => !segment || segment === '..')) return null
  return normalized
}

// Everything in the plan lands under the user's ComfyUI folder — reject
// anything that could escape it or fetch over a non-https scheme.
export function sanitizeInstallPlan(plan) {
  const nodePacks = []
  for (const pack of Array.isArray(plan?.nodePacks) ? plan.nodePacks : []) {
    const repoUrl = String(pack?.repoUrl || '').trim()
    if (!REPO_URL_RE.test(repoUrl)) {
      throw new Error(`Node pack "${pack?.id || pack?.displayName || 'unknown'}" has an unsupported repo URL — only https github.com/gitlab.com repos are allowed.`)
    }
    const installDirName = sanitizeRelativePath(pack?.installDirName)
    if (!installDirName || installDirName.includes('/')) {
      throw new Error(`Node pack "${pack?.id || 'unknown'}" has an unsafe install folder name.`)
    }
    nodePacks.push({ ...pack, installDirName })
  }
  const models = []
  for (const model of Array.isArray(plan?.models) ? plan.models : []) {
    const downloadUrl = String(model?.downloadUrl || '').trim()
    if (!/^https:\/\//i.test(downloadUrl)) {
      throw new Error(`Model "${model?.filename || 'unknown'}" has a non-https download URL.`)
    }
    const filename = sanitizeRelativePath(model?.filename)
    const targetSubdir = sanitizeRelativePath(model?.targetSubdir)
    if (!filename || !targetSubdir) {
      throw new Error(`Model "${model?.filename || 'unknown'}" has an unsafe filename or target folder.`)
    }
    models.push({ ...model, filename, targetSubdir, downloadUrl })
  }
  return { nodePacks, models }
}

export async function buildInstallPlanForWorkflow(workflowId) {
  const id = String(workflowId || '').trim()
  if (!id) throw new Error('workflowId is required.')

  const check = await checkWorkflowDependencies(id)
  if (!check?.hasPack) {
    throw new Error(`Unknown workflowId "${id}" — use the tpl- id returned by import_comfyui_workflow or a built-in workflow id.`)
  }
  if (check.status === 'error') {
    throw new Error(check.error || 'Could not check workflow dependencies — is ComfyUI running?')
  }

  const enriched = enrichWorkflowDependencyResult(check)
  const plan = buildWorkflowInstallPlanWithImportedPromotion(enriched)

  const api = typeof window !== 'undefined' ? window.electronAPI : null
  let rootValidation = { checked: false, isValid: false, normalizedPath: '', error: 'Desktop build required.' }
  if (api?.getSetting && api?.validateWorkflowSetupRoot) {
    const stored = String(await api.getSetting(COMFY_ROOT_PATH_SETTING_KEY) || '').trim()
    if (!stored) {
      rootValidation = {
        checked: true,
        isValid: false,
        normalizedPath: '',
        error: 'No ComfyUI folder is configured in Velorn yet — set it in the app (Generate tab setup or Settings) first.',
      }
    } else {
      const validation = await api.validateWorkflowSetupRoot(stored)
      rootValidation = {
        checked: true,
        isValid: Boolean(validation?.isValid),
        normalizedPath: validation?.normalizedPath || stored,
        error: validation?.isValid ? '' : (validation?.error || 'The configured ComfyUI folder failed validation.'),
      }
    }
  }

  return { enriched, plan, rootValidation }
}

function ensureProgressSubscription() {
  if (progressSubscribed) return
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.onWorkflowSetupProgress) return
  progressSubscribed = true
  api.onWorkflowSetupProgress((entry) => {
    if (!activeJobId) return
    const job = jobs.get(activeJobId)
    if (!job || job.status !== 'running') return
    const normalized = entry && typeof entry === 'object' ? entry : {}
    const next = { ...job.progress }
    for (const key of PROGRESS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(normalized, key)) next[key] = normalized[key]
    }
    job.progress = next
  })
}

function evictFinishedJobs() {
  const finished = Array.from(jobs.values())
    .filter((job) => job.status !== 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  while (finished.length > MAX_FINISHED_JOBS) {
    const oldest = finished.shift()
    jobs.delete(oldest.jobId)
  }
}

function summarizeInstallJob(job) {
  return { ...job, plan: { ...job.plan }, progress: { ...job.progress } }
}

export function startWorkflowInstall({ workflowId, plan, comfyRootPath }) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.installWorkflowSetup) {
    throw new Error('Workflow setup installation is only available in the desktop build.')
  }
  const active = activeJobId ? jobs.get(activeJobId) : null
  if (active && active.status === 'running') {
    throw new Error(`An install is already running (jobId ${active.jobId}) — poll get_workflow_install_status and wait for it to finish.`)
  }

  const sanitized = sanitizeInstallPlan(plan)
  const totalDownloadBytes = sanitized.models.reduce(
    (sum, model) => (Number.isFinite(model.sizeBytes) ? sum + Number(model.sizeBytes) : sum),
    0
  )
  const jobId = `wfinstall_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const job = {
    jobId,
    workflowId: String(workflowId || '').trim(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    plan: {
      nodePacks: sanitized.nodePacks.map((pack) => ({ id: pack.id, displayName: pack.displayName, repoUrl: pack.repoUrl })),
      models: sanitized.models.map((model) => ({
        filename: model.filename,
        targetSubdir: model.targetSubdir,
        downloadUrl: model.downloadUrl,
        sizeBytes: Number.isFinite(model.sizeBytes) ? Number(model.sizeBytes) : null,
      })),
      totalDownloadBytes,
      restartRecommended: Boolean(plan?.restartRecommended),
    },
    progress: {
      stage: 'install',
      status: 'active',
      message: 'Preparing workflow setup install...',
      currentLabel: '',
      taskType: '',
      currentTaskIndex: 0,
      totalTasks: sanitized.nodePacks.length + sanitized.models.length,
      completedTasks: 0,
      taskPercent: null,
      overallPercent: 0,
      bytesDownloaded: 0,
      totalBytes: 0,
    },
    result: null,
    errors: [],
  }
  jobs.set(jobId, job)
  activeJobId = jobId
  evictFinishedJobs()
  ensureProgressSubscription()

  const finalize = (result, error) => {
    const record = jobs.get(jobId)
    if (activeJobId === jobId) activeJobId = null
    if (!record) return
    record.finishedAt = Date.now()
    if (error) {
      record.status = 'failed'
      record.errors = [error instanceof Error ? error.message : String(error || 'Workflow setup install failed.')]
      return
    }
    if (!result?.success) {
      record.status = 'failed'
      record.errors = [result?.error || 'Workflow setup install failed.'].filter(Boolean)
      return
    }
    const installErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : []
    record.status = installErrors.length > 0 ? 'completed-with-errors' : 'completed'
    record.errors = installErrors
    record.result = {
      restartRecommended: Boolean(result.restartRecommended),
      nodePacks: result.nodePackResults || result.nodePacks || [],
      models: result.modelResults || result.models || [],
    }
  }

  // Fire and forget — the handler must return well inside the 60s bridge cap;
  // get_workflow_install_status reads this record as the install progresses.
  api.installWorkflowSetup({
    comfyRootPath,
    plan: { nodePacks: sanitized.nodePacks, models: sanitized.models },
  }).then((result) => finalize(result, null)).catch((error) => finalize(null, error))

  return summarizeInstallJob(job)
}

export function getWorkflowInstallJobs(jobId = null) {
  const id = String(jobId || '').trim()
  if (id) {
    const job = jobs.get(id)
    return job ? [summarizeInstallJob(job)] : []
  }
  return Array.from(jobs.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(summarizeInstallJob)
}
