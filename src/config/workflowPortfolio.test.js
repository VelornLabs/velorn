import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeComfyTemplateIndex } from '../services/comfyTemplateCatalog.js'
import {
  WORKFLOW_EVIDENCE_LEVELS,
  WORKFLOW_PORTFOLIO_ROLES,
  enrichWorkflowWithOperationalMetadata,
  getComfyTemplateOperationalMetadata,
  getWorkflowOperationalMetadata,
  mergeWorkflowRuntimeReadiness,
} from './workflowPortfolio.js'

test('keeps exact product proof narrower than provider-family evidence', () => {
  const seedance = getWorkflowOperationalMetadata({
    id: 'seedance2-r2v',
    workflowId: 'seedance2-r2v',
    route: 'cloud',
    category: 'image-to-video',
    provider: 'ByteDance',
    runnable: true,
  })
  const wan = getWorkflowOperationalMetadata({
    id: 'wan22-i2v',
    workflowId: 'wan22-i2v',
    route: 'local',
    category: 'image-to-video',
    provider: 'Local',
    runnable: true,
  })
  const wanT2v = getWorkflowOperationalMetadata({
    id: 'wan22-t2v',
    workflowId: 'wan22-t2v',
    route: 'local',
    category: 'text-to-video',
    provider: 'Local',
    runnable: true,
  })

  assert.equal(seedance.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.TECHNICALLY_VALIDATED)
  assert.match(seedance.evidenceLabel, /exact 2\.0 workflow still needs product proof/i)
  assert.match(seedance.limitation, /another Seedance version\/provider route/i)
  assert.equal(wan.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(wan.evidenceLabel, /exact bundled workflow hash is recorded as BLOCKED/i)
  assert.match(wan.limitation, /route proof cannot be inherited|evidence cannot be transferred/i)
  assert.equal(wanT2v.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(wanT2v.evidenceLabel, /distinct B200 wan_t2v_stable_v1 route/i)
  assert.match(wanT2v.limitation, /route proof cannot be inherited/i)
})

test('keeps benchmarked model evidence separate from the exact ComfyUI route', () => {
  const seedance = getComfyTemplateOperationalMetadata({
    name: 'api_seedance2_5_i2v_1080p',
    categoryLabel: 'Video',
    openSource: false,
  })
  const nanoBanana = getComfyTemplateOperationalMetadata({
    name: 'api_nano_banana_pro',
    categoryLabel: 'Image',
    openSource: false,
  })

  assert.equal(seedance.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.CHAMPION)
  assert.equal(seedance.modelEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
  assert.equal(seedance.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.equal(seedance.benchmark.score, 9.55)
  assert.equal(nanoBanana.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.SPECIALIST_CHAMPION)
  assert.equal(nanoBanana.benchmark.specialty, 'identity')
})

test('recognizes the exact Wan Animate 2 product route without inflating adjacent model routes', () => {
  const wanAnimate = getComfyTemplateOperationalMetadata({
    name: 'video_wan_animate2',
    categoryLabel: 'Video',
    openSource: true,
  })
  const seedance = getComfyTemplateOperationalMetadata({
    name: 'api_seedance2_5_i2v_1080p',
    categoryLabel: 'Video',
    openSource: false,
  })

  assert.equal(wanAnimate.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.SPECIALIST_CHAMPION)
  assert.equal(wanAnimate.modelEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
  assert.equal(wanAnimate.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
  assert.match(wanAnimate.qualityObservation, /reference image strength 1\.35.*pose strength 1\.25/i)
  assert.match(wanAnimate.limitation, /Full-frame output did not preserve/i)
  assert.equal(seedance.modelEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
  assert.equal(seedance.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
})

test('marks frontier templates blocked without inflating installed weights into execution proof', () => {
  const ltx25 = getComfyTemplateOperationalMetadata({
    name: 'api_ltx2_5_i2v',
    categoryLabel: 'Video',
    openSource: false,
  })
  const trellis = getComfyTemplateOperationalMetadata({
    name: '3d_pixal3d_trellis2_image_to_model',
    categoryLabel: '3D',
    openSource: true,
  })

  assert.equal(ltx25.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED)
  assert.equal(ltx25.modelEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.INSTALLED)
  assert.equal(ltx25.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(ltx25.limitation, /HTTP 403/i)
  assert.equal(trellis.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED)
  assert.match(trellis.limitation, /weights.*absent/i)
})

test('keeps audio product evidence narrower than the exact Velorn route', () => {
  const elevenLabs = getWorkflowOperationalMetadata({
    id: 'elevenlabs-tts',
    workflowId: 'elevenlabs-tts',
    route: 'cloud',
    category: 'audio',
    provider: 'ElevenLabs',
    runnable: true,
  })
  const music = getWorkflowOperationalMetadata({
    id: 'music-gen',
    workflowId: 'music-gen',
    route: 'local',
    category: 'audio',
    provider: 'Local',
    runnable: true,
  })

  assert.equal(elevenLabs.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE)
  assert.equal(elevenLabs.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.TECHNICALLY_VALIDATED)
  assert.match(elevenLabs.limitation, /authorization does not prove this exact bundled workflow.*artifact and receipt/i)
  assert.equal(music.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED)
  assert.match(music.limitation, /No durable ACE-Step weights were present/i)
})

test('keeps provider matte proof separate from official Bria template execution', () => {
  const matte = getComfyTemplateOperationalMetadata({
    name: 'api_bria_remove_video_background_transparent',
    categoryLabel: 'Video',
    openSource: false,
  })
  const soundEffects = getComfyTemplateOperationalMetadata({
    name: 'api_elevenlabs_text_to_sound_effects',
    categoryLabel: 'Audio',
    openSource: false,
  })

  assert.equal(matte.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE)
  assert.equal(matte.modelEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
  assert.equal(matte.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(matte.limitation, /not the exact official Bria template route/i)
  assert.equal(soundEffects.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.FRONTIER_CANDIDATE)
  assert.equal(soundEffects.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(soundEffects.limitation, /No exact SFX artifact/i)
})

test('keeps finishing and 3D routes honest about installed assets and exact product proof', () => {
  const interpolation = getWorkflowOperationalMetadata({
    id: 'frame-interpolation',
    workflowId: 'frame-interpolation',
    route: 'local',
    category: 'video',
    provider: 'Local',
    runnable: true,
  })
  const officialInterpolation = getComfyTemplateOperationalMetadata({
    name: 'utility_video_frame_interpolation',
    categoryLabel: 'Video',
    openSource: true,
  })
  const topaz = getComfyTemplateOperationalMetadata({
    name: 'api_topaz_astra2',
    categoryLabel: 'Video',
    openSource: false,
  })
  const topazWorkflow = getWorkflowOperationalMetadata({
    id: 'topaz-video-upscale',
    workflowId: 'topaz-video-upscale',
    route: 'cloud',
    category: 'upscale',
    provider: 'Topaz',
    runnable: true,
  })
  const meshy = getComfyTemplateOperationalMetadata({
    name: 'api_meshy7_image_to_model',
    categoryLabel: '3D',
    openSource: false,
  })
  const trellis = getComfyTemplateOperationalMetadata({
    name: '3d_pixal3d_trellis2_image_to_model',
    categoryLabel: '3D',
    openSource: true,
  })

  assert.equal(interpolation.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.SOVEREIGN_ALTERNATIVE)
  assert.equal(interpolation.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(interpolation.evidenceLabel, /RIFE 4\.26 assets are installed.*bundled graph references FILM/i)
  assert.match(interpolation.limitation, /FILM weights were not found/i)
  assert.equal(officialInterpolation.modelEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.INSTALLED)
  assert.equal(officialInterpolation.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(officialInterpolation.limitation, /RIFE requires a separate exact graph/i)
  assert.equal(topaz.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE)
  assert.match(topaz.limitation, /Astra 2 itself remains unbenchmarked/i)
  assert.equal(topazWorkflow.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.PREMIUM_ALTERNATIVE)
  assert.match(topazWorkflow.evidenceLabel, /Starlight and Astra are exposed/i)
  assert.match(topazWorkflow.limitation, /Runway 4K upscaler was rejected/i)
  assert.equal(meshy.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.match(meshy.limitation, /No comparable 3D artifact/i)
  assert.equal(trellis.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.FRONTIER_BLOCKED)
})

test('leaves unknown official templates unassessed instead of assigning a winner by default', () => {
  const unknown = getComfyTemplateOperationalMetadata({
    name: 'future-template',
    categoryLabel: 'Video',
    openSource: false,
  })

  assert.equal(unknown.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.UNASSESSED)
  assert.equal(unknown.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.equal(unknown.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
})

test('enriches official Comfy templates without changing their import identity', () => {
  const index = normalizeComfyTemplateIndex([{ title: 'Video', templates: [{
    name: 'api_seedance2_5_i2v_1080p',
    title: 'Seedance 2.5 I2V',
    models: ['Seedance 2.5'],
    openSource: false,
  }] }])
  const template = index.templates[0]

  assert.equal(template.name, 'api_seedance2_5_i2v_1080p')
  assert.deepEqual(template.models, ['Seedance 2.5'])
  assert.match(template.workflowUrl, /api_seedance2_5_i2v_1080p\.json$/)
  assert.equal(template.operational.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.CHAMPION)
  assert.equal(template.operational.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.DISCOVERABLE)
  assert.deepEqual(template.calibrationProfiles, [])

  const wanIndex = normalizeComfyTemplateIndex([{ title: 'Video', templates: [{
    name: 'video_wan_animate2',
    title: 'Wan Animate 2',
    models: ['Wan Animate 2'],
    openSource: true,
  }] }])
  assert.equal(wanIndex.templates[0].operational.portfolioRole, WORKFLOW_PORTFOLIO_ROLES.SPECIALIST_CHAMPION)
  assert.equal(wanIndex.templates[0].operational.routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
  assert.equal(wanIndex.templates[0].calibrationProfiles.length, 1)
  assert.equal(wanIndex.templates[0].calibrationProfiles[0].id, 'wan-animate2-identity-motion-v1')
  assert.equal(wanIndex.templates[0].calibrationProfiles[0].routeEvidenceLevel, WORKFLOW_EVIDENCE_LEVELS.PRODUCT_PROVEN)
})

test('derives operational metadata without duplicating workflow bindings', () => {
  const source = {
    id: 'custom-candidate',
    workflowId: 'custom-candidate',
    route: 'custom',
    category: 'video',
    provider: 'Velorn',
    fields: [{ id: 'prompt' }],
    runnable: true,
  }
  const enriched = enrichWorkflowWithOperationalMetadata(source)

  assert.notEqual(enriched, source)
  assert.deepEqual(enriched.fields, source.fields)
  assert.equal(source.operational, undefined)
  assert.equal(enriched.operational.sovereignty, 'Self-hosted')
  assert.equal(enriched.operational.capabilityLane, 'Video')
})

test('runtime readiness changes availability without promoting evidence', () => {
  const workflow = {
    id: 'ltx23-i2v',
    workflowId: 'ltx23-i2v',
    route: 'local',
    category: 'image-to-video',
    provider: 'Local',
    runnable: true,
  }
  const ready = mergeWorkflowRuntimeReadiness(workflow, {
    workflowId: 'ltx23-i2v',
    status: 'ready',
  })
  const missing = mergeWorkflowRuntimeReadiness(workflow, {
    workflowId: 'ltx23-i2v',
    status: 'missing',
  })

  assert.equal(ready.operational.availability, 'Ready on connected runtime')
  assert.equal(missing.operational.availability, 'Blocked by missing dependencies')
  assert.equal(ready.operational.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.INSTALLED)
  assert.equal(missing.operational.evidenceLevel, WORKFLOW_EVIDENCE_LEVELS.INSTALLED)
})
