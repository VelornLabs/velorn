const {
  CALIBRATION_PATCH_SCHEMA,
  CALIBRATION_PROFILE_SCHEMA,
  listCalibrationProfiles,
  resolveCalibrationProfile,
} = require('./workflowCalibrationProfiles.cjs')

const CAPABILITY_MANIFEST_SCHEMA = 'velorn.capability-manifest/v1'
const WORKFLOW_CATALOG_SCHEMA = 'velorn.workflow-catalog/v1'
const CALIBRATION_PROFILE_CATALOG_SCHEMA = 'velorn.calibration-profile-catalog/v1'

const BRIDGE_SCHEMAS = Object.freeze({
  capabilitySnapshot: 'monstruo-capability-snapshot/v1',
  calibrationProfile: 'monstruo-calibration-profile/v1',
  calibrationPatch: 'monstruo-calibration-patch/v1',
  executionGrant: 'monstruo-calibration-grant/v1',
  receipt: 'monstruo-calibration-receipt/v1',
})

const EVIDENCE_TAXONOMY = Object.freeze([
  'DISCOVERABLE',
  'INSTALLED',
  'EXECUTABLE',
  'TECHNICALLY_VALIDATED',
  'PRODUCT_PROVEN',
])

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function toBridgeControlId(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

function technicalRangeForControl(profile, control) {
  const target = control.mapsTo
  const classInput = String(target || '').split('.').slice(-1)[0]
  if (!classInput) return { min: control.technicalValue, max: control.technicalValue }
  const operations = profile?.calibrationPatch?.operations || []
  const values = operations
    .map((operation) => operation?.inputs?.[classInput])
    .filter((value) => Number.isFinite(Number(value)))
  const baseline = Number.isFinite(Number(control.technicalValue)) ? Number(control.technicalValue) : Number(values[0])
  if (control.id === 'identityFidelity') return { min: 1.05, max: 1.3625 }
  if (control.id === 'motionAdherence') return { min: 0.5, max: 1.5 }
  if (control.id === 'choreographyLock') return { min: 0.8, max: 1.0 }
  return { min: baseline - 1, max: baseline + 1 }
}

function buildBridgeCalibrationProfile(descriptor, profile) {
  const workflowSha256 = profile?.calibrationPatch?.workflowSha256 || ''
  const bridgeProfile = {
    schema: BRIDGE_SCHEMAS.calibrationProfile,
    profile_id: descriptor.id,
    version: String(descriptor.version),
    specialist_id: 'velorn',
    workflow_id: profile.templateName,
    workflow_version: workflowSha256 ? `sha256:${workflowSha256}` : null,
    preset: cloneJson(profile.preset || {}),
    controls: (profile.controls || []).map((control) => {
      const range = technicalRangeForControl(profile, control)
      return {
        control_id: toBridgeControlId(control.id),
        label: control.label,
        axis: control.id,
        target_path: control.mapsTo,
        semantic_min: Number(control.min) - Number(control.value),
        semantic_max: Number(control.max) - Number(control.value),
        technical_min: range.min,
        technical_max: range.max,
        default_value: Number(control.technicalValue),
        step: Number(control.step || 1),
        unit: '',
        confidence: descriptor.routeEvidenceLevel === 'PRODUCT_PROVEN' ? 1 : 0.5,
        evidence_refs: [descriptor.evidence?.artifact].filter(Boolean),
      }
    }),
    locks: [
      'WanAnimate2ToVideo.video_frame_offset',
      'WanAnimate2ToVideo.pose_start_percent',
      'workflow.dimensionsMultipleOf',
      'output.nonDestructive',
      'timeline.originalMediaPreserved',
    ],
    uncertainty: {
      scope: 'Face-only reversible identity source; full-frame background/halo preservation is not claimed.',
      bindingStatus: 'Descriptor is bridge-compatible; mutating execution still requires a configured specialist adapter and scoped Kernel grant.',
      choreographyMapping: 'The neutral bridge exposes the technical pose_end_percent range; the native Velorn control remains the authoritative piecewise mapping.',
    },
    provenance: [{
      evidence_id: descriptor.evidence?.artifact || descriptor.id,
      ref: `velorn://evidence/${descriptor.evidence?.artifact || descriptor.id}`,
      verdict: descriptor.routeEvidenceLevel === 'PRODUCT_PROVEN' ? 'PASS' : 'UNKNOWN',
    }],
  }
  if (!bridgeProfile.workflow_version) delete bridgeProfile.workflow_version
  return bridgeProfile
}

function buildPublishedCalibrationProfiles() {
  return listCalibrationProfiles().map((descriptor) => {
    const templateName = descriptor.templateNames?.[0] || ''
    const profile = templateName
      ? resolveCalibrationProfile(templateName, { calibrationProfileId: descriptor.id }, {})
      : null
    const bridgeProfile = profile ? buildBridgeCalibrationProfile(descriptor, profile) : null
    return {
      descriptor,
      profile,
      bridgeProfile,
    }
  })
}

function buildWorkflowCatalogDescriptor(catalog = {}) {
  const workflows = Array.isArray(catalog.workflows) ? catalog.workflows : []
  return {
    schema: WORKFLOW_CATALOG_SCHEMA,
    itemsField: 'workflows',
    count: Number.isFinite(Number(catalog.count)) ? Number(catalog.count) : workflows.length,
    totalCount: Number.isFinite(Number(catalog.totalCount)) ? Number(catalog.totalCount) : workflows.length,
    sourceCounts: catalog.sourceCounts && typeof catalog.sourceCounts === 'object'
      ? cloneJson(catalog.sourceCounts)
      : {},
    filters: catalog.filters && typeof catalog.filters === 'object'
      ? cloneJson(catalog.filters)
      : {},
    generatedAt: catalog.generatedAt || null,
  }
}

function summarizeWorkflowCapabilities(workflows = []) {
  const categories = new Set()
  const runtimes = new Set()
  const outputs = new Set()
  let runnableCount = 0

  for (const workflow of workflows) {
    if (workflow?.category) categories.add(String(workflow.category))
    if (workflow?.runtime) runtimes.add(String(workflow.runtime))
    if (workflow?.outputType) outputs.add(String(workflow.outputType))
    if (workflow?.mcpRunnable === true) runnableCount += 1
  }

  return {
    workflowCount: workflows.length,
    agentRunnableWorkflowCount: runnableCount,
    categories: [...categories].sort(),
    runtimes: [...runtimes].sort(),
    outputTypes: [...outputs].sort(),
  }
}

function buildSpecialistPublication(catalog = {}, { serverVersion = null } = {}) {
  const workflows = Array.isArray(catalog.workflows) ? catalog.workflows : []
  const publishedProfiles = buildPublishedCalibrationProfiles()
  const workflowCatalog = buildWorkflowCatalogDescriptor(catalog)

  return {
    capabilityManifest: {
      schema: CAPABILITY_MANIFEST_SCHEMA,
      specialistId: 'velorn',
      specialistVersion: serverVersion || null,
      protocol: {
        transport: 'mcp',
        discovery: 'tools/list',
        workflowCatalogTool: 'list_velorn_workflows',
        officialTemplateCatalogTool: 'list_comfyui_templates',
      },
      capabilities: summarizeWorkflowCapabilities(workflows),
      catalogs: {
        workflowCatalogSchema: WORKFLOW_CATALOG_SCHEMA,
        workflowItemsField: 'workflows',
        calibrationProfileCatalogSchema: CALIBRATION_PROFILE_CATALOG_SCHEMA,
        calibrationProfileItemsField: 'calibrationProfiles',
      },
      calibration: {
        nativeProfileSchema: CALIBRATION_PROFILE_SCHEMA,
        nativePatchSchema: CALIBRATION_PATCH_SCHEMA,
        publishedProfileCount: publishedProfiles.length,
        failClosed: true,
        routeExact: true,
      },
      interoperability: {
        bridge: 'existing-external-contract',
        bridgeSchemas: BRIDGE_SCHEMAS,
        gateway: 'existing-external-gateway',
        mediaBytesCrossKernel: false,
      },
      authorityBoundary: {
        specialistOwns: ['workflow-discovery', 'preview', 'editable-execution', 'artifacts', 'technical-provenance'],
        kernelOwns: ['identity', 'policy', 'budget', 'secrets', 'publication', 'canon', 'scoped-grants', 'governance-receipts'],
        specialistIssuesExecutionGrants: false,
        mutationsRequirePreviewOrExternalAuthorization: true,
      },
      evidenceTaxonomy: EVIDENCE_TAXONOMY,
    },
    workflowCatalog,
    calibrationProfileCatalog: {
      schema: CALIBRATION_PROFILE_CATALOG_SCHEMA,
      count: publishedProfiles.length,
      nativeProfileSchema: CALIBRATION_PROFILE_SCHEMA,
      nativePatchSchema: CALIBRATION_PATCH_SCHEMA,
      bridgeProfileSchema: BRIDGE_SCHEMAS.calibrationProfile,
      bridgePatchSchema: BRIDGE_SCHEMAS.calibrationPatch,
      digestAuthority: 'existing-bridge-host',
      itemsField: 'calibrationProfiles',
    },
    calibrationProfiles: publishedProfiles,
  }
}

module.exports = {
  BRIDGE_SCHEMAS,
  CAPABILITY_MANIFEST_SCHEMA,
  WORKFLOW_CATALOG_SCHEMA,
  CALIBRATION_PROFILE_CATALOG_SCHEMA,
  EVIDENCE_TAXONOMY,
  buildPublishedCalibrationProfiles,
  buildSpecialistPublication,
}
