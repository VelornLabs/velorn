// Turn what an editor types into the timecode box into a time in seconds.
//
//   01:02:03:04   hours:minutes:seconds:frames
//   3:04          fields fill from the right, so this is 3 seconds 4 frames
//   1204          digits without separators pair up from the right: 12:04
//   +12  -12      move by that many frames from the current time
//   +1:00  -2:12  move by a timecode amount
//
// Separators may be : ; . or , so a numeric keypad works. Returns null for
// anything that is not a time.

import { getTimecodeFrameRate } from './timelineFrames.js'

export function parseTimecodeInput(text, fps, currentSeconds = 0) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const sign = raw[0] === '+' ? 1 : raw[0] === '-' ? -1 : 0
  const body = (sign ? raw.slice(1) : raw).trim()
  if (!body || !/^[0-9:;.,]+$/.test(body)) return null

  const frameRate = getTimecodeFrameRate(fps)
  let fields
  if (/[:;.,]/.test(body)) {
    fields = body.split(/[:;.,]/).map((part) => (part === '' ? 0 : Number(part)))
  } else if (sign) {
    // A bare signed number is a frame count: +12 means twelve frames on.
    fields = [Number(body)]
  } else {
    fields = []
    for (let end = body.length; end > 0; end -= 2) fields.unshift(Number(body.slice(Math.max(0, end - 2), end)))
  }
  if (fields.length === 0 || fields.length > 4 || fields.some((value) => !Number.isFinite(value))) return null

  const [frames = 0, seconds = 0, minutes = 0, hours = 0] = [...fields].reverse()
  const totalFrames = frames + (seconds + minutes * 60 + hours * 3600) * frameRate
  if (!sign) return totalFrames / frameRate
  const currentFrames = Math.round((Number(currentSeconds) || 0) * frameRate)
  return Math.max(0, currentFrames + sign * totalFrames) / frameRate
}
