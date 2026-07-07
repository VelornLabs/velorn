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
 * durationSeconds is stored but the popover re-prefills it from the active
 * in/out range on open — matching the range is the explicit intent when one
 * is set; otherwise the last value is reused.
 */
export const useMusicPopoverStore = create(
  persist(
    (set) => ({
      tags: 'cinematic, ambient, warm pads, mellow, 90 bpm',
      instrumental: true,
      lyrics: '',
      durationSeconds: 30,
      variations: 2,
      bpm: 90,
      keyScale: 'C major',
      timeSignature: '4',
      sessionPromptIds: [],

      setMusicField: (key, value) => set({ [key]: value }),
      appendSessionPromptIds: (ids) => set((state) => ({
        sessionPromptIds: [...state.sessionPromptIds, ...ids],
      })),
    }),
    {
      name: 'velorn-music-popover',
      partialize: (state) => ({
        tags: state.tags,
        instrumental: state.instrumental,
        lyrics: state.lyrics,
        durationSeconds: state.durationSeconds,
        variations: state.variations,
        bpm: state.bpm,
        keyScale: state.keyScale,
        timeSignature: state.timeSignature,
        sessionPromptIds: state.sessionPromptIds,
      }),
    }
  )
)

export default useMusicPopoverStore
