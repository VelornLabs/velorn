import jsonata from 'jsonata'
import { comfyui } from './comfyui'
import { getWorkflowDependencyPack } from '../config/workflowDependencyPacks'
import { BUILTIN_WORKFLOW_PATHS } from '../config/workflowRegistry'

const COMFY_CREDITS_PER_USD = 211

function asStringList(values) {
  if (!Array.isArray(values)) return []
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
}

function extractChoiceListFromSpec(inputSpec) {
  if (!inputSpec) return []

  if (Array.isArray(inputSpec)) {
    const [first] = inputSpec
    if (Array.isArray(first)) return asStringList(first)
    if (first && typeof first === 'object') {
      return asStringList(first.values || first.choices || first.options || first.enum)
    }
  }

  if (inputSpec && typeof inputSpec === 'object') {
    return asStringList(inputSpec.values || inputSpec.choices || inputSpec.options || inputSpec.enum)
  }

  return []
}

function getInputSpec(nodeSchema, inputKey) {
  const requiredSpec = nodeSchema?.input?.required?.[inputKey]
  if (requiredSpec !== undefined) return requiredSpec
  const optionalSpec = nodeSchema?.input?.optional?.[inputKey]
  if (optionalSpec !== undefined) return optionalSpec
  return null
}

function modelChoiceBasename(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return ''
  const parts = normalized.split(/[\\/]+/)
  return parts[parts.length - 1] || ''
}

function collectPriceBadgesFromSchema(nodeSchema, out = []) {
  if (nodeSchema === null || nodeSchema === undefined) return out

  if (Array.isArray(nodeSchema)) {
    for (const item of nodeSchema) {
      collectPriceBadgesFromSchema(item, out)
    }
    return out
  }

  if (typeof nodeSchema !== 'object') return out

  for (const [key, value] of Object.entries(nodeSchema)) {
    if (key === 'price_badge') {
      out.push(value)
      continue
    }
    collectPriceBadgesFromSchema(value, out)
  }
  return out
}

function normalizePriceBadgeText(badge) {
  if (badge === null || badge === undefined) return ''
  if (typeof badge === 'string') return badge.trim()
  if (typeof badge === 'number') return String(badge)
  if (typeof badge === 'boolean') return badge ? 'true' : 'false'

  if (Array.isArray(badge)) {
    return badge.map((entry) => normalizePriceBadgeText(entry)).filter(Boolean).join(' | ').trim()
  }

  if (typeof badge === 'object') {
    const preferredKeys = ['text', 'label', 'value', 'display', 'price', 'credits', 'expression', 'jsonata']
    const pieces = []
    for (const key of preferredKeys) {
      if (!(key in badge)) continue
      const normalized = normalizePriceBadgeText(badge[key])
      if (normalized) pieces.push(normalized)
    }
    if (pieces.length > 0) {
      return pieces.join(' | ').trim()
    }
    try {
      return JSON.stringify(badge)
    } catch (_) {
      return ''
    }
  }

  return ''
}

function extractCreditValuesFromText(text = '') {
  const normalized = String(text || '')
  if (!normalized) return []

  const values = []
  const creditMatches = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*credits?/gi)]
  for (const match of creditMatches) {
    const parsed = Number(match?.[1])
    if (Number.isFinite(parsed) && parsed >= 0) values.push(parsed)
  }

  // Some price badges expose expressions with explicit credit keys.
  const keyMatches = [...normalized.matchAll(/(?:credit|credits|credit_cost|cost)\s*[:=]\s*(\d+(?:\.\d+)?)/gi)]
  for (const match of keyMatches) {
    const parsed = Number(match?.[1])
    if (Number.isFinite(parsed) && parsed >= 0) values.push(parsed)
  }

  return values
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeEstimatedCreditRange(minValue, maxValue = minValue) {
  if (minValue === null || minValue === undefined) return null
  if (maxValue === null || maxValue === undefined) return null
  const min = Number(minValue)
  const max = Number(maxValue)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
  }
}

function mergeEstimatedCreditRanges(ranges = []) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((range) => normalizeEstimatedCreditRange(range?.min, range?.max))
    .filter(Boolean)
  if (normalized.length === 0) return null
  return normalized.reduce(
    (acc, range) => ({
      min: acc.min + range.min,
      max: acc.max + range.max,
    }),
    { min: 0, max: 0 }
  )
}

async function loadBuiltinWorkflowDefinition(workflowId) {
  const workflowPath = BUILTIN_WORKFLOW_PATHS[String(workflowId || '').trim()]
  if (!workflowPath) return null
  try {
    const response = await fetch(workflowPath)
    if (!response.ok) return null
    return await response.json()
  } catch (_) {
    return null
  }
}

function getWorkflowNodesByClassType(workflowDefinition, classType) {
  const normalizedClassType = String(classType || '').trim()
  if (!workflowDefinition || typeof workflowDefinition !== 'object' || !normalizedClassType) return []
  return Object.values(workflowDefinition).filter((node) => (
    node
    && typeof node === 'object'
    && String(node.class_type || '').trim() === normalizedClassType
  ))
}

function getDependencyEntryName(entry) {
  if (typeof entry === 'string') return entry.trim()
  if (entry && typeof entry === 'object') return String(entry.name || '').trim()
  return ''
}

function buildPriceBadgeEvaluationContext(workflowNode, priceBadge, options = {}) {
  const nodeInputs = workflowNode?.inputs && typeof workflowNode.inputs === 'object'
    ? workflowNode.inputs
    : {}
  const dependsOn = priceBadge?.depends_on && typeof priceBadge.depends_on === 'object'
    ? priceBadge.depends_on
    : {}
  const lowercaseStrings = Boolean(options.lowercaseStrings)

  const normalizeWidgetValue = (value) => {
    if (!lowercaseStrings || typeof value !== 'string') return value
    return value.trim().toLowerCase()
  }

  const widgets = {}
  for (const widgetEntry of Array.isArray(dependsOn.widgets) ? dependsOn.widgets : []) {
    const widgetName = getDependencyEntryName(widgetEntry)
    if (!widgetName || !(widgetName in nodeInputs)) continue
    const widgetValue = nodeInputs[widgetName]
    if (Array.isArray(widgetValue)) continue
    widgets[widgetName] = normalizeWidgetValue(widgetValue)
  }

  const inputs = {}
  for (const inputEntry of Array.isArray(dependsOn.inputs) ? dependsOn.inputs : []) {
    const inputName = getDependencyEntryName(inputEntry)
    if (!inputName) continue
    const inputValue = nodeInputs[inputName]
    const isConnected = Array.isArray(inputValue)
      ? inputValue.length >= 2 && inputValue[0] !== null && inputValue[0] !== undefined
      : inputValue !== undefined && inputValue !== null && String(inputValue).trim() !== ''
    inputs[inputName] = { connected: isConnected }
  }

  return {
    widgets,
    inputs,
    input_groups: {},
  }
}

function normalizePriceBadgeResultToCredits(result) {
  if (result === null || result === undefined) return null

  if (Array.isArray(result)) {
    return mergeEstimatedCreditRanges(result.map((entry) => normalizePriceBadgeResultToCredits(entry)))
  }

  if (typeof result === 'number') {
    return normalizeEstimatedCreditRange(result, result)
  }

  if (typeof result !== 'object') return null

  const type = String(result.type || '').trim().toLowerCase()
  const directCredits = normalizeEstimatedCreditRange(
    firstFiniteNumber(result.credits, result.credit, result.minCredits, result.min_credits, result.credit_min),
    firstFiniteNumber(result.credits, result.credit, result.maxCredits, result.max_credits, result.credit_max)
  )
  if (type.includes('credit') || directCredits) {
    return directCredits
  }

  const usdRange = normalizeEstimatedCreditRange(
    firstFiniteNumber(result.usd, result.amountUsd, result.minUsd, result.min_usd, result.usd_min),
    firstFiniteNumber(result.usd, result.amountUsd, result.maxUsd, result.max_usd, result.usd_max)
  )
  if (type === 'usd' || usdRange) {
    return normalizeEstimatedCreditRange(
      usdRange.min * COMFY_CREDITS_PER_USD,
      usdRange.max * COMFY_CREDITS_PER_USD
    )
  }

  return null
}

async function evaluateJsonataPriceBadge(priceBadge, workflowNode) {
  if (!priceBadge || typeof priceBadge !== 'object') return null
  if (String(priceBadge.engine || '').trim().toLowerCase() !== 'jsonata') return null
  const expressionSource = String(priceBadge.expr || '').trim()
  if (!expressionSource || !workflowNode || typeof workflowNode !== 'object') return null

  const evaluateWithContext = async (context) => {
    const expression = jsonata(expressionSource)
    return await expression.evaluate(context)
  }

  try {
    const primaryResult = await evaluateWithContext(buildPriceBadgeEvaluationContext(workflowNode, priceBadge))
    const normalizedPrimary = normalizePriceBadgeResultToCredits(primaryResult)
    if (normalizedPrimary) return normalizedPrimary

    const fallbackResult = await evaluateWithContext(
      buildPriceBadgeEvaluationContext(workflowNode, priceBadge, { lowercaseStrings: true })
    )
    return normalizePriceBadgeResultToCredits(fallbackResult)
  } catch (_) {
    return null
  }
}

async function buildWorkflowPricingSnapshot(pack, objectInfo, workflowDefinition = null) {
  const workflowClassTypes = uniqueBy(
    (pack?.requiredNodes || []).map((node) => ({
      classType: String(node?.classType || '').trim(),
    })).filter((node) => node.classType),
    (node) => node.classType
  )

  const badgeSummaries = []
  const creditValues = []
  const evaluatedCreditRanges = []

  for (const nodeInfo of workflowClassTypes) {
    const schema = objectInfo?.[nodeInfo.classType]
    if (!schema) continue
    const badges = collectPriceBadgesFromSchema(schema, [])
    const workflowNodes = getWorkflowNodesByClassType(workflowDefinition, nodeInfo.classType)
    for (const badge of badges) {
      const text = normalizePriceBadgeText(badge)
      if (!text) continue
      badgeSummaries.push({
        classType: nodeInfo.classType,
        text,
      })
      creditValues.push(...extractCreditValuesFromText(text))

      for (const workflowNode of workflowNodes) {
        const evaluatedRange = await evaluateJsonataPriceBadge(badge, workflowNode)
        if (evaluatedRange) {
          evaluatedCreditRanges.push(evaluatedRange)
        }
      }
    }
  }

  const uniqueBadgeSummaries = uniqueBy(
    badgeSummaries,
    (entry) => `${entry.classType}:${entry.text}`
  )
  const uniqueCreditValues = Array.from(new Set(
    creditValues
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
  )).sort((a, b) => a - b)
  const fallbackEstimatedCredits = normalizeEstimatedCreditRange(
    pack?.fallbackEstimatedCredits?.min,
    pack?.fallbackEstimatedCredits?.max
  )

  const estimatedCredits = (
    mergeEstimatedCreditRanges(evaluatedCreditRanges)
    || fallbackEstimatedCredits
    || (
      uniqueCreditValues.length === 1
        ? { min: uniqueCreditValues[0], max: uniqueCreditValues[0] }
        : uniqueCreditValues.length > 1
          ? { min: uniqueCreditValues[0], max: uniqueCreditValues[uniqueCreditValues.length - 1] }
          : null
    )
  )

  return {
    hasPriceMetadata: uniqueBadgeSummaries.length > 0,
    badgeSummaries: uniqueBadgeSummaries,
    creditValues: uniqueCreditValues,
    estimatedCredits,
  }
}

function uniqueBy(items, keyBuilder) {
  const seen = new Set()
  const out = []
  for (const item of items || []) {
    const key = keyBuilder(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

async function getObjectInfoForDependencyCheck(providedObjectInfo) {
  if (providedObjectInfo !== undefined) {
    return providedObjectInfo
  }
  return await comfyui.getObjectInfo()
}

async function resolveComfyRootPath(options = {}) {
  if (typeof options?.comfyRootPath === 'string' && options.comfyRootPath.trim()) {
    return options.comfyRootPath.trim()
  }
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.getSetting) return ''
  try {
    const value = await api.getSetting('comfyRootPath')
    return String(value || '').trim()
  } catch {
    return ''
  }
}

async function verifyUnresolvedModelsOnDisk(unresolvedModels, options = {}) {
  const empty = { success: false, results: [] }
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.checkWorkflowSetupFiles) return empty

  const comfyRootPath = await resolveComfyRootPath(options)
  if (!comfyRootPath) return empty

  const files = unresolvedModels.map((entry) => ({
    filename: entry.filename,
    targetSubdir: entry.targetSubdir || '',
  }))

  try {
    const response = await api.checkWorkflowSetupFiles({ comfyRootPath, files })
    if (!response?.success) return empty
    return { success: true, results: Array.isArray(response.results) ? response.results : [] }
  } catch {
    return empty
  }
}

export async function checkWorkflowDependencies(workflowId, options = {}) {
  const pack = getWorkflowDependencyPack(workflowId)
  const checkedAt = Date.now()

  if (!pack) {
    return {
      workflowId,
      checkedAt,
      hasPack: false,
      status: 'no-pack',
      missingNodes: [],
      missingModels: [],
      unresolvedModels: [],
      missingAuth: false,
      hasBlockingIssues: false,
      hasPriceMetadata: false,
      badgeSummaries: [],
      creditValues: [],
      estimatedCredits: null,
      pack: null,
    }
  }

  let objectInfo = null
  try {
    objectInfo = await getObjectInfoForDependencyCheck(options?.objectInfo)
  } catch (error) {
    return {
      workflowId,
      checkedAt,
      hasPack: true,
      status: 'error',
      error: error instanceof Error ? error.message : String(error || 'Failed to fetch object info'),
      missingNodes: [],
      missingModels: [],
      unresolvedModels: [],
      missingAuth: false,
      hasBlockingIssues: false,
      hasPriceMetadata: false,
      badgeSummaries: [],
      creditValues: [],
      estimatedCredits: null,
      pack,
    }
  }

  const workflowDefinition = await loadBuiltinWorkflowDefinition(workflowId)

  const missingNodes = uniqueBy(
    (pack.requiredNodes || [])
      .filter((node) => !objectInfo?.[node.classType])
      .map((node) => ({
        classType: node.classType,
        notes: node.notes || '',
      })),
    (node) => node.classType
  )

  const missingModels = []
  const unresolvedModels = []

  for (const model of pack.requiredModels || []) {
    const classType = String(model.classType || '').trim()
    const inputKey = String(model.inputKey || '').trim()
    const filename = String(model.filename || '').trim()
    if (!classType || !inputKey || !filename) continue

    const nodeSchema = objectInfo?.[classType]
    if (!nodeSchema) {
      // Missing node will already block. Keep this as unresolved context.
      unresolvedModels.push({
        classType,
        inputKey,
        filename,
        reason: 'missing-node',
        targetSubdir: model.targetSubdir || '',
      })
      continue
    }

    const inputSpec = getInputSpec(nodeSchema, inputKey)
    const choices = extractChoiceListFromSpec(inputSpec)

    if (choices.length === 0) {
      unresolvedModels.push({
        classType,
        inputKey,
        filename,
        reason: 'choices-unavailable',
        targetSubdir: model.targetSubdir || '',
      })
      continue
    }

    // Match by full value first, then by basename: models organized into
    // subfolders (models/diffusion_models/WAN/...) appear in ComfyUI's choice
    // list as relative paths ("WAN/wan2.2.safetensors"), which still satisfy
    // a pack that asks for the bare filename. The queue path rewrites the
    // input to the subfolder value (comfyui.resolveSubfolderModelPaths).
    const lowerFilename = filename.toLowerCase()
    const installedChoices = new Set(choices.map((item) => item.toLowerCase()))
    const installedBasenames = new Set(choices.map((item) => modelChoiceBasename(item)))
    if (!installedChoices.has(lowerFilename) && !installedBasenames.has(lowerFilename)) {
      missingModels.push({
        classType,
        inputKey,
        filename,
        targetSubdir: model.targetSubdir || '',
      })
    }
  }

  let missingAuth = false
  if (pack.requiresComfyOrgApiKey) {
    const apiKey = await comfyui.getComfyOrgApiKey()
    missingAuth = !String(apiKey || '').trim()
  }

  // Filesystem fallback: ComfyUI's object_info sometimes can't enumerate the
  // list of available filenames for a loader input (for example, nodes that
  // declare the input as a free-form STRING instead of a combo). When that
  // happens the model ends up in `unresolvedModels` and the workflow is marked
  // "Partial" even though the user might already have everything installed.
  //
  // To give a more accurate answer we peek at the ComfyUI models folder on
  // disk. Files that are confirmed present get removed from unresolvedModels
  // (so the workflow can report "All set"). Files we can verify are missing
  // are promoted to missingModels so the Install flow can pick them up.
  let resolvedViaFilesystem = false
  if (unresolvedModels.length > 0) {
    const fsCheck = await verifyUnresolvedModelsOnDisk(unresolvedModels, options)
    if (fsCheck.success) {
      const stillUnresolved = []
      for (let i = 0; i < unresolvedModels.length; i += 1) {
        const entry = unresolvedModels[i]
        const fsResult = fsCheck.results[i]
        if (!fsResult) {
          stillUnresolved.push(entry)
          continue
        }
        if (fsResult.exists) {
          resolvedViaFilesystem = true
          continue
        }
        // Only demote to "missing" when the node schema itself was present
        // (so we know the file is genuinely needed). If the node schema was
        // missing we already surface that through missingNodes and don't want
        // to double-report.
        if (entry.reason === 'choices-unavailable') {
          missingModels.push({
            classType: entry.classType,
            inputKey: entry.inputKey,
            filename: entry.filename,
            targetSubdir: entry.targetSubdir || '',
            verifiedMissingOnDisk: true,
          })
        } else {
          stillUnresolved.push(entry)
        }
      }
      unresolvedModels.length = 0
      for (const entry of stillUnresolved) unresolvedModels.push(entry)
    }
  }

  const pricing = await buildWorkflowPricingSnapshot(pack, objectInfo, workflowDefinition)

  const hasBlockingIssues = missingNodes.length > 0 || missingModels.length > 0 || missingAuth
  const status = hasBlockingIssues
    ? 'missing'
    : (unresolvedModels.length > 0 ? 'partial' : 'ready')

  return {
    workflowId,
    checkedAt,
    hasPack: true,
    status,
    missingNodes,
    missingModels,
    unresolvedModels,
    missingAuth,
    hasBlockingIssues,
    hasPriceMetadata: pricing.hasPriceMetadata,
    badgeSummaries: pricing.badgeSummaries,
    creditValues: pricing.creditValues,
    estimatedCredits: pricing.estimatedCredits,
    pack,
  }
}

export async function checkWorkflowDependenciesBatch(workflowIds = []) {
  const normalizedIds = uniqueBy(
    (Array.isArray(workflowIds) ? workflowIds : [])
      .map((workflowId) => String(workflowId || '').trim())
      .filter(Boolean),
    (workflowId) => workflowId
  )

  if (normalizedIds.length === 0) return []

  let objectInfo = null
  try {
    objectInfo = await comfyui.getObjectInfo()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Failed to fetch object info')
    return normalizedIds.map((workflowId) => {
      const pack = getWorkflowDependencyPack(workflowId)
      return {
        workflowId,
        checkedAt: Date.now(),
        hasPack: Boolean(pack),
        status: pack ? 'error' : 'no-pack',
        error: pack ? message : '',
        missingNodes: [],
        missingModels: [],
        unresolvedModels: [],
        missingAuth: false,
        hasBlockingIssues: false,
        hasPriceMetadata: false,
        badgeSummaries: [],
        creditValues: [],
        estimatedCredits: null,
        pack: pack || null,
      }
    })
  }

  // Pre-resolve the comfy root path once so each individual check doesn't
  // round-trip to the main process settings for the same value.
  const comfyRootPath = await resolveComfyRootPath({})

  return await Promise.all(
    normalizedIds.map((workflowId) => checkWorkflowDependencies(workflowId, { objectInfo, comfyRootPath }))
  )
}

export function buildMissingDependencyClipboardText(checkResult) {
  if (!checkResult || !checkResult.hasPack) return 'No dependency pack found for this workflow.'

  const lines = []
  const title = checkResult.pack?.displayName || checkResult.workflowId
  lines.push(`Workflow dependency report: ${title}`)
  lines.push('')

  if (checkResult.missingNodes?.length > 0) {
    lines.push('Missing custom nodes:')
    for (const node of checkResult.missingNodes) {
      lines.push(`- ${node.classType}`)
    }
    lines.push('')
  }

  if (checkResult.missingModels?.length > 0) {
    lines.push('Missing models:')
    for (const model of checkResult.missingModels) {
      const folderHint = model.targetSubdir ? ` -> ComfyUI/models/${model.targetSubdir}` : ''
      lines.push(`- ${model.filename}${folderHint}`)
    }
    lines.push('')
  }

  if (checkResult.missingAuth) {
    lines.push('Missing API key:')
    lines.push('- Configure "Comfy Partner API Key" in Settings before running this workflow.')
    lines.push('')
  }

  if ((checkResult.missingNodes?.length || 0) === 0 && (checkResult.missingModels?.length || 0) === 0 && !checkResult.missingAuth) {
    lines.push('No blocking dependencies detected.')
  }

  return lines.join('\n').trim()
}
