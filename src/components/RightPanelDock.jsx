import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, MessageSquare, PanelRight, PanelRightClose, SlidersHorizontal } from 'lucide-react'

// The slot moves between Editor (normal/full-height) and all other workspaces. Reparent
// one owned portal container instead of changing createPortal's target, which
// would remount the conversation and discard drafts or pending responses.
export default function RightPanelDock({ hostRef, activeTab = 'inspector', isExpanded,
  onTabClick, onToggleExpanded, isFullHeight, onToggleFullHeight,
  fullHeightDisabled = false, inspectorAvailable = true, inspector, agent, keepAgentMounted = false }) {
  const [container] = useState(() => document.createElement('div'))
  const [hasOpenedAgent, setHasOpenedAgent] = useState(false)
  useEffect(() => {
    let disposed = false
    // A previously enabled phone needs a fresh conversation publication after
    // startup even when the user leaves the Agent panel collapsed.
    void window.electronAPI?.mobileCompanion?.getPreference?.().then(result => {
      if (!disposed && result?.success && result.enabled) setHasOpenedAgent(true)
    }).catch(() => {})
    return () => { disposed = true }
  }, [])
  const showAgent = isExpanded && activeTab === 'agent'
  const showInspector = isExpanded && activeTab === 'inspector' && inspectorAvailable
  useLayoutEffect(() => {
    container.className = 'h-full min-h-0 min-w-0'
    if (hostRef.current && container.parentNode !== hostRef.current) hostRef.current.appendChild(container)
    else if (!hostRef.current) container.remove()
    if (showAgent && !hasOpenedAgent) setHasOpenedAgent(true)
  })
  useLayoutEffect(() => () => container.remove(), [container])

  return createPortal(<div className="h-full flex min-h-0 min-w-0" data-testid="right-panel-dock">
    <div className="flex-1 min-w-0 min-h-0" style={{ display: showInspector ? 'block' : 'none' }}
      inert={!showInspector ? '' : undefined} aria-hidden={!showInspector}>
      {inspector}
    </div>
    <div className="flex-1 min-w-0 min-h-0" style={{ display: showAgent ? 'flex' : 'none' }}
      inert={!showAgent ? '' : undefined} aria-hidden={!showAgent}>
      {(hasOpenedAgent || showAgent || keepAgentMounted) && agent}
    </div>
    <div className="w-12 flex-shrink-0 bg-sf-dark-950 border-l border-sf-dark-700 flex flex-col" aria-label="Right panel tools">
      <div className="flex-1 flex flex-col pt-2">
        {[...(inspectorAvailable ? [{ id: 'inspector', label: 'Inspector', Icon: SlidersHorizontal }] : []),
          { id: 'agent', label: 'Assistant', Icon: MessageSquare }].map(({ id, label, Icon }) => {
          const selected = id === 'agent' ? showAgent : showInspector
          return <button key={id} type="button" onClick={() => onTabClick(id)} title={label}
            aria-label={label} aria-pressed={selected}
            className={`w-full h-11 flex items-center justify-center transition-all relative group ${selected ? 'text-sf-accent bg-sf-dark-800' : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50'}`}>
            {selected && <span className="absolute right-0 top-1 bottom-1 w-0.5 bg-sf-accent rounded-l" />}
            <Icon className="w-5 h-5" />
            <span className="absolute right-full mr-2 px-2 py-1 bg-sf-dark-700 text-sf-text-primary text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">{label}</span>
          </button>
        })}
      </div>
      <div className="border-t border-sf-dark-700">
        {inspectorAvailable && <button type="button" onClick={onToggleFullHeight} disabled={fullHeightDisabled}
          aria-label={isFullHeight ? 'Restore right panel height' : 'Expand right panel to full height'}
          title={fullHeightDisabled ? 'Full-height layout is unavailable in this workspace' : isFullHeight ? 'Restore right panel height' : 'Expand right panel to full height'}
          className={`w-full h-10 flex items-center justify-center transition-colors ${fullHeightDisabled ? 'text-sf-text-muted opacity-40 cursor-default' : isFullHeight ? 'text-sf-accent bg-sf-dark-800' : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50'}`}>
          {isFullHeight ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
        </button>}
        <button type="button" onClick={onToggleExpanded}
          aria-label={isExpanded ? 'Collapse right panel' : 'Expand right panel'} title={isExpanded ? 'Collapse right panel' : 'Expand right panel'}
          className="w-full h-10 flex items-center justify-center text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50 transition-colors">
          {isExpanded ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </div>
  </div>, container)
}
