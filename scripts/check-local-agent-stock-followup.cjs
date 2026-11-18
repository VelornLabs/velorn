'use strict'
// Opt-in real inference, synthetic tool results only. Never connects to Velorn's
// live MCP/renderer, Pexels, or media files; never loads/unloads a model.
const assert = require('node:assert/strict')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')

async function runCase(model, mode) {
  const catalog = createComfyStudioMcpServer({ performAction: () => { throw Error('No real dispatcher in this fixture') } }).tools
  const calls = [], predictions = [], assets = [], clips = []
  const timeline = { id: 'fixture-timeline', name: 'Short Music Video Test', width: 1080, height: 1920, fps: 24,
    duration: 60, tracks: [{ id: 'video-track', name: 'Video 1', type: 'video' }], clips }
  let searchArgs, result, error, fixtureStopped = false
  const start = Date.now()
  function dispatch(name, args) {
    const fail = message => ({ success: false, error: message })
    if (name === 'search_stock_media') {
      searchArgs = args
      const mediaType = args.mediaType || 'photos'
      return { success: true, query: args.query, mediaType, totalResults: 10, results: Array.from({ length: 10 }, (_, i) => ({
        id: 500 + i, type: mediaType === 'videos' ? 'video' : 'image', title: `Drone city buildings ${i + 1}`,
        duration: mediaType === 'videos' ? 6 : undefined, width: 1920, height: 1080,
      })) }
    }
    if (name === 'get_project') return { success: true, project: { name: 'Synthetic stock follow-up' }, timelines: [timeline], currentTimeline: timeline }
    if (name === 'get_timeline') return { success: true, timeline }
    if (name === 'get_assets') return { success: true, assets }
    if (name === 'import_stock_media' && mode === 'import') {
      if (!searchArgs || (args.mediaType || 'photos') !== 'videos' || (searchArgs.mediaType || 'photos') !== 'videos') return fail('Search and import must use mediaType videos for the requested videos.')
      if (args.query !== searchArgs.query) return fail('Use the same query as the search.')
      const ids = args.resultIds || Array.from({ length: args.count || 10 }, (_, i) => 500 + i)
      if (ids.length !== 10 || new Set(ids.map(Number)).size !== 10 || ids.some(id => Number(id) < 500 || Number(id) > 509)) return fail('Select the ten exact result IDs returned by search.')
      if (args.previewOnly === true) return { success: true, previewOnly: true, selectedCount: ids.length, resultIds: ids }
      if (!assets.length) assets.push(...ids.map(id => ({ id: `asset-${id}`, name: `Drone city ${id}`, type: 'video', duration: 6 })))
      return { success: true, previewOnly: false, importedCount: assets.length, importedAssets: assets }
    }
    if (name === 'add_assets_to_timeline' && mode === 'import') {
      const ids = args.assetIds || args.assets?.map(asset => asset.assetId) || assets.slice(-(args.latestCount || args.count || 6)).map(asset => asset.id)
      if (!assets.length || ids.length !== 10 || ids.some(id => !assets.some(asset => asset.id === id))) return fail('Use the ten imported asset IDs.')
      if (args.previewOnly === true) return { success: true, previewOnly: true, assetIds: ids, clipCount: ids.length }
      if (clips.length) return fail('These synthetic clips are already placed; inspect instead of repeating.')
      clips.push(...ids.map((assetId, i) => ({ id: `clip-${i + 1}`, assetId, trackId: 'video-track', startTime: i * 6, duration: 6 })))
      return { success: true, previewOnly: false, clipCount: clips.length, clips }
    }
    return fail(`Synthetic fixture does not implement ${name}. No action was executed.`)
  }
  try {
    result = await sendLocalWithTools({ model, endpoint: 'http://127.0.0.1:1234/v1', fullAccess: true,
      context: JSON.stringify({ project: { name: 'Synthetic stock follow-up' }, currentTimeline: timeline, assets: [] }),
      messages: [
        { role: 'user', content: 'Create a new timeline named Short Music Video Test, 1080 by 1920, 24 FPS.' },
        { role: 'assistant', content: 'Created and activated Short Music Video Test (fixture-timeline), 1080 by 1920 at 24 FPS.' },
        { role: 'user', content: mode === 'import'
          ? 'Awesome, good job. Now, in the Pexels stocks, can you pick 10 drone shots that show city streets and buildings from above? Make 10 selects of those and then put those in the timeline for me, please.'
          : 'Now search Pexels for 10 drone videos showing city streets and buildings from above. Report the returned result IDs. Do not import or edit anything yet.' },
      ],
    }, {
      signal: AbortSignal.timeout(45000),
      toolSession: { listTools: async () => catalog, callTool: async (name, args) => {
        const value = dispatch(name, args)
        calls.push({ name, args, success: value.success, previewOnly: value.previewOnly })
        return { ...(value.success === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] }
      } },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:1234/v1/chat/completions')
        if (predictions.length >= 15) { fixtureStopped = true; throw Error('Fixture-only prediction bound reached') }
        const response = await fetch(url, options), data = await response.clone().json()
        // Public protocol/usage only: never log private reasoning.
        predictions.push({ tools: data.choices?.[0]?.message?.tool_calls?.map(call => call.function.name) || [],
          promptTokens: data.usage?.prompt_tokens, responseModel: data.model })
        return response
      },
    })
  } catch (failure) { error = fixtureStopped ? { code: 'FIXTURE_PREDICTION_LIMIT', message: 'Stopped this isolated test after 15 predictions; not a product limit or connection failure.' }
    : { code: failure.code, message: failure.message } }
  const allowed = ['get_project', 'get_timeline', 'get_assets', 'search_stock_media', ...(mode === 'import' ? ['import_stock_media', 'add_assets_to_timeline'] : [])]
  const taskPassed = result?.success === true && searchArgs?.mediaType === 'videos'
    && calls.every(call => allowed.includes(call.name)) && (mode === 'search' ? assets.length === 0 && clips.length === 0 : assets.length === 10 && clips.length === 10)
  return { mode, model, seconds: (Date.now() - start) / 1000, taskPassed, predictions, calls,
    simulatedAssets: assets.length, simulatedClips: clips.length, text: result?.text, error }
}
async function main(args) {
  if (!args.includes('--run')) { console.log('Opt-in: --run --model <already-loaded-instance> [--case search|import]. Real inference; synthetic tools only. At most two 45-second cases.'); return }
  const model = args[args.indexOf('--model') + 1]
  assert.ok(args.includes('--model') && model && !model.startsWith('--'), 'Supply the exact already-loaded model instance.')
  const selected = args.includes('--case') ? args[args.indexOf('--case') + 1] : null
  assert.ok(selected === null || ['search', 'import'].includes(selected), 'Case must be search or import')
  const response = await fetch('http://127.0.0.1:1234/api/v1/models', { signal: AbortSignal.timeout(5000) })
  assert.ok(response.ok)
  const body = await response.json()
  assert.ok(body.models?.some(modelInfo => modelInfo.loaded_instances?.some(instance => instance.id === model)), 'Exact model must already be loaded.')
  for (const mode of selected ? [selected] : ['search', 'import']) {
    const result = await runCase(model, mode)
    console.log(JSON.stringify(result))
    if (!result.taskPassed) process.exitCode = 1
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { runCase }
