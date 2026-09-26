import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyImportedWorkflowBindings,
  detectImportedWorkflowBindings,
} from './importedWorkflowBindings.js'

test('detects and replaces MiniMax H3 model.prompt without touching the source image', () => {
  const workflow = {
    2: {
      class_type: 'LoadImage',
      inputs: { image: 'old-reference.png' },
    },
    4: {
      class_type: 'MinimaxHailuo03FirstLastFrameNode',
      inputs: {
        first_frame: ['2', 0],
        'model.prompt': 'Old character-specific prompt',
        seed: 42,
      },
    },
    5: {
      class_type: 'SaveVideo',
      inputs: { video: ['4', 0], filename_prefix: 'video/test' },
    },
  }

  const detected = detectImportedWorkflowBindings(workflow, null)

  assert.deepEqual(detected.bindings.prompt, {
    nodeId: '4',
    inputKey: 'model.prompt',
  })

  const bound = applyImportedWorkflowBindings(workflow, detected.bindings, {
    prompt: 'Clean paper-city motion prompt',
    inputImage: '01_city_stage.png',
    seed: 310001,
  })

  assert.equal(bound['4'].inputs['model.prompt'], 'Clean paper-city motion prompt')
  assert.equal(bound['2'].inputs.image, '01_city_stage.png')
  assert.equal(bound['4'].inputs.seed, 310001)
})

test('applies imported bindings and a Wan Animate 2 CalibrationPatch in one queue-time pass', () => {
  const workflow = {
    '1': { class_type: 'LoadImage', inputs: { image: 'old-reference.png' } },
    '2': { class_type: 'LoadVideo', inputs: { file: 'old-motion.mp4' } },
    '3': {
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
    '4': { class_type: 'CreateVideo', inputs: { fps: 16 } },
  }
  const bindings = {
    assets: [
      { source: 'primary', nodeId: '1', inputKey: 'image', assetType: 'image' },
      { source: 'field', fieldId: 'templateInput1', nodeId: '2', inputKey: 'file', assetType: 'video' },
    ],
    parameters: [],
    seeds: [],
    outputPrefixes: [],
  }

  const bound = applyImportedWorkflowBindings(workflow, bindings, {
    inputImage: 'approved-identity.png',
    assetFieldFilenames: { templateInput1: 'dynamic-shot.mp4' },
    calibrationPatch: {
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
            pose_strength: 1.1,
            pose_start_percent: 0,
            pose_end_percent: 1,
            reference_image_strength: 1.3,
          },
        },
        { target: { classType: 'CreateVideo', occurrence: 'all' }, inputs: { fps: 24 } },
      ],
    },
  })

  assert.equal(bound['1'].inputs.image, 'approved-identity.png')
  assert.equal(bound['2'].inputs.file, 'dynamic-shot.mp4')
  assert.equal(bound['3'].inputs.reference_image_strength, 1.3)
  assert.equal(bound['3'].inputs.pose_strength, 1.1)
  assert.equal(bound['4'].inputs.fps, 24)
})
