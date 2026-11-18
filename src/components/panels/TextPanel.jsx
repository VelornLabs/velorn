import { Type, AlignLeft, AlignCenter, AlignRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTimelineStore } from '../../stores/timelineStore'
import { TEXT_ANIMATION_PRESETS, TEXT_ANIMATION_MODE_OPTIONS } from '../../utils/textAnimationPresets'
import { useI18n } from '../../i18n/I18nContext'
import { quoteCssFontFamily } from '../../utils/fontFamily'
import FontFamilyPicker from '../FontFamilyPicker'
import { useTimelineFields } from '../../hooks/useTimelineFields'

// The playhead is read at the moment text is added, not subscribed to.
const TEXT_PANEL_TIMELINE_FIELDS = ['addTextClip', 'applyTextAnimationPreset', 'tracks', 'activeTrackId', 'requestTextEdit']

function TextPanel() {
  const { t } = useI18n()
  // Timeline store for adding text clips
  const {
    addTextClip,
    applyTextAnimationPreset,
    tracks,
    activeTrackId,
    requestTextEdit,
  } = useTimelineFields(TEXT_PANEL_TIMELINE_FIELDS)
  
  // Text generation state
  const [textContent, setTextContent] = useState(() => t('textPanel.sampleText'))
  const [textFontFamily, setTextFontFamily] = useState('Inter')
  const [textFontSize, setTextFontSize] = useState(64)
  const [textFontWeight, setTextFontWeight] = useState('bold')
  const [textColor, setTextColor] = useState('#FFFFFF')
  const [textStrokeColor, setTextStrokeColor] = useState('#000000')
  const [textStrokeWidth, setTextStrokeWidth] = useState(0)
  const [textDuration, setTextDuration] = useState(5)
  const [textBackgroundColor, setTextBackgroundColor] = useState('#000000')
  const [textBackgroundOpacity, setTextBackgroundOpacity] = useState(0)
  const [textShadow, setTextShadow] = useState(false)
  const [textAlign, setTextAlign] = useState('center')
  const [animationPreset, setAnimationPreset] = useState('none')
  const [animationMode, setAnimationMode] = useState('inOut')

  const preferredVideoTrack = useMemo(() => {
    const activeVideoTrack = tracks.find((track) => track.id === activeTrackId && track.type === 'video')
    if (activeVideoTrack) return activeVideoTrack
    return tracks.find((track) => track.type === 'video') || null
  }, [tracks, activeTrackId])

  // Handle adding text to timeline
  const handleAddText = () => {
    if (!preferredVideoTrack) return
    
    const newClip = addTextClip(preferredVideoTrack.id, {
      text: textContent,
      fontFamily: textFontFamily,
      fontSize: textFontSize,
      fontWeight: textFontWeight,
      textColor: textColor,
      textAlign: textAlign,
      strokeColor: textStrokeColor,
      strokeWidth: textStrokeWidth,
      backgroundColor: textBackgroundColor,
      backgroundOpacity: textBackgroundOpacity,
      shadow: textShadow,
      duration: textDuration,
    }, useTimelineStore.getState().playheadPosition)

    if (newClip && animationPreset !== 'none') {
      applyTextAnimationPreset(newClip.id, animationPreset, animationMode, { saveHistory: false })
    }

    if (newClip) {
      requestTextEdit(newClip.id, { selectAll: true })
    }
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="p-3 space-y-4">
        {/* Text Content */}
        <div>
          <label className="text-xs font-medium text-sf-text-primary mb-1.5 block">{t('textPanel.textContent')}</label>
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            className="w-full h-24 bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 text-xs text-sf-text-primary placeholder-sf-text-muted resize-none focus:outline-none focus:border-sf-accent transition-colors"
            placeholder={t('textPanel.placeholder')}
          />
        </div>

        {/* Font Settings */}
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-sf-text-secondary mb-1 block">{t('textPanel.fontFamily')}</label>
            <FontFamilyPicker
              value={textFontFamily}
              onChange={setTextFontFamily}
              ariaLabel={t('textPanel.fontFamily')}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Font Size */}
            <div>
              <label className="text-[10px] text-sf-text-secondary mb-1 block">{t('textPanel.size', { size: textFontSize })}</label>
              <input
                type="range"
                min="12"
                max="200"
                value={textFontSize}
                onChange={(e) => setTextFontSize(parseInt(e.target.value))}
                className="w-full h-1.5 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Font Weight */}
            <div>
              <label className="text-[10px] text-sf-text-secondary mb-1 block">{t('textPanel.weight')}</label>
              <select
                value={textFontWeight}
                onChange={(e) => setTextFontWeight(e.target.value)}
                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                <option value="normal">{t('textPanel.weights.normal')}</option>
                <option value="bold">{t('textPanel.weights.bold')}</option>
                <option value="100">{t('textPanel.weights.thin')}</option>
                <option value="300">{t('textPanel.weights.light')}</option>
                <option value="500">{t('textPanel.weights.medium')}</option>
                <option value="600">{t('textPanel.weights.semiBold')}</option>
                <option value="800">{t('textPanel.weights.extraBold')}</option>
                <option value="900">{t('textPanel.weights.black')}</option>
              </select>
            </div>
          </div>

          {/* Text Alignment */}
          <div>
            <label className="text-[10px] text-sf-text-secondary mb-1.5 block">{t('textPanel.alignment')}</label>
            <div className="flex gap-1">
              {[
                { value: 'left', icon: AlignLeft, label: t('textPanel.left') },
                { value: 'center', icon: AlignCenter, label: t('textPanel.center') },
                { value: 'right', icon: AlignRight, label: t('textPanel.right') },
              ].map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => setTextAlign(value)}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs transition-colors ${
                    textAlign === value
                      ? 'bg-sf-accent text-white'
                      : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                  }`}
                  title={label}
                >
                  <Icon className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Colors Section */}
        <div className="space-y-3">
          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider block">{t('textPanel.colors')}</label>
          
          <div className="grid grid-cols-2 gap-3">
            {/* Text Color */}
            <div>
              <label className="text-[10px] text-sf-text-secondary mb-1 block">{t('textPanel.textColor')}</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={textColor}
                  onChange={(e) => setTextColor(e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={textColor}
                  onChange={(e) => setTextColor(e.target.value)}
                  className="flex-1 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
            </div>

            {/* Stroke Color */}
            <div>
              <label className="text-[10px] text-sf-text-secondary mb-1 block">{t('textPanel.strokeColor')}</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={textStrokeColor}
                  onChange={(e) => setTextStrokeColor(e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={textStrokeColor}
                  onChange={(e) => setTextStrokeColor(e.target.value)}
                  className="flex-1 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
            </div>
          </div>

          {/* Stroke Width */}
          <div>
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-sf-text-secondary">{t('textPanel.strokeWidth')}</span>
              <span className="text-sf-text-muted">{textStrokeWidth}px</span>
            </div>
            <input
              type="range"
              min="0"
              max="10"
              value={textStrokeWidth}
              onChange={(e) => setTextStrokeWidth(parseInt(e.target.value))}
              className="w-full h-1.5 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
          </div>
        </div>

        {/* Background Section */}
        <div className="space-y-3">
          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider block">{t('textPanel.background')}</label>
          
          <div className="grid grid-cols-2 gap-3">
            {/* Background Color */}
            <div>
              <label className="text-[10px] text-sf-text-secondary mb-1 block">{t('textPanel.color')}</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={textBackgroundColor}
                  onChange={(e) => setTextBackgroundColor(e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={textBackgroundColor}
                  onChange={(e) => setTextBackgroundColor(e.target.value)}
                  className="flex-1 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
            </div>

            {/* Background Opacity */}
            <div>
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-sf-text-secondary">{t('textPanel.opacity')}</span>
                <span className="text-sf-text-muted">{textBackgroundOpacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={textBackgroundOpacity}
                onChange={(e) => setTextBackgroundOpacity(parseInt(e.target.value))}
                className="w-full h-1.5 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>
          </div>
        </div>

        {/* Effects */}
        <div className="flex items-center gap-2 p-2 bg-sf-dark-800 rounded-lg">
          <input
            type="checkbox"
            id="textShadow"
            checked={textShadow}
            onChange={(e) => setTextShadow(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-sf-dark-600 bg-sf-dark-700 text-sf-accent focus:ring-sf-accent focus:ring-offset-0 cursor-pointer"
          />
          <label htmlFor="textShadow" className="text-[11px] text-sf-text-secondary cursor-pointer flex-1">
            {t('textPanel.dropShadow')}
          </label>
        </div>

        {/* Duration */}
        <div>
          <div className="flex justify-between text-[10px] mb-1">
            <span className="text-sf-text-secondary">{t('textPanel.duration')}</span>
            <span className="text-sf-text-muted">{textDuration}s</span>
          </div>
          <div className="flex gap-0.5">
            {[2, 3, 5, 8, 10].map(d => (
              <button
                key={d}
                onClick={() => setTextDuration(d)}
                className={`flex-1 py-1 rounded text-[10px] transition-colors ${
                  textDuration === d ? 'bg-sf-accent text-white' : 'bg-sf-dark-700 text-sf-text-muted'
                }`}
              >
                {d}s
              </button>
            ))}
          </div>
        </div>

        {/* Title Animation Presets */}
        <div className="space-y-2">
          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider block">{t('textPanel.titleAnimation')}</label>
          <div className="grid grid-cols-3 gap-1">
            {TEXT_ANIMATION_MODE_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setAnimationMode(option.id)}
                className={`py-1 rounded text-[10px] transition-colors ${
                  animationMode === option.id
                    ? 'bg-sf-accent text-white'
                    : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                }`}
              >
                {t(`textPanel.animationModes.${option.id}`, undefined, option.label)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => setAnimationPreset('none')}
              className={`px-2 py-1 rounded text-[10px] transition-colors ${
                animationPreset === 'none'
                  ? 'bg-sf-accent text-white'
                  : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
              }`}
            >
              {t('textPanel.none')}
            </button>
            {TEXT_ANIMATION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => setAnimationPreset(preset.id)}
                className={`px-2 py-1 rounded text-[10px] transition-colors ${
                  animationPreset === preset.id
                    ? 'bg-sf-accent text-white'
                    : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                }`}
              >
                {t(`textPanel.animationPresets.${preset.id}`, undefined, preset.name)}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-sf-text-muted">
            {t('textPanel.animationHelp')}
          </p>
        </div>

        {/* Preview */}
        <div className="bg-sf-dark-800 rounded-lg p-4 relative overflow-hidden">
          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider block mb-2">{t('textPanel.preview')}</label>
          <div 
            className="min-h-[80px] flex items-center justify-center rounded"
            style={{
              backgroundColor: textBackgroundOpacity > 0 
                ? `${textBackgroundColor}${Math.round(textBackgroundOpacity * 2.55).toString(16).padStart(2, '0')}`
                : 'transparent',
              justifyContent: textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center',
              padding: '8px'
            }}
          >
            <span
              style={{
                fontFamily: quoteCssFontFamily(textFontFamily),
                fontSize: `${Math.min(textFontSize, 32)}px`,
                fontWeight: textFontWeight,
                color: textColor,
                textShadow: textShadow ? '2px 2px 4px rgba(0,0,0,0.5)' : 'none',
                WebkitTextStroke: textStrokeWidth > 0 ? `${textStrokeWidth}px ${textStrokeColor}` : 'none',
                paintOrder: 'stroke fill',
              }}
            >
              {textContent || t('textPanel.sampleText')}
            </span>
          </div>
        </div>

        {/* Add to Timeline Button */}
        <div className="space-y-2">
          <button
            onClick={handleAddText}
            disabled={!preferredVideoTrack}
            className={`w-full py-2.5 rounded-lg font-medium text-white flex items-center justify-center gap-2 transition-colors text-sm ${
              preferredVideoTrack
                ? 'bg-sf-accent hover:bg-sf-accent-hover'
                : 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
            }`}
          >
            <Type className="w-4 h-4" />
            {t('textPanel.addToTimeline')}
          </button>
          
          <p className="text-[10px] text-sf-text-muted text-center">
            {preferredVideoTrack
              ? t('textPanel.addAtPlayhead', { track: preferredVideoTrack.name })
              : t('textPanel.noVideoTrack')}
          </p>
        </div>

        {/* Text Presets */}
        <div className="pt-3 border-t border-sf-dark-700">
          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-2 block">{t('textPanel.presets')}</label>
          <div className="flex flex-wrap gap-1">
            {[
              { name: 'Title', size: 72, weight: 'bold', color: '#FFFFFF' },
              { name: 'Subtitle', size: 36, weight: 'normal', color: '#CCCCCC' },
              { name: 'Lower Third', size: 24, weight: '500', color: '#FFFFFF', stroke: 1 },
              { name: 'Caption', size: 18, weight: 'normal', color: '#FFFFFF', bg: 50 },
            ].map(preset => (
              <button
                key={preset.name}
                onClick={() => {
                  setTextFontSize(preset.size)
                  setTextFontWeight(preset.weight)
                  setTextColor(preset.color)
                  if (preset.stroke) setTextStrokeWidth(preset.stroke)
                  if (preset.bg) setTextBackgroundOpacity(preset.bg)
                }}
                className="px-2 py-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[10px] text-sf-text-secondary transition-colors"
              >
                {t(`textPanel.stylePresets.${preset.name.replaceAll(' ', '')}`, undefined, preset.name)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default TextPanel
