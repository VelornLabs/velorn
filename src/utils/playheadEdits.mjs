// Keyboard edits that act at the playhead or on the selection without a
// mouse gesture: trim a clip's start or end to the playhead, and nudge the
// selected clips by whole frames. Each is one undo step and goes through the
// same store actions as the mouse gestures.

import { createMultiClipTrimSession, resolveMultiClipTrim } from './multiClipTrim.mjs'
import { getSafeTimelineFps, quantizeTimeToFrame } from './timelineFrames.js'

const EPSILON = 1e-6

const isSyncLocked = (clip) => clip?.lockMode === 'sync' && clip?.syncLock?.mode === 'sync'

const isEditable = (state, clip) => {
  if (!clip || clip.locked || isSyncLocked(clip)) return false
  const track = state.tracks.find((candidate) => candidate.id === clip.trackId)
  return Boolean(track) && track.locked !== true
}

const spansTime = (clip, time) => time > clip.startTime + EPSILON && time < clip.startTime + clip.duration - EPSILON

/**
 * Clips a trim-to-playhead should act on: the selected clips under the
 * playhead, or with nothing selected there, the clip on the active track
 * under the playhead together with anything linked to it.
 */
export function getTrimToPlayheadTargets(state, time) {
  const selected = new Set(state.selectedClipIds || [])
  const selectedTargets = state.clips.filter((clip) => selected.has(clip.id) && spansTime(clip, time) && isEditable(state, clip))
  if (selectedTargets.length > 0) return selectedTargets
  const active = state.clips.find((clip) => clip.trackId === state.activeTrackId && spansTime(clip, time))
  if (!active || !isEditable(state, active)) return []
  const linkId = typeof active.linkGroupId === 'string' ? active.linkGroupId.trim() : ''
  if (!linkId) return [active]
  return state.clips.filter((clip) => clip === active || (
    typeof clip.linkGroupId === 'string' && clip.linkGroupId.trim() === linkId && spansTime(clip, time) && isEditable(state, clip)
  ))
}

/**
 * Trim the start ('left') or end ('right') of the target clips to the
 * playhead. With Ripple Edit on and a single target, later clips close up.
 * @returns {{ ok: boolean, changed: boolean, reason?: string }}
 */
export function trimToPlayhead(store, edge) {
  if (edge !== 'left' && edge !== 'right') return { ok: false, changed: false, reason: 'Unknown edge.' }
  const state = store.getState()
  const fps = getSafeTimelineFps(state.timelineFps)
  const time = quantizeTimeToFrame(state.playheadPosition, fps)
  const targets = getTrimToPlayheadTargets(state, time)
  if (targets.length === 0) {
    return { ok: false, changed: false, reason: 'Park the playhead inside a clip on the active track, or select the clip.' }
  }
  const deltaFor = (clip) => (edge === 'left' ? time - clip.startTime : time - (clip.startTime + clip.duration))

  if (state.rippleEditMode === true && targets.length === 1) {
    const [clip] = targets
    const begun = state.beginRippleTrim({ clipId: clip.id, edge })
    if (!begun.ok) return { ok: false, changed: false, reason: begun.reason }
    const applied = store.getState().applyRippleTrim(begun.token, deltaFor(clip))
    store.getState().endRippleTrim(begun.token)
    return applied.ok ? { ok: true, changed: applied.changed !== false } : { ok: false, changed: false, reason: applied.reason }
  }

  const updates = []
  for (const clip of targets) {
    const session = createMultiClipTrimSession({
      clips: state.clips, targetClipIds: [clip.id], primaryClipId: clip.id, edge, fps,
    })
    if (!session) continue
    const resolved = resolveMultiClipTrim(session, deltaFor(clip))
    if (Math.abs(resolved.delta) > EPSILON) updates.push(...resolved.updates)
  }
  if (updates.length === 0) return { ok: false, changed: false, reason: 'Nothing to trim at the playhead.' }
  state.saveToHistory()
  store.getState().updateClipsTrim(updates)
  return { ok: true, changed: true }
}

/**
 * Move the selected clips by whole frames (negative = earlier). Clips never
 * move before the start of the timeline; whatever they land on is
 * overwritten, the same as dropping them there with the mouse.
 */
export function nudgeSelectedClips(store, frames) {
  const state = store.getState()
  const step = Math.trunc(Number(frames) || 0)
  if (step === 0) return { ok: false, changed: false }
  const selected = new Set(state.selectedClipIds || [])
  const clips = state.clips.filter((clip) => selected.has(clip.id))
  if (clips.length === 0) return { ok: false, changed: false, reason: 'Select a clip to nudge.' }
  if (clips.some((clip) => !isEditable(state, clip))) {
    return { ok: false, changed: false, reason: 'Unlock the selected clips and their tracks before nudging.' }
  }
  const fps = getSafeTimelineFps(state.timelineFps)
  const earliest = Math.min(...clips.map((clip) => clip.startTime))
  const seconds = Math.max(step / fps, -earliest)
  if (Math.abs(seconds) < EPSILON) return { ok: false, changed: false }
  state.saveToHistory()
  store.getState().setSelectedClipsStartTimes(clips.map((clip) => ({ id: clip.id, startTime: clip.startTime + seconds })))
  store.getState().moveSelectedClips(0, null, true)
  return { ok: true, changed: true }
}
