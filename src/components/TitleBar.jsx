import { Fragment, useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import ComfyLauncherChip from './ComfyLauncherChip'
import CreditsChip from './CreditsChip'

const TOP_TABS = [
  { id: 'editor', label: 'Editor' },
  { id: 'generate', label: 'Generate' },
  { id: 'flow-ai', label: 'Flow AI' },
  { id: 'mog', label: 'MoGraph' },
  { id: 'stock', label: 'Stock' },
  { id: 'comfyui', label: 'ComfyUI' },
  { id: 'export', label: 'Export' },
]

function TitleBar({
  projectName,
  activeTab = 'editor',
  onTabChange,
  centerInsetLeft = 0,
  centerInsetRight = 0,
}) {
  const tabs = TOP_TABS
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
    <div className="h-10 bg-black flex items-center justify-between px-4 drag-region relative">
      {/* Left - Spacer for center alignment */}
      <div className="w-[120px] flex-shrink-0" />
      
      {/* Center - App mode tabs; extend 1px into content so grey touches with no black line */}
      <div
        className="absolute top-0 flex items-center justify-center"
        style={{
          left: `${centerInsetLeft}px`,
          right: `${centerInsetRight}px`,
          bottom: -1,
          height: 'calc(100% + 1px)'
        }}
      >
        <div className="no-drag flex items-center gap-0 h-full bg-sf-dark-800 border-x border-sf-dark-700 border-t-0 rounded-none p-0.5">
          {tabs.map((tab, index) => (
            <Fragment key={tab.id}>
              {index > 0 && (
                <div className="w-px h-4 bg-sf-dark-600 flex-shrink-0" aria-hidden="true" />
              )}
              <div className="relative flex h-full items-center">
                <button
                  onClick={() => onTabChange?.(tab.id)}
                  className={`px-3 py-1 text-[11px] rounded-none transition-colors ${
                    activeTab === tab.id
                      ? 'bg-sf-accent text-white'
                      : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
                  }`}
                >
                  {tab.label}
                </button>
                {tab.id === 'mog' && activeTab === 'mog' && (
                  <div className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 rounded-full bg-pink-300/12 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-pink-200/65 shadow-[0_0_10px_rgba(244,114,182,0.12)]">
                    beta
                  </div>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      
      {/* Right - Launcher chip + Window Controls (Windows style) */}
      <div className="flex items-center">
        <CreditsChip size="xs" className="mr-1" />
        <ComfyLauncherChip />
        <button
          onClick={handleMinimize}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title="Minimize"
        >
          <Minus className="w-4 h-4 text-sf-text-secondary" />
        </button>
        <button
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
