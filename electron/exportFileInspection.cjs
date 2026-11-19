const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')

const rate = value => {
  const [a, b = 1] = String(value || '').split('/').map(Number)
  return Number.isFinite(a / b) && a / b > 0 ? a / b : null
}

function probeFile(binary, filePath, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, text = '', errors = '', settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(value)
    }
    try {
      child = spawnProcess(binary, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { windowsHide: true })
    } catch (error) { finish(error); return }
    timer = setTimeout(() => { child.kill(); finish(new Error('Media inspection timed out')) }, timeoutMs)
    child.stdout.on('data', chunk => {
      text += chunk.toString()
      if (text.length > 4 * 1024 * 1024) { child.kill(); finish(new Error('Media inspection output exceeded the limit')) }
    })
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4096) })
    child.on('error', error => finish(error))
    child.on('close', code => {
      if (code !== 0) return finish(new Error(errors || `Media inspection failed (${code})`))
      try { finish(null, JSON.parse(text)) } catch { finish(new Error('Media inspection returned invalid metadata')) }
    })
  })
}

async function inspectExportFileNative(args = {}, { ffprobePath, probe = probeFile } = {}) {
  const filePath = args.filePath || args.path || args.outputPath
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Supply an absolute export file path')
  const result = { path: filePath, exists: false, ready: false, warnings: [], blockers: [], ffprobe: null, ffprobeAvailable: false }
  let stat
  try { stat = await fs.stat(filePath) } catch (error) {
    result.blockers.push(error.code === 'ENOENT' ? 'Export file does not exist.' : `Cannot inspect export: ${error.message}`)
    return result
  }
  Object.assign(result, { exists: true, isFile: stat.isFile(), bytes: stat.size, zeroBytes: stat.size === 0 })
  if (!stat.isFile()) result.blockers.push('Path is not a file. PNG sequence folders require per-frame inspection.')
  if (!stat.size) result.blockers.push('Export file is zero bytes.')
  if (result.blockers.length) return result
  try {
    if (!ffprobePath) throw new Error('The bundled ffprobe binary is unavailable')
    const parsed = await probe(ffprobePath, filePath)
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const video = streams.find(stream => stream.codec_type === 'video')
    const audio = streams.filter(stream => stream.codec_type === 'audio')
    result.ffprobeAvailable = true
    result.ffprobe = { duration: Number(parsed.format?.duration) > 0 ? Number(parsed.format.duration) : null,
      bitrate: Number(parsed.format?.bit_rate) || null, formatName: parsed.format?.format_name || '', streamCount: streams.length,
      video: video ? { codec: video.codec_name || '', width: video.width, height: video.height,
        fps: rate(video.avg_frame_rate || video.r_frame_rate), pixFmt: video.pix_fmt || '' } : null,
      audio: audio.map(stream => ({ codec: stream.codec_name, channels: stream.channels, sampleRate: Number(stream.sample_rate) || null })) }
    if (!streams.length) result.blockers.push('No media streams were found.')
    const expectations = [
      ['width', args.width ?? args.expectedWidth, result.ffprobe.video?.width, 0],
      ['height', args.height ?? args.expectedHeight, result.ffprobe.video?.height, 0],
      ['FPS', args.fps ?? args.expectedFps, result.ffprobe.video?.fps, 0.02],
      ['duration', args.durationSeconds ?? args.expectedDurationSeconds, result.ffprobe.duration, 0.15],
    ]
    for (const [label, expected, actual, tolerance] of expectations) {
      if (expected == null) continue
      if (!Number.isFinite(Number(expected)) || Number(expected) <= 0) throw new Error(`Expected ${label} must be positive`)
      if (actual == null || Math.abs(Number(expected) - actual) > tolerance) result.warnings.push(`${label} is ${actual ?? 'unavailable'}, expected ${expected}.`)
    }
    const codec = args.videoCodec || args.expectedVideoCodec
    const normalizedCodec = codec === 'h265' ? 'hevc' : String(codec || '').replace('h.', 'h')
    if (codec && result.ffprobe.video?.codec !== normalizedCodec) result.warnings.push(`Video codec is ${result.ffprobe.video?.codec || 'unavailable'}, expected ${codec}.`)
    if (args.includeAudio === true && !audio.length) result.warnings.push('Expected an audio stream, but none was found.')
    if (args.includeAudio === false && audio.length) result.warnings.push('An unexpected audio stream was found.')
  } catch (error) { result.blockers.push(error.message) }
  result.ready = result.blockers.length === 0 && result.warnings.length === 0
  result.inspectionScope = 'Container metadata only; does not certify picture, audio quality, or legal delivery compliance.'
  return result
}

module.exports = { inspectExportFileNative, probeFile }
