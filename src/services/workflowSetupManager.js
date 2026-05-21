import { AVAILABLE_WORKFLOWS, BUILTIN_WORKFLOWS, BUILTIN_WORKFLOW_PATHS } from '../config/workflowRegistry'
import { OPEN_COMFY_TAB_EVENT, getWorkflowDisplayLabel } from '../config/generateWorkspaceConfig'
import { getModelInstallInfo, getNodeInstallInfo } from '../config/workflowInstallCatalog'
import { buildComfyGraphFromApiWorkflow } from './comfyWorkflowGraph'
import { comfyui } from './comfyui'
import { getLocalComfyConnectionSync } from './localComfyConnection'
import { buildMissingDependencyClipboardText, checkWorkflowDependenciesBatch } from './workflowDependencies'

export const WORKFLOW_SETUP_SECTION_ID = 'workflow-setup'
const WORKFLOW_SETUP_EXTRA_IDS = new Set(['mask-gen'])

function uniqueBy(items = [], keyBuilder = (value) => value) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyBuilder(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(String(text || ''))
  }

  const textarea = document.createElement('textarea')
  textarea.value = String(text || '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
  return Promise.resolve()
}

function isComfyIframeVisible() {
  if (typeof document === 'undefined') return false
  const iframe = document.querySelector('iframe[title="ComfyUI"]')
  if (!(iframe instanceof HTMLIFrameElement)) return false
  const rect = iframe.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  const style = window.getComputedStyle(iframe)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const parent = iframe.parentElement
  if (parent) {
    const parentStyle = window.getComputedStyle(parent)
    if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return false
  }
  return true
}

async function waitForVisibleComfyIframe(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (isComfyIframeVisible()) return true
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  }
  return isComfyIframeVisible()
}

function enrichMissingNode(node = {}) {
  const install = getNodeInstallInfo(node.classType)
  return {
    ...node,
    install,
    autoInstallable: install.kind === 'auto',
    requiresManualSetup: install.kind === 'manual',
    needsCoreUpdate: install.kind === 'core',
  }
}

function enrichMissingModel(model = {}) {
  const install = getModelInstallInfo(model)
  return {
    ...model,
    install,
    autoInstallable: Boolean(install.downloadUrl),
  }
}

function buildSetupStatus(checkResult, summary) {
  if (!checkResult?.hasPack) return 'no-pack'
  if (checkResult.status === 'error') return 'error'
  if (checkResult.status === 'ready') return 'ready'
  if (checkResult.status === 'checking') return 'checking'

  if (checkResult.missingAuth && summary.actionableCount === 0 && summary.manualCount === 0 && summary.coreUpdateCount === 0) {
    return 'needs-auth'
  }
  if (summary.actionableCount > 0 && summary.manualCount === 0 && summary.coreUpdateCount === 0 && !checkResult.missingAuth) {
    return 'auto-installable'
  }
  if (summary.coreUpdateCount > 0 && summary.actionableCount === 0 && summary.manualCount === 0) {
    return 'needs-comfy-update'
  }
  if (summary.manualCount > 0 && summary.actionableCount === 0 && summary.coreUpdateCount === 0 && !checkResult.missingAuth) {
    return 'manual'
  }
  if (checkResult.status === 'partial') return 'partial'
  if (checkResult.status === 'missing') return 'mixed'
  return checkResult.status || 'idle'
}

export function getWorkflowSetupWorkflows() {
  const extraWorkflows = AVAILABLE_WORKFLOWS.filter((workflow) => WORKFLOW_SETUP_EXTRA_IDS.has(workflow.id))
  return uniqueBy([...BUILTIN_WORKFLOWS, ...extraWorkflows], (workflow) => workflow?.id || '')
}

export function enrichWorkflowDependencyResult(checkResult) {
  const missingNodes = (checkResult?.missingNodes || []).map(enrichMissingNode)
  const missingModels = (checkResult?.missingModels || []).map(enrichMissingModel)
  const autoNodePacks = uniqueBy(
    missingNodes.filter((entry) => entry.autoInstallable).map((entry) => entry.install),
    (entry) => entry.id
  )
  const autoModels = missingModels.filter((entry) => entry.autoInstallable)
  const manualNodes = missingNodes.filter((entry) => entry.requiresManualSetup)
  const coreUpdateNodes = missingNodes.filter((entry) => entry.needsCoreUpdate)
  const manualModels = missingModels.filter((entry) => !entry.autoInstallable)
  const actionableCount = autoNodePacks.length + autoModels.length
  const manualCount = manualNodes.length + manualModels.length
  const coreUpdateCount = coreUpdateNodes.length

  const workflowLabel = getWorkflowDisplayLabel(checkResult?.workflowId)
    || checkResult?.pack?.displayName
    || String(checkResult?.workflowId || 'workflow')

  return {
    ...checkResult,
    workflowLabel,
    missingNodes,
    missingModels,
    autoNodePacks,
    autoModels,
    manualNodes,
    manualModels,
    coreUpdateNodes,
    actionableCount,
    manualCount,
    coreUpdateCount,
    hasActionableInstalls: actionableCount > 0,
    setupStatus: buildSetupStatus(checkResult, {
      actionableCount,
      manualCount,
      coreUpdateCount,
    }),
  }
}

export async function scanWorkflowSetupDependencies() {
  const workflows = getWorkflowSetupWorkflows()
  const rawResults = await checkWorkflowDependenciesBatch(workflows.map((workflow) => workflow.id))
  const resultMap = new Map(
    (Array.isArray(rawResults) ? rawResults : []).map((result) => [result.workflowId, result])
  )

  return workflows.map((workflow) => {
    const result = resultMap.get(workflow.id) || {
      workflowId: workflow.id,
      status: 'no-pack',
      hasPack: false,
      hasBlockingIssues: false,
      missingNodes: [],
      missingModels: [],
      unresolvedModels: [],
      missingAuth: false,
      error: '',
      pack: null,
      checkedAt: Date.now(),
    }
    return enrichWorkflowDependencyResult(result)
  })
}

export function buildWorkflowInstallPlan(results = [], selectedWorkflowIds = []) {
  const selectedIdSet = new Set(
    (Array.isArray(selectedWorkflowIds) ? selectedWorkflowIds : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  )

  const selectedResults = (Array.isArray(results) ? results : []).filter((result) => selectedIdSet.has(result.workflowId))

  const nodePackMap = new Map()
  const modelMap = new Map()
  const manualNodes = []
  const coreNodes = []
  const manualModels = []
  const authWorkflows = []

  for (const result of selectedResults) {
    for (const node of result.missingNodes || []) {
      if (node.autoInstallable) {
        const current = nodePackMap.get(node.install.id) || {
          ...node.install,
          workflowIds: [],
          workflowLabels: [],
          classTypes: [],
        }
        current.workflowIds.push(result.workflowId)
        current.workflowLabels.push(result.workflowLabel)
        current.classTypes.push(node.classType)
        nodePackMap.set(node.install.id, current)
        continue
      }

      if (node.needsCoreUpdate) {
        coreNodes.push({
          workflowId: result.workflowId,
          workflowLabel: result.workflowLabel,
          classType: node.classType,
          install: node.install,
        })
        continue
      }

      manualNodes.push({
        workflowId: result.workflowId,
        workflowLabel: result.workflowLabel,
        classType: node.classType,
        install: node.install,
      })
    }

    for (const model of result.missingModels || []) {
      if (model.autoInstallable) {
        const key = `${model.targetSubdir}::${model.filename}`.toLowerCase()
        const current = modelMap.get(key) || {
          ...model.install,
          filename: model.filename,
          targetSubdir: model.targetSubdir,
          workflowIds: [],
          workflowLabels: [],
        }
        current.workflowIds.push(result.workflowId)
        current.workflowLabels.push(result.workflowLabel)
        modelMap.set(key, current)
        continue
      }

      manualModels.push({
        workflowId: result.workflowId,
        workflowLabel: result.workflowLabel,
        filename: model.filename,
        targetSubdir: model.targetSubdir,
        install: model.install,
      })
    }

    if (result.missingAuth) {
      authWorkflows.push({
        workflowId: result.workflowId,
        workflowLabel: result.workflowLabel,
      })
    }
  }

  const nodePacks = Array.from(nodePackMap.values()).map((entry) => ({
    ...entry,
    workflowIds: uniqueBy(entry.workflowIds, (value) => value),
    workflowLabels: uniqueBy(entry.workflowLabels, (value) => value),
    classTypes: uniqueBy(entry.classTypes, (value) => value),
  }))

  const models = Array.from(modelMap.values()).map((entry) => ({
    ...entry,
    workflowIds: uniqueBy(entry.workflowIds, (value) => value),
    workflowLabels: uniqueBy(entry.workflowLabels, (value) => value),
  }))

  return {
    selectedWorkflows: selectedResults.map((result) => ({
      workflowId: result.workflowId,
      workflowLabel: result.workflowLabel,
    })),
    nodePacks,
    models,
    manualNodes,
    manualModels,
    coreNodes,
    authWorkflows,
    actionableTaskCount: nodePacks.length + models.length,
    hasActionableTasks: nodePacks.length + models.length > 0,
    restartRecommended: nodePacks.length > 0,
  }
}

export function buildWorkflowSetupClipboardText(result) {
  const lines = []
  lines.push(buildMissingDependencyClipboardText(result))

  if ((result?.coreUpdateNodes?.length || 0) > 0) {
    lines.push('')
    lines.push('Needs ComfyUI update:')
    for (const node of result.coreUpdateNodes) {
      lines.push(`- ${node.classType}: ${node.install.notes || 'Update ComfyUI to a newer build.'}`)
    }
  }

  if ((result?.manualNodes?.length || 0) > 0) {
    lines.push('')
    lines.push('Manual-only node setup:')
    for (const node of result.manualNodes) {
      lines.push(`- ${node.classType}: ${node.install.notes || 'Use the registry or ComfyUI Manager.'}`)
    }
  }

  if ((result?.missingModels?.length || 0) > 0) {
    const manualModels = result.missingModels.filter((entry) => !entry.autoInstallable)
    if (manualModels.length > 0) {
      lines.push('')
      lines.push('Manual-only model setup:')
      for (const model of manualModels) {
        lines.push(`- ${model.filename}: ${model.install.notes || 'No curated download URL is available yet.'}`)
      }
    }
  }

  return lines.join('\n').trim()
}

export async function copyWorkflowSetupText(result) {
  const text = buildWorkflowSetupClipboardText(result)
  await copyTextToClipboard(text)
  return text
}

export async function openBundledWorkflowInComfyUi(workflowId) {
  const normalizedWorkflowId = String(workflowId || '').trim()
  const workflowPath = BUILTIN_WORKFLOW_PATHS[normalizedWorkflowId]
  if (!workflowPath) {
    return {
      success: false,
      error: 'This workflow file is not mapped in Generate.',
    }
  }

  try {
    window.dispatchEvent(new CustomEvent(OPEN_COMFY_TAB_EVENT, {
      detail: { workflowId: normalizedWorkflowId, workflowPath },
    }))

    const response = await fetch(workflowPath)
    if (!response.ok) {
      throw new Error(`Failed to fetch workflow JSON (${response.status})`)
    }

    const apiWorkflow = await response.json()
    await loadApiWorkflowGraphIntoComfyUi(apiWorkflow)

    return {
      success: true,
      hint: `Loaded ${getWorkflowDisplayLabel(normalizedWorkflowId)} into the embedded ComfyUI tab.`,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not open workflow in ComfyUI.',
    }
  }
}

async function loadApiWorkflowGraphIntoComfyUi(apiWorkflow) {
  const objectInfo = await comfyui.getObjectInfo()
  const workflowGraph = await buildComfyGraphFromApiWorkflow(apiWorkflow, objectInfo)
  const comfyBaseUrl = getLocalComfyConnectionSync().httpBase

  if (!window?.electronAPI?.loadComfyUiWorkflowGraph) {
    throw new Error('Workflow loading into the embedded ComfyUI tab is only available in the desktop build.')
  }

  const becameVisible = await waitForVisibleComfyIframe(4000)
  if (!becameVisible) {
    throw new Error('The embedded ComfyUI tab did not become visible in time.')
  }

  const loadResult = await window.electronAPI.loadComfyUiWorkflowGraph({
    workflowGraph,
    comfyBaseUrl,
    waitForMs: 12000,
  })

  if (!loadResult?.success) {
    throw new Error(loadResult?.error || 'Could not load the workflow into the embedded ComfyUI tab.')
  }
}

export async function openApiWorkflowInComfyUi(apiWorkflow, { label = 'Custom workflow' } = {}) {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_COMFY_TAB_EVENT, {
      detail: { label },
    }))

    await loadApiWorkflowGraphIntoComfyUi(apiWorkflow)

    return {
      success: true,
      hint: `Loaded ${label} into the embedded ComfyUI tab.`,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not open workflow in ComfyUI.',
    }
  }
}
