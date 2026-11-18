// Actual Settings, TitleBar, navigation hook and queue store; no App, real
// native calls, user project, generation, files or external services.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'

const query = new URLSearchParams(location.search)
const settings = JSON.parse(sessionStorage.getItem('fixture-native-settings') || '{}')
const calls = [], forbidden = [], events = []
const clone = value => structuredClone(value)
localStorage.setItem('velorn-show-cloud-credit-balance', 'false')
if (query.has('hidden')) {
  settings.showGenerateTab = false
  localStorage.setItem('velorn-show-generate-tab', 'false')
}
const deny = method => async () => { forbidden.push(method); throw new Error('Forbidden fixture call: ' + method) }
window.electronAPI = {
  isElectron: true, platform: query.get('platform') || 'linux',
  getSetting: async key => settings[key] ?? null,
  setSetting: async (key, value) => {
    calls.push({ key, value }); settings[key] = clone(value)
    sessionStorage.setItem('fixture-native-settings', JSON.stringify(settings))
    return { success: true }
  },
  getWindowState: async () => ({ isMaximized: false, isFullScreen: false }),
  onWindowStateChanged: () => () => {},
  getHardwareExportFfmpegStatus: async () => ({ source: 'bundled', settingPath: '' }),
  getAppVersion: async () => '0.0.0-fixture',
  getSystemInfo: async () => ({ platform: 'linux', arch: 'fixture' }),
  getComfyCloudCreditBalance: deny('getComfyCloudCreditBalance'),
  writeFile: deny('writeFile'), createDirectory: deny('createDirectory'),
  deleteFile: deny('deleteFile'), selectDirectory: deny('selectDirectory'),
  closeWindow: deny('closeWindow'),
  comfyLauncher: {
    getState: async () => ({ state: 'idle', ownership: 'none' }),
    getConfig: async () => ({ autoStart: false, disableAutoLaunch: true }),
    getLogs: async () => [], onState: () => () => {}, onLog: () => () => {},
    start: deny('comfyLauncher.start'), stop: deny('comfyLauncher.stop'), restart: deny('comfyLauncher.restart'),
  },
}
window.addEventListener('velorn-generate-tab-visibility-changed', event => events.push(clone(event.detail)))
const [settingsModule, titleModule, hookModule, monitorModule, projectModule] = await Promise.all([
  import('../../src/components/SettingsModal'), import('../../src/components/TitleBar'),
  import('../../src/hooks/useGenerateWorkspace'), import('../../src/stores/generationMonitorStore'),
  import('../../src/stores/projectStore'),
])
const SettingsModal = settingsModule.default, TitleBar = titleModule.default
const useGenerateWorkspace = hookModule.default, monitor = monitorModule.default
projectModule.default.setState({ currentProject: { name: 'Navigation fixture', id: 'navigation-fixture',
  settings: { width: 1280, height: 720, fps: 24 } }, currentProjectHandle: '/fixture-only/navigation' })
monitor.getState().publishRuns({ runs: [{ id: 'fixture-running', promptId: 'fixture-prompt',
  label: 'Synthetic tracked run', status: 'running', progress: null, origin: 'agent',
  projectKey: '/fixture-only/navigation', createdAt: '2026-09-29T12:00:00Z', outputs: [],
}], owner: { scope: 'application' } })
let mounts = 0, unmounts = 0, cloudImageCalls = 0
function SyntheticGenerateListeners() {
  React.useEffect(() => {
    mounts++
    const probe = event => event.detail?.respond?.({ success: true })
    window.addEventListener('comfystudio-mcp-music-video-keyframe-probe', probe)
    return () => { unmounts++; window.removeEventListener('comfystudio-mcp-music-video-keyframe-probe', probe) }
  }, [])
  return <p>Generate listener fixture — no workflow execution</p>
}
function Fixture() {
  const [requestedTab, setTab] = React.useState(query.get('active') || 'editor')
  const [open, setOpen] = React.useState(false)
  const [disabled, setDisabled] = React.useState(false)
  const { activeTab, showGenerateTab, hasMountedGenerate } = useGenerateWorkspace({ activeTab: requestedTab, onTabChange: setTab, disabled })
  window.generateVisibilityTest = {
    ready: true, setTab, setDisabled, openSettings: () => setOpen(true), closeSettings: () => setOpen(false),
    state: () => ({ activeTab, showGenerateTab, hasMountedGenerate, mounts, unmounts, cloudImageCalls,
      calls: clone(calls), forbidden: clone(forbidden), events: clone(events),
      project: clone(projectModule.default.getState().currentProject), queue: clone(monitor.getState().runs),
      saved: localStorage.getItem('velorn-show-generate-tab') }),
    requestGenerate: event => window.dispatchEvent(new CustomEvent(event)),
    probe: () => { let result = false; window.dispatchEvent(new CustomEvent('comfystudio-mcp-music-video-keyframe-probe', {
      detail: { respond: () => { result = true } },
    })); return result },
  }
  return <div className="h-screen flex flex-col bg-sf-dark-950 text-sf-text-primary">
    <TitleBar activeTab={activeTab} onTabChange={setTab} showGenerateTab={showGenerateTab} exportBusy={disabled}
      onOpenCloudImage={() => { cloudImageCalls++ }} />
    <main className="flex-1 p-6">
      <button onClick={() => setOpen(true)} className="rounded bg-sf-dark-700 px-3 py-2">Open settings</button>
      <h1 className="mt-4 text-xl">{activeTab} — isolated navigation fixture</h1>
      {hasMountedGenerate && <div style={{ display: activeTab === 'generate' ? 'block' : 'none' }}><SyntheticGenerateListeners /></div>}
    </main>
    <SettingsModal isOpen={open} onClose={() => setOpen(false)} initialSection="appearance" />
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
