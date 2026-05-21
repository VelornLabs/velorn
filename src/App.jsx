import { useState, useCallback, useEffect, useRef } from 'react'
import { RefreshCw, ExternalLink, Loader2 } from 'lucide-react'
import TitleBar from './components/TitleBar'
import ExportPanel from './components/ExportPanel'
import GenerateWorkspace from './components/GenerateWorkspace'
import FlowAIWorkspace from './components/FlowAIWorkspace'
import LLMAssistantWorkspace from './components/LLMAssistantWorkspace'
import MOGWorkspace from './components/MOGWorkspace'
import StockPanel from './components/StockPanel'
import WorkspaceErrorBoundary from './components/WorkspaceErrorBoundary'
import LeftPanel from './components/LeftPanel'
import PreviewPanel from './components/PreviewPanel'
import Timeline from './components/Timeline'
import DopeSheet from './components/DopeSheet'
import TransportControls from './components/TransportControls'
import InspectorPanel from './components/InspectorPanel'
import ResizeHandle from './components/ResizeHandle'
import AudioGenerateModal from './components/AudioGenerateModal'
import SettingsModal from './components/SettingsModal'
import GettingStartedModal from './components/GettingStartedModal'
import WelcomeScreen from './components/WelcomeScreen'
import BottomBar from './components/BottomBar'
import useProjectStore from './stores/projectStore'
import useAssetsStore from './stores/assetsStore'
import useTimelineStore from './stores/timelineStore'
import videoCache from './services/videoCache'
import { WORKFLOW_SETUP_SECTION_ID } from './services/workflowSetupManager'
import {
  COMFY_CONNECTION_CHANGED_EVENT,
  getLocalComfyHttpBaseSync,
  hydrateLocalComfyConnection,
} from './services/localComfyConnection'
import { startComfyLauncherEventBridge } from './services/comfyLauncherEventBridge'
import { startComfyAutoImport } from './services/comfyAutoImport'

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

function App() {
  const [audioModalOpen, setAudioModalOpen] = useState(false)
  const [audioModalType, setAudioModalType] = useState('music')
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState(null)
  const [gettingStartedOpen, setGettingStartedOpen] = useState(false)
  const [selectedItem, setSelectedItem] = useState({ type: 'shot', id: '2.1' })
  const [mainTab, setMainTab] = useState('editor')
  const [hasMountedFlowAi, setHasMountedFlowAi] = useState(false)
  const [bottomEditorView, setBottomEditorView] = useState('timeline')
  const [activeTimelineToolLabel, setActiveTimelineToolLabel] = useState('Move tool')
  const [downloadProgressItems, setDownloadProgressItems] = useState([])
  const mainTabRef = useRef(mainTab)
  const downloadDismissTimersRef = useRef(new Map())
  
  // Left panel state
  const [leftPanelExpanded, setLeftPanelExpanded] = useState(true)
  const [leftPanelTab, setLeftPanelTab] = useState('assets')
  const [leftPanelFullHeight, setLeftPanelFullHeight] = useState(false) // Resolve-style full height mode
  
  // Right panel (Inspector) state
  const [inspectorExpanded, setInspectorExpanded] = useState(true)
  
  // Panel sizes (in pixels)
  const [leftPanelWidth, setLeftPanelWidth] = useState(280) // Content panel width (icon bar is 48px additional)
  const [inspectorWidth, setInspectorWidth] = useState(256) // Content panel width (icon bar is 48px additional)
  const [timelineHeight, setTimelineHeight] = useState(320) // Default: enough room for track headers; persisted in localStorage

  // Min/max constraints
  const ICON_BAR_WIDTH = 48 // Fixed icon toolbar width
  const MIN_LEFT_PANEL = 200 // Content panel min
  const MAX_LEFT_PANEL = 450 // Content panel max
  const MIN_INSPECTOR = 200 // Content panel min
  const MAX_INSPECTOR = 400 // Content panel max
  const MIN_TIMELINE = 180 // Accounts for transport controls (40px) + minimum timeline
  const MAX_TIMELINE = 450

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
    const previousTab = mainTabRef.current
    mainTabRef.current = mainTab
    if (previousTab === 'editor' && mainTab !== 'editor') {
      try {
        useTimelineStore.getState().shuttlePause?.()
        videoCache.clear()
      } catch (_) {
        // Best-effort release of hidden editor media resources.
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

  // When user sends timeline frame to Generate (right-click preview → Extend with AI / Starting keyframe for AI)
  useEffect(() => {
    const handler = () => setMainTab('generate')
    window.addEventListener('comfystudio-open-generate-with-frame', handler)
    return () => window.removeEventListener('comfystudio-open-generate-with-frame', handler)
  }, [])

  useEffect(() => {
    const handler = () => setMainTab('generate')
    window.addEventListener('comfystudio-open-generate-tab', handler)
    return () => window.removeEventListener('comfystudio-open-generate-tab', handler)
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

  const isFullScreenTab = mainTab === 'export' || mainTab === 'generate' || mainTab === 'flow-ai' || mainTab === 'mog' || mainTab === 'llm-assistant' || mainTab === 'stock' || mainTab === 'comfyui'
  // Editor layout insets (used for content when on Editor, and always for tab bar so it doesn't shift)
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
  
  // Auto-save functionality
  useEffect(() => {
    if (!currentProject || !autoSaveEnabled) return
    
    const autoSaveTimer = setInterval(() => {
      saveProject()
      console.log('Auto-saved project')
    }, autoSaveInterval)
    
    return () => clearInterval(autoSaveTimer)
  }, [currentProject, autoSaveEnabled, autoSaveInterval, saveProject])
  
  // Save on window close/refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (currentProject) {
        saveProject()
      }
    }
    
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [currentProject, saveProject])

  // Resize handlers
  const handleLeftPanelResize = useCallback((clientX) => {
    const contentWidth = clientX - ICON_BAR_WIDTH
    const newWidth = Math.min(MAX_LEFT_PANEL, Math.max(MIN_LEFT_PANEL, contentWidth))
    setLeftPanelWidth(newWidth)
    persistLayout({ leftPanelWidth: newWidth })
  }, [persistLayout])

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

  const handleToggleLeftPanelExpanded = useCallback(() => {
    setLeftPanelExpanded(prev => {
      const next = !prev
      persistLayout({ leftPanelExpanded: next })
      return next
    })
  }, [persistLayout])

  const handleToggleInspectorExpanded = useCallback(() => {
    setInspectorExpanded(prev => {
      const next = !prev
      persistLayout({ inspectorExpanded: next })
      return next
    })
  }, [persistLayout])

  const openAudioModal = (type = 'music') => {
    setAudioModalType(type)
    setAudioModalOpen(true)
  }

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
    return <WelcomeScreen />
  }

  return (
    <div className="relative h-screen flex flex-col bg-sf-dark-950 no-select">
      {/* Title Bar */}
      <TitleBar 
        projectName={currentProject?.name || 'Untitled'} 
        activeTab={mainTab}
        onTabChange={setMainTab}
        centerInsetLeft={editorLeftInset}
        centerInsetRight={editorRightInset}
      />

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
        {/* ComfyUI tab – kept mounted when visible so iframe does not reload */}
        <div
          className="flex-1 flex flex-col min-h-0 bg-sf-dark-950"
          style={{ display: mainTab === 'comfyui' ? 'flex' : 'none' }}
        >
          {/* Thin toolbar: the embedded ComfyUI iframe has no browser chrome,
              so when it gets into a stuck state (blank/black canvas from a
              failed WS handshake, a crashed extension, or ComfyUI restarting
              under it) the user has no way to recover from inside the app.
              Reload remounts the iframe; Open-external pops it in the system
              browser as a fallback diagnostic. */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-sf-dark-700 bg-sf-dark-900 text-xs text-sf-text-muted flex-shrink-0">
            <span className="font-mono truncate">{comfyIframeUrl || '—'}</span>
            <div className="flex-1" />
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
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
        </div>
        {/* Generate tab – keep mounted so queue/progress survives tab switches */}
        <div
          className="flex-1 flex flex-col min-h-0 overflow-hidden bg-sf-dark-950"
          style={{ display: mainTab === 'generate' ? 'flex' : 'none' }}
        >
          <GenerateWorkspace
            key={`generate-workspace-${projectSessionKey}`}
            onOpenWorkflowSetup={() => openSettingsModal(WORKFLOW_SETUP_SECTION_ID)}
          />
        </div>
        {hasMountedFlowAi && (
          <div
            className="flex-1 flex flex-col min-h-0 overflow-hidden bg-sf-dark-950"
            style={{ display: mainTab === 'flow-ai' ? 'flex' : 'none' }}
          >
            <WorkspaceErrorBoundary>
              <FlowAIWorkspace onOpenWorkflowSetup={() => openSettingsModal(WORKFLOW_SETUP_SECTION_ID)} />
            </WorkspaceErrorBoundary>
          </div>
        )}
        {mainTab === 'mog' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-sf-dark-950">
            <WorkspaceErrorBoundary>
              <MOGWorkspace />
            </WorkspaceErrorBoundary>
          </div>
        )}
        {/* Export tab - keep mounted so settings, queue, and progress survive tab switches */}
        <div
          className="flex-1 flex flex-col min-h-0 overflow-hidden bg-sf-dark-950"
          style={{ display: mainTab === 'export' ? 'flex' : 'none' }}
        >
          <ExportPanel />
        </div>
        {mainTab === "stock" && (
          <StockPanel />
        )}
        {mainTab === "llm-assistant" && (
          <LLMAssistantWorkspace />
        )}
        {/* Editor tab: unmount when hidden so video/canvas preview resources are released before Generate opens. */}
        {mainTab === "editor" && (
        <div
          className="flex-1 flex min-h-0 overflow-hidden bg-sf-dark-950"
        >
          <>
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
                    onToggleFullHeight={() => setLeftPanelFullHeight(false)}
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
                {/* Left Panel - Normal Mode (only in upper area) */}
                {!leftPanelFullHeight && (
                  <>
                    <div 
                      style={{ width: leftPanelExpanded ? ICON_BAR_WIDTH + leftPanelWidth : ICON_BAR_WIDTH }} 
                      className="flex-shrink-0 transition-[width] duration-200 ease-out"
                    >
                      <LeftPanel 
                        isActive={mainTab === 'editor'}
                        isExpanded={leftPanelExpanded}
                        onToggleExpanded={handleToggleLeftPanelExpanded}
                        activeTab={leftPanelTab}
                        onTabChange={setLeftPanelTab}
                        isFullHeight={false}
                        onToggleFullHeight={() => setLeftPanelFullHeight(true)}
                        onSettingsClick={() => setSettingsModalOpen(true)}
                      />
                    </div>
                    {/* Resize Handle - Left Panel (only when expanded) */}
                    {leftPanelExpanded && (
                      <ResizeHandle 
                        direction="horizontal" 
                        onResize={handleLeftPanelResize}
                      />
                    )}
                  </>
                )}
                
                {/* Center - Preview */}
                <div className="flex-1 min-w-0">
                  <PreviewPanel />
                </div>
                
                {/* Resize Handle - Inspector (only when expanded) */}
                {inspectorExpanded && (
                  <ResizeHandle 
                    direction="horizontal" 
                    onResize={handleInspectorResize}
                  />
                )}
                
                {/* Right Sidebar - Inspector with Icon Toolbar */}
                <div 
                  style={{ width: inspectorExpanded ? inspectorWidth + ICON_BAR_WIDTH : ICON_BAR_WIDTH }} 
                  className="flex-shrink-0 transition-[width] duration-200 ease-out"
                >
                  <InspectorPanel 
                    selectedItem={selectedItem}
                    isExpanded={inspectorExpanded}
                    onToggleExpanded={handleToggleInspectorExpanded}
                  />
                </div>
              </div>
              
              {/* Resize Handle - Timeline */}
              <ResizeHandle 
                direction="vertical" 
                onResize={handleTimelineResize}
              />
              
              {/* Bottom Section - Transport (centered to viewer) + Timeline */}
              <div style={{ height: timelineHeight }} className="flex-shrink-0 w-full flex flex-col min-h-0">
                {/* Transport row - same columns as Preview row so play button is centered under viewer */}
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
                  <div
                    style={{ width: inspectorExpanded ? inspectorWidth + ICON_BAR_WIDTH : ICON_BAR_WIDTH }}
                    className="flex-shrink-0 transition-[width] duration-200 ease-out"
                    aria-hidden
                  />
                </div>
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
                  </div>
                  <span className="text-[10px] text-sf-text-muted">
                    {bottomEditorView === 'timeline' ? `Timeline · ${activeTimelineToolLabel}` : 'Keyframe edit mode'}
                  </span>
                </div>
                {/* Selected bottom editor view - takes remaining height */}
                <div className="flex-1 min-h-0">
                  {bottomEditorView === 'timeline' ? (
                    <Timeline
                      onOpenAudioGenerate={openAudioModal}
                      onActiveToolChange={handleActiveTimelineToolChange}
                    />
                  ) : (
                    <DopeSheet />
                  )}
                </div>
              </div>
            </div>
          </>
        </div>
        )}
      </div>
      
      {/* Bottom bar: settings menu + undo/redo */}
      <BottomBar
        projectName={currentProject?.name}
        onOpenSettings={handleOpenSettingsFromBottomBar}
        onOpenGettingStarted={handleOpenGettingStarted}
      />

      {/* Audio Generate Modal */}
      <AudioGenerateModal 
        isOpen={audioModalOpen}
        onClose={() => setAudioModalOpen(false)}
        initialType={audioModalType}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={() => {
          setSettingsModalOpen(false)
          setSettingsInitialSection(null)
        }}
        initialSection={settingsInitialSection}
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
  )
}

export default App
