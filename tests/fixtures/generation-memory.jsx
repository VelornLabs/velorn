import React from 'react'
import { createRoot } from 'react-dom/client'
import GenerationMemorySetting from '../../src/components/GenerationMemorySetting'
import '../../src/components/ConnectedAgentPanel.css'
let stored = false, fail = false, writes = []
window.electronAPI = {
  getSetting: async key => { if (key !== 'freeGpuMemoryAfterGeneration') throw new Error('unexpected setting'); return stored },
  setSetting: async (key, value) => {
    if (key !== 'freeGpuMemoryAfterGeneration' || typeof value !== 'boolean') throw new Error('unexpected write')
    if (fail) return { success: false }
    writes.push(value); stored = value; return { success: true }
  },
}
const root = createRoot(document.getElementById('root'))
let version = 0
window.memoryFixture = { snapshot: () => ({ stored, writes }), fail: value => { fail = value },
  mount: () => root.render(<div className="connected-agent-panel"><GenerationMemorySetting key={++version} /></div>) }
window.memoryFixture.mount()
