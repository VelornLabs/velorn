import { useEffect, useMemo, useState, useRef } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, Film, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowLeftToLine, ArrowRightToLine, Repeat, Repeat1, ArrowLeftRight, Check } from 'lucide-react'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import TimelineSwitcher from './TimelineSwitcher'
import { isTextEditingElement } from '../utils/keyboardFocus'

// Playback mode options
const PLAYBACK_MODES = [
  { id: 'normal', label: 'Normal', description: 'Play once and stop', icon: null },
  { id: 'loop', label: 'Loop', description: 'Loop entire timeline', icon: Repeat },
  { id: 'loop-in-out', label: 'In to Out', description: 'Loop between In/Out points', icon: Repeat1 },
  { id: 'loop-selection', label: 'Selection', description: 'Loop selected clip range', icon: Film },
  { id: 'ping-pong', label: 'Back and Forth', description: 'Play forward then reverse', icon: ArrowLeftRight },
]

function TransportControls() {
  // Track if K is held for slow shuttle
  const [isKHeld, setIsKHeld] = useState(false)
  // Distinguish Space tap (play/pause) from Space+drag (pan/zoom modifiers)
  const pendingSpaceToggleRef = useRef(false)
  const spaceUsedAsModifierRef = useRef(false)
  
  // Context menu state for playback mode
  const [showPlaybackMenu, setShowPlaybackMenu] = useState(false)
  const playButtonRef = useRef(null)
  const menuRef = useRef(null)
  
  // Asset store (for single asset preview)
  const { 
    currentPreview,
    isPlaying: assetIsPlaying, 
    currentTime: assetCurrentTime, 
    duration: assetDuration, 
    volume,
    togglePlay: assetTogglePlay,
    seekTo: assetSeekTo,
    setVolume,
    previewMode,
    mediaPreparation,
  } = useAssetsStore()
  
  // Timeline store (for timeline playback)
  const {
    isPlaying: timelineIsPlaying,
    playheadPosition,
    setPlayheadPosition,
    togglePlay: timelineTogglePlay,
    getTimelineEndTime,
    clips,
    selectedClipIds,
    playbackRate,
    shuttleMode,
    shuttleForward,
    shuttleReverse,
    shuttlePause,
    shuttleSlow,
    inPoint,
    outPoint,
    setInPoint,
    setOutPoint,
    clearInOutPoints,
    goToInPoint,
    goToOutPoint,
    loopMode,
    setLoopMode
  } = useTimelineStore()

  // Project store (for timeline FPS)
  const { getCurrentTimelineSettings } = useProjectStore()
  
  // Use the actual preview mode from assets store
  // Timeline mode when previewMode is 'timeline' AND there are clips
  // Asset mode when previewMode is 'asset' AND there's an asset selected
  const timelineMode = previewMode === 'timeline' && clips.length > 0
  const endTime = getTimelineEndTime()
  
  // Unified values based on current preview mode
  const isPlaying = timelineMode ? timelineIsPlaying : assetIsPlaying
  const currentTime = timelineMode ? playheadPosition : assetCurrentTime
  const duration = timelineMode ? (endTime || 60) : assetDuration
  const hasContent = timelineMode ? clips.length > 0 : currentPreview !== null
  const playDisabled = !hasContent || Boolean(mediaPreparation?.critical)

  const selectedLoopRange = useMemo(() => {
    if (!timelineMode) return null
    if (!Array.isArray(selectedClipIds) || selectedClipIds.length === 0) return null

    const selectedSet = new Set(selectedClipIds)
    const selectedTimelineClips = clips.filter((clip) => selectedSet.has(clip.id))
    if (selectedTimelineClips.length === 0) return null

    let start = Infinity
    let end = -Infinity
    for (const clip of selectedTimelineClips) {
      const clipStart = Number(clip.startTime)
      const clipDuration = Math.max(0, Number(clip.duration) || 0)
      if (!Number.isFinite(clipStart)) continue
      const clipEnd = clipStart + clipDuration
      start = Math.min(start, clipStart)
      end = Math.max(end, clipEnd)
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null
    }

    return {
      start: Math.max(0, start),
      end: Math.max(0, end),
      clipCount: selectedTimelineClips.length,
    }
  }, [clips, selectedClipIds, timelineMode])
  const hasSelectedLoopRange = Boolean(selectedLoopRange)

  // Frame rate for frame stepping - use actual timeline FPS
  const timelineSettings = getCurrentTimelineSettings()
  const fps = timelineSettings?.fps || 24
  const frameStep = 1 / fps

  // Format time as HH:MM:SS:FF (hours:minutes:seconds:frames)
  const formatTimecode = (seconds) => {
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)
    const frames = Math.floor((seconds % 1) * fps)
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`
  }
  
  // Unified controls
  const togglePlay = () => {
    if (playDisabled) return
    if (timelineMode) {
      timelineTogglePlay()
    } else {
      assetTogglePlay()
    }
  }
  
  const seekTo = (time) => {
    if (timelineMode) {
      setPlayheadPosition(Math.max(0, Math.min(duration, time)))
    } else {
      assetSeekTo(time)
    }
  }
  
  // Navigation controls
  const goToStart = () => seekTo(0)
  const goToEnd = () => seekTo(duration)
  
  const frameBack = () => {
    seekTo(Math.max(0, currentTime - frameStep))
  }
  
  const frameForward = () => {
    seekTo(Math.min(duration, currentTime + frameStep))
  }
  
  const previousClip = () => {
    if (!timelineMode) return goToStart()
    const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime)
    const prevClip = sortedClips.reverse().find(c => c.startTime < currentTime - 0.01)
    if (prevClip) {
      seekTo(prevClip.startTime)
    } else {
      goToStart()
    }
  }
  
  const nextClip = () => {
    if (!timelineMode) return goToEnd()
    const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime)
    const nextClipItem = sortedClips.find(c => c.startTime > currentTime + 0.01)
    if (nextClipItem) {
      seekTo(nextClipItem.startTime)
    } else {
      goToEnd()
    }
  }

  // JKL Shuttle keyboard handlers
  useEffect(() => {
    const handleKeyDown = (e) => {
      const active = document.activeElement
      const target = e.target
      if (isTextEditingElement(active) || isTextEditingElement(target)) return

      // Reserve timeline frame-step on Left/Right globally so inspector controls
      // don't trap arrow keys when the user expects timeline navigation.
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        frameBack()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        frameForward()
        return
      }

      // JKL Controls
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        if (isKHeld) {
          // K+J = slow reverse
          shuttleSlow('reverse')
        } else {
          shuttleReverse()
        }
      }
      
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setIsKHeld(true)
        shuttlePause()
      }
      
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        if (isKHeld) {
          // K+L = slow forward
          shuttleSlow('forward')
        } else {
          shuttleForward()
        }
      }
      
      // I/O Points
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault()
        setInPoint()
      }
      
      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault()
        setOutPoint()
      }
      
      // Clear I/O with Option/Alt + X
      if ((e.altKey || e.metaKey) && e.key === 'x') {
        e.preventDefault()
        clearInOutPoints()
      }
      
      // Enter = Play/Pause toggle (legacy shortcut)
      if (e.key === 'Enter' && !e.repeat) {
        const target = e.target
        if (isTextEditingElement(target)) return
        if (!playDisabled) {
          e.preventDefault()
          togglePlay()
        }
      }
      
      // Space = Play/Pause toggle on keyup.
      // We defer to keyup so Space+drag (pan/zoom in timeline/preview) doesn't toggle playback.
      if (e.code === 'Space' && !e.repeat) {
        if (playDisabled) return
        pendingSpaceToggleRef.current = true
        spaceUsedAsModifierRef.current = false
        e.preventDefault()
      }
      
    }
    
    const handleKeyUp = (e) => {
      if (e.key === 'k' || e.key === 'K') {
        setIsKHeld(false)
      }

      if (e.code === 'Space') {
        const shouldToggle = pendingSpaceToggleRef.current && !spaceUsedAsModifierRef.current
        pendingSpaceToggleRef.current = false
        spaceUsedAsModifierRef.current = false
        if (shouldToggle && !playDisabled) {
          e.preventDefault()
          togglePlay()
        }
      }
    }

    const handleMouseDown = () => {
      if (pendingSpaceToggleRef.current) {
        spaceUsedAsModifierRef.current = true
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('mousedown', handleMouseDown)
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('mousedown', handleMouseDown)
    }
  }, [isKHeld, playDisabled, isPlaying, togglePlay, shuttleReverse, shuttlePause, shuttleForward, shuttleSlow, setInPoint, setOutPoint, clearInOutPoints, frameBack, frameForward])

  // Format playback rate display
  const getPlaybackRateDisplay = () => {
    if (!shuttleMode || playbackRate === 1) return null
    const absRate = Math.abs(playbackRate)
    const direction = playbackRate < 0 ? '◀' : '▶'
    if (absRate < 1) {
      return `${direction} ${absRate}x`
    }
    return `${direction}${direction.repeat(Math.log2(absRate))} ${absRate}x`
  }

  // Handle right-click on play button
  const handlePlayContextMenu = (e) => {
    e.preventDefault()
    setShowPlaybackMenu(true)
  }

  // Close playback menu when clicking outside
  useEffect(() => {
    if (!showPlaybackMenu) return

    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target) &&
          playButtonRef.current && !playButtonRef.current.contains(e.target)) {
        setShowPlaybackMenu(false)
      }
    }

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        setShowPlaybackMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [showPlaybackMenu])

  // Get current loop mode info
  const currentLoopMode = PLAYBACK_MODES.find(m => m.id === loopMode) || PLAYBACK_MODES[0]
  const LoopIcon = currentLoopMode.icon

  return (
    <div className="h-10 bg-sf-dark-900 border-b border-sf-dark-700 flex items-center px-4 flex-shrink-0">
      {/* Left side - Timeline Switcher + Mode indicator + I/O Points */}
      <div className="flex-1 flex items-center gap-2">
        {/* Timeline Switcher */}
        <TimelineSwitcher />
        
        {/* Loop Mode Indicator */}
        {loopMode !== 'normal' && (
          <button
            onClick={() => setShowPlaybackMenu(true)}
            className="flex items-center gap-1 px-2 py-0.5 bg-green-500/20 rounded text-[10px] text-green-400 hover:bg-green-500/30 transition-colors"
            title={`Playback: ${currentLoopMode.label} • Click to change`}
          >
            {LoopIcon && <LoopIcon className="w-3 h-3" />}
            {currentLoopMode.label}
          </button>
        )}
        
        {/* Playback Rate Indicator */}
        {shuttleMode && playbackRate !== 1 && (
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono ${
            playbackRate < 0 ? 'bg-sf-accent/20 text-sf-accent' : 'bg-green-500/20 text-green-400'
          }`}>
            {getPlaybackRateDisplay()}
          </div>
        )}
        
        {/* I/O Point Controls */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => inPoint !== null ? goToInPoint() : setInPoint()}
            onDoubleClick={() => setInPoint()}
            className={`p-1 rounded text-[10px] transition-colors ${
              inPoint !== null 
                ? 'bg-[#5a7a9e]/20 text-[#7a9ab8] hover:bg-[#5a7a9e]/30' 
                : 'hover:bg-sf-dark-700 text-sf-text-muted'
            }`}
            title={inPoint !== null ? `In: ${formatTimecode(inPoint)} (I to set, click to go)` : 'Set In Point (I)'}
          >
            <ArrowLeftToLine className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => outPoint !== null ? goToOutPoint() : setOutPoint()}
            onDoubleClick={() => setOutPoint()}
            className={`p-1 rounded text-[10px] transition-colors ${
              outPoint !== null 
                ? 'bg-[#5a7a9e]/20 text-[#7a9ab8] hover:bg-[#5a7a9e]/30' 
                : 'hover:bg-sf-dark-700 text-sf-text-muted'
            }`}
            title={outPoint !== null ? `Out: ${formatTimecode(outPoint)} (O to set, click to go)` : 'Set Out Point (O)'}
          >
            <ArrowRightToLine className="w-3.5 h-3.5" />
          </button>
          {(inPoint !== null || outPoint !== null) && (
            <button
              onClick={clearInOutPoints}
              className="p-1 hover:bg-sf-dark-700 rounded text-[9px] text-sf-text-muted transition-colors"
              title="Clear In/Out Points (Alt+X)"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      
      {/* Center controls - Full transport */}
      <div className="flex items-center gap-1">
        {/* Go to Start */}
        <button 
          onClick={goToStart}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          disabled={!hasContent}
          title="Go to Start (Home)"
        >
          <SkipBack className="w-4 h-4 text-sf-text-secondary" />
        </button>
        
        {/* Previous Clip */}
        <button 
          onClick={previousClip}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          disabled={!hasContent}
          title="Previous Clip"
        >
          <ChevronsLeft className="w-4 h-4 text-sf-text-secondary" />
        </button>
        
        {/* Frame Back */}
        <button 
          onClick={frameBack}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          disabled={!hasContent}
          title="Frame Back"
        >
          <ChevronLeft className="w-4 h-4 text-sf-text-secondary" />
        </button>
        
        {/* Play/Pause with Loop Mode Context Menu */}
        <div className="relative">
          <button 
            ref={playButtonRef}
            onClick={togglePlay}
            onContextMenu={handlePlayContextMenu}
            className={`p-2 mx-1 rounded-full transition-colors relative ${
              !playDisabled 
                ? 'bg-sf-blue hover:bg-sf-blue-hover' 
                : 'bg-sf-dark-600 cursor-not-allowed'
            }`}
            disabled={playDisabled}
            title={mediaPreparation?.critical
              ? 'Project media is still loading'
              : `${isPlaying ? 'Pause' : 'Play'} • Space/Enter = Play/Pause • Right-click for playback mode`}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 text-white" />
            ) : (
              <Play className="w-4 h-4 text-white ml-0.5" />
            )}
            {/* Loop Mode Indicator Badge */}
            {loopMode !== 'normal' && LoopIcon && (
              <div className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-green-500 rounded-full flex items-center justify-center">
                <LoopIcon className="w-2 h-2 text-white" />
              </div>
            )}
          </button>

          {/* Playback Mode Context Menu */}
          {showPlaybackMenu && (
            <div 
              ref={menuRef}
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[200px] z-50"
            >
              <div className="px-3 py-1.5 border-b border-sf-dark-600">
                <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Playback Mode</span>
              </div>
              
              {PLAYBACK_MODES.map((mode) => {
                const ModeIcon = mode.icon
                const isActive = loopMode === mode.id
                const missingInOutRange = mode.id === 'loop-in-out' && (inPoint === null && outPoint === null)
                const missingSelectionRange = mode.id === 'loop-selection' && !hasSelectedLoopRange
                const isDisabled = missingInOutRange || missingSelectionRange
                
                return (
                  <button
                    key={mode.id}
                    onClick={() => {
                      if (!isDisabled) {
                        setLoopMode(mode.id)
                        setShowPlaybackMenu(false)
                      }
                    }}
                    disabled={isDisabled}
                    className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 transition-colors ${
                      isActive 
                        ? 'bg-sf-accent/20 text-sf-accent' 
                        : isDisabled 
                          ? 'text-sf-text-muted/50 cursor-not-allowed'
                          : 'text-sf-text-primary hover:bg-sf-dark-700'
                    }`}
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      {ModeIcon ? (
                        <ModeIcon className={`w-4 h-4 ${isActive ? 'text-sf-accent' : ''}`} />
                      ) : (
                        <Play className={`w-3.5 h-3.5 ${isActive ? 'text-sf-accent' : ''}`} />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium">{mode.label}</div>
                      <div className={`text-[10px] ${isActive ? 'text-sf-accent/70' : 'text-sf-text-muted'}`}>
                        {mode.description}
                        {missingInOutRange && ' (set I/O points first)'}
                        {missingSelectionRange && ' (select one or more clips first)'}
                        {mode.id === 'loop-selection' && hasSelectedLoopRange
                          ? ` (${selectedLoopRange.clipCount} clip${selectedLoopRange.clipCount === 1 ? '' : 's'})`
                          : ''}
                      </div>
                    </div>
                    {isActive && (
                      <Check className="w-4 h-4 text-sf-accent" />
                    )}
                  </button>
                )
              })}
              
              <div className="px-3 py-1.5 border-t border-sf-dark-600 mt-1">
                <span className="text-[10px] text-sf-text-muted">
                  Right-click play button to change
                </span>
              </div>
            </div>
          )}
        </div>
        
        {/* Frame Forward */}
        <button 
          onClick={frameForward}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          disabled={!hasContent}
          title="Frame Forward"
        >
          <ChevronRight className="w-4 h-4 text-sf-text-secondary" />
        </button>
        
        {/* Next Clip */}
        <button 
          onClick={nextClip}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          disabled={!hasContent}
          title="Next Clip"
        >
          <ChevronsRight className="w-4 h-4 text-sf-text-secondary" />
        </button>
        
        {/* Go to End */}
        <button 
          onClick={goToEnd}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          disabled={!hasContent}
          title="Go to End (End)"
        >
          <SkipForward className="w-4 h-4 text-sf-text-secondary" />
        </button>
        
        {/* Timecode Display */}
        <div className="ml-3 px-2 py-0.5 bg-sf-dark-950 rounded font-mono text-xs text-sf-text-primary">
          {formatTimecode(currentTime)}
        </div>
        <span className="text-sf-text-muted text-xs mx-1">/</span>
        <div className="px-2 py-0.5 bg-sf-dark-950/50 rounded font-mono text-xs text-sf-text-muted">
          {formatTimecode(duration)}
        </div>
      </div>
      
      {/* Right side - volume */}
      <div className="flex-1 flex items-center justify-end gap-2">
        <Volume2 className="w-4 h-4 text-sf-text-muted" />
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="w-20 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
        />
      </div>
    </div>
  )
}

export default TransportControls
