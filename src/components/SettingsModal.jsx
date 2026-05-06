import { useState, useEffect, useMemo } from 'react'
import {
  X, Server, FolderOpen, Palette, Monitor, Save,
  HardDrive, Film, Keyboard, Wrench, Power,
  KeyRound, CheckCircle2, ExternalLink,
} from 'lucide-react'
import useProjectStore, { RESOLUTION_PRESETS, FPS_PRESETS } from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import { THEMES, getStoredThemeId, applyTheme } from '../config/themes'
import { getPexelsApiKey, setPexelsApiKey } from '../services/pexelsSettings'
import WorkflowSetupSection from './WorkflowSetupSection'
import ComfyLauncherSettingsSection from './ComfyLauncherSettingsSection'
import ComfyLauncherLogViewer from './ComfyLauncherLogViewer'
import ApiKeyDialog from './ApiKeyDialog'
import {
  COMFY_PARTNER_KEY_CHANGED_EVENT,
  COMFY_PARTNER_WORKFLOWS,
  getComfyPartnerApiKey,
  openComfyPartnerDashboard,
} from '../services/comfyPartnerAuth'
import {
  DEFAULT_EDITOR_HOTKEYS,
  EDITOR_HOTKEY_DEFINITIONS,
  EDITOR_HOTKEY_PRESETS,
  formatEditorHotkey,
  getEditorHotkeys,
  getEditorHotkeyPresetMatch,
  hotkeyEventToBinding,
  isReservedEditorHotkeyBinding,
  setEditorHotkeys,
} from '../services/editorHotkeys'
import {
  DEFAULT_COMFY_PORT,
  checkLocalComfyConnection,
  getLocalComfyConnectionSync,
  hydrateLocalComfyConnection,
  parseLocalComfyPortInput,
  saveLocalComfyConnectionPort,
} from '../services/localComfyConnection'

const AUTO_IMPORT_KEY = 'comfystudio-auto-import-comfy-outputs'
const OUTPUT_DIRECTORY_SETTING_KEY = 'outputDirectory'
const WORKFLOWS_DIRECTORY_SETTING_KEY = 'workflowsDirectory'
const OUTPUT_DIRECTORY_PLACEHOLDER = 'C:\\Users\\...\\ComfyStudio\\outputs'
const WORKFLOWS_DIRECTORY_PLACEHOLDER = 'C:\\Users\\...\\ComfyUI\\workflow_API'

const SETTINGS_SECTIONS = [
  {
    id: 'storage',
    title: 'Projects & Storage',
    icon: HardDrive,
    description: 'Choose where projects live and control auto-save behavior.',
  },
  {
    id: 'stock',
    title: 'Stock (Pexels)',
    icon: Film,
    description: 'Manage stock-media search credentials.',
  },
  {
    id: 'connection',
    title: 'ComfyUI Connection',
    icon: Server,
    description: 'Configure the local ComfyUI endpoint, partner API key, and advanced tab visibility.',
  },
  {
    id: 'launcher',
    title: 'ComfyUI Launcher',
    icon: Power,
    description: 'Let ComfyStudio start, stop, and restart your local ComfyUI process.',
  },
  {
    id: 'paths',
    title: 'File Paths',
    icon: FolderOpen,
    description: 'Review output and workflow path settings.',
  },
  {
    id: 'workflow-setup',
    title: 'Workflow Setup',
    icon: Wrench,
    description: 'Scan workflows, review missing dependencies, and install curated models or node packs.',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    icon: Palette,
    description: 'Pick the editor theme that best fits your workspace.',
  },
  {
    id: 'hotkeys',
    title: 'Hotkeys',
    icon: Keyboard,
    description: 'Customize editor shortcuts and apply familiar keymap presets.',
  },
  {
    id: 'project',
    title: 'New Project Defaults',
    icon: Monitor,
    description: 'Set default resolution and frame rate for new projects.',
  },
]

function isValidSection(sectionId) {
  return SETTINGS_SECTIONS.some((section) => section.id === sectionId)
}

function resolveInitialSection(sectionId) {
  return isValidSection(sectionId) ? sectionId : SETTINGS_SECTIONS[0].id
}

function SettingsRailItem({ section, isActive, onSelect }) {
  const Icon = section.icon

  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
        isActive
          ? 'border-sf-accent/40 bg-sf-accent/10 text-sf-text-primary'
          : 'border-transparent text-sf-text-secondary hover:border-sf-dark-700 hover:bg-sf-dark-800/70 hover:text-sf-text-primary'
      }`}
      aria-current={isActive ? 'page' : undefined}
    >
      <div className="flex items-center gap-3">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
          isActive ? 'bg-sf-accent/15 text-sf-accent' : 'bg-sf-dark-800 text-sf-text-muted'
        }`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{section.title}</div>
        </div>
      </div>
    </button>
  )
}

function GeneralTab({ initialSection = null }) {
  const initialComfyConnection = getLocalComfyConnectionSync()
  const [comfyPortInput, setComfyPortInput] = useState(String(initialComfyConnection.port || DEFAULT_COMFY_PORT))
  const [comfyConnectionState, setComfyConnectionState] = useState({
    status: 'idle',
    message: `Local endpoint: ${initialComfyConnection.httpBase}`,
  })
  const [outputPath, setOutputPath] = useState('')
  const [workflowPath, setWorkflowPath] = useState('')
  const [activeThemeId, setActiveThemeId] = useState(() => getStoredThemeId())
  const [pexelsApiKey, setPexelsApiKeyLocal] = useState('')
  const [comfyOrgApiKey, setComfyOrgApiKey] = useState('')
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [activeSection, setActiveSection] = useState(() => resolveInitialSection(initialSection))
  const [editorHotkeys, setEditorHotkeysState] = useState(DEFAULT_EDITOR_HOTKEYS)
  const [recordingHotkeyId, setRecordingHotkeyId] = useState(null)
  const [hotkeysError, setHotkeysError] = useState('')
  const [logViewerOpen, setLogViewerOpen] = useState(false)
  const currentHotkeyPresetId = useMemo(
    () => getEditorHotkeyPresetMatch(editorHotkeys),
    [editorHotkeys]
  )

  const [autoImportComfyOutputs, setAutoImportComfyOutputs] = useState(() => {
    try {
      const stored = localStorage.getItem(AUTO_IMPORT_KEY)
      if (stored === null) return true // default ON
      return stored === 'true'
    } catch {
      return true
    }
  })

  const {
    defaultProjectsLocation,
    selectDefaultProjectsLocation,
    autoSaveEnabled,
    setAutoSaveEnabled,
    reopenLastProjectOnStartup,
    setReopenLastProjectOnStartup,
    showHeroBackground,
    setShowHeroBackground,
    currentProject,
    closeProject,
    defaultResolution,
    defaultFps,
    setDefaultProjectSettings,
  } = useProjectStore()
  const showTimelineClipThumbnails = useTimelineStore((state) => state.showTimelineClipThumbnails)
  const setShowTimelineClipThumbnails = useTimelineStore((state) => state.setShowTimelineClipThumbnails)

  useEffect(() => {
    getPexelsApiKey().then((key) => setPexelsApiKeyLocal(key || ''))
    ;(async () => {
      try {
        const [storedOutputPath, storedWorkflowPath] = await Promise.all([
          window.electronAPI?.getSetting?.(OUTPUT_DIRECTORY_SETTING_KEY),
          window.electronAPI?.getSetting?.(WORKFLOWS_DIRECTORY_SETTING_KEY),
        ])
        setOutputPath(String(storedOutputPath || ''))
        setWorkflowPath(String(storedWorkflowPath || ''))
      } catch {
        setOutputPath('')
        setWorkflowPath('')
      }

      try {
        setEditorHotkeysState(await getEditorHotkeys())
      } catch {
        setEditorHotkeysState(DEFAULT_EDITOR_HOTKEYS)
      }

      try {
        const next = await getComfyPartnerApiKey()
        setComfyOrgApiKey(next)
      } catch {
        setComfyOrgApiKey('')
      }

      try {
        const connection = await hydrateLocalComfyConnection()
        setComfyPortInput(String(connection.port || DEFAULT_COMFY_PORT))
        setComfyConnectionState({
          status: 'idle',
          message: `Local endpoint: ${connection.httpBase}`,
        })
      } catch {
        setComfyConnectionState({
          status: 'error',
          message: `Could not load local ComfyUI port. Using ${DEFAULT_COMFY_PORT}.`,
        })
      }
    })()
  }, [])

  useEffect(() => {
    if (!recordingHotkeyId) return

    const handleKeyDown = (e) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRecordingHotkeyId(null)
        setHotkeysError('')
        return
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        setEditorHotkeysState((prev) => ({ ...prev, [recordingHotkeyId]: '' }))
        setRecordingHotkeyId(null)
        setHotkeysError('')
        return
      }

      const binding = hotkeyEventToBinding(e)
      if (!binding) return

      if (isReservedEditorHotkeyBinding(binding)) {
        setHotkeysError(`${formatEditorHotkey(binding)} is reserved for fixed shortcuts like play, step, undo, or delete.`)
        return
      }

      setEditorHotkeysState((prev) => {
        const next = { ...prev }
        for (const definition of EDITOR_HOTKEY_DEFINITIONS) {
          if (definition.id !== recordingHotkeyId && next[definition.id] === binding) {
            next[definition.id] = ''
          }
        }
        next[recordingHotkeyId] = binding
        return next
      })
      setRecordingHotkeyId(null)
      setHotkeysError('')
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [recordingHotkeyId, editorHotkeys])

  useEffect(() => {
    if (!initialSection) return
    setActiveSection(resolveInitialSection(initialSection))
  }, [initialSection])

  // Keep the Settings view in sync if the key is saved/cleared from any
  // other surface (Onboarding, Workflow Setup gallery, Generate tab).
  useEffect(() => {
    const handler = () => {
      getComfyPartnerApiKey().then((value) => setComfyOrgApiKey(value || '')).catch(() => {})
    }
    window.addEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
    return () => window.removeEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
  }, [])

  const handleToggleAutoImportComfyOutputs = () => {
    const next = !autoImportComfyOutputs
    setAutoImportComfyOutputs(next)
    try {
      localStorage.setItem(AUTO_IMPORT_KEY, String(next))
    } catch (_) {}
  }

  const handleSavePexelsKey = () => {
    setPexelsApiKey(pexelsApiKey.trim()).catch(console.error)
  }

  const handleSaveComfyConnection = async () => {
    const result = await saveLocalComfyConnectionPort(comfyPortInput)
    if (!result.success) {
      setComfyConnectionState({
        status: 'error',
        message: result.error || 'Invalid local ComfyUI configuration.',
      })
      return false
    }

    setComfyPortInput(String(result.config.port))
    setComfyConnectionState({
      status: 'idle',
      message: `Saved local endpoint: ${result.config.httpBase}`,
    })
    return true
  }

  const handleTestComfyConnection = async () => {
    const parsed = parseLocalComfyPortInput(comfyPortInput)
    if (!parsed.success) {
      setComfyConnectionState({
        status: 'error',
        message: parsed.error || 'Invalid local ComfyUI port.',
      })
      return
    }

    setComfyConnectionState({
      status: 'testing',
      message: `Testing localhost:${parsed.port}...`,
    })

    const testResult = await checkLocalComfyConnection({ port: parsed.port })
    if (testResult.ok) {
      setComfyConnectionState({
        status: 'success',
        message: `Connected to ${testResult.httpBase}`,
      })
      return
    }

    setComfyConnectionState({
      status: 'error',
      message: testResult.error || `Could not connect to localhost:${parsed.port}.`,
    })
  }

  const handleResetComfyConnection = async () => {
    setComfyPortInput(String(DEFAULT_COMFY_PORT))
    const result = await saveLocalComfyConnectionPort(DEFAULT_COMFY_PORT)
    if (!result.success) {
      setComfyConnectionState({
        status: 'error',
        message: result.error || 'Could not reset local ComfyUI port.',
      })
      return
    }
    setComfyConnectionState({
      status: 'idle',
      message: `Reset to local endpoint: ${result.config.httpBase}`,
    })
  }

  const handleChooseDirectory = async ({ title, currentPath, onSelect }) => {
    if (!window.electronAPI?.selectDirectory) {
      console.warn('Directory picker is not available in this environment.')
      return
    }

    try {
      const selectedPath = await window.electronAPI.selectDirectory({
        title,
        defaultPath: currentPath || undefined,
      })
      if (selectedPath) onSelect(selectedPath)
    } catch (error) {
      console.error('Could not open directory picker:', error)
    }
  }

  const handleSaveFilePathSettings = async () => {
    try {
      const [outputResult, workflowResult] = await Promise.all([
        window.electronAPI?.setSetting?.(OUTPUT_DIRECTORY_SETTING_KEY, outputPath.trim()),
        window.electronAPI?.setSetting?.(WORKFLOWS_DIRECTORY_SETTING_KEY, workflowPath.trim()),
      ])

      return outputResult?.success !== false && workflowResult?.success !== false
    } catch (error) {
      console.error('Could not save file path settings:', error)
      return false
    }
  }

  const handleSaveAllSettings = async () => {
    await setPexelsApiKey(pexelsApiKey.trim())
    await setEditorHotkeys(editorHotkeys)
    const [connectionSaved, filePathsSaved] = await Promise.all([
      handleSaveComfyConnection(),
      handleSaveFilePathSettings(),
    ])
    if (connectionSaved && filePathsSaved) {
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    } else {
      setSettingsSaved(false)
    }
  }

  const activeSectionMeta = useMemo(
    () => SETTINGS_SECTIONS.find((section) => section.id === activeSection) || SETTINGS_SECTIONS[0],
    [activeSection]
  )
  const isWorkflowSetupActive = activeSection === 'workflow-setup'

  let activeSectionContent = null

  switch (activeSection) {
    case 'storage':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">Projects Location</label>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary truncate">
                {defaultProjectsLocation || 'Not set'}
              </div>
              <button
                onClick={selectDefaultProjectsLocation}
                className="px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors flex-shrink-0"
              >
                Change
              </button>
            </div>
            <p className="text-[10px] text-sf-text-muted mt-1">Where new projects are created</p>
          </div>

          {currentProject && (
            <div>
              <label className="block text-xs text-sf-text-muted mb-1">Current Project</label>
              <div className="bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2">
                <p className="text-sm text-sf-text-primary truncate">{currentProject.name}</p>
                <p className="text-[10px] text-sf-text-muted mt-0.5">
                  {currentProject.settings?.width}x{currentProject.settings?.height} @ {currentProject.settings?.fps}fps
                </p>
              </div>
              <button
                onClick={closeProject}
                className="mt-2 w-full px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors"
              >
                Close Project
              </button>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">Auto-save</label>
              <p className="text-[10px] text-sf-text-muted">Save every 30 sec</p>
            </div>
            <button
              onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
              className={`w-10 h-5 rounded-full transition-colors ${autoSaveEnabled ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${autoSaveEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">Reopen last project on startup</label>
              <p className="text-[10px] text-sf-text-muted">When off, ComfyStudio opens to the project picker.</p>
            </div>
            <button
              onClick={() => setReopenLastProjectOnStartup(!reopenLastProjectOnStartup)}
              className={`w-10 h-5 rounded-full transition-colors ${reopenLastProjectOnStartup ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${reopenLastProjectOnStartup ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">Show hero background on project picker</label>
              <p className="text-[10px] text-sf-text-muted">Cinematic image at the top of the project picker. Turn off for a minimal look.</p>
            </div>
            <button
              onClick={() => setShowHeroBackground(!showHeroBackground)}
              className={`w-10 h-5 rounded-full transition-colors ${showHeroBackground ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${showHeroBackground ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>
      )
      break
    case 'stock':
      activeSectionContent = (
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">API Key</label>
            <input
              type="password"
              value={pexelsApiKey}
              onChange={(e) => setPexelsApiKeyLocal(e.target.value)}
              onBlur={handleSavePexelsKey}
              placeholder="Your Pexels API key"
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-sm text-sf-text-primary placeholder-sf-text-muted focus:outline-none focus:border-sf-accent"
            />
            <p className="text-[10px] text-sf-text-muted mt-1">
              Free at{' '}
              <a href="https://www.pexels.com/api/" target="_blank" rel="noopener noreferrer" className="text-sf-accent hover:underline">
                pexels.com/api
              </a>
              . Used by the Stock tab to search photos and videos.
            </p>
          </div>
        </div>
      )
      break
    case 'connection':
      activeSectionContent = (
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">Local ComfyUI Port</label>
            <input
              type="number"
              min={1}
              max={65535}
              step={1}
              value={comfyPortInput}
              onChange={(e) => setComfyPortInput(e.target.value)}
              onBlur={() => { void handleSaveComfyConnection() }}
              placeholder={String(DEFAULT_COMFY_PORT)}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-sm text-sf-text-primary focus:outline-none focus:border-sf-accent"
            />
            <p className="text-[10px] text-sf-text-muted mt-1">
              Local-only mode. Remote/LAN ComfyUI is disabled in this build.
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${
                comfyConnectionState.status === 'success'
                  ? 'bg-sf-success'
                  : comfyConnectionState.status === 'error'
                    ? 'bg-red-500'
                    : comfyConnectionState.status === 'testing'
                      ? 'bg-yellow-400 animate-pulse'
                      : 'bg-sf-dark-500'
              }`} />
              <span className="text-xs text-sf-text-muted truncate">{comfyConnectionState.message}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => { void handleResetComfyConnection() }}
                className="px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => { void handleTestComfyConnection() }}
                className="px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors"
              >
                Test
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <div className="rounded-md bg-sf-dark-800 p-2 flex-shrink-0">
                  <KeyRound className="h-4 w-4 text-sf-accent" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-sf-text-primary">Cloud Workflows · Comfy.org API key</div>
                  <div className="mt-0.5 text-[11px] text-sf-text-muted">
                    Unlocks {COMFY_PARTNER_WORKFLOWS.length} starter workflows that render in the cloud (Grok, Kling, Vidu, Nano Banana, Seedream). One key covers all of them.
                  </div>
                  <div className="mt-1.5 text-[11px]">
                    {comfyOrgApiKey ? (
                      <span className="inline-flex items-center gap-1 text-green-400">
                        <CheckCircle2 className="h-3 w-3" />
                        Key saved and ready
                      </span>
                    ) : (
                      <span className="text-yellow-300">No key saved yet</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setApiKeyDialogOpen(true)}
                  className="rounded bg-sf-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sf-accent/90"
                >
                  {comfyOrgApiKey ? 'Change key' : 'Add API key'}
                </button>
                <button
                  type="button"
                  onClick={() => { void openComfyPartnerDashboard() }}
                  className="inline-flex items-center gap-1 text-[11px] text-sf-text-muted hover:text-sf-text-primary"
                >
                  <ExternalLink className="h-3 w-3" />
                  Get a key
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="pr-4">
              <label className="text-sm text-sf-text-primary">Auto-import ComfyUI tab generations</label>
              <p className="text-[10px] text-sf-text-muted">
                When enabled, successful custom prompts observed while the embedded ComfyUI tab is active are imported into the current project&apos;s <span className="text-sf-text-secondary">Imported from ComfyUI/</span> folder. Detected frame sequences are stitched into a single MP4 at the project&apos;s framerate.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoImportComfyOutputs}
              onClick={handleToggleAutoImportComfyOutputs}
              className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 relative ${autoImportComfyOutputs ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
              title={autoImportComfyOutputs ? 'Disable auto-import' : 'Enable auto-import'}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${autoImportComfyOutputs ? 'left-[calc(100%-1.25rem)]' : 'left-0.5'}`}
                aria-hidden
              />
            </button>
          </div>
        </div>
      )
      break
    case 'paths':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">Output Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder={OUTPUT_DIRECTORY_PLACEHOLDER}
                className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent truncate"
              />
              <button
                type="button"
                onClick={() => {
                  void handleChooseDirectory({
                    title: 'Select Output Directory',
                    currentPath: outputPath,
                    onSelect: setOutputPath,
                  })
                }}
                className="px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors flex-shrink-0"
              >
                ...
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">Workflows Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workflowPath}
                onChange={(e) => setWorkflowPath(e.target.value)}
                placeholder={WORKFLOWS_DIRECTORY_PLACEHOLDER}
                className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent truncate"
              />
              <button
                type="button"
                onClick={() => {
                  void handleChooseDirectory({
                    title: 'Select Workflows Directory',
                    currentPath: workflowPath,
                    onSelect: setWorkflowPath,
                  })
                }}
                className="px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors flex-shrink-0"
              >
                ...
              </button>
            </div>
          </div>
        </div>
      )
      break
    case 'workflow-setup':
      activeSectionContent = <WorkflowSetupSection />
      break
    case 'launcher':
      activeSectionContent = <ComfyLauncherSettingsSection onOpenLogViewer={() => setLogViewerOpen(true)} />
      break
    case 'appearance':
      activeSectionContent = (
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-sf-text-muted">Theme</label>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {THEMES.map((theme) => {
                const isActive = theme.id === activeThemeId
                return (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => {
                      setActiveThemeId(theme.id)
                      applyTheme(theme.id)
                    }}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      isActive
                        ? 'border-sf-accent bg-sf-accent/10'
                        : 'border-sf-dark-700 bg-sf-dark-800 hover:bg-sf-dark-700'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex gap-0.5 flex-shrink-0">
                        <div className="w-4 h-4 rounded-sm" style={{ backgroundColor: theme.preview.bg }} />
                        <div className="w-4 h-4 rounded-sm" style={{ backgroundColor: theme.preview.surface }} />
                        <div className="w-4 h-4 rounded-sm" style={{ backgroundColor: theme.preview.accent }} />
                        <div className="w-4 h-4 rounded-sm border border-white/10" style={{ backgroundColor: theme.preview.text }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm text-sf-text-primary font-medium">{theme.label}</span>
                          {isActive && (
                            <span className="text-[10px] text-sf-accent font-medium">Active</span>
                          )}
                        </div>
                        <p className="text-[10px] text-sf-text-muted truncate">{theme.description}</p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">Timeline clip thumbnails</label>
              <p className="text-[10px] text-sf-text-muted">Turn off for heavy edits so clips draw as lightweight colored blocks.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowTimelineClipThumbnails(!showTimelineClipThumbnails)}
              className={`w-10 h-5 rounded-full transition-colors ${showTimelineClipThumbnails ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${showTimelineClipThumbnails ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>
      )
      break
    case 'hotkeys':
      activeSectionContent = (
        <div className="space-y-5">
          <div className="rounded border border-sf-dark-700 bg-sf-dark-800/60 px-3 py-2">
            <p className="text-xs text-sf-text-secondary">
              Only editor-specific shortcuts are customizable in this first pass. Core shortcuts like <code>Space</code>, <code>Arrow Left/Right</code>, <code>Undo/Redo</code>, <code>Delete</code>, and copy/paste stay fixed.
            </p>
            <p className="mt-1 text-[10px] text-sf-text-muted">
              Press a shortcut to record it. Press <code>Delete</code> while recording to clear an assignment.
            </p>
          </div>

          <div className="rounded border border-sf-dark-700 bg-sf-dark-800/60 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-sf-text-primary">Keymap presets</p>
                <p className="text-[10px] text-sf-text-muted">
                  Apply familiar editor-style bindings to the configurable actions only.
                </p>
              </div>
              <div className="rounded bg-sf-dark-900 px-2 py-1 text-[10px] text-sf-text-secondary">
                Current preset: {currentHotkeyPresetId === 'custom'
                  ? 'Custom'
                  : (EDITOR_HOTKEY_PRESETS.find((preset) => preset.id === currentHotkeyPresetId)?.label || 'Custom')}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              {EDITOR_HOTKEY_PRESETS.map((preset) => {
                const isActive = preset.id === currentHotkeyPresetId
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setEditorHotkeysState(preset.bindings)
                      setRecordingHotkeyId(null)
                      setHotkeysError('')
                    }}
                    className={`rounded border px-3 py-2 text-left transition-colors ${
                      isActive
                        ? 'border-sf-accent bg-sf-accent/10'
                        : 'border-sf-dark-700 bg-sf-dark-800 hover:bg-sf-dark-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-sf-text-primary">{preset.label}</span>
                      {isActive && (
                        <span className="text-[10px] text-sf-accent">Active</span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-sf-text-muted">{preset.description}</p>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            {EDITOR_HOTKEY_DEFINITIONS.map((definition) => (
              <div
                key={definition.id}
                className="flex items-center justify-between gap-3 rounded border border-sf-dark-700 bg-sf-dark-800 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm text-sf-text-primary">{definition.label}</div>
                  <div className="text-[10px] text-sf-text-muted">{definition.description}</div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setRecordingHotkeyId(definition.id)
                      setHotkeysError('')
                    }}
                    className={`min-w-[128px] rounded border px-3 py-1.5 text-xs font-mono transition-colors ${
                      recordingHotkeyId === definition.id
                        ? 'border-sf-accent bg-sf-accent/15 text-sf-accent'
                        : 'border-sf-dark-600 bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                    }`}
                  >
                    {recordingHotkeyId === definition.id ? 'Press shortcut...' : formatEditorHotkey(editorHotkeys[definition.id])}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditorHotkeysState((prev) => ({ ...prev, [definition.id]: definition.defaultBinding || '' }))
                      setHotkeysError('')
                    }}
                    className="rounded bg-sf-dark-700 px-2.5 py-1.5 text-[10px] text-sf-text-muted transition-colors hover:bg-sf-dark-600"
                    title="Restore default binding for this action"
                  >
                    Default
                  </button>
                </div>
              </div>
            ))}
          </div>

          {hotkeysError && (
            <p className="text-xs text-sf-error">{hotkeysError}</p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setEditorHotkeysState(DEFAULT_EDITOR_HOTKEYS)
                setRecordingHotkeyId(null)
                setHotkeysError('')
              }}
              className="rounded bg-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600"
            >
              Restore All Defaults
            </button>
          </div>
        </div>
      )
      break
    case 'project':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">Default Resolution</label>
            <select
              value={defaultResolution || 'HD 1080p'}
              onChange={(e) => setDefaultProjectSettings(e.target.value, defaultFps)}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-sm text-sf-text-primary focus:outline-none focus:border-sf-accent"
            >
              {RESOLUTION_PRESETS.map((preset) => (
                <option key={preset.name} value={preset.name}>
                  {preset.name} ({preset.width}x{preset.height})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">Default Frame Rate</label>
            <select
              value={defaultFps ?? 24}
              onChange={(e) => setDefaultProjectSettings(defaultResolution, Number(e.target.value))}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-sm text-sf-text-primary focus:outline-none focus:border-sf-accent"
            >
              {FPS_PRESETS.map((fps) => (
                <option key={fps.value} value={fps.value}>
                  {fps.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )
      break
    default:
      activeSectionContent = null
  }

  const ActiveSectionIcon = activeSectionMeta.icon

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="w-[250px] flex-shrink-0 border-r border-sf-dark-700 bg-sf-dark-950/60">
          <div className="border-b border-sf-dark-700 px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-sf-text-muted">Categories</div>
            <p className="mt-1 text-xs text-sf-text-secondary">Pick a settings area to edit.</p>
          </div>
          <div className="overflow-y-auto p-2">
            <div className="space-y-1">
              {SETTINGS_SECTIONS.map((section) => (
                <SettingsRailItem
                  key={section.id}
                  section={section}
                  isActive={section.id === activeSection}
                  onSelect={setActiveSection}
                />
              ))}
            </div>
          </div>
        </aside>

        <section className="flex flex-1 min-w-0 min-h-0 flex-col">
          <div className="border-b border-sf-dark-700 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sf-dark-800 text-sf-text-secondary">
                <ActiveSectionIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-medium text-sf-text-primary">{activeSectionMeta.title}</h3>
                <p className="mt-1 text-sm text-sf-text-secondary">{activeSectionMeta.description}</p>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
            <div className="max-w-4xl">
              {activeSectionContent}
            </div>
          </div>
        </section>
      </div>

      <ComfyLauncherLogViewer open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
      <ApiKeyDialog
        open={apiKeyDialogOpen}
        onClose={() => setApiKeyDialogOpen(false)}
        onSaved={(value) => setComfyOrgApiKey(value || '')}
      />

      <div className="flex items-center justify-between gap-4 border-t border-sf-dark-700 px-5 py-4">
        <p className="text-[11px] text-sf-text-muted">
          {isWorkflowSetupActive
            ? 'Workflow installs happen in the panel above. Save Settings only persists shared preferences and shortcuts.'
            : 'Some settings save as you edit. Use Save Settings to persist shared preferences and shortcuts.'}
        </p>
        <button
          onClick={handleSaveAllSettings}
          className={`flex flex-shrink-0 items-center justify-center gap-2 rounded px-4 py-2.5 text-sm transition-colors min-w-[180px] ${
            isWorkflowSetupActive
              ? 'border border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary hover:border-sf-dark-500 hover:bg-sf-dark-700 hover:text-sf-text-primary'
              : 'bg-sf-accent text-white hover:bg-sf-accent-hover'
          }`}
        >
          <Save className="w-4 h-4" />
          {settingsSaved ? 'Saved' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

export default function SettingsModal({ isOpen, onClose, initialSection = null }) {
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 pt-4 pb-4 px-4"
      onClick={onClose}
    >
      <div
        className="bg-sf-dark-900 border border-sf-dark-600 rounded-xl w-full max-w-6xl h-[calc(100vh-2rem)] overflow-hidden shadow-2xl flex flex-col flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-sf-dark-700 flex-shrink-0">
          <h2 className="text-lg font-medium text-sf-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-sf-dark-700 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-sf-text-muted" />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          <GeneralTab initialSection={initialSection} />
        </div>
      </div>
    </div>
  )
}
