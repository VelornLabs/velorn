import {
  Palette, Languages, Volume2, Film, Keyboard, HardDrive, Trash2, FolderOpen,
  Play, Monitor, Plug, Cloud, Image, Wrench, Bot, Cpu,
} from 'lucide-react'
import './SettingsSectionTabs.css'

const SECTION_ICONS = {
  appearance: Palette, language: Languages, notifications: Volume2,
  editor: Film, hotkeys: Keyboard, storage: HardDrive, assets: Trash2,
  paths: FolderOpen, cache: Play, ffmpeg: Monitor, comfy: Plug,
  cloud: Cloud, stock: Image, 'workflow-setup': Wrench, agents: Bot, network: Cpu,
}

export default function SettingsSectionTabs({ pages, activeId, onSelect, label, hint }) {
  const handleKeyDown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')]
    const index = tabs.indexOf(event.currentTarget)
    let nextIndex
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else if (event.key === 'ArrowRight') nextIndex = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length
    else return
    event.preventDefault()
    event.stopPropagation()
    onSelect(pages[nextIndex].id)
    tabs[nextIndex].focus()
  }

  return (
    <div className="flex-shrink-0 border-b border-sf-dark-600 bg-sf-dark-950/50 px-5 pt-3 pb-4">
      <p className="mb-2.5 text-xs font-medium text-sf-text-secondary">{hint}</p>
      <div role="tablist" aria-label={label} aria-orientation="horizontal" className="flex flex-wrap gap-2">
        {pages.map(page => {
          const active = page.id === activeId
          const Icon = SECTION_ICONS[page.id] || FolderOpen
          return (
            <button key={page.id} id={`settings-section-tab-${page.id}`} type="button" role="tab"
              aria-selected={active} aria-controls="settings-section-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(page.id)} onKeyDown={handleKeyDown}
              className={`settings-section-tab inline-flex min-h-[42px] max-w-full cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sf-dark-950 ${active
                ? 'border-sf-accent bg-sf-accent text-white'
                : 'border-sf-dark-500 bg-sf-dark-700 text-sf-text-primary hover:border-sf-accent hover:bg-sf-dark-600'}`}>
              <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words text-left">{page.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
