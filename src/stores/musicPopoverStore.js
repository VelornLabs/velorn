import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Persisted form state for the timeline Music popover.
 *
 * The popover unmounts every time it closes (including accidental
 * click-outside), so keeping the creative inputs here — instead of local
 * component state — means tags/lyrics/BPM/key/etc. survive a close and even
 * an app restart. sessionPromptIds is persisted too so the in-progress /
 * finished takes list reappears on reopen; after an app restart the job
 * registry is empty, so stale ids simply resolve to no jobs (harmless).
 *
 * ACE-Step durationSeconds and yue2CustomDurationSeconds retain independent
 * values. In/out prefills only Custom maximum or ACE-Step; YuE2's Automatic
 * mode is independent of the edit range and keeps the custom value.
 */
export const useMusicPopoverStore = create(
  persist(
    (set) => ({
      backend: 'yue2',
      tags: 'cinematic, ambient, warm pads, mellow, 90 bpm',
      instrumental: true,
      lyrics: '',
      yue2LengthMode: 'automatic',
      yue2CustomDurationSeconds: 30,
      durationSeconds: 30,
      variations: 2,
      bpm: 90,
      keyScale: 'C major',
      timeSignature: '4',
      sessionPromptIds: [],

      setMusicField: (key, value) => set({ [key]: value }),
      appendSessionPromptIds: (ids) => set((state) => ({
        sessionPromptIds: [...new Set([...state.sessionPromptIds, ...ids])].slice(-100),
      })),
    }),
    {
      name: 'velorn-music-popover',
      partialize: (state) => ({
        backend: state.backend,
        tags: state.tags,
        instrumental: state.instrumental,
        lyrics: state.lyrics,
        yue2LengthMode: state.yue2LengthMode,
        yue2CustomDurationSeconds: state.yue2CustomDurationSeconds,
        durationSeconds: state.durationSeconds,
        variations: state.variations,
        bpm: state.bpm,
        keyScale: state.keyScale,
        timeSignature: state.timeSignature,
        sessionPromptIds: state.sessionPromptIds,
      }),
      // Old forms contain a duration but no mode. Keep those seconds for an
      // explicit Custom selection without inheriting the old short default.
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...persistedState,
        yue2LengthMode: persistedState?.yue2LengthMode === 'custom' ? 'custom' : 'automatic',
        yue2CustomDurationSeconds: persistedState?.yue2CustomDurationSeconds
          ?? persistedState?.durationSeconds ?? currentState.yue2CustomDurationSeconds,
      }),
    }
  )
)

export default useMusicPopoverStore
