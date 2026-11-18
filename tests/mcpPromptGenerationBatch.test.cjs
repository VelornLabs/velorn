'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')

// Actual native MCP dispatcher/planner, with a RAM-only renderer boundary.
// No ComfyUI, project files, generation, provider or model management is used.
function fixture() {
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async request => {
    calls.push(structuredClone(request))
    return { success: true, queued: request.payload.jobs.length,
      jobs: request.payload.jobs.map((job, index) => ({ ...job, id: `synthetic-job-${index}` })) }
  } })
  server.updateSnapshot({ schemaVersion: 2, project: { id: 'synthetic-project', name: 'Synthetic project' },
    assets: [{ id: 'image-1', name: 'Synthetic image', type: 'image' }],
    currentTimeline: { id: 'timeline-1', clips: [], tracks: [], fps: 24, duration: 0 } })
  return { server, calls, run: args => server.callTool('queue_prompt_generation_batch', args) }
}
const body = result => JSON.parse(result.content.find(item => item.type === 'text').text)
const error = result => {
  assert.equal(result.isError, true)
  return result.content.find(item => item.type === 'text').text
}
const i2vJob = () => ({ workflowId: 'ltx23-i2v', prompt: 'Synthetic camera motion', seed: 44,
  durationSeconds: 3, fps: 24, resolution: { width: 512, height: 320 },
  assetFieldIds: { image: 'image-1' }, generateAudio: false })

test('explicit job schema requires workflow and prompt in every complete job object', () => {
  const { server } = fixture()
  const jobs = server.tools.find(tool => tool.name === 'queue_prompt_generation_batch').inputSchema.properties.jobs
  assert.deepEqual(jobs.items.required, ['workflowId', 'prompt'])
  assert.match(jobs.description, /one complete job/i)
  assert.match(jobs.description, /same object/i)
})

test('LTX image-to-video preview/apply preserves exact seed, duration, resolution and image field', async () => {
  const f = fixture(), job = i2vJob()
  const preview = body(await f.run({ jobs: [job], previewOnly: true }))
  assert.equal(preview.previewOnly, true)
  assert.equal(preview.plan.totalJobs, 1)
  assert.equal(f.calls.length, 0)
  const planned = preview.plan.jobs[0]
  assert.equal(planned.workflowId, 'ltx23-i2v')
  assert.equal(planned.category, 'video')
  assert.equal(planned.outputType, 'video')
  assert.equal(planned.needsImage, true)
  assert.equal(planned.workflowLabel, 'Image to Video (LTX 2.3)')
  for (const key of ['prompt', 'seed', 'durationSeconds', 'fps', 'resolution', 'assetFieldIds', 'generateAudio']) {
    assert.deepEqual(planned[key], job[key], key)
  }
  const applied = body(await f.run(preview.suggestedApplyCall.arguments))
  assert.equal(applied.success, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].action, 'queue_prompt_generation_batch')
  assert.equal(f.calls[0].payload.previewOnly, false)
  assert.deepEqual(f.calls[0].payload.jobs, preview.plan.jobs)
  assert.equal(applied.result.queued, 1)
})

test('LTX image-to-video omitted optional settings use established video defaults', async () => {
  const f = fixture()
  const preview = body(await f.run({ jobs: [{ workflowId: 'ltx23-i2v', prompt: 'Synthetic motion',
    assetFieldIds: { inputImage: 'image-1' }, seed: 0 }] }))
  const planned = preview.plan.jobs[0]
  assert.equal(planned.durationSeconds, 5)
  assert.equal(planned.fps, 24)
  assert.deepEqual(planned.resolution, { width: 1280, height: 720 })
  assert.deepEqual(planned.assetFieldIds, { inputImage: 'image-1' })
  assert.equal(planned.seed, 0)
  assert.equal(f.calls.length, 0)
})

for (const alias of ['LTX 2.3 I2V', 'ltx-i2v']) {
  test(`explicit ${alias} alias selects image-to-video without changing generic LTX meaning`, async () => {
    const f = fixture()
    const preview = body(await f.run({ jobs: [{ ...i2vJob(), workflowId: alias }] }))
    assert.equal(preview.plan.jobs[0].workflowId, 'ltx23-i2v')
    assert.equal(f.calls.length, 0)
  })
}

test('generic LTX aliases still select text-to-video without requiring an image', async () => {
  const f = fixture()
  for (const workflowId of ['ltx', 'ltx23', 'ltx23-t2v']) {
    const preview = body(await f.run({ workflowId, prompt: 'Synthetic text-to-video', baseSeed: 44 }))
    assert.equal(preview.plan.jobs[0].workflowId, 'ltx23-t2v')
    assert.equal(preview.plan.jobs[0].needsImage, false)
  }
  assert.equal(f.calls.length, 0)
})

test('image-to-video without an explicit input image fails before preview/apply dispatch', async () => {
  const f = fixture()
  for (const previewOnly of [true, false]) for (const assetFieldIds of [undefined, {}, { referenceImage1: 'image-1' }]) {
    assert.match(error(await f.run({ jobs: [{ ...i2vJob(), assetFieldIds }], previewOnly })), /needs an input image.*jobs\[\]\.assetFieldIds\.image/)
  }
  assert.equal(f.calls.length, 0)
})

test('cartesian prompt/workflow form cannot queue image-to-video without per-job image fields', async () => {
  const f = fixture()
  for (const previewOnly of [true, false]) {
    const result = await f.run({ prompts: ['Synthetic motion'], workflowIds: ['ltx23-i2v'],
      assetFieldIds: { image: 'image-1' }, previewOnly })
    assert.match(error(result), /needs a per-job input image.*jobs\[\].*instead of prompts × workflows/)
  }
  assert.equal(f.calls.length, 0)
})

test('split settings fragments fail with indexed missing-workflow error and no partial dispatch', async () => {
  const f = fixture()
  for (const previewOnly of [true, false]) {
    const result = await f.run({ workflowId: 'z-image-turbo', prompt: 'Synthetic fallback must not repair jobs',
      jobs: [{ workflowId: 'z-image-turbo', prompt: 'Synthetic image' }, { seed: 42 },
        { resolution: { width: 512, height: 512 } }], previewOnly })
    assert.match(error(result), /Prompt generation job 2 is missing workflowId/)
    assert.doesNotMatch(error(result), /Unsupported prompt generation workflow ""/)
  }
  assert.equal(f.calls.length, 0)
})

test('blank workflow and missing prompt errors identify the incomplete job without guessing operands', async () => {
  const f = fixture()
  assert.match(error(await f.run({ jobs: [i2vJob(), { workflowId: '  ', prompt: 'Synthetic' }], previewOnly: false })),
    /Prompt generation job 2 is missing workflowId/)
  assert.match(error(await f.run({ jobs: [i2vJob(), { workflowId: 'z-image-turbo' }], previewOnly: false })),
    /Prompt generation job 2 is missing prompt text/)
  assert.equal(f.calls.length, 0)
})
