import test from 'node:test'
import assert from 'node:assert/strict'
import { collectRouterPicture, dollars, quoteRouterPicture, routerPictureModel, sendRouterPicture } from '../src/services/routerPicture.mjs'

const MODELS = { success: true, creditsPerUsd: 211, models: [
  { id: 'seedream', kind: 'image', name: 'Seedream', usdPerImage: { '1K': 0.03, '2K': 0.03 } },
  { id: 'nano-banana-2-1', kind: 'image', name: 'Nano Banana 2.1', default: true, usdPerImage: { '1K': 0.055, '2K': 0.0785 } },
  { id: 'vid', kind: 'video', name: 'Video' },
] }

test('the cloud picture model and its price come from the list Velorn keeps', async () => {
  const model = await routerPictureModel({ models: async () => MODELS })
  assert.deepEqual(model, { id: 'nano-banana-2-1', name: 'Nano Banana 2.1', usd: 0.0785, size: '2K', creditsPerUsd: 211 })
  assert.equal(await routerPictureModel({ models: async () => ({ success: false }) }), null)
  assert.equal(await routerPictureModel(undefined), null)
  assert.equal(dollars(0.0785), '$0.08')
})

test('asking the price sends the description and shape, and nothing is submitted', async () => {
  const calls = []
  const api = {
    previewCreate: async (payload) => { calls.push(payload); return { success: true, planId: 'p1', estimate: { usd: 0.08, firm: false }, buttonApproval: true } },
    submitCreate: async () => { throw new Error('must not be called') },
  }
  const quote = await quoteRouterPicture({ api, modelId: 'nano-banana-2-1', size: '2K', prompt: ' A snowy street ', shape: 'portrait' })
  assert.deepEqual(quote, { success: true, planId: 'p1', usd: 0.08, firm: false, clickApproves: true })
  assert.deepEqual(calls, [{ modelId: 'nano-banana-2-1', choices: { prompt: 'A snowy street', shape: 'portrait', size: '2K' } }])
  assert.equal((await quoteRouterPicture({ api, modelId: 'x', size: '2K', prompt: '  ' })).success, false)
})

test('no Comfy account is explained in plain words', async () => {
  const api = { previewCreate: async () => ({ success: false, code: 'COMFY_ROUTER_KEY_REQUIRED' }) }
  const quote = await quoteRouterPicture({ api, modelId: 'x', size: '2K', prompt: 'a room' })
  assert.match(quote.error, /Connect your Comfy account first/)
})

test('sending uses the agreed plan once and reports the job', async () => {
  const sent = []
  const api = { submitCreate: async (payload) => { sent.push(payload); return { success: true, job: { jobId: 'j1' } } } }
  assert.deepEqual(await sendRouterPicture({ api, planId: 'p1' }), { success: true, jobId: 'j1' })
  assert.deepEqual(sent, [{ planId: 'p1' }])
  const lateClick = { submitCreate: async () => { throw new Error('Generate requires a user gesture.') } }
  assert.match((await sendRouterPicture({ api: lateClick, planId: 'p1' })).error, /once more/)
})

test('the finished picture is saved into the project', async () => {
  const answers = [{ success: true, job: { status: 'RUNNING' } }, { success: true, job: { status: 'COMPLETED' } }]
  const api = { refresh: async () => answers.shift() }
  const imported = []
  const result = await collectRouterPicture({
    api, jobId: 'j1', wait: async () => {},
    importImage: async (jobId, options) => { imported.push([jobId, options]); return { success: true, assetId: 'asset-9' } },
  })
  assert.deepEqual(result, { success: true, assetId: 'asset-9' })
  assert.deepEqual(imported, [['j1', { previewOnly: false }]])
})

test('a failed job, lost contact and a failed save each say what happened', async () => {
  const none = async () => { throw new Error('must not import') }
  const failed = await collectRouterPicture({ api: { refresh: async () => ({ success: true, job: { status: 'FAILED', error: 'Refused.' } }) }, jobId: 'j', wait: async () => {}, importImage: none })
  assert.equal(failed.error, 'Refused.')
  const lost = await collectRouterPicture({ api: { refresh: async () => ({ success: false }) }, jobId: 'j', wait: async () => {}, importImage: none, maxMisses: 3 })
  assert.match(lost.error, /lost touch/)
  const unsaved = await collectRouterPicture({ api: { refresh: async () => ({ success: true, job: { status: 'COMPLETED' } }) }, jobId: 'j', wait: async () => {}, importImage: async () => ({ success: false }) })
  assert.match(unsaved.error, /could not be added/)
})
