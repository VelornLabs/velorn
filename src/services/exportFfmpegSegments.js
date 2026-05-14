const isElectronRuntime = () => typeof window !== 'undefined' && window?.electronAPI != null

const toErrorMessage = (error) => {
  if (!error) return 'Unknown FFmpeg segment render error.'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || String(error)
  if (typeof error?.message === 'string') return error.message
  return String(error)
}

const hasValue = (value) => value != null && value !== ''

const shellQuote = (value) => {
  const raw = String(value ?? '')
  if (!raw.length) return "''"
  if (/^[A-Za-z0-9_./:=+-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

export const buildFfmpegCommandPreview = ({ framePattern, fps, outputPath, audioPath, duration }) => {
  const args = ['ffmpeg', '-y', '-framerate', String(fps), '-i', framePattern]
  if (hasValue(audioPath)) args.push('-i', String(audioPath))
  if (Number.isFinite(Number(duration)) && Number(duration) > 0) args.push('-t', String(duration))
  args.push('<encoder_args>', outputPath)
  return args.map(shellQuote).join(' ')
}

const emitCommandLog = async ({ command, segment, options }) => {
  const api = typeof window !== 'undefined' ? window?.electronAPI : null

  if (typeof api?.logFfmpegCommand === 'function') {
    await api.logFfmpegCommand({ stage: 'segment-render', command, segment, options })
    return
  }
  if (typeof api?.logExportCommand === 'function') {
    await api.logExportCommand({ stage: 'segment-render', command, segment, options })
    return
  }
  console.log('[Export:ffmpeg:segment]', { command, segment, options })
}

export async function renderFfmpegSegment({
  segment,
  options = {},
  projectState,
  timelineState,
  assetsState,
  onProgress,
} = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {}

  try {
    if (!segment || typeof segment !== 'object') {
      throw new Error('FFmpeg segment render requires a valid segment object.')
    }
    if (!isElectronRuntime()) {
      throw new Error('FFmpeg segment render is only available in Electron runtime.')
    }
    if (typeof window.electronAPI.encodeVideo !== 'function') {
      throw new Error('FFmpeg segment render unavailable: electronAPI.encodeVideo bridge is missing.')
    }
    if (!projectState?.currentProjectHandle) {
      throw new Error('FFmpeg segment render requires projectState.currentProjectHandle.')
    }
    if (!timelineState || typeof timelineState !== 'object') {
      throw new Error('FFmpeg segment render requires timelineState.')
    }
    if (!assetsState || typeof assetsState !== 'object') {
      throw new Error('FFmpeg segment render requires assetsState.')
    }

    const framePattern = options.framePattern || segment.framePattern
    const outputPath = options.outputPath || segment.outputPath
    const fps = Number(options.fps ?? timelineState.fps ?? 24)
    const audioPath = options.audioPath ?? segment.audioPath ?? null
    const duration = Number(options.duration ?? segment.duration)

    if (!hasValue(framePattern)) throw new Error('FFmpeg segment render missing framePattern.')
    if (!hasValue(outputPath)) throw new Error('FFmpeg segment render missing outputPath.')
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`FFmpeg segment render requires valid fps, got "${fps}".`)

    const command = buildFfmpegCommandPreview({ framePattern, fps, outputPath, audioPath, duration })
    await emitCommandLog({ command, segment, options: { ...options, fps, framePattern, outputPath, audioPath, duration } })

    progress({ status: 'Rendering FFmpeg segment...', progress: 0 })

    const encodeResult = await window.electronAPI.encodeVideo({
      ...options,
      framePattern,
      fps,
      outputPath,
      audioPath,
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    })

    if (!encodeResult?.success) {
      const errorMessage = encodeResult?.error || 'FFmpeg segment render failed during encodeVideo.'
      progress({ status: `FFmpeg segment failed: ${errorMessage}`, progress: 100 })
      return { success: false, outputPath, error: errorMessage }
    }

    progress({ status: 'FFmpeg segment rendered.', progress: 100 })
    return { success: true, outputPath, error: null }
  } catch (error) {
    const message = toErrorMessage(error)
    progress({ status: `FFmpeg segment failed: ${message}`, progress: 100 })
    return { success: false, outputPath: options?.outputPath || segment?.outputPath || null, error: message }
  }
}

export default renderFfmpegSegment
