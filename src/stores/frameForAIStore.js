import { create } from 'zustand'

/**
 * Store for "frame from timeline" sent to Generate tab for AI extend/keyframe,
 * as well as the two-frame payload used by the timeline "Fill Gap (FLF2V)"
 * action.
 *
 * Shapes supported:
 *   - Legacy single-frame:
 *       { mode: 'extend' | 'keyframe', blobUrl, file }
 *   - Two-frame FLF2V (used by Timeline.jsx → Generate workspace → wan22-flf2v):
 *       {
 *         mode: 'flf2v',
 *         startFrame: { blobUrl, file },
 *         endFrame:   { blobUrl, file },
 *         targetDurationSeconds,
 *         targetTrackId,
 *         targetGapStartTime,
 *       }
 */
export const useFrameForAIStore = create((set) => ({
  /** Frame payload or null. See file header for supported shapes. */
  frame: null,

  setFrame: (frame) => {
    set({ frame })
  },

  clearFrame: () => {
    set((state) => {
      const frame = state.frame
      if (frame) {
        if (frame.blobUrl) {
          try { URL.revokeObjectURL(frame.blobUrl) } catch (_) {}
        }
        if (frame.startFrame?.blobUrl) {
          try { URL.revokeObjectURL(frame.startFrame.blobUrl) } catch (_) {}
        }
        if (frame.endFrame?.blobUrl) {
          try { URL.revokeObjectURL(frame.endFrame.blobUrl) } catch (_) {}
        }
      }
      return { frame: null }
    })
  },
}))
