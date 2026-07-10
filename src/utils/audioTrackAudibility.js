// Shared solo/mute audibility rules for audio tracks, used by the live
// preview graph, the mixer UI, and every mixdown path (export FFmpeg mix,
// OfflineAudioContext fallback, captions mix, FCPXML). Keeping the predicate
// in one place is what keeps preview and export telling the same story.
//
// Semantics: solo does not override mute. If any audio track is soloed,
// only soloed (and unmuted) audio tracks are audible.

export const TRACK_VOLUME_MIN = 0
export const TRACK_VOLUME_MAX = 200 // 200% = +6 dB
export const TRACK_VOLUME_UNITY = 100

export function clampTrackVolume(value, fallback = TRACK_VOLUME_UNITY) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(TRACK_VOLUME_MIN, Math.min(TRACK_VOLUME_MAX, parsed))
}

export function trackVolumeToLinearGain(volume) {
  return clampTrackVolume(volume) / TRACK_VOLUME_UNITY
}

export const TRACK_PAN_MIN = -100 // full left
export const TRACK_PAN_MAX = 100 // full right

export function clampTrackPan(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(TRACK_PAN_MIN, Math.min(TRACK_PAN_MAX, parsed))
}

/**
 * Track pan as the -1..1 value StereoPannerNode takes. Every consumer forces
 * the pan stage to stereo input so the Web Audio STEREO pan law applies
 * uniformly (center = exact passthrough); the FFmpeg export matrix implements
 * the same law.
 */
export function trackPanToStereoPosition(pan) {
  return clampTrackPan(pan) / TRACK_PAN_MAX
}

export function hasAudioSolo(tracks = []) {
  return (tracks || []).some((track) => track?.type === 'audio' && track.solo === true)
}

export function isAudioTrackAudible(track, anySolo) {
  if (!track) return false
  if (track.muted) return false
  if (track.visible === false) return false
  if (anySolo && track.solo !== true) return false
  return true
}

/**
 * Fold solo state into `muted` so consumers that only understand mute
 * (FFmpeg IPC handlers, FCPXML) apply the right audibility without needing
 * to learn about solo.
 */
export function applySoloAsMute(tracks = []) {
  const anySolo = hasAudioSolo(tracks)
  if (!anySolo) return tracks
  return (tracks || []).map((track) => (
    track?.type === 'audio' && !isAudioTrackAudible(track, anySolo)
      ? { ...track, muted: true }
      : track
  ))
}
