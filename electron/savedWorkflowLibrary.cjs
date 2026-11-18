'use strict'

// A view over the two existing workflow stores, never a third copy of them.
// Resolving a stable library ID must not grant arbitrary filesystem access or
// load/replace the user's currently open ComfyUI graph.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { loadMyWorkflowCatalog } = require('./myWorkflowCatalog.js')
const { loadManagedWorkflowCatalog, readBounded } = require('./managedApiWorkflows.cjs')
const { resolveRunInputs, describeRunInputs } = require('./workflowRunInputs.cjs')
const LIMITS = Object.freeze({ recordBytes: 4 * 1024 * 1024, uiBytes: 2 * 1024 * 1024, entries: 200, overrides: 128 })
const legacyMessage = 'Open this workflow in ComfyUI and save it to Velorn again to enable agent runs. Its older saved copy contains only the editor layout; inspecting it will not replace your open graph.'
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clean = (value, limit = 240) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').slice(0, limit) : ''
const hash = value => createHash('sha256').update(value).digest('hex')
function problem(code, message) { return Object.assign(new Error(message), { code: `SAVED_WORKFLOW_${code}`, publicMessage: message }) }

async function safeDirectory(folder) {
  const stat = await fs.lstat(folder)
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(folder)) !== path.resolve(folder)) {
    throw problem('UNSAFE', 'The saved workflow folder is not a regular local directory.')
  }
}

async function prepareApiGraph(apiWorkflow, { workflowId, title, inputOverrides = [], templateParameters, assetBindings, resolveAsset } = {}) {
  const { validateApiWorkflow, stableWorkflowJson, buildApiWorkflowMetadata } = await import('./workflowApiGraph.mjs')
  let graph
  try { graph = validateApiWorkflow(apiWorkflow) }
  catch { throw problem('NOT_READY', 'The saved API graph is oversized or contains unsupported, unsafe, or credential-like inputs. Review a safe API copy before reuse.') }
  const graphFingerprint = hash(stableWorkflowJson(graph))
  const originalMetadata = buildApiWorkflowMetadata(graph, { name: 'inspection', inspectOnly: true })
  const resolved = await resolveRunInputs(graph, originalMetadata.bindings, { inputOverrides, templateParameters, assetBindings, resolveAsset })
  const seen = new Set(), appliedInputs = []
  for (const override of resolved.changes) {
    if (!plain(override) || Object.keys(override).some(key => !['nodeId', 'input', 'value'].includes(key))
      || typeof override.nodeId !== 'string' || typeof override.input !== 'string' || !Object.hasOwn(override, 'value')) {
      throw problem('INVALID_OVERRIDES', 'Each input override must contain exactly nodeId, input, and value.')
    }
    const { nodeId, input, value } = override
    const node = Object.hasOwn(graph, nodeId) ? graph[nodeId] : null
    const key = JSON.stringify([nodeId, input])
    if (!node || !Object.hasOwn(node.inputs, input) || Array.isArray(node.inputs[input]) || seen.has(key)) {
      throw problem('INVALID_OVERRIDES', 'Overrides must name distinct existing scalar inputs; node links cannot be replaced.')
    }
    const previous = node.inputs[input]
    if ((value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      || (typeof value === 'number' && !Number.isFinite(value))
      || (previous !== null && typeof value !== typeof previous)) {
      throw problem('INVALID_OVERRIDES', 'Input overrides must preserve the saved scalar value type.')
    }
    node.inputs[input] = value
    seen.add(key)
    appliedInputs.push({ nodeId, input, previousValue: previous, value })
  }
  try { graph = validateApiWorkflow(graph) }
  catch { throw problem('INVALID_OVERRIDES', 'An input override is unsafe or exceeds the saved API graph limits. Use ComfyUI-relative media filenames, never credentials, paths, or file URLs.') }
  const metadata = buildApiWorkflowMetadata(graph, { name: 'inspection', inspectOnly: true })
  const prepared = { success: true, ready: true, workflowId, title, format: 'api', workflow: graph,
    graphFingerprint, resolvedFingerprint: hash(stableWorkflowJson(graph)), bindings: metadata.bindings,
    appliedInputs, preparedAssets: resolved.assets, queueInputs: describeRunInputs(graph, metadata.bindings), nodeCount: Object.keys(graph).length,
    readinessMessage: 'Saved API copy available. Dependencies, input files, and spending still require review before generation.' }
  if (Buffer.byteLength(JSON.stringify(prepared)) > 112 * 1024) throw problem('NOT_READY', 'The graph plus exact input bindings exceeds the bounded inspection limit. Save a smaller API copy before reuse.')
  return prepared
}

function createSavedWorkflowLibrary({ getUserData, resolveAsset }) {
  async function catalog() {
    const userData = await getUserData()
    await safeDirectory(userData)
    const customDirectory = path.join(userData, 'custom-workflows')
    const [custom, managed] = await Promise.all([
      loadMyWorkflowCatalog(userData, { fs: {
        async readdir(folder) { await safeDirectory(folder); return (await fs.readdir(folder)).filter(name => /^[^/\\]+\.json$/i.test(name)).sort().slice(0, LIMITS.entries) },
        async readFile(file) { await safeDirectory(customDirectory); return readBounded(file, LIMITS.recordBytes) },
      } }),
      loadManagedWorkflowCatalog(userData),
    ])
    return { success: custom.success || managed.success, workflows: [...custom.workflows, ...managed.workflows],
      warnings: [...custom.errors, ...managed.errors] }
  }
  async function resolve(workflowId) {
    if (typeof workflowId !== 'string' || workflowId.length > 200
      || !/^(?:my-workflow:[A-Za-z0-9][A-Za-z0-9_.-]*|tpl-mcp-[a-z0-9][a-z0-9-]{0,47})$/.test(workflowId)) {
      throw problem('INVALID_ID', 'Choose an exact saved workflow ID from the library; file paths are not accepted.')
    }
    const found = (await catalog()).workflows.filter(entry => entry.id === workflowId)
    if (found.length !== 1) throw problem('NOT_FOUND', 'That saved workflow is missing or ambiguous. Refresh the library and choose it again.')
    const entry = found[0]
    await safeDirectory(path.dirname(entry.path))
    const raw = await readBounded(entry.path, entry.source === 'my-workflows' ? LIMITS.recordBytes : 96 * 1024)
    const record = JSON.parse(raw)
    if (entry.source === 'my-workflows' && `my-workflow:${record.id}` !== workflowId) throw problem('CHANGED', 'The saved workflow identity changed. Refresh the library.')
    return { entry, record }
  }
  async function list() {
    try {
      const result = await catalog()
      return { success: result.success, warnings: result.warnings.map(() => 'An unreadable or unsafe saved workflow was skipped.'), workflows: result.workflows.map(entry => {
        const api = entry.source === 'imported' || entry.hasApiWorkflow === true
        return { id: entry.id, libraryId: entry.libraryId, title: clean(entry.label), label: clean(entry.label),
          description: clean(entry.savedDescription || (entry.source === 'imported' ? entry.description : ''), 2000),
          source: entry.source, format: api ? 'api' : 'ui', hasUiWorkflow: entry.source === 'my-workflows',
          nodeCount: entry.nodeCount || null, updatedAt: entry.updatedAt || null, outputType: entry.outputType || null,
          readiness: api ? 'needs-review' : 'needs-api-capture', savedRunsReady: api,
          readinessMessage: api ? 'Saved API copy available; inspect before generation.' : legacyMessage }
      }) }
    } catch { return { success: false, workflows: [], error: 'The saved workflow library could not be read.' } }
  }
  async function read({ workflowId } = {}) {
    try {
      const { entry, record } = await resolve(workflowId)
      if (entry.source === 'my-workflows') {
        if (!plain(record.uiWorkflow) || Buffer.byteLength(JSON.stringify(record.uiWorkflow)) > LIMITS.uiBytes) throw problem('NOT_READY', 'The saved editor graph is missing or too large to open.')
        return { success: true, workflowId, title: clean(entry.label), format: 'ui', uiWorkflow: record.uiWorkflow }
      }
      return await prepareApiGraph(record, { workflowId, title: clean(entry.label) })
    } catch (error) { return { success: false, error: error.publicMessage || 'The saved workflow could not be read.', code: error.code || 'SAVED_WORKFLOW_UNAVAILABLE' } }
  }
  async function prepare({ workflowId, inputOverrides, templateParameters, assetBindings } = {}) {
    try {
      const { entry, record } = await resolve(workflowId)
      const graph = entry.source === 'my-workflows' ? record.apiWorkflow : record
      if (!plain(graph)) throw problem('NEEDS_API_CAPTURE', legacyMessage)
      return await prepareApiGraph(graph, { workflowId, title: clean(entry.label), inputOverrides, templateParameters, assetBindings, resolveAsset })
    } catch (error) { return { success: false, ready: false, workflowId, error: error.publicMessage || 'The saved workflow could not be prepared.', code: error.code || 'SAVED_WORKFLOW_UNAVAILABLE' } }
  }
  return { list, read, prepare }
}

const CHANNELS = Object.freeze({ list: 'saved-workflows:list', read: 'saved-workflows:read', prepare: 'saved-workflows:prepare' })
function registerSavedWorkflowLibraryIpc({ ipcMain, getMainWindow, getLibrary }) {
  for (const [method, channel] of Object.entries(CHANNELS)) ipcMain.handle(channel, async (event, payload = {}) => {
    const window = getMainWindow()
    const authorized = () => window && getMainWindow() === window && !window.isDestroyed() && !window.webContents.isDestroyed()
      && event?.sender === window.webContents && event.senderFrame && event.senderFrame === window.webContents.mainFrame
    if (!authorized()) return { success: false, code: 'SAVED_WORKFLOW_UNAUTHORIZED', error: 'Saved workflows are available in the main Velorn window.' }
    if (!plain(payload) || Object.keys(payload).some(key => !['workflowId'].includes(key))) {
      return { success: false, code: 'SAVED_WORKFLOW_INVALID_REQUEST', error: 'Choose a saved workflow ID, not a file path.' }
    }
    try {
      const result = await getLibrary()[method](payload)
      return authorized() ? result : { success: false, error: 'The Velorn window changed. Inspect the workflow again.' }
    } catch { return { success: false, error: 'The saved workflow could not be read.' } }
  })
  return { dispose() { for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler?.(channel) } }
}

module.exports = { createSavedWorkflowLibrary, registerSavedWorkflowLibraryIpc, prepareApiGraph, CHANNELS, LIMITS }
