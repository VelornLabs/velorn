import { Fragment, useEffect, useRef, useState } from 'react'
import { Copy, LayoutTemplate, Minus, PanelLeft, PlayCircle, Square, X } from 'lucide-react'
import ComfyLauncherChip from './ComfyLauncherChip'
import CreditsChip from './CreditsChip'
import GenerationMonitorChip from './GenerationMonitorChip'
import { DesktopAccountButton } from './DesktopAccount'
import { useI18n } from '../i18n/I18nContext'

const EDITOR_LAYOUTS = [
  { id: 'default', Icon: LayoutTemplate, label: 'Default layout' },
  { id: 'vertical', Icon: PanelLeft, label: 'Vertical layout — tall preview on the left, made for 9:16, 1:1, and other social formats' },
]

const TOP_TABS = [
  { id: 'storyboard', label: 'Storyboard' },
  { id: 'editor', label: 'Editor' },
  { id: 'generate', label: 'Director' },
  { id: 'create', label: 'Create' },
  { id: 'sound', label: 'Sound' },
  { id: 'agent', label: 'Agent' },
  { id: 'flow-ai', label: 'Flow AI' },
  { id: 'mog', label: 'MoGraph' },
  { id: 'stock', label: 'Stock' },
  { id: 'gpu-sharing', label: 'GPU sharing' },
  { id: 'comfyui', label: 'ComfyUI' },
  { id: 'export', label: 'Export' },
  { id: 'discover', label: 'Tutorials' },
]

const HIDDEN_TOP_TAB_IDS = new Set([
  'agent',
  'flow-ai',
  'mog',
])

function TitleBar({
  projectName,
  activeTab = 'editor',
  onTabChange,
  showGenerateTab = true,
  showDiscoverTab = true,
  showStoryboardTab = false,
  hiddenTabs = [],
  editorLayout = 'default',
  onEditorLayoutChange,
  exportBusy = false,
}) {
  const { t } = useI18n()
  const activeTabRef = useRef(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeTab, showStoryboardTab, showGenerateTab, showDiscoverTab])
  const tabs = TOP_TABS.filter((tab) => (
    !HIDDEN_TOP_TAB_IDS.has(tab.id)
    && (tab.id !== 'generate' || showGenerateTab)
    && (tab.id !== 'discover' || showDiscoverTab)
    && (tab.id !== 'storyboard' || showStoryboardTab)
    && !hiddenTabs.includes(tab.id)
  ))
  const [windowState, setWindowState] = useState({
    isMaximized: false,
    isFullScreen: false,
  })

  useEffect(() => {
    let mounted = true
    let unsubscribe = null

    const loadWindowState = async () => {
      try {
        const nextState = await window.electronAPI?.getWindowState?.()
        if (mounted && nextState) {
          setWindowState({
            isMaximized: Boolean(nextState.isMaximized),
            isFullScreen: Boolean(nextState.isFullScreen),
          })
        }
      } catch (_) {
        // Ignore missing Electron bridge/state fetch errors in non-Electron contexts.
      }
    }

    loadWindowState()

    unsubscribe = window.electronAPI?.onWindowStateChanged?.((nextState) => {
      if (!mounted || !nextState) return
      setWindowState({
        isMaximized: Boolean(nextState.isMaximized),
        isFullScreen: Boolean(nextState.isFullScreen),
      })
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [])

  const isRestoreDown = windowState.isMaximized || windowState.isFullScreen

  const handleMinimize = () => {
    window.electronAPI?.minimizeWindow?.()
  }

  const handleToggleMaximize = () => {
    window.electronAPI?.toggleMaximizeWindow?.()
  }

  const handleCloseWindow = () => {
    window.electronAPI?.closeWindow?.()
  }
  
  return (
    <div className="h-10 flex-shrink-0 bg-black flex items-center justify-between gap-2 px-4 drag-region relative">
      {/* Keep a window-drag target even when a narrow tab strip is full. */}
      <div className="w-8 2xl:w-[120px] h-full flex-shrink-0" aria-hidden="true" />
      
      {/* Center - App mode tabs; extend 1px into content so grey touches with no black line */}
      <div
        className="flex min-w-0 flex-1 items-center overflow-x-auto"
        style={{
          height: 'calc(100% + 1px)'
        }}
      >
        <nav
          className="no-drag mx-auto flex flex-shrink-0 items-center gap-0 h-full bg-sf-dark-800 border-x border-sf-dark-700 border-t-0 rounded-none p-0.5"
          aria-label={t('topTabs.navigation', undefined, 'Workspace modes')}
        >
          {tabs.map((tab, index) => (
            <Fragment key={tab.id}>
              {index > 0 && (
                <div
                  className={tab.id === 'discover'
                    ? 'mx-0.5 h-5 w-px flex-shrink-0 bg-sf-dark-500 2xl:mx-1.5'
                    : 'h-4 w-px flex-shrink-0 bg-sf-dark-600'}
                  aria-hidden="true"
                />
              )}
              <div className="relative flex h-full items-center">
                <button
                  ref={activeTab === tab.id ? activeTabRef : undefined}
                  onFocus={event => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
                  disabled={exportBusy}
                  onClick={() => onTabChange?.(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 text-[11px] transition-colors ${
                    tab.id === 'discover'
                      ? (activeTab === tab.id
                          ? 'rounded border border-sf-accent/70 bg-sf-accent/20 font-medium text-sf-text-primary'
                          : 'rounded border border-sf-dark-600 bg-sf-dark-900/70 text-sf-text-secondary hover:border-sf-dark-500 hover:bg-sf-dark-700 hover:text-sf-text-primary')
                      : (activeTab === tab.id
                          ? 'rounded-none bg-sf-accent text-white'
                          : 'rounded-none text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary')
                  }`}
                >
                  {tab.id === 'discover' && <PlayCircle className="hidden h-3.5 w-3.5 2xl:block" aria-hidden="true" />}
                  {tab.id === 'comfyui' ? tab.label : t(`topTabs.${tab.id}`, undefined, tab.label)}
                </button>
                {tab.id === 'mog' && activeTab === 'mog' && (
                  <div className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 rounded-full bg-pink-300/12 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-pink-200/65 shadow-[0_0_10px_rgba(244,114,182,0.12)]">
                    beta
                  </div>
                )}
              </div>
            </Fragment>
          ))}
        </nav>
      </div>
      
      {/* Right - Launcher chip + Window Controls (Windows style) */}
      <div className="no-drag flex flex-shrink-0 items-center">
        <div className="contents" inert={exportBusy ? '' : undefined} aria-hidden={exportBusy ? true : undefined}>
        {activeTab === 'editor' && onEditorLayoutChange && (
          <div className="mr-2 flex items-center gap-0.5 rounded bg-sf-dark-800 p-0.5">
            {EDITOR_LAYOUTS.map(({ id, Icon, label }) => (
              <button
                key={id}
                onClick={() => onEditorLayoutChange(id)}
                title={label}
                className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
                  editorLayout === id
                    ? 'bg-sf-accent/25 text-sf-accent'
                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>
        )}
        <CreditsChip size="xs" className="mr-1" />
        <GenerationMonitorChip onOpenGenerate={() => onTabChange?.('generate')} />
        <ComfyLauncherChip />
        <DesktopAccountButton disabled={exportBusy} />
        </div>
        <button
          data-export-allowed="true"
          onClick={handleMinimize}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title="Minimize"
        >
          <Minus className="w-4 h-4 text-sf-text-secondary" />
        </button>
        <button
          data-export-allowed="true"
          onClick={handleToggleMaximize}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title={isRestoreDown ? 'Restore Down' : 'Maximize'}
        >
          {isRestoreDown ? (
            <Copy className="w-3 h-3 text-sf-text-secondary" />
          ) : (
            <Square className="w-3 h-3 text-sf-text-secondary" />
          )}
        </button>
        <button
          data-export-allowed="true"
          onClick={handleCloseWindow}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-red-600 transition-colors"
          title="Close"
        >
          <X className="w-4 h-4 text-sf-text-secondary" />
        </button>
      </div>
    </div>
  )
}

export default TitleBar
