// Actual MCP renderer handler and API-to-UI conversion. All saved graphs,
// native calls and settings below live in RAM; there is no App startup.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'

const clone = value => value === undefined ? undefined : structuredClone(value)
const storage = new Map([['comfystudio-comfy-connection', JSON.stringify({ port: 59989 })]])
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key), clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null, get length() { return storage.size },
} })

const uiWorkflow = {
  version: 1, nodes: [{ id: 9, type: 'LoadImage', title: 'Saved portrait',
    pos: [120, 90], size: [320, 180], widgets_values: ['fixture-portrait.png'] }],
  links: [], groups: [{ title: 'Keep saved layout', bounding: [90, 50, 420, 300] }],
}
const apiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'fixture-city.png' }, _meta: { title: 'City reference' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'fixture-preview' } },
}
const records = new Map([
  ['my-workflow:portrait', { success: true, title: 'Saved portrait', format: 'ui', uiWorkflow }],
  ['tpl-mcp-city', { success: true, title: 'City authoring test', format: 'api', workflow: apiWorkflow }],
  ['my-workflow:malformed', { success: true, title: 'Broken graph', format: 'ui', uiWorkflow: { nodes: null } }],
])
const calls = [], forbiddenCalls = []
let loadError = '', exportLease = null, renderGraph = () => {}
const forbidden = method => async (...args) => {
  forbiddenCalls.push({ method, args: clone(args) })
  throw new Error(`Forbidden fixture operation: ${method}`)
}
window.electronAPI = {
  getSetting: async key => key === 'comfyConnection' ? { port: 59989 } : null,
  readSavedWorkflow: async ({ workflowId }) => {
    calls.push({ type: 'read', workflowId })
    return clone(records.get(workflowId) || { success: false, error: 'Synthetic saved workflow not found.' })
  },
  loadComfyUiWorkflowGraph: async args => {
    const iframe = document.querySelector('iframe[title="ComfyUI"]')
    const visible = Boolean(iframe && iframe.getBoundingClientRect().width && iframe.getBoundingClientRect().height)
    calls.push({ type: 'load', args: clone(args), visible })
    if (loadError) return { success: false, error: loadError }
    if (!visible) return { success: false, error: 'Synthetic embedded tab was not visible.' }
    renderGraph(clone(args.workflowGraph))
    return { success: true }
  },
  writeFile: forbidden('writeFile'), saveProject: forbidden('saveProject'),
  queueComfyWorkflow: forbidden('queueComfyWorkflow'), executeWorkflow: forbidden('executeWorkflow'),
}

// Import only after the RAM storage/bridge are installed, so module startup
// cannot read a real browser profile or native connection setting.
const { handleOpenComfyUiWorkflow } = await import('../../src/services/mcpWorkflowOpening')
const { default: useProjectStore } = await import('../../src/stores/projectStore')
const { default: useTimelineStore } = await import('../../src/stores/timelineStore')
const { default: useAssetsStore } = await import('../../src/stores/assetsStore')
const { beginLocalExportActivity } = await import('../../src/stores/exportActivityStore')

function authored() {
  const project = useProjectStore.getState(), timeline = useTimelineStore.getState(), assets = useAssetsStore.getState()
  return clone({ project: project.currentProject, projectHandle: project.currentProjectHandle,
    timelineId: project.currentTimelineId, clips: timeline.clips, tracks: timeline.tracks,
    transitions: timeline.transitions, undoStack: timeline.undoStack, redoStack: timeline.redoStack,
    assets: assets.assets, folders: assets.folders })
}
window.workflowOpeningTest = {
  ready: false,
  snapshot: () => ({ calls: clone(calls), forbiddenCalls: clone(forbiddenCalls), authored: authored(),
    uiWorkflow: clone(uiWorkflow), apiWorkflow: clone(apiWorkflow) }),
  run: async payload => {
    try { return await handleOpenComfyUiWorkflow(clone(payload)) }
    catch (error) { return { success: false, error: error.message } }
  },
  setLoadError: value => { loadError = value },
  setExportBusy: value => {
    exportLease?.end(); exportLease = value ? beginLocalExportActivity({ label: 'Synthetic export' }) : null
  },
}

function Fixture() {
  const [tab, setTab] = React.useState('editor'), [graph, setGraph] = React.useState(null)
  renderGraph = setGraph
  React.useEffect(() => {
    const open = event => { calls.push({ type: 'tab', detail: clone(event.detail) }); setTab('comfyui') }
    window.addEventListener('comfystudio-open-comfyui-tab', open)
    window.workflowOpeningTest.ready = true
    return () => window.removeEventListener('comfystudio-open-comfyui-tab', open)
  }, [])
  return <main style={{ minHeight: '100vh', background: '#090e18', color: '#e7ebf5', padding: 28 }}>
    <h1 style={{ fontSize: 20 }}>Velorn · Workflow opening fixture</h1>
    <p style={{ margin: '12px 0', color: '#a8b2c7' }}>Synthetic saved graphs and native bridge. No generation or project writes.</p>
    <p role="status">Active tab: {tab}</p>
    <div style={{ display: tab === 'comfyui' ? 'block' : 'none', marginTop: 24 }}>
      <iframe title="ComfyUI" style={{ width: '90%', height: 200, border: '1px solid #46546a' }}
        srcDoc="<!doctype html><html><body style='background:#151c28;color:#a8b2c7;font:16px sans-serif;padding:20px'>Isolated ComfyUI canvas — native load calls captured in RAM</body></html>" />
      <pre aria-label="Loaded graph" style={{ marginTop: 12, maxHeight: 440, overflow: 'auto' }}>{graph ? JSON.stringify(graph, null, 2) : 'No graph loaded'}</pre>
    </div>
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
