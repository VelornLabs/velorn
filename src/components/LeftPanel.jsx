import { useState } from 'react'
import { 
  FolderOpen, Settings, Type, SlidersHorizontal,
  ChevronLeft, ChevronRight, PanelLeftClose, PanelLeft
} from 'lucide-react'
import AssetsPanel from './panels/AssetsPanel'
import TextPanel from './panels/TextPanel'
import EffectsPanel from './panels/EffectsPanel'

function LeftPanel({ isActive = true, isExpanded, onToggleExpanded, activeTab, onTabChange, isFullHeight = false, onToggleFullHeight, onSettingsClick }) {
  const tabs = [
    { id: 'assets', label: 'Assets', icon: FolderOpen },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'effects', label: 'Effects', icon: SlidersHorizontal },
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  const handleTabClick = (tabId) => {
    if (tabId === 'settings' && onSettingsClick) {
      onSettingsClick()
      return
    }
    if (activeTab === tabId && isExpanded) {
      // Clicking active tab when expanded -> collapse
      onToggleExpanded()
    } else if (!isExpanded) {
      // Clicking any tab when collapsed -> expand and switch
      onToggleExpanded()
      onTabChange(tabId)
    } else {
      // Clicking different tab when expanded -> just switch
      onTabChange(tabId)
    }
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'text':
        return <TextPanel />
      case 'effects':
        return <EffectsPanel />
      case 'assets':
        return <AssetsPanel isActive={isActive} />
      default:
        return <AssetsPanel isActive={isActive} />
    }
  }

  return (
    <div className="h-full flex">
      {/* Icon Toolbar - Always Visible */}
      <div className="w-12 flex-shrink-0 bg-sf-dark-950 border-r border-sf-dark-700 flex flex-col">
        {/* Tab Icons */}
        <div className="flex-1 flex flex-col pt-2">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id && isExpanded
            
            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className={`w-full h-11 flex items-center justify-center transition-all relative group ${
                  isActive
                    ? 'text-sf-accent bg-sf-dark-800'
                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50'
                }`}
                title={tab.label}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-sf-accent rounded-r" />
                )}
                <Icon className="w-5 h-5" />
                
                {/* Tooltip */}
                <div className="absolute left-full ml-2 px-2 py-1 bg-sf-dark-700 text-sf-text-primary text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                  {tab.label}
                </div>
              </button>
            )
          })}
        </div>
        
        {/* Bottom buttons */}
        <div className="border-t border-sf-dark-700">
          {/* Full Height Toggle Button */}
          <button
            onClick={onToggleFullHeight}
            className={`w-full h-10 flex items-center justify-center transition-colors ${
              isFullHeight 
                ? 'text-sf-accent bg-sf-dark-800' 
                : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50'
            }`}
            title={isFullHeight ? 'Contract panel (exit full height)' : 'Expand panel (full height)'}
          >
            {isFullHeight ? (
              <PanelLeftClose className="w-4 h-4" />
            ) : (
              <PanelLeft className="w-4 h-4" />
            )}
          </button>
          
          {/* Collapse/Expand Button */}
          <button
            onClick={onToggleExpanded}
            className="w-full h-10 flex items-center justify-center text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50 transition-colors"
            title={isExpanded ? 'Collapse panel' : 'Expand panel'}
          >
            {isExpanded ? (
              <ChevronLeft className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
      
      {/* Content Panel - Collapsible */}
      {isExpanded && (
        <div className="flex-1 bg-sf-dark-900 border-r border-sf-dark-700 flex flex-col min-w-0 overflow-hidden">
          {/* Panel Header */}
          <div className="flex-shrink-0 h-9 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center px-3">
            <span className="text-xs font-medium text-sf-text-primary">
              {tabs.find(t => t.id === activeTab)?.label}
            </span>
          </div>
          
          {/* Panel Content */}
          <div className="flex-1 overflow-hidden min-w-0">
            {renderContent()}
          </div>
        </div>
      )}
    </div>
  )
}

export default LeftPanel
