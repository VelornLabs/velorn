const assert = require('node:assert/strict')
const fs = require('node:fs').promises
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  analyzeMyWorkflowRecord,
  createMyWorkflowCatalogEntry,
  loadMyWorkflowCatalog,
} = require('../electron/myWorkflowCatalog')
const { createComfyStudioMcpServer } = require('../electron/mcpServer')

function makeRecord(nodes, overrides = {}) {
  return {
    id: 'portrait-look',
    title: 'Portrait Look',
    savedAt: 100,
    updatedAt: 200,
    uiWorkflow: { nodes },
    ...overrides,
  }
}

test('marks a prompt-driven saved image workflow as MCP ready', () => {
  const record = makeRecord([
    { id: 1, type: 'PrimitiveStringMultiline', title: 'VELORN_PROMPT' },
    { id: 2, type: 'LoadImage', title: 'VELORN_REFERENCE_IMAGE_1' },
    { id: 3, type: 'SaveImage', title: 'VELORN_OUTPUT_IMAGE' },
  ])

  const entry = createMyWorkflowCatalogEntry(record, 'C:/Velorn/custom-workflows/portrait-look.json')

  assert.equal(entry.id, 'my-workflow:portrait-look')
  assert.equal(entry.source, 'my-workflows')
  assert.equal(entry.outputType, 'image')
  assert.equal(entry.mcpRunnable, true)
  assert.equal(entry.needsImage, false)
  assert.deepEqual(entry.optionalAssetFields.map((field) => field.id), ['referenceImage1'])
})

test('reports the markers missing from an arbitrary saved graph', () => {
  const analysis = analyzeMyWorkflowRecord(makeRecord([
    { id: 1, type: 'KSampler', title: 'Sampler' },
    { id: 2, type: 'PreviewImage', title: 'Preview' },
  ]))

  assert.equal(analysis.mcpRunnable, false)
  assert.equal(analysis.readiness, 'needs-setup')
  assert.match(analysis.readinessMessage, /VELORN_PROMPT/)
  assert.match(analysis.readinessMessage, /VELORN_OUTPUT_IMAGE/)
})

test('detects video inputs and legacy marker aliases', () => {
  const analysis = analyzeMyWorkflowRecord(makeRecord([
    { id: 1, type: 'PrimitiveStringMultiline', title: 'COMFYSTUDIO_PROMPT' },
    { id: 2, type: 'LoadImage', title: 'COMFYSTUDIO_INPUT_IMAGE' },
    { id: 3, type: 'LoadAudio', title: 'VELORN_AUDIO' },
    { id: 4, type: 'SaveVideo', title: 'VELORN_OUTPUT_VIDEO' },
  ]))

  assert.equal(analysis.mcpRunnable, true)
  assert.equal(analysis.outputType, 'video')
  assert.equal(analysis.needsImage, true)
  assert.equal(analysis.acceptsAudio, true)
  assert.deepEqual(analysis.requiredAssetFields.map((field) => field.id), ['image'])
  assert.deepEqual(analysis.optionalAssetFields.map((field) => field.id), ['audio'])
})

test('loads My Workflows records from the user-data library directory', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-my-workflows-'))
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }))
  const libraryDir = path.join(userDataDir, 'custom-workflows')
  await fs.mkdir(libraryDir, { recursive: true })
  await fs.writeFile(
    path.join(libraryDir, 'portrait-look.json'),
    JSON.stringify(makeRecord([
      { id: 1, type: 'PrimitiveStringMultiline', title: 'VELORN_PROMPT' },
      { id: 2, type: 'SaveImage', title: 'VELORN_OUTPUT_IMAGE' },
    ])),
    'utf8'
  )

  const catalog = await loadMyWorkflowCatalog(userDataDir)

  assert.equal(catalog.success, true)
  assert.equal(catalog.count, 1)
  assert.equal(catalog.workflows[0].id, 'my-workflow:portrait-look')
  assert.equal(catalog.workflows[0].mcpRunnable, true)
})

test('builds a prompt-generation preview for an agent-ready My Workflows id', async () => {
  const server = createComfyStudioMcpServer({
    listComfyStudioWorkflows: async () => ({
      success: true,
      workflows: [{
        id: 'my-workflow:portrait-look',
        libraryId: 'portrait-look',
        label: 'Portrait Look',
        outputType: 'image',
        needsImage: false,
        mcpRunnable: true,
        requiredAssetFields: [],
        optionalAssetFields: [],
      }],
    }),
  })
  server.updateSnapshot({
    project: { id: 'project-1', name: 'Test' },
    timelines: [],
    currentTimeline: null,
    assets: [],
    folders: [],
  })

  const result = await server.callTool('queue_prompt_generation_batch', {
    workflowId: 'my-workflow:portrait-look',
    prompt: 'A cinematic portrait',
    previewOnly: true,
  })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(result.isError, undefined)
  assert.equal(payload.previewOnly, true)
  assert.equal(payload.plan.jobs[0].workflowId, 'my-workflow:portrait-look')
  assert.equal(payload.plan.jobs[0].libraryWorkflowId, 'portrait-look')
  assert.equal(payload.plan.jobs[0].outputType, 'image')
})

test('forwards the My Workflows source filter through the public MCP listing tool', async () => {
  let receivedOptions = null
  const server = createComfyStudioMcpServer({
    listComfyStudioWorkflows: async (options) => {
      receivedOptions = options
      return {
        success: true,
        sourceCounts: { bundled: 42, 'my-workflows': 2 },
        count: 2,
        workflows: [{
          id: 'my-workflow:portrait-look',
          label: 'Portrait Look',
          source: 'my-workflows',
          mcpRunnable: true,
        }],
      }
    },
  })

  const result = await server.callTool('list_velorn_workflows', {
    source: 'my-workflows',
    refresh: true,
  })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(result.isError, undefined)
  assert.equal(receivedOptions.source, 'my-workflows')
  assert.equal(receivedOptions.refresh, true)
  assert.equal(payload.workflows[0].id, 'my-workflow:portrait-look')
  assert.equal(payload.capabilityManifest.schema, 'velorn.capability-manifest/v1')
  assert.equal(payload.capabilityManifest.specialistId, 'velorn')
  assert.equal(payload.capabilityManifest.protocol.workflowCatalogTool, 'list_velorn_workflows')
  assert.equal(payload.capabilityManifest.interoperability.bridge, 'existing-external-contract')
  assert.equal(payload.capabilityManifest.interoperability.gateway, 'existing-external-gateway')
  assert.equal(payload.capabilityManifest.interoperability.mediaBytesCrossKernel, false)
  assert.equal(payload.capabilityManifest.authorityBoundary.specialistIssuesExecutionGrants, false)
  assert.equal(payload.workflowCatalog.schema, 'velorn.workflow-catalog/v1')
  assert.equal(payload.workflowCatalog.count, 2)
  assert.equal(payload.calibrationProfileCatalog.schema, 'velorn.calibration-profile-catalog/v1')
  assert.equal(payload.calibrationProfileCatalog.count, 1)
  assert.equal(payload.calibrationProfiles[0].descriptor.id, 'wan-animate2-identity-motion-v1')
  assert.equal(payload.calibrationProfiles[0].profile.preset.id, 'product-v2-balanced-face-source')
  assert.equal(payload.calibrationProfiles[0].profile.calibrationPatch.profileVersion, 1)
  assert.equal(payload.calibrationProfiles[0].bridgeProfile.schema, 'monstruo-calibration-profile/v1')
  assert.equal(payload.calibrationProfiles[0].bridgeProfile.specialist_id, 'velorn')
  assert.equal(payload.calibrationProfiles[0].bridgeProfile.workflow_id, 'video_wan_animate2')
  assert.equal(payload.calibrationProfiles[0].bridgeProfile.controls.length, 3)
  assert.deepEqual(payload.calibrationProfiles[0].bridgeProfile.controls.map((control) => control.control_id), [
    'identity-fidelity',
    'motion-adherence',
    'choreography-lock',
  ])
  assert.deepEqual(payload.calibrationProfiles[0].bridgeProfile.locks, [
    'WanAnimate2ToVideo.video_frame_offset',
    'WanAnimate2ToVideo.pose_start_percent',
    'workflow.dimensionsMultipleOf',
    'output.nonDestructive',
    'timeline.originalMediaPreserved',
  ])
  assert.equal(Object.hasOwn(payload.calibrationProfiles[0], 'bridgeProfileDigest'), false)
  assert.equal(Object.hasOwn(payload.calibrationProfiles[0].bridgeProfile, 'profile_digest'), false)
  assert.equal(payload.calibrationProfileCatalog.digestAuthority, 'existing-bridge-host')
  assert.equal(payload.capabilityManifest.interoperability.bridgeSchemas.calibrationProfile, 'monstruo-calibration-profile/v1')
  assert.equal(payload.capabilityManifest.interoperability.bridgeSchemas.executionGrant, 'monstruo-calibration-grant/v1')
})

test('dispatches an approved My Workflows generation through the renderer bridge', async () => {
  let dispatchedAction = null
  const server = createComfyStudioMcpServer({
    listComfyStudioWorkflows: async () => ({
      success: true,
      workflows: [{
        id: 'my-workflow:portrait-look',
        libraryId: 'portrait-look',
        label: 'Portrait Look',
        outputType: 'image',
        needsImage: false,
        mcpRunnable: true,
        requiredAssetFields: [],
        optionalAssetFields: [],
      }],
    }),
    performAction: async (request) => {
      dispatchedAction = request
      return { success: true, queued: 1 }
    },
  })
  server.updateSnapshot({
    project: { id: 'project-1', name: 'Test' },
    timelines: [],
    currentTimeline: null,
    assets: [],
    folders: [],
  })

  const result = await server.callTool('queue_prompt_generation_batch', {
    workflowId: 'my-workflow:portrait-look',
    prompt: 'A cinematic portrait',
    previewOnly: false,
  })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(result.isError, undefined)
  assert.equal(payload.success, true)
  assert.equal(dispatchedAction.action, 'queue_prompt_generation_batch')
  assert.equal(dispatchedAction.payload.jobs[0].workflowId, 'my-workflow:portrait-look')
  assert.equal(dispatchedAction.payload.jobs[0].libraryWorkflowId, 'portrait-look')
  assert.equal(dispatchedAction.payload.jobs[0].workflowSource, 'my-workflows')
})

test('returns actionable setup blockers instead of queueing an incompatible saved graph', async () => {
  const server = createComfyStudioMcpServer({
    listComfyStudioWorkflows: async () => ({
      success: true,
      workflows: [{
        id: 'my-workflow:unfinished',
        libraryId: 'unfinished',
        label: 'Unfinished',
        mcpRunnable: false,
        readinessMessage: 'Add a node titled VELORN_PROMPT.',
      }],
    }),
  })
  server.updateSnapshot({
    project: { id: 'project-1', name: 'Test' },
    timelines: [],
    currentTimeline: null,
    assets: [],
    folders: [],
  })

  const result = await server.callTool('queue_prompt_generation_batch', {
    workflowId: 'my-workflow:unfinished',
    prompt: 'Test prompt',
    previewOnly: true,
  })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /visible but not agent-ready/i)
  assert.match(result.content[0].text, /VELORN_PROMPT/)
})
