import { deleteCustomLibraryWorkflow, loadCustomWorkflowLibrary, updateCustomLibraryWorkflowMetadata } from './customWorkflowLibrary'
import { openApiWorkflowInComfyUi, openUiWorkflowInComfyUi } from './workflowSetupManager'
import { isExportBusy } from '../stores/exportActivityStore'
import { assertMcpContext, captureMcpContext } from './mcpContext'

// This is a view over the existing owned stores, not another recipe store.
// Always ask native for a fresh list: an agent can save a workflow while the
// renderer's older Generate registry is already loaded.
export const WORKFLOW_LIBRARY_EVENTS = [
  'comfystudio:custom-workflow-library-changed',
  'comfystudio:imported-workflows-changed',
]

const text = (value, max = 2000) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''
const failure = error => ({ success: false, error: text(error?.message, 1000) || 'Could not access My Workflows.' })

function mutationGuard() {
  const expectedContext = captureMcpContext()
  const assertCurrent = () => {
    if (isExportBusy()) throw new Error('Workflow actions are paused during export. Try again when export finishes.')
    assertMcpContext(expectedContext, 'the saved workflow action')
  }
  assertCurrent()
  return { expectedContext, assertCurrent }
}

export function normalizeSavedWorkflow(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = text(entry.id || entry.workflowId, 200)
  if (!id || !['my-workflows', 'imported'].includes(entry.source)) return null
  return {
    id,
    title: text(entry.title || entry.label, 240) || 'Untitled workflow',
    label: text(entry.title || entry.label, 240) || 'Untitled workflow',
    description: text(entry.description),
    source: entry.source,
    outputType: ['image', 'video', 'audio', 'utility'].includes(entry.outputType) ? entry.outputType : null,
    format: entry.format === 'api' ? 'api' : 'ui',
    readiness: text(entry.readiness, 80),
    readinessMessage: text(entry.readinessMessage, 600),
    nodeCount: Math.max(0, Number(entry.nodeCount) || 0),
    updatedAt: Number(entry.updatedAt) || 0,
    inputSummary: text(entry.inputSummary, 600),
  }
}

export function searchSavedWorkflows(entries, query = '') {
  const words = text(query).toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter(entry => {
    const haystack = `${entry.title} ${entry.description} ${entry.id}`.toLocaleLowerCase()
    return words.every(word => haystack.includes(word))
  })
}

export async function listSavedWorkflows() {
  const api = globalThis.window?.electronAPI
  if (!api?.listSavedWorkflows) {
    return { success: false, workflows: [], error: 'My Workflows needs the updated desktop bridge. Restart the lab when it is idle, then try again.' }
  }
  try {
    const result = await api.listSavedWorkflows()
    if (!result?.success) throw new Error(result?.error || 'Could not load My Workflows.')
    const seen = new Set()
    const workflows = (Array.isArray(result.workflows) ? result.workflows : [])
      .map(normalizeSavedWorkflow).filter(entry => {
        if (!entry || seen.has(entry.id)) return false
        seen.add(entry.id)
        return true
      }).sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
    return { success: true, workflows, warnings: Array.isArray(result.warnings) ? result.warnings.map(value => text(value, 600)).filter(Boolean) : [] }
  } catch (error) {
    return { ...failure(error), workflows: [] }
  }
}

/** Caller must obtain explicit confirmation before replacing the active graph. */
export async function openSavedWorkflow(entry, { confirmed = false } = {}) {
  if (!confirmed) return { success: false, error: 'Confirm replacing the current ComfyUI graph first.' }
  const api = globalThis.window?.electronAPI
  if (!api?.readSavedWorkflow) return { success: false, error: 'Opening saved workflows needs the updated desktop bridge.' }
  try {
    const guard = mutationGuard()
    const result = await api.readSavedWorkflow({ workflowId: entry.id })
    if (!result?.success) throw new Error(result?.error || 'Could not read the saved workflow.')
    guard.assertCurrent()
    const options = { label: text(result.title, 240) || entry.title, ...guard }
    if (result.format === 'ui' && result.uiWorkflow && Array.isArray(result.uiWorkflow.nodes)) {
      return await openUiWorkflowInComfyUi(result.uiWorkflow, options)
    }
    if (result.format === 'api' && result.workflow && typeof result.workflow === 'object') {
      return await openApiWorkflowInComfyUi(result.workflow, options)
    }
    throw new Error('The saved workflow does not contain an editable graph.')
  } catch (error) {
    return failure(error)
  }
}

// Is this saved workflow one the person shares in GPU sharing? Deleting or replacing it stops that until it is added again.
export async function isSharedInGpuSharing(workflowId) {
  try {
    const listed = await globalThis.window?.electronAPI?.gpuShare?.own?.candidates?.()
    return Boolean(listed?.success && listed.workflows?.some(item => item.workflowId === workflowId && item.added))
  } catch { return false }
}

// Removes one ComfyUI capture from My Workflows for good.
export async function deleteSavedWorkflow(entry) {
  if (entry?.source !== 'my-workflows' || !entry.id?.startsWith('my-workflow:')) {
    return { success: false, error: 'Only workflows you saved from ComfyUI can be deleted here.' }
  }
  try {
    const guard = mutationGuard()
    await loadCustomWorkflowLibrary({ refresh: true })
    guard.assertCurrent()
    const removed = await deleteCustomLibraryWorkflow(entry.id.slice('my-workflow:'.length))
    return removed ? { success: true } : { success: false, error: 'That workflow is no longer in My Workflows.' }
  } catch (error) {
    return failure(error)
  }
}

export async function updateSavedWorkflowMetadata(entry, changes) {
  if (entry?.source !== 'my-workflows' || !entry.id?.startsWith('my-workflow:')) {
    return { success: false, error: 'Only ComfyUI captures can be renamed here. Managed API recipes keep their imported metadata.' }
  }
  try {
    const guard = mutationGuard()
    await loadCustomWorkflowLibrary({ refresh: true })
    guard.assertCurrent()
    return await updateCustomLibraryWorkflowMetadata(entry.id.slice('my-workflow:'.length), changes, guard)
  } catch (error) {
    return failure(error)
  }
}
