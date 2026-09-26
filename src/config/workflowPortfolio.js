import workflowPortfolioData from '../../electron/workflowPortfolioData.cjs'

export const WORKFLOW_EVIDENCE_LEVELS = Object.freeze({
  DISCOVERABLE: 'DISCOVERABLE',
  INSTALLED: 'INSTALLED',
  EXECUTABLE: 'EXECUTABLE',
  TECHNICALLY_VALIDATED: 'TECHNICALLY_VALIDATED',
  PRODUCT_PROVEN: 'PRODUCT_PROVEN',
})

export const WORKFLOW_PORTFOLIO_ROLES = Object.freeze({
  CHAMPION: 'CHAMPION',
  SPECIALIST_CHAMPION: 'SPECIALIST_CHAMPION',
  SOVEREIGN_ALTERNATIVE: 'SOVEREIGN_ALTERNATIVE',
  ECONOMIC_ALTERNATIVE: 'ECONOMIC_ALTERNATIVE',
  PREMIUM_ALTERNATIVE: 'PREMIUM_ALTERNATIVE',
  FRONTIER_CANDIDATE: 'FRONTIER_CANDIDATE',
  FRONTIER_BLOCKED: 'FRONTIER_BLOCKED',
  UNASSESSED: 'UNASSESSED',
})

export const WORKFLOW_CAPABILITY_LANES = Object.freeze({
  'text-to-image': 'Text to image',
  'image-edit': 'Image edit',
  'image-to-video': 'Image to video',
  'text-to-video': 'Text to video',
  'video-tools': 'Restoration and finishing',
  audio: 'Audio',
  image: 'Image',
  video: 'Video',
  create: 'Guided production',
  utility: 'Utility',
})

const SELF_HOSTED_PROVIDER_NAMES = new Set(['local', 'velorn'])

const WORKFLOW_EVIDENCE_OVERRIDES = Object.freeze({
  'wan22-t2v': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.SOVEREIGN_ALTERNATIVE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked by exact model mismatch',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'Wan T2V is product-proven through the distinct B200 wan_t2v_stable_v1 route; the bundled workflow hash is separately recorded as BLOCKED.',
    qualityObservation: 'Stable long-form Wan T2V artifacts were produced and preserved, but not by this exact bundled graph.',
    limitation: 'The bundled graph references FP8/LightX2V filenames not found as exact physical files in the certified volume; route proof cannot be inherited from wan_t2v_stable_v1.',
  }),
  'wan22-i2v': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.SOVEREIGN_ALTERNATIVE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked by exact model mismatch',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'Wan I2V family artifacts exist, but the exact bundled workflow hash is recorded as BLOCKED and has no matched route receipt.',
    qualityObservation: 'Controlled Wan I2V output exists elsewhere in the ecosystem; this exact graph is not product-proven.',
    limitation: 'The bundled graph references FP8/LightX2V filenames not found as exact physical files in the certified volume; identity and continuity evidence cannot be transferred across routes.',
  }),
  'ltx23-t2v': Object.freeze({
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.INSTALLED,
    availability: 'Runtime required',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'LTX model family physically present on the durable volume',
    limitation: 'The exact Velorn workflow still requires a current end-to-end product proof.',
  }),
  'ltx23-i2v': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.INSTALLED,
    availability: 'Runtime required',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'LTX model family physically present on the durable volume',
    limitation: 'The exact Velorn workflow still requires a current end-to-end product proof.',
  }),
  'ltx23-ia2v': Object.freeze({
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.INSTALLED,
    availability: 'Runtime required',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'LTX audio-video models physically present on the durable volume',
    limitation: 'Audio-conditioned output has not yet passed the full Velorn product gate.',
  }),
  'frame-interpolation': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.SOVEREIGN_ALTERNATIVE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked by exact model mismatch',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'RIFE 4.26 assets are installed, but the bundled graph references FILM model film_net_fp16.safetensors.',
    limitation: 'FILM weights were not found in the certified volume; an exact RIFE graph and product artifact are still required.',
  }),
  'topaz-video-upscale': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Cloud credentials required',
    sovereignty: 'Commercial API',
    evidenceLabel: 'Topaz Starlight and Astra are exposed by the bundled guided workflow.',
    limitation: 'The tested Runway 4K upscaler was rejected for premium finishing; this exact Topaz route remains unbenchmarked.',
  }),
  'music-gen': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked until dependencies are installed',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'Workflow is bundled; durable music-model weights were not found',
    limitation: 'No durable ACE-Step weights were present in the certified volume census.',
  }),
  'vocal-extract-melband': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked until dependencies are installed',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'The Mel-Band RoFormer workflow is bundled in Velorn.',
    limitation: 'The exact model weights and runtime pack were absent from the certified durable volume.',
  }),
  'caption-qwen-asr': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked until dependencies are installed',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'The Qwen ASR caption workflow is bundled in Velorn.',
    limitation: 'No exact ASR model/runtime proof or validated caption artifact was found.',
  }),
  'elevenlabs-tts': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.TECHNICALLY_VALIDATED,
    availability: 'Credential verified; exact route smoke test required',
    sovereignty: 'Commercial API',
    evidenceLabel: 'ElevenLabs has historical voice artifacts, a bundled Velorn TTS workflow and a read-only entitlement preflight that returned HTTP 200 on 2026-09-09.',
    qualityObservation: 'Natural voice output is product-proven elsewhere in the ecosystem.',
    limitation: 'Credential authorization does not prove this exact bundled workflow; it still lacks a current artifact and receipt.',
  }),
  'sonilo-v2m': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_CANDIDATE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Cloud credentials required',
    sovereignty: 'Commercial API',
    evidenceLabel: 'The Sonilo video-to-music workflow is bundled in Velorn.',
    limitation: 'No authenticated comparative artifact was produced in this phase.',
  }),
  'short-film-dialogue-ltx23-ia2v': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.INSTALLED,
    availability: 'Blocked by incomplete runtime pack',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'The guided dialogue workflow and LTX family are present.',
    limitation: 'The exact audio-video graph has not passed an end-to-end product gate on the current runtime.',
  }),
  'ltx23-id-lora': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked until dependencies are installed',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'The guided LTX ID-LoRA lipsync workflow is bundled.',
    limitation: 'The exact ID-LoRA, supporting runtime and a product artifact are not certified on the durable volume.',
  }),
  'mask-gen': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    availability: 'Blocked until dependencies are installed',
    sovereignty: 'Self-hosted',
    evidenceLabel: 'The SAM text-mask workflow is bundled as an optional workflow.',
    limitation: 'SAM weights are absent from the certified durable volume.',
  }),
  'kling-o3-i2v': Object.freeze({
    portfolioRole: WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE,
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.TECHNICALLY_VALIDATED,
    availability: 'Cloud credentials required',
    sovereignty: 'Commercial API',
    evidenceLabel: 'Exact Kling O3 Pro model benchmarked blind on the shared identity-motion brief',
    qualityObservation: '6.325/10 weighted: strong motion, but it replaced the requested pivot with a jump and changed the lighting.',
    limitation: 'The benchmark proves the model through the Runway workspace, not this ComfyUI execution route.',
    benchmark: Object.freeze({ model: 'kling-o3-pro', score: 6.325, artifact: 'candidate_b.mp4' }),
  }),
  'seedance2-r2v': Object.freeze({
    evidenceLevel: WORKFLOW_EVIDENCE_LEVELS.TECHNICALLY_VALIDATED,
    availability: 'Cloud credentials required',
    sovereignty: 'Commercial API',
    evidenceLabel: 'Seedance family artifact verified; exact 2.0 workflow still needs product proof',
    limitation: 'The preserved product artifact used another Seedance version/provider route.',
  }),
})

const COMFY_TEMPLATE_PORTFOLIO_OVERRIDES = workflowPortfolioData.comfyTemplateOverrides

function inferEvidenceLevel(workflow) {
  if (!workflow) return WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE
  if (workflow.mode === 'create') return WORKFLOW_EVIDENCE_LEVELS.EXECUTABLE
  if (workflow.imported && workflow.runnable) return WORKFLOW_EVIDENCE_LEVELS.EXECUTABLE
  if (workflow.runnable && workflow.route === 'local') return WORKFLOW_EVIDENCE_LEVELS.INSTALLED
  return WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE
}

function inferSovereignty(workflow) {
  const provider = String(workflow?.provider || '').trim().toLowerCase()
  if (SELF_HOSTED_PROVIDER_NAMES.has(provider) || workflow?.route === 'local') return 'Self-hosted'
  if (workflow?.route === 'custom') return 'User-controlled graph'
  return 'Commercial API'
}

function inferAvailability(workflow) {
  if (workflow?.mode === 'create') return 'Available in Velorn'
  if (!workflow?.runnable) return 'Preview only'
  if (workflow?.route === 'local') return 'Runtime required'
  if (workflow?.route === 'cloud') return 'Cloud credentials required'
  return 'Dependency check required'
}

export function getWorkflowOperationalMetadata(workflow) {
  const workflowId = String(workflow?.workflowId || workflow?.id || '').trim()
  const override = WORKFLOW_EVIDENCE_OVERRIDES[workflowId] || {}
  const category = String(workflow?.category || 'utility').trim()
  return {
    capabilityLane: WORKFLOW_CAPABILITY_LANES[category] || category || 'Utility',
    portfolioRole: override.portfolioRole || WORKFLOW_PORTFOLIO_ROLES.UNASSESSED,
    evidenceLevel: override.evidenceLevel || inferEvidenceLevel(workflow),
    availability: override.availability || inferAvailability(workflow),
    sovereignty: override.sovereignty || inferSovereignty(workflow),
    evidenceLabel: override.evidenceLabel || (
      workflow?.mode === 'create'
        ? 'Native guided-creation surface is present in Velorn'
        : 'No exact product receipt is attached to this workflow yet'
    ),
    qualityObservation: override.qualityObservation || '',
    benchmark: override.benchmark || null,
    limitation: override.limitation || (
      workflow?.runnable
        ? 'Runtime readiness is verified when the workflow is selected.'
        : 'Workflow graph or execution bindings are not complete.'
    ),
  }
}

export function getComfyTemplateOperationalMetadata(template) {
  const templateName = String(template?.name || '').trim()
  const override = COMFY_TEMPLATE_PORTFOLIO_OVERRIDES[templateName] || {}
  return {
    capabilityLane: override.capabilityLane || template?.categoryLabel || 'ComfyUI template',
    portfolioRole: override.portfolioRole || WORKFLOW_PORTFOLIO_ROLES.UNASSESSED,
    evidenceLevel: override.evidenceLevel || WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    modelEvidenceLevel: override.modelEvidenceLevel || override.evidenceLevel || WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    routeEvidenceLevel: override.routeEvidenceLevel || WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE,
    sovereignty: template?.openSource ? 'Open source workflow' : 'Commercial API',
    evidenceLabel: override.evidenceLabel || 'Official ComfyUI template is discoverable; no exact product receipt is attached.',
    qualityObservation: override.qualityObservation || '',
    limitation: override.limitation || 'Import, dependency readiness and an exact-route artifact are still required.',
    benchmark: override.benchmark || null,
  }
}

export function enrichWorkflowWithOperationalMetadata(workflow) {
  if (!workflow || typeof workflow !== 'object') return workflow
  return {
    ...workflow,
    operational: getWorkflowOperationalMetadata(workflow),
  }
}

export function mergeWorkflowRuntimeReadiness(workflow, dependencyCheck) {
  const enriched = enrichWorkflowWithOperationalMetadata(workflow)
  if (!enriched || !dependencyCheck || dependencyCheck.workflowId !== enriched.workflowId) return enriched

  let availability = enriched.operational.availability
  if (dependencyCheck.status === 'ready') availability = 'Ready on connected runtime'
  if (dependencyCheck.status === 'missing') availability = 'Blocked by missing dependencies'
  if (dependencyCheck.status === 'partial') availability = 'Partially verified on connected runtime'
  if (dependencyCheck.status === 'offline') availability = 'Runtime offline'
  if (dependencyCheck.status === 'error') availability = 'Readiness check failed'

  return {
    ...enriched,
    operational: {
      ...enriched.operational,
      availability,
      runtimeStatus: dependencyCheck.status,
    },
  }
}
