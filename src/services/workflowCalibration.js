const CALIBRATION_PATCH_SCHEMA = 'velorn.calibration-patch/v1'

const CALIBRATION_PROFILE_CONTRACTS = Object.freeze({
  'wan-animate2-identity-motion-v1': Object.freeze({
    version: 1,
    templateName: 'video_wan_animate2',
    workflowSha256: '772a7dfce6d5b61b8f838ec0609211a0c9b1c04a7c64e26d05f0852f147edac7',
    allowedClasses: new Set(['WanAnimate2ToVideo', 'CreateVideo']),
    lockedInputsByClass: Object.freeze({
      WanAnimate2ToVideo: Object.freeze({
        video_frame_offset: 160,
        pose_start_percent: 0,
      }),
    }),
  }),
})

const ALLOWED_INPUTS_BY_CLASS = Object.freeze({
  WanAnimate2ToVideo: new Set([
    'width',
    'height',
    'length',
    'video_frame_offset',
    'pose_strength',
    'pose_start_percent',
    'pose_end_percent',
    'reference_image_strength',
  ]),
  CreateVideo: new Set(['fps']),
})

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertFiniteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`CalibrationPatch ${label} must be a finite number.`)
  return number
}

function validatePatchContract(patch) {
  const profileId = String(patch?.profileId || '').trim()
  const contract = CALIBRATION_PROFILE_CONTRACTS[profileId]
  if (!contract) throw new Error(`CalibrationPatch profileId is not registered: ${profileId || '(missing)'}.`)
  if (Number(patch.profileVersion) !== contract.version) {
    throw new Error(`CalibrationPatch profileVersion must be ${contract.version} for ${profileId}.`)
  }
  if (String(patch.templateName || '').trim() !== contract.templateName) {
    throw new Error(`CalibrationPatch templateName must be ${contract.templateName} for ${profileId}.`)
  }
  if (String(patch.workflowSha256 || '').trim() !== contract.workflowSha256) {
    throw new Error(`CalibrationPatch workflowSha256 does not match the registered ${profileId} route.`)
  }
  return contract
}

function validateInputValue(classType, inputKey, rawValue) {
  const value = assertFiniteNumber(rawValue, `${classType}.${inputKey}`)
  if (classType === 'WanAnimate2ToVideo') {
    if (inputKey === 'width' || inputKey === 'height') {
      if (value < 16 || value > 8192 || value % 16 !== 0) {
        throw new Error(`CalibrationPatch ${inputKey} must be a multiple of 16 between 16 and 8192.`)
      }
      return Math.round(value)
    }
    if (inputKey === 'length') {
      if (value < 1 || value > 4097 || (Math.round(value) - 1) % 4 !== 0) {
        throw new Error('CalibrationPatch length must be 1 + 4n frames between 1 and 4097.')
      }
      return Math.round(value)
    }
    if (inputKey === 'video_frame_offset') {
      if (value < 0 || !Number.isInteger(value)) {
        throw new Error('CalibrationPatch video_frame_offset must be a non-negative integer.')
      }
      return value
    }
    if (inputKey === 'pose_strength' || inputKey === 'reference_image_strength') {
      if (value < 0 || value > 10) {
        throw new Error(`CalibrationPatch ${inputKey} must be between 0 and 10.`)
      }
      return value
    }
    if (inputKey === 'pose_start_percent' || inputKey === 'pose_end_percent') {
      if (value < 0 || value > 1) {
        throw new Error(`CalibrationPatch ${inputKey} must be between 0 and 1.`)
      }
      return value
    }
  }
  if (classType === 'CreateVideo' && inputKey === 'fps') {
    if (value <= 0 || value > 240) throw new Error('CalibrationPatch fps must be greater than 0 and at most 240.')
    return value
  }
  return value
}

export function buildCalibrationArtifactMetadata(job, {
  promptId = job?.promptId || null,
  workflowId = job?.workflowId || null,
  materializedAt = new Date().toISOString(),
} = {}) {
  if (!job?.calibrationProfile) return null
  return {
    profile: cloneJson(job.calibrationProfile),
    patch: job.calibrationPatch ? cloneJson(job.calibrationPatch) : null,
    receipt: {
      ...(job.calibrationReceipt ? cloneJson(job.calibrationReceipt) : {}),
      status: 'materialized',
      promptId,
      workflowId,
      workflowLabel: String(job?.workflowLabel || ''),
      materializedAt,
    },
  }
}

export function applyCalibrationPatch(workflowJson, patch) {
  const workflow = cloneJson(workflowJson || {})
  if (!patch) return workflow
  if (patch.schema !== CALIBRATION_PATCH_SCHEMA) {
    throw new Error(`Unsupported CalibrationPatch schema: ${patch.schema || '(missing)'}.`)
  }
  const contract = validatePatchContract(patch)
  const operations = Array.isArray(patch.operations) ? patch.operations : []
  if (operations.length === 0) throw new Error('CalibrationPatch has no operations.')

  const applied = []
  for (const operation of operations) {
    const classType = String(operation?.target?.classType || '').trim()
    const occurrence = String(operation?.target?.occurrence || '').trim()
    const allowedInputs = ALLOWED_INPUTS_BY_CLASS[classType]
    if (!allowedInputs || !contract.allowedClasses.has(classType)) {
      throw new Error(`CalibrationPatch cannot target class ${classType || '(missing)'}.`)
    }
    if (occurrence !== 'all') {
      throw new Error(
        `CalibrationPatch occurrence must be all for ${classType}; received ${occurrence || '(missing)'}.`
      )
    }

    const inputs = operation?.inputs && typeof operation.inputs === 'object' ? operation.inputs : {}
    const inputEntries = Object.entries(inputs)
    if (inputEntries.length === 0) throw new Error(`CalibrationPatch operation for ${classType} has no inputs.`)
    for (const [inputKey, rawValue] of inputEntries) {
      if (!allowedInputs.has(inputKey)) {
        throw new Error(`CalibrationPatch cannot modify ${classType}.${inputKey}.`)
      }
      const lockedValue = contract.lockedInputsByClass?.[classType]?.[inputKey]
      if (typeof lockedValue !== 'undefined' && Number(rawValue) !== lockedValue) {
        throw new Error(`CalibrationPatch cannot override locked ${classType}.${inputKey}=${lockedValue}.`)
      }
    }

    const targets = Object.entries(workflow)
      .filter(([, node]) => String(node?.class_type || '').trim() === classType)
    if (targets.length === 0) {
      throw new Error(`CalibrationPatch expected at least one ${classType} node, but none was found.`)
    }

    for (const [nodeId, node] of targets) {
      if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {}
      for (const [inputKey, rawValue] of inputEntries) {
        node.inputs[inputKey] = validateInputValue(classType, inputKey, rawValue)
      }
      applied.push({ nodeId, classType, inputKeys: inputEntries.map(([inputKey]) => inputKey) })
    }
  }

  Object.defineProperty(workflow, '__calibrationApplied', {
    value: applied,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return workflow
}

export { CALIBRATION_PATCH_SCHEMA }
