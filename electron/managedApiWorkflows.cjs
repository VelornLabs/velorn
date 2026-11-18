'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const slug = /^[a-z0-9][a-z0-9-]{0,47}$/
const managedName = /^mcp-[a-z0-9][a-z0-9-]{0,47}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const graphModule = () => import('./workflowApiGraph.mjs')

async function directory(target, { missing = false } = {}) {
  let stat
  try { stat = await fs.lstat(target) } catch (error) { if (missing && error.code === 'ENOENT') return false; throw error }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed workflow directory is unsafe.')
  if (path.resolve(await fs.realpath(target)) !== path.resolve(target)) throw new Error('Managed workflow path crosses a symbolic link.')
  return true
}
async function readBounded(file, maxBytes) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Managed workflow file is unsafe or too large.')
  const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0))
  try {
    const fresh = await handle.stat()
    if (fresh.ino !== stat.ino || fresh.dev !== stat.dev || fresh.size > maxBytes) throw new Error('Managed workflow file changed while reading.')
    const data = await handle.readFile('utf8')
    if (Buffer.byteLength(data) > maxBytes) throw new Error('Managed workflow file exceeds its limit.')
    return data
  } finally { await handle.close() }
}
async function targetState(base, templateName) {
  const dir = path.join(base, templateName)
  if (!await directory(base, { missing: true }) || !await directory(dir, { missing: true })) return { fingerprint: 'absent', exists: false, dir }
  const entryText = await readBounded(path.join(dir, 'entry.json'), 256 * 1024)
  const workflowText = await readBounded(path.join(dir, 'workflow.json'), 96 * 1024)
  const entry = JSON.parse(entryText)
  if (entry.workflowId !== `tpl-${templateName}` || entry.templateName !== templateName) throw new Error('Managed workflow identity does not match its folder.')
  return { exists: true, dir, entry, workflowText, fingerprint: hash(`${entryText}\n${workflowText}`) }
}

function modelDependencies(metadata, hints = []) {
  if (!Array.isArray(hints) || hints.length > 20) throw new Error('Use at most 20 model URL hints.')
  const directories = { ckpt_name: 'checkpoints', lora_name: 'loras', vae_name: 'vae', clip_name: 'text_encoders', unet_name: 'diffusion_models', audio_vae: 'vae', text_encoder: 'text_encoders', upscale_model: 'upscale_models' }
  const requiredModels = [], recipes = []
  for (const model of metadata.models) {
    const hint = hints.find(item => typeof item?.filename === 'string' && item.filename.toLowerCase() === model.filename.toLowerCase())
    const targetSubdir = String(hint?.targetSubdir || model.targetSubdir || directories[model.inputKey] || '')
    if (targetSubdir && !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(targetSubdir)) throw new Error('Model targetSubdir must stay inside a ComfyUI model category.')
    requiredModels.push({ classType: model.nodeType, inputKey: model.inputKey, filename: model.filename, targetSubdir })
    if (!hint?.url) continue
    const url = new URL(hint.url)
    if (url.protocol !== 'https:' || url.username || url.password || /[?&](?:token|api_key|signature|password)=/i.test(url.href)) throw new Error('Model URL hints must be public HTTPS URLs without credentials.')
    if (!targetSubdir) throw new Error('A model URL hint needs targetSubdir when its category is unknown.')
    recipes.push({ filename: model.filename, targetSubdir, displayName: model.filename, downloadUrl: url.href, sourceUrl: url.href, sizeBytes: null, sha256: '', notes: 'Explicit model URL supplied for a managed API workflow. Installation requires separate approval.' })
  }
  return { requiredModels, recipes }
}

function createManagedApiWorkflowStore({ getUserData, validateNodes, beforeCommit = async () => {} }) {
  let tail = Promise.resolve()
  const run = async args => {
    const { validateApiWorkflow, buildApiWorkflowMetadata, stableWorkflowJson } = await graphModule()
    const workflow = validateApiWorkflow(args.workflowJson)
    if (!slug.test(args.name || '')) throw new Error('API import requires an explicit lowercase name slug; it always creates a managed copy.')
    const metadata = buildApiWorkflowMetadata(workflow, args)
    const dependencies = modelDependencies(metadata, args.modelUrls)
    const sourceFingerprint = hash(stableWorkflowJson({ workflow, name: args.name, title: metadata.title, outputType: metadata.outputType, dependencies }))
    const userData = await getUserData()
    await directory(userData)
    const base = path.join(userData, 'generate-templates')
    const state = await targetState(base, metadata.templateName)
    if (state.exists && args.overwrite !== true && args.previewOnly === false) throw new Error('That managed workflow already exists. Inspect it and preview overwrite:true first.')
    const checked = await validateNodes({ nodeClasses: metadata.nodeClasses })
    const runnable = checked?.validation?.ok === true
    const missing = checked?.validation?.missing || metadata.nodeClasses
    const entry = {
      workflowId: metadata.workflowId, templateName: metadata.templateName,
      manifest: { id: metadata.workflowId, workflowId: metadata.workflowId, title: metadata.title, subtitle: 'Managed ComfyUI API workflow',
        description: 'API graph imported without execution. Local ComfyUI execution does not certify local-only or free generation. Spending behavior is unverified.', mode: 'generate', route: 'local', provider: 'ComfyUI', spendingRisk: 'unknown',
        category: metadata.outputType === 'video' ? metadata.needsImage ? 'image-to-video' : 'text-to-video' : metadata.outputType === 'image' ? metadata.needsImage ? 'image-edit' : 'text-to-image' : 'audio',
        outputType: metadata.outputType, needsImage: metadata.needsImage, inputAssetType: metadata.inputAssetType, fields: metadata.fields,
        runnable, imported: true, templateName: metadata.templateName, unknownNodeTypes: missing, tags: ['mcp-import', 'api-workflow'] },
      pack: { id: metadata.workflowId, displayName: metadata.title, requiredNodes: metadata.nodeClasses.map(classType => ({ classType })), requiredModels: dependencies.requiredModels, requiresComfyOrgApiKey: false },
      bindings: metadata.bindings, recipes: dependencies.recipes, nodePackRecipes: [], uncoveredNodeTypes: missing,
      unresolvedNodePacks: [], conversionIncomplete: false, template: { name: metadata.templateName, title: metadata.title, openSource: true, workflowUrl: '', sourceUrl: '', tags: ['api-workflow'], models: [], requiresCustomNodes: [] },
      source: { format: 'api', fingerprint: sourceFingerprint }, importedAt: Date.now(),
    }
    if (Buffer.byteLength(JSON.stringify(entry)) > 192 * 1024) throw new Error('Workflow bindings and metadata exceed the managed entry limit. Use a smaller workflow.')
    const plan = { workflowId: metadata.workflowId, format: 'api', name: args.name, title: metadata.title, outputType: metadata.outputType,
      nodeCount: Object.keys(workflow).length, nodeClasses: metadata.nodeClasses, runnable, missingNodeClasses: missing,
      bindings: metadata.bindings, modelReferences: dependencies.requiredModels, overwrite: state.exists, sourceFingerprint, targetFingerprint: state.fingerprint,
      warnings: ['Import saves a managed workflow copy; it does not execute nodes, queue generation, install dependencies, or change bundled workflows.',
        'Custom ComfyUI nodes may write outputs, call external services or spend credits when separately queued. Node availability is not a security or cost certification.',
        'Numeric parameters are exact node input bindings. General duration/FPS/resolution fields do not imply an imported graph was changed; review the binding keys.',
        ...(!runnable ? ['ComfyUI node availability is unverified or incomplete. Inspect/install dependencies separately before queueing.'] : []),
        ...(metadata.outputType === 'audio' ? ['The timeline-template queue currently needs an image/video source; this audio graph can be saved for review but may require another compatible UI queue route.'] : [])] }
    if (Buffer.byteLength(JSON.stringify(plan)) > 100 * 1024) throw new Error('Workflow inspection plan exceeds its response limit. Use a smaller workflow; nothing was saved.')
    if (args.previewOnly !== false) return { previewOnly: true, plan, suggestedApplyPayload: { sourceFingerprint, targetFingerprint: state.fingerprint, previewOnly: false } }
    if (args.sourceFingerprint !== sourceFingerprint || args.targetFingerprint !== state.fingerprint) throw new Error('Workflow source or managed target changed. Preview again before applying.')
    await fs.mkdir(base, { recursive: true })
    await directory(base)
    const temporary = await fs.mkdtemp(path.join(base, '.api-stage-'))
    let committed = false, backup = null
    try {
      await fs.chmod(temporary, 0o700)
      await fs.writeFile(path.join(temporary, 'workflow.json'), stableWorkflowJson(workflow), { flag: 'wx', mode: 0o600 })
      await fs.writeFile(path.join(temporary, 'entry.json'), JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
      await beforeCommit()
      const latest = await targetState(base, metadata.templateName)
      if (latest.fingerprint !== state.fingerprint) throw new Error('Managed workflow changed before commit. Preview again; nothing was replaced.')
      if (state.exists) { backup = path.join(base, `.api-backup-${metadata.templateName}-${randomUUID()}`); await fs.rename(state.dir, backup) }
      try { await fs.rename(temporary, state.dir); committed = true }
      catch (error) { if (backup) await fs.rename(backup, state.dir); throw error }
      return { success: true, previewOnly: false, workflowId: metadata.workflowId, runnable,
        message: 'Managed API workflow saved. Generation and dependency installation remain separate actions.',
        backupId: backup ? path.basename(backup) : null,
        entry: { ...entry, workflowPath: path.join(state.dir, 'workflow.json') }, plan }
    } finally { if (!committed) await fs.rm(temporary, { recursive: true, force: true }) }
  }
  return { importWorkflow(args) { const next = tail.then(() => run(args)); tail = next.catch(() => {}); return next } }
}

async function loadManagedWorkflowCatalog(userData) {
  const base = path.join(userData, 'generate-templates'), workflows = [], errors = []
  try {
    if (!await directory(base, { missing: true })) return { success: true, workflows, errors }
    const names = (await fs.readdir(base)).filter(name => managedName.test(name)).slice(0, 200)
    for (const templateName of names) {
      try {
        const state = await targetState(base, templateName)
        const entry = state.entry
        // UI imports also persist a converted API graph. Keep their provenance
        // untouched: stamping format:'api' would change renderer re-import behavior.
        const convertedImport = entry?.source?.format == null
          && entry?.manifest?.imported === true && entry.conversionIncomplete === false
          && entry?.template?.name === templateName
        if (entry?.source?.format !== 'api' && !convertedImport) continue
        if (entry.conversionIncomplete === true) throw new Error('Workflow conversion is incomplete.')
        const { validateApiWorkflow } = await graphModule()
        validateApiWorkflow(JSON.parse(state.workflowText))
        const manifest = entry.manifest || {}
        workflows.push({ id: entry.workflowId, label: manifest.title || templateName, category: manifest.outputType || 'custom', runtime: 'local', spendingRisk: 'unknown',
          outputType: manifest.outputType, needsImage: Boolean(manifest.needsImage), file: 'workflow.json', path: path.join(state.dir, 'workflow.json'), source: 'imported',
          description: manifest.description || '', updatedAt: entry.importedAt || null,
          mcpRunnable: manifest.runnable === true, readinessMessage: 'Managed API workflow. Inspect includeGraph:true, preview queue_comfyui_workflow with workflowId and named or exact inputOverrides, then apply the same inputs and returned fingerprints when generation is authorized. Spending is assessed on apply; unknown here is not a denial. Under ask-cloud the apply call opens native confirmation when needed; previews and status checks do not.',
          requiredAssetFields: (manifest.fields || []).filter(field => field.type === 'assetSelect' && field.required), bindings: entry.bindings,
          sourceFingerprint: entry.source?.fingerprint || hash(state.workflowText), targetFingerprint: state.fingerprint })
      } catch (error) { errors.push(`Skipped managed workflow ${templateName}: ${error.message}`) }
    }
    return { success: true, workflows, errors }
  } catch (error) { return { success: false, workflows, errors: [error.message] } }
}

module.exports = { createManagedApiWorkflowStore, loadManagedWorkflowCatalog, readBounded }
