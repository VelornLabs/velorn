// RAM-only saved library. No App startup, filesystem, ComfyUI or provider.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import WorkflowLibraryDrawer from '../../src/components/WorkflowLibraryDrawer'

const uiWorkflow = { nodes: [{ id: 1, type: 'LoadImage' }], links: [] }
const apiWorkflow = { '1': { class_type: 'LoadImage', inputs: { image: 'portrait.png' } } }
const records = new Map([
  ['portrait', { id: 'portrait', title: 'My portrait animation', description: 'A gentle portrait performance with my favorite local workflow.', savedAt: 1, updatedAt: 3, outputType: 'image', uiWorkflow, apiWorkflow, nodeCount: 1 }],
  ['legacy', { id: 'legacy', title: 'My older landscape workflow', description: 'Saved before API capture was available.', savedAt: 1, updatedAt: 1, uiWorkflow, nodeCount: 1 }],
])
const calls = []
const settings = new Map(), settingsCalls = []
let empty = false, failList = false, pendingRead = null, holdRead = false, longList = false
let failSettingsRead = false, failSettingsWrite = false
let holdSettingsWrite = false, pendingSettingsWrite = null
const base = '/fixture-only/custom-workflows'
const customEntry = record => ({ id: `my-workflow:${record.id}`, ...record, id: `my-workflow:${record.id}`, source: 'my-workflows', format: record.apiWorkflow ? 'api' : 'ui', readiness: record.apiWorkflow ? 'needs-review' : 'needs-api-capture', readinessMessage: record.apiWorkflow ? 'Saved API copy available; inspect before generation.' : 'Open this workflow in ComfyUI and save it to Velorn again to enable agent runs.', inputSummary: 'Image · prompt · seed' })
const listed = () => empty ? [] : [...records.values()].map(customEntry).concat({ id: 'tpl-mcp-upscale', title: 'My upscale workflow', description: 'Increase the resolution of a finished shot.', source: 'imported', format: 'api', outputType: 'video', updatedAt: 2, readinessMessage: 'Saved API copy available; inspect before generation.', inputSummary: 'Video · scale' }, longList ? Array.from({ length: 48 }, (_, index) => ({ id: `tpl-mcp-long-${index + 1}`, title: `Long workflow ${String(index + 1).padStart(2, '0')} — saved recipe with a longer name`, description: 'Synthetic long-list workflow. No graph is opened or executed.', source: 'imported', format: 'api', outputType: ['image', 'video', 'audio'][index % 3], updatedAt: index + 10 })) : [])
window.electronAPI = {
  getSetting: async key => { settingsCalls.push({ action: 'read', key }); if (failSettingsRead) throw new Error('Synthetic organization read failed.'); return structuredClone(settings.get(key)) },
  setSetting: async (key, value) => { settingsCalls.push({ action: 'write', key }); if (holdSettingsWrite) await new Promise(resolve => { pendingSettingsWrite = resolve }); if (failSettingsWrite) return { success: false, error: 'Synthetic organization write failed.' }; settings.set(key, structuredClone(value)); return { success: true } },
  listSavedWorkflows: async () => { calls.push('list'); return failList ? { success: false, error: 'Synthetic library read failed.' } : { success: true, workflows: listed() } },
  readSavedWorkflow: async ({ workflowId }) => {
    calls.push('read'); if (holdRead) await new Promise(resolve => { pendingRead = resolve })
    return { success: true, title: workflowId, format: 'ui', uiWorkflow }
  },
  loadComfyUiWorkflowGraph: async args => { calls.push('open'); return { success: true } },
  getAppPath: async () => '/fixture-only', pathJoin: async (...parts) => parts.join('/'),
  listDirectory: async () => ({ success: true, items: [...records.keys()].map(id => ({ name: `${id}.json` })) }),
  readFile: async file => ({ success: true, data: JSON.stringify(records.get(file.split('/').at(-1).replace(/\.json$/, ''))) }),
  writeFile: async (file, contents) => { if (!file.startsWith(`${base}/`)) throw new Error('Unexpected synthetic write'); calls.push('metadata-write'); const record = JSON.parse(contents); records.set(record.id, record); return { success: true } },
}
window.workflowLibraryTest = {
  snapshot: () => ({ calls: [...calls], records: [...records.values()], settings: Object.fromEntries(settings), settingsCalls: [...settingsCalls], settingsWritePending: Boolean(pendingSettingsWrite) }),
  setEmpty: value => { empty = value }, setFailList: value => { failList = value },
  setLongList: value => { longList = value },
  setFailSettingsRead: value => { failSettingsRead = value }, setFailSettingsWrite: value => { failSettingsWrite = value },
  holdSettingsWrite: value => { holdSettingsWrite = value }, releaseSettingsWrite: () => { pendingSettingsWrite?.(); pendingSettingsWrite = null },
  holdRead: value => { holdRead = value }, releaseRead: () => { pendingRead?.(); pendingRead = null },
}
function Fixture() {
  const [open, setOpen] = React.useState(false), [disabled, setDisabled] = React.useState(false)
  const [reference, setReference] = React.useState('')
  const composer = React.useRef(null)
  const focusHandoff = React.useRef(false)
  window.workflowLibraryTest.setDisabled = value => setDisabled(value)
  React.useEffect(() => { if (focusHandoff.current && !open) { focusHandoff.current = false; composer.current?.focus() } }, [reference, open])
  return <main style={{ height: '100vh', background: '#090e18', color: '#e7ebf5', padding: 28 }}>
    <h1 style={{ fontSize: 20 }}>Velorn · ComfyUI</h1>
    <p style={{ margin: '12px 0 22px', color: '#a8b2c7' }}>Synthetic workflow library — no real generation or disk access</p>
    <button style={{ background: '#263246', border: '1px solid #46546a', borderRadius: 6, padding: '8px 16px' }} onClick={() => setOpen(true)}>My Workflows</button>
    <iframe title="ComfyUI" style={{ display: 'block', width: 540, maxWidth: '90%', height: 180, margin: '28px 0' }} srcDoc="<!doctype html><html><body style='background:#151c28;color:#a8b2c7;font:14px sans-serif;padding:20px'>Synthetic graph canvas</body></html>" />
    <textarea ref={composer} aria-label="Staged workflow reference" value={reference} readOnly style={{ width: 450, maxWidth: '90%', color: '#e7ebf5', background: '#151c28' }} />
    {open && <WorkflowLibraryDrawer open onClose={() => setOpen(false)} disabled={disabled} onUseWithAgent={entry => { calls.push('stage'); focusHandoff.current = true; setReference(entry.id); return { success: true } }} />}
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
