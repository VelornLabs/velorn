import { useMemo, useState, useEffect } from 'react'
import { Search, Info, ChevronDown, ChevronRight, Waves, Radio, Sparkles, CircleDot, Sun, RectangleHorizontal, MoveRight, Plus } from 'lucide-react'
import { useTimelineStore } from '../../stores/timelineStore'
import { TRANSITION_TYPES, TRANSITION_DURATIONS, FRAME_RATE, TRANSITION_DEFAULT_SETTINGS, TRANSITION_CATEGORIES } from '../../constants/transitions'
import { EFFECT_PICKER_GROUPS, getEffectTypeDefinition } from '../../utils/effects'
import { useI18n } from '../../i18n/I18nContext'
import { useTimelineFields } from '../../hooks/useTimelineFields'

const EFFECT_PANEL_ICONS = {
  cameraShake: Waves,
  glslCameraShake: Waves,
  glslDirectionalBlur: MoveRight,
  glslLensBlur: CircleDot,
  glslFisheye: CircleDot,
  chromaticAberration: Radio,
  glslChromaWarp: Radio,
  glslDigitalGlitch: Radio,
  sharpen: CircleDot,
  glslSharpen: CircleDot,
  glslVignette: CircleDot,
  filmGrain: Sparkles,
  glslFilmGrain: Sparkles,
  glslFilmLook: Sun,
  glslFlicker: Sparkles,
  glow: Sun,
  vignette: CircleDot,
  glslVhsLook: Radio,
  letterbox: RectangleHorizontal,
}

const TRANSITION_DEFAULT_DURATION_KEY = 'comfystudio-transition-default-duration-frames'

const EFFECTS_PANEL_TIMELINE_FIELDS = ['clips', 'transitions', 'selectedClipIds', 'addTransition', 'addEdgeTransition',
  'updateTransition', 'getMaxTransitionDuration', 'getMaxEdgeTransitionDuration', 'addEffect', 'applyMultiClipEffectsEdit']

function EffectsPanel() {
  const { t } = useI18n()
  const {
    clips,
    transitions,
    selectedClipIds,
    addTransition,
    addEdgeTransition,
    updateTransition,
    getMaxTransitionDuration,
    getMaxEdgeTransitionDuration,
    addEffect,
    applyMultiClipEffectsEdit,
  } = useTimelineFields(EFFECTS_PANEL_TIMELINE_FIELDS)
  
  const [tab, setTab] = useState('transitions') // 'transitions' | 'effects'
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [durationFrames, setDurationFrames] = useState(() => {
    try {
      const raw = localStorage.getItem(TRANSITION_DEFAULT_DURATION_KEY)
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed >= 1) return Math.round(parsed)
    } catch (_) {}
    return TRANSITION_DURATIONS[1]?.frames || 12
  })
  const [edgeMode, setEdgeMode] = useState('between') // between | in | out
  const [expandedCategories, setExpandedCategories] = useState(() => TRANSITION_CATEGORIES.map(c => c.id))
  const [expandedEffectCategories, setExpandedEffectCategories] = useState([])
  
  const durationSeconds = Math.max(1, durationFrames) / FRAME_RATE
  const minTransitionSeconds = 1 / FRAME_RATE
  
  const getTransitionDefaults = (type) => TRANSITION_DEFAULT_SETTINGS[type] || {}

  const getTransitionLabel = (transition) => (
    t(`effectsPanel.transitions.items.${transition.id}`, undefined, transition.name)
  )
  const getEffectGroupLabel = (group) => (
    t(`effectsPanel.effectGroups.${group.id}`, undefined, group.label)
  )
  const getEffectLabel = (definition) => (
    t(`effectsPanel.catalog.${definition.id}.label`, undefined, definition.label)
  )
  const getEffectDescription = (definition) => (
    t(`effectsPanel.catalog.${definition.id}.description`, undefined, definition.description)
  )
  const getPresetLabel = (definition, preset) => (
    t(`effectsPanel.catalog.${definition.id}.presets.${preset.id}`, undefined, preset.label)
  )
  
  const filteredTransitions = useMemo(() => {
    if (!search.trim()) return TRANSITION_TYPES
    const q = search.trim().toLowerCase()
    return TRANSITION_TYPES.filter((transition) => (
      transition.name.toLowerCase().includes(q)
      || getTransitionLabel(transition).toLowerCase().includes(q)
    ))
  }, [search, t])
  const transitionsById = useMemo(() => {
    const map = new Map()
    TRANSITION_TYPES.forEach(t => map.set(t.id, t))
    return map
  }, [])
  
  const selectedClips = clips.filter(c => selectedClipIds.includes(c.id))

  useEffect(() => {
    if (selectedClips.length === 1) {
      if (edgeMode === 'between') {
        setEdgeMode('in')
      }
    } else if (edgeMode !== 'between') {
      setEdgeMode('between')
    }
  }, [selectedClips.length, edgeMode])

  useEffect(() => {
    const handler = (e) => {
      const next = Number(e?.detail)
      if (Number.isFinite(next) && next >= 1) {
        setDurationFrames(Math.round(next))
      }
    }
    window.addEventListener('comfystudio-transition-default-duration-changed', handler)
    return () => window.removeEventListener('comfystudio-transition-default-duration-changed', handler)
  }, [])
  
  const getSelectedPair = () => {
    if (selectedClips.length !== 2) return null
    
    const [clipA, clipB] = selectedClips.sort((a, b) => a.startTime - b.startTime)
    if (clipA.trackId !== clipB.trackId) return null
    
    const trackClips = clips
      .filter(c => c.trackId === clipA.trackId)
      .sort((a, b) => a.startTime - b.startTime)
    
    const indexA = trackClips.findIndex(c => c.id === clipA.id)
    if (indexA === -1 || trackClips[indexA + 1]?.id !== clipB.id) return null
    
    return { clipA, clipB }
  }
  
  const getSelectedSingle = () => {
    if (selectedClips.length !== 1) return null
    return selectedClips[0]
  }

  const selectedPair = useMemo(() => getSelectedPair(), [selectedClips, clips])
  const selectedSingle = useMemo(() => getSelectedSingle(), [selectedClips])
  
  const selectedBetweenTransition = useMemo(() => {
    if (!selectedPair) return null
    const { clipA, clipB } = selectedPair
    return transitions.find(t =>
      t.kind === 'between' &&
      ((t.clipAId === clipA.id && t.clipBId === clipB.id) ||
       (t.clipAId === clipB.id && t.clipBId === clipA.id))
    ) || null
  }, [selectedPair, transitions])
  
  const selectedEdgeTransitions = useMemo(() => {
    if (!selectedSingle) return []
    return transitions.filter(t => t.kind === 'edge' && t.clipId === selectedSingle.id)
  }, [selectedSingle, transitions])
  
  const toggleCategory = (categoryId) => {
    setExpandedCategories(prev =>
      prev.includes(categoryId)
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    )
  }

  const toggleEffectCategory = (categoryId) => {
    setExpandedEffectCategories(prev =>
      prev.includes(categoryId)
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    )
  }
  
  const updateTransitionDuration = (transitionId, frames) => {
    const nextFrames = Math.max(1, Math.min(240, Number(frames) || 1))
    updateTransition(transitionId, { duration: nextFrames / FRAME_RATE })
  }
  
  const updateTransitionSetting = (transitionId, key, value) => {
    updateTransition(transitionId, { settings: { [key]: value } })
  }
  
  const getTransitionSettings = (transition) => {
    const defaults = getTransitionDefaults(transition.type)
    return {
      zoomAmount: transition?.settings?.zoomAmount ?? defaults.zoomAmount ?? 0.1,
      blurAmount: transition?.settings?.blurAmount ?? defaults.blurAmount ?? 8,
    }
  }
  
  const applyTransition = (type) => {
    const singleClip = getSelectedSingle()
    if (edgeMode !== 'between' && singleClip) {
      const maxDuration = getMaxEdgeTransitionDuration(singleClip.id)
      if (maxDuration < minTransitionSeconds) {
        setMessage(t('effectsPanel.messages.edgeTooShort'))
        return
      }
      const actualDuration = Math.min(durationSeconds, maxDuration)
      const result = addEdgeTransition(singleClip.id, edgeMode, type, actualDuration)
      if (!result) {
        setMessage(t('effectsPanel.messages.edgeAddFailed'))
        return
      }
      setMessage('')
      return
    }
    
    const pair = getSelectedPair()
    if (!pair) {
      setMessage(t('effectsPanel.messages.selectAdjacent'))
      return
    }
    
    const maxDuration = getMaxTransitionDuration(pair.clipA.id, pair.clipB.id)
    if (maxDuration < minTransitionSeconds) {
      setMessage(t('effectsPanel.messages.insufficientHandles'))
      return
    }
    
    const actualDuration = Math.min(durationSeconds, maxDuration)
    const result = addTransition(pair.clipA.id, pair.clipB.id, type, actualDuration)
    if (!result) {
      setMessage(t('effectsPanel.messages.transitionAddFailed'))
      return
    }
    
    setMessage('')
  }
  
  const handleDragStart = (e, transitionType) => {
    const payload = { type: transitionType, duration: durationSeconds }
    e.dataTransfer.setData('application/x-comfystudio-transition', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleEffectDragStart = (e, effectTypeId, presetId = null) => {
    const payload = { effectType: effectTypeId, presetId }
    e.dataTransfer.setData('application/x-comfystudio-effect', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const applyEffect = (effectTypeId, presetId = null) => {
    const liveState = useTimelineStore.getState()
    if (liveState.clips.some((clip) => liveState.selectedClipIds.includes(clip.id) && clip.type === 'compound')) {
      setMessage('Open Contents to add effects to clips inside this compound. Effects cannot be added to the parent compound.')
      return
    }
    const def = getEffectTypeDefinition(effectTypeId)
    if (!def) return
    if (selectedClips.length === 0) {
      setMessage(t('effectsPanel.messages.selectClipsForEffect'))
      return
    }
    const preset = presetId ? def.presets?.find((p) => p.id === presetId) : null
    const settings = preset
      ? { ...def.defaults, ...preset.settings }
      : { ...def.defaults }
    let changedCount = selectedClips.length
    if (selectedClips.length > 1) {
      const result = applyMultiClipEffectsEdit({ clipIds: selectedClipIds, action: 'add', type: effectTypeId, settings })
      if (!result.ok) { setMessage(result.error); return }
      changedCount = result.changedCount
    } else {
      addEffect(selectedClips[0].id, { type: effectTypeId, settings })
    }
    const effectLabel = getEffectLabel(def)
    const presetSuffix = preset
      ? t('effectsPanel.messages.presetSuffix', { preset: getPresetLabel(def, preset) })
      : ''
    setMessage(t(
      changedCount === 1 ? 'effectsPanel.messages.effectAddedOne' : 'effectsPanel.messages.effectAddedMany',
      { effect: effectLabel, preset: presetSuffix, count: changedCount }
    ))
  }
  
  const TransitionThumbnail = ({ type, icon }) => {
    const overlayStyle = (() => {
      switch (type) {
        case 'dissolve':
          return { background: 'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 40%, rgba(255,255,255,0.4) 60%, rgba(0,0,0,0) 100%)' }
        case 'fade-black':
          return { background: 'linear-gradient(90deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0) 100%)' }
        case 'fade-white':
          return { background: 'linear-gradient(90deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 100%)' }
        case 'wipe-left':
          return { background: 'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 50%, rgba(255,255,255,0.5) 50%, rgba(0,0,0,0) 52%)' }
        case 'wipe-right':
          return { background: 'linear-gradient(90deg, rgba(0,0,0,0) 48%, rgba(255,255,255,0.5) 50%, rgba(0,0,0,0) 52%)' }
        case 'wipe-up':
          return { background: 'linear-gradient(0deg, rgba(0,0,0,0) 48%, rgba(255,255,255,0.5) 50%, rgba(0,0,0,0) 52%)' }
        case 'wipe-down':
          return { background: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 48%, rgba(255,255,255,0.5) 50%, rgba(0,0,0,0) 52%)' }
        case 'slide-left':
        case 'slide-right':
        case 'slide-up':
        case 'slide-down':
          return { background: 'linear-gradient(90deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0) 100%)' }
        case 'zoom-in':
        case 'zoom-out':
          return { boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.4)' }
        case 'blur':
          return { filter: 'blur(1px)', background: 'linear-gradient(90deg, rgba(255,255,255,0.2) 0%, rgba(0,0,0,0) 100%)' }
        default:
          return {}
      }
    })()
    
    return (
      <div className="relative w-14 h-8 rounded-md overflow-hidden bg-sf-dark-900 border border-sf-dark-700 flex-shrink-0">
        <div className="absolute inset-0 grid grid-cols-2">
          <div className="bg-sf-blue-500/70" />
          <div className="bg-sf-emerald-500/70" />
        </div>
        <div className="absolute inset-0" style={overlayStyle} />
        <div className="absolute bottom-0 right-0 text-[9px] text-white/90 px-1 py-0.5 bg-black/40">
          {icon}
        </div>
      </div>
    )
  }
  
  const TransitionSettingsCard = ({ transition, label }) => {
    if (!transition) return null
    const settings = getTransitionSettings(transition)
    const framesValue = Math.max(1, Math.round((transition.duration || 0) * FRAME_RATE))
    const supportsZoom = transition.type === 'zoom-in' || transition.type === 'zoom-out'
    const supportsBlur = transition.type === 'blur'
    
    return (
      <div className="bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-sf-text-primary">{label}</div>
          <div className="text-[10px] text-sf-text-muted">
            {getTransitionLabel(transitionsById.get(transition.type) || { id: transition.type, name: transition.type })}
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-sf-text-muted w-16">{t('effectsPanel.duration')}</label>
          <input
            type="number"
            min={1}
            max={240}
            value={framesValue}
            onChange={(e) => updateTransitionDuration(transition.id, e.target.value)}
            className="w-20 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
          />
          <span className="text-[10px] text-sf-text-muted">{t('effectsPanel.frames')}</span>
        </div>
        
        {supportsZoom && (
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-sf-text-muted w-16">{t('effectsPanel.zoom')}</label>
            <input
              type="range"
              min={0.02}
              max={0.3}
              step={0.01}
              value={settings.zoomAmount}
              onChange={(e) => updateTransitionSetting(transition.id, 'zoomAmount', Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-[10px] text-sf-text-muted w-10 text-right">
              {settings.zoomAmount.toFixed(2)}
            </span>
          </div>
        )}
        
        {supportsBlur && (
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-sf-text-muted w-16">{t('effectsPanel.blur')}</label>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={settings.blurAmount}
              onChange={(e) => updateTransitionSetting(transition.id, 'blurAmount', Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-[10px] text-sf-text-muted w-10 text-right">
              {Math.round(settings.blurAmount)}px
            </span>
          </div>
        )}
      </div>
    )
  }
  
  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="flex items-center gap-1 px-3 pt-3">
        <button
          type="button"
          onClick={() => setTab('transitions')}
          className={`px-3 py-1.5 text-[11px] rounded-t transition-colors ${
            tab === 'transitions'
              ? 'bg-sf-dark-800 text-sf-text-primary border-b-2 border-sf-accent'
              : 'text-sf-text-muted hover:text-sf-text-primary'
          }`}
        >
          {t('effectsPanel.transitionsTab')}
        </button>
        <button
          type="button"
          onClick={() => setTab('effects')}
          className={`px-3 py-1.5 text-[11px] rounded-t transition-colors ${
            tab === 'effects'
              ? 'bg-sf-dark-800 text-sf-text-primary border-b-2 border-sf-accent'
              : 'text-sf-text-muted hover:text-sf-text-primary'
          }`}
        >
          {t('effectsPanel.effectsTab')}
        </button>
      </div>

      {tab === 'effects' && (
        <div className="p-3 space-y-3">
          <div className="text-[11px] text-sf-text-muted flex items-start gap-2 bg-sf-dark-800/60 border border-sf-dark-700 rounded-lg p-2">
            <Info className="w-4 h-4 text-sf-text-muted mt-0.5" />
            <div>{t('effectsPanel.effectHelp')}</div>
          </div>

          {message && (
            <div role="status" data-testid="effects-panel-status" className="text-[11px] text-sf-accent bg-sf-accent/10 border border-sf-accent/20 rounded-lg p-2">
              {message}
            </div>
          )}

          <div className="space-y-2">
            {EFFECT_PICKER_GROUPS.map((group) => {
              const expanded = expandedEffectCategories.includes(group.id)
              return (
                <div
                  key={group.id}
                  className="border border-sf-dark-700 rounded-lg overflow-hidden bg-sf-dark-900"
                >
                  <button
                    type="button"
                    onClick={() => toggleEffectCategory(group.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-sf-dark-800 hover:bg-sf-dark-700 transition-colors"
                  >
                    {expanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-sf-text-muted" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-sf-text-muted" />
                    )}
                    <span className="flex-1 text-left text-[11px] uppercase tracking-wider text-sf-text-secondary">
                      {getEffectGroupLabel(group)}
                    </span>
                    <span className="text-[10px] text-sf-text-muted">{group.effects.length}</span>
                  </button>

                  {expanded && (
                    <div className="space-y-2 p-2">
                      {group.effects.map((def) => {
                        const Icon = EFFECT_PANEL_ICONS[def.id] || Sparkles
                        return (
                          <div
                            key={def.id}
                            className="border border-sf-dark-700 rounded-lg overflow-hidden bg-sf-dark-900"
                          >
                            <div
                              draggable
                              onDragStart={(e) => handleEffectDragStart(e, def.id)}
                              onClick={() => applyEffect(def.id)}
                              className="flex items-center gap-2 px-3 py-2 bg-sf-dark-800/70 hover:bg-sf-dark-700 transition-colors cursor-pointer"
                              title={t('effectsPanel.clickEffectHelp')}
                            >
                              <Icon className="w-4 h-4 text-sf-accent" />
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] text-sf-text-primary">{getEffectLabel(def)}</div>
                                {def.description && (
                                  <div className="text-[10px] text-sf-text-muted truncate">{getEffectDescription(def)}</div>
                                )}
                              </div>
                              <Plus className="w-3.5 h-3.5 text-sf-text-muted" />
                            </div>

                            {def.presets && def.presets.length > 0 && (
                              <div className="p-2 flex flex-wrap gap-1">
                                {def.presets.map((preset) => (
                                  <button
                                    key={preset.id}
                                    type="button"
                                    draggable
                                    onDragStart={(e) => handleEffectDragStart(e, def.id, preset.id)}
                                    onClick={() => applyEffect(def.id, preset.id)}
                                    className="px-2 py-0.5 rounded text-[10px] border border-sf-dark-600 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-accent hover:text-sf-text-primary transition-colors"
                                    title={t('effectsPanel.applyPresetHelp', {
                                      effect: getEffectLabel(def),
                                      preset: getPresetLabel(def, preset),
                                    })}
                                  >
                                    {getPresetLabel(def, preset)}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'transitions' && (
      <div className="p-3 space-y-4">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-sf-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('effectsPanel.searchTransitions')}
            className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-2 py-1.5 text-xs text-sf-text-primary placeholder-sf-text-muted focus:outline-none focus:border-sf-accent transition-colors"
          />
        </div>

        {/* Apply-at duration: compact chip row. Fine-tuning to exact frames
            and "Set as Default Duration" live in the transition Inspector
            once a transition is applied — the bin stays a browsing surface. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-sf-text-muted">{t('effectsPanel.applyAt')}</span>
          {TRANSITION_DURATIONS.map((d) => (
            <button
              key={d.frames}
              onClick={() => setDurationFrames(d.frames)}
              className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                durationFrames === d.frames
                  ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                  : 'bg-sf-dark-800 border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
              }`}
            >
              {t('effectsPanel.frameShort', { count: d.frames })}
            </button>
          ))}
          <span className="text-[11px] text-sf-text-muted">
            {t('effectsPanel.secondsShort', { seconds: durationSeconds.toFixed(2) })}
          </span>
          <span
            className="ml-auto cursor-help"
            title={t('effectsPanel.transitionHelp')}
          >
            <Info className="w-3.5 h-3.5 text-sf-text-muted/70" />
          </span>
        </div>

        {/* Edge mode for single clip */}
        {selectedClips.length === 1 && (
          <div className="space-y-2">
            <div className="text-[11px] text-sf-text-muted">{t('effectsPanel.applyTo')}</div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEdgeMode('in')}
                className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                  edgeMode === 'in'
                    ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                    : 'bg-sf-dark-800 border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                }`}
              >
                {t('effectsPanel.startIn')}
              </button>
              <button
                onClick={() => setEdgeMode('out')}
                className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                  edgeMode === 'out'
                    ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                    : 'bg-sf-dark-800 border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                }`}
              >
                {t('effectsPanel.endOut')}
              </button>
            </div>
          </div>
        )}

        {message && (
          <div className="text-[11px] text-sf-accent bg-sf-accent/10 border border-sf-accent/20 rounded-lg p-2">
            {message}
          </div>
        )}

        {(selectedBetweenTransition || selectedEdgeTransitions.length > 0) && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-sf-text-primary">{t('effectsPanel.transitionSettings')}</div>
            {selectedBetweenTransition && (
              <TransitionSettingsCard
                transition={selectedBetweenTransition}
                label={t('effectsPanel.betweenClips')}
              />
            )}
            {selectedEdgeTransitions.map((transition) => (
              <TransitionSettingsCard
                key={transition.id}
                transition={transition}
                label={transition.edge === 'in' ? t('effectsPanel.startIn') : t('effectsPanel.endOut')}
              />
            ))}
          </div>
        )}
        
        <div className="space-y-3">
          <div className="text-xs font-medium text-sf-text-primary">{t('effectsPanel.transitionsTitle')}</div>
          {search.trim() ? (
            <div className="grid grid-cols-1 gap-2">
              {filteredTransitions.map((transition) => (
                <div
                  key={transition.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, transition.id)}
                  onClick={() => applyTransition(transition.id)}
                  className="flex items-center gap-2 px-3 py-2 bg-sf-dark-800 border border-sf-dark-600 rounded-lg text-xs text-sf-text-primary hover:border-sf-accent hover:bg-sf-dark-700 transition-colors cursor-pointer"
                  title={t('effectsPanel.dragOrClickSelected')}
                >
                  <TransitionThumbnail type={transition.id} icon={transition.icon} />
                  <div className="flex-1">
                    <div className="text-xs text-sf-text-primary">{getTransitionLabel(transition)}</div>
                    <div className="text-[10px] text-sf-text-muted">
                      {t('effectsPanel.frameShort', { count: durationFrames })}
                    </div>
                  </div>
                  <span className="text-[10px] text-sf-text-muted">{transition.icon}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {TRANSITION_CATEGORIES.map((category) => {
                const isExpanded = expandedCategories.includes(category.id)
                const items = category.items
                  .map(id => transitionsById.get(id))
                  .filter(Boolean)

                return (
                  <div key={category.id} className="border border-sf-dark-700 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleCategory(category.id)}
                      className="w-full flex items-center justify-between px-2.5 py-2 bg-sf-dark-800 hover:bg-sf-dark-700 transition-colors"
                    >
                      <span className="text-[11px] font-medium text-sf-text-primary">
                        {t(`effectsPanel.transitionCategories.${category.id}`, undefined, category.label)}
                      </span>
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-sf-text-muted" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-sf-text-muted" />
                      )}
                    </button>
                    {isExpanded && (
                      <div className="p-2 grid grid-cols-2 gap-2 bg-sf-dark-900">
                        {items.map((transition) => (
                          <button
                            key={transition.id}
                            draggable
                            onDragStart={(e) => handleDragStart(e, transition.id)}
                            onClick={() => applyTransition(transition.id)}
                            className="flex items-center gap-2 px-2 py-2 bg-sf-dark-800 border border-sf-dark-600 rounded text-[11px] text-sf-text-primary hover:border-sf-accent hover:bg-sf-dark-700 transition-colors text-left"
                            title={t('effectsPanel.dragOrClick')}
                          >
                            <span className="text-[12px] text-sf-text-muted w-4 text-center">{transition.icon}</span>
                            <span className="truncate">{getTransitionLabel(transition)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}

export default EffectsPanel
