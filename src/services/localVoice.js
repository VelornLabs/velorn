/**
 * The Sound tab's built-in local voice (Kokoro). It runs in a worker inside
 * Velorn, with no ComfyUI: the main process keeps and checks the model files,
 * the worker speaks with them, and the finished recording is saved into the
 * project that asked for it. Jobs are reported in the same shape as the other
 * sound services, so the Sound tab follows them the same way.
 */
import { importAsset } from './fileSystem'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'

export const GENERATED_SOUND_FOLDER = 'Generated Sound'
const api = () => globalThis.window?.electronAPI?.localVoice
const jobs = new Map()
const asked = new Map()
let worker = null, nextId = 0

export const localVoiceAvailable = () => typeof api()?.status === 'function'
export async function localVoiceStatus() {
  if (!localVoiceAvailable()) return { success: false, error: 'Local voices need the Velorn desktop app.' }
  return api().status()
}
// Downloads the model files that are missing. `onProgress` gets { doneBytes, totalBytes }.
export async function installLocalVoice(onProgress) {
  if (!localVoiceAvailable()) return { success: false, error: 'Local voices need the Velorn desktop app.' }
  const stop = typeof onProgress === 'function' ? api().onProgress?.(onProgress) : null
  try { return await api().install() } finally { stop?.() }
}

function startWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./kokoroWorker.js', import.meta.url), { type: 'module' })
  worker.onmessage = async event => {
    const message = event.data || {}
    if (message.type === 'file') {
      // The worker asks for a model file; the main process returns checked bytes.
      const result = await api().read({ path: message.path }).catch(() => null)
      if (result?.success && result.bytes) {
        const bytes = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength)
        worker?.postMessage({ type: 'file-reply', id: message.id, bytes }, [bytes])
      } else worker?.postMessage({ type: 'file-reply', id: message.id, error: result?.error || 'File not available.' })
      return
    }
    if (message.type === 'progress') { asked.get(message.id)?.alive?.(); return }
    if (message.type === 'done') { const waiting = asked.get(message.id); asked.delete(message.id); waiting?.(message) }
  }
  worker.onerror = () => {
    for (const waiting of asked.values()) waiting({ error: 'The voice model stopped unexpectedly. Try again.' })
    asked.clear(); worker?.terminate(); worker = null
  }
  return worker
}
// A request that goes quiet is ended with a message instead of waiting forever. The clock
// restarts whenever the worker reports a finished piece; the first piece also loads the model.
const QUIET_MS = 4 * 60 * 1000
const ask = message => new Promise(resolve => {
  const id = ++nextId
  let timer = null
  const finish = value => { clearTimeout(timer); resolve(value) }
  finish.alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!asked.delete(id)) return
      worker?.terminate(); worker = null
      for (const other of asked.values()) other({ error: 'The voice model stopped answering. Try again.' })
      asked.clear()
      resolve({ error: 'The voice model stopped answering, so this was cancelled. Nothing was charged. Try again.' })
    }, QUIET_MS)
  }
  asked.set(id, finish); finish.alive()
  startWorker().postMessage({ ...message, id })
})

function ensureFolder() {
  const state = useAssetsStore.getState()
  return (state.folders || []).find(folder => !folder.parentId && folder.name === GENERATED_SOUND_FOLDER)?.id
    || state.addFolder({ name: GENERATED_SOUND_FOLDER, parentId: null })?.id
}
const summary = job => ({ promptId: job.promptId, status: job.status, error: job.error || null, assetIds: [...job.assetIds] })

async function run(job, text, voice) {
  try {
    job.status = 'running'
    const made = await ask({ type: 'speak', text, voice })
    if (made.error || !made.bytes) throw new Error(made.error || 'The voice could not be made.')
    if (job.projectDir !== useProjectStore.getState().currentProjectHandle) throw new Error('The project was closed before the voice was finished, so it was not saved.')
    const file = new File([made.bytes], `velorn_voice_${Date.now()}.wav`, { type: 'audio/wav' })
    const info = await importAsset(job.projectDir, file, 'audio')
    const seconds = Number(info.duration) > 0 ? Number(info.duration) : made.seconds
    const asset = useAssetsStore.getState().addAsset({
      ...info, url: info.url || URL.createObjectURL(file), duration: seconds, name: `${job.label} ${job.title.slice(0, 40)}`,
      type: 'audio', folderId: ensureFolder(), isImported: true, source: 'velorn-local-voice', promptId: job.promptId,
      generatedSound: { version: 1, model: job.label, cloud: false, seconds },
    })
    if (!asset?.id) throw new Error('The voice was made but could not be added to the project.')
    job.assetIds = [asset.id]; job.status = 'completed'
  } catch (error) { job.status = 'failed'; job.error = error?.message || 'The voice could not be made.' }
}

/** Start one line of speech. Returns at once; follow it with getLocalVoiceJobs. */
export async function queueLocalVoice({ text, voice, label = 'Voice' } = {}) {
  if (!localVoiceAvailable()) throw new Error('Local voices need the Velorn desktop app.')
  const projectDir = useProjectStore.getState().currentProjectHandle
  if (!projectDir) throw new Error('Create or open a project first, so the audio can be saved with it.')
  const words = typeof text === 'string' ? text.trim() : ''
  if (!words) throw new Error('Write what the voice should say first.')
  const status = await api().status()
  if (!status?.installed) throw new Error('Download the voice model first.')
  const job = { promptId: `local-voice-${globalThis.crypto.randomUUID()}`, status: 'queued', projectDir, label: String(label), title: words, error: null, assetIds: [] }
  jobs.set(job.promptId, job)
  run(job, words, voice)
  return [summary(job)]
}

export function getLocalVoiceJobs(promptIds = null) {
  const wanted = Array.isArray(promptIds) ? new Set(promptIds) : null
  return [...jobs.values()].filter(job => !wanted || wanted.has(job.promptId)).map(summary)
}
