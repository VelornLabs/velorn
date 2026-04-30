import { useState, useMemo, useCallback } from 'react'
import {
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  RotateCcw,
  Diamond,
  Waves,
  Radio,
  Sparkles,
  CircleDot,
  Sun,
  RectangleHorizontal,
  MoveRight,
  Tv,
} from 'lucide-react'
import {
  EFFECT_PICKER_GROUPS,
  getEffectTypeDefinition,
  getEffectPropertyId,
  isManagedEffectType,
  normalizeEffectSettings,
  getAnimatedEffectSettings,
} from '../../utils/effects'
import { getKeyframeAtTime } from '../../utils/keyframes'

const EFFECT_ICONS = {
  cameraShake: Waves,
  glslCameraShake: Waves,
  gaussianBlur: CircleDot,
  directionalBlur: MoveRight,
  glslDirectionalBlur: MoveRight,
  glslLensBlur: CircleDot,
  glslFisheye: CircleDot,
  chromaticAberration: Radio,
  glslChromaWarp: Radio,
  glslDigitalGlitch: Radio,
  sharpen: CircleDot,
  glslSharpen: CircleDot,
  filmGrain: Sparkles,
  glslFilmGrain: Sparkles,
  glslFilmLook: Sun,
  glslFlicker: Sparkles,
  glow: Sun,
  halation: Sun,
  vhsDamage: Tv,
  glslVhsLook: Tv,
  vignette: CircleDot,
  glslVignette: CircleDot,
  letterbox: RectangleHorizontal,
}

function EffectParamSlider({
  clip,
  effect,
  param,
  value,
  animatedValue,
  hasKeyframeHere,
  hasAnyKeyframes,
  onChange,
  onCommit,
  onReset,
  onToggleKeyframe,
  onPrevKeyframe,
  onNextKeyframe,
}) {
  const formatValue = (num) => {
    if (param.step != null && param.step < 1) {
      return `${Number(num).toFixed(2)}${param.unit || ''}`
    }
    return `${Math.round(num)}${param.unit || ''}`
  }

  if (param.type === 'toggle') {
    const enabled = Number(value) >= 0.5
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-sf-text-secondary flex-1">{param.label}</span>
        <button
          type="button"
          onClick={() => {
            const next = enabled ? 0 : 1
            onChange(next)
            onCommit(next)
          }}
          className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${
            enabled ? 'bg-sf-accent' : 'bg-sf-dark-600'
          }`}
          title={`Toggle ${param.label}`}
        >
          <div className={`w-3 h-3 rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </button>
        <KeyframeDiamond
          hasKeyframeHere={hasKeyframeHere}
          hasAnyKeyframes={hasAnyKeyframes}
          onToggle={onToggleKeyframe}
          onPrev={onPrevKeyframe}
          onNext={onNextKeyframe}
        />
      </div>
    )
  }

  const displayValue = animatedValue != null ? animatedValue : value
  const isAnimated = animatedValue != null && Math.abs(animatedValue - value) > 0.001

  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <label className="text-[10px] text-sf-text-secondary">{param.label}</label>
        <div className="flex items-center gap-1">
          <span className={`text-[10px] ${isAnimated ? 'text-sf-accent' : 'text-sf-text-muted'}`}>
            {formatValue(displayValue)}
          </span>
          <KeyframeDiamond
            hasKeyframeHere={hasKeyframeHere}
            hasAnyKeyframes={hasAnyKeyframes}
            onToggle={onToggleKeyframe}
            onPrev={onPrevKeyframe}
            onNext={onNextKeyframe}
          />
        </div>
      </div>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onMouseUp={(e) => onCommit(parseFloat(e.target.value))}
        onKeyUp={(e) => onCommit(parseFloat(e.target.value))}
        onDoubleClick={onReset}
        title={`Double-click to reset to default`}
        className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
      />
    </div>
  )
}

function KeyframeDiamond({ hasKeyframeHere, hasAnyKeyframes, onToggle, onPrev, onNext }) {
  return (
    <div className="flex items-center gap-0.5">
      {hasAnyKeyframes && (
        <button
          type="button"
          onClick={onPrev}
          className="p-0.5 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-600"
          title="Previous keyframe"
        >
          <ChevronUp className="w-2.5 h-2.5 -rotate-90" />
        </button>
      )}
      <button
        type="button"
        onClick={onToggle}
        className={`p-0.5 rounded transition-colors ${
          hasKeyframeHere
            ? 'text-sf-warning'
            : hasAnyKeyframes
              ? 'text-sf-accent'
              : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-600'
        }`}
        title={hasKeyframeHere ? 'Remove keyframe at current time' : 'Add keyframe at current time'}
      >
        <Diamond className="w-3 h-3" fill={hasKeyframeHere ? 'currentColor' : 'none'} />
      </button>
      {hasAnyKeyframes && (
        <button
          type="button"
          onClick={onNext}
          className="p-0.5 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-600"
          title="Next keyframe"
        >
          <ChevronDown className="w-2.5 h-2.5 -rotate-90" />
        </button>
      )}
    </div>
  )
}

function EffectCard({
  clip,
  effect,
  index,
  totalCount,
  playheadPosition,
  onUpdate,
  onToggle,
  onRemove,
  onReorder,
  onResetEffect,
  onSetKeyframe,
  onRemoveKeyframe,
  onGoToKeyframe,
}) {
  const [expanded, setExpanded] = useState(true)
  const definition = getEffectTypeDefinition(effect.type)
  const Icon = EFFECT_ICONS[effect.type] || Sparkles
  const clipTime = playheadPosition - (clip?.startTime || 0)
  const normalizedEffect = useMemo(() => normalizeEffectSettings(effect), [effect])
  const animatedEffect = useMemo(() => getAnimatedEffectSettings(clip, effect, clipTime), [clip, effect, clipTime])

  if (!definition) return null

  const handleParamChange = (paramKey, value) => {
    const nextSettings = { ...normalizedEffect.settings, [paramKey]: value }
    onUpdate(effect.id, { settings: nextSettings }, false)
  }
  const handleParamCommit = (paramKey, value) => {
    const nextSettings = { ...normalizedEffect.settings, [paramKey]: value }
    onUpdate(effect.id, { settings: nextSettings }, true)
  }
  const handleParamReset = (paramKey) => {
    const nextSettings = { ...normalizedEffect.settings, [paramKey]: definition.defaults[paramKey] }
    onUpdate(effect.id, { settings: nextSettings }, true)
  }

  const handlePresetSelect = (preset) => {
    onUpdate(effect.id, {
      settings: { ...normalizedEffect.settings, ...preset.settings },
    }, true)
  }

  return (
    <div className={`bg-sf-dark-800 rounded overflow-hidden border ${effect.enabled ? 'border-sf-dark-700' : 'border-sf-dark-800'}`}>
      <div className="flex items-center gap-1 px-2 py-1.5 bg-sf-dark-700">
        <button
          type="button"
          onClick={() => onToggle(effect.id)}
          className={`p-1 rounded transition-colors ${effect.enabled ? 'text-sf-accent' : 'text-sf-text-muted'}`}
          title={effect.enabled ? 'Disable effect' : 'Enable effect'}
        >
          {effect.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
        </button>

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex-1 flex items-center gap-1.5 text-left"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <Icon className="w-3 h-3 text-sf-text-secondary" />
          <span className="text-[11px] text-sf-text-primary">{definition.label}</span>
        </button>

        <button
          type="button"
          onClick={() => onReorder(effect.id, -1)}
          disabled={index === 0}
          className="p-1 hover:bg-sf-dark-600 rounded text-sf-text-muted hover:text-sf-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move up"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => onReorder(effect.id, 1)}
          disabled={index === totalCount - 1}
          className="p-1 hover:bg-sf-dark-600 rounded text-sf-text-muted hover:text-sf-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move down"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => onResetEffect(effect.id)}
          className="p-1 hover:bg-sf-dark-600 rounded text-sf-text-muted hover:text-sf-text-primary transition-colors"
          title="Reset effect to defaults"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(effect.id)}
          className="p-1 hover:bg-sf-dark-600 rounded text-sf-text-muted hover:text-sf-error transition-colors"
          title="Remove effect"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {expanded && (
        <div className="p-2 space-y-2">
          {definition.description && (
            <p className="text-[10px] text-sf-text-muted">{definition.description}</p>
          )}

          {definition.presets && definition.presets.length > 0 && (
            <div>
              <div className="text-[10px] text-sf-text-muted mb-1">Presets</div>
              <div className="flex flex-wrap gap-1">
                {definition.presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePresetSelect(preset)}
                    className="px-2 py-0.5 rounded text-[10px] border border-sf-dark-600 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-accent hover:text-sf-text-primary transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {definition.params.map((param) => {
            const propertyId = getEffectPropertyId(effect.id, param.key)
            const paramKeyframes = clip?.keyframes?.[propertyId] || []
            const keyframeAtTime = getKeyframeAtTime(paramKeyframes, clipTime, 0.05)
            const hasKeyframeHere = !!keyframeAtTime
            const hasAnyKeyframes = paramKeyframes.length > 0
            const baseValue = normalizedEffect.settings[param.key]
            const liveValue = animatedEffect.settings[param.key]

            return (
              <EffectParamSlider
                key={param.key}
                clip={clip}
                effect={effect}
                param={param}
                value={baseValue}
                animatedValue={hasAnyKeyframes ? liveValue : null}
                hasKeyframeHere={hasKeyframeHere}
                hasAnyKeyframes={hasAnyKeyframes}
                onChange={(val) => handleParamChange(param.key, val)}
                onCommit={(val) => handleParamCommit(param.key, val)}
                onReset={() => handleParamReset(param.key)}
                onToggleKeyframe={() => {
                  if (hasKeyframeHere) {
                    onRemoveKeyframe(propertyId, clipTime)
                  } else {
                    onSetKeyframe(propertyId, clipTime, liveValue)
                  }
                }}
                onPrevKeyframe={() => onGoToKeyframe(propertyId, 'prev')}
                onNextKeyframe={() => onGoToKeyframe(propertyId, 'next')}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Render the effect stack for a clip, limited to the managed stylistic
 * effect types (camera shake, chromatic aberration, film grain, vignette).
 *
 * Mask effects are managed by the existing Inspector UI so we skip them
 * here to avoid duplicating controls.
 */
export default function EffectsStack({
  clip,
  playheadPosition,
  addEffect,
  removeEffect,
  updateEffect,
  toggleEffect,
  reorderEffect,
  setKeyframe,
  removeKeyframe,
  goToNextKeyframe,
  goToPrevKeyframe,
}) {
  const [isAddOpen, setIsAddOpen] = useState(false)
  const managedEffects = useMemo(
    () => (clip?.effects || []).filter((effect) => isManagedEffectType(effect?.type)),
    [clip?.effects]
  )

  const handleAdd = useCallback((typeId) => {
    const def = getEffectTypeDefinition(typeId)
    if (!def) return
    addEffect(clip.id, {
      type: typeId,
      settings: { ...def.defaults },
    })
    setIsAddOpen(false)
  }, [addEffect, clip])

  const handleReset = useCallback((effectId) => {
    const effect = managedEffects.find((e) => e.id === effectId)
    if (!effect) return
    const def = getEffectTypeDefinition(effect.type)
    if (!def) return
    updateEffect(clip.id, effectId, { settings: { ...def.defaults } }, true)
  }, [managedEffects, updateEffect, clip])

  const handleReorder = useCallback((effectId, direction) => {
    const allEffects = clip?.effects || []
    const fromIndex = allEffects.findIndex((e) => e.id === effectId)
    if (fromIndex === -1) return

    const managedPositions = allEffects
      .map((e, i) => (isManagedEffectType(e?.type) ? i : -1))
      .filter((i) => i !== -1)
    const managedPos = managedPositions.indexOf(fromIndex)
    if (managedPos === -1) return

    const targetManagedPos = managedPos + direction
    if (targetManagedPos < 0 || targetManagedPos >= managedPositions.length) return

    const targetIndex = managedPositions[targetManagedPos]
    const steps = targetIndex - fromIndex
    const stepDir = steps > 0 ? 1 : -1
    for (let i = 0; i < Math.abs(steps); i += 1) {
      reorderEffect(clip.id, effectId, stepDir)
    }
  }, [reorderEffect, clip])

  const handleGoToKeyframe = useCallback((propertyId, direction) => {
    if (direction === 'prev') {
      goToPrevKeyframe(clip.id, propertyId)
    } else {
      goToNextKeyframe(clip.id, propertyId)
    }
  }, [clip, goToNextKeyframe, goToPrevKeyframe])

  const handleSetKeyframe = useCallback((propertyId, clipTime, value) => {
    setKeyframe(clip.id, propertyId, clipTime, value, 'easeInOut', { saveHistory: true })
  }, [setKeyframe, clip])

  const handleRemoveKeyframe = useCallback((propertyId, clipTime) => {
    removeKeyframe(clip.id, propertyId, clipTime, { saveHistory: true })
  }, [removeKeyframe, clip])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">
          Effects{managedEffects.length > 0 ? ` (${managedEffects.length})` : ''}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsAddOpen((prev) => !prev)}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-sf-dark-600 bg-sf-dark-800 text-[10px] text-sf-text-secondary hover:border-sf-accent hover:text-sf-text-primary transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Effect
          </button>
          {isAddOpen && (
            <div className="absolute right-0 top-full mt-1 z-10 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl min-w-[230px] max-h-80 overflow-y-auto py-1">
              {EFFECT_PICKER_GROUPS.map((group) => (
                <div key={group.id} className="py-1">
                  <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-sf-text-muted">
                    {group.label}
                  </div>
                  {group.effects.map((def) => {
                    const Icon = EFFECT_ICONS[def.id] || Sparkles
                    return (
                      <button
                        key={def.id}
                        type="button"
                        onClick={() => handleAdd(def.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-sf-dark-700 transition-colors"
                      >
                        <Icon className="w-3.5 h-3.5 text-sf-text-secondary" />
                        <span className="text-[11px] text-sf-text-primary">{def.label}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {managedEffects.length === 0 && (
        <div className="text-[10px] text-sf-text-muted italic bg-sf-dark-900/40 border border-dashed border-sf-dark-700 rounded p-3 text-center">
          No effects on this clip. Add one to get started.
        </div>
      )}

      {managedEffects.map((effect, managedIdx) => {
        return (
          <EffectCard
            key={effect.id}
            clip={clip}
            effect={effect}
            index={managedIdx}
            totalCount={managedEffects.length}
            playheadPosition={playheadPosition}
            onUpdate={(effectId, updates, saveHistory) => updateEffect(clip.id, effectId, updates, saveHistory)}
            onToggle={(effectId) => toggleEffect(clip.id, effectId)}
            onRemove={(effectId) => removeEffect(clip.id, effectId)}
            onReorder={handleReorder}
            onResetEffect={handleReset}
            onSetKeyframe={handleSetKeyframe}
            onRemoveKeyframe={handleRemoveKeyframe}
            onGoToKeyframe={handleGoToKeyframe}
          />
        )
      })}
    </div>
  )
}
