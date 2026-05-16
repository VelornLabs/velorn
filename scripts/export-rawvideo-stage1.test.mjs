#!/usr/bin/env node
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { buildExportFramePlan } from '../src/services/exportFramePlan.mjs'
import { resolveExportRange } from '../src/services/exportRange.mjs'
import { getClipsOverlappingRange, getClippedClipsForRange } from '../src/services/exportPlanValidation.js'
import { getSelectionScopedExportClips } from '../src/services/exportRange.mjs'
import {
  createExportTimelineQueries,
  getExportActiveClipsAtTime,
  getExportTransitionAtTime,
} from '../src/services/exportTimelineState.mjs'

const require = createRequire(import.meta.url)
const { buildRawFramePipeArgs } = require('../electron/exportFfmpegPipe')

test('buildRawFramePipeArgs creates a raw RGBA stdin ffmpeg command', () => {
  const { args, encoderUsed } = buildRawFramePipeArgs({
    width: 1920,
    height: 1080,
    fps: 24,
    outputPath: '/tmp/export.mp4',
    duration: 12.5,
    videoCodec: 'h264',
    useHardwareEncoder: true,
    nvencPreset: 'p5',
  })

  assert.equal(encoderUsed, 'h264_nvenc')
  assert.deepEqual(args.slice(0, 11), [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-video_size', '1920x1080',
    '-framerate', '24',
    '-i', 'pipe:0',
  ])
  assert.ok(args.includes('-t'))
  assert.ok(args.includes('12.5'))
  assert.ok(args.includes('-c:v'))
  assert.ok(args.includes('h264_nvenc'))
  assert.equal(args.at(-1), '/tmp/export.mp4')
})

test('buildExportFramePlan preserves frame order and midpoint timing', () => {
  const plan = buildExportFramePlan({ rangeStart: 10, rangeEnd: 11.5, fps: 2 })

  assert.equal(plan.totalFrames, 3)
  assert.equal(plan.frameDuration, 0.5)
  assert.equal(plan.getFrameTime(0), 10.25)
  assert.equal(plan.getFrameTime(1), 10.75)
  assert.equal(plan.getFrameTime(2), 11.25)
  assert.deepEqual(
    Array.from({ length: plan.totalFrames }, (_, index) => plan.getFrameTime(index)),
    [10.25, 10.75, 11.25]
  )
})

test('resolveExportRange uses In/Out points when requested', () => {
  const range = resolveExportRange({
    rangeMode: 'inout',
    inPoint: 12.5,
    outPoint: 18.25,
  })

  assert.deepEqual(range, { start: 12.5, end: 18.25, mode: 'inout' })
})

test('resolveExportRange uses the selected clip bounds when requested', () => {
  const range = resolveExportRange({
    rangeMode: 'selection',
    selectedClipIds: ['clip-b', 'clip-a'],
    clips: [
      { id: 'clip-a', startTime: 2, duration: 3 },
      { id: 'clip-b', startTime: 8, duration: 4 },
      { id: 'clip-c', startTime: 20, duration: 2 },
    ],
  })

  assert.deepEqual(range, { start: 2, end: 12, mode: 'selection' })
})

test('resolveExportRange rejects missing In/Out points and empty selections', () => {
  assert.throws(() => resolveExportRange({ rangeMode: 'inout', inPoint: 1 }), /In\/Out/)
  assert.throws(() => resolveExportRange({ rangeMode: 'selection', selectedClipIds: [] }), /Selection/)
})

test('getClipsOverlappingRange keeps only clips that overlap the requested export window', () => {
  const clips = getClipsOverlappingRange({
    rangeStart: 5,
    rangeEnd: 15,
    clips: [
      { id: 'before', startTime: 0, duration: 4 },
      { id: 'partial-start', startTime: 4, duration: 3 },
      { id: 'inside', startTime: 8, duration: 2 },
      { id: 'partial-end', startTime: 13, duration: 4 },
      { id: 'after', startTime: 20, duration: 5 },
    ],
  })

  assert.deepEqual(clips.map((clip) => clip.id), ['partial-start', 'inside', 'partial-end'])
})

test('getClippedClipsForRange trims clips to the requested export window', () => {
  const clipped = getClippedClipsForRange({
    rangeStart: 5,
    rangeEnd: 15,
    clips: [
      { id: 'partial-start', startTime: 4, duration: 3 },
      { id: 'inside', startTime: 8, duration: 2 },
      { id: 'partial-end', startTime: 13, duration: 4 },
    ],
  })

  assert.deepEqual(
    clipped.map((clip) => ({ id: clip.id, startTime: clip.startTime, duration: clip.duration })),
    [
      { id: 'partial-start', startTime: 5, duration: 2 },
      { id: 'inside', startTime: 8, duration: 2 },
      { id: 'partial-end', startTime: 13, duration: 2 },
    ]
  )
})

test('getSelectionScopedExportClips keeps selected clips and overlapping adjustment layers', () => {
  const scoped = getSelectionScopedExportClips({
    rangeStart: 3,
    rangeEnd: 9,
    selectedClipIds: ['clip-b'],
    clips: [
      { id: 'clip-a', type: 'video', startTime: 0, duration: 3 },
      { id: 'clip-b', type: 'video', startTime: 4, duration: 2 },
      { id: 'adj-a', type: 'adjustment', startTime: 1, duration: 10 },
      { id: 'text-a', type: 'text', startTime: 4, duration: 2 },
    ],
  })

  assert.deepEqual(scoped.map((clip) => clip.id).sort(), ['adj-a', 'clip-b'])
})

test('export timeline queries use the scoped timeline state instead of the live store', () => {
  const state = {
    clips: [
      { id: 'clip-a', type: 'video', trackId: 'video-1', startTime: 0, duration: 4 },
      { id: 'clip-b', type: 'video', trackId: 'video-1', startTime: 4, duration: 4 },
      { id: 'adj-a', type: 'adjustment', trackId: 'video-9', startTime: 0, duration: 10 },
    ],
    tracks: [
      { id: 'video-1', type: 'video', visible: true, muted: false },
      { id: 'video-9', type: 'video', visible: true, muted: false },
    ],
    transitions: [],
  }

  const queries = createExportTimelineQueries(state)
  assert.equal(queries.getTimelineEndTime(), 10)
  assert.deepEqual(getExportActiveClipsAtTime(state, 1).map((entry) => entry.clip.id), ['clip-a', 'adj-a'])
  assert.deepEqual(queries.getActiveClipsAtTime(5).map((entry) => entry.clip.id), ['clip-b', 'adj-a'])
  assert.equal(getExportTransitionAtTime(state, 5), null)
})
