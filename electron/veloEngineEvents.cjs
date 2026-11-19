'use strict'
const { redactActivityText } = require('./connectedAgentFullAccessCodex.cjs')

// Forward only public assistant text and typed activity, never raw reasoning,
// protocol diagnostics, credential payloads or the provider's response objects.
function createEngineEventSink(emit, { fullAccess = false, secrets = [] } = {}) {
  const messages = new Map()
  const clean = (value, maxBytes = 65536, complete = true) => redactActivityText(
    secrets.reduce((text, secret) => text.split(secret).join('[private capability]'), String(value || '')),
    { complete, maxBytes })
  return event => {
    const p = event.params || {}, item = p.item
    if (event.method === 'turn/started') { emit({ type: 'status', text: 'Velo is working with the bundled engine…' }); return }
    if (event.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      const record = messages.get(p.itemId) || { text: '', phase: 'commentary' }
      record.text += p.delta; record.streamed = true; messages.set(p.itemId, record)
      // Full-access text is replaced by item ID; other modes use completion-only
      // text so partial capability strings can never leak across delta chunks.
      if (fullAccess) emit({ type: 'progress', itemId: p.itemId, text: clean(record.text, 65536, false), phase: record.phase, status: 'running' })
      return
    }
    if (!['item/started', 'item/completed'].includes(event.method) || !item) return
    const complete = event.method === 'item/completed'
    if (item.type === 'contextCompaction') {
      emit({ type: 'status', text: complete ? 'Velo is continuing…' : 'Velo is compacting this chat’s context…' })
      return
    }
    if (item.type === 'agentMessage') {
      const record = messages.get(item.id) || { text: '' }
      record.phase = item.phase === 'final_answer' ? 'final_answer' : 'commentary'
      if (typeof item.text === 'string') record.text = item.text
      messages.set(item.id, record)
      if (fullAccess) emit({ type: 'progress', itemId: item.id, text: clean(record.text), phase: record.phase, status: complete ? 'completed' : 'running' })
      else if (complete) emit({ type: 'delta', text: clean(record.text) })
      return
    }
    // MCP tool activity is already emitted by the authoritative native session.
    const label = { commandExecution: 'Shell command', fileChange: 'File changes', imageView: 'View image', webSearch: 'Web search' }[item.type]
    if (!fullAccess || !label) return
    emit({ type: 'tool', callId: `velo-engine:${item.id}`, toolName: label,
      status: !complete ? 'running' : item.status === 'failed' || item.exitCode > 0 ? 'failed'
        : ['declined', 'cancelled', 'denied'].includes(item.status) ? 'denied' : 'completed',
      summary: clean(item.command || item.query || label, 1200),
      ...(complete && item.type === 'commandExecution' ? { output: clean(item.aggregatedOutput, 16384) } : {}) })
  }
}
module.exports = { createEngineEventSink }
