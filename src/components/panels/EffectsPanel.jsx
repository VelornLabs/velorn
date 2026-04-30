import { useMemo, useState, useEffect } from 'react'
import { Search, Info, ChevronDown, ChevronRight, Waves, Radio, Sparkles, CircleDot, Sun, RectangleHorizontal, MoveRight, Plus } from 'lucide-react'
import { useTimelineStore } from '../../stores/timelineStore'
import { TRANSITION_TYPES, TRANSITION_DURATIONS, FRAME_RATE, TRANSITION_DEFAULT_SETTINGS, TRANSITION_CATEGORIES } from '../../constants/transitions'
import { EFFECT_PICKER_GROUPS, getEffectTypeDefinition } from '../../utils/effects'

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

function EffectsPanel() {
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
  } = useTimelineStore()
  
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
  
  const filteredTransitions = useMemo(() => {
    if (!search.trim()) return TRANSITION_TYPES
    const q = search.trim().toLowerCase()
    return TRANSITION_TYPES.filter(t => t.name.toLowerCase().includes(q))
  }, [search])
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
  
  const handleDurationInput = (value) => {
    const next = Number(value)
    if (Number.isNaN(next)) return
    setDurationFrames(Math.max(1, Math.min(240, next)))
  }

  const handleSetDefaultDuration = () => {
    try {
      localStorage.setItem(TRANSITION_DEFAULT_DURATION_KEY, String(durationFrames))
      window.dispatchEvent(new CustomEvent('comfystudio-transition-default-duration-changed', { detail: durationFrames }))
    } catch (_) {}
    setMessage(`Default transition duration set to ${durationFrames} frames.`)
  }

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
        setMessage('Clip is too short for an edge transition.')
        return
      }
      const actualDuration = Math.min(durationSeconds, maxDuration)
      const result = addEdgeTransition(singleClip.id, edgeMode, type, actualDuration)
      if (!result) {
        setMessage('Could not add edge transition.')
        return
      }
      setMessage('')
      return
    }
    
    const pair = getSelectedPair()
    if (!pair) {
      setMessage('Select two adjacent clips on the same track to apply a transition.')
      return
    }
    
    const maxDuration = getMaxTransitionDuration(pair.clipA.id, pair.clipB.id)
    if (maxDuration < minTransitionSeconds) {
      setMessage('Insufficient handles. Extend clip trims to add a transition.')
      return
    }
    
    const actualDuration = Math.min(durationSeconds, maxDuration)
    const result = addTransition(pair.clipA.id, pair.clipB.id, type, actualDuration)
    if (!result) {
      setMessage('Could not add transition. Check clip handles or overlap.')
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
    const def = getEffectTypeDefinition(effectTypeId)
    if (!def) return
    if (selectedClips.length === 0) {
      setMessage('Select one or more clips, then click an effect to apply.')
      return
    }
    const preset = presetId ? def.presets?.find((p) => p.id === presetId) : null
    const settings = preset
      ? { ...def.defaults, ...preset.settings }
      : { ...def.defaults }
    selectedClips.forEach((clip) => {
      addEffect(clip.id, { type: effectTypeId, settings })
    })
    setMessage(
      `Added ${def.label}${preset ? ` (${preset.label})` : ''} to ${selectedClips.length} clip${
        selectedClips.length === 1 ? '' : 's'
      }.`
    )
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
          <div className="text-[10px] text-sf-text-muted">{transition.type}</div>
        </div>
        
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-sf-text-muted w-16">Duration</label>
          <input
            type="number"
            min={1}
            max={240}
            value={framesValue}
            onChange={(e) => updateTransitionDuration(transition.id, e.target.value)}
            className="w-20 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
          />
          <span className="text-[10px] text-sf-text-muted">frames</span>
        </div>
        
        {supportsZoom && (
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-sf-text-muted w-16">Zoom</label>
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
            <label className="text-[10px] text-sf-text-muted w-16">Blur</label>
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
          Transitions
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
          Effects
        </button>
      </div>

      {tab === 'effects' && (
        <div className="p-3 space-y-3">
          <div className="text-[11px] text-sf-text-muted flex items-start gap-2 bg-sf-dark-800/60 border border-sf-dark-700 rounded-lg p-2">
            <Info className="w-4 h-4 text-sf-text-muted mt-0.5" />
            <div>
              Select one or more clips on the timeline, then click an effect or preset
              to apply. Configure parameters in the Inspector.
            </div>
          </div>

          {message && (
            <div className="text-[11px] text-sf-accent bg-sf-accent/10 border border-sf-accent/20 rounded-lg p-2">
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
                      {group.label}
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
                              title="Click to apply to selected clips"
                            >
                              <Icon className="w-4 h-4 text-sf-accent" />
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] text-sf-text-primary">{def.label}</div>
                                {def.description && (
                                  <div className="text-[10px] text-sf-text-muted truncate">{def.description}</div>
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
                                    title={`Apply ${def.label} preset "${preset.label}"`}
                                  >
                                    {preset.label}
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
            placeholder="Search transitions..."
            className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-2 py-1.5 text-xs text-sf-text-primary placeholder-sf-text-muted focus:outline-none focus:border-sf-accent transition-colors"
          />
        </div>

        {/* Duration picker */}
        <div className="space-y-2">
          <div className="text-[11px] text-sf-text-muted">Duration</div>
          <div className="flex items-center gap-1 flex-wrap">
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
                {d.frames}f
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={240}
              value={durationFrames}
              onChange={(e) => handleDurationInput(e.target.value)}
              className="w-20 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
            />
            <span className="text-[11px] text-sf-text-muted">frames</span>
            <span className="text-[11px] text-sf-text-muted">({(durationFrames / FRAME_RATE).toFixed(2)}s)</span>
          </div>
          <button
            onClick={handleSetDefaultDuration}
            className="w-full px-2 py-1 rounded border border-sf-dark-600 bg-sf-dark-800 hover:bg-sf-dark-700 text-[10px] text-sf-text-secondary transition-colors"
          >
            Set as Default Duration
          </button>
        </div>

        {/* Edge mode for single clip */}
        {selectedClips.length === 1 && (
          <div className="space-y-2">
            <div className="text-[11px] text-sf-text-muted">Apply to</div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEdgeMode('in')}
                className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                  edgeMode === 'in'
                    ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                    : 'bg-sf-dark-800 border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                }`}
              >
                Start (In)
              </button>
              <button
                onClick={() => setEdgeMode('out')}
                className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                  edgeMode === 'out'
                    ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                    : 'bg-sf-dark-800 border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                }`}
              >
                End (Out)
              </button>
            </div>
          </div>
        )}
        
        <div className="text-[11px] text-sf-text-muted flex items-start gap-2 bg-sf-dark-800/60 border border-sf-dark-700 rounded-lg p-2">
          <Info className="w-4 h-4 text-sf-text-muted mt-0.5" />
          <div>
            Drag a transition onto a cut, or select two adjacent clips and click a transition to apply.
            Select one clip to apply to its start or end.
          </div>
        </div>
        
        {message && (
          <div className="text-[11px] text-sf-accent bg-sf-accent/10 border border-sf-accent/20 rounded-lg p-2">
            {message}
          </div>
        )}

        {(selectedBetweenTransition || selectedEdgeTransitions.length > 0) && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-sf-text-primary">Transition Settings</div>
            {selectedBetweenTransition && (
              <TransitionSettingsCard
                transition={selectedBetweenTransition}
                label="Between Clips"
              />
            )}
            {selectedEdgeTransitions.map((t) => (
              <TransitionSettingsCard
                key={t.id}
                transition={t}
                label={t.edge === 'in' ? 'Start (In)' : 'End (Out)'}
              />
            ))}
          </div>
        )}
        
        <div className="space-y-3">
          <div className="text-xs font-medium text-sf-text-primary">Transitions</div>
          {search.trim() ? (
            <div className="grid grid-cols-1 gap-2">
              {filteredTransitions.map((transition) => (
                <div
                  key={transition.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, transition.id)}
                  onClick={() => applyTransition(transition.id)}
                  className="flex items-center gap-2 px-3 py-2 bg-sf-dark-800 border border-sf-dark-600 rounded-lg text-xs text-sf-text-primary hover:border-sf-accent hover:bg-sf-dark-700 transition-colors cursor-pointer"
                  title="Drag to a cut or click to apply to selected clips"
                >
                  <TransitionThumbnail type={transition.id} icon={transition.icon} />
                  <div className="flex-1">
                    <div className="text-xs text-sf-text-primary">{transition.name}</div>
                    <div className="text-[10px] text-sf-text-muted">{durationFrames}f</div>
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
                      <span className="text-[11px] font-medium text-sf-text-primary">{category.label}</span>
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
                            title="Drag to a cut or click to apply"
                          >
                            <span className="text-[12px] text-sf-text-muted w-4 text-center">{transition.icon}</span>
                            <span className="truncate">{transition.name}</span>
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
