'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  tools, writableTools, nativeToolNames, defaultPreviewOnly,
  normalizeComfyRouterArgs, dispatchComfyRouterTool,
} = require('../electron/mcpComfyRouterTools.cjs')

function fixture() {
  const calls = []
  const job = { jobId: 'router-job-1', status: 'IN_QUEUE' }
  const comfyRouter = Object.fromEntries(['status', 'list', 'preview', 'inspectPlan', 'submit', 'refresh', 'cancel', 'models', 'previewCreate'].map((method) => [method, async (args) => {
    calls.push({ method, args })
    if (method === 'status') return { success: true, configured: true, readiness: 'not_verified' }
    if (method === 'list') return { success: true, jobs: [job] }
    if (method === 'preview' || method === 'inspectPlan' || method === 'previewCreate') return { success: true, planId: 'router-plan-1' }
    if (method === 'models') return { success: true, models: [{ id: 'nano-banana-2-1', kind: 'image' }], voices: [] }
    return { success: true, method, ...args }
  }]))
  return { calls, job, comfyRouter, run: (name, args) => dispatchComfyRouterTool({ comfyRouter, name, args }) }
}

test('catalog exposes six strict tools, with import renderer-owned and no credential/model controls', () => {
  assert.equal(tools.length, 6)
  assert.equal(new Set(tools.map(({ name }) => name)).size, 6)
  assert.deepEqual(writableTools, ['generate_comfy_router_image', 'generate_create_media', 'control_comfy_router_image', 'import_comfy_router_image'])
  assert.equal(nativeToolNames.size, 5)
  assert.equal(nativeToolNames.has('import_comfy_router_image'), false)
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.inputSchema.type, 'object')
    for (const name of ['apiKey', 'key', 'model', 'url', 'policy', 'filePath', 'workflow']) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties, name), false)
    }
    if (writableTools.includes(tool.name)) assert.equal(tool.inputSchema.properties.previewOnly.default, true)
  }
  const generation = tools.find(({ name }) => name === 'generate_comfy_router_image')
  assert.match(generation.description, /native human confirmation regardless of agent access/)
  assert.match(generation.description, /pure review of that exact existing plan/)
  assert.equal(generation.inputSchema.oneOf.length, 3)
  assert.equal(generation.inputSchema.properties.prompt.maxLength, 4000)
  assert.equal(generation.inputSchema.properties.planId.maxLength, 200)
})

test('status composes only cached status and job reads', async () => {
  const f = fixture()
  assert.deepEqual(await f.run('get_comfy_router_status'), {
    success: true, configured: true, readiness: 'not_verified', jobs: [f.job],
  })
  assert.deepEqual(f.calls, [{ method: 'status', args: {} }, { method: 'list', args: {} }])
})

test('rejected-job preview preserves diagnostics without promising a provider poll or output download', async () => {
  const f = fixture()
  Object.assign(f.job, { status: 'FAILED', errorType: 'REQUEST_REJECTED', submissionRejected: true, canRefresh: false,
    errorMessage: 'Comfy rejected this request (HTTP 403 · not_enabled).', diagnostics: { httpStatus: 403, errorType: 'not_enabled' } })
  const result = await f.run('control_comfy_router_image', { jobId: f.job.jobId, operation: 'refresh' })
  assert.equal(result.previewOnly, true); assert.equal(result.summary, f.job.errorMessage)
  assert.deepEqual(result.job.diagnostics, f.job.diagnostics)
  assert.deepEqual(f.calls, [{ method: 'list', args: {} }])
})

test('generation defaults to preview and never submits implicitly', async () => {
  const f = fixture()
  const result = await f.run('generate_comfy_router_image', { prompt: 'A fox', expectedContext: { projectId: 'current' } })
  assert.equal(result.planId, 'router-plan-1')
  assert.equal(result.previewOnly, true)
  assert.equal(result.applied, false)
  assert.deepEqual(f.calls, [{ method: 'preview', args: { prompt: 'A fox' } }])
  assert.equal(defaultPreviewOnly('generate_comfy_router_image'), true)
  assert.equal(defaultPreviewOnly('get_comfy_router_status'), undefined)
})

test('plan-only preview reviews the same native plan without creating or submitting one', async () => {
  for (const previewOnly of [undefined, true]) {
    const f = fixture()
    const result = await f.run('generate_comfy_router_image', { planId: 'router-plan-1', previewOnly, expectedContext: { version: 3 } })
    assert.equal(result.planId, 'router-plan-1')
    assert.equal(result.previewOnly, true)
    assert.equal(result.applied, false)
    assert.deepEqual(f.calls, [{ method: 'inspectPlan', args: { planId: 'router-plan-1' } }])
  }
})

test('plan review failures stay failures and never fall back to a fresh preview', async () => {
  const f = fixture()
  f.comfyRouter.inspectPlan = async () => ({ success: false, code: 'COMFY_ROUTER_PLAN_EXPIRED' })
  const denied = await f.run('generate_comfy_router_image', { planId: 'router-plan-1' })
  assert.equal(denied.code, 'COMFY_ROUTER_PLAN_EXPIRED')
  assert.equal(denied.previewOnly, undefined)
  delete f.comfyRouter.inspectPlan
  assert.equal((await f.run('generate_comfy_router_image', { planId: 'router-plan-1' })).code, 'COMFY_ROUTER_UNAVAILABLE')
  assert.deepEqual(f.calls, [])
})

test('generation applies only a previously supplied plan and forwards no override/context', async () => {
  const f = fixture()
  const result = await f.run('generate_comfy_router_image', { planId: 'router-plan-1', previewOnly: false, expectedContext: { version: 3 } })
  assert.equal(result.success, true)
  assert.deepEqual(f.calls, [{ method: 'submit', args: { planId: 'router-plan-1' } }])
})

test('invalid generation requests never preview or submit', async () => {
  const f = fixture()
  for (const args of [
    {}, { prompt: '' }, { prompt: '   ' }, { prompt: 'x'.repeat(4001) },
    { prompt: 'A fox', previewOnly: false },
    { planId: '' }, { planId: undefined }, { planId: 'https://host/plan' },
    { planId: 'router-plan-1', prompt: undefined },
    { planId: 'router-plan-1', prompt: 'changed', previewOnly: false },
    { planId: 'router-plan-1', prompt: undefined, previewOnly: false },
    { prompt: 'A fox', planId: 'router-plan-1', previewOnly: true },
    { prompt: 'A fox', previewOnly: 'false' },
    { prompt: 'A fox', previewOnly: null },
    { prompt: 'A fox', model: 'other/model' },
    { prompt: 'A fox', apiKey: 'secret' },
    { planId: 'https://host/plan', previewOnly: false },
    { planId: 'x'.repeat(201), previewOnly: false },
    null, [], new Date(),
  ]) {
    const result = await f.run('generate_comfy_router_image', args)
    assert.equal(result.success, false)
    assert.equal(result.code, 'COMFY_ROUTER_INVALID_REQUEST')
  }
  assert.deepEqual(f.calls, [])
})

test('control preview performs only a cached lookup for either operation', async () => {
  for (const operation of ['refresh', 'cancel']) {
    const f = fixture()
    const result = await f.run('control_comfy_router_image', { jobId: f.job.jobId, operation })
    assert.equal(result.success, true)
    assert.equal(result.previewOnly, true)
    assert.equal(result.applied, false)
    assert.equal(result.jobId, f.job.jobId)
    assert.deepEqual(f.calls, [{ method: 'list', args: {} }])
  }
})

test('unknown control preview job fails without network or mutation', async () => {
  const f = fixture()
  const result = await f.run('control_comfy_router_image', { jobId: 'missing', operation: 'cancel' })
  assert.equal(result.code, 'COMFY_ROUTER_JOB_NOT_FOUND')
  assert.deepEqual(f.calls.map(({ method }) => method), ['list'])
})

test('control applies only the explicit refresh/cancel to the native manager', async () => {
  for (const operation of ['refresh', 'cancel']) {
    const f = fixture()
    assert.equal((await f.run('control_comfy_router_image', { jobId: f.job.jobId, operation, previewOnly: false })).success, true)
    assert.deepEqual(f.calls, [{ method: operation, args: { jobId: f.job.jobId } }])
  }
})

test('control cannot retry, accept a provider URL, or change prompts', async () => {
  const f = fixture()
  for (const args of [
    { jobId: f.job.jobId, operation: 'retry', previewOnly: false },
    { jobId: 'https://host/job', operation: 'refresh' },
    { jobId: '', operation: 'cancel' },
    { jobId: f.job.jobId, operation: 'cancel', prompt: 'A fox' },
    { jobId: f.job.jobId, operation: 'refresh', previewOnly: 0 },
  ]) assert.equal((await f.run('control_comfy_router_image', args)).code, 'COMFY_ROUTER_INVALID_REQUEST')
  assert.deepEqual(f.calls, [])
})

test('import is described/normalized but cannot enter the native dispatcher', async () => {
  const f = fixture()
  assert.deepEqual(normalizeComfyRouterArgs('import_comfy_router_image', { jobId: f.job.jobId }), {
    success: true, args: { jobId: f.job.jobId, previewOnly: true },
  })
  assert.equal((await f.run('import_comfy_router_image', { jobId: f.job.jobId, previewOnly: false })).code, 'COMFY_ROUTER_INVALID_REQUEST')
  assert.deepEqual(f.calls, [])
})

test('manager denial stays authoritative and never falls back to another action', async () => {
  const f = fixture()
  f.comfyRouter.submit = async () => ({ success: false, code: 'COMFY_ROUTER_DENIED', error: 'Generation was not approved.' })
  assert.equal((await f.run('generate_comfy_router_image', { planId: 'router-plan-1', previewOnly: false })).code, 'COMFY_ROUTER_DENIED')
  assert.deepEqual(f.calls, [])
})

test('manager failures are bounded and do not leak thrown provider/key text', async () => {
  const f = fixture()
  f.comfyRouter.preview = async () => { throw Object.assign(new Error('secret-key https://signed.invalid/token'), { publicMessage: 'secret-key', code: 'secret-key' }) }
  const result = await f.run('generate_comfy_router_image', { prompt: 'A fox' })
  assert.equal(result.code, 'COMFY_ROUTER_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /secret-key|signed\.invalid/)
})

test('unavailable/unsupported/malformed native results fail closed', async () => {
  assert.equal((await dispatchComfyRouterTool({ name: 'get_comfy_router_status' })).code, 'COMFY_ROUTER_UNAVAILABLE')
  assert.equal((await dispatchComfyRouterTool({ name: 'unknown' })).code, 'COMFY_ROUTER_INVALID_REQUEST')
  const f = fixture()
  assert.equal((await f.run('get_comfy_router_status', { refresh: true })).code, 'COMFY_ROUTER_INVALID_REQUEST')
  f.comfyRouter.preview = async () => null
  assert.equal((await f.run('generate_comfy_router_image', { prompt: 'A fox' })).code, 'COMFY_ROUTER_INVALID_RESULT')
  f.comfyRouter.list = async () => ({ success: true, jobs: 'not-an-array' })
  assert.equal((await f.run('get_comfy_router_status')).code, 'COMFY_ROUTER_INVALID_RESULT')
  assert.equal((await f.run('control_comfy_router_image', { jobId: f.job.jobId, operation: 'refresh' })).code, 'COMFY_ROUTER_INVALID_RESULT')
})

test('status/list failure does not claim a usable snapshot', async () => {
  const f = fixture()
  f.comfyRouter.status = async () => ({ success: false, code: 'COMFY_ROUTER_UNAVAILABLE' })
  assert.equal((await f.run('get_comfy_router_status')).success, false)
  assert.deepEqual(f.calls, [])
  f.comfyRouter.status = async () => ({ success: true })
  f.comfyRouter.list = async () => ({ success: false, code: 'COMFY_ROUTER_CONTEXT_CHANGED' })
  assert.equal((await f.run('get_comfy_router_status')).code, 'COMFY_ROUTER_CONTEXT_CHANGED')
})

// ---- Create models for agents ----
test('get_create_models reads the kept model list and nothing else', async () => {
  const f = fixture()
  const listed = await f.run('get_create_models', {})
  assert.equal(listed.success, true); assert.equal(listed.models[0].id, 'nano-banana-2-1')
  assert.deepEqual(f.calls, [{ method: 'models', args: {} }])
  assert.equal((await f.run('get_create_models', { modelId: 'x' })).code, 'COMFY_ROUTER_INVALID_REQUEST')
})

test('generate_create_media previews with only the choices that were given, reviews a plan, and applies by planId alone', async () => {
  const f = fixture()
  const preview = await f.run('generate_create_media', { modelId: 'seedance-2-0-mini', prompt: 'Waves at dusk', seconds: 5, resolution: '720p', inputImageAssetId: 'asset-1', pictureUse: 'start' })
  assert.equal(preview.success, true); assert.equal(preview.previewOnly, true); assert.equal(preview.applied, false)
  assert.deepEqual(f.calls.at(-1), { method: 'previewCreate', args: { modelId: 'seedance-2-0-mini', choices: { prompt: 'Waves at dusk', seconds: 5, resolution: '720p', pictureUse: 'start' }, inputImageAssetId: 'asset-1' } })
  await f.run('generate_create_media', { modelId: 'nano-banana-2-1', prompt: 'A red kite', count: 4, expectedContext: { any: true } })
  assert.deepEqual(f.calls.at(-1), { method: 'previewCreate', args: { modelId: 'nano-banana-2-1', choices: { prompt: 'A red kite' }, count: 4 } })
  await f.run('generate_create_media', { planId: 'router-plan-1' })
  assert.deepEqual(f.calls.at(-1), { method: 'inspectPlan', args: { planId: 'router-plan-1' } })
  const applied = await f.run('generate_create_media', { planId: 'router-plan-1', previewOnly: false })
  assert.deepEqual(f.calls.at(-1), { method: 'submit', args: { planId: 'router-plan-1' } })
  assert.equal(applied.previewOnly, undefined)
  assert.equal(f.calls.some(call => ['submitCreate', 'submitCreateRemote'].includes(call.method)), false, 'an agent never uses the button or phone approval paths')
})

test('generate_create_media cannot apply without a previewed plan, or change a plan while applying', async () => {
  const f = fixture()
  for (const args of [
    { modelId: 'nano-banana-2-1', prompt: 'A red kite', previewOnly: false },
    { planId: 'router-plan-1', prompt: 'Something else', previewOnly: false },
    { planId: 'router-plan-1', modelId: 'seedance-2-5', previewOnly: false },
    { planId: 'router-plan-1', seconds: 10 },
    { planId: 'router-plan-1', count: 4, previewOnly: false },
    { previewOnly: false }, {},
    { modelId: 'nano-banana-2-1' }, { prompt: 'No model' }, { modelId: 'nano-banana-2-1', prompt: '   ' },
    { modelId: '../x', prompt: 'A' }, { modelId: 'nano-banana-2-1', prompt: 'A', count: 3 },
    { modelId: 'nano-banana-2-1', prompt: 'A', pictureUse: 'start' },
    { modelId: 'nano-banana-2-1', prompt: 'A', inputImageAssetId: '/etc/passwd' },
    { modelId: 'nano-banana-2-1', prompt: 'A', picture: { mimeType: 'image/png', base64: 'AAAA' } },
    { modelId: 'nano-banana-2-1', prompt: 'A', apiKey: 'x' }, { modelId: 'nano-banana-2-1', prompt: 'A', url: 'https://example.com' },
    { modelId: 'nano-banana-2-1', prompt: 'A', previewOnly: 'no' },
  ]) {
    assert.equal((await f.run('generate_create_media', args)).code, 'COMFY_ROUTER_INVALID_REQUEST', JSON.stringify(args))
  }
  assert.deepEqual(f.calls, [], 'nothing reached the manager')
  const tool = tools.find(({ name }) => name === 'generate_create_media')
  assert.match(tool.description, /own spending confirmation, on the computer or on their paired phone, in every access mode/)
  assert.equal(tool.inputSchema.oneOf, undefined, 'every field stays visible to hosts that build a call signature from the schema')
  for (const field of ['modelId', 'prompt', 'shape', 'size', 'seconds', 'resolution', 'voice', 'loop', 'count', 'inputImageAssetId', 'pictureUse', 'planId', 'previewOnly']) assert.ok(tool.inputSchema.properties[field], field)
  // The first real agent sent kind:"image"; the answer now names the field and what is accepted.
  const guessed = await f.run('generate_create_media', { modelId: 'gpt-image-2-5', kind: 'image', prompt: 'A red kite', size: '1K', count: 1 })
  assert.match(guessed.error, /Unsupported Comfy Router request field: kind\. This tool takes: modelId, prompt, shape, size/)
  assert.equal(defaultPreviewOnly('generate_create_media', {}), true)
  assert.equal(normalizeComfyRouterArgs('generate_create_media', { modelId: 'nano-banana-2-1', prompt: 'A' }).args.previewOnly, true)
})
