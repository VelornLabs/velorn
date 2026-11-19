// Real workspace hook, TitleBar, BottomBar, reference board and MCP services.
// Never import App: there is no normal startup, native IO, media generation,
// real project, credentials, persisted preference or external service here.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'

const prefix = '/fixture-only/storyboard-workspace/'
const roots = { alpha: `${prefix}alpha`, beta: `${prefix}beta` }
const clone = value => value === undefined ? undefined : structuredClone(value)
const files = new Map(), directories = new Set(Object.values(roots)), preferences = new Map()
const calls = [], forbiddenCalls = [], storage = new Map()
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key), clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null, get length() { return storage.size },
} })
const checked = value => {
  if (!String(value).startsWith(prefix) || String(value).split('/').includes('..')) throw new Error(`Outside RAM fixture: ${value}`)
  return value
}
const record = (method, value) => calls.push({ method, value: clone(value) })
const forbidden = method => async value => {
  forbiddenCalls.push({ method, value: clone(value) })
  throw new Error(`Forbidden fixture operation: ${method}`)
}
window.electronAPI = {
  isElectron: true, platform: 'linux',
  pathJoin: async (...parts) => checked(parts.join('/').replace(/\/+/g, '/')),
  pathBasename: async value => checked(value).split('/').pop(),
  exists: async value => directories.has(checked(value)) || files.has(value)
    || seededAssets.some(asset => Object.values(roots).some(root => value === `${root}/${asset.path}`)),
  isDirectory: async value => directories.has(checked(value)),
  createDirectory: async value => { directories.add(checked(value)); record('createDirectory', value); return { success: true } },
  writeFile: async (value, data) => {
    checked(value)
    if (!value.endsWith('.comfystudio')) return forbidden('writeFile')(value)
    files.set(value, String(data)); record('writeFile', value); return { success: true }
  },
  readFile: async value => { checked(value); record('readFile', value); return files.has(value)
    ? { success: true, data: files.get(value) } : { success: false, error: 'Missing RAM fixture file' } },
  listDirectory: async value => { checked(value); return { success: true, items: [...files.keys()]
    .filter(name => name.startsWith(value + '/') && !name.slice(value.length + 1).includes('/'))
    .map(name => ({ path: name, name: name.split('/').pop(), isFile: true, modified: '2026-09-27T00:00:00.000Z' })) } },
  deleteFile: async value => { checked(value); if (!value.includes('/autosave/')) return forbidden('deleteFile')(value)
    files.delete(value); record('deleteFixtureSnapshot', value); return { success: true } },
  writeFileFromArrayBuffer: async (value, data) => {
    checked(value)
    if (!Object.values(roots).some(root => value === `${root}/project.thumbnail.webp`)) return forbidden('writeFileFromArrayBuffer')(value)
    files.set(value, data.slice(0)); record('writeFixtureThumbnail', value); return { success: true }
  },
  getFileUrlDirect: async value => {
    checked(value)
    const asset = seededAssets.find(item => Object.values(roots).some(root => value === `${root}/${item.path}`))
    if (!asset) throw new Error('Only synthetic RAM images are available')
    return asset.url
  },
  getSetting: async key => preferences.get(key) ?? null,
  setSetting: async (key, value) => { preferences.set(key, clone(value)); record('setSetting', key); return { success: true } },
  deleteSetting: async key => { preferences.delete(key); record('deleteSetting', key); return { success: true } },
  getWindowState: async () => ({ isMaximized: false, isFullScreen: false }),
  onWindowStateChanged: () => () => {},
  getMediaPreparationStatus: async () => ({ activeCount: 0, queuedCount: 0, jobs: [] }),
  onMediaPreparationStatus: () => () => {},
  getComfyCloudCreditBalance: async () => ({ status: 'ok', credits: 3200 }),
  selectFile: forbidden('selectFile'), selectDirectory: forbidden('selectDirectory'),
  copyFile: forbidden('copyFile'), trashAssetFiles: forbidden('trashAssetFiles'),
  transcodeForPlayback: forbidden('transcodeForPlayback'), transcodeForProxy: forbidden('transcodeForProxy'),
  minimizeWindow: forbidden('minimizeWindow'), toggleMaximizeWindow: forbidden('toggleMaximizeWindow'),
  toggleFullScreenWindow: forbidden('toggleFullScreenWindow'), closeWindow: forbidden('closeWindow'),
  comfyLauncher: {
    getState: async () => ({ state: 'idle', ownership: 'none' }),
    getConfig: async () => ({ autoStart: false, disableAutoLaunch: true }), getLogs: async () => [],
    onState: () => () => {}, onLog: () => () => {},
    start: forbidden('comfyLauncher.start'), stop: forbidden('comfyLauncher.stop'), restart: forbidden('comfyLauncher.restart'),
    refresh: forbidden('comfyLauncher.refresh'), detectCandidates: forbidden('comfyLauncher.detectCandidates'),
  },
}

// Deterministic canvas diagrams, not generated/imported user media.
const seededAssets = ['SIGNAL', 'MARA', 'CITY', 'DAWN'].map((label, index) => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
  const context = canvas.getContext('2d')
  context.fillStyle = ['#123f54', '#3c3055', '#245353', '#694a32'][index]; context.fillRect(0, 0, 640, 360)
  context.strokeStyle = '#ffffff33'; context.lineWidth = 2
  for (let x = 24; x < 640; x += 56) context.strokeRect(x, 120 + (x % 80), 36, 190)
  context.fillStyle = '#f1f7ff'; context.font = 'bold 40px sans-serif'; context.fillText(label, 28, 66)
  context.font = '14px sans-serif'; context.fillText('SYNTHETIC WORKSPACE FIXTURE — RAM ONLY', 30, 98)
  return { id: `reference-${index + 1}`, type: 'image', name: `${label.toLowerCase()}-study.png`,
    path: `assets/images/reference-${index + 1}.png`, url: canvas.toDataURL('image/png'),
    width: 640, height: 360, duration: 5, isImported: true, createdAt: '2026-09-27T00:00:00.000Z' }
})

const [{ default: TitleBar }, { default: BottomBar }, { default: ProductionWorkspace }, { default: useStoryboardWorkspace },
  { default: project }, { default: timeline }, { default: assets }, { default: monitor }, storyboard, { runMcpAction }, dirty] = await Promise.all([
  import('../../src/components/TitleBar'), import('../../src/components/BottomBar'), import('../../src/components/ProductionWorkspace'),
  import('../../src/hooks/useStoryboardWorkspace'), import('../../src/stores/projectStore'), import('../../src/stores/timelineStore'),
  import('../../src/stores/assetsStore'), import('../../src/stores/generationMonitorStore'), import('../../src/services/storyboard'),
  import('../../src/services/mcpActions'), import('../../src/services/projectDirtyTracker'),
])
const timelineDefaults = timeline.getState()
dirty.attachProjectDirtyWatchers({ timelineStore: timeline, assetsStore: assets, projectStore: project })
function reset({ populated = false, root = 'alpha', raw, name = `${root === 'alpha' ? 'Signal' : 'Another project'} — synthetic workspace` } = {}) {
  const settings = { width: 1920, height: 1080, fps: 24 }
  timeline.setState({ ...timelineDefaults, clips: [], transitions: [], markers: [], selectedClipIds: [],
    tracks: [{ id: 'video-1', name: 'Video 1', type: 'video', visible: true, locked: false, muted: false }],
    duration: 20, timelineFps: 24, isPlaying: false, history: [], historyIndex: -1,
    timelineSessionId: timeline.getState().timelineSessionId + 1 })
  assets.setState({ assets: clone(seededAssets), folders: [], folderCounter: 1, currentPreview: null, mediaPreparation: null })
  project.setState({ currentProject: { name, created: `fixture-${root}`, settings,
    timelines: [{ id: `timeline-${root}`, name: 'Timeline 1', ...settings }], assets: clone(seededAssets), folders: [],
    ...(raw === undefined ? {} : { storyboard: clone(raw) }) }, currentProjectHandle: roots[root], currentTimelineId: `timeline-${root}`,
    isLoading: false, autoSaveEnabled: false, projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0, error: null })
  if (populated) {
    storyboard.applyStoryboardEdit({ operation: 'update_board', patch: { title: 'SIGNAL / A technology story', brief: 'Synthetic workspace study', referenceAssetIds: ['reference-1'] } })
    storyboard.applyStoryboardEdit({ operation: 'start_production', productionType: 'music-video', targetDurationSeconds: 45 })
    storyboard.applyStoryboardEdit({ operation: 'add_cast_member', member: { name: 'Mara', role: 'Lead', referenceAssetIds: ['reference-2'] } })
    storyboard.applyStoryboardEdit({ operation: 'add_location', location: { name: 'Signal city', referenceAssetIds: ['reference-3'] } })
    for (let index = 0; index < 8; index++) storyboard.applyStoryboardEdit({ operation: 'add_shot', shot: {
      title: `A signal in the city ${index + 1}`, description: 'A synthetic still for workspace, keyboard and scrolling checks.',
      durationSeconds: 5, storyboardAssetId: `reference-${index % 4 + 1}`,
    } })
  }
  project.setState({ projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0 })
  dirty.markProjectClean()
}
reset()
window.storyboardWorkspaceTest = {
  ready: false, reset, runMcpAction,
  snapshot: () => ({ projectName: project.getState().currentProject?.name, projectHandle: project.getState().currentProjectHandle,
    raw: clone(project.getState().currentProject?.storyboard), historyCount: project.getState().projectHistory.length,
    futureCount: project.getState().projectFuture.length, dirty: dirty.isProjectDirty(),
    timeline: JSON.stringify(timeline.getState().getProjectData()), calls: clone(calls), forbiddenCalls: clone(forbiddenCalls),
    filePaths: [...files.keys()], preferences: [...preferences.keys()], error: project.getState().error }),
  setRaw: raw => project.setState(state => ({ currentProject: { ...state.currentProject, storyboard: clone(raw) } })),
  setLoading: isLoading => project.setState({ isLoading }),
  close: () => project.getState().closeProject(),
  reopen: (root = 'alpha') => project.getState().openProject(roots[root]),
  saved: (root = 'alpha') => JSON.parse(files.get(`${roots[root]}/project.comfystudio`) || 'null'),
  undo: () => runMcpAction('undo', { previewOnly: false }),
  redo: () => runMcpAction('redo', { previewOnly: false }),
  setCrowdedTitlebar: enabled => monitor.setState({ jobs: enabled ? [{ id: 'fixture-job', status: 'running',
    workflowId: 'fixture', workflowLabel: 'Synthetic status only', progress: 40, createdAt: Date.now() - 1000 }] : [], activeJobId: enabled ? 'fixture-job' : null }),
}
function Fixture() {
  const currentProject = project(state => state.currentProject)
  const [requestedTab, setRequestedTab] = React.useState('editor')
  const [disabled, setDisabled] = React.useState(false)
  const { activeTab, showStoryboardTab, selectTab, openStoryboard } = useStoryboardWorkspace({ activeTab: requestedTab, onTabChange: setRequestedTab, disabled })
  window.storyboardWorkspaceTest.workspace = () => ({ activeTab, requestedTab, showStoryboardTab, disabled })
  window.storyboardWorkspaceTest.selectTab = selectTab
  window.storyboardWorkspaceTest.setDisabled = setDisabled
  React.useEffect(() => { window.storyboardWorkspaceTest.ready = true }, [])
  return <div className="h-screen min-w-0 flex flex-col overflow-hidden bg-sf-dark-950 text-sf-text-primary" data-testid="workspace-fixture">
    <TitleBar projectName={currentProject?.name} activeTab={activeTab} showStoryboardTab={showStoryboardTab}
      onTabChange={selectTab} editorLayout="default" onEditorLayoutChange={() => {}} exportBusy={disabled} />
    <main className="flex-1 min-h-0 min-w-0" data-testid="workspace-content">
      {currentProject ? activeTab === 'storyboard'
        ? <ProductionWorkspace workspace onBackToEditor={() => selectTab('editor')} />
        : <section className="h-full p-8" data-testid={`workspace-${activeTab}`}><h1>{activeTab === 'editor' ? 'Editor' : activeTab} workspace fixture</h1>
          <p className="mt-3 text-xs text-sf-text-muted">Real navigation and board · RAM-only project · synthetic stills · no app startup or generation</p></section>
        : <section data-testid="project-selection" className="p-8">No project open</section>}
    </main>
    <BottomBar projectName={currentProject?.name} onOpenStoryboard={currentProject && !disabled ? openStoryboard : undefined} />
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
