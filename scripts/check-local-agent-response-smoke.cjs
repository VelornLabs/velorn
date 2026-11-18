'use strict'
// Two opt-in prompts through the real local transport/native tool session and
// real renderer stores in RAM. NOT the running desktop or user project. The
// selected model must already be loaded; no model load/settings/file mutations.
const assert = require('node:assert/strict')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { diagnosticFixture: fixture } = require('./check-local-agent-desktop-chat.cjs')
const prompts = [
  'Call get_timeline. Report the actual picture clip count and clip-6 start, duration and end. Do not change anything.',
  'Inspect the timeline. Shorten clip-6 from 3 seconds to 2.5 seconds, preserving its 17-second start and source-in. Leave everything else unchanged. Apply directly, then inspect to verify. Only if the trim succeeded, Undo it exactly once and verify it is back to 17–20 seconds. Do not export or generate anything. Report actual results.',
]
async function main(args) {
  if (!args.includes('--run')) { console.log(JSON.stringify({ prompts, actualModelRequests: 0, maxSeconds: 120, scope: 'isolated RAM fixture' })); return }
  const model = args[args.indexOf('--model') + 1]
  assert.ok(args.includes('--model') && model && !model.startsWith('--'), 'Supply --model with an exact loaded instance ID')
  const selectedCase = args.includes('--case') ? Number(args[args.indexOf('--case') + 1]) : null
  assert.ok(selectedCase === null || [1, 2].includes(selectedCase), 'Optional --case must be 1 or 2')
  const response = await fetch('http://127.0.0.1:1234/api/v1/models', { signal: AbortSignal.timeout(5000) })
  assert.ok(response.ok, 'LM Studio must be running locally')
  const body = await response.json()
  assert.ok(body.models?.some(m => m.type === 'llm' && m.loaded_instances?.some(i => i.id === model)), 'The exact model instance must already be loaded')
  const overall = AbortSignal.timeout(120000)
  for (let index = 0; index < prompts.length; index++) {
    if (selectedCase !== null && selectedCase !== index + 1) continue
    if (overall.aborted) break
    fixture.seed()
    const before = fixture.sha(fixture.state()), started = Date.now()
    const record = { hostCalls: [], rendererActions: [], hostTiming: [], publicToolResults: [], approvals: [], blockedTools: [], transitions: [] }
    const f = await fixture.fixture({ id: `response-${index}`, writes: index ? ['trim_clips', 'undo'] : [] }, record)
    const signal = AbortSignal.any([overall, AbortSignal.timeout(60000)])
    let session, predictions = 0, result, error, responseModels = new Set()
    try {
      session = await f.createGuardedSession({ signal, trustedFullAccess: true })
      result = await sendLocalWithTools({ model, endpoint: 'http://127.0.0.1:1234/v1', fullAccess: true,
        context: JSON.stringify({ project: 'Isolated diagnostic fixture' }),
        messages: [{ role: 'user', content: prompts[index] }], images: [], vision: false }, {
        signal, toolSession: session, timeoutMs: 60000,
        fetchImpl: async (url, options) => {
          assert.equal(url, 'http://127.0.0.1:1234/v1/chat/completions'); predictions++
          const reply = await fetch(url, options)
          const data = await reply.clone().json()
          if (typeof data.model === 'string') responseModels.add(data.model)
          return reply
        },
      })
    } catch (e) { error = { code: e.code || 'ERROR', message: e.message } }
    finally {
      const clip = fixture.state().clips.find(c => c.id === 'clip-6')
      const receipts = session?.getReceipts(), applied = (receipts?.entries || []).filter(e => e.outcome === 'applied')
      const unchanged = fixture.sha(fixture.state()) === before
      const taskStatePassed = unchanged && record.blockedTools.length === 0 && (index === 0 ? applied.length === 0
        : applied.length === 2 && applied[0].toolName === 'trim_clips' && applied[1].toolName === 'undo'
          && record.publicToolResults.some(c => c.returnedTarget?.duration === 2.5)
          && record.publicToolResults.at(-1)?.returnedTarget?.duration === 3)
      console.log(JSON.stringify({ prompt: index + 1, requestedModel: model, responseModels: [...responseModels],
        seconds: (Date.now() - started) / 1000, predictions, transportSuccess: result?.success === true,
        taskStatePassed, text: result?.text, error,
        hostCalls: record.hostCalls.map(c => ({ name: c.name, previewOnly: c.previewOnly })),
        receipts, unchanged,
        lastClip: { start: clip.startTime, duration: clip.duration, end: clip.startTime + clip.duration },
        targetReads: record.publicToolResults.filter(c => c.returnedTarget).map(c => ({ name: c.name, ...c.returnedTarget })),
        approvals: record.approvals.length, blockedTools: record.blockedTools,
      }))
      f.close()
    }
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1 })
module.exports = { main, prompts }
