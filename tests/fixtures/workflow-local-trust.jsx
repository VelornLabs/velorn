import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import WorkflowLocalTrustSettings from '../../src/components/WorkflowLocalTrustSettings'
import '../../src/components/ConnectedAgentPanel.css'

let entries = [{ id: 'a'.repeat(64), workflowId: 'my-workflow:synthetic', title: 'Synthetic H3 video' }]
let fail = false
const listeners = new Set(), calls = []
const status = () => ({ success: true, policy: 'ask-cloud', localTrustedWorkflows: structuredClone(entries) })
const api = {
  getStatus: async () => { calls.push({ method: 'getStatus' }); return status() },
  onChanged: callback => { listeners.add(callback); return () => listeners.delete(callback) },
  revokeLocalTrust: async payload => {
    calls.push({ method: 'revoke', payload })
    if (fail) return { success: false, error: 'Synthetic save failure' }
    entries = entries.filter(entry => entry.id !== payload.id)
    for (const listener of listeners) listener(status())
    return status()
  },
}
window.workflowLocalTrustTest = {
  snapshot: () => ({ calls: structuredClone(calls), entries: structuredClone(entries), listeners: listeners.size }),
  fail: value => { fail = value },
  replace: value => { entries = structuredClone(value); for (const listener of listeners) listener(status()) },
}
function Fixture() {
  const [mounted, setMounted] = useState(true), [disabled, setDisabled] = useState(false)
  return <main className="connected-agent-panel" style={{ color: '#e3e7ec', background: '#121923', padding: 20, maxWidth: 540, minWidth: 0, fontFamily: 'sans-serif' }}>
    <h2>Generation spending</h2>
    <button onClick={() => setMounted(value => !value)}>{mounted ? 'Unmount' : 'Remount'}</button>
    <button onClick={() => setDisabled(value => !value)}>{disabled ? 'Enable actions' : 'Disable actions'}</button>
    {mounted && <WorkflowLocalTrustSettings api={api} disabled={disabled} />}
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
