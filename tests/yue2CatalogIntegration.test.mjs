import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { buildYue2Workflow, getMusicBackend, getMusicCompletion, resolveMusicLength, YUE2_MODEL, YUE2_AUTOMATIC_DURATION } from '../src/services/musicGenerationModels.mjs'

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const loadConfig = (relative) => {
  const module = { exports: {} }
  const bundled = buildSync({
    entryPoints: [new URL(relative, import.meta.url).pathname],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    define: { 'import.meta.env.BASE_URL': '"/"' }, logLevel: 'silent',
  }).outputFiles[0].text
  Function('module', 'exports', bundled)(module, module.exports)
  return module.exports
}

const registry = loadConfig('../src/config/workflowRegistry.js')
const catalog = loadConfig('../src/config/generateWorkflowCatalog.js')
const dependencies = loadConfig('../src/config/workflowDependencyPacks.js')
const installers = loadConfig('../src/config/workflowInstallCatalog.js')
const workspace = loadConfig('../src/config/generateWorkspaceConfig.js')
const gallery = loadConfig('../src/config/workflowSetupGallery.js')
const flow = loadConfig('../src/services/flowAiSchema.js')
const yue2 = JSON.parse(read('../public/workflows/music_generation_yue2.json'))
const ace = JSON.parse(read('../public/workflows/music_generation.json'))

test('YuE2 has its own workflow ID and does not repoint persisted ACE-Step jobs', () => {
  assert.equal(registry.BUILTIN_WORKFLOW_PATHS['music-gen'], '/workflows/music_generation.json')
  assert.equal(registry.BUILTIN_WORKFLOW_PATHS['music-gen-yue2'], '/workflows/music_generation_yue2.json')
  assert.equal(ace['94'].class_type, 'TextEncodeAceStepAudio1.5')
  assert.equal(ace['104'].inputs.unet_name, 'acestep_v1.5_turbo.safetensors')
  for (const id of ['music-gen', 'music-gen-yue2']) {
    assert.equal(registry.BUILTIN_WORKFLOWS.filter((entry) => entry.id === id).length, 1)
    assert.equal(catalog.GENERATE_WORKFLOW_CATALOG.filter((entry) => entry.workflowId === id).length, 1)
  }
})

test('the bundled YuE2 graph is the same graph used by timeline generation', () => {
  assert.deepEqual(yue2, buildYue2Workflow({
    tags: 'Cinematic ambient instrumental, warm piano, gentle strings, 90 BPM',
    instrumental: true, lengthMode: 'automatic', seed: 31,
  }))
  assert.deepEqual(yue2['98'].inputs.seconds, ['95', 1])
  assert.equal(yue2['107'].inputs.format, 'flac')
})

test('YuE2 dependency inspection covers every graph node and only one bundled checkpoint', () => {
  const pack = dependencies.getWorkflowDependencyPack('music-gen-yue2')
  const nodes = new Set(pack.requiredNodes.map((node) => node.classType))
  assert.deepEqual(nodes, new Set(Object.values(yue2).map((node) => node.class_type)))
  assert.deepEqual(pack.requiredModels, [{
    classType: 'CheckpointLoaderSimple', inputKey: 'ckpt_name',
    filename: YUE2_MODEL, targetSubdir: 'checkpoints',
  }])
  for (const node of nodes) assert.equal(installers.getNodeInstallInfo(node).kind, 'core', node)
  assert.equal(dependencies.getWorkflowDependencyPack('music-gen').requiredModels.length, 4)
})

test('YuE2 checkpoint install uses the official repository and current upstream model license', () => {
  const recipe = installers.getModelInstallInfo({ filename: YUE2_MODEL, targetSubdir: 'checkpoints' })
  assert.equal(recipe.downloadUrl, 'https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_int8_convrot.safetensors')
  assert.equal(recipe.sizeBytes, 3960938800)
  assert.equal(recipe.licenseUrl, 'https://github.com/multimodal-art-projection/YuE/blob/main/MODEL_LICENSE')
  assert.match(recipe.notes, /individual creators.*monetize/)
  assert.match(recipe.notes, /company commercial model use requires separate permission/)
})

test('YuE2 fields explain Automatic and custom maximum length without fictitious native BPM or key controls', () => {
  const manifest = catalog.getWorkflowManifestByWorkflowId('music-gen-yue2')
  assert.deepEqual(manifest.fields.map((field) => field.id), ['musicTags', 'lyrics', 'musicLengthMode', 'seed'])
  assert.equal(manifest.fields.find((field) => field.id === 'musicLengthMode').label, 'Song length')
  assert.equal(manifest.fields.find((field) => field.id === 'musicLengthMode').type, 'yue2Length')
  assert.match(manifest.fields.find((field) => field.id === 'musicLengthMode').helper, /Automatic.*6-minute safety limit.*custom maximum.*end earlier.*cut off/)
  assert.match(manifest.fields.find((field) => field.id === 'lyrics').helper, /not guaranteed/)
  assert.match(manifest.runtimeNote, /Apple GPU compatibility is not yet verified/)
  assert.ok(manifest.licenseNotice)
  assert.ok(manifest.licenseUrl)
})

test('YuE2 does not inherit ACE-Step low-VRAM claims', () => {
  const hardware = workspace.getWorkflowHardwareInfo('music-gen-yue2')
  assert.equal(hardware.runtime, 'local')
  assert.equal(hardware.minimumVramGb, undefined)
  assert.equal(hardware.recommendedVramGb, undefined)
  assert.equal(workspace.getWorkflowTierMeta('music-gen-yue2'), null)
  assert.match(gallery.getWorkflowSetupGalleryMeta('music-gen-yue2').longDescription, /ceiling/)
})

test('Flow AI keeps its working legacy music default instead of exposing an unsupported YuE2 node', () => {
  assert.equal(flow.getDefaultWorkflowId(flow.FLOW_AI_NODE_TYPES.musicGen), 'music-gen')
  assert.equal(flow.getFlowAudioWorkflowOptions().some((workflow) => workflow.id === 'music-gen-yue2'), false)
})

const service = read('../src/services/comfyui.js')
const extractModifier = (name, nextMarker, injectedNames = [], injectedValues = []) => {
  const start = service.indexOf(`export function ${name}(`)
  const end = service.indexOf(nextMarker, start)
  assert.ok(start >= 0 && end > start)
  return Function(...injectedNames, `${service.slice(start, end).replace('export function', 'function')}\nreturn ${name}`)(...injectedValues)
}
const modifyYue2 = extractModifier('modifyYue2MusicWorkflow', 'function normalizeElevenLabsVoiceName', ['buildYue2Workflow'], [buildYue2Workflow])
const modifyAce = extractModifier('modifyMusicWorkflow', '/** YuE2 stays')

test('Generate YuE2 modifier preserves checkpoint subfolders and uses style, lyrics, seed and duration ceiling', () => {
  const template = structuredClone(yue2)
  template['104'].inputs.ckpt_name = `music/${YUE2_MODEL}`
  const snapshot = structuredClone(template)
  const graph = modifyYue2(template, {
    tags: 'Warm indie rock, 110 BPM', lyrics: '[Verse]\nA morning song', duration: 60,
    seed: 77, bpm: 200, keyscale: 'F minor', filenamePrefix: 'audio/velorn_music_test',
  })
  assert.deepEqual(template, snapshot)
  assert.equal(graph['104'].inputs.ckpt_name, `music/${YUE2_MODEL}`)
  assert.equal(graph['94'].inputs.style, 'Warm indie rock, 110 BPM')
  assert.equal(graph['95'].inputs.lyrics, '[Verse]\nA morning song')
  assert.equal(graph['95'].inputs.max_duration, 60)
  for (const id of ['94', '95', '3']) assert.equal(graph[id].inputs.seed, 77)
  assert.equal(graph['95'].inputs.bpm, undefined)
  assert.equal(graph['95'].inputs.keyscale, undefined)
  assert.equal(graph['107'].inputs.filename_prefix, 'audio/velorn_music_test')
})

test('Generate YuE2 empty lyrics requests instrumental while ACE-Step retains exact-duration inputs', () => {
  const instrumental = modifyYue2(yue2, { tags: 'Piano', lyrics: '  ', duration: 15, seed: 0 })
  assert.match(instrumental['94'].inputs.style, /instrumental/i)
  assert.equal(instrumental['95'].inputs.lyrics, '')
  const legacy = modifyAce(ace, { tags: 'Jazz', lyrics: 'Words', duration: 37, seed: 12, bpm: 91, keyscale: 'D minor' })
  assert.equal(legacy['94'].inputs.duration, 37)
  assert.equal(legacy['98'].inputs.seconds, 37)
  assert.equal(legacy['94'].inputs.bpm, 91)
  assert.equal(legacy['94'].inputs.keyscale, 'D minor')
  assert.equal(legacy['107'].class_type, 'SaveAudioMP3')
})

test('Generate modifier defaults to Automatic while explicit legacy durations remain custom ceilings', () => {
  const automatic = modifyYue2(yue2, { tags: 'Piano' })
  assert.equal(automatic['95'].inputs.max_duration, YUE2_AUTOMATIC_DURATION)
  assert.equal(modifyYue2(yue2, { tags: 'Piano', duration: 30 })['95'].inputs.max_duration, 30)
  assert.equal(modifyYue2(yue2, { tags: 'Piano', duration: 30, lengthMode: 'automatic' })['95'].inputs.max_duration, 360)
  assert.equal(modifyYue2(yue2, { tags: 'Piano', duration: 360, lengthMode: 'custom' })['95'].inputs.max_duration, 360)
})

test('Generate dispatch and saved media retain backend identity and actual length semantics', () => {
  const source = read('../src/components/GenerateWorkspace.jsx')
  assert.match(source, /case 'music-gen-yue2':[\s\S]*?modifyYue2MusicWorkflow\(workflowJson/)
  assert.match(source, /case 'music-gen':[\s\S]*?modifyMusicWorkflow\(workflowJson/)
  assert.match(source, /musicBackend: 'yue2', musicWorkflowVersion: 1/)
  assert.match(source, /measuredDurationSeconds: assetInfo.duration/)
  assert.match(source, /maximumDuration: musicLength.durationSeconds, duration: assetInfo.duration/)
  assert.match(source, /lengthMode: job.musicLengthMode/)
  assert.match(source, /musicLengthMode: selectedMusicLength.lengthMode/)
  assert.match(source, /musicDuration: selectedMusicLength.durationSeconds, musicLengthMode: selectedMusicLength.lengthMode/)
  assert.match(source, /const \[musicLengthMode, setMusicLengthMode\] = useState\(persistedState\?\.musicLengthMode === 'custom' \? 'custom' : 'automatic'\)/)
  assert.match(source, /musicDuration: workflowId === 'music-gen-yue2' \? yue2CustomDuration : musicDuration/)
  assert.match(read('../src/components/generate/WorkflowDetail.jsx'), /workflow\.licenseNotice/)
  assert.match(read('../src/components/generate/WorkflowDetail.jsx'), /previewAsset\.generatedMusic\?\.completion\?\.warning/)
})

// Exercise the actual asynchronous save boundary with isolated in-memory stores,
// including project changes during fetch/import. No user folders are opened.
const generateSource = read('../src/components/GenerateWorkspace.jsx')
test('actual Generate queued jobs and persisted records freeze the selected music length without changing video seconds', () => {
  const marker = '  const createQueuedJob = useCallback('
  const start = generateSource.indexOf(marker) + marker.length
  const end = generateSource.indexOf('\n  }, [', start) + '\n  }'.length
  const scope = {
    resolveMusicLength, workflowId: 'music-gen-yue2', category: 'audio',
    selectedWorkflowManifest: {}, currentWorkflow: {}, primaryAssetSlot: null,
    CUSTOM_GENERATE_IMAGE_WORKFLOW_ID: 'custom-image', CUSTOM_GENERATE_VIDEO_WORKFLOW_ID: 'custom-video',
    fullPrompt: '', negativePrompt: '', selectedTags: [], seed: 42, duration: 3, fps: 24,
    interpolationMultiplier: 4, enableFpsMultiplier: false, resolution: { width: 1280, height: 720 },
    wanQualityPreset: 'balanced', editSteps: 10, editCfg: 1, musicTags: 'Piano', lyrics: '',
    selectedMusicLength: { lengthMode: 'automatic', durationSeconds: 360 }, bpm: 120, keyscale: 'C major',
    selectedAsset: null, selectedAudioAsset: null, conditioningAudio: null, templateParameterValues: {},
    frameTime: 0, currentProjectHandle: 'project-a', currentProject: { name: 'Test' }, assets: [],
    selectedAssetFields: {}, selectedAssetFieldIds: {},
  }
  const context = vm.createContext(scope)
  const create = vm.runInContext(`(${generateSource.slice(start, end)})`, context)
  const automatic = create()
  scope.selectedMusicLength = { lengthMode: 'custom', durationSeconds: 305 }
  const custom = create()
  assert.equal(automatic.musicLengthMode, 'automatic')
  assert.equal(automatic.musicDuration, 360)
  assert.equal(custom.musicLengthMode, 'custom')
  assert.equal(custom.musicDuration, 305)
  assert.equal(automatic.duration, 3)
  assert.equal(custom.duration, 3)
  scope.workflowId = 'music-gen'
  scope.selectedMusicLength = { lengthMode: 'exact', durationSeconds: 37 }
  const aceJob = create()
  assert.equal(aceJob.musicLengthMode, 'exact')
  assert.equal(aceJob.musicDuration, 37)
  assert.equal(aceJob.workflowId, 'music-gen')
  const sanitizeStart = generateSource.indexOf('function sanitizeGenerationJobForStorage(')
  const sanitizeEnd = generateSource.indexOf('function normalizePersistedGenerationJob(', sanitizeStart)
  const sanitize = vm.runInNewContext(`${generateSource.slice(sanitizeStart, sanitizeEnd)}; sanitizeGenerationJobForStorage`, {
    sanitizeProjectOriginForStorage: value => value,
    sanitizeAssetSnapshotForStorage: value => value,
  })
  for (const job of [automatic, custom, aceJob]) {
    const restored = JSON.parse(JSON.stringify(sanitize(job)))
    assert.equal(restored.musicLengthMode, job.musicLengthMode)
    assert.equal(restored.musicDuration, job.musicDuration)
    assert.equal(restored.duration, 3)
  }
})

const saveStart = generateSource.indexOf('  const saveGenerationResult = async (')
const saveEnd = generateSource.indexOf('  const rememberLatestWorkflowPreview', saveStart)
const saveSource = generateSource.slice(saveStart, saveEnd)
function musicSaveHarness({ capturedProject = 'project-a', activeProject = capturedProject, duration = 11.84, duringDownload, duringImport, failDownload = false, jobOverrides = {} } = {}) {
  const state = { activeProject, added: [], persisted: [], imported: [], folderWrites: [], signatures: new Set(), logs: [] }
  const scope = {
    currentProjectHandle: capturedProject,
    useProjectStore: { getState: () => ({ currentProjectHandle: state.activeProject }) },
    useAssetsStore: { getState: () => ({ folders: [] }) },
    areProjectHandlesSame: (a, b) => Boolean(a && b && a === b),
    importedMediaSignaturesRef: { current: state.signatures },
    generateName: (value) => value,
    buildDirectorAssetDisplayName: () => 'Director',
    buildDirectorGeneratedFolderName: () => '',
    getWorkflowDisplayLabel: () => 'Music Generation (YuE2)',
    GENERATED_ASSET_FOLDERS: { audio: ['Generated Music'] },
    ensureAssetFolderPath: () => { state.folderWrites.push(state.activeProject); return `folder-${state.activeProject}` },
    addAsset: (asset) => { const added = { ...asset, id: `asset-${state.added.length + 1}` }; state.added.push({ project: state.activeProject, asset: added }); return added },
    saveProject: async () => {},
    appendAssetToProjectFile: async (project, asset) => { state.persisted.push({ project, asset }); return { ...asset, id: 'persisted-asset' } },
    addComfyLog: (...args) => state.logs.push(args),
    comfyui: { getMediaUrl: () => 'http://local-test/view' },
    fetch: async () => { duringDownload?.(state); return { ok: !failDownload, status: failDownload ? 500 : 200, blob: async () => new Blob(['audio']) } },
    importAsset: async (project) => { state.imported.push(project); duringImport?.(state); return { path: 'assets/audio/song.flac', duration } },
    getMusicBackend,
    resolveMusicLength,
    getMusicCompletion,
    URL: { createObjectURL: () => 'blob:test' },
    console: { warn: () => {} },
  }
  const save = Function(...Object.keys(scope), `${saveSource}\nreturn saveGenerationResult`)(...Object.values(scope))
  const result = { type: 'audio', filename: 'song.flac', subfolder: 'audio', outputType: 'output' }
  const job = { workflowId: 'music-gen-yue2', originProject: { handle: 'project-a' }, musicTags: 'Indie rock', musicDuration: 30, lyrics: '', seed: 7, ...jobOverrides }
  return { state, save: () => save(result, 'music-gen-yue2', job), saveWithoutOrigin: () => save(result, 'music-gen-yue2', { ...job, originProject: null }) }
}

test('YuE2 import after a project switch saves to the origin without mutating the newly active project', async () => {
  for (const boundary of ['duringDownload', 'duringImport']) {
    const harness = musicSaveHarness({ [boundary]: (state) => { state.activeProject = 'project-b' } })
    await harness.save()
    assert.deepEqual(harness.state.imported, ['project-a'])
    assert.equal(harness.state.added.length, 0)
    assert.equal(harness.state.persisted.length, 1)
    assert.equal(harness.state.persisted[0].project, 'project-a')
    assert.equal(harness.state.persisted[0].asset.url, null)
    assert.equal(harness.state.folderWrites.includes('project-b'), false)
  }
})

test('YuE2 rechecks the live project when the origin becomes active during import', async () => {
  const harness = musicSaveHarness({ capturedProject: 'project-b', duringImport: (state) => { state.activeProject = 'project-a' } })
  await harness.save()
  assert.equal(harness.state.persisted.length, 0)
  assert.equal(harness.state.added[0].project, 'project-a')
  assert.equal(harness.state.added[0].asset.folderId, 'folder-project-a')
  assert.equal(harness.state.added[0].asset.duration, 11.84)
  assert.equal(harness.state.added[0].asset.generatedMusic.measuredDurationSeconds, 11.84)
  assert.equal(harness.state.added[0].asset.settings.maximumDuration, 30)
  assert.equal(harness.state.added[0].asset.generatedMusic.lengthMode, 'custom')
  assert.equal(harness.state.added[0].asset.generatedMusic.completion.status, 'unknown')
})

test('Generate imports automatic-limit audio with measured duration and a visible warning, not a verified ending', async () => {
  const harness = musicSaveHarness({ duration: 359.9, jobOverrides: { musicLengthMode: 'automatic', musicDuration: 360 } })
  await harness.save()
  const asset = harness.state.added[0].asset
  assert.equal(asset.duration, 359.9)
  assert.equal(asset.generatedMusic.lengthMode, 'automatic')
  assert.equal(asset.generatedMusic.durationSeconds, 360)
  assert.equal(asset.generatedMusic.completion.status, 'limit-reached')
  assert.equal(asset.generatedMusic.completion.naturalEndingVerified, false)
  assert.equal(asset.generatedMusic.completion.truncated, null)
  assert.equal(asset.settings.musicLengthMode, 'automatic')
  assert.deepEqual(harness.state.logs, [['warning', asset.generatedMusic.completion.warning]])
})

test('Generate custom-limit warnings use the saved job ceiling, including legacy jobs', async () => {
  for (const jobOverrides of [{}, { musicLengthMode: 'custom', musicDuration: 90 }]) {
    const ceiling = jobOverrides.musicDuration || 30
    const harness = musicSaveHarness({ duration: ceiling, jobOverrides })
    await harness.save()
    const metadata = harness.state.added[0].asset.generatedMusic
    assert.equal(metadata.lengthMode, 'custom')
    assert.equal(metadata.completion.limitSeconds, ceiling)
    assert.equal(metadata.completion.status, 'limit-reached')
  }
})

test('YuE2 failed probes leave recoverable media but no ghost asset or fictional duration', async () => {
  for (const duration of [null, 0, -1, NaN, Infinity]) {
    const harness = musicSaveHarness({ duration })
    await assert.rejects(harness.save(), /duration could not be read.*assets\/audio\/song\.flac/)
    assert.equal(harness.state.added.length, 0)
    assert.equal(harness.state.persisted.length, 0)
    assert.equal(harness.state.signatures.size, 0)
  }
})

test('YuE2 download failures and missing origin never create temporary remote assets', async () => {
  const failed = musicSaveHarness({ failDownload: true })
  await assert.rejects(failed.save(), /download failed \(500\)/)
  assert.equal(failed.state.imported.length, 0)
  assert.equal(failed.state.added.length, 0)
  assert.equal(failed.state.signatures.size, 0)
  const missing = musicSaveHarness()
  await assert.rejects(missing.saveWithoutOrigin(), /no origin project/)
  assert.equal(missing.state.imported.length, 0)
})
