const CALIBRATION_PROFILE_SCHEMA = 'velorn.calibration-profile/v1'
const CALIBRATION_PATCH_SCHEMA = 'velorn.calibration-patch/v1'

const WAN_ANIMATE2_PROFILE_ID = 'wan-animate2-identity-motion-v1'
const WAN_ANIMATE2_TEMPLATE_NAMES = new Set(['video_wan_animate2'])
const WAN_ANIMATE2_NATURAL_INTENT_VERSION = 'wan-animate2-natural-intent/v1'
const WAN_ANIMATE2_NATURAL_INTENTS = new Map([
  [
    'conserva al maximo la identidad sigue el movimiento aprobado y bloquea la coreografia',
    Object.freeze({ identityFidelity: 96, motionAdherence: 75, choreographyLock: 100 }),
  ],
  [
    'preserve the approved identity follow the approved motion and lock the choreography',
    Object.freeze({ identityFidelity: 96, motionAdherence: 75, choreographyLock: 100 }),
  ],
])

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function roundTo(value, decimals = 3) {
  const scale = 10 ** decimals
  return Math.round(Number(value) * scale) / scale
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeNaturalIntent(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function resolveCalibrationIntent(profileId, intent) {
  const normalizedProfileId = String(profileId || '').trim()
  const rawIntent = String(intent || '').trim()
  if (!rawIntent) return null
  if (normalizedProfileId !== WAN_ANIMATE2_PROFILE_ID) {
    throw new Error(`Natural calibration intent is unsupported for ${normalizedProfileId || '(missing profile)'}.`)
  }
  const normalizedIntent = normalizeNaturalIntent(rawIntent)
  const controls = WAN_ANIMATE2_NATURAL_INTENTS.get(normalizedIntent)
  if (!controls) {
    throw new Error('Unsupported natural calibration intent. Use a registered intent alias or explicit calibrationControls.')
  }
  return {
    schema: WAN_ANIMATE2_NATURAL_INTENT_VERSION,
    profileId: WAN_ANIMATE2_PROFILE_ID,
    intent: rawIntent,
    normalizedIntent,
    controls: cloneJson(controls),
  }
}

const PROFILE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: WAN_ANIMATE2_PROFILE_ID,
    version: 1,
    schema: CALIBRATION_PROFILE_SCHEMA,
    templateNames: Object.freeze([...WAN_ANIMATE2_TEMPLATE_NAMES]),
    title: 'Wan Animate 2 — Identity/Motion Equalizer',
    lifecycle: 'champion',
    evidenceLevel: 'PRODUCT_PROVEN',
    routeEvidenceLevel: 'PRODUCT_PROVEN',
    evidence: Object.freeze({
      artifact: 'WAN-ANIMATE-PRODUCT-01',
      summary: 'Three intentional variants were compared in Velorn; V2 won. Full-frame output was rejected for background/halo drift and retained only as a reversible face-only identity source.',
      observedCalibration: Object.freeze({
        winner: Object.freeze({ referenceImageStrength: 1.35, poseStrength: 1.25 }),
        highMotionTradeoff: 'pose_strength 1.45 increased motion but introduced morphing.',
        highIdentityTradeoff: 'reference_image_strength 1.5 increased rigidity and flicker.',
      }),
    }),
    controlIds: Object.freeze(['identityFidelity', 'motionAdherence', 'choreographyLock']),
    requiredNodeContracts: Object.freeze([
      Object.freeze({ classType: 'WanAnimate2ToVideo', inputs: Object.freeze(['width', 'height', 'length', 'video_frame_offset', 'pose_strength', 'pose_start_percent', 'pose_end_percent', 'reference_image_strength']) }),
      Object.freeze({ classType: 'CreateVideo', inputs: Object.freeze(['fps']) }),
    ]),
  }),
])

const PROFILE_DESCRIPTOR_BY_ID = new Map(PROFILE_DESCRIPTORS.map((profile) => [profile.id, profile]))
const PROFILE_IDS_BY_TEMPLATE = new Map()
for (const profile of PROFILE_DESCRIPTORS) {
  for (const templateName of profile.templateNames) {
    if (!PROFILE_IDS_BY_TEMPLATE.has(templateName)) PROFILE_IDS_BY_TEMPLATE.set(templateName, [])
    PROFILE_IDS_BY_TEMPLATE.get(templateName).push(profile.id)
  }
}

function getCalibrationProfileDescriptor(profileId) {
  const descriptor = PROFILE_DESCRIPTOR_BY_ID.get(String(profileId || '').trim())
  return descriptor ? cloneJson(descriptor) : null
}

function listCalibrationProfiles({ templateName = '' } = {}) {
  const normalizedTemplateName = String(templateName || '').trim()
  const profileIds = normalizedTemplateName
    ? (PROFILE_IDS_BY_TEMPLATE.get(normalizedTemplateName) || [])
    : PROFILE_DESCRIPTORS.map((profile) => profile.id)
  return profileIds
    .map((profileId) => getCalibrationProfileDescriptor(profileId))
    .filter(Boolean)
}

function summarizeCalibrationProfilesForTemplate(templateName) {
  return listCalibrationProfiles({ templateName }).map((profile) => ({
    id: profile.id,
    version: profile.version,
    schema: profile.schema,
    title: profile.title,
    lifecycle: profile.lifecycle,
    evidenceLevel: profile.evidenceLevel,
    routeEvidenceLevel: profile.routeEvidenceLevel,
    controlIds: profile.controlIds,
    requiredNodeContracts: profile.requiredNodeContracts,
  }))
}

function buildWanAnimate2Calibration(templateName, args = {}, plan = {}) {
  if (!WAN_ANIMATE2_TEMPLATE_NAMES.has(String(templateName || '').trim())) return null

  const requestedProfileId = String(args.calibrationProfileId || '').trim()
  if (requestedProfileId && requestedProfileId !== WAN_ANIMATE2_PROFILE_ID) {
    throw new Error(`Unsupported CalibrationProfile for ${templateName}: ${requestedProfileId}.`)
  }

  const explicitControls = args.calibrationControls && typeof args.calibrationControls === 'object'
    ? args.calibrationControls
    : {}
  const resolvedIntent = resolveCalibrationIntent(WAN_ANIMATE2_PROFILE_ID, args.calibrationIntent)
  if (resolvedIntent) {
    for (const [controlId, naturalValue] of Object.entries(resolvedIntent.controls)) {
      if (Object.hasOwn(explicitControls, controlId) && Number(explicitControls[controlId]) !== Number(naturalValue)) {
        throw new Error(`Calibration intent conflicts with explicit calibrationControls.${controlId}.`)
      }
    }
  }
  const requestedControls = {
    ...(resolvedIntent?.controls || {}),
    ...explicitControls,
  }
  const identityFidelity = clampNumber(requestedControls.identityFidelity, 0, 100, 96)
  const motionAdherence = clampNumber(requestedControls.motionAdherence, 0, 100, 75)
  const choreographyLock = clampNumber(requestedControls.choreographyLock, 0, 100, 100)
  const width = Math.max(16, Math.round(clampNumber(args.resolution?.width, 16, 8192, 480) / 16) * 16)
  const height = Math.max(16, Math.round(clampNumber(args.resolution?.height, 16, 8192, 848) / 16) * 16)
  const fps = clampNumber(args.fps, 1, 240, 24)
  const durationSeconds = clampNumber(args.durationSeconds ?? args.duration, 0.1, 170, 3.375)
  const length = Math.max(1, 1 + (Math.ceil((durationSeconds * fps - 1) / 4) * 4))
  const referenceImageStrength = roundTo(1.05 + identityFidelity * 0.003125, 3)
  const poseStrength = roundTo(0.5 + motionAdherence * 0.01, 3)
  const poseEndPercent = choreographyLock >= 50 ? 1 : roundTo(0.8 + choreographyLock * 0.004, 3)

  const controls = {
    identityFidelity,
    motionAdherence,
    choreographyLock,
  }
  const patch = {
    schema: CALIBRATION_PATCH_SCHEMA,
    profileId: WAN_ANIMATE2_PROFILE_ID,
    profileVersion: 1,
    templateName: String(templateName || '').trim(),
    workflowSha256: '772a7dfce6d5b61b8f838ec0609211a0c9b1c04a7c64e26d05f0852f147edac7',
    controls,
    operations: [
      {
        target: { classType: 'WanAnimate2ToVideo' },
        inputs: {
          width,
          height,
          length,
          video_frame_offset: 160,
          pose_strength: poseStrength,
          pose_start_percent: 0,
          pose_end_percent: poseEndPercent,
          reference_image_strength: referenceImageStrength,
        },
      },
      {
        target: { classType: 'CreateVideo' },
        inputs: { fps },
      },
    ],
  }

  return {
    schema: CALIBRATION_PROFILE_SCHEMA,
    id: WAN_ANIMATE2_PROFILE_ID,
    version: 1,
    title: 'Wan Animate 2 — Identity/Motion Equalizer',
    lifecycle: 'champion',
    evidenceLevel: 'PRODUCT_PROVEN',
    routeEvidenceLevel: 'PRODUCT_PROVEN',
    templateName: String(templateName || '').trim(),
    preset: {
      id: 'product-v2-balanced-face-source',
      label: 'Product-proven V2 balance',
      evidence: 'WAN-ANIMATE-PRODUCT-01 — variant V2 selected; face-only reversible finishing preserved body, environment, and original audio.',
    },
    controls: [
      {
        id: 'identityFidelity',
        label: 'Identity fidelity',
        min: 0,
        max: 100,
        step: 1,
        value: identityFidelity,
        mapsTo: 'WanAnimate2ToVideo.reference_image_strength',
        technicalValue: referenceImageStrength,
        observedRange: { recommended: [80, 100], winner: 96 },
      },
      {
        id: 'motionAdherence',
        label: 'Motion adherence',
        min: 0,
        max: 100,
        step: 1,
        value: motionAdherence,
        mapsTo: 'WanAnimate2ToVideo.pose_strength',
        technicalValue: poseStrength,
        observedRange: { recommended: [65, 80], winner: 75 },
      },
      {
        id: 'choreographyLock',
        label: 'Choreography lock',
        min: 0,
        max: 100,
        step: 1,
        value: choreographyLock,
        mapsTo: 'WanAnimate2ToVideo.pose_end_percent',
        technicalValue: poseEndPercent,
        observedRange: { recommended: [95, 100], winner: 100 },
      },
    ],
    technicalParameters: {
      width,
      height,
      length,
      fps,
      videoFrameOffset: 160,
      poseStartPercent: 0,
      poseEndPercent,
      poseStrength,
      referenceImageStrength,
      seed: Number.isFinite(Number(plan.seed)) ? Number(plan.seed) : null,
    },
    locks: {
      aspectRatio: true,
      dimensionsMultipleOf: 16,
      wanFrameRule: '1 + 4n',
      poseStartPercent: 0,
      videoFrameOffset: 160,
      nonDestructiveOutput: true,
      originalTimelineMediaPreserved: true,
      backgroundPreservationClaim: false,
    },
    checkpoint: {
      requiredBeforeApply: true,
      tool: 'create_project_checkpoint',
      label: `Before ${WAN_ANIMATE2_PROFILE_ID}`,
    },
    undo: {
      strategy: 'restore_project_checkpoint',
      suggestedCall: {
        tool: 'restore_project_checkpoint',
        arguments: { previewOnly: true, saveProject: false },
      },
    },
    estimatedCost: {
      currency: 'USD',
      hardwareClass: 'RTX PRO 6000 equivalent',
      billingBasis: 'runtime-dependent',
      estimatedRange: [0.2, 1.0],
      requiresExplicitAuthorization: true,
      note: 'Estimate only. Actual GPU/provider price and runtime must be recorded in the receipt.',
    },
    evidence: {
      artifact: 'WAN-ANIMATE-PRODUCT-01',
      result: 'V2 selected after three intentional variants. Full-frame output was rejected for background/halo drift; approved usage was a reversible face-only identity source.',
      observedCalibration: {
        winner: { referenceImageStrength: 1.35, poseStrength: 1.25 },
        highMotionTradeoff: 'pose_strength 1.45 increased movement but introduced morphing.',
        highIdentityTradeoff: 'reference_image_strength 1.5 increased rigidity and flicker.',
      },
    },
    retake: {
      mode: 'review-lane-first',
      targetClipId: String(args.retakeTargetClipId || '').trim() || null,
      timelineRange: {
        startTimeSeconds: Number.isFinite(Number(args.retakeStartTimeSeconds)) ? Number(args.retakeStartTimeSeconds) : null,
        durationSeconds,
      },
      identitySourceClipId: plan.sourceClipId || null,
      identitySourceFrameTimeSeconds: Number.isFinite(Number(plan.sourceFrameTimeSeconds))
        ? Number(plan.sourceFrameTimeSeconds)
        : null,
      motionSourceAssetId: String(args.assetFieldIds?.templateInput1 || '').trim() || null,
      motionFrameOffset: 160,
      outputPlacement: {
        tool: 'add_asset_to_timeline',
        mode: 'review_lane',
        destructiveReplacement: false,
      },
    },
    requiredInputs: [
      { role: 'identity_reference', field: 'primary asset', type: 'image or timeline video frame' },
      { role: 'motion_reference', field: 'templateInput1', type: 'video' },
      { role: 'prompt', field: 'prompt', type: 'text' },
    ],
    intentEquivalence: {
      schema: WAN_ANIMATE2_NATURAL_INTENT_VERSION,
      source: resolvedIntent ? 'natural-language' : (Object.keys(explicitControls).length > 0 ? 'manual-controls' : 'profile-default'),
      intent: resolvedIntent?.intent || null,
      normalizedIntent: resolvedIntent?.normalizedIntent || null,
      canonicalControls: cloneJson(controls),
      manualEquivalent: { calibrationControls: cloneJson(controls) },
      deterministic: true,
    },
    calibrationPatch: patch,
  }
}

const PROFILE_BUILDERS = Object.freeze({
  [WAN_ANIMATE2_PROFILE_ID]: buildWanAnimate2Calibration,
})

function resolveCalibrationProfile(templateName, args = {}, plan = {}) {
  const normalizedTemplateName = String(templateName || '').trim()
  const supportedProfileIds = PROFILE_IDS_BY_TEMPLATE.get(normalizedTemplateName) || []
  const requestedProfileId = String(args.calibrationProfileId || '').trim()

  if (requestedProfileId && !supportedProfileIds.includes(requestedProfileId)) {
    throw new Error(`Unsupported CalibrationProfile for ${normalizedTemplateName || '(missing template)'}: ${requestedProfileId}.`)
  }
  if (supportedProfileIds.length === 0) return null

  const profileId = requestedProfileId || supportedProfileIds[0]
  const builder = PROFILE_BUILDERS[profileId]
  if (typeof builder !== 'function') {
    throw new Error(`CalibrationProfile ${profileId} has no executable builder.`)
  }
  return builder(normalizedTemplateName, args, plan)
}

module.exports = {
  CALIBRATION_PROFILE_SCHEMA,
  CALIBRATION_PATCH_SCHEMA,
  WAN_ANIMATE2_PROFILE_ID,
  WAN_ANIMATE2_NATURAL_INTENT_VERSION,
  resolveCalibrationIntent,
  getCalibrationProfileDescriptor,
  listCalibrationProfiles,
  summarizeCalibrationProfilesForTemplate,
  resolveCalibrationProfile,
}
