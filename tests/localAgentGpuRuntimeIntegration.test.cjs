'use strict'

// Exercise the real coordinator and runtime together with an in-memory HTTP
// boundary. No installed models, GPU, running app or external network is used.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalAgentGpuCoordinator } = require('../electron/localAgentGpuCoordinator.cjs')
const { createLocalAgentModelRuntime } = require('../electron/localAgentModelRuntime.cjs')

const lmEndpoint = 'http://127.0.0.1:1234/v1'
const comfyEndpoint = 'http://127.0.0.1:8189'
const reply = value => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
})
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'synthetic GPU handoff did not make progress')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

for (const contextLength of [16384, 32768]) {
  test(`generation success and failure both restore the selected ${contextLength}-token instance, never its sibling`, async t => {
    const selectedModel = 'example/local-model'
    const config = { context_length: contextLength, eval_batch_size: 256,
      flash_attention: true, offload_kv_cache_to_gpu: false }
    const sibling = { id: `${selectedModel}:other`, config: { context_length: 4096 } }
    const otherModel = { type: 'llm', key: 'another/model', loaded_instances: [
      { id: 'another-alias', config: { context_length: 8192 } },
    ] }
    const modelRow = { type: 'llm', key: selectedModel, loaded_instances: [
      { id: selectedModel, config: { ...config } }, structuredClone(sibling),
    ] }
    const rows = [modelRow, structuredClone(otherModel)]
    const history = {}, calls = []
    let memory = 0, loaded = 0
    const fetchImpl = async (url, init = {}) => {
      const route = new URL(url).pathname
      const body = init.body ? JSON.parse(init.body) : undefined
      calls.push({ route, body })
      if (route === '/api/v1/models') return reply({ models: rows })
      if (route === '/api/v1/models/unload') {
        assert.notEqual(body.instance_id, sibling.id)
        assert.notEqual(body.instance_id, 'another-alias')
        modelRow.loaded_instances = modelRow.loaded_instances.filter(item => item.id !== body.instance_id)
        return reply({ instance_id: body.instance_id })
      }
      if (route === '/api/v1/models/load') {
        assert.equal(body.model, selectedModel)
        for (const [key, value] of Object.entries(config)) assert.equal(body[key], value)
        const id = `restored-instance-${++loaded}`
        modelRow.loaded_instances.push({ id, config: { ...config } })
        return reply({ status: 'loaded', instance_id: id })
      }
      if (route === '/queue') return reply({ queue_running: [], queue_pending: [] })
      if (route.startsWith('/history/')) {
        const id = route.slice('/history/'.length)
        return reply(history[id] ? { [id]: history[id] } : {})
      }
      if (route === '/system_stats') return reply({ devices: [{ type: 'cuda', torch_vram_total: memory }] })
      if (route === '/free') {
        assert.deepEqual(body, { unload_models: true, free_memory: true })
        memory = 0
        return new Response(null, { status: 200 })
      }
      throw new Error(`Unexpected synthetic route: ${route}`)
    }
    const runtime = createLocalAgentModelRuntime({ fetchImpl })
    const coordinator = createLocalAgentGpuCoordinator({ runtime, fetchImpl,
      getComfyEndpoint: () => comfyEndpoint, pollMs: 1, maxWaitMs: 3000 })
    t.after(() => coordinator.dispose())
    const infer = () => coordinator.withInference({ model: selectedModel, endpoint: lmEndpoint }, async ({ model }) => {
      assert.notEqual(model, sibling.id)
      const instance = modelRow.loaded_instances.find(item => item.id === model)
      assert.ok(instance, 'prediction receives a verified loaded instance')
      assert.equal(instance.config.context_length, contextLength)
      return model
    })
    assert.equal(await infer(), selectedModel)

    for (const [index, status] of ['success', 'error'].entries()) {
      const beforeCalls = calls.length
      const lease = await coordinator.beforeGeneration({ endpoint: comfyEndpoint })
      assert.deepEqual(modelRow.loaded_instances, [sibling])
      const promptId = `synthetic-${status}`
      memory = 1024 * 1024 * 1024
      coordinator.afterGeneration({ lease, postStarted: true,
        result: { success: true, body: { prompt_id: promptId } } })
      const pending = infer()
      await until(() => calls.slice(beforeCalls).some(call => call.route === `/history/${promptId}`))
      assert.equal(loaded, index, 'do not reload merely because the queue is empty')
      history[promptId] = { status: { status_str: status, completed: status === 'success' } }
      assert.equal(await pending, `restored-instance-${index + 1}`)
      const cycleCalls = calls.slice(beforeCalls)
      assert.ok(cycleCalls.findIndex(call => call.route === '/free')
        < cycleCalls.findIndex(call => call.route === '/api/v1/models/load'))
      assert.deepEqual(modelRow.loaded_instances.find(item => item.id === sibling.id), sibling)
      assert.deepEqual(rows[1], otherModel)
    }
    assert.deepEqual(calls.filter(call => call.route === '/api/v1/models/unload').map(call => call.body.instance_id),
      [selectedModel, 'restored-instance-1'])
    assert.equal(loaded, 2)
  })
}
