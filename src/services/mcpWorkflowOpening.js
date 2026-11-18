import { openApiWorkflowInComfyUi, openUiWorkflowInComfyUi } from './workflowSetupManager'
import { assertMcpContext, captureMcpContext } from './mcpContext'
import { isExportBusy } from '../stores/exportActivityStore'

// Open the persisted recipe, not a model-authored second copy or a stale
// renderer catalog entry. The native library resolves the ID and reads disk.
export async function handleOpenComfyUiWorkflow(payload = {}) {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId.trim() : ''
  if (!workflowId) throw new Error('workflowId is required. Choose a saved workflow ID from the workflow library.')
  const api = globalThis.window?.electronAPI
  if (!api?.readSavedWorkflow) throw new Error('Opening saved workflows needs the updated desktop bridge. Restart Velorn, then try again.')

  assertMcpContext(payload.expectedContext, 'opening the saved ComfyUI workflow')
  const context = captureMcpContext()
  const assertCurrent = () => {
    if (isExportBusy()) throw new Error('Workflow actions are paused during export. Try again when export finishes.')
    assertMcpContext(context, 'opening the saved ComfyUI workflow')
  }
  assertCurrent()
  const saved = await api.readSavedWorkflow({ workflowId })
  if (!saved?.success) throw new Error(saved?.error || 'Could not read the saved workflow.')
  assertCurrent()

  let graph, openWorkflow, nodeCount
  if (saved.format === 'ui' && saved.uiWorkflow && Array.isArray(saved.uiWorkflow.nodes)) {
    graph = saved.uiWorkflow
    openWorkflow = openUiWorkflowInComfyUi
    nodeCount = graph.nodes.length
  } else if (saved.format === 'api' && saved.workflow && typeof saved.workflow === 'object' && !Array.isArray(saved.workflow)) {
    graph = saved.workflow
    openWorkflow = openApiWorkflowInComfyUi
    nodeCount = Object.keys(graph).length
  } else {
    throw new Error('The saved workflow does not contain an editable ComfyUI graph.')
  }
  const title = typeof saved.title === 'string' && saved.title.trim() ? saved.title.trim() : workflowId
  const summary = { workflowId, title, format: saved.format, nodeCount, target: 'comfyui', generationSubmitted: false }
  if (payload.previewOnly !== false) {
    return {
      success: true, action: 'open_comfyui_workflow', previewOnly: true, opened: false, applied: false,
      ...summary, context,
      plan: { ...summary, replacesActiveGraph: true },
      message: 'Ready to show this saved workflow in Velorn’s ComfyUI tab. Applying replaces the currently displayed ComfyUI graph, including unsaved graph changes. No generation will start and the saved workflow and project stay unchanged.',
      suggestedApplyPayload: { workflowId, previewOnly: false, expectedContext: context },
    }
  }

  const result = await openWorkflow(graph, { label: title, assertCurrent, expectedContext: context })
  if (result?.success !== true) throw new Error(result?.error || 'Could not load the workflow into Velorn’s ComfyUI tab.')
  return {
    success: true, action: 'open_comfyui_workflow', previewOnly: false, opened: true, applied: true,
    ...summary,
    message: `Opened ${title} in Velorn’s ComfyUI tab. No generation was started; the saved workflow and project are unchanged.`,
  }
}
