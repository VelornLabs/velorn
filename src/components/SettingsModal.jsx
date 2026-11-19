import { useState, useEffect, useMemo, useRef } from 'react'
import {
  X, Palette, Monitor, Save, Search,
  HardDrive, Keyboard,
  KeyRound, CheckCircle2, ExternalLink, Loader2, RefreshCcw,
  Play, Copy, MessageSquare,
} from 'lucide-react'
import useProjectStore, { RESOLUTION_PRESETS, FPS_PRESETS } from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import { THEMES, getStoredThemeId, applyTheme } from '../config/themes'
import { getPexelsApiKey, setPexelsApiKey } from '../services/pexelsSettings'
import WorkflowSetupSection from './WorkflowSetupSection'
import FeedbackSection from './FeedbackSection'
import ComfyLauncherSettingsSection from './ComfyLauncherSettingsSection'
import ComfyConnectionSetup from './ComfyConnectionSetup'
import OptionalSetup from './OptionalSetup'
import ComfyLauncherLogViewer from './ComfyLauncherLogViewer'
import ApiKeyDialog from './ApiKeyDialog'
import ComfyHostedSetup from './ComfyHostedSetup'
import CreateKeySetting from './CreateKeySetting'
import SettingsSectionTabs from './SettingsSectionTabs'
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
  assignEditorHotkeyBinding,
  formatEditorHotkey,
  getEditorHotkeys,
  getEditorHotkeyPresetMatch,
  hotkeyEventToBinding,
  isReservedEditorHotkeyBinding,
  setEditorHotkeys,
} from '../services/editorHotkeys'
import {
  generatePlaybackCachesForAllVideos,
  hasUsablePlaybackCache,
  isPlaybackCacheableVideoAsset,
} from '../services/playbackCache'
import {
  GENERATION_COMPLETION_SOUND_CHANGED_EVENT,
  GENERATION_COMPLETION_SOUND_OPTIONS,
  getGenerationCompletionSoundSettings,
  playGenerationCompletionSound,
  setGenerationCompletionSoundSettings,
} from '../services/generationCompletionSoundSettings'
import {
  getShowCloudCreditBalance,
  setShowCloudCreditBalance,
} from '../services/cloudCreditDisplaySettings'
import {
  DISCOVER_TAB_VISIBILITY_CHANGED_EVENT,
  getShowDiscoverTab,
  hydrateShowDiscoverTab,
  setShowDiscoverTab,
} from '../services/discoverTabVisibilitySettings.mjs'
import { setShowGenerateTab } from '../services/generateTabVisibilitySettings.mjs'
import { HIDEABLE_TOP_TABS, setTopTabShown, useHiddenTopTabs } from '../services/topTabVisibilitySettings.mjs'
import { useGenerateTabVisibility } from '../hooks/useGenerateWorkspace'
import { useI18n } from '../i18n/I18nContext'
import { SETTINGS_GROUPS, SETTINGS_PAGES, resolveSettingsTarget, searchSettings } from '../config/settingsNavigation.mjs'
import { ASSET_REMOVAL_MODE_EVENT, getAssetRemovalMode, setAssetRemovalMode } from '../services/assetRemovalPreferences.mjs'

const AUTO_IMPORT_KEY = 'comfystudio-auto-import-comfy-outputs'
const OUTPUT_DIRECTORY_SETTING_KEY = 'outputDirectory'
const WORKFLOWS_DIRECTORY_SETTING_KEY = 'workflowsDirectory'
const OUTPUT_DIRECTORY_PLACEHOLDER = 'C:\\Users\\...\\Velorn\\outputs'
const WORKFLOWS_DIRECTORY_PLACEHOLDER = 'C:\\Users\\...\\ComfyUI\\workflow_API'
const HOTKEY_CATEGORY_KEY = {
  'Timeline selection': 'selection',
  'Timeline editing': 'editing',
  'Timeline clip state': 'clipState',
  'Timeline navigation': 'navigation',
  'Precision editing': 'precision',
  'Timeline text': 'text',
  'Timeline transitions': 'transitions',
  'Timeline linking': 'linking',
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

const GROUP_ICONS = { general: Palette, editing: Keyboard, media: HardDrive, playback: Play, connections: KeyRound, project: Monitor, feedback: MessageSquare }

function GeneralTab({ initialSection = null, onFinishSetup, onChooseAgentModel }) {
  const { language, languages, setLanguage, t } = useI18n()
  const label = (key, fallback) => t(`settings.navigation.${key}`, { defaultValue: fallback }, fallback)
  const [searchQuery, setSearchQuery] = useState('')
  const [assetRemovalMode, setAssetRemovalModeState] = useState(getAssetRemovalMode)
  const [assetRemovalError, setAssetRemovalError] = useState('')
  const [draftSave, setDraftSave] = useState({ section: '', status: '', message: '' })
  const [saveBusy, setSaveBusy] = useState(false)
  const draftSaveLock = useRef(false)
  const draftValuesRef = useRef(null)
  const contentRef = useRef(null)
  useEffect(() => {
    const sync = () => { setAssetRemovalModeState(getAssetRemovalMode()); setAssetRemovalError('') }
    window.addEventListener(ASSET_REMOVAL_MODE_EVENT, sync)
    return () => window.removeEventListener(ASSET_REMOVAL_MODE_EVENT, sync)
  }, [])
  const changeRemovalMode = mode => {
    const result = setAssetRemovalMode(mode)
    if (result?.success === false) setAssetRemovalError(result.error || label('saveFailed', 'Could not save this preference.'))
    else { setAssetRemovalModeState(getAssetRemovalMode()); setAssetRemovalError('') }
  }
  const [outputPath, setOutputPath] = useState('')
  const [workflowPath, setWorkflowPath] = useState('')
  const [hardwareExportFfmpegPath, setHardwareExportFfmpegPathState] = useState('')
  const [hardwareExportFfmpegStatus, setHardwareExportFfmpegStatus] = useState(null)
  const [hardwareExportFfmpegTest, setHardwareExportFfmpegTest] = useState(null)
  const [hardwareExportFfmpegBusy, setHardwareExportFfmpegBusy] = useState('')
  const [hardwareExportFfmpegMessage, setHardwareExportFfmpegMessage] = useState('')
  const hardwareExportFfmpegInputDirtyRef = useRef(false)
  const hardwareExportFfmpegStatusGenerationRef = useRef(0)
  const [activeThemeId, setActiveThemeId] = useState(() => getStoredThemeId())
  const [generationCompletionSoundSettings, setGenerationCompletionSoundSettingsState] = useState(() => (
    getGenerationCompletionSoundSettings()
  ))
  const [showCloudCreditBalance, setShowCloudCreditBalanceState] = useState(() => getShowCloudCreditBalance())
  const [showDiscoverTab, setShowDiscoverTabState] = useState(getShowDiscoverTab)
  const showGenerateTab = useGenerateTabVisibility()
  const hiddenTopTabs = useHiddenTopTabs()
  const [pexelsApiKey, setPexelsApiKeyLocal] = useState('')
  const [comfyOrgApiKey, setComfyOrgApiKey] = useState('')
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [activeSection, setActiveSection] = useState(() => resolveSettingsTarget(initialSection).pageId)
  const [editorHotkeys, setEditorHotkeysState] = useState(DEFAULT_EDITOR_HOTKEYS)
  const [recordingHotkeyId, setRecordingHotkeyId] = useState(null)
  const [hotkeysError, setHotkeysError] = useState('')
  const [logViewerOpen, setLogViewerOpen] = useState(false)
  const [playbackCacheConfirmOpen, setPlaybackCacheConfirmOpen] = useState(false)
  const [playbackCacheBusy, setPlaybackCacheBusy] = useState(false)
  const [playbackCacheProgress, setPlaybackCacheProgress] = useState({ completed: 0, total: 0, currentName: '' })
  const [playbackCacheMessage, setPlaybackCacheMessage] = useState('')
  const [mcpStatus, setMcpStatus] = useState(null)
  const [mcpCopied, setMcpCopied] = useState('')
  draftValuesRef.current = { stock: pexelsApiKey, hotkeys: editorHotkeys, paths: [outputPath, workflowPath] }
  const currentHotkeyPresetId = useMemo(
    () => getEditorHotkeyPresetMatch(editorHotkeys),
    [editorHotkeys]
  )
  const assets = useAssetsStore((state) => state.assets)

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
    currentProjectHandle,
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
      const hardwareFfmpegStatusGeneration = hardwareExportFfmpegStatusGenerationRef.current
      try {
        const [storedOutputPath, storedWorkflowPath, hardwareFfmpegStatus] = await Promise.all([
          window.electronAPI?.getSetting?.(OUTPUT_DIRECTORY_SETTING_KEY),
          window.electronAPI?.getSetting?.(WORKFLOWS_DIRECTORY_SETTING_KEY),
          window.electronAPI?.getHardwareExportFfmpegStatus?.(),
        ])
        setOutputPath(String(storedOutputPath || ''))
        setWorkflowPath(String(storedWorkflowPath || ''))
        if (
          hardwareFfmpegStatus
          && hardwareFfmpegStatusGeneration === hardwareExportFfmpegStatusGenerationRef.current
        ) {
          if (!hardwareExportFfmpegInputDirtyRef.current) {
            setHardwareExportFfmpegPathState(String(hardwareFfmpegStatus.settingPath || ''))
          }
          setHardwareExportFfmpegStatus(hardwareFfmpegStatus)
        }
      } catch {
        setOutputPath('')
        setWorkflowPath('')
        if (hardwareFfmpegStatusGeneration === hardwareExportFfmpegStatusGenerationRef.current) {
          setHardwareExportFfmpegStatus(null)
        }
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

      setEditorHotkeysState((prev) => assignEditorHotkeyBinding(prev, recordingHotkeyId, binding))
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
    setActiveSection(resolveSettingsTarget(initialSection).pageId)
    setSearchQuery('')
    setRecordingHotkeyId(null)
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [initialSection])

  useEffect(() => {
    if (activeSection !== 'agents') return undefined
    let cancelled = false
    const refreshStatus = () => {
      if (!window.electronAPI?.mcp?.getStatus) {
        setMcpStatus({
          running: false,
          url: 'http://127.0.0.1:19790/mcp',
          error: 'MCP server is only available in the desktop app.',
          hasProject: false,
        })
        return
      }
      window.electronAPI.mcp.getStatus()
        .then((status) => {
          if (!cancelled) setMcpStatus(status)
        })
        .catch((error) => {
          if (!cancelled) {
            setMcpStatus({
              running: false,
              url: 'http://127.0.0.1:19790/mcp',
              error: error?.message || 'Could not read MCP status.',
              hasProject: false,
            })
          }
        })
    }
    refreshStatus()
    const timer = setInterval(refreshStatus, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeSection])

  useEffect(() => {
    const handler = (event) => {
      setGenerationCompletionSoundSettingsState(event?.detail || getGenerationCompletionSoundSettings())
    }
    window.addEventListener(GENERATION_COMPLETION_SOUND_CHANGED_EVENT, handler)
    return () => window.removeEventListener(GENERATION_COMPLETION_SOUND_CHANGED_EVENT, handler)
  }, [])

  useEffect(() => {
    let cancelled = false
    hydrateShowDiscoverTab().then((show) => {
      if (!cancelled) setShowDiscoverTabState(show)
    }).catch(() => {})

    const handler = (event) => {
      setShowDiscoverTabState(event?.detail?.show !== false)
    }
    window.addEventListener(DISCOVER_TAB_VISIBILITY_CHANGED_EVENT, handler)
    return () => {
      cancelled = true
      window.removeEventListener(DISCOVER_TAB_VISIBILITY_CHANGED_EVENT, handler)
    }
  }, [])

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

  const handleGenerationCompletionSoundChange = (updates) => {
    const next = setGenerationCompletionSoundSettings({
      ...generationCompletionSoundSettings,
      ...updates,
    })
    setGenerationCompletionSoundSettingsState(next)
  }

  const handleToggleCloudCreditBalance = () => {
    const next = setShowCloudCreditBalance(!showCloudCreditBalance)
    setShowCloudCreditBalanceState(next)
  }

  const handleToggleDiscoverTab = () => {
    const next = !showDiscoverTab
    setShowDiscoverTabState(next)
    setShowDiscoverTab(next).catch(() => {})
  }

  const handleCopyMcpText = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text)
      setMcpCopied(id)
      setTimeout(() => setMcpCopied((current) => (current === id ? '' : current)), 1800)
    } catch (error) {
      console.warn('Could not copy MCP text:', error)
    }
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

  const handleChooseHardwareExportFfmpeg = async () => {
    if (!window.electronAPI?.selectFile) {
      setHardwareExportFfmpegMessage('File picker is not available in this environment.')
      return
    }
    try {
      const selectedPath = await window.electronAPI.selectFile({
        title: 'Select FFmpeg for hardware export',
        defaultPath: hardwareExportFfmpegPath || hardwareExportFfmpegStatus?.activePath || undefined,
        filters: [{ name: 'FFmpeg executable', extensions: ['*'] }],
      })
      if (selectedPath) {
        hardwareExportFfmpegInputDirtyRef.current = true
        setHardwareExportFfmpegPathState(String(selectedPath))
        setHardwareExportFfmpegTest(null)
        setHardwareExportFfmpegMessage('Path selected. Save it to validate and activate it.')
      }
    } catch (error) {
      setHardwareExportFfmpegMessage(error?.message || 'Could not choose an FFmpeg executable.')
    }
  }

  const handleSaveHardwareExportFfmpeg = async () => {
    const selectedPath = hardwareExportFfmpegPath.trim()
    if (!selectedPath) {
      setHardwareExportFfmpegMessage('Choose an FFmpeg executable or use the bundled default.')
      return
    }
    if (!window.electronAPI?.setHardwareExportFfmpegPath) {
      setHardwareExportFfmpegMessage('Hardware-export FFmpeg settings are not available in this environment.')
      return
    }

    hardwareExportFfmpegStatusGenerationRef.current += 1
    setHardwareExportFfmpegBusy('saving')
    setHardwareExportFfmpegTest(null)
    setHardwareExportFfmpegMessage('Validating FFmpeg...')
    try {
      const result = await window.electronAPI.setHardwareExportFfmpegPath(selectedPath)
      if (!result?.success) {
        setHardwareExportFfmpegMessage(result?.error || 'The selected FFmpeg executable could not be saved.')
        return
      }
      setHardwareExportFfmpegStatus(result.status || null)
      setHardwareExportFfmpegPathState(String(result.status?.settingPath || selectedPath))
      hardwareExportFfmpegInputDirtyRef.current = false
      setHardwareExportFfmpegMessage(
        result.status?.source === 'environment'
          ? 'Saved. VELORN_FFMPEG_PATH still takes priority for this app session.'
          : 'Hardware-export FFmpeg saved and ready to test.'
      )
    } catch (error) {
      setHardwareExportFfmpegMessage(error?.message || 'Could not save the hardware-export FFmpeg path.')
    } finally {
      setHardwareExportFfmpegBusy('')
    }
  }

  const handleResetHardwareExportFfmpeg = async () => {
    if (!window.electronAPI?.resetHardwareExportFfmpegPath) return
    hardwareExportFfmpegStatusGenerationRef.current += 1
    setHardwareExportFfmpegBusy('resetting')
    setHardwareExportFfmpegTest(null)
    try {
      const result = await window.electronAPI.resetHardwareExportFfmpegPath()
      if (!result?.success) {
        setHardwareExportFfmpegMessage(result?.error || 'Could not restore the bundled FFmpeg setting.')
        return
      }
      setHardwareExportFfmpegPathState('')
      hardwareExportFfmpegInputDirtyRef.current = false
      setHardwareExportFfmpegStatus(result.status || null)
      setHardwareExportFfmpegMessage(
        result.status?.source === 'environment'
          ? 'Saved path cleared. VELORN_FFMPEG_PATH remains active.'
          : 'Velorn will use its bundled FFmpeg for hardware checks and software fallback.'
      )
    } catch (error) {
      setHardwareExportFfmpegMessage(error?.message || 'Could not restore the bundled FFmpeg setting.')
    } finally {
      setHardwareExportFfmpegBusy('')
    }
  }

  const handleTestHardwareExportFfmpeg = async () => {
    if (!window.electronAPI?.checkNvenc) return
    hardwareExportFfmpegStatusGenerationRef.current += 1
    setHardwareExportFfmpegBusy('testing')
    setHardwareExportFfmpegMessage('Testing the active FFmpeg and hardware encoder...')
    try {
      const result = await window.electronAPI.checkNvenc({ forceRefresh: true })
      setHardwareExportFfmpegTest(result)
      const status = await window.electronAPI.getHardwareExportFfmpegStatus?.()
      if (status) setHardwareExportFfmpegStatus(status)
      if (result?.available) {
        const codecs = [result.h264 ? 'H.264' : '', result.h265 ? 'H.265' : ''].filter(Boolean).join(' and ')
        setHardwareExportFfmpegMessage(`${codecs} hardware encoding is ready.`)
      } else {
        setHardwareExportFfmpegMessage(result?.error || 'This FFmpeg does not provide a usable hardware encoder. CPU export remains available.')
      }
    } catch (error) {
      setHardwareExportFfmpegTest(null)
      setHardwareExportFfmpegMessage(error?.message || 'Could not test the active FFmpeg executable.')
    } finally {
      setHardwareExportFfmpegBusy('')
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

  const saveDraft = async section => {
    if (draftSaveLock.current || !['stock', 'hotkeys', 'paths'].includes(section)) return
    draftSaveLock.current = true
    setSaveBusy(true)
    const savedValues = JSON.stringify(draftValuesRef.current[section])
    setDraftSave({ section, status: 'saving', message: '' })
    try {
      if (section === 'stock') await setPexelsApiKey(pexelsApiKey.trim())
      else if (section === 'hotkeys') await setEditorHotkeys(editorHotkeys)
      else if (section === 'paths') {
        if (!window.electronAPI?.setSetting || !await handleSaveFilePathSettings()) {
          throw new Error(label('saveFailed', 'Could not save these settings. Please try again.'))
        }
      }
      const unchanged = JSON.stringify(draftValuesRef.current[section]) === savedValues
      setDraftSave({ section, status: unchanged ? 'saved' : 'unsaved', message: unchanged
        ? label('saved', 'Saved.')
        : label('newerDraft', 'Earlier values saved. Save again to apply your latest changes.') })
    } catch (error) {
      setDraftSave({ section, status: 'error', message: error?.message || label('saveFailed', 'Could not save these settings.') })
    } finally {
      draftSaveLock.current = false
      setSaveBusy(false)
    }
  }

  const playbackCacheCoverage = useMemo(() => {
    const videoAssets = (assets || []).filter((asset) => asset?.type === 'video')
    const cacheableAssets = videoAssets.filter(isPlaybackCacheableVideoAsset)
    const ready = videoAssets.filter(hasUsablePlaybackCache).length
    const encoding = videoAssets.filter((asset) => asset?.playbackCacheStatus === 'encoding').length
    const failed = cacheableAssets.filter((asset) => asset?.playbackCacheStatus === 'failed').length
    return {
      total: videoAssets.length,
      cacheable: cacheableAssets.length,
      rebuildable: cacheableAssets.filter((asset) => asset?.playbackCacheStatus !== 'encoding').length,
      ready,
      encoding,
      failed,
      unavailable: videoAssets.length - cacheableAssets.length,
    }
  }, [assets])

  const handleRebuildVideoPlaybackCache = async () => {
    if (!currentProjectHandle || playbackCacheBusy || playbackCacheCoverage.rebuildable <= 0) return

    const expectedTotal = (useAssetsStore.getState().assets || [])
      .filter((asset) => isPlaybackCacheableVideoAsset(asset) && asset?.playbackCacheStatus !== 'encoding')
      .length
    if (expectedTotal <= 0) return

    setPlaybackCacheConfirmOpen(false)
    setPlaybackCacheBusy(true)
    setPlaybackCacheMessage('')
    setPlaybackCacheProgress({ completed: 0, total: expectedTotal, currentName: '' })

    try {
      let completed = 0
      let currentName = ''
      const summary = await generatePlaybackCachesForAllVideos(currentProjectHandle, {
        force: true,
        onStart: (asset) => {
          currentName = asset?.name || asset?.id || 'Video'
          setPlaybackCacheProgress((prev) => ({
            ...prev,
            currentName,
          }))
        },
        onFinish: (asset) => {
          completed += 1
          setPlaybackCacheProgress({
            completed,
            total: expectedTotal,
            currentName: asset?.name || currentName,
          })
        },
      })

      setPlaybackCacheMessage(
        summary?.success
          ? t(summary.encoded === 1 ? 'settings.storage.cache.rebuildCompleteOne' : 'settings.storage.cache.rebuildCompleteMany', {
              encoded: summary.encoded,
              failed: summary.failed
                ? t('settings.storage.cache.failedSuffix', { count: summary.failed })
                : '',
            })
          : (summary?.error || t('settings.storage.cache.rebuildFailed'))
      )
    } catch (error) {
      setPlaybackCacheMessage(error?.message || t('settings.storage.cache.rebuildFailed'))
    } finally {
      setPlaybackCacheBusy(false)
      setPlaybackCacheProgress({ completed: 0, total: 0, currentName: '' })
    }
  }

  const localizedGroups = SETTINGS_GROUPS.map(group => ({
    ...group, icon: GROUP_ICONS[group.id],
    title: label(`groups.${group.id}.title`, group.title),
    description: label(`groups.${group.id}.description`, group.description),
  }))
  const localizedPages = SETTINGS_PAGES.map(page => ({
    ...page, title: label(`pages.${page.id}`, page.title),
  }))
  const activeGroupId = resolveSettingsTarget(activeSection).groupId
  const activeGroup = localizedGroups.find(group => group.id === activeGroupId)
  const activePage = localizedPages.find(page => page.id === activeSection)
  const activeSectionMeta = activeGroup || {
    title: t('settings.sections.feedback.title'), description: t('settings.sections.feedback.description'), icon: MessageSquare,
  }
  const searchResults = searchSettings(searchQuery, localizedPages, localizedGroups)
  const navigate = pageId => {
    setActiveSection(pageId); setSearchQuery(''); setRecordingHotkeyId(null)
    if (contentRef.current) contentRef.current.scrollTop = 0
  }
  useEffect(() => {
    if (!draftSaveLock.current) setDraftSave({ section: '', status: '', message: '' })
  }, [outputPath, workflowPath, editorHotkeys, pexelsApiKey])

  let activeSectionContent = null

  switch (activeSection) {
    case 'storage':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">{t('settings.storage.projectsLocation')}</label>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary truncate">
                {defaultProjectsLocation || t('common.notSet')}
              </div>
              <button
                onClick={selectDefaultProjectsLocation}
                className="px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors flex-shrink-0"
              >
                {t('common.change')}
              </button>
            </div>
            <p className="text-[10px] text-sf-text-muted mt-1">{t('settings.storage.projectsLocationHelp')}</p>
          </div>

          {currentProject && (
            <div>
              <label className="block text-xs text-sf-text-muted mb-1">{t('settings.storage.currentProject')}</label>
              <div className="bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2">
                <p className="text-sm text-sf-text-primary truncate">{currentProject.name}</p>
                <p className="text-[10px] text-sf-text-muted mt-0.5">
                  {t('settings.storage.projectSummary', {
                    width: currentProject.settings?.width,
                    height: currentProject.settings?.height,
                    fps: currentProject.settings?.fps,
                  })}
                </p>
              </div>
              <button
                onClick={closeProject}
                className="mt-2 w-full px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors"
              >
                {t('settings.storage.closeProject')}
              </button>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">{t('settings.storage.autoSave')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.storage.autoSaveHelp')}</p>
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
              <label className="text-sm text-sf-text-primary">{t('settings.storage.reopenLastProject')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.storage.reopenLastProjectHelp')}</p>
            </div>
            <button
              onClick={() => setReopenLastProjectOnStartup(!reopenLastProjectOnStartup)}
              className={`w-10 h-5 rounded-full transition-colors ${reopenLastProjectOnStartup ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${reopenLastProjectOnStartup ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

        </div>
      )
      break
    case 'stock':
      activeSectionContent = (
        <div className="space-y-4">
          <div>
            <label htmlFor="pexels-api-key" className="block text-xs text-sf-text-muted mb-1">API Key</label>
            <input
              id="pexels-api-key"
              type="password"
              value={pexelsApiKey}
              onChange={(e) => setPexelsApiKeyLocal(e.target.value)}
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
    case 'setup':
      activeSectionContent = <OptionalSetup onCloudSetup={() => navigate('cloud')} onFinish={onFinishSetup} onChooseAgentModel={onChooseAgentModel} />
      break
    case 'comfy':
      activeSectionContent = window.electronAPI?.comfyLauncher
        ? <ComfyLauncherSettingsSection onOpenLogViewer={() => setLogViewerOpen(true)} />
        : <ComfyConnectionSetup />
      break
    case 'feedback':
      activeSectionContent = <FeedbackSection />
      break
    case 'network':
      activeSectionContent = <div className="max-w-xl flex flex-col gap-3 text-sm text-sf-text-secondary">
        <p>Sharing your GPU now has its own tab, next to Stock.</p>
        <button type="button" className="self-start rounded-md border border-sf-dark-600 bg-sf-dark-800 px-3 py-1.5 text-xs text-sf-text-primary hover:bg-sf-dark-700"
          onClick={() => window.dispatchEvent(new CustomEvent('velorn:open-settings', { detail: 'network' }))}>Open GPU sharing</button>
      </div>
      break
    case 'agents': {
      const mcpUrl = mcpStatus?.url || 'http://127.0.0.1:19790/mcp'
      const codexCommand = `codex mcp add velorn --url ${mcpUrl}`
      const claudeCommand = `claude mcp add --transport http velorn ${mcpUrl}`
      activeSectionContent = (
        <div className="space-y-4">
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-sf-text-primary">Velorn MCP server</div>
                <p className="mt-1 text-[11px] text-sf-text-muted">
                  {t('settings.agents.serverDescription')}
                </p>
              </div>
              <span className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[10px] font-medium ${
                mcpStatus?.running
                  ? 'bg-green-900/30 text-green-300'
                  : 'bg-red-900/30 text-red-300'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${mcpStatus?.running ? 'bg-green-300' : 'bg-red-300'}`} />
                {mcpStatus?.running ? 'Running' : 'Stopped'}
              </span>
            </div>

            <div className="mt-3 rounded border border-sf-dark-700 bg-black/30 px-3 py-2">
              <div className="mb-1 text-[10px] uppercase text-sf-text-muted">Local endpoint</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs text-sf-text-primary">{mcpUrl}</code>
                <button
                  type="button"
                  onClick={() => { void handleCopyMcpText('url', mcpUrl) }}
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-sf-dark-700 px-2 py-1 text-[11px] text-sf-text-secondary hover:bg-sf-dark-600"
                >
                  <Copy className="h-3 w-3" />
                  {mcpCopied === 'url' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {mcpStatus?.error && (
              <p className="mt-2 text-[11px] text-red-300">{mcpStatus.error}</p>
            )}
            <p className="mt-2 text-[11px] text-sf-text-muted">
              Snapshot: {mcpStatus?.lastSnapshotAt ? new Date(mcpStatus.lastSnapshotAt).toLocaleTimeString() : 'Waiting for app state'}
              {' '}• Project: {mcpStatus?.hasProject ? 'Open' : 'None open'}
              {' '}• Tools: {mcpStatus?.toolCount ?? 0}
            </p>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
              <div className="mb-2 text-xs font-semibold text-sf-text-primary">Codex</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-1.5 text-[11px] text-sf-text-secondary">{codexCommand}</code>
                <button
                  type="button"
                  onClick={() => { void handleCopyMcpText('codex', codexCommand) }}
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-sf-dark-700 px-2 py-1.5 text-[11px] text-sf-text-secondary hover:bg-sf-dark-600"
                >
                  <Copy className="h-3 w-3" />
                  {mcpCopied === 'codex' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
              <div className="mb-2 text-xs font-semibold text-sf-text-primary">Claude Code</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-1.5 text-[11px] text-sf-text-secondary">{claudeCommand}</code>
                <button
                  type="button"
                  onClick={() => { void handleCopyMcpText('claude', claudeCommand) }}
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-sf-dark-700 px-2 py-1.5 text-[11px] text-sf-text-secondary hover:bg-sf-dark-600"
                >
                  <Copy className="h-3 w-3" />
                  {mcpCopied === 'claude' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>

          <details className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-sf-text-primary">{label('agentTools', 'Available agent tools')}</summary>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-sf-text-secondary">
              {['get_project', 'create_project', 'duplicate_project', 'get_timeline', 'get_assets', 'get_ai_review_passes', 'get_mcp_recipes', 'find_timeline_items', 'check_media_health', 'inspect_export_file', 'guide_comfyui_setup', 'diagnose_comfyui_connection', 'set_comfyui_connection', 'repair_comfyui_connection', 'control_comfyui_launcher', 'get_comfyui_launcher_logs', 'validate_comfyui_nodes', 'list_velorn_workflows', 'inspect_velorn_workflow', 'check_export_readiness', 'inspect_clip', 'inspect_timeline_frame', 'prepare_generation_from_timeline_context', 'queue_prepared_generation', 'queue_timeline_generation_batch', 'queue_h3_reference_video', 'get_generation_queue_status', 'queue_prompt_generation_batch', 'inspect_timeline_range', 'inspect_visible_shots', 'get_generation_status', 'get_music_video_status', 'get_music_video_plan', 'inspect_music_video_keyframe', 'regenerate_music_video_keyframe', 'inspect_music_video_video', 'regenerate_music_video_video', 'analyze_timeline', 'analyze_music_video_workflow', 'undo', 'redo', 'set_playhead', 'select_clips', 'select_assets', 'create_project_checkpoint', 'restore_project_checkpoint', 'set_in_out_range', 'run_mcp_action_plan', 'import_asset_from_path', 'relink_asset', 'set_clip_style', 'set_clip_label_color', 'set_clips_enabled', 'add_timeline_markers', 'remove_timeline_markers', 'set_timeline_marker_properties', 'create_timeline', 'switch_timeline', 'rename_timeline', 'duplicate_timeline', 'delete_timeline', 'create_asset_folder', 'move_assets_to_folder', 'move_unused_assets_to_folder', 'add_track', 'update_track', 'remove_track', 'add_transition', 'update_transition', 'remove_transitions', 'move_clips', 'trim_clips', 'delete_clips', 'add_asset_to_timeline', 'add_assets_to_timeline', 'replace_clip_with_asset', 'add_solid_color', 'add_adjustment_clip', 'add_text_clip', 'add_shape_clip', 'duplicate_clip', 'update_text_clip', 'update_shape_clip', 'list_glsl_effects', 'add_glsl_effect', 'update_glsl_effect', 'remove_glsl_effect', 'set_clip_keyframes', 'add_dip_to_black', 'export_timeline', 'export_delivery_batch', 'export_fcpxml'].map((tool) => (
                <span key={tool} className="rounded bg-sf-dark-800 px-2 py-1">{tool}</span>
              ))}
            </div>
          </details>
        </div>
      )
      break
    }
    case 'paths':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label htmlFor="settings-output-directory" className="block text-xs text-sf-text-muted mb-1">{t('settings.paths.outputDirectory')}</label>
            <div className="flex gap-2">
              <input
                id="settings-output-directory"
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
                    title: t('settings.paths.selectOutputDirectory'),
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
            <label htmlFor="settings-workflows-directory" className="block text-xs text-sf-text-muted mb-1">{t('settings.paths.workflowsDirectory')}</label>
            <div className="flex gap-2">
              <input
                id="settings-workflows-directory"
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
                    title: t('settings.paths.selectWorkflowsDirectory'),
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

    case 'language':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label htmlFor="velorn-display-language" className="block text-xs text-sf-text-muted mb-1">
              {t('settings.languageLabel')}
            </label>
            <select
              id="velorn-display-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-sm text-sf-text-primary focus:outline-none focus:border-sf-accent"
            >
              {languages.map((item) => (
                <option key={item.code} value={item.code}>{item.name}</option>
              ))}
            </select>
            <p className="mt-2 text-xs text-sf-text-secondary">{t('settings.languageHelp')}</p>
            <p className="mt-1 text-[10px] text-sf-text-muted">{t('settings.fallbackHelp')}</p>
          </div>
        </div>
      )
      break
    case 'appearance':
      activeSectionContent = (
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-sf-text-muted">{t('settings.appearance.theme')}</label>
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
                            <span className="text-[10px] text-sf-accent font-medium">{t('settings.appearance.active')}</span>
                          )}
                        </div>
                        <p className="text-[10px] text-sf-text-muted truncate">{t(`settings.appearance.themes.${theme.id}`)}</p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">{t('settings.storage.showHero')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.storage.showHeroHelp')}</p>
            </div>
            <button
              onClick={() => setShowHeroBackground(!showHeroBackground)}
              className={`w-10 h-5 rounded-full transition-colors ${showHeroBackground ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${showHeroBackground ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="pr-4">
              <label className="text-sm text-sf-text-primary">{t('settings.appearance.generateTab', undefined, 'Show Director tab')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.appearance.generateTabHelp', undefined, 'Hide the tab for an agent-first layout. ComfyUI, agent tools and the generation queue remain available. You can show it again anytime.')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showGenerateTab}
              aria-label={t('settings.appearance.generateTab', undefined, 'Show Director tab')}
              onClick={() => { void setShowGenerateTab(!showGenerateTab) }}
              className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors ${showGenerateTab ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${showGenerateTab ? 'left-[calc(100%-1.25rem)]' : 'left-0.5'}`} aria-hidden />
            </button>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="pr-4">
              <label className="text-sm text-sf-text-primary">{t('settings.appearance.discoverTab')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.appearance.discoverTabHelp')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showDiscoverTab}
              aria-label={t('settings.appearance.discoverTab')}
              onClick={handleToggleDiscoverTab}
              className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors ${showDiscoverTab ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
              title={t(showDiscoverTab ? 'settings.appearance.hideDiscoverTab' : 'settings.appearance.showDiscoverTab')}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${showDiscoverTab ? 'left-[calc(100%-1.25rem)]' : 'left-0.5'}`}
                aria-hidden
              />
            </button>
          </div>
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3" data-testid="top-tab-switches">
            <div className="text-sm text-sf-text-primary">{t('settings.appearance.otherTabs', undefined, 'Other tabs')}</div>
            <p className="text-[10px] text-sf-text-muted">{t('settings.appearance.otherTabsHelp', undefined, 'Switch off the tabs you do not use. Editor and Export always stay.')}</p>
            <div className="mt-2 space-y-2">
              {HIDEABLE_TOP_TABS.map((tab) => {
                const shown = !hiddenTopTabs.includes(tab.id)
                const name = tab.id === 'comfyui' ? tab.label : t(`topTabs.${tab.id}`, undefined, tab.label)
                return (
                  <div key={tab.id} className="flex items-center justify-between">
                    <span className="text-xs text-sf-text-secondary">{name}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={shown}
                      aria-label={name}
                      onClick={() => { void setTopTabShown(tab.id, !shown) }}
                      className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors ${shown ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
                    >
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${shown ? 'left-[calc(100%-1.25rem)]' : 'left-0.5'}`} aria-hidden />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )
      break
    case 'notifications': {
      const soundEnabled = generationCompletionSoundSettings.enabled
      const soundVolume = generationCompletionSoundSettings.volume
      activeSectionContent = (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">{t('settings.notifications.completionSound')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.notifications.completionSoundHelp')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={soundEnabled}
              onClick={() => handleGenerationCompletionSoundChange({ enabled: !soundEnabled })}
              className={`w-10 h-5 rounded-full transition-colors ${soundEnabled ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
            >
              <div className={`w-4 h-4 bg-white rounded-full transition-transform ${soundEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className={`rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3 ${soundEnabled ? '' : 'opacity-60'}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="text-sm text-sf-text-primary">{t('settings.notifications.volume')}</label>
                <p className="text-[10px] text-sf-text-muted">{t('settings.notifications.volumeHelp')}</p>
              </div>
              <div className="rounded bg-sf-dark-800 px-2 py-1 text-xs text-sf-text-secondary">
                {soundVolume === 0 ? t('settings.notifications.off') : `${soundVolume}/10`}
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={soundVolume}
              disabled={!soundEnabled}
              onChange={(event) => handleGenerationCompletionSoundChange({ volume: Number(event.target.value) })}
              className="mt-3 w-full accent-sf-accent disabled:cursor-not-allowed"
            />
          </div>

          <div className={`rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3 ${soundEnabled ? '' : 'opacity-60'}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="text-sm text-sf-text-primary">{t('settings.notifications.sound')}</label>
                <p className="text-[10px] text-sf-text-muted">{t('settings.notifications.soundHelp')}</p>
              </div>
              <button
                type="button"
                disabled={!soundEnabled || soundVolume <= 0}
                onClick={() => playGenerationCompletionSound(generationCompletionSoundSettings)}
                className="inline-flex items-center gap-1.5 rounded bg-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {t('settings.notifications.preview')}
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
              {GENERATION_COMPLETION_SOUND_OPTIONS.map((option) => {
                const isSelected = option.id === generationCompletionSoundSettings.soundId
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleGenerationCompletionSoundChange({ soundId: option.id })}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'border-sf-accent bg-sf-accent/10'
                        : 'border-sf-dark-700 bg-sf-dark-800 hover:bg-sf-dark-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-sf-text-primary">{t(`settings.notifications.sounds.${option.id}.label`)}</span>
                      {isSelected && (
                        <span className="text-[10px] text-sf-accent">{t('settings.notifications.active')}</span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-sf-text-muted">{t(`settings.notifications.sounds.${option.id}.description`)}</p>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )
      break
    }
    case 'hotkeys':
      activeSectionContent = (
        <div className="space-y-5">
          <div className="rounded border border-sf-dark-700 bg-sf-dark-800/60 px-3 py-2">
            <p className="text-xs text-sf-text-secondary">
              {t('settings.hotkeys.introBefore')} <code>Space</code>, <code>Arrow Left/Right</code>, <code>Undo/Redo</code>, <code>Delete</code>, {t('settings.hotkeys.introAfter')}
            </p>
            <p className="mt-1 text-[10px] text-sf-text-muted">
              {t('settings.hotkeys.recordHelpBefore')} <code>Delete</code> {t('settings.hotkeys.recordHelpAfter')}
            </p>
          </div>

          <div className="rounded border border-sf-dark-700 bg-sf-dark-800/60 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-sf-text-primary">{t('settings.hotkeys.presets')}</p>
                <p className="text-[10px] text-sf-text-muted">
                  {t('settings.hotkeys.presetsHelp')}
                </p>
              </div>
              <div className="rounded bg-sf-dark-900 px-2 py-1 text-[10px] text-sf-text-secondary">
                {t('settings.hotkeys.currentPreset')}: {currentHotkeyPresetId === 'custom'
                  ? t('settings.hotkeys.custom')
                  : (EDITOR_HOTKEY_PRESETS.find((preset) => preset.id === currentHotkeyPresetId)?.label || t('settings.hotkeys.custom'))}
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
                        <span className="text-[10px] text-sf-accent">{t('settings.hotkeys.active')}</span>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-sf-text-muted">{t(`settings.hotkeys.presetDescriptions.${preset.id}`)}</p>
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
                  <div className="text-sm text-sf-text-primary">{t(`settings.hotkeys.actions.${definition.id}`)}</div>
                  <div className="text-[10px] text-sf-text-muted">{t(`settings.hotkeys.categories.${HOTKEY_CATEGORY_KEY[definition.description]}`)}</div>
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
                    {recordingHotkeyId === definition.id ? t('settings.hotkeys.pressShortcut') : formatEditorHotkey(editorHotkeys[definition.id])}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditorHotkeysState((prev) => assignEditorHotkeyBinding(prev, definition.id, definition.defaultBinding || ''))
                      setHotkeysError('')
                    }}
                    className="rounded bg-sf-dark-700 px-2.5 py-1.5 text-[10px] text-sf-text-muted transition-colors hover:bg-sf-dark-600"
                    title={t('settings.hotkeys.restoreAction')}
                  >
                    {t('settings.hotkeys.default')}
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
              {t('settings.hotkeys.restoreAll')}
            </button>
          </div>
        </div>
      )
      break
    case 'project':
      activeSectionContent = (
        <div className="space-y-5">
          <div>
            <label className="block text-xs text-sf-text-muted mb-1">{t('settings.projectDefaults.resolution')}</label>
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
            <label className="block text-xs text-sf-text-muted mb-1">{t('settings.projectDefaults.frameRate')}</label>
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
    case 'assets':
      activeSectionContent = (
        <div className="space-y-5">
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-4">
            <label htmlFor="asset-removal-default" className="block text-sm font-medium text-sf-text-primary">
              {label('assetRemoval.title', 'Default asset removal')}
            </label>
            <select id="asset-removal-default" value={assetRemovalMode} onChange={event => changeRemovalMode(event.target.value)}
              className="mt-2 w-full rounded border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-sm text-sf-text-primary">
              <option value="project-only">{label('assetRemoval.keep', 'Remove from project — keep files')}</option>
              <option value="trash">{label('assetRemoval.trash', 'Remove from project and move files to Trash')}</option>
            </select>
            <p className="mt-2 text-xs text-sf-text-secondary">
              {label('assetRemoval.help', 'This changes the default for future removals in the asset browser. Nothing is removed now. You will review the affected files before a Trash action.')}
            </p>
            <p className="mt-2 text-xs text-amber-200">
              {assetRemovalMode === 'trash'
                ? label('assetRemoval.warning', 'Trash can include a linked original file outside the project and generated cache files. Other projects may use those files. Review the confirmation carefully.')
                : label('assetRemoval.safe', 'Recommended: keep media files on disk when removing them from a project.')}
            </p>
            {assetRemovalError && <p role="alert" className="mt-2 text-xs text-red-300">{assetRemovalError}</p>}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="pr-4">
              <label className="text-sm text-sf-text-primary">{t('settings.connection.autoImport')}</label>
              <p className="text-[10px] text-sf-text-muted">
                {t('settings.connection.autoImportHelpBefore')} <span className="text-sf-text-secondary">Imported from ComfyUI/</span> {t('settings.connection.autoImportHelpAfter')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoImportComfyOutputs}
              onClick={handleToggleAutoImportComfyOutputs}
              className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 relative ${autoImportComfyOutputs ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
              title={autoImportComfyOutputs ? t('settings.connection.disableAutoImport') : t('settings.connection.enableAutoImport')}
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
    case 'editor':
      activeSectionContent = (
        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div>
              <label className="text-sm text-sf-text-primary">{t('settings.appearance.timelineThumbnails')}</label>
              <p className="text-[10px] text-sf-text-muted">{t('settings.appearance.timelineThumbnailsHelp')}</p>
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
    case 'cache':
      activeSectionContent = (
        <div className="space-y-5">
          <p className="text-xs text-sf-text-secondary">{label('currentProjectMaintenance', 'Current-project maintenance. Rebuilding writes playback cache files; it does not change your original media.')}</p>
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label className="text-sm text-sf-text-primary">{t('settings.storage.cache.title')}</label>
                <p className="mt-1 text-[10px] text-sf-text-muted">
                  {t('settings.storage.cache.description')}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                  <span className="rounded bg-sf-dark-800 px-2 py-1 text-sf-text-secondary">
                    {t('settings.storage.cache.ready', {
                      ready: playbackCacheCoverage.ready,
                      total: playbackCacheCoverage.total,
                    })}
                  </span>
                  {playbackCacheCoverage.encoding > 0 && (
                    <span className="rounded bg-blue-900/40 px-2 py-1 text-blue-200">
                      {t('settings.storage.cache.encoding', { count: playbackCacheCoverage.encoding })}
                    </span>
                  )}
                  {playbackCacheCoverage.failed > 0 && (
                    <span className="rounded bg-amber-900/40 px-2 py-1 text-amber-200">
                      {t('settings.storage.cache.failed', { count: playbackCacheCoverage.failed })}
                    </span>
                  )}
                  {playbackCacheCoverage.unavailable > 0 && (
                    <span className="rounded bg-sf-dark-800 px-2 py-1 text-sf-text-muted">
                      {t('settings.storage.cache.unavailable', { count: playbackCacheCoverage.unavailable })}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPlaybackCacheMessage('')
                  setPlaybackCacheConfirmOpen(true)
                }}
                disabled={playbackCacheBusy || !currentProjectHandle || playbackCacheCoverage.rebuildable <= 0}
                className="inline-flex flex-shrink-0 items-center gap-2 rounded bg-sf-dark-700 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {playbackCacheBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCcw className="h-3.5 w-3.5" />
                )}
                {playbackCacheBusy ? t('settings.storage.cache.rebuilding') : t('settings.storage.cache.rebuild')}
              </button>
            </div>

            {playbackCacheConfirmOpen && !playbackCacheBusy && (
              <div className="mt-3 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-3">
                <p className="text-xs text-amber-100">
                  {t(
                    playbackCacheCoverage.rebuildable === 1
                      ? 'settings.storage.cache.confirmOne'
                      : 'settings.storage.cache.confirmMany',
                    { count: playbackCacheCoverage.rebuildable }
                  )}
                </p>
                <p className="mt-1 text-[10px] text-amber-200/80">
                  {t('settings.storage.cache.confirmHelp')}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPlaybackCacheConfirmOpen(false)}
                    className="rounded bg-sf-dark-800 px-3 py-1.5 text-xs text-sf-text-secondary hover:bg-sf-dark-700"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleRebuildVideoPlaybackCache() }}
                    className="rounded bg-sf-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-sf-accent-hover"
                  >
                    {t('settings.storage.cache.startRebuild')}
                  </button>
                </div>
              </div>
            )}

            {playbackCacheBusy && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-sf-text-muted">
                  <span className="truncate">
                    {playbackCacheProgress.currentName || t('settings.storage.cache.preparing')}
                  </span>
                  <span className="flex-shrink-0">
                    {playbackCacheProgress.completed}/{playbackCacheProgress.total || playbackCacheCoverage.rebuildable}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-sf-dark-800">
                  <div
                    className="h-full rounded-full bg-sf-accent transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((playbackCacheProgress.completed / Math.max(1, playbackCacheProgress.total || playbackCacheCoverage.rebuildable)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {playbackCacheMessage && !playbackCacheBusy && (
              <p className="mt-3 text-[10px] text-sf-text-muted">{playbackCacheMessage}</p>
            )}
          </div>


        </div>
      )
      break
    case 'ffmpeg':
      activeSectionContent = (
        <div className="space-y-5">
          <p className="text-xs text-sf-text-secondary">{label('exportAdvanced', 'Optional advanced configuration. Most editors can keep the bundled tools. Export quality and delivery choices stay in the Export panel.')}</p>
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-sf-text-primary">Hardware export FFmpeg</div>
                <p className="mt-1 text-[10px] text-sf-text-muted">
                  Advanced: choose an FFmpeg build with NVENC on Linux. It is used only for final H.264/H.265 hardware video encoding; Velorn keeps its bundled FFmpeg for media tools and as the safe CPU fallback.
                </p>
              </div>
              <span className="flex-shrink-0 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1 text-[10px] text-sf-text-secondary">
                {hardwareExportFfmpegStatus?.source === 'environment'
                  ? 'Environment'
                  : hardwareExportFfmpegStatus?.source === 'setting'
                    ? 'Custom'
                    : 'Bundled'}
              </span>
            </div>

            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={hardwareExportFfmpegPath}
                onChange={(event) => {
                  hardwareExportFfmpegInputDirtyRef.current = true
                  setHardwareExportFfmpegPathState(event.target.value)
                  setHardwareExportFfmpegTest(null)
                  setHardwareExportFfmpegMessage('')
                }}
                placeholder={window.electronAPI?.platform === 'win32' ? 'C:\\path\\to\\ffmpeg.exe' : '/usr/bin/ffmpeg'}
                className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent truncate"
              />
              <button
                type="button"
                onClick={() => { void handleChooseHardwareExportFfmpeg() }}
                disabled={Boolean(hardwareExportFfmpegBusy)}
                className="px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors flex-shrink-0 disabled:cursor-wait disabled:opacity-50"
              >
                Browse
              </button>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { void handleSaveHardwareExportFfmpeg() }}
                disabled={Boolean(hardwareExportFfmpegBusy) || !hardwareExportFfmpegPath.trim()}
                className="rounded bg-sf-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {hardwareExportFfmpegBusy === 'saving' ? 'Validating...' : 'Save path'}
              </button>
              <button
                type="button"
                onClick={() => { void handleTestHardwareExportFfmpeg() }}
                disabled={Boolean(hardwareExportFfmpegBusy)}
                className="inline-flex items-center gap-1 rounded bg-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600 disabled:cursor-wait disabled:opacity-50"
              >
                <RefreshCcw className={`h-3 w-3 ${hardwareExportFfmpegBusy === 'testing' ? 'animate-spin' : ''}`} />
                Test active FFmpeg
              </button>
              <button
                type="button"
                onClick={() => { void handleResetHardwareExportFfmpeg() }}
                disabled={Boolean(hardwareExportFfmpegBusy) || (!hardwareExportFfmpegPath && hardwareExportFfmpegStatus?.source !== 'setting')}
                className="rounded bg-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {hardwareExportFfmpegStatus?.source === 'environment' ? 'Clear saved path' : 'Use bundled FFmpeg'}
              </button>
            </div>

            {hardwareExportFfmpegStatus?.activePath && (
              <div className="mt-3 rounded border border-sf-dark-700 bg-black/20 px-2.5 py-2 text-[10px] text-sf-text-muted">
                <div className="flex gap-1">
                  <span className="flex-shrink-0 uppercase tracking-wider">Active:</span>
                  <code className="min-w-0 break-all text-sf-text-secondary">{hardwareExportFfmpegStatus.activePath}</code>
                </div>
                {hardwareExportFfmpegStatus.version && (
                  <div className="mt-1 break-all">{hardwareExportFfmpegStatus.version}</div>
                )}
              </div>
            )}

            {hardwareExportFfmpegStatus?.environmentPath && (
              <p className="mt-2 text-[10px] text-yellow-300">
                VELORN_FFMPEG_PATH is active and takes priority over the saved path until Velorn is restarted without it.
              </p>
            )}
            {hardwareExportFfmpegStatus?.warning && (
              <p className="mt-2 text-[10px] text-yellow-300">{hardwareExportFfmpegStatus.warning}</p>
            )}
            {hardwareExportFfmpegMessage && (
              <p className={`mt-2 text-[10px] ${hardwareExportFfmpegTest?.available ? 'text-green-300' : 'text-sf-text-muted'}`}>
                {hardwareExportFfmpegMessage}
              </p>
            )}
            {hardwareExportFfmpegTest && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${hardwareExportFfmpegTest.h264 ? 'border-green-500/40 bg-green-500/10 text-green-300' : 'border-sf-dark-600 text-sf-text-muted'}`}>
                  H.264 {hardwareExportFfmpegTest.kind === 'videotoolbox' ? 'VideoToolbox' : 'NVENC'}
                </span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${hardwareExportFfmpegTest.h265 ? 'border-green-500/40 bg-green-500/10 text-green-300' : 'border-sf-dark-600 text-sf-text-muted'}`}>
                  H.265 {hardwareExportFfmpegTest.kind === 'videotoolbox' ? 'VideoToolbox' : 'NVENC'}
                </span>
              </div>
            )}
          </div>

        </div>
      )
      break
    case 'cloud':
      activeSectionContent = (
        <div className="space-y-5">
          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <div className="rounded-md bg-sf-dark-800 p-2 flex-shrink-0">
                  <KeyRound className="h-4 w-4 text-sf-accent" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-sf-text-primary">{t('settings.connection.cloudKeyTitle')}</div>
                  <p className="mt-1 text-[11px] text-sf-text-muted">Partner/API nodes through local ComfyUI. This is separate from the hosted account check below.</p>
                  <div className="mt-0.5 text-[11px] text-sf-text-muted">
                    {t('settings.connection.cloudKeyHelp', { count: COMFY_PARTNER_WORKFLOWS.length })}
                  </div>
                  <div className="mt-1.5 text-[11px]">
                    {comfyOrgApiKey ? (
                      <span className="inline-flex items-center gap-1 text-green-400">
                        <CheckCircle2 className="h-3 w-3" />
                        {t('settings.connection.keyReady')}
                      </span>
                    ) : (
                      <span className="text-yellow-300">{t('settings.connection.noKey')}</span>
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
                  {comfyOrgApiKey ? t('settings.connection.changeKey') : t('settings.connection.addKey')}
                </button>
                <button
                  type="button"
                  onClick={() => { void openComfyPartnerDashboard() }}
                  className="inline-flex items-center gap-1 text-[11px] text-sf-text-muted hover:text-sf-text-primary"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('settings.connection.getKey')}
                </button>
              </div>
            </div>
          </div>

          <ComfyHostedSetup />

          <CreateKeySetting />

          <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
            <div className="pr-4">
              <label className="text-sm text-sf-text-primary">Show cloud credit balance</label>
              <p className="text-[10px] text-sf-text-muted">
                Display Comfy.org credits in the app header. Turning this off does not disable cloud workflows.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showCloudCreditBalance}
              onClick={handleToggleCloudCreditBalance}
              className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors ${showCloudCreditBalance ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
              title={showCloudCreditBalance ? 'Hide cloud credit balance' : 'Show cloud credit balance'}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${showCloudCreditBalance ? 'left-[calc(100%-1.25rem)]' : 'left-0.5'}`}
                aria-hidden
              />
            </button>
          </div>


        </div>
      )
      break
    default:
      activeSectionContent = null
  }

  const ActiveSectionIcon = searchQuery.trim() ? Search : activeSectionMeta.icon
  const draftLabels = { paths: label('savePaths', 'Save media folders'), hotkeys: label('saveHotkeys', 'Save shortcuts'), stock: label('saveStock', 'Save API key') }
  const isDraftPage = Boolean(draftLabels[activeSection]) && !searchQuery.trim()
  const hasSectionTabs = !searchQuery.trim() && activeGroup?.pages.length > 1

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="flex w-[230px] min-h-0 flex-shrink-0 flex-col border-r border-sf-dark-700 bg-sf-dark-950/60">
          <div className="flex-shrink-0 border-b border-sf-dark-700 px-3 py-4">
            <label htmlFor="settings-search" className="sr-only">{label('search', 'Search settings')}</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-sf-text-muted" />
              <input id="settings-search" type="search" value={searchQuery}
                onChange={event => { setSearchQuery(event.target.value); setRecordingHotkeyId(null) }}
                placeholder={label('search', 'Search settings')}
                className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-800 py-2 pl-8 pr-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent" />
            </div>
          </div>
          <nav aria-label={label('categories', 'Settings categories')} className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-1">
              {localizedGroups.map(group => <SettingsRailItem key={group.id} section={group}
                isActive={!searchQuery.trim() && group.id === activeGroupId}
                onSelect={() => navigate(group.pages[0])} />)}
            </div>
          </nav>
          <div className="border-t border-sf-dark-700 p-2">
            <SettingsRailItem section={{ id: 'feedback', title: t('settings.sections.feedback.title'), icon: MessageSquare }}
              isActive={!searchQuery.trim() && activeSection === 'feedback'} onSelect={() => navigate('feedback')} />
          </div>
        </aside>

        <section className="flex flex-1 min-w-0 min-h-0 flex-col">
          <div className="flex-shrink-0 border-b border-sf-dark-700 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sf-dark-800 text-sf-text-secondary">
                <ActiveSectionIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-medium text-sf-text-primary">{searchQuery.trim() ? label('results', 'Search results') : activeSectionMeta.title}</h3>
                <p className="mt-1 text-sm text-sf-text-secondary">{searchQuery.trim() ? label('searchHelp', 'Choose a result to open its settings.') : activeSectionMeta.description}</p>
              </div>
            </div>
          </div>

          {hasSectionTabs && (
            <SettingsSectionTabs
              pages={activeGroup.pages.map(id => localizedPages.find(page => page.id === id))}
              activeId={activeSection} onSelect={navigate}
              label={label('sections', 'Settings sections')}
              hint={label('sectionsHint', 'Choose a section')}
            />
          )}
          <div ref={contentRef}
            role={hasSectionTabs ? 'tabpanel' : undefined}
            id={hasSectionTabs ? 'settings-section-panel' : undefined}
            aria-labelledby={hasSectionTabs ? `settings-section-tab-${activeSection}` : undefined}
            tabIndex={hasSectionTabs ? 0 : undefined}
            className="flex-1 min-h-0 overflow-y-auto px-5 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sf-accent">
            <div className="max-w-4xl" data-settings-page={activeSection}>
              {searchQuery.trim() ? (
                <div className="space-y-2">
                  {searchResults.length === 0 && <p role="status" className="text-sm text-sf-text-muted">{label('noResults', 'No matching settings. Try a different word.')}</p>}
                  {searchResults.map(result => <button key={result.id} type="button" onClick={() => navigate(result.id)}
                    className="block w-full rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-4 py-3 text-left hover:border-sf-accent/50">
                    <span className="block text-sm font-medium text-sf-text-primary">{result.title}</span>
                    <span className="mt-1 block text-xs text-sf-text-muted">{result.groupTitle}</span>
                  </button>)}
                </div>
              ) : (
                <>
                  {activePage && activeGroup?.pages.length > 1 && <h4 className="mb-4 text-base font-medium text-sf-text-primary">{activePage.title}</h4>}
                  {activeSectionContent}
                </>
              )}
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

      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-t border-sf-dark-700 px-5 py-3">
        <div className="text-[11px] text-sf-text-muted">
          <p>{isDraftPage
            ? label('draftHelp', 'Changes on this page are drafts until you select Save. Other preferences save automatically.')
            : label('autoSaveHelp', 'Preferences save automatically unless a Save button is shown. Actions run only when you choose them.')}</p>
          {isDraftPage && draftSave.section === activeSection && draftSave.message && (
            <p role={draftSave.status === 'error' ? 'alert' : 'status'} className={`mt-1 ${draftSave.status === 'error' ? 'text-red-300' : 'text-emerald-400'}`}>{draftSave.message}</p>
          )}
        </div>
        {isDraftPage && <button type="button" onClick={() => { void saveDraft(activeSection) }} disabled={saveBusy}
          className="flex flex-shrink-0 items-center justify-center gap-2 rounded bg-sf-accent px-4 py-2 text-sm text-white hover:bg-sf-accent-hover disabled:opacity-50">
          <Save className="h-4 w-4" />{saveBusy ? label('saving', 'Saving…') : draftLabels[activeSection]}
        </button>}
      </div>
    </div>
  )
}

export default function SettingsModal({ isOpen, onClose, initialSection = null, onChooseAgentModel }) {
  const { t } = useI18n()
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
          <h2 className="text-lg font-medium text-sf-text-primary">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-sf-dark-700 rounded-lg transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5 text-sf-text-muted" />
          </button>
        </div>

        <div className="flex-1 min-h-0">
          <GeneralTab initialSection={initialSection} onFinishSetup={onClose} onChooseAgentModel={onChooseAgentModel} />
        </div>
      </div>
    </div>
  )
}
