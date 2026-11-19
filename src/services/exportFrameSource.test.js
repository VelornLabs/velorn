import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

import {
  getWebCodecsExportFallbackReason,
  isExpectedFrameSourceReadAbort,
  needsWebCodecsSourcePreparation,
  WEBCODECS_EXPORT_MAX_SOURCE_DURATION_SEC,
  WEBCODECS_EXPORT_MAX_START_TIME_SEC,
} from './exportFrameSource.js'

test('keeps ordinary short sources on the fast decoder', () => {
  assert.equal(getWebCodecsExportFallbackReason({
    sourceDuration: 180,
    startTime: 30,
  }), null)
})

test('identifies sources that need preparation before fast decoding', () => {
  assert.equal(needsWebCodecsSourcePreparation({
    sourceDuration: WEBCODECS_EXPORT_MAX_SOURCE_DURATION_SEC + 1,
    startTime: 0,
  }), true)
  assert.equal(needsWebCodecsSourcePreparation({
    sourceDuration: 60,
    startTime: WEBCODECS_EXPORT_MAX_START_TIME_SEC + 1,
  }), true)
  assert.equal(needsWebCodecsSourcePreparation({
    sourceDuration: 60,
    startTime: 0,
  }), false)
})

test('falls back when unusually long source media could not be prepared', () => {
  const reason = getWebCodecsExportFallbackReason({
    sourceDuration: WEBCODECS_EXPORT_MAX_SOURCE_DURATION_SEC + 1,
    startTime: 0,
  })

  assert.match(reason, /source duration/)
})

test('keeps a prepared long source on the fast decoder', () => {
  assert.equal(getWebCodecsExportFallbackReason({
    sourceDuration: WEBCODECS_EXPORT_MAX_SOURCE_DURATION_SEC + 1,
    startTime: WEBCODECS_EXPORT_MAX_START_TIME_SEC + 1,
    sourcePrepared: true,
  }), null)
})

test('falls back when the clip starts deep inside its source', () => {
  const reason = getWebCodecsExportFallbackReason({
    sourceDuration: WEBCODECS_EXPORT_MAX_SOURCE_DURATION_SEC,
    startTime: WEBCODECS_EXPORT_MAX_START_TIME_SEC + 1,
  })

  assert.match(reason, /source in-point/)
})

test('does not reject boundary values or missing metadata', () => {
  assert.equal(getWebCodecsExportFallbackReason({
    sourceDuration: WEBCODECS_EXPORT_MAX_SOURCE_DURATION_SEC,
    startTime: WEBCODECS_EXPORT_MAX_START_TIME_SEC,
  }), null)
  assert.equal(getWebCodecsExportFallbackReason(), null)
})

test('ignores only intentional stream aborts after close or clip end', () => {
  const aborted = Object.assign(new Error('BodyStreamBuffer was aborted'), { name: 'AbortError' })
  assert.equal(isExpectedFrameSourceReadAbort(aborted, { pastEnd: true }), true)
  assert.equal(isExpectedFrameSourceReadAbort(aborted, { closed: true }), true)
  assert.equal(isExpectedFrameSourceReadAbort(aborted), false)
  assert.equal(isExpectedFrameSourceReadAbort(new Error('Decoder failed'), { pastEnd: true }), false)
})

// Exercise the real cursor without a browser decoder or a fixture-owned MP4.
// Encoded chunks preserve their assigned timing; decoded frames then arrive
// either ahead of the consumer or only after its first wait.
const source = fs.readFileSync(new URL('./exportFrameSource.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replace(/^export (?=(?:const|function|class)\b)/gm, '')
const { ClipFrameCursor } = vm.runInNewContext(source + '\n({ ClipFrameCursor })', {
  document: { createElement: () => ({}) },
  EncodedVideoChunk: class { constructor(options) { Object.assign(this, options) } },
  console, performance, setTimeout, clearTimeout,
})

const TIMESCALE = 12288
const FRAME_TICKS = 512
const EDIT_OFFSET = 1024
const expectedTimestamp = frame => Math.round(frame * FRAME_TICKS / TIMESCALE * 1e6)
const makeSample = (frame, offset = EDIT_OFFSET) => ({
  number: frame + 1, cts: frame * FRAME_TICKS + offset, duration: FRAME_TICKS,
  timescale: TIMESCALE, is_sync: frame === 0, data: new Uint8Array([frame]), offset: frame, size: 1,
})
function cursorWithChunks(frameNumbers, offset = EDIT_OFFSET) {
  const cursor = new ClipFrameCursor({ url: 'memory:timing' })
  cursor._trackId = 1
  cursor._started = true
  // The old rounded-offset field keeps this regression's pre-fix input
  // equivalent; the fixed cursor stores the original container units.
  cursor._ctsOffsetMicros = Math.round(offset / TIMESCALE * 1e6)
  cursor._ctsOffsetUnits = offset
  cursor._mp4box = { releaseUsedSamples() {} }
  cursor._onSamples(1, frameNumbers.map(frame => makeSample(frame, offset)))
  return cursor
}
function decodedFrame(chunk, frameNumber) {
  return { timestamp: chunk.timestamp, duration: chunk.duration, frameNumber,
    displayWidth: 2, displayHeight: 2, close() {} }
}

for (const editOffset of [0, EDIT_OFFSET]) {
  test(`32 sample timestamps and durations have exact adjacent boundaries with edit offset ${editOffset}`, () => {
    const frameNumbers = Array.from({ length: 32 }, (_, index) => index + 38)
    const cursor = cursorWithChunks(frameNumbers, editOffset)
    for (let i = 0; i < frameNumbers.length; i++) {
      const frame = frameNumbers[i], chunk = cursor._pendingChunks[i]
      assert.equal(chunk.timestamp, expectedTimestamp(frame), `frame ${frame} presentation timestamp`)
      assert.equal(chunk.timestamp + chunk.duration, expectedTimestamp(frame + 1), `frame ${frame} exclusive end`)
      if (i > 0) {
        const previous = cursor._pendingChunks[i - 1]
        assert.equal(previous.timestamp + previous.duration, chunk.timestamp, 'no rounding gap or overlap')
      }
    }
  })
}

test('B-frame decode order does not change normalized presentation timestamps', () => {
  const frameNumbers = [45, 43, 44, 48, 46, 47]
  const cursor = cursorWithChunks(frameNumbers)
  assert.deepEqual(Array.from(cursor._pendingChunks, chunk => chunk.timestamp), frameNumbers.map(expectedTimestamp))
})

test('variable durations and genuine presentation gaps remain intact', () => {
  const cursor = cursorWithChunks([])
  const timings = [{ start: -512, duration: 256 }, { start: 0, duration: 512 },
    { start: 512, duration: 1536 }, { start: 4096, duration: 1024 }]
  cursor._onSamples(1, timings.map(({ start, duration }, index) => ({
    ...makeSample(index), cts: start + EDIT_OFFSET, duration,
  })))
  for (let i = 0; i < timings.length; i++) {
    const { start, duration } = timings[i], chunk = cursor._pendingChunks[i]
    assert.equal(chunk.timestamp, Math.round(start / TIMESCALE * 1e6))
    assert.equal(chunk.timestamp + chunk.duration, Math.round((start + duration) / TIMESCALE * 1e6))
  }
  const beforeGap = cursor._pendingChunks[2], afterGap = cursor._pendingChunks[3]
  assert.ok(beforeGap.timestamp + beforeGap.duration < afterGap.timestamp, 'real gaps are not filled or snapped')
})

test('output frame 2 selects source frame 45 whether its decoder output is early or late', async () => {
  for (const ahead of [true, false]) {
    const cursor = cursorWithChunks([44, 45, 46])
    const frames = cursor._pendingChunks.splice(0).map((chunk, index) => decodedFrame(chunk, index + 44))
    cursor._readyFrames.push(frames[0])
    let waits = 0
    if (ahead) cursor._readyFrames.push(frames[1], frames[2])
    cursor._waitForActivity = async () => {
      assert.equal(++waits, 1, 'one decoder delivery is sufficient')
      cursor._readyFrames.push(frames[1], frames[2])
    }
    // 24-fps output frame 2, center sampling, 2x playback, trim start 40/24.
    const sourceTime = 40 / 24 + ((2 + 0.5) / 24) * 2
    assert.equal(Math.round(sourceTime * 1e6), 1875000)
    await cursor.seek(sourceTime)
    assert.equal(cursor.drawSource.frameNumber, 45, `source frame identity with decoder ahead=${ahead}`)
    assert.equal(waits, ahead ? 0 : 1)
  }
})

test('32 frame-boundary requests select the same source with late and ahead decoder delivery', async () => {
  for (let frame = 38; frame < 70; frame++) {
    for (const ahead of [true, false]) {
      const cursor = cursorWithChunks([frame - 1, frame, frame + 1])
      const frames = cursor._pendingChunks.splice(0).map((chunk, index) => decodedFrame(chunk, frame - 1 + index))
      cursor._readyFrames.push(frames[0])
      if (ahead) cursor._readyFrames.push(frames[1], frames[2])
      let delivered = false
      cursor._waitForActivity = async () => {
        assert.equal(delivered, false, 'decoder output must resolve the request')
        delivered = true
        cursor._readyFrames.push(frames[1], frames[2])
      }
      await cursor.seek(frame / 24)
      assert.equal(cursor.drawSource.frameNumber, frame, `frame ${frame}, decoder ahead=${ahead}`)
    }
  }
})
