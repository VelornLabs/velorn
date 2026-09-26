import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyCalibrationPatch,
  buildCalibrationArtifactMetadata,
} from './workflowCalibration.js'

function makeWorkflow() {
  return {
    '12:34': {
      class_type: 'WanAnimate2ToVideo',
      inputs: {
        width: 832,
        height: 480,
        length: 81,
        video_frame_offset: 0,
        pose_strength: 1,
        pose_start_percent: 0,
        pose_end_percent: 1,
        reference_image_strength: 1,
      },
    },
    '56:78': {
      class_type: 'CreateVideo',
      inputs: { fps: 16 },
    },
    '90': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'wan_animate_2_int8_convrot.safetensors' },
    },
  }
}

function makePatch() {
  return {
    schema: 'velorn.calibration-patch/v1',
    profileId: 'wan-animate2-identity-motion-v1',
    profileVersion: 1,
    templateName: 'video_wan_animate2',
    workflowSha256: '772a7dfce6d5b61b8f838ec0609211a0c9b1c04a7c64e26d05f0852f147edac7',
    operations: [
      {
        target: { classType: 'WanAnimate2ToVideo', occurrence: 'all' },
        inputs: {
          width: 480,
          height: 848,
          length: 81,
          video_frame_offset: 160,
          pose_strength: 1.2,
          pose_start_percent: 0,
          pose_end_percent: 0.9,
          reference_image_strength: 1.35,
        },
      },
      {
        target: { classType: 'CreateVideo', occurrence: 'all' },
        inputs: { fps: 24 },
      },
    ],
  }
}

test('applies a Wan Animate 2 CalibrationPatch without mutating the source workflow', () => {
  const source = makeWorkflow()
  const patched = applyCalibrationPatch(source, makePatch())

  assert.equal(source['12:34'].inputs.width, 832)
  assert.equal(source['56:78'].inputs.fps, 16)
  assert.deepEqual(patched['12:34'].inputs, {
    width: 480,
    height: 848,
    length: 81,
    video_frame_offset: 160,
    pose_strength: 1.2,
    pose_start_percent: 0,
    pose_end_percent: 0.9,
    reference_image_strength: 1.35,
  })
  assert.equal(patched['56:78'].inputs.fps, 24)
  assert.equal(patched['90'].inputs.unet_name, 'wan_animate_2_int8_convrot.safetensors')
  assert.deepEqual(patched.__calibrationApplied, [
    {
      nodeId: '12:34',
      classType: 'WanAnimate2ToVideo',
      inputKeys: [
        'width',
        'height',
        'length',
        'video_frame_offset',
        'pose_strength',
        'pose_start_percent',
        'pose_end_percent',
        'reference_image_strength',
      ],
    },
    { nodeId: '56:78', classType: 'CreateVideo', inputKeys: ['fps'] },
  ])
})

test('rejects attempts to use CalibrationPatch as an arbitrary workflow editor', () => {
  const patch = makePatch()
  patch.operations[0].inputs.model = 'different-model.safetensors'

  assert.throws(
    () => applyCalibrationPatch(makeWorkflow(), patch),
    /cannot modify WanAnimate2ToVideo\.model/
  )
})

test('rejects a CalibrationPatch that overrides a locked technical parameter', () => {
  const patch = makePatch()
  patch.operations[0].inputs.video_frame_offset = 0

  assert.throws(
    () => applyCalibrationPatch(makeWorkflow(), patch),
    /cannot override locked WanAnimate2ToVideo\.video_frame_offset=160/
  )
})

test('rejects unknown, stale or route-mismatched CalibrationProfiles', () => {
  const unknown = makePatch()
  unknown.profileId = 'unregistered-profile'
  assert.throws(() => applyCalibrationPatch(makeWorkflow(), unknown), /profileId is not registered/)

  const stale = makePatch()
  stale.profileVersion = 2
  assert.throws(() => applyCalibrationPatch(makeWorkflow(), stale), /profileVersion must be 1/)

  const wrongTemplate = makePatch()
  wrongTemplate.templateName = 'video_wan_animate2_distilled'
  assert.throws(() => applyCalibrationPatch(makeWorkflow(), wrongTemplate), /templateName must be video_wan_animate2/)

  const wrongHash = makePatch()
  wrongHash.workflowSha256 = '0'.repeat(64)
  assert.throws(() => applyCalibrationPatch(makeWorkflow(), wrongHash), /workflowSha256 does not match/)
})

test('builds materialized artifact provenance without mutating queue-time calibration data', () => {
  const profile = { id: 'wan-animate2-identity-motion-v1', version: 1 }
  const patch = makePatch()
  const job = {
    workflowId: 'tpl-video_wan_animate2',
    workflowLabel: 'Wan Animate 2',
    calibrationProfile: profile,
    calibrationPatch: patch,
    calibrationReceipt: {
      schema: 'velorn.calibration-receipt/v1',
      status: 'prepared',
      sourceAssetId: 'asset-identity',
      sourceFrameTimeSeconds: 3.542,
    },
  }

  const metadata = buildCalibrationArtifactMetadata(job, {
    promptId: 'prompt-123',
    workflowId: job.workflowId,
    materializedAt: '2026-09-07T20:30:00.000Z',
  })

  assert.equal(metadata.profile.id, profile.id)
  assert.equal(metadata.patch.profileId, patch.profileId)
  assert.deepEqual(metadata.receipt, {
    schema: 'velorn.calibration-receipt/v1',
    status: 'materialized',
    sourceAssetId: 'asset-identity',
    sourceFrameTimeSeconds: 3.542,
    promptId: 'prompt-123',
    workflowId: 'tpl-video_wan_animate2',
    workflowLabel: 'Wan Animate 2',
    materializedAt: '2026-09-07T20:30:00.000Z',
  })
  metadata.profile.id = 'mutated'
  assert.equal(profile.id, 'wan-animate2-identity-motion-v1')
})

test('fails closed when the expected workflow class is absent', () => {
  const workflow = {
    '1': { class_type: 'KSampler', inputs: { seed: 42 } },
  }

  assert.throws(
    () => applyCalibrationPatch(workflow, makePatch()),
    /expected at least one WanAnimate2ToVideo node/
  )
})

test('fails closed instead of ignoring an unsupported occurrence selector', () => {
  const workflow = makeWorkflow()
  workflow['12:35'] = {
    class_type: 'WanAnimate2ToVideo',
    inputs: { video_frame_offset: 160, pose_start_percent: 0 },
  }
  const patch = makePatch()
  patch.operations[0].target.occurrence = 'first'

  assert.throws(
    () => applyCalibrationPatch(workflow, patch),
    /occurrence must be all for WanAnimate2ToVideo; received first/
  )
})
