// Real renderer components and stores, but only in-memory images, settings and
// native replies. No App, preload, project loading, filesystem or process APIs.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'

const query = new URLSearchParams(location.search)
const scenario = query.get('scenario') || 'normal'
const surface = query.get('surface') || 'assets'
const initialSection = query.get('section') || null
const platform = query.get('platform') || 'linux'
const projectRoot = platform === 'win32' ? 'C:/fixture-only/project' : '/fixture-only/project'
const externalRoot = platform === 'win32' ? 'C:/fixture-only/external' : '/fixture-only/external'
const clone = value => value === undefined ? undefined : structuredClone(value)
const calls = [], trashCalls = [], forbiddenCalls = [], settingWrites = [], removalEvents = [], alerts = []
let pendingTrash = null
window.alert = message => alerts.push(String(message))
const settings = { comfyConnection: { host: '127.0.0.1', port: 8188 },
  outputDirectory: '/fixture-only/outputs', workflowsDirectory: '/fixture-only/workflows' }
const record = (method, payload) => calls.push({ method, payload: clone(payload) })
const forbidden = method => async payload => {
  forbiddenCalls.push({ method, payload: clone(payload) })
  throw new Error(`Forbidden fixture action: ${method}`)
}
const launcherState = { state: 'idle', ownership: 'none', httpBase: 'http://127.0.0.1:8188' }
const launcherConfig = { launcherMode: 'script', launcherScript: '', macAppPath: '', autoStart: false,
  stopOnQuit: true, startupTimeoutMs: 120000, disableAutoLaunch: true }
const bridge = {
  isElectron: true, platform,
  async getSetting(key) { record('getSetting', key); return clone(key ? settings[key] : settings) },
  async setSetting(key, value) { record('setSetting', { key, value }); settingWrites.push({ key, value: clone(value) }); settings[key] = clone(value); return { success: true } },
  async getHardwareExportFfmpegStatus() { record('getHardwareExportFfmpegStatus'); return { source: 'bundled', settingPath: '', path: '/fixture-only/ffmpeg' } },
  async checkLocalComfyConnection(payload) { record('checkLocalComfyConnection', payload); return { ok: false, error: 'Fixture ComfyUI is offline.' } },
  async pathJoin(...parts) { return parts.join('/').replace(/\/+/g, '/') },
  async getFileUrlDirect() { return imageUrl },
  async exists() { return false },
  async isDirectory() { return false },
  async selectDirectory() { return null },
  async selectFile() { return null },
  async getAppVersion() { return '0.0.0-fixture' },
  async getSystemInfo() { return { platform: 'linux', arch: 'fixture', appVersion: '0.0.0-fixture' } },
  async openExternal(url) { record('openExternal', url); return { success: true } },
  deleteFile: forbidden('deleteFile'), deleteDirectory: forbidden('deleteDirectory'),
  writeFile: forbidden('writeFile'), writeFileFromArrayBuffer: forbidden('writeFileFromArrayBuffer'),
  copyFile: forbidden('copyFile'), createDirectory: forbidden('createDirectory'),
  async trashAssetFiles(payload) {
    record('trashAssetFiles', payload); trashCalls.push(clone(payload))
    const results = payload.paths.map((path, index) => {
      const success = scenario !== 'trash-failure' && !(scenario === 'trash-partial' && index > 0)
      return { path: platform === 'win32' ? path.replaceAll('/', '\\') : path, success,
        ...(!success ? { error: 'Fixture Trash is unavailable for this file.' } : {}) }
    })
    const response = { success: results.every(result => result.success), results }
    if (scenario === 'trash-pending') return new Promise(resolve => { pendingTrash = () => { pendingTrash = null; resolve(response) } })
    return response
  },
  mcp: { async getStatus() { return { running: false, url: 'http://127.0.0.1:19790/mcp', hasProject: true, toolCount: 0 } } },
  comfyLauncher: {
    async getState() { return clone(launcherState) }, async getConfig() { return clone(launcherConfig) },
    async getLogs() { return [] }, async refresh() { return clone(launcherState) },
    onState() { return () => {} }, onLog() { return () => {} },
    async detectLaunchers() { return { success: true, candidates: [] } },
    async discoverConnections() { return { success: true, connections: [], checkedPorts: [8188] } },
    async probeConnection() { return { success: false, error: 'Fixture ComfyUI is offline.' } },
    start: forbidden('comfyLauncher.start'), stop: forbidden('comfyLauncher.stop'), restart: forbidden('comfyLauncher.restart'),
  },
}
if (scenario === 'no-native') delete bridge.trashAssetFiles
window.electronAPI = bridge
// Deliberately keep the old unsafe preference: the new versioned preference
// must independently default to project-only, never silently inherit "disk".
localStorage.setItem('assetsDeleteMode', 'disk')
localStorage.removeItem('assetsRemovalModeV2')
localStorage.setItem('assetsViewMode', 'list')
window.addEventListener('velorn:asset-removal-mode-changed', event => removalEvents.push(clone(event.detail)))

const [settingsModule, assetsPanelModule, assetsModule, projectModule, timelineModule] = await Promise.all([
  import('../../src/components/SettingsModal'), import('../../src/components/panels/AssetsPanel'),
  import('../../src/stores/assetsStore'), import('../../src/stores/projectStore'), import('../../src/stores/timelineStore'),
])
const SettingsModal = settingsModule.default, AssetsPanel = assetsPanelModule.default
const useAssetsStore = assetsModule.default, useProjectStore = projectModule.default, useTimelineStore = timelineModule.default
const image = document.createElement('canvas')
image.width = 48; image.height = 27
const painter = image.getContext('2d'); painter.fillStyle = '#0ea5e9'; painter.fillRect(0, 0, 48, 27)
const imageUrl = image.toDataURL('image/png')
const assets = [
  { id: 'fixture-alpha', name: 'Alpha source.png', path: 'assets/images/alpha.png',
    absolutePath: `${projectRoot}/assets/images/alpha.png`,
    playbackCachePath: 'assets/cache/alpha-playback.mp4', proxyPath: 'assets/proxies/alpha-proxy.mp4' },
  { id: 'fixture-beta', name: 'Beta external.png', absolutePath: `${externalRoot}/beta.png` },
  { id: 'fixture-gamma', name: 'Gamma kept.png', path: 'assets/images/gamma.png', absolutePath: `${projectRoot}/assets/images/gamma.png` },
  ...(scenario === 'large-selection' ? Array.from({ length: 16 }, (_, index) => ({ id: `fixture-long-${index}`,
    name: `Long confirmation ${String(index).padStart(2, '0')}.png`,
    path: `assets/images/${'long-reviewable-filename-'.repeat(7)}${index}.png` })) : []),
].map(asset => ({ ...asset, type: 'image', folderId: null, url: imageUrl, width: 48, height: 27,
  isImported: true, createdAt: '2026-09-18T00:00:00.000Z' }))
useTimelineStore.setState({ clips: [], tracks: [], transitions: [], selectedClipIds: [], isPlaying: false })
useProjectStore.setState({ currentProject: { name: 'Synthetic media-removal fixture', timelines: [], settings: { width: 960, height: 540, fps: 24 } },
  currentProjectHandle: projectRoot, currentTimelineId: null, defaultProjectsLocation: '/fixture-only/projects', autoSaveEnabled: false })
useAssetsStore.setState({ assets: clone(assets), folders: scenario === 'folder-race' ? [{ id: 'fixture-bin', name: 'Fixture bin', parentId: null }] : [], currentPreview: null })
window.settingsMediaTest = {
  ready: false,
  snapshot: () => ({ scenario, surface, initialSection, platform, calls: clone(calls), trashCalls: clone(trashCalls),
    forbiddenCalls: clone(forbiddenCalls), settingWrites: clone(settingWrites), removalEvents: clone(removalEvents), alerts: clone(alerts),
    assetIds: useAssetsStore.getState().assets.map(asset => asset.id),
    folderIds: useAssetsStore.getState().folders.map(folder => folder.id), trashPending: !!pendingTrash,
    legacyMode: localStorage.getItem('assetsDeleteMode'), removalMode: localStorage.getItem('assetsRemovalModeV2'),
    text: document.body.innerText }),
  switchProject() { useProjectStore.setState({ currentProjectHandle: '/fixture-only/replacement-project' }) },
  completeTrash() { pendingTrash?.() },
  async applyTheme(themeId) { const { applyTheme } = await import('../../src/config/themes'); applyTheme(themeId) },
  addFolderAssetAndClickRemoval() {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Remove folder and move files to Trash…')
    if (!button) throw new Error('Open the fixture folder context menu first.')
    const lateAsset = { ...assets[2], id: 'fixture-late-folder', name: 'Late folder asset.png', folderId: 'fixture-bin',
      path: 'assets/images/late-folder.png', absolutePath: `${projectRoot}/assets/images/late-folder.png` }
    // Store mutation and the real button's DOM click share one JS turn: the
    // handler must use current stores, not its last-render folder inventory.
    useAssetsStore.setState(state => ({ assets: [...state.assets, lateAsset] }))
    button.click()
  },
}

function Fixture() {
  const [showSettings, setShowSettings] = React.useState(surface === 'settings')
  const [showAssets, setShowAssets] = React.useState(true)
  const [section, setSection] = React.useState(initialSection)
  React.useEffect(() => {
    window.settingsMediaTest.ready = true
    window.settingsMediaTest.openSettings = next => flushSync(() => { setSection(next); setShowSettings(true) })
    window.settingsMediaTest.closeSettings = () => flushSync(() => setShowSettings(false))
    window.settingsMediaTest.unmountAssets = () => flushSync(() => setShowAssets(false))
    window.settingsMediaTest.remountAssets = () => flushSync(() => setShowAssets(true))
  }, [])
  return <div className="h-screen bg-sf-dark-950 text-sf-text-primary flex flex-col">
    <header className="h-14 shrink-0 border-b border-sf-dark-700 flex items-center gap-4 px-5">
      <span>Velorn · isolated Settings and media removal</span>
      <button className="rounded bg-sf-dark-700 px-3 py-1" onClick={() => { setSection(null); setShowSettings(true) }}>Open fixture Settings</button>
    </header>
    <main className="flex min-h-0 flex-1">
      <section id="fixture-assets" style={{ width: 650 }} className="shrink-0 h-full border-r border-sf-dark-700">{showAssets && <AssetsPanel />}</section>
      <aside className="p-6 text-sm text-sf-text-muted">Synthetic images and paths only. Trash returns a mock result and never accesses disk.</aside>
    </main>
    <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} initialSection={section} />
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
