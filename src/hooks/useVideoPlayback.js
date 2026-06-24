import { useEffect, useRef, useCallback, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import videoCache from '../services/videoCache'

/**
 * Hook for managing seamless video playback with preloading
 * 
 * This hook handles:
 * - Preloading upcoming clips before they're needed
 * - Seamless transitions between clips (no black flicker)
 * - Multi-layer compositing with cached videos
 * - Sync between timeline position and video playback
 */
export function useVideoPlayback() {
  // Track which clips are currently being rendered
  const [activeClipIds, setActiveClipIds] = useState([])
  const [readyStates, setReadyStates] = useState({})
  
  // Refs for tracking state without re-renders
  const lastPreloadTime = useRef(0)
  const preloadIntervalRef = useRef(null)
  
  const {
    clips,
    tracks,
    isPlaying,
    playheadPosition,
    playbackRate,
    getActiveClipsAtTime,
  } = useTimelineStore()

  /**
   * Get all video clips that should be visible at the current time
   * Returns clips sorted by layer order (bottom to top)
   */
  const getVisibleClips = useCallback((time) => {
    const allActive = getActiveClipsAtTime(time)
    
    // Filter to only video tracks and sort by track index
    const videoClips = allActive
      .filter(({ track }) => track.type === 'video')
      .map(({ clip, track }) => {
        const trackIndex = tracks.findIndex(t => t.id === track.id)
        return { clip, track, trackIndex }
      })
      // Sort by track index descending (Video 2 renders first/behind, Video 1 on top)
      .sort((a, b) => b.trackIndex - a.trackIndex)
    
    return videoClips
  }, [getActiveClipsAtTime, tracks])

  /**
   * Preload upcoming clips based on current playhead position
   */
  const preloadUpcoming = useCallback(() => {
    if (clips.length === 0) return
    
    // Only preload every 500ms to avoid excessive calls
    const now = Date.now()
    if (now - lastPreloadTime.current < 500) return
    lastPreloadTime.current = now
    
    const enabledTrackIds = new Set(
      tracks
        .filter((track) => track.type === 'video' && track.enabled !== false)
        .map((track) => track.id)
    )
    videoCache.preloadUpcoming(clips, playheadPosition, playbackRate, {
      includeNext: isPlaying,
      enabledTrackIds,
    })
    
    // Update ready states
    const clipIds = clips.map(c => c.id)
    setReadyStates(videoCache.getReadyStates(clipIds))
  }, [clips, playheadPosition, playbackRate, tracks, isPlaying])

  /**
   * Sync all visible videos to the current timeline position
   */
  const syncVideos = useCallback((time, playing) => {
    const visibleClips = getVisibleClips(time)
    const newActiveIds = visibleClips.map(({ clip }) => clip.id)
    
    // Mark previously active clips as inactive
    for (const clipId of activeClipIds) {
      if (!newActiveIds.includes(clipId)) {
        videoCache.setInactive(clipId)
      }
    }
    
    // Sync each visible clip's video
    visibleClips.forEach(({ clip, track }, index) => {
      const video = videoCache.syncVideo(clip.id, clip, time, playing)
      if (video) {
        // First layer (bottom) can have audio, others muted
        const isBottomLayer = index === 0
        videoCache.setActive(clip.id, isBottomLayer && visibleClips.length === 1)
      }
    })
    
    setActiveClipIds(newActiveIds)
    
    return visibleClips
  }, [getVisibleClips, activeClipIds])

  /**
   * Get a cached and ready video element for a clip
   */
  const getVideoForClip = useCallback((clip) => {
    if (!clip) return null
    return videoCache.getVideoElement(clip)
  }, [])

  /**
   * Check if a clip's video is ready to play
   */
  const isClipReady = useCallback((clipId) => {
    return videoCache.isReady(clipId)
  }, [])

  // Preload when clips or position changes significantly
  useEffect(() => {
    preloadUpcoming()
  }, [clips, Math.floor(playheadPosition), preloadUpcoming])

  // Set up preload interval during playback
  useEffect(() => {
    if (isPlaying) {
      // Preload more frequently during playback
      preloadIntervalRef.current = setInterval(() => {
        preloadUpcoming()
      }, 300)
    } else {
      if (preloadIntervalRef.current) {
        clearInterval(preloadIntervalRef.current)
        preloadIntervalRef.current = null
      }
      // Pause all cached videos when timeline stops
      videoCache.pauseAll()
    }

    return () => {
      if (preloadIntervalRef.current) {
        clearInterval(preloadIntervalRef.current)
      }
    }
  }, [isPlaying, preloadUpcoming])

  // Listen for video ready events
  useEffect(() => {
    const handleReady = ({ clipId }) => {
      setReadyStates(prev => ({ ...prev, [clipId]: true }))
    }
    
    videoCache.on('ready', handleReady)
    return () => videoCache.off('ready', handleReady)
  }, [])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      videoCache.pauseAll()
    }
  }, [])

  return {
    getVisibleClips,
    syncVideos,
    getVideoForClip,
    isClipReady,
    activeClipIds,
    readyStates,
    preloadUpcoming,
    cacheStats: videoCache.getStats(),
  }
}

export default useVideoPlayback
