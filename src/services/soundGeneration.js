/**
 * Sound tab jobs that run as a ComfyUI workflow: a paid partner node (Sonilo)
 * or a local model. ComfyUI does the work; this queues the workflow through
 * Velorn's managed generation path (which asks before any cloud spend and adds
 * the Comfy account key), watches ComfyUI's history, and saves the finished
 * audio into the project that started it. Modelled on musicGeneration.js.
 */
import { comfyui } from './comfyui'
import { importAsset } from './fileSystem'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { markPromptHandledByApp } from './comfyPromptGuard'

export const GENERATED_SOUND_FOLDER = 'Generated Sound'
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 60 * 60 * 1000
const jobs = new Map()
let pollTimer = null
let pollInFlight = null

const ownsActiveProject = job => job.projectDir === useProjectStore.getState().currentProjectHandle

function ensureFolder() {
  const state = useAssetsStore.getState()
  return (state.folders || []).find(folder => !folder.parentId && folder.name === GENERATED_SOUND_FOLDER)?.id
    || state.addFolder({ name: GENERATED_SOUND_FOLDER, parentId: null })?.id
}

// Only the workflow's own save node counts; other nodes may also hold audio.
export function collectSoundOutputs(historyEntry, outputNodeId) {
  const files = new Map()
  for (const entries of Object.values(historyEntry?.outputs?.[outputNodeId] || {})) {
    if (!Array.isArray(entries)) continue
    for (const item of entries) {
      const filename = item?.filename
      if (!filename || !/\.(mp3|wav|ogg|flac|aac|m4a|opus)$/i.test(filename) || (item.type && item.type !== 'output')) continue
      const file = { filename, subfolder: item.subfolder || '', type: 'output' }
      files.set(file.subfolder + '/' + filename, file)
    }
  }
  return [...files.values()]
}

async function importOutput(job, file) {
  if (!ownsActiveProject(job)) return null
  const existing = useAssetsStore.getState().assets.find(asset => asset.promptId === job.promptId
    && asset.sourceFilename === file.filename && (asset.sourceSubfolder || '') === file.subfolder)
  if (existing) return existing
  const fileKey = file.subfolder + '/' + file.filename
  let assetInfo = job.importedFiles.get(fileKey)
  if (!assetInfo) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const response = await fetch(job.httpBase + '/view?' + query)
    if (!response.ok) throw new Error('Could not download the finished audio (' + response.status + ').')
    const blob = await response.blob()
    if (!ownsActiveProject(job)) return null
    const blobFile = new File([blob], file.filename, { type: blob.type || 'audio/mpeg' })
    assetInfo = await importAsset(job.projectDir, blobFile, 'audio')
    assetInfo = { ...assetInfo, url: URL.createObjectURL(blobFile) }
    job.importedFiles.set(fileKey, assetInfo)
  }
  if (!ownsActiveProject(job)) return null
  const seconds = Number(assetInfo.duration)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('The audio was saved, but its length could not be read. Reopen it from the project’s assets/audio folder.')
  return useAssetsStore.getState().addAsset({
    ...assetInfo, name: job.label + ' ' + job.title.slice(0, 40) + ' (' + file.filename + ')',
    type: 'audio', folderId: ensureFolder(), isImported: true,
    source: 'comfyui-auto-import', promptId: job.promptId,
    sourceFilename: file.filename, sourceSubfolder: file.subfolder, sourceOutputType: file.type,
    generatedSound: { version: 1, model: job.label, cloud: job.cloud === true, seconds },
  })
}

async function pollOnce() {
  const pending = [...jobs.values()].filter(job => ['queued', 'running', 'awaiting-project'].includes(job.status))
  if (!pending.length) { clearInterval(pollTimer); pollTimer = null; return }
  for (const job of pending) {
    try {
      if (!job.outputFiles) {
        if (Date.now() - job.createdAt > JOB_TIMEOUT_MS) throw new Error('This took too long. Check ComfyUI’s history for the result.')
        const response = await fetch(job.httpBase + '/history/' + encodeURIComponent(job.promptId))
        if (!response.ok) throw new Error('Could not check ComfyUI’s history (' + response.status + ').')
        const entry = (await response.json())?.[job.promptId]
        if (!entry) continue
        if (entry.status?.status_str === 'error') {
          const detail = (entry.status.messages || []).filter(message => String(message[0]).includes('error'))
            .map(message => message[1]?.exception_message).filter(Boolean).join('; ')
          job.status = 'failed'; job.error = detail || 'ComfyUI reported an error.'
          continue
        }
        const files = collectSoundOutputs(entry, job.outputNodeId)
        if (!files.length) {
          if (entry.status?.completed) { job.status = 'failed'; job.error = 'ComfyUI finished without an audio file.' }
          continue
        }
        job.outputFiles = files
      }
      if (!ownsActiveProject(job)) { job.status = 'awaiting-project'; job.error = 'The audio is ready. Reopen the project that started it to save it.'; continue }
      job.status = 'running'
      const assetIds = []
      for (const file of job.outputFiles) { const asset = await importOutput(job, file); if (asset?.id) assetIds.push(asset.id) }
      if (assetIds.length !== job.outputFiles.length) { job.status = 'awaiting-project'; continue }
      job.status = 'completed'; job.error = null; job.assetIds = assetIds
    } catch (error) {
      job.error = error?.message || 'The audio could not be made.'
      // A failed status check can recover; a failed save must be shown, not hidden.
      if (job.outputFiles || Date.now() - job.createdAt > JOB_TIMEOUT_MS) job.status = 'failed'
    }
  }
}
const poll = () => { if (!pollInFlight) pollInFlight = pollOnce().finally(() => { pollInFlight = null }); return pollInFlight }

const summary = job => ({ promptId: job.promptId, status: job.status, error: job.error || null, assetIds: [...job.assetIds] })

/**
 * Queue one audio workflow. `workflow` is a ComfyUI prompt; `outputNodeId` is its
 * save node. A cloud workflow goes through the native spending check before
 * anything is sent: the priced button's click approves the Sound tab's own
 * requests, and anything else is asked about. Returns the same shape as the music service.
 */
export async function queueSoundWorkflow({ workflow, outputNodeId, label, title, cloud = false } = {}) {
  const projectDir = useProjectStore.getState().currentProjectHandle
  if (!projectDir) throw new Error('Create or open a project first, so the audio can be saved with it.')
  const httpBase = comfyui.getHttpBase()
  // The button showed the price, so the click can stand as the approval for a cloud request.
  const promptId = await comfyui.queuePrompt(workflow, { priced: cloud === true })
  markPromptHandledByApp(promptId)
  const job = { promptId, status: 'queued', projectDir, httpBase, outputNodeId: String(outputNodeId), label: String(label || 'Sound'),
    title: String(title || ''), cloud, error: null, assetIds: [], importedFiles: new Map(), createdAt: Date.now() }
  jobs.set(promptId, job)
  if (!pollTimer) pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  return [summary(job)]
}

export function getSoundJobs(promptIds = null) {
  const wanted = Array.isArray(promptIds) ? new Set(promptIds) : null
  return [...jobs.values()].filter(job => !wanted || wanted.has(job.promptId)).map(summary)
}
