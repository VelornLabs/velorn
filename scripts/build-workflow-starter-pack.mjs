#!/usr/bin/env node

import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXTRA_STARTER_PACK_WORKFLOWS = Object.freeze([
  {
    id: 'image-edit-model-product',
    label: 'Qwen Image Edit 2509 (Model + Product)',
    category: 'image',
    description: 'Local image-edit workflow used by Director Mode for combined model and product keyframes.',
  },
])

const CATEGORY_ORDER = Object.freeze({
  video: 0,
  image: 1,
  audio: 2,
})

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const outputDir = path.join(repoRoot, 'docs', 'workflow-starter-pack')
const docsDir = path.join(outputDir, 'docs')
const workflowDocsDir = path.join(docsDir, 'workflows')
const setupWorkflowsDir = path.join(outputDir, 'workflows')
const localSetupWorkflowsDir = path.join(setupWorkflowsDir, 'local')
const cloudSetupWorkflowsDir = path.join(setupWorkflowsDir, 'cloud')
const nodesDir = path.join(outputDir, 'nodes')
const modelsDir = path.join(outputDir, 'models')
const checksumsDir = path.join(outputDir, 'checksums')
const checksumFile = path.join(checksumsDir, 'SHA256SUMS.txt')

function uniqueSorted(list = []) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)))
    .sort((a, b) => String(a).localeCompare(String(b)))
}

function normalizeWorkflowId(value) {
  const id = String(value || '').trim()
  return id === 'nano-banana-pro' ? 'nano-banana-2' : id
}

function toPosixPath(value = '') {
  return String(value || '').split(path.sep).join('/')
}

function inferSourceWorkflowFilename(appWorkflowPath) {
  const value = String(appWorkflowPath || '').trim()
  if (!value.startsWith('/workflows/')) return null
  return value.slice('/workflows/'.length)
}

function getGitCommit() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function loadConfigModules() {
  const registryPath = pathToFileURL(path.join(repoRoot, 'src', 'config', 'workflowRegistry.js')).href
  const dependencyPath = pathToFileURL(path.join(repoRoot, 'src', 'config', 'workflowDependencyPacks.js')).href
  const workspaceConfigPath = pathToFileURL(path.join(repoRoot, 'src', 'config', 'generateWorkspaceConfig.js')).href
  const installCatalogPath = pathToFileURL(path.join(repoRoot, 'src', 'config', 'workflowInstallCatalog.js')).href

  const registry = await import(registryPath)
  const dependency = await import(dependencyPath)
  const workspaceConfig = await import(workspaceConfigPath)
  const installCatalog = await import(installCatalogPath)
  return { registry, dependency, workspaceConfig, installCatalog }
}

function buildWorkflowCatalog(BUILTIN_WORKFLOWS, BUILTIN_WORKFLOW_PATHS) {
  const catalog = []
  const seen = new Set()

  for (const workflow of BUILTIN_WORKFLOWS) {
    const id = normalizeWorkflowId(workflow.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    catalog.push({ ...workflow, id })
  }

  for (const workflow of EXTRA_STARTER_PACK_WORKFLOWS) {
    const id = normalizeWorkflowId(workflow.id)
    if (!id || seen.has(id) || !BUILTIN_WORKFLOW_PATHS[id]) continue
    seen.add(id)
    catalog.push({ ...workflow, id })
  }

  return catalog.sort((left, right) => {
    const categoryCompare = (CATEGORY_ORDER[left.category] ?? 99) - (CATEGORY_ORDER[right.category] ?? 99)
    if (categoryCompare !== 0) return categoryCompare
    return left.label.localeCompare(right.label)
  })
}

function buildManifestEntry(
  workflow,
  workflowPaths,
  getWorkflowDependencyPack,
  getWorkflowHardwareInfo,
  getNodeInstallInfo,
  getModelInstallInfo
) {
  const workflowId = normalizeWorkflowId(workflow.id)
  const dependencyPack = getWorkflowDependencyPack(workflowId)
  const hardwareInfo = getWorkflowHardwareInfo(workflowId)
  const appWorkflowPath = workflowPaths[workflowId] || null
  const sourceWorkflowFilename = inferSourceWorkflowFilename(appWorkflowPath)
  const runtime = hardwareInfo?.runtime || (dependencyPack?.requiresComfyOrgApiKey ? 'cloud' : 'local')
  const tier = hardwareInfo?.tierId || 'unknown'
  const setupWorkflowFile = sourceWorkflowFilename ? `workflows/${runtime}/${workflowId}.comfyui.json` : null
  const workflowGuideFile = `docs/workflows/${workflowId}.md`
  const requiredNodesDetailed = uniqueSorted((dependencyPack?.requiredNodes || []).map((node) => String(node?.classType || '').trim()))
    .map((classType) => ({
      classType,
      install: getNodeInstallInfo(classType),
    }))
  const requiredNodes = requiredNodesDetailed.map((entry) => entry.classType)
  const requiredModels = (dependencyPack?.requiredModels || [])
    .map((model) => ({
      filename: String(model?.filename || '').trim(),
      targetSubdir: String(model?.targetSubdir || '').trim(),
      classType: String(model?.classType || '').trim(),
      inputKey: String(model?.inputKey || '').trim(),
      install: getModelInstallInfo({
        filename: String(model?.filename || '').trim(),
        targetSubdir: String(model?.targetSubdir || '').trim(),
      }),
    }))
    .filter((model) => model.filename)
    .sort((left, right) => left.filename.localeCompare(right.filename))

  return {
    id: workflowId,
    label: workflow.label,
    category: workflow.category,
    description: workflow.description || '',
    tier,
    runtime,
    appWorkflowPath,
    appWorkflowFile: sourceWorkflowFilename ? `public/workflows/${sourceWorkflowFilename}` : null,
    sourceWorkflowFilename,
    setupWorkflowFile,
    setupWorkflowStatus: 'pending',
    workflowGuideFile,
    requiresComfyOrgApiKey: Boolean(dependencyPack?.requiresComfyOrgApiKey),
    docsUrl: dependencyPack?.docsUrl || null,
    requiredNodes,
    requiredNodesDetailed,
    requiredModels,
  }
}

function renderWorkflowMarkdown(entry) {
  const lines = []
  lines.push(`# ${entry.label}`)
  lines.push('')
  lines.push(entry.description || 'Workflow setup checklist for advanced ComfyUI users.')
  lines.push('')
  lines.push(`- **Workflow ID:** \`${entry.id}\``)
  lines.push(`- **Category:** \`${entry.category}\``)
  lines.push(`- **Tier:** \`${entry.tier}\``)
  lines.push(`- **Runtime:** \`${entry.runtime}\``)
  lines.push(`- **App Workflow JSON:** \`${entry.appWorkflowPath || 'unknown'}\``)
  lines.push(`- **Starter Pack Setup Workflow:** \`${entry.setupWorkflowFile || 'not available'}\``)
  lines.push(`- **Setup Workflow Status:** \`${entry.setupWorkflowStatus}\``)
  lines.push('')

  lines.push('## What This Setup Workflow Is')
  lines.push('- A ComfyUI-importable copy of the workflow graph bundled with Velorn.')
  lines.push('- Use it to inspect missing nodes, model loaders, and expected filenames directly inside ComfyUI.')
  if (entry.runtime === 'cloud') {
    lines.push('- This is still a cloud workflow: local model weights are usually not required, but the partner node and API key still are.')
  } else {
    lines.push('- This is a local workflow: expect to install the listed custom nodes and local model files before it runs successfully.')
  }
  lines.push('')

  lines.push('## Required Custom Nodes')
  if (entry.requiredNodesDetailed.length === 0) {
    lines.push('- None declared')
  } else {
    for (const node of entry.requiredNodesDetailed) {
      const installMode = node.install?.kind === 'auto'
        ? 'Auto-install supported'
        : node.install?.kind === 'core'
          ? 'Built into newer ComfyUI builds'
          : 'Manual setup'
      lines.push(`- \`${node.classType}\` - ${installMode}`)
      if (node.install?.notes) {
        lines.push(`  - ${node.install.notes}`)
      }
      if (node.install?.repoUrl) {
        lines.push(`  - Repo: ${node.install.repoUrl}`)
      } else if (node.install?.docsUrl) {
        lines.push(`  - Docs: ${node.install.docsUrl}`)
      }
    }
  }
  lines.push('')

  lines.push('## Required Models')
  if (entry.requiredModels.length === 0) {
    lines.push('- None declared')
  } else {
    lines.push('| Filename | ComfyUI Folder | Loader | Input Key | Download |')
    lines.push('|---|---|---|---|---|')
    for (const model of entry.requiredModels) {
      const folder = model.targetSubdir ? `models/${model.targetSubdir}` : 'unknown'
      const downloadText = model.install?.downloadUrl ? `[Download](${model.install.downloadUrl})` : 'Manual'
      lines.push(`| \`${model.filename}\` | \`${folder}\` | \`${model.classType || '-'}\` | \`${model.inputKey || '-'}\` | ${downloadText} |`)
    }
  }
  lines.push('')

  lines.push('## API Key')
  lines.push(entry.requiresComfyOrgApiKey
    ? '- Requires a Comfy account API key in `Settings > ComfyUI Connection > Comfy Account API Key`.'
    : '- Not required for this workflow.')
  lines.push('')

  lines.push('## Setup Steps')
  lines.push(`1. Import \`${entry.setupWorkflowFile || 'the packaged workflow JSON'}\` into ComfyUI.`)
  lines.push('2. Let ComfyUI show any missing custom nodes, then install them in ComfyUI Manager.')
  if (entry.requiredModels.length > 0) {
    lines.push('3. Place the required model files into the folders listed above.')
    lines.push('4. Re-open the workflow in ComfyUI and confirm all loaders resolve.')
    lines.push('5. Return to Velorn Generate and click `Re-check` before queueing.')
  } else {
    lines.push('3. Re-open the workflow in ComfyUI and confirm the required partner/custom nodes load cleanly.')
    if (entry.requiresComfyOrgApiKey) {
      lines.push('4. Add your Comfy account API key in Velorn Settings before queueing.')
      lines.push('5. Return to Velorn Generate and click `Re-check` before queueing.')
    } else {
      lines.push('4. Return to Velorn Generate and click `Re-check` before queueing.')
    }
  }
  lines.push('')

  lines.push('## Related Guides')
  lines.push('- `../WHERE_FILES_GO.md`')
  lines.push('- `../API_KEYS.md`')
  lines.push('- `../TROUBLESHOOTING.md`')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderIndexMarkdown(entries) {
  const lines = []
  lines.push('# Workflow Starter Pack Index')
  lines.push('')
  lines.push('_Auto-generated by `npm run starter-pack:build`._')
  lines.push('')
  lines.push('This pack is for advanced ComfyUI users who want to inspect workflows directly in ComfyUI and prepare dependencies manually.')
  lines.push('')
  lines.push('| Workflow | ID | Tier | Runtime | Setup Workflow | Guide | API Key |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const entry of entries) {
    lines.push(`| ${entry.label} | \`${entry.id}\` | \`${entry.tier}\` | \`${entry.runtime}\` | [\`${path.basename(entry.setupWorkflowFile || 'missing')}\`](${entry.setupWorkflowFile || '#'}) | [Guide](${entry.workflowGuideFile}) | ${entry.requiresComfyOrgApiKey ? 'Required' : 'Not required'} |`)
  }
  lines.push('')
  lines.push('## Maintenance')
  lines.push('- Add/update workflows in `src/config/workflowRegistry.js`.')
  lines.push('- Keep dependency definitions in `src/config/workflowDependencyPacks.js`.')
  lines.push('- Run `npm run starter-pack:build` after workflow changes.')
  lines.push('- Package a versioned zip with `npm run starter-pack:package` before publishing a release asset.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderReleaseNotes(releaseMetadata) {
  const lines = []
  lines.push(`# Workflow Starter Pack v${releaseMetadata.starterPackVersion}`)
  lines.push('')
  lines.push(`Generated for Velorn v${releaseMetadata.compatibleAppVersion}.`)
  lines.push('')
  lines.push('## What Is Included')
  lines.push('')
  lines.push(`- ${releaseMetadata.totalWorkflows} workflow setup guides`)
  lines.push(`- ${releaseMetadata.localWorkflowCount} local workflow JSONs for ComfyUI import`)
  lines.push(`- ${releaseMetadata.cloudWorkflowCount} cloud/partner workflow JSONs for ComfyUI import`)
  lines.push('- aggregated custom-node and model manifests')
  lines.push('- where-files-go, API key, and troubleshooting docs')
  lines.push('')
  lines.push('## Who This Is For')
  lines.push('')
  lines.push('- Advanced ComfyUI users who want to inspect workflows directly in ComfyUI')
  lines.push('- Users who prefer to install nodes and models manually before queueing inside Velorn')
  lines.push('')
  lines.push('## Important Notes')
  lines.push('')
  lines.push('- This pack does not replace the Velorn desktop app.')
  lines.push('- This pack does not include ComfyUI itself.')
  lines.push('- Cloud workflows still require local ComfyUI plus the relevant partner nodes and API key.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function buildCustomNodeManifest(entries, getNodeInstallInfo) {
  const nodes = new Map()
  for (const entry of entries) {
    for (const classType of entry.requiredNodes) {
      const current = nodes.get(classType) || {
        classType,
        workflows: [],
        runtimes: [],
        docsUrls: [],
      }
      current.workflows.push(entry.id)
      current.runtimes.push(entry.runtime)
      if (entry.docsUrl) current.docsUrls.push(entry.docsUrl)
      nodes.set(classType, current)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalNodes: nodes.size,
    nodes: Array.from(nodes.values())
      .map((entry) => {
        const install = getNodeInstallInfo(entry.classType)
        return {
          classType: entry.classType,
          workflows: uniqueSorted(entry.workflows),
          runtimes: uniqueSorted(entry.runtimes),
          installDocs: install?.docsUrl || uniqueSorted(entry.docsUrls)[0] || null,
          installKind: install?.kind || 'manual',
          repoUrl: install?.repoUrl || null,
          installDirName: install?.installDirName || null,
          requirementsStrategy: install?.requirementsStrategy || null,
          fallbackRepoUrl: install?.fallbackRepoUrl || null,
          notes: install?.notes || '',
          searchTerm: install?.searchTerm || entry.classType,
        }
      })
      .sort((left, right) => left.classType.localeCompare(right.classType)),
  }
}

function buildModelManifest(entries, getModelInstallInfo) {
  const models = new Map()
  for (const entry of entries) {
    for (const model of entry.requiredModels) {
      const key = `${model.targetSubdir}::${model.filename}`
      const current = models.get(key) || {
        filename: model.filename,
        targetSubdir: model.targetSubdir,
        folder: model.targetSubdir ? `models/${model.targetSubdir}` : null,
        loaders: [],
        inputKeys: [],
        workflows: [],
      }
      current.loaders.push(model.classType)
      current.inputKeys.push(model.inputKey)
      current.workflows.push(entry.id)
      models.set(key, current)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalModels: models.size,
    models: Array.from(models.values())
      .map((entry) => {
        const install = getModelInstallInfo({
          filename: entry.filename,
          targetSubdir: entry.targetSubdir,
        })
        return {
          filename: entry.filename,
          targetSubdir: entry.targetSubdir,
          folder: entry.folder,
          loaders: uniqueSorted(entry.loaders),
          inputKeys: uniqueSorted(entry.inputKeys),
          workflows: uniqueSorted(entry.workflows),
          downloadUrl: install?.downloadUrl || null,
          sourceUrl: install?.sourceUrl || null,
          licenseUrl: install?.licenseUrl || null,
          sizeBytes: Number.isFinite(install?.sizeBytes) ? install.sizeBytes : null,
          sha256: install?.sha256 || null,
          autoInstallSupported: Boolean(install?.downloadUrl),
          notes: install?.notes || '',
        }
      })
      .sort((left, right) => left.filename.localeCompare(right.filename)),
  }
}

async function copySetupWorkflow(entry) {
  if (!entry.sourceWorkflowFilename || !entry.setupWorkflowFile) return
  const sourcePath = path.join(repoRoot, 'public', 'workflows', entry.sourceWorkflowFilename)
  const targetPath = path.join(outputDir, entry.setupWorkflowFile)
  const sourceExists = await exists(sourcePath)
  entry.setupWorkflowStatus = sourceExists ? 'available' : 'missing'
  if (!sourceExists) return
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.copyFile(sourcePath, targetPath)
}

async function listFilesRecursively(targetDir) {
  const output = []
  const items = await fs.readdir(targetDir, { withFileTypes: true })
  for (const item of items) {
    const absolutePath = path.join(targetDir, item.name)
    if (item.isDirectory()) {
      output.push(...await listFilesRecursively(absolutePath))
    } else {
      output.push(absolutePath)
    }
  }
  return output
}

async function writeChecksums() {
  await fs.mkdir(checksumsDir, { recursive: true })
  const files = await listFilesRecursively(outputDir)
  const entries = []
  for (const absolutePath of files) {
    const relativePath = toPosixPath(path.relative(outputDir, absolutePath))
    if (!relativePath || relativePath === 'checksums/SHA256SUMS.txt') continue
    const buffer = await fs.readFile(absolutePath)
    const digest = crypto.createHash('sha256').update(buffer).digest('hex')
    entries.push(`${digest}  ${relativePath}`)
  }
  entries.sort((left, right) => left.localeCompare(right))
  await fs.writeFile(checksumFile, `${entries.join('\n')}\n`, 'utf8')
}

async function main() {
  const { registry, dependency, workspaceConfig, installCatalog } = await loadConfigModules()
  const { BUILTIN_WORKFLOWS = [], BUILTIN_WORKFLOW_PATHS = {} } = registry
  const { getWorkflowDependencyPack } = dependency
  const { getWorkflowHardwareInfo } = workspaceConfig
  const { getNodeInstallInfo, getModelInstallInfo } = installCatalog

  const workflowCatalog = buildWorkflowCatalog(BUILTIN_WORKFLOWS, BUILTIN_WORKFLOW_PATHS)
  const entries = workflowCatalog.map((workflow) => (
    buildManifestEntry(
      workflow,
      BUILTIN_WORKFLOW_PATHS,
      getWorkflowDependencyPack,
      getWorkflowHardwareInfo,
      getNodeInstallInfo,
      getModelInstallInfo
    )
  ))

  await fs.mkdir(outputDir, { recursive: true })
  await fs.mkdir(docsDir, { recursive: true })
  await fs.rm(workflowDocsDir, { recursive: true, force: true })
  await fs.rm(setupWorkflowsDir, { recursive: true, force: true })
  await fs.rm(nodesDir, { recursive: true, force: true })
  await fs.rm(modelsDir, { recursive: true, force: true })
  await fs.rm(checksumsDir, { recursive: true, force: true })
  await fs.mkdir(workflowDocsDir, { recursive: true })
  await fs.mkdir(localSetupWorkflowsDir, { recursive: true })
  await fs.mkdir(cloudSetupWorkflowsDir, { recursive: true })
  await fs.mkdir(nodesDir, { recursive: true })
  await fs.mkdir(modelsDir, { recursive: true })

  for (const entry of entries) {
    await copySetupWorkflow(entry)
    await fs.writeFile(
      path.join(outputDir, entry.workflowGuideFile),
      renderWorkflowMarkdown(entry),
      'utf8'
    )
  }

  const generatedAt = new Date().toISOString()
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const releaseMetadata = {
    starterPackVersion: packageJson.version,
    compatibleAppVersion: packageJson.version,
    generatedAt,
    sourceCommit: getGitCommit(),
    totalWorkflows: entries.length,
    localWorkflowCount: entries.filter((entry) => entry.runtime === 'local').length,
    cloudWorkflowCount: entries.filter((entry) => entry.runtime === 'cloud').length,
  }
  const manifest = {
    ...releaseMetadata,
    entries,
  }

  await fs.writeFile(
    path.join(outputDir, 'starter-pack.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  await fs.writeFile(
    path.join(outputDir, 'release.json'),
    `${JSON.stringify(releaseMetadata, null, 2)}\n`,
    'utf8'
  )
  await fs.writeFile(
    path.join(outputDir, 'RELEASE_NOTES.md'),
    renderReleaseNotes(releaseMetadata),
    'utf8'
  )
  await fs.writeFile(
    path.join(outputDir, 'INDEX.md'),
    renderIndexMarkdown(entries),
    'utf8'
  )
  await fs.writeFile(
    path.join(nodesDir, 'custom-node-manifest.json'),
    `${JSON.stringify(buildCustomNodeManifest(entries, getNodeInstallInfo), null, 2)}\n`,
    'utf8'
  )
  await fs.writeFile(
    path.join(modelsDir, 'model-manifest.json'),
    `${JSON.stringify(buildModelManifest(entries, getModelInstallInfo), null, 2)}\n`,
    'utf8'
  )
  await writeChecksums()

  console.log(`Generated workflow starter pack for ${entries.length} workflows.`)
}

main().catch((error) => {
  console.error('Failed to build workflow starter pack:', error)
  process.exitCode = 1
})
