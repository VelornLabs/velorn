import { useRef, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import { formatTimecode } from '../utils/timelineFrames'
import { parseTimecodeInput } from '../utils/timecodeInput.mjs'

/**
 * The timeline's current timecode. Click it and type a time to jump there:
 * a full timecode, a short one (3:00), bare digits (212 = 2 seconds 12
 * frames), or +12 / -12 to move by frames. Enter goes, Escape cancels.
 *
 * This is the only part of the transport bar that follows the playhead;
 * selecting the formatted text re-renders it once per frame of timecode.
 */
function TimecodeField({ fps, maxTime }) {
  const text = useTimelineStore((state) => formatTimecode(state.playheadPosition, fps))
  const [draft, setDraft] = useState(null)
  const [invalid, setInvalid] = useState(false)
  const committedRef = useRef(false)

  const close = () => {
    setDraft(null)
    setInvalid(false)
  }

  const commit = () => {
    const state = useTimelineStore.getState()
    const seconds = parseTimecodeInput(draft, fps, state.playheadPosition)
    if (seconds === null) {
      setInvalid(true)
      return
    }
    const limit = Number.isFinite(Number(maxTime)) ? Math.max(0, Number(maxTime)) : Infinity
    committedRef.current = true
    state.setPlayheadPosition(Math.min(limit, Math.max(0, seconds)), { snap: true })
    close()
  }

  if (draft === null) {
    return (
      <button
        type="button"
        onClick={() => { committedRef.current = false; setDraft(text) }}
        title="Click to type a time. Examples: 1:12, 212, +10, -10"
        className="font-mono text-xs text-sf-text-primary cursor-text hover:text-white focus:outline-none"
      >
        {text}
      </button>
    )
  }

  return (
    <input
      autoFocus
      type="text"
      value={draft}
      spellCheck={false}
      aria-label="Go to timecode"
      aria-invalid={invalid || undefined}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => { setDraft(event.target.value); setInvalid(false) }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') { event.preventDefault(); commit() }
        if (event.key === 'Escape') { event.preventDefault(); close() }
      }}
      onBlur={close}
      className={`w-[5.5rem] bg-transparent font-mono text-xs text-sf-text-primary outline-none border-b ${invalid ? 'border-red-400' : 'border-sf-accent'}`}
    />
  )
}

export default TimecodeField
