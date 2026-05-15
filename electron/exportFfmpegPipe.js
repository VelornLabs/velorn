const appendExportVideoEncoderArgs = (args, options = {}) => {
  const {
    format = 'mp4',
    videoCodec = 'h264',
    proresProfile = '3',
    useHardwareEncoder = false,
    nvencPreset = 'p5',
    preset = 'medium',
    qualityMode = 'crf',
    crf = 18,
    bitrateKbps = 8000,
    keyframeInterval = null,
  } = options

  let encoderUsed = null
  const isProRes = videoCodec === 'prores' || (format === 'mov' && options.proresProfile != null)
  const normalizedCodec = isProRes
    ? 'prores'
    : (format === 'webm' || videoCodec === 'vp9'
      ? 'vp9'
      : (videoCodec === 'h265' ? 'h265' : 'h264'))

  if (normalizedCodec === 'prores') {
    const profileNum = Math.min(4, Math.max(0, parseInt(String(proresProfile), 10) || 3))
    args.push(
      '-c:v', 'prores_ks',
      '-profile:v', String(profileNum),
      '-pix_fmt', profileNum === 4 ? 'yuva444p10le' : 'yuv422p10le'
    )
    encoderUsed = 'prores_ks'
  } else if (normalizedCodec === 'vp9') {
    const vp9SpeedMap = {
      ultrafast: 8,
      superfast: 7,
      veryfast: 6,
      faster: 5,
      fast: 4,
      medium: 3,
      slow: 2,
      slower: 1,
      veryslow: 0,
    }
    args.push(
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuv420p',
      '-row-mt', '1',
      '-cpu-used', String(vp9SpeedMap[preset] ?? 3)
    )
    encoderUsed = 'libvpx-vp9'
    if (qualityMode === 'bitrate') {
      args.push('-b:v', `${bitrateKbps}k`)
    } else {
      args.push('-crf', String(crf), '-b:v', '0')
    }
  } else if (normalizedCodec === 'h265') {
    if (useHardwareEncoder) {
      args.push(
        '-c:v', 'hevc_nvenc',
        '-preset', nvencPreset,
        '-pix_fmt', 'yuv420p',
        '-rc', qualityMode === 'bitrate' ? 'vbr' : 'vbr'
      )
      encoderUsed = 'hevc_nvenc'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-cq', String(crf))
      }
    } else {
      args.push(
        '-c:v', 'libx265',
        '-preset', preset,
        '-pix_fmt', 'yuv420p'
      )
      encoderUsed = 'libx265'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-crf', String(crf))
      }
    }
    args.push('-tag:v', 'hvc1')
  } else {
    if (useHardwareEncoder) {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', nvencPreset,
        '-pix_fmt', 'yuv420p',
        '-rc', qualityMode === 'bitrate' ? 'vbr' : 'vbr'
      )
      encoderUsed = 'h264_nvenc'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-cq', String(crf))
      }
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', preset,
        '-pix_fmt', 'yuv420p'
      )
      encoderUsed = 'libx264'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-crf', String(crf))
      }
    }
  }

  if (keyframeInterval && Number(keyframeInterval) > 0) {
    args.push('-g', String(keyframeInterval), '-keyint_min', String(keyframeInterval))
  }

  if (format === 'mp4') {
    args.push('-movflags', '+faststart')
  }

  return encoderUsed
}

const buildRawFramePipeArgs = (options = {}) => {
  const {
    width,
    height,
    fps = 24,
    outputPath,
    format = 'mp4',
    duration = null,
  } = options

  if (!width || !height || !outputPath) {
    throw new Error('Missing frame pipe inputs.')
  }

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-video_size', `${Math.round(Number(width))}x${Math.round(Number(height))}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
  ]
  if (duration) {
    args.push('-t', String(duration))
  }

  const encoderUsed = appendExportVideoEncoderArgs(args, options)
  args.push(outputPath)
  return { args, encoderUsed }
}

module.exports = {
  appendExportVideoEncoderArgs,
  buildRawFramePipeArgs,
}
