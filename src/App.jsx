import { useState, useCallback, useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react'
import { registerDesktopClose } from './services/desktopClose'
import { RefreshCw, ExternalLink, Loader2, BookmarkPlus, Library } from 'lucide-react'
import TitleBar from './components/TitleBar'
import { DesktopAccountProvider } from './components/DesktopAccount'
import AgentComfyCloudSetup from './components/AgentComfyCloudSetup'
import PhoneCreateSaver from './components/PhoneCreateSaver'
import VelornNetworkSaver from './components/VelornNetworkSaver'
import ExportPanel from './components/ExportPanel'
import ExportProgressOverlay from './components/ExportProgressOverlay'
import useExportActivityStore, { isExportBusy } from './stores/exportActivityStore'
import { startExportActivityBridge } from './services/exportActivity'
import WorkspaceErrorBoundary from './components/WorkspaceErrorBoundary'
import LeftPanel from './components/LeftPanel'
import PreviewPanel from './components/PreviewPanel'
import Timeline from './components/Timeline'
import DopeSheet from './components/DopeSheet'
import MixerPanel from './components/MixerPanel'
import ScopesPanel from './components/ScopesPanel'
import TransportControls from './components/TransportControls'
import InspectorPanel from './components/InspectorPanel'
import RightPanelDock from './components/RightPanelDock'
import ResizeHandle from './components/ResizeHandle'
import SettingsModal from './components/SettingsModal'
import GettingStartedModal from './components/GettingStartedModal'
import WelcomeScreen from './components/WelcomeScreen'
import BottomBar from './components/BottomBar'
import useProjectStore from './stores/projectStore'
import useAssetsStore from './stores/assetsStore'
import useTimelineStore from './stores/timelineStore'
import useStoryboardWorkspace from './hooks/useStoryboardWorkspace'
import useGenerateWorkspace from './hooks/useGenerateWorkspace'
import { getStoryboardProjectKey } from './utils/storyboardWorkspace.mjs'
import { stageWorkflowInAgent } from './utils/workflowAgentHandoff.mjs'
import videoCache from './services/videoCache'
import { WORKFLOW_SETUP_SECTION_ID } from './services/workflowSetupManager'
import {
  COMFY_CONNECTION_CHANGED_EVENT,
  getLocalComfyHttpBaseSync,
  hydrateLocalComfyConnection,
} from './services/localComfyConnection'
import { startComfyLauncherEventBridge } from './services/comfyLauncherEventBridge'
import { startComfyAutoImport } from './services/comfyAutoImport'
import { startMcpSnapshotPublisher } from './services/mcpSnapshot'
import { MCP_ACTION_BRIDGE_VERSION, startMcpActionBridge } from './services/mcpActions'
import { startGenerationRuns } from './services/generationRuns'
import { attachProjectDirtyWatchers, isProjectDirty } from './services/projectDirtyTracker'
import { VELORN_OPEN_STOCK_EVENT } from './services/pexelsStock'
import {
  DISCOVER_TAB_VISIBILITY_CHANGED_EVENT,
  getShowDiscoverTab,
  hydrateShowDiscoverTab,
} from './services/discoverTabVisibilitySettings.mjs'
import { useHiddenTopTabs } from './services/topTabVisibilitySettings.mjs'

// Tab workspaces load on first visit instead of shipping in the startup
// bundle. This keeps launch parse time down; GenerateWorkspace alone carries
// jspdf, and FlowAI carries @xyflow/react. The editor path (Timeline,
// PreviewPanel) and ExportPanel stay eager: the editor is the default tab,
// and ExportPanel hosts the renderer-side export engine that MCP-driven
// exports rely on.
const GenerateWorkspace = lazy(() => import('./components/GenerateWorkspace'))
const FlowAIWorkspace = lazy(() => import('./components/FlowAIWorkspace'))
const AgentWorkspace = lazy(() => import('./components/AgentWorkspace'))
const MOGWorkspace = lazy(() => import('./components/MOGWorkspace'))
const CreateWorkspace = lazy(() => import('./components/CreateWorkspace'))
const StockPanel = lazy(() => import('./components/StockPanel'))
const DiscoverWorkspace = lazy(() => import('./components/DiscoverWorkspace'))
const GpuSharingWorkspace = lazy(() => import('./components/GpuSharingWorkspace'))
const ProductionWorkspace = lazy(() => import('./components/ProductionWorkspace'))
const ConnectedAgentPanel = lazy(() => import('./components/ConnectedAgentPanel'))
const WorkflowLibraryDrawer = lazy(() => import('./components/WorkflowLibraryDrawer'))

const WORKSPACE_LOADING_FALLBACK = (
  <div className="flex-1 flex items-center justify-center bg-sf-dark-950 text-xs text-sf-text-muted">
    Loading…
  </div>
)

function formatDownloadBytes(bytes) {
  const numeric = Math.max(0, Number(bytes) || 0)
  if (numeric < 1024) return `${numeric} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = numeric / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function AppWorkspace({ accountAgentRequested = false }) {
  const exportBusy = useExportActivityStore(state => Boolean(state.activeJob || state.localActivity))
  useLayoutEffect(() => startExportActivityBridge(), [])
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState(null)
  const [agentModelPickerRequest, setAgentModelPickerRequest] = useState(0)
  const [gettingStartedOpen, setGettingStartedOpen] = useState(false)
  const [selectedItem, setSelectedItem] = useState({ type: 'shot', id: '2.1' })
  const [requestedMainTab, setMainTab] = useState('editor')
  const [rightPanelTab, setRightPanelTab] = useState('inspector')
  const rightPanelHostRef = useRef(null)
  const workflowReferenceRef = useRef(null)
  const workflowLibraryEpoch = useRef(0)
  const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false)
  const closeWorkflowLibrary = useCallback(() => { workflowLibraryEpoch.current++; setWorkflowLibraryOpen(false) }, [])
  useEffect(() => () => { workflowLibraryEpoch.current++ }, [])
  const [agentHighlightShotIds, setAgentHighlightShotIds] = useState([])
  const [agentRevealShotId, setAgentRevealShotId] = useState(null)
  const agentWorkspaceRef = useRef(null)
  const { activeTab: visibleMainTab, showGenerateTab, hasMountedGenerate } = useGenerateWorkspace({
    activeTab: requestedMainTab, onTabChange: setMainTab, disabled: exportBusy,
  })
  const { activeTab: mainTab, showStoryboardTab, selectTab, openStoryboard } = useStoryboardWorkspace({
    activeTab: visibleMainTab, onTabChange: setMainTab, disabled: exportBusy,
  })
  const [hasMountedFlowAi, setHasMountedFlowAi] = useState(false)
  const [showDiscoverTab, setShowDiscoverTabState] = useState(getShowDiscoverTab)
  const [bottomEditorView, setBottomEditorView] = useState('timeline')
  // Migrate the previous lab's panel selection during a development hot update.
  useEffect(() => {
    if (bottomEditorView === 'storyboard') setBottomEditorView('timeline')
  }, [bottomEditorView])
  const [activeTimelineToolLabel, setActiveTimelineToolLabel] = useState('Move tool')
  const [timelineStatusText, setTimelineStatusText] = useState('')
  const [downloadProgressItems, setDownloadProgressItems] = useState([])
  const mainTabRef = useRef(mainTab)
  useLayoutEffect(() => {
    // Release the editor's preview/decoder tree, including agent-started jobs.
    // Remain on Export afterwards so completion or errors are easy to review.
    if (exportBusy) setMainTab('export')
  }, [exportBusy, mainTab])
  const downloadDismissTimersRef = useRef(new Map())
  
  // Left panel state
  const [leftPanelExpanded, setLeftPanelExpanded] = useState(true)
  const [leftPanelTab, setLeftPanelTab] = useState('assets')
  const [leftPanelFullHeight, setLeftPanelFullHeight] = useState(false) // Resolve-style full height mode
  
  // Right panel (Inspector) state
  const [inspectorExpanded, setInspectorExpanded] = useState(true)
  const [inspectorFullHeight, setInspectorFullHeight] = useState(false) // Resolve-style full height mode
  
  // Panel sizes (in pixels)
  const [leftPanelWidth, setLeftPanelWidth] = useState(280) // Content panel width (icon bar is 48px additional)
  const [inspectorWidth, setInspectorWidth] = useState(256) // Content panel width (icon bar is 48px additional)
  const [timelineHeight, setTimelineHeight] = useState(320) // Default: enough room for track headers; persisted in localStorage
  // Editor layout preset: 'default' | 'vertical' (tall preview column on the
  // left — made for 9:16 work).
  const [editorLayout, setEditorLayout] = useState('default')
  const [verticalPreviewWidth, setVerticalPreviewWidth] = useState(420)

  // Min/max constraints
  const ICON_BAR_WIDTH = 48 // Fixed icon toolbar width
  const MIN_LEFT_PANEL = 200 // Content panel min
  const MAX_LEFT_PANEL = 900 // Content panel max
  const MIN_INSPECTOR = 200 // Content panel min
  const MAX_INSPECTOR = 800 // Content panel max
  const MIN_TIMELINE = 180 // Accounts for transport controls (40px) + minimum timeline
  const MAX_TIMELINE = 900
  const MIN_VERTICAL_PREVIEW = 280
  const MAX_VERTICAL_PREVIEW = 1200

  const LAYOUT_STORAGE_KEY = 'comfystudio-editor-layout'
  const [comfyIframeUrl, setComfyIframeUrl] = useState(() => getLocalComfyHttpBaseSync())
  // Bumped to force-remount the ComfyUI iframe (e.g. when the user clicks the
  // reload button in the tab header). Necessary because the iframe is kept
  // mounted across tab switches to preserve queue/progress state, but that
  // means a failed initial load (WS handshake timed out, extension JS crashed,
  // ComfyUI was briefly down during our own restart) leaves it stuck on a
  // black canvas with no in-app way to recover.
  const [comfyIframeNonce, setComfyIframeNonce] = useState(0)
  const reloadComfyIframe = useCallback(() => {
    setComfyIframeNonce((n) => n + 1)
  }, [])
  const [comfySaveState, setComfySaveState] = useState({ phase: 'idle', name: '', message: '', error: '' })
  const capturedComfyGraphRef = useRef(null)
  const comfySaveNameInputRef = useRef(null)
  // Focus + select ONCE when the naming field opens (autoFocus alone loses
  // the focus race against the cross-origin ComfyUI iframe). Doing this per
  // render would re-select on every keystroke and eat the typed text.
  useEffect(() => {
    if (comfySaveState.phase !== 'naming') return undefined
    const timer = setTimeout(() => {
      try {
        comfySaveNameInputRef.current?.focus()
        comfySaveNameInputRef.current?.select()
      } catch { /* best effort */ }
    }, 50)
    return () => clearTimeout(timer)
  }, [comfySaveState.phase])
  const handleStartSaveComfyGraph = useCallback(async () => {
    setComfySaveState((prev) => (prev.phase === 'idle' ? { phase: 'busy', name: '', message: '', error: '' } : prev))
    try {
      const { captureCurrentComfyGraph } = await import('./services/customWorkflowLibrary')
      const captured = await captureCurrentComfyGraph()
      capturedComfyGraphRef.current = captured
      // The cross-origin ComfyUI iframe holds keyboard focus hostage (OOPIF
      // quirk): reclaim it explicitly or the name input won't take keystrokes.
      try { document.querySelector('iframe[title="ComfyUI"]')?.blur() } catch { /* best effort */ }
      await window.electronAPI?.focusRendererWindow?.()
      window.focus()
      // ComfyUI's tab rename is unreliable, so naming happens here: prefill
      // with whatever ComfyUI calls the workflow and let the user fix it.
      setComfySaveState({ phase: 'naming', name: String(captured.workflowName || '').trim(), message: '', error: '' })
    } catch (error) {
      setComfySaveState({
        phase: 'idle',
        name: '',
        message: '',
        error: error instanceof Error ? error.message : 'Could not capture the workflow.',
      })
    }
  }, [])
  // `choice` is undefined on the first press of Save. If a workflow of that name exists, the person is asked once:
  // 'replace' overwrites it in place, 'both' saves a second one as before.
  const handleConfirmSaveComfyGraph = useCallback(async (choice) => {
    const captured = capturedComfyGraphRef.current
    const existing = comfySaveState.existing
    setComfySaveState((prev) => ({ ...prev, phase: 'busy' }))
    try {
      const { saveCapturedGraphToLibrary, findCustomLibraryWorkflowsByTitle } = await import('./services/customWorkflowLibrary')
      if (choice !== 'replace' && choice !== 'both') {
        const same = await findCustomLibraryWorkflowsByTitle(comfySaveState.name || captured?.workflowName)
        if (same.length) {
          const { isSharedInGpuSharing } = await import('./services/workflowLibrary')
          const shared = await isSharedInGpuSharing(`my-workflow:${same[0].id}`)
          setComfySaveState((prev) => ({ ...prev, phase: 'exists', existing: { id: same[0].id, title: same[0].title, count: same.length, shared }, error: '', message: '' }))
          return
        }
      }
      const result = await saveCapturedGraphToLibrary(captured, comfySaveState.name, choice === 'replace' && existing ? { replaceId: existing.id } : {})
      capturedComfyGraphRef.current = null
      setComfySaveState({
        phase: 'idle',
        name: '',
        message: `${result.updated ? 'Replaced' : 'Saved'} "${result.entry.title}" — find it in My Workflows.${result.updated && existing?.shared ? ' It is no longer shared in GPU sharing: add it there again.' : ''}`,
        error: '',
      })
    } catch (error) {
      setComfySaveState((prev) => ({
        ...prev,
        phase: 'naming',
        message: '',
        error: error instanceof Error ? error.message : 'Could not save the workflow.',
      }))
    }
  }, [comfySaveState.name, comfySaveState.existing])
  const handleCancelSaveComfyGraph = useCallback(() => {
    capturedComfyGraphRef.current = null
    setComfySaveState({ phase: 'idle', name: '', message: '', error: '' })
  }, [])
  const openComfyExternal = useCallback(() => {
    const url = comfyIframeUrl || getLocalComfyHttpBaseSync()
    if (!url) return
    if (window?.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url).catch(() => {})
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [comfyIframeUrl])

  useEffect(() => {
    let cancelled = false
    hydrateLocalComfyConnection().then((config) => {
      if (!cancelled && config?.httpBase) {
        setComfyIframeUrl(config.httpBase)
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    const handler = (event) => {
      const next = event?.detail?.httpBase || getLocalComfyHttpBaseSync()
      setComfyIframeUrl(next)
    }
    window.addEventListener(COMFY_CONNECTION_CHANGED_EVENT, handler)
    return () => window.removeEventListener(COMFY_CONNECTION_CHANGED_EVENT, handler)
  }, [])

  // Bridge ComfyUI websocket events (generation start/progress/complete/
  // error) into the launcher log viewer. This makes the "Running" chip's
  // log tail actually useful during a generation: the user sees the same
  // kind of information they'd see in the native ComfyUI terminal window.
  useEffect(() => {
    const stop = startComfyLauncherEventBridge()
    return () => { try { stop?.() } catch (_) { /* ignore */ } }
  }, [])

  useEffect(() => {
    const stop = startMcpSnapshotPublisher()
    return () => { try { stop?.() } catch (_) { /* ignore */ } }
  }, [])

  // Track unsaved changes so autosave can skip the full save path (project
  // serialization + thumbnail capture + disk writes) when nothing changed.
  useEffect(() => {
    const stop = attachProjectDirtyWatchers({
      timelineStore: useTimelineStore,
      assetsStore: useAssetsStore,
      projectStore: useProjectStore,
    })
    return () => { try { stop?.() } catch (_) { /* ignore */ } }
  }, [])

  useEffect(() => {
    const stop = startMcpActionBridge()
    return () => { try { stop?.() } catch (_) { /* ignore */ } }
  }, [MCP_ACTION_BRIDGE_VERSION])

  // Native run tracking is independent of the mounted workspace.
  useEffect(() => startGenerationRuns(), [])

  useLayoutEffect(() => {
    const previousTab = mainTabRef.current
    mainTabRef.current = mainTab
    if ((previousTab === 'editor' || previousTab === 'export') && previousTab !== mainTab) {
      try {
        useTimelineStore.getState().shuttlePause?.()
        videoCache.clear()
      } catch (_) {
        // Run before the newly visible preview's passive effects acquire
        // decoders; clearing later could dispose its freshly mounted media.
      }
    }
  }, [mainTab])

  // Auto-import outputs from custom workflows run while the embedded
  // ComfyUI tab is active. Managed Generate jobs use their own import path.
  useEffect(() => {
    const stop = startComfyAutoImport({
      shouldImportUnmanagedPrompt: () => mainTabRef.current === 'comfyui',
    })
    return () => { try { stop?.() } catch (_) { /* ignore */ } }
  }, [])

  // ComfyUI's own Download button for a missing model: the frame asks, Velorn
  // saves the file into the right models folder (electron/comfyModelDownload.cjs).
  useEffect(() => {
    const onMessage = async (event) => {
      const data = event.data
      if (!data || data.source !== 'velorn-comfy-frame' || data.type !== 'download-model') return
      const frame = document.querySelector('iframe[title="ComfyUI"]')
      if (!frame || event.source !== frame.contentWindow) return
      let answer = null
      try {
        answer = await window.electronAPI?.comfyModelDownload?.({ url: data.url, name: data.name, directory: data.directory })
      } catch (error) {
        answer = { success: false, error: error?.message }
      }
      try {
        event.source.postMessage({
          source: 'velorn-host', type: 'download-model-answer', id: data.id,
          ok: Boolean(answer?.success), error: answer?.error || (answer ? '' : 'Model downloads need the Velorn desktop app.'),
        }, '*')
      } catch { /* the frame was reloaded meanwhile */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window?.electronAPI?.onDownloadProgress : null
    if (typeof subscribe !== 'function') return undefined
    const clearDismissTimer = (id) => {
      const timer = downloadDismissTimersRef.current.get(id)
      if (timer) clearTimeout(timer)
      downloadDismissTimersRef.current.delete(id)
    }
    const unsubscribe = subscribe((payload) => {
      if (!payload?.id) return
      clearDismissTimer(payload.id)
      setDownloadProgressItems((current) => {
        const withoutCurrent = current.filter((item) => item.id !== payload.id)
        return [...withoutCurrent, payload].slice(-4)
      })
      if (payload.done) {
        const timer = setTimeout(() => {
          setDownloadProgressItems((current) => current.filter((item) => item.id !== payload.id))
          downloadDismissTimersRef.current.delete(payload.id)
        }, payload.state === 'completed' ? 5000 : 8000)
        downloadDismissTimersRef.current.set(payload.id, timer)
      }
    })
    return () => {
      unsubscribe?.()
      downloadDismissTimersRef.current.forEach((timer) => clearTimeout(timer))
      downloadDismissTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const setPointerModality = () => {
      document.documentElement.dataset.inputModality = 'pointer'
    }

    const setKeyboardModality = (event) => {
      if (event.key === 'Tab') {
        document.documentElement.dataset.inputModality = 'keyboard'
      }
    }

    document.documentElement.dataset.inputModality = 'pointer'
    window.addEventListener('pointerdown', setPointerModality, true)
    window.addEventListener('keydown', setKeyboardModality, true)
    return () => {
      window.removeEventListener('pointerdown', setPointerModality, true)
      window.removeEventListener('keydown', setKeyboardModality, true)
    }
  }, [])

  // Flow AI used to mount immediately after project-open even while its tab was
  // hidden. That means a runtime error in Flow AI could black out the whole app
  // during project selection. Lazy-mount it on first visit so hidden-tab
  // failures cannot take down the main editor.
  useEffect(() => {
    if (mainTab === 'flow-ai') {
      setHasMountedFlowAi(true)
    }
  }, [mainTab])

  useEffect(() => {
    let cancelled = false
    hydrateShowDiscoverTab().then((show) => {
      if (!cancelled) setShowDiscoverTabState(show)
    }).catch(() => {})

    const handleVisibilityChanged = (event) => {
      setShowDiscoverTabState(event?.detail?.show !== false)
    }
    window.addEventListener(DISCOVER_TAB_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged)
    return () => {
      cancelled = true
      window.removeEventListener(DISCOVER_TAB_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged)
    }
  }, [])

  useEffect(() => {
    if (!showDiscoverTab && mainTab === 'discover') {
      setMainTab('editor')
    }
  }, [mainTab, showDiscoverTab])

  // A tab hidden in Settings while it is open: go back to the Editor. Buttons
  // elsewhere that open a hidden tab (Share my GPU, Open Stock) still work.
  const hiddenTopTabs = useHiddenTopTabs()
  const openTabRef = useRef(mainTab)
  openTabRef.current = mainTab
  useEffect(() => {
    if (hiddenTopTabs.includes(openTabRef.current)) setMainTab('editor')
  }, [hiddenTopTabs])

  useEffect(() => {
    const handler = () => setMainTab('stock')
    window.addEventListener(VELORN_OPEN_STOCK_EVENT, handler)
    return () => window.removeEventListener(VELORN_OPEN_STOCK_EVENT, handler)
  }, [])

  // Reveal-in-assets (timeline clip menu / Shift+F): make sure the Assets
  // panel is actually visible — editor tab, left panel expanded, Assets tab.
  // AssetsPanel handles the rest (folder, selection, scroll, flash).
  useEffect(() => {
    const handler = () => {
      setMainTab('editor')
      setLeftPanelTab('assets')
      setLeftPanelExpanded(true)
    }
    window.addEventListener('comfystudio-reveal-asset', handler)
    return () => window.removeEventListener('comfystudio-reveal-asset', handler)
  }, [])

  // Allow Generate tab to open ComfyUI directly (used for workflow import guidance).
  useEffect(() => {
    const handler = () => {
      setMainTab('comfyui')
    }
    window.addEventListener('comfystudio-open-comfyui-tab', handler)
    return () => window.removeEventListener('comfystudio-open-comfyui-tab', handler)
  }, [])

  // Load persisted layout on mount (single read)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  useEffect(() => {
    if (layoutLoaded) return
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved.timelineHeight === 'number' && saved.timelineHeight >= MIN_TIMELINE && saved.timelineHeight <= MAX_TIMELINE) {
          setTimelineHeight(saved.timelineHeight)
        }
        if (typeof saved.leftPanelWidth === 'number' && saved.leftPanelWidth >= MIN_LEFT_PANEL && saved.leftPanelWidth <= MAX_LEFT_PANEL) {
          setLeftPanelWidth(saved.leftPanelWidth)
        }
        if (typeof saved.inspectorWidth === 'number' && saved.inspectorWidth >= MIN_INSPECTOR && saved.inspectorWidth <= MAX_INSPECTOR) {
          setInspectorWidth(saved.inspectorWidth)
        }
        if (typeof saved.leftPanelExpanded === 'boolean') setLeftPanelExpanded(saved.leftPanelExpanded)
        if (typeof saved.inspectorExpanded === 'boolean') setInspectorExpanded(saved.inspectorExpanded)
        if (typeof saved.leftPanelFullHeight === 'boolean') setLeftPanelFullHeight(saved.leftPanelFullHeight)
        if (typeof saved.inspectorFullHeight === 'boolean') setInspectorFullHeight(saved.inspectorFullHeight)
        if (saved.editorLayout === 'default' || saved.editorLayout === 'vertical') {
          setEditorLayout(saved.editorLayout)
        }
        if (typeof saved.verticalPreviewWidth === 'number' && saved.verticalPreviewWidth >= MIN_VERTICAL_PREVIEW && saved.verticalPreviewWidth <= MAX_VERTICAL_PREVIEW) {
          setVerticalPreviewWidth(saved.verticalPreviewWidth)
        }
      }
    } catch (_) { /* ignore */ }
    setLayoutLoaded(true)
  }, [layoutLoaded])

  const persistLayout = useCallback((updates) => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
      const prev = raw ? JSON.parse(raw) : {}
      const next = { ...prev, ...updates }
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next))
    } catch (_) { /* ignore */ }
  }, [])

  const [hasOpenedCreate, setHasOpenedCreate] = useState(false)
  useEffect(() => { if (mainTab === 'create') setHasOpenedCreate(true) }, [mainTab])
  const [hasOpenedSound, setHasOpenedSound] = useState(false)
  useEffect(() => { if (mainTab === 'sound') setHasOpenedSound(true) }, [mainTab])
  const [hasOpenedGpuSharing, setHasOpenedGpuSharing] = useState(false)
  const [gpuShareAsk, setGpuShareAsk] = useState(0) // counts requests to show the owner's side of the GPU sharing tab
  useEffect(() => { if (mainTab === 'gpu-sharing') setHasOpenedGpuSharing(true) }, [mainTab])
  const isFullScreenTab = mainTab === 'storyboard' || mainTab === 'export' || mainTab === 'generate' || mainTab === 'create' || mainTab === 'sound' || mainTab === 'agent' || mainTab === 'flow-ai' || mainTab === 'mog' || mainTab === 'llm-assistant' || mainTab === 'stock' || mainTab === 'gpu-sharing' || mainTab === 'comfyui'
  // Editor layout insets used by the editor content shell.
  const editorLeftInset = leftPanelExpanded ? ICON_BAR_WIDTH + leftPanelWidth : ICON_BAR_WIDTH
  const editorRightInset = inspectorExpanded ? ICON_BAR_WIDTH + inspectorWidth : ICON_BAR_WIDTH
  const leftSidebarWidth = isFullScreenTab ? 0 : editorLeftInset
  const rightSidebarWidth = isFullScreenTab ? 0 : editorRightInset
  
  // Project state
  const {
    currentProject,
    defaultProjectsLocation,
    initialize,
    isLoading,
    saveProject,
    autoSaveEnabled,
    autoSaveInterval,
  } = useProjectStore()
  const projectSessionKey = currentProject
    ? (currentProject.created || currentProject.name || 'project')
    : 'no-project'
  const agentProjectHandle = useProjectStore(state => state.currentProjectHandle)
  const agentProjectKey = getStoryboardProjectKey(currentProject, agentProjectHandle)
  useLayoutEffect(() => { setAgentHighlightShotIds([]); setAgentRevealShotId(null) }, [agentProjectKey, isLoading])
  useEffect(() => {
    if (mainTab !== 'storyboard' || !agentRevealShotId) return
    let cancelled = false, timer
    let attempts = 0
    const reveal = () => {
      if (cancelled) return
      const card = [...(agentWorkspaceRef.current?.querySelectorAll('[data-shot-id]') || [])]
        .find(element => element.dataset.shotId === agentRevealShotId)
      if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); setAgentRevealShotId(null) }
      else if (++attempts < 20) timer = setTimeout(reveal, 100)
    }
    reveal()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [mainTab, agentRevealShotId])
  const mediaPreparation = useAssetsStore((state) => state.mediaPreparation)
  const mediaPreparationTotal = Math.max(0, Number(mediaPreparation?.total) || 0)
  const mediaPreparationCompleted = Math.max(0, Math.min(mediaPreparationTotal, Number(mediaPreparation?.completed) || 0))
  const mediaPreparationPercent = mediaPreparationTotal > 0
    ? Math.round((mediaPreparationCompleted / mediaPreparationTotal) * 100)
    : 0
  const showMediaPreparation = Boolean(mediaPreparation?.active && mediaPreparationTotal > 0)
  const visibleDownloadProgressItems = downloadProgressItems.filter(Boolean)
  
  // Initialize project store on mount
  useEffect(() => {
    initialize()
  }, [initialize])
  
  // Auto-save functionality. Saves only when something actually changed —
  // the save path serializes the whole project and captures a playhead
  // thumbnail, which is far too heavy to run on a fixed timer at idle. The
  // backstop save caps worst-case loss if a mutation ever slips past the
  // dirty tracker (e.g. an in-place edit that keeps the same reference).
  useEffect(() => {
    if (!currentProject || !autoSaveEnabled) return

    const AUTOSAVE_BACKSTOP_MS = 5 * 60 * 1000
    const autoSaveTimer = setInterval(() => {
      if (isExportBusy()) return
      const lastSavedAt = Date.parse(useProjectStore.getState().lastAutoSave || '') || 0
      const overdue = Date.now() - lastSavedAt > AUTOSAVE_BACKSTOP_MS
      const dirty = isProjectDirty()
      if (!dirty && !overdue) return
      saveProject()
      console.log(dirty ? 'Auto-saved project' : 'Auto-saved project (backstop)')
    }, autoSaveInterval)

    return () => clearInterval(autoSaveTimer)
  }, [currentProject, autoSaveEnabled, autoSaveInterval, saveProject])
  
  // Await saving before native close; retain browser/reload fallback.
  useEffect(() => registerDesktopClose({
    api: window.electronAPI,
    getProjectState: () => useProjectStore.getState(),
  }), [])

  // Resize handlers
  const handleLeftPanelResize = useCallback((clientX) => {
    // In the vertical layout the preview column sits left of the panel, so
    // the panel's left edge is offset by that column (plus its resize handle).
    const layoutOffset = editorLayout === 'vertical' ? verticalPreviewWidth + 4 : 0
    const contentWidth = clientX - layoutOffset - ICON_BAR_WIDTH
    const newWidth = Math.min(MAX_LEFT_PANEL, Math.max(MIN_LEFT_PANEL, contentWidth))
    setLeftPanelWidth(newWidth)
    persistLayout({ leftPanelWidth: newWidth })
  }, [persistLayout, editorLayout, verticalPreviewWidth])

  const handleInspectorResize = useCallback((clientX) => {
    const contentWidth = window.innerWidth - clientX - ICON_BAR_WIDTH
    const newWidth = Math.min(MAX_INSPECTOR, Math.max(MIN_INSPECTOR, contentWidth))
    setInspectorWidth(newWidth)
    persistLayout({ inspectorWidth: newWidth })
  }, [persistLayout])

  const handleTimelineResize = useCallback((clientY) => {
    const newHeight = Math.min(MAX_TIMELINE, Math.max(MIN_TIMELINE, window.innerHeight - clientY))
    setTimelineHeight(newHeight)
    persistLayout({ timelineHeight: newHeight })
  }, [persistLayout])

  const handleEditorLayoutChange = useCallback((mode) => {
    if (mode !== 'default' && mode !== 'vertical') return
    setEditorLayout(mode)
    persistLayout({ editorLayout: mode })
  }, [persistLayout])

  const handleVerticalPreviewResize = useCallback((clientX) => {
    const newWidth = Math.min(MAX_VERTICAL_PREVIEW, Math.max(MIN_VERTICAL_PREVIEW, clientX))
    setVerticalPreviewWidth(newWidth)
    persistLayout({ verticalPreviewWidth: newWidth })
  }, [persistLayout])

  const handleToggleLeftPanelExpanded = useCallback(() => {
    setLeftPanelExpanded(prev => {
      const next = !prev
      persistLayout({ leftPanelExpanded: next })
      return next
    })
  }, [persistLayout])

  const handleToggleInspectorExpanded = useCallback(() => {
    if (mainTab !== 'editor' && rightPanelTab !== 'agent') {
      setRightPanelTab('agent')
      setInspectorExpanded(true)
      persistLayout({ inspectorExpanded: true })
      return
    }
    setInspectorExpanded(prev => {
      const next = !prev
      persistLayout({ inspectorExpanded: next })
      return next
    })
  }, [persistLayout, mainTab, rightPanelTab])

  const handleRightPanelTabClick = useCallback((tab) => {
    if (isExportBusy() || (tab === 'inspector' && mainTab !== 'editor')) return
    if (rightPanelTab === tab && inspectorExpanded) {
      handleToggleInspectorExpanded()
    } else {
      setRightPanelTab(tab)
      setInspectorExpanded(true)
      persistLayout({ inspectorExpanded: true })
    }
  }, [mainTab, rightPanelTab, inspectorExpanded, persistLayout, handleToggleInspectorExpanded])

  const handleRevealInspector = useCallback(() => {
    setRightPanelTab('inspector')
    setInspectorExpanded(true)
    persistLayout({ inspectorExpanded: true })
  }, [persistLayout])

  const handleUseWorkflowWithAgent = useCallback(entry => {
    const before = useProjectStore.getState()
    const key = getStoryboardProjectKey(before.currentProject, before.currentProjectHandle)
    const epoch = workflowLibraryEpoch.current
    return stageWorkflowInAgent(entry, {
      handlerRef: workflowReferenceRef,
      reveal: () => { setRightPanelTab('agent'); setInspectorExpanded(true); persistLayout({ inspectorExpanded: true }) },
      isCurrent: () => {
        const current = useProjectStore.getState()
        return epoch === workflowLibraryEpoch.current && !isExportBusy() && !current.isLoading && Boolean(current.currentProject)
          && current.currentProjectHandle === before.currentProjectHandle
          && getStoryboardProjectKey(current.currentProject, current.currentProjectHandle) === key
      },
    })
  }, [persistLayout])

  const handleToggleLeftPanelFullHeight = useCallback(() => {
    setLeftPanelFullHeight(prev => {
      const next = !prev
      persistLayout({ leftPanelFullHeight: next })
      return next
    })
  }, [persistLayout])

  const handleToggleInspectorFullHeight = useCallback(() => {
    setInspectorFullHeight(prev => {
      const next = !prev
      persistLayout({ inspectorFullHeight: next })
      return next
    })
  }, [persistLayout])

  // Both sides full height can't coexist in the vertical layout (the center
  // column would be dead space above the timeline) — the left panel wins and
  // the inspector regains full height when the left panel drops it.
  const inspectorFullHeightActive = inspectorFullHeight && !(editorLayout === 'vertical' && leftPanelFullHeight)
  const rightPanelExpanded = inspectorExpanded && (mainTab === 'editor' || rightPanelTab === 'agent')
  const agentVisible = rightPanelExpanded && rightPanelTab === 'agent'

  const handleActiveTimelineToolChange = useCallback((label) => {
    setActiveTimelineToolLabel(label || 'Move tool')
  }, [])

  const closeGettingStarted = useCallback(() => {
    setGettingStartedOpen(false)
  }, [])

  const openSettingsModal = useCallback((section = null) => {
    setSettingsInitialSection(section)
    setSettingsModalOpen(true)
  }, [])

  // Other parts of the window (the account drop-down) can ask for a Settings page by name.
  useEffect(() => {
    // GPU sharing has its own tab now; a request for its old Settings page goes there.
    const open = event => { if (isExportBusy()) return; if (event.detail === 'network') { setSettingsModalOpen(false); setMainTab('gpu-sharing'); setGpuShareAsk(count => count + 1) } else openSettingsModal(typeof event.detail === 'string' ? event.detail : null) }
    window.addEventListener('velorn:open-settings', open)
    return () => window.removeEventListener('velorn:open-settings', open)
  }, [openSettingsModal])

  const handleOpenSettingsFromBottomBar = useCallback(() => {
    setMainTab('editor')
    openSettingsModal()
  }, [openSettingsModal])

  const handleOpenGettingStarted = useCallback(() => {
    setGettingStartedOpen(true)
  }, [])

  const handleNavigateFromGettingStarted = useCallback((tabId) => {
    setMainTab(tabId)
    closeGettingStarted()
  }, [closeGettingStarted])

  const handleOpenSettingsFromGettingStarted = useCallback((section = null) => {
    openSettingsModal(section)
    closeGettingStarted()
  }, [closeGettingStarted, openSettingsModal])

  // Show welcome screen if no project is open
  if (!currentProject) {
    return <><div inert={exportBusy ? '' : undefined}><WelcomeScreen /></div><ExportProgressOverlay /></>
  }

  return (
    <div className="relative h-screen flex flex-col bg-sf-dark-950 no-select">
      {/* Title Bar */}
      <TitleBar
        projectName={currentProject?.name || 'Untitled'}
        activeTab={mainTab}
        onTabChange={selectTab}
        showStoryboardTab={showStoryboardTab}
        showGenerateTab={showGenerateTab}
        showDiscoverTab={showDiscoverTab}
        hiddenTabs={hiddenTopTabs}
        editorLayout={editorLayout}
        onEditorLayoutChange={handleEditorLayoutChange}
        exportBusy={exportBusy}
      />

      <div className="contents" inert={exportBusy ? '' : undefined} aria-hidden={exportBusy ? true : undefined}>

      {showMediaPreparation && (
        <div className="pointer-events-none fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-sf-dark-600 bg-sf-dark-900/95 px-3 py-2 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sf-accent" />
            <span className="font-medium text-sf-text-primary">
              {mediaPreparation?.critical ? 'Opening project media' : 'Preparing project media'}
            </span>
            <span className="ml-auto font-mono text-[10px] text-sf-text-muted">
              {mediaPreparationCompleted}/{mediaPreparationTotal}
            </span>
          </div>
          <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-sf-dark-700">
            <div
              className="h-full rounded-full bg-sf-accent transition-[width] duration-200"
              style={{ width: `${mediaPreparationPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 text-[10px] text-sf-text-muted">
            <span>{mediaPreparation?.label || 'Preparing media...'}</span>
            <span>{mediaPreparationPercent}%</span>
          </div>
        </div>
      )}

      {visibleDownloadProgressItems.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(420px,calc(100vw-32px))] flex-col gap-2">
          {visibleDownloadProgressItems.map((item) => {
            const isCompleted = item.state === 'completed'
            const isCancelled = item.state === 'cancelled'
            const isInterrupted = item.state === 'interrupted'
            const percent = typeof item.percent === 'number' ? Math.max(0, Math.min(100, item.percent)) : null
            const progressLabel = percent !== null
              ? `${percent}%`
              : `${formatDownloadBytes(item.receivedBytes)} downloaded`
            const detail = item.totalBytes > 0
              ? `${formatDownloadBytes(item.receivedBytes)} / ${formatDownloadBytes(item.totalBytes)}`
              : formatDownloadBytes(item.receivedBytes)
            return (
              <div
                key={item.id}
                className="rounded-xl border border-sf-dark-600 bg-sf-dark-900/95 p-3 shadow-2xl shadow-black/40 backdrop-blur"
              >
                <div className="mb-2 flex items-start gap-2 text-xs">
                  {!item.done && <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-sf-accent" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sf-text-primary">
                      {isCompleted ? 'Download complete' : isCancelled ? 'Download cancelled' : isInterrupted ? 'Download interrupted' : 'Downloading'}
                    </div>
                    <div className="truncate text-[10px] text-sf-text-muted" title={item.filename}>
                      {item.filename || 'File download'}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-sf-text-muted">{progressLabel}</span>
                </div>
                <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-sf-dark-700">
                  <div
                    className={`h-full rounded-full transition-[width] duration-200 ${isCompleted ? 'bg-green-500' : isCancelled || isInterrupted ? 'bg-red-500' : 'bg-sf-accent'} ${percent === null && !item.done ? 'animate-pulse' : ''}`}
                    style={{ width: `${percent ?? 100}%` }}
                  />
                </div>
                <div className="truncate text-[10px] text-sf-text-muted" title={item.savePath}>
                  {detail}
                </div>
              </div>
            )
          })}
        </div>
      )}
      
      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden min-h-0">
      <div className="flex-1 flex overflow-hidden min-h-0 min-w-0">
        {/* ComfyUI tab – kept mounted when visible so iframe does not reload */}
        <div
          className="flex-1 flex flex-col min-h-0 min-w-0 bg-sf-dark-950"
          style={{ display: mainTab === 'comfyui' ? 'flex' : 'none' }}
        >
          {/* Thin toolbar: the embedded ComfyUI iframe has no browser chrome,
              so when it gets into a stuck state (blank/black canvas from a
              failed WS handshake, a crashed extension, or ComfyUI restarting
              under it) the user has no way to recover from inside the app.
              Reload remounts the iframe; Open-external pops it in the system
              browser as a fallback diagnostic. */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-sf-dark-700 bg-sf-dark-900 text-xs text-sf-text-muted flex-shrink-0">
            <span>Local ComfyUI</span><span className="min-w-0 max-w-full font-mono truncate">{comfyIframeUrl || '—'}</span>
            {(comfySaveState.message || comfySaveState.error) && (
              <span className={`min-w-0 max-w-[min(420px,100%)] truncate ${comfySaveState.error ? 'text-sf-error' : 'text-emerald-300'}`}>
                {comfySaveState.error || comfySaveState.message}
              </span>
            )}
            <div className="flex-1" />
            {comfySaveState.phase === 'exists' ? (
              <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 text-sf-text-secondary" role="group" aria-label="A workflow with this name exists">
                <span className="min-w-0">You already have “{comfySaveState.existing?.title}”{comfySaveState.existing?.count > 1 ? ` (${comfySaveState.existing.count} of them)` : ''}.{comfySaveState.existing?.shared ? ' It is shared in GPU sharing; replacing it stops that until you add it again.' : ''}</span>
                <button type="button" onClick={() => { void handleConfirmSaveComfyGraph('replace') }} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sf-accent/15 text-sf-accent hover:bg-sf-accent/25 transition-colors">{comfySaveState.existing?.count > 1 ? 'Replace the newest' : 'Replace it'}</button>
                <button type="button" onClick={() => { void handleConfirmSaveComfyGraph('both') }} className="px-2 py-1 rounded hover:bg-sf-dark-700 hover:text-sf-text-primary transition-colors">Keep both</button>
                <button type="button" onClick={handleCancelSaveComfyGraph} className="px-2 py-1 rounded hover:bg-sf-dark-700 hover:text-sf-text-primary transition-colors">Cancel</button>
              </span>
            ) : comfySaveState.phase === 'naming' ? (
              <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
                <input
                  type="text"
                  value={comfySaveState.name}
                  onChange={(event) => setComfySaveState((prev) => ({ ...prev, name: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleConfirmSaveComfyGraph()
                    if (event.key === 'Escape') handleCancelSaveComfyGraph()
                  }}
                  ref={comfySaveNameInputRef}
                  autoFocus
                  placeholder="Workflow name"
                  className="w-56 min-w-0 max-w-full rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1 text-xs text-sf-text-primary outline-none placeholder:text-sf-text-muted focus:border-sf-accent"
                />
                <button
                  type="button"
                  onClick={() => { void handleConfirmSaveComfyGraph() }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sf-accent/15 text-sf-accent hover:bg-sf-accent/25 transition-colors"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleCancelSaveComfyGraph}
                  className="px-2 py-1 rounded hover:bg-sf-dark-700 hover:text-sf-text-primary transition-colors"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={handleStartSaveComfyGraph}
                disabled={comfySaveState.phase === 'busy'}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                  comfySaveState.phase === 'busy'
                    ? 'cursor-not-allowed text-sf-text-muted'
                    : 'bg-sf-accent/15 text-sf-accent hover:bg-sf-accent/25'
                }`}
                title="Save a copy of the current workflow in My Workflows, to reopen it or use it with your agent"
              >
                {comfySaveState.phase === 'busy' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookmarkPlus className="w-3.5 h-3.5" />}
                Save workflow
              </button>
            )}
            <button type="button" onClick={() => setWorkflowLibraryOpen(true)} disabled={exportBusy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-sf-dark-700 hover:text-sf-text-primary transition-colors"
              title="Browse saved workflows and add one to your agent chat">
              <Library className="w-3.5 h-3.5" /> My Workflows
            </button>
            <button
              type="button"
              onClick={reloadComfyIframe}
              className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-sf-dark-700 hover:text-sf-text-primary transition-colors"
              title="Reload the ComfyUI iframe (useful if it's stuck on a black screen)"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload
            </button>
            <button
              type="button"
              onClick={openComfyExternal}
              className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-sf-dark-700 hover:text-sf-text-primary transition-colors"
              title="Open ComfyUI in your default browser"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in browser
            </button>
          </div>
          <iframe
            key={`comfy-iframe-${comfyIframeUrl}-${comfyIframeNonce}`}
            src={comfyIframeUrl}
            title="ComfyUI"
            className="flex-1 w-full min-h-0 border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          />
        </div>
        {/* Generate stays mounted after first use so its existing jobs survive
            tab switches and hiding the tab. Older MCP adapters can still
            mount its listeners in the background through the open event. */}
        {hasMountedGenerate && (
          <div
            className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950"
            style={{ display: mainTab === 'generate' ? 'flex' : 'none' }}
          >
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <GenerateWorkspace
                  key={`generate-workspace-${projectSessionKey}`}
                  onOpenWorkflowSetup={() => openSettingsModal(WORKFLOW_SETUP_SECTION_ID)}
                />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        )}
        {hasMountedFlowAi && (
          <div
            className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950"
            style={{ display: mainTab === 'flow-ai' ? 'flex' : 'none' }}
          >
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <FlowAIWorkspace onOpenWorkflowSetup={() => openSettingsModal(WORKFLOW_SETUP_SECTION_ID)} />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        )}
        {/* Sound tab - the same screen as Create, making voice, music and effects */}
        {(mainTab === 'sound' || hasOpenedSound) && (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950" style={{ display: mainTab === 'sound' ? 'flex' : 'none' }}>
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <CreateWorkspace mode="sound" />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        )}
        {/* Create tab - kept mounted once opened so a request in progress survives tab switches */}
        {(mainTab === 'create' || hasOpenedCreate) && (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950" style={{ display: mainTab === 'create' ? 'flex' : 'none' }}>
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <CreateWorkspace />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        )}
        {mainTab === 'mog' && (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950">
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <MOGWorkspace />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        )}
        {/* Export tab - keep mounted so settings, queue, and progress survive tab switches */}
        <div
          className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950"
          style={{ display: mainTab === 'export' ? 'flex' : 'none' }}
        >
          <ExportPanel active={mainTab === 'export'} />
        </div>
        {mainTab === 'storyboard' && (
          <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden" data-workspace="storyboard">
          <div ref={agentWorkspaceRef} className="flex-1 min-w-0 min-h-0 overflow-hidden">
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <ProductionWorkspace workspace onBackToEditor={() => selectTab('editor')} highlightShotIds={agentHighlightShotIds} />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
          </div>
        )}
        {mainTab === "stock" && (
          <WorkspaceErrorBoundary>
            <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
              <StockPanel />
            </Suspense>
          </WorkspaceErrorBoundary>
        )}
        {/* GPU sharing tab - kept mounted once opened, like Create, so a job being made survives tab switches */}
        {(mainTab === 'gpu-sharing' || hasOpenedGpuSharing) && (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-sf-dark-950" style={{ display: mainTab === 'gpu-sharing' ? 'flex' : 'none' }}>
            <WorkspaceErrorBoundary>
              <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
                <GpuSharingWorkspace openShare={gpuShareAsk} />
              </Suspense>
            </WorkspaceErrorBoundary>
          </div>
        )}
        {mainTab === 'discover' && showDiscoverTab && (
          <WorkspaceErrorBoundary>
            <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
              <DiscoverWorkspace />
            </Suspense>
          </WorkspaceErrorBoundary>
        )}
        {mainTab === "agent" && (
          <WorkspaceErrorBoundary>
            <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
              <AgentWorkspace />
            </Suspense>
          </WorkspaceErrorBoundary>
        )}
        {/* Editor tab: unmount when hidden so video/canvas preview resources are released before Generate opens. */}
        {mainTab === "editor" && (
        <div
          className="flex-1 flex min-h-0 overflow-hidden bg-sf-dark-950"
        >
          <>
            {/* Vertical layout: full-height preview column on the far left
                (9:16 work), with the transport directly under the viewer. */}
            {editorLayout === 'vertical' && (
              <>
                <div style={{ width: verticalPreviewWidth }} className="flex-shrink-0 flex flex-col min-h-0">
                  <div ref={agentWorkspaceRef} className="flex-1 min-h-0">
                    <PreviewPanel />
                  </div>
                  <div className="flex-shrink-0 flex items-center justify-center py-1 border-t border-sf-dark-700">
                    <TransportControls />
                  </div>
                </div>
                <ResizeHandle
                  direction="horizontal"
                  onResize={handleVerticalPreviewResize}
                />
              </>
            )}
            {/* Left Panel - Full Height Mode (spans entire left side) */}
            {leftPanelFullHeight && (
              <>
                <div 
                  style={{ width: leftPanelExpanded ? ICON_BAR_WIDTH + leftPanelWidth : ICON_BAR_WIDTH }} 
                  className="flex-shrink-0 transition-[width] duration-200 ease-out h-full"
                >
                  <LeftPanel 
                    isActive={mainTab === 'editor'}
                    isExpanded={leftPanelExpanded}
                    onToggleExpanded={handleToggleLeftPanelExpanded}
                    activeTab={leftPanelTab}
                    onTabChange={setLeftPanelTab}
                    isFullHeight={true}
                    onToggleFullHeight={handleToggleLeftPanelFullHeight}
                    onSettingsClick={() => setSettingsModalOpen(true)}
                  />
                </div>
                {/* Resize Handle for full-height left panel */}
                {leftPanelExpanded && (
                  <ResizeHandle 
                    direction="horizontal" 
                    onResize={handleLeftPanelResize}
                  />
                )}
              </>
            )}
            
            {/* Right Side Content (Preview + Inspector + Timeline) */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Upper Content Area - Preview + Inspector */}
              <div className="flex-1 flex overflow-hidden min-h-0">
                {/* Left Panel - Normal Mode (only in upper area). In the
                    vertical layout the preview leaves this row, so an expanded
                    panel stretches to use the freed width. */}
                {!leftPanelFullHeight && (
                  <>
                    <div
                      style={editorLayout === 'vertical' && leftPanelExpanded
                        ? undefined
                        : { width: leftPanelExpanded ? ICON_BAR_WIDTH + leftPanelWidth : ICON_BAR_WIDTH }}
                      className={`${editorLayout === 'vertical' && leftPanelExpanded ? 'flex-1 min-w-0' : 'flex-shrink-0'} transition-[width] duration-200 ease-out`}
                    >
                      <LeftPanel
                        isActive={mainTab === 'editor'}
                        isExpanded={leftPanelExpanded}
                        onToggleExpanded={handleToggleLeftPanelExpanded}
                        activeTab={leftPanelTab}
                        onTabChange={setLeftPanelTab}
                        isFullHeight={false}
                        onToggleFullHeight={handleToggleLeftPanelFullHeight}
                        onSettingsClick={() => setSettingsModalOpen(true)}
                      />
                    </div>
                    {/* Resize Handle - Left Panel (fixed width layouts only) */}
                    {leftPanelExpanded && editorLayout !== 'vertical' && (
                      <ResizeHandle
                        direction="horizontal"
                        onResize={handleLeftPanelResize}
                      />
                    )}
                    {editorLayout === 'vertical' && !leftPanelExpanded && (
                      <div className="flex-1 min-w-0" />
                    )}
                  </>
                )}

                {/* Center - Preview (in the vertical layout it lives in the
                    dedicated left column instead) */}
                {editorLayout !== 'vertical' && (
                  <div ref={agentWorkspaceRef} className="flex-1 min-w-0">
                    <PreviewPanel />
                  </div>
                )}

                {/* Vertical + full-height panel: keep the inspector pinned right */}
                {editorLayout === 'vertical' && leftPanelFullHeight && (
                  <div className="flex-1 min-w-0" />
                )}

                {/* Inspector - Normal Mode (only in upper area) */}
                {!inspectorFullHeightActive && (
                  <>
                    {/* Resize Handle - Inspector (only when expanded) */}
                    {inspectorExpanded && (
                      <ResizeHandle
                        direction="horizontal"
                        onResize={handleInspectorResize}
                      />
                    )}

                    {/* One shared right sidebar: Inspector or Agent. */}
                    <div
                      ref={rightPanelHostRef}
                      style={{ width: inspectorExpanded ? inspectorWidth + ICON_BAR_WIDTH : ICON_BAR_WIDTH }}
                      className="flex-shrink-0 transition-[width] duration-200 ease-out"
                    />
                  </>
                )}
              </div>
              
              {/* Resize Handle - Timeline */}
              <ResizeHandle
                direction="vertical"
                onResize={handleTimelineResize}
              />

              {/* Bottom Section - Transport (centered to viewer) + Timeline */}
              <div style={{ height: timelineHeight }} className="flex-shrink-0 w-full flex flex-col min-h-0">
                {/* Transport row - same columns as Preview row so play button
                    is centered under viewer. The vertical layout renders the
                    transport inside the preview column instead. */}
                {editorLayout !== 'vertical' && (
                <div className="flex-shrink-0 w-full flex min-h-0">
                  {!leftPanelFullHeight && (
                    <div
                      style={{ width: leftPanelExpanded ? ICON_BAR_WIDTH + leftPanelWidth : ICON_BAR_WIDTH }}
                      className="flex-shrink-0 transition-[width] duration-200 ease-out"
                      aria-hidden
                    />
                  )}
                  <div className="flex-1 min-w-0 flex items-center justify-center">
                    <TransportControls />
                  </div>
                  {!inspectorFullHeightActive && (
                    <div
                      style={{ width: inspectorExpanded ? inspectorWidth + ICON_BAR_WIDTH : ICON_BAR_WIDTH }}
                      className="flex-shrink-0 transition-[width] duration-200 ease-out"
                      aria-hidden
                    />
                  )}
                </div>
                )}
                {/* Bottom editor view switcher */}
                <div className="flex-shrink-0 h-7 px-2 bg-sf-dark-900 border-y border-sf-dark-700 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setBottomEditorView('timeline')}
                      className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                        bottomEditorView === 'timeline'
                          ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/40'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title="Clip and track editing view"
                    >
                      Timeline
                    </button>
                    <button
                      onClick={() => setBottomEditorView('dopesheet')}
                      className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                        bottomEditorView === 'dopesheet'
                          ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/40'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title="Property keyframe editing view"
                    >
                      Dope Sheet
                    </button>
                    <button
                      onClick={() => setBottomEditorView('mixer')}
                      className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                        bottomEditorView === 'mixer'
                          ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/40'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title="Audio mixer: track faders, mute/solo, meters, master"
                    >
                      Mixer
                    </button>
                    <button
                      onClick={() => setBottomEditorView('scopes')}
                      className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                        bottomEditorView === 'scopes'
                          ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/40'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title="Video scopes: luma waveform, RGB parade, vectorscope"
                    >
                      Scopes
                    </button>
                  </div>
                  <span className="text-[10px] text-sf-text-muted">
                    {bottomEditorView === 'timeline'
                      ? `${timelineStatusText ? `${timelineStatusText} · ` : ''}Timeline · ${activeTimelineToolLabel}`
                      : bottomEditorView === 'mixer'
                        ? 'Audio mixer'
                        : bottomEditorView === 'scopes'
                          ? 'Video scopes'
                          : 'Keyframe edit mode'}
                  </span>
                </div>
                {/* Selected bottom editor view - takes remaining height */}
                <div className="flex-1 min-h-0">
                  {bottomEditorView === 'timeline' ? (
                    <Timeline
                      onActiveToolChange={handleActiveTimelineToolChange}
                      onStatusChange={setTimelineStatusText}
                    />
                  ) : bottomEditorView === 'mixer' ? (
                    <MixerPanel />
                  ) : bottomEditorView === 'scopes' ? (
                    <ScopesPanel />
                  ) : (
                    <DopeSheet />
                  )}
                </div>
              </div>
            </div>

            {/* Inspector - Full Height Mode (spans entire right side) */}
            {inspectorFullHeightActive && (
              <>
                {/* Resize Handle for full-height inspector */}
                {inspectorExpanded && (
                  <ResizeHandle
                    direction="horizontal"
                    onResize={handleInspectorResize}
                  />
                )}
                <div
                  ref={rightPanelHostRef}
                  style={{ width: inspectorExpanded ? inspectorWidth + ICON_BAR_WIDTH : ICON_BAR_WIDTH }}
                  className="flex-shrink-0 transition-[width] duration-200 ease-out h-full"
                />
              </>
            )}
          </>
        </div>
        )}
      </div>

      {/* Every non-editor workspace shares a full-height Agent slot. The editor
          keeps its normal/full-height slots; RightPanelDock moves its existing
          DOM between them without remounting the conversation. */}
      {mainTab !== 'editor' && <>
        {rightPanelExpanded && <ResizeHandle direction="horizontal" onResize={handleInspectorResize} />}
        <div ref={rightPanelHostRef}
          style={{ width: rightPanelExpanded ? inspectorWidth + ICON_BAR_WIDTH : ICON_BAR_WIDTH, maxWidth: '60vw' }}
          className="flex-shrink-0 min-h-0 transition-[width] duration-200 ease-out" />
      </>}
      
      <RightPanelDock hostRef={rightPanelHostRef} activeTab={rightPanelTab} isExpanded={rightPanelExpanded}
        keepAgentMounted={accountAgentRequested}
        onTabClick={handleRightPanelTabClick} onToggleExpanded={handleToggleInspectorExpanded}
        isFullHeight={mainTab !== 'editor' || inspectorFullHeightActive}
        onToggleFullHeight={handleToggleInspectorFullHeight}
        fullHeightDisabled={mainTab !== 'editor' || (editorLayout === 'vertical' && leftPanelFullHeight)}
        inspectorAvailable={mainTab === 'editor'}
        inspector={mainTab === 'editor' ? <InspectorPanel embedded
          isExpanded={rightPanelExpanded && rightPanelTab === 'inspector'} onToggleExpanded={handleRevealInspector} /> : null}
        agent={<WorkspaceErrorBoundary><Suspense fallback={null}>
          <ConnectedAgentPanel docked visible={agentVisible} activeTab={mainTab} workspaceRef={agentWorkspaceRef} modelPickerRequest={agentModelPickerRequest}
            onOpenEditor={() => { if (!isExportBusy()) setMainTab('editor') }}
            workflowReferenceRef={workflowReferenceRef}
            onHighlight={setAgentHighlightShotIds}
            onShowShot={shotId => {
              if (isExportBusy()) return
              setAgentHighlightShotIds([shotId]); setAgentRevealShotId(shotId); openStoryboard()
            }} />
        </Suspense></WorkspaceErrorBoundary>} />
      </div>
      {/* Bottom bar: settings menu + undo/redo */}
      <BottomBar
        projectName={currentProject?.name}
        onOpenSettings={handleOpenSettingsFromBottomBar}
        onOpenGettingStarted={handleOpenGettingStarted}
        onOpenStoryboard={openStoryboard}
      />

      {/* Settings Modal */}
      {workflowLibraryOpen && <Suspense fallback={WORKSPACE_LOADING_FALLBACK}>
        <WorkflowLibraryDrawer open onClose={closeWorkflowLibrary}
          onUseWithAgent={handleUseWorkflowWithAgent} disabled={exportBusy} />
      </Suspense>}
      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={() => {
          setSettingsModalOpen(false)
          setSettingsInitialSection(null)
        }}
        initialSection={settingsInitialSection}
        onChooseAgentModel={() => {
          setSettingsModalOpen(false); setSettingsInitialSection(null)
          setRightPanelTab('agent'); setInspectorExpanded(true)
          setAgentModelPickerRequest(value => value + 1)
        }}
      />
      <GettingStartedModal
        isOpen={gettingStartedOpen}
        onClose={closeGettingStarted}
        projectName={currentProject?.name}
        defaultProjectsLocation={defaultProjectsLocation}
        onOpenSettings={handleOpenSettingsFromGettingStarted}
        onNavigate={handleNavigateFromGettingStarted}
      />
      </div>
      <ExportProgressOverlay />
    </div>
  )
}

export default function App() {
  const hasProject = useProjectStore(state => Boolean(state.currentProject) && !state.isLoading)
  const [accountAgentRequested, setAccountAgentRequested] = useState(false)
  const requestAccountAgent = useCallback(() => setAccountAgentRequested(true), [])
  return <DesktopAccountProvider hasProject={hasProject} onRequestAgent={requestAccountAgent}>
    <AppWorkspace accountAgentRequested={accountAgentRequested} />
    <AgentComfyCloudSetup />
    <PhoneCreateSaver />
    <VelornNetworkSaver />
  </DesktopAccountProvider>
}
