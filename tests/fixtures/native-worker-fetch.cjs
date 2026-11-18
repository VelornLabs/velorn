'use strict'
// Test preload ONLY. Not packaged. No actual network or inference is used.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const catalog = { models: [{ slug: 'gpt-6-luna', display_name: 'Offline fixture', description: 'No inference',
  default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Light' }],
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, upgrade: null,
  base_instructions: 'Scripted offline transport fixture.', supports_reasoning_summaries: true,
  support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
  truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false, context_window: 272000,
  effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'],
  additional_speed_tiers: [], service_tiers: [], default_service_tier: null, tool_mode: 'code_mode_only' }] }
const pending = new Map()
let serial = 0
const message = text => ({ type: 'message', role: 'assistant', id: 'message_' + serial,
  phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
function response(output) {
  const base = { id: 'response_' + (++serial), object: 'response', model: 'gpt-6-luna', created_at: 1, status: 'in_progress', output: [] }
  const events = [{ type: 'response.created', response: base }]
  output.forEach((item, output_index) => events.push({ type: 'response.output_item.added', output_index, item },
    { type: 'response.output_item.done', output_index, item }))
  events.push({ type: 'response.completed', response: { ...base, status: 'completed', output,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
  return new Response(events.map(value => 'event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}
global.fetch = async (url, options) => {
  assert.ok(url.startsWith('https://connect.velorn.ai/account/desktop/luna/native-test/v1/'))
  assert.equal(options.headers.authorization, 'Bearer SYNTHETIC_ACCOUNT_ONLY')
  if (url.includes('/models?')) return Response.json(catalog)
  assert.ok(url.endsWith('/responses'))
  const body = JSON.parse(options.body), history = JSON.stringify(body.input), id = options.headers['Idempotency-Key']
  assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'low')
  if (history.includes('FULL_NATIVE')) {
    if (history.includes('FULL_RECEIPT')) return response([message('FULL_SHELL_FINISHED')])
    return response([{ type: 'custom_tool_call', id: 'full_tool', call_id: 'full_call', name: 'exec', status: 'completed',
      input: 'const t=ALL_TOOLS.find(t=>/exec_command$/.test(t.name));text(await tools[t.name]({cmd:"printf FULL_RECEIPT"}));' }])
  }
  const digest = crypto.createHash('sha256').update(options.body).digest('hex')
  if (pending.has(id)) assert.equal(pending.get(id), digest)
  if (history.includes('FOLLOWUP_NATIVE')) {
    assert.ok(history.includes('SHADOW_FIRST'))
    return response([message('SHADOW_RETAINED')])
  }
  if (!history.includes('RECEIPT_ONCE')) return response([{ type: 'custom_tool_call', id: 'tool_1',
    call_id: 'call_1', name: 'exec', status: 'completed',
    input: 'const t=ALL_TOOLS.find(t=>/receipt_probe$/.test(t.name));text(await tools[t.name]({}));' }])
  if (!pending.has(id)) {
    pending.set(id, digest)
    return Response.json({ reserved: false, retrySameId: true, error: { code: 'busy' } },
      { status: 429, headers: { 'x-velorn-retry-same-id': '1', 'retry-after': '0.1' } })
  }
  return response([message('SHADOW_FIRST')])
}
