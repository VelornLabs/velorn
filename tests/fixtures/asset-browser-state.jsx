// Actual LeftPanel/AssetsPanel and stores with generated in-memory images.
// There is no App, preload, project directory, filesystem write, or MCP bridge.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../../src/index.css'
import LeftPanel from '../../src/components/LeftPanel'
import { I18nProvider } from '../../src/i18n/I18nContext'
import useAssetBrowserStore from '../../src/stores/assetBrowserStore.mjs'
import useAssetsStore from '../../src/stores/assetsStore'
import useProjectStore from '../../src/stores/projectStore'
import useTimelineStore from '../../src/stores/timelineStore'
import { attachProjectDirtyWatchers, markProjectClean, isProjectDirty,
  TIMELINE_PROJECT_KEYS, ASSETS_PROJECT_KEYS, PROJECT_STORE_KEYS } from '../../src/services/projectDirtyTracker'

const image = document.createElement('canvas')
image.width = 32; image.height = 18
image.getContext('2d').fillStyle = '#38bdf8'; image.getContext('2d').fillRect(0, 0, 32, 18)
const imageUrl = image.toDataURL('image/png')
const folders = [
  { id: 'shots', name: 'Shots', parentId: null },
  { id: 'takes', name: 'Takes', parentId: 'shots' },
  { id: 'details', name: 'Details', parentId: 'takes' },
  { id: 'archive', name: 'Archive', parentId: null },
]
const assets = [
  ...Array.from({ length: 120 }, (_, index) => ({ id: `shot-${index}`, folderId: 'shots', name: `Match shot ${String(index).padStart(3, '0')}` })),
  ...Array.from({ length: 12 }, (_, index) => ({ id: `other-${index}`, folderId: 'shots', name: `Other shot ${String(index).padStart(3, '0')}` })),
  ...Array.from({ length: 16 }, (_, index) => ({ id: `take-${index}`, folderId: 'takes', name: `Match take ${String(index).padStart(3, '0')}` })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `detail-${index}`, folderId: 'details', name: `Match detail ${String(index).padStart(3, '0')}` })),
  { id: 'root-image', folderId: null, name: 'Root image' },
].map((asset, index) => ({ ...asset, type: 'image', url: imageUrl, isImported: false,
  width: 32, height: 18, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }))

useTimelineStore.setState({ clips: [], tracks: [], transitions: [], selectedClipIds: [], isPlaying: false })
attachProjectDirtyWatchers({ timelineStore: useTimelineStore, assetsStore: useAssetsStore, projectStore: useProjectStore })
const loadProject = async (name = 'Synthetic asset browser project') => {
  useProjectStore.setState({ currentProject: { name, settings: { width: 960, height: 540, fps: 24 }, timelines: [] },
    currentProjectHandle: null, currentTimelineId: null })
  // Exercise the real project hydration reset path without any project handle.
  await useAssetsStore.getState().loadFromProject(assets.map(asset => ({ ...asset })), null, folders.map(folder => ({ ...folder })), 10)
  markProjectClean()
}
await loadProject()

window.assetBrowserTest = {
  async loadProject(name) { await loadProject(name) },
  clearProject: () => useAssetsStore.getState().clearProject(),
  removeFolder: id => useAssetsStore.getState().removeFolder(id),
  restoreCheckpointWithoutShots() {
    // Checkpoint restoration replaces store data directly, bypassing removeFolder.
    useAssetsStore.setState(state => ({
      folders: state.folders.filter(folder => folder.id === 'archive'),
      assets: state.assets.filter(asset => !['shots', 'takes', 'details'].includes(asset.folderId)),
    }))
  },
  snapshot() {
    const state = useAssetBrowserStore.getState(), authored = useAssetsStore.getState()
    const scroller = document.querySelector('[data-testid="asset-browser-scroll"]')
    return {
      viewMode: state.viewMode, currentFolderId: state.currentFolderId, searchQuery: state.searchQuery,
      expandedFolderIds: Array.from(state.expandedFolderIds).sort(), scrollTop: state.scrollTop,
      domScrollTop: scroller?.scrollTop ?? null, scrollHeight: scroller?.scrollHeight ?? null,
      clientHeight: scroller?.clientHeight ?? null, searchValue: document.querySelector('input[placeholder="Search..."]')?.value ?? null,
      savedView: localStorage.getItem('assetsViewMode'),
      dirty: isProjectDirty(),
      authored: JSON.stringify(Object.fromEntries([
        ['assets', useAssetsStore, ASSETS_PROJECT_KEYS], ['timeline', useTimelineStore, TIMELINE_PROJECT_KEYS],
        ['project', useProjectStore, PROJECT_STORE_KEYS],
      ].map(([name, store, keys]) => [name, Object.fromEntries(keys.map(key => [key, store.getState()[key]]))]))),
      assetCount: authored.assets.length, folderIds: authored.folders.map(folder => folder.id).sort(),
    }
  },
}

function Fixture() {
  const [editor, setEditor] = React.useState(true), [layout, setLayout] = React.useState(0)
  const [activeTab, setActiveTab] = React.useState('assets'), [expanded, setExpanded] = React.useState(true)
  React.useEffect(() => {
    window.assetBrowserTest.resetLayout = () => flushSync(() => { setEditor(true); setLayout(value => value + 1); setExpanded(true); setActiveTab('assets') })
  }, [])
  return <div className="flex h-screen flex-col bg-sf-dark-950 text-sf-text-primary">
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-sf-dark-700 px-4">
      <span>Velorn · isolated asset browser</span>
      <button className="rounded bg-sf-dark-700 p-2" onClick={() => setEditor(value => !value)}>{editor ? 'Switch workspace' : 'Return to editor'}</button>
      <button className="rounded bg-sf-dark-700 p-2" onClick={() => setLayout(value => value + 1)}>Remount layout</button>
    </header>
    <main className="flex min-h-0 flex-1">
      {editor ? <div key={layout} className="h-full w-[650px] shrink-0" data-testid="actual-left-panel">
        <LeftPanel isActive isExpanded={expanded} onToggleExpanded={() => setExpanded(value => !value)}
          activeTab={activeTab} onTabChange={setActiveTab} onToggleFullHeight={() => setLayout(value => value + 1)} />
      </div> : <div data-testid="other-workspace" className="p-6">Synthetic other workspace; the asset panel is unmounted.</div>}
      <aside className="min-w-0 flex-1 p-6 text-sm text-sf-text-muted">Only synthetic folders and in-memory PNGs are loaded. Project import, file writes and normal app services are absent.</aside>
    </main>
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
