#!/usr/bin/env node

// Real-FFmpeg smoke check using only a newly created synthetic fixture folder.
// No project, app preference, environment override, or download is involved.
// --hardware-ffmpeg /absolute/path opts into a real GPU probe/encode attempt.
// An unavailable GPU is reported as CPU fallback, never as hardware validation.
// --keep retains this run's temporary folder for manual inspection.
const assert = require('node:assert/strict')
const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const TEMP_PREFIX = 'velorn-media-preparation-'
const OWNER_ID = 131
const USAGE = 'Usage: node scripts/check-media-preparation.cjs [--keep] [--hardware-ffmpeg /absolute/path]'

function parseOptions(args) {
  const options = { keep: false, hardwareFfmpeg: null }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--keep') options.keep = true
    else if (args[index] === '--hardware-ffmpeg') {
      const selected = args[++index]
      if (!selected || !path.isAbsolute(selected)) throw new Error(USAGE)
      options.hardwareFfmpeg = selected
    } else if (args[index] === '--help') return { help: true }
    else throw new Error(USAGE)
  }
  return options
}

async function dependencyBinary(packageName) {
  const resolved = require(packageName)
  const binaryPath = typeof resolved === 'string' ? resolved : resolved?.path
  if (!binaryPath || !(await fs.stat(binaryPath)).isFile()) {
    throw new Error(`${packageName} did not resolve an installed binary; run npm ci first.`)
  }
  return path.resolve(binaryPath)
}

async function run(binaryPath, args, label, timeout = 30000) {
  try {
    return await execFileAsync(binaryPath, args, {
      encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().slice(-3000)
    throw new Error(`${label} failed: ${detail}`, { cause: error })
  }
}

function fpsRatio(value) {
  const [numerator, denominator = 1] = String(value || '').split('/').map(Number)
  return denominator ? numerator / denominator : null
}

function normalizeFps(value) {
  const fps = Number(value)
  return Number.isFinite(fps) && fps > 0
    ? Math.round(Math.max(1, Math.min(60, fps)) * 1000) / 1000
    : null
}

function makeProbe(ffprobePath) {
  return async (filePath) => {
    try {
      const { stdout } = await run(ffprobePath, [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
      ], 'Media probe')
      const parsed = JSON.parse(stdout)
      const video = parsed.streams.find(stream => stream.codec_type === 'video')
      const audio = parsed.streams.find(stream => stream.codec_type === 'audio')
      return {
        success: true, hasVideo: Boolean(video), hasAudio: Boolean(audio),
        fps: fpsRatio(video?.avg_frame_rate) || fpsRatio(video?.r_frame_rate),
        width: video?.width, height: video?.height,
        duration: Number(video?.duration || parsed.format?.duration),
        videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null,
        pixelFormat: video?.pix_fmt || null, videoProfile: video?.profile || null,
        hasAlpha: false,
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
}

async function probeHardwareEncoder(encoder, binaryPath) {
  try {
    await run(binaryPath, [
      '-hide_banner', '-v', 'error', '-f', 'lavfi',
      '-i', 'color=black:size=256x256:rate=30', '-frames:v', '1',
      '-c:v', encoder, '-f', 'null', '-',
    ], 'Hardware encoder probe', 15000)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function trackEncoderProcesses() {
  const live = new Set()
  const attempts = []
  let maximumActive = 0
  return {
    live, attempts,
    get maximumActive() { return maximumActive },
    spawnImpl(binaryPath, args, options) {
      attempts.push({ binaryPath, encoder: args[args.indexOf('-c:v') + 1] })
      const child = spawn(binaryPath, args, options)
      // ENOENT has no process. Count only successfully spawned native children.
      if (child.pid) {
        live.add(child)
        maximumActive = Math.max(maximumActive, live.size)
        child.once('close', () => live.delete(child))
      }
      return child
    },
  }
}

function collectStatus() {
  const snapshots = []
  return {
    snapshots,
    onStatus(snapshot) {
      snapshots.push(structuredClone(snapshot))
    },
  }
}

async function verifyOutput({ ffmpegPath, ffprobePath, probe, outputPath, source, width, height }) {
  const info = await probe(outputPath)
  assert.equal(info.success, true, info.error)
  assert.equal(info.videoCodec, 'h264', 'Cache must remain H.264')
  assert.equal(info.pixelFormat, 'yuv420p', 'Cache must remain broadly decodable')
  assert.equal(info.width, width, 'Output width changed unexpectedly')
  assert.equal(info.height, height, 'Output height changed unexpectedly')
  assert.ok(Math.abs(info.fps - source.fps) < 0.005, `FPS changed: ${source.fps} -> ${info.fps}`)
  assert.ok(Math.abs(info.duration - source.duration) < 0.12,
    `Duration changed: ${source.duration} -> ${info.duration}`)
  assert.equal(info.hasAudio, true, 'Synthetic source audio was lost')

  const { stdout } = await run(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=key_frame,pict_type,best_effort_timestamp_time',
    '-of', 'json', outputPath,
  ], 'Frame structure probe')
  const frames = JSON.parse(stdout).frames
  assert.ok(frames.length >= 50, 'Cache is unexpectedly truncated')
  assert.equal(frames[0].key_frame, 1, 'Cache must begin with a keyframe')
  let lastKeyframe = 0
  let maximumGop = 0
  for (let index = 0; index < frames.length; index++) {
    assert.notEqual(frames[index].pict_type, 'B', 'Cache must not contain B-frames')
    if (frames[index].key_frame === 1) {
      maximumGop = Math.max(maximumGop, index - lastKeyframe)
      lastKeyframe = index
    }
    assert.ok(index - lastKeyframe < 6, 'Cache keyframe gap exceeds six frames')
  }
  await run(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-xerror', '-i', outputPath,
    '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-',
  ], 'Full cache decode')
  return { width: info.width, height: info.height, fps: info.fps,
    duration: info.duration, frames: frames.length, maximumGop }
}

async function sourceHash(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

async function removeFixture(tempPath, tempParent) {
  const actual = await fs.realpath(tempPath)
  const stat = await fs.lstat(tempPath)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Refusing to remove a replaced fixture folder')
  assert.equal(path.dirname(actual), tempParent, 'Fixture must remain directly inside its temporary parent')
  assert.ok(path.basename(actual).startsWith(TEMP_PREFIX), 'Unexpected fixture directory name')
  assert.equal(actual, tempPath, 'Refusing to remove a redirected fixture folder')
  await fs.rm(actual, { recursive: true, force: true })
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) return console.log(USAGE)
  const { createMediaPreparationService } = require('../electron/mediaPreparation')
  const ffmpegPath = await dependencyBinary('ffmpeg-static')
  const ffprobePath = await dependencyBinary('@derhuerst/ffprobe-static')
  if (options.hardwareFfmpeg) {
    assert.ok((await fs.stat(options.hardwareFfmpeg)).isFile(), 'Hardware FFmpeg must be a file')
    await run(options.hardwareFfmpeg, ['-hide_banner', '-version'], 'Selected FFmpeg version check')
  }
  const tempParent = await fs.realpath(os.tmpdir())
  const tempPath = await fs.mkdtemp(path.join(tempParent, TEMP_PREFIX))
  const inputPath = path.join(tempPath, 'synthetic-source.mp4')
  const probe = makeProbe(ffprobePath)
  const processes = trackEncoderProcesses()
  const services = []
  let initialHash
  try {
    console.log(`Synthetic fixture: ${tempPath}`)
    await run(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=960x540:rate=30000/1001:duration=2.002',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.002',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', inputPath,
    ], 'Synthetic fixture generation')
    initialHash = await sourceHash(inputPath)
    const source = await probe(inputPath)
    assert.equal(source.success, true, source.error)
    const makeService = (overrides = {}) => {
      const service = createMediaPreparationService({
        ffmpegPath, resolveHardwareFfmpeg: async () => ({ path: ffmpegPath }),
        probeVideoInfo: probe, normalizeFps, platform: process.platform,
        spawn: processes.spawnImpl,
        probeHardwareEncoder: async () => ({ ok: false, error: 'CPU smoke check.' }),
        ...overrides,
      })
      services.push(service)
      return service
    }
    const awaitJobs = async (promise) => {
      let timer
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => {
            for (const service of services) service.cancelOwner(OWNER_ID)
            for (const child of processes.live) child.kill('SIGKILL')
            reject(new Error('Synthetic media preparation did not finish within 45 seconds.'))
          }, 45000)
        })])
      } finally {
        clearTimeout(timer)
      }
    }
    const status = collectStatus()
    const queue = makeService({ onStatus: status.onStatus })
    const playbackPath = path.join(tempPath, 'playback.mp4')
    const proxyPath = path.join(tempPath, 'proxy.mp4')
    const [playback, proxy] = await awaitJobs(Promise.all([
      queue.enqueue({ kind: 'playback', ownerId: OWNER_ID, assetId: 'playback',
        label: 'Synthetic playback', inputPath, outputPath: playbackPath }),
      queue.enqueue({ kind: 'proxy', ownerId: OWNER_ID, assetId: 'proxy',
        label: 'Synthetic proxy', inputPath, outputPath: proxyPath, targetHeight: 270 }),
    ]))
    assert.equal(playback.success, true, playback.error)
    assert.equal(proxy.success, true, proxy.error)
    assert.equal(playback.hardware, false)
    assert.equal(proxy.hardware, false)
    assert.ok(status.snapshots.some(snapshot => snapshot.queuedCount >= 1), 'Did not observe queued work')
    assert.ok(status.snapshots.every(snapshot => snapshot.activeCount <= 1), 'Status reported overlapping encodes')
    assert.equal(queue.getStatus(OWNER_ID).activeCount, 0)
    assert.equal(queue.getStatus(OWNER_ID).queuedCount, 0)
    const reports = {
      playback: await verifyOutput({ ffmpegPath, ffprobePath, probe,
        outputPath: playbackPath, source, width: 960, height: 540 }),
      proxy: await verifyOutput({ ffmpegPath, ffprobePath, probe,
        outputPath: proxyPath, source, width: 480, height: 270 }),
    }

    // Force capability success for a path that cannot spawn. This exercises
    // encode-time recovery, not only the easier preflight-unavailable route.
    const missingHardwarePath = path.join(tempPath, 'deliberately-missing-ffmpeg')
    const fallbackPath = path.join(tempPath, 'fallback.mp4')
    const fallbackService = makeService({
      resolveHardwareFfmpeg: async () => ({ path: missingHardwarePath }),
      probeHardwareEncoder: async () => ({ ok: true }),
    })
    const fallback = await awaitJobs(fallbackService.enqueue({
      kind: 'playback', ownerId: OWNER_ID, assetId: 'fallback',
      label: 'Synthetic hardware failure', inputPath, outputPath: fallbackPath,
    }))
    assert.equal(fallback.success, true, fallback.error)
    assert.equal(fallback.hardware, false, 'Broken hardware executable must use CPU')
    assert.equal(fallback.encoder, 'libx264')
    assert.ok(fallback.fallbackReason, 'CPU fallback must explain why hardware failed')
    assert.ok(processes.attempts.some(attempt => attempt.binaryPath === missingHardwarePath),
      'Broken hardware encode was never attempted')
    reports.fallback = await verifyOutput({ ffmpegPath, ffprobePath, probe,
      outputPath: fallbackPath, source, width: 960, height: 540 })

    if (options.hardwareFfmpeg) {
      const hardwarePath = path.join(tempPath, 'hardware-attempt.mp4')
      const hardwareService = makeService({
        resolveHardwareFfmpeg: async () => ({ path: options.hardwareFfmpeg }),
        probeHardwareEncoder,
      })
      const hardware = await awaitJobs(hardwareService.enqueue({
        kind: 'playback', ownerId: OWNER_ID, assetId: 'hardware',
        label: 'Synthetic real hardware attempt', inputPath, outputPath: hardwarePath,
      }))
      assert.equal(hardware.success, true, hardware.error)
      reports.hardwareAttempt = {
        validatedHardware: hardware.hardware === true,
        encoder: hardware.encoder, fallbackReason: hardware.fallbackReason || null,
        ...await verifyOutput({ ffmpegPath, ffprobePath, probe,
          outputPath: hardwarePath, source, width: 960, height: 540 }),
      }
    } else {
      reports.hardwareAttempt = { skipped: true, reason: 'No explicit --hardware-ffmpeg path supplied.' }
    }
    assert.ok(processes.attempts.length >= 4, 'Native encoder tracking did not run')
    assert.equal(processes.maximumActive, 1, 'More than one cache encoder ran concurrently')
    assert.equal(await sourceHash(inputPath), initialHash, 'Source file was modified')
    assert.ok((await fs.readdir(tempPath)).every(name => !name.includes('.tmp.')),
      'An unfinished temporary output survived successful preparation')
    console.log(JSON.stringify({ success: true, maximumActiveEncoders: processes.maximumActive,
      sourceSha256: initialHash, ...reports }, null, 2))
  } finally {
    for (const service of services) service.cancelOwner(OWNER_ID)
    if (initialHash) assert.equal(await sourceHash(inputPath), initialHash, 'Source file was modified')
    if (options.keep || processes.live.size) {
      // Never unlink a folder while an encoder could still recreate files in it.
      console.log(`Retained synthetic fixture: ${tempPath}`)
    } else {
      await removeFixture(tempPath, tempParent)
    }
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
