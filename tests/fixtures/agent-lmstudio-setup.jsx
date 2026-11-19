// Synthetic native cache only. No downloads, model files, server probes or inference.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentLmStudioSetup, useAgentLmStudioSetup } from '../../src/components/AgentLmStudioSetup'
import '../../src/components/ConnectedAgentPanel.css'

const listeners = new Set(), calls = [], records = new Map(), heldReads = [], heldLoads = []
let listError = '', holdRead = false, concurrent = 0, maximum = 0, loadError = null
let updateMounted, updateScope, updateExport
const initialAuthored = { provider: 'codex', model: 'synthetic-selected', history: ['unchanged'], draft: 'Keep this draft', projectDirty: false }
const authored = structuredClone(initialAuthored)
const key = ({ projectPath, chatId }) => `${projectPath}|${chatId}`
const initialScope = { projectPath: '/synthetic/project-a', chatId: 'chat-a' }
const invalidate = () => { for (const listener of listeners) listener() }
const find = jobId => {
  for (const jobs of records.values()) { const found = jobs.find(job => job.jobId === jobId); if (found) return found }
  return null
}
const api = {
  onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  agentDownloads: async scope => {
    calls.push({ method: 'list', ...scope }); concurrent++; maximum = Math.max(maximum, concurrent)
    const result = listError ? { success: false, error: listError } : { success: true, jobs: structuredClone(records.get(key(scope)) || []) }
    try { if (holdRead) await new Promise(resolve => heldReads.push(resolve)); return result } finally { concurrent-- }
  },
  cancel: async ({ jobId }) => {
    calls.push({ method: 'cancel', jobId }); const item = find(jobId)
    if (!item || item.state !== 'downloading') return { success: false, error: 'Download cannot be cancelled.' }
    item.state = 'cancelled'; invalidate(); return { success: true, jobId, state: item.state }
  },
  load: async ({ jobId }) => {
    calls.push({ method: 'load', jobId }); const item = find(jobId)
    if (!item || item.state !== 'completed' || !item.canLoad) return { success: false, error: 'Model not eligible to load.' }
    const approved = await new Promise(resolve => heldLoads.push(resolve))
    if (!approved) return { success: false, code: 'DECLINED', error: 'Loading was not approved. No automatic retry was started.' }
    if (loadError) {
      item.canLoad = loadError.code === 'LM_IDENTITY_UNAVAILABLE'; item.error = structuredClone(loadError); invalidate()
      return { success: false, error: structuredClone(loadError), jobId }
    }
    item.state = 'loading'; item.canLoad = false; invalidate(); return { success: true, jobId, state: 'loading' }
  },
}
window.electronAPI = new URLSearchParams(location.search).has('missing') ? {} : { lmStudioSetup: api }
window.lmStudioSetupTest = {
  ready: true,
  snapshot: () => ({ calls: structuredClone(calls), listeners: listeners.size, heldReads: heldReads.length, heldLoads: heldLoads.length,
    concurrent, maximum, authored: structuredClone(authored) }),
  jobs: ({ jobs, scope = initialScope, notify = true }) => { records.set(key(scope), structuredClone(jobs)); if (notify) invalidate() },
  invalidate, error: value => { listError = value; invalidate() }, holdRead: value => { holdRead = value },
  releaseReads: () => { heldReads.splice(0).forEach(resolve => resolve()) },
  approve: value => { heldLoads.splice(0).forEach(resolve => resolve(value)) },
  loadError: value => { loadError = value },
  mounted: value => updateMounted(value), scope: value => updateScope(value), exportBusy: value => updateExport(value),
}
function Conversation({ scope, exportBusy }) {
  const tracked = useAgentLmStudioSetup(scope)
  const turns = [...new Set(tracked.items.map(item => item.turnId))]
  return <div className="ca-messages" id="conversation" style={{ height: 390, flex: 'none', overflowY: 'auto', padding: 12 }}>
    <p>LM Studio setup fixture — RAM only</p>
    {turns.map((turnId, index) => <div key={turnId} data-turn-id={turnId}>
      <p>Agent turn: {turnId}</p>
      <AgentLmStudioSetup items={tracked.items.filter(item => item.turnId === turnId)} error={index === 0 ? tracked.error : ''}
        onRefresh={tracked.refresh} onCancel={tracked.cancel} onLoad={tracked.load} pendingById={tracked.pendingById}
        actionErrors={tracked.actionErrors} exportBusy={exportBusy} />
    </div>)}
    {!tracked.items.length && <AgentLmStudioSetup error={tracked.error} onRefresh={tracked.refresh} />}
  </div>
}
function Fixture() {
  const [mounted, setMounted] = useState(true), [scope, setScope] = useState(initialScope), [exportBusy, setExport] = useState(false)
  updateMounted = setMounted; updateScope = setScope; updateExport = setExport
  return <main className="connected-agent-panel" style={{ width: 'min(570px, 100%)', boxSizing: 'border-box', margin: '0 auto', minHeight: '100vh' }}>
    <h1 style={{ padding: 12 }}>Velorn · LM Studio model setup</h1>
    {mounted && <Conversation scope={scope} exportBusy={exportBusy} />}
    <p style={{ padding: 12 }}>Existing selected agent, model, draft and project stay unchanged.</p>
  </main>
}
document.body.style.cssText = 'margin:0;background:#080c14;color:#e7ebf5;font:13px system-ui'
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>)
