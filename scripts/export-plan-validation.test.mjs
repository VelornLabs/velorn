import assert from 'node:assert/strict'
import { findMissingClipCoverage, validateSegmentsCoverClips } from '../src/services/exportPlanValidation.js'
import buildExportLanePlan from '../src/services/exportLanePlanner.js'

const makeTimeline = () => ({
  clips: [
    { id: 'clip-1', type: 'video', startTime: 0, duration: 4, trackId: 'v1', effects: [], transform: {} },
    { id: 'clip-2', type: 'video', startTime: 4, duration: 3, trackId: 'v1', effects: [], transform: {} },
  ],
  transitions: [],
  tracks: [{ id: 'v1', type: 'video', visible: true, muted: false }],
  getActiveClipsAtTime(time) {
    return this.clips.filter((clip) => time >= clip.startTime && time < clip.startTime + clip.duration)
      .map((clip) => ({ clip, track: this.tracks[0] }))
  },
})

const timeline = makeTimeline()
const plan = buildExportLanePlan({ timelineState: timeline, rangeStart: 0, rangeEnd: 7, exportMode: 'auto' })
assert.equal(plan.segments.length > 0, true, 'plan should produce segments')

const okResult = validateSegmentsCoverClips({
  segments: plan.segments,
  clips: timeline.clips,
})
assert.equal(okResult.ok, true, 'planned segments should cover all clips')
assert.equal(okResult.missingClips.length, 0)

const missingResult = findMissingClipCoverage({
  segments: [{ start: 1, end: 7 }],
  clips: timeline.clips,
})
assert.equal(missingResult.length, 1, 'should detect uncovered first clip coverage')
assert.equal(missingResult[0].clip.id, 'clip-1')
assert.equal(missingResult[0].missingRange.start, 0)
assert.equal(missingResult[0].missingRange.end, 1)

console.log('export-plan-validation.test.mjs passed')

