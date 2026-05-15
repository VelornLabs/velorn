#!/usr/bin/env node
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { buildExportFramePlan } from '../src/services/exportFramePlan.mjs'

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
