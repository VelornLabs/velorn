const CONCAT_LIST_ENCODING = { encoding: 'utf8' }

const isElectron = () => typeof window !== 'undefined' && window?.electronAPI != null

const quoteConcatPath = (filePath) => {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  return `'${normalized.replace(/'/g, "'\\''")}'`
}

const ensure = (condition, message, code) => {
  if (!condition) {
    const err = new Error(message)
    err.code = code
    throw err
  }
}

const ensureElectronApi = (...hooks) => {
  ensure(isElectron(), 'Hybrid stitch requires Electron runtime.', 'HYBRID_STITCH_NO_ELECTRON')
  for (const hook of hooks) {
    ensure(typeof window.electronAPI?.[hook] === 'function', `Missing Electron API hook: ${hook}`, 'HYBRID_STITCH_MISSING_HOOK')
  }
}

const buildConcatListContent = (segmentEntries = []) => {
  ensure(Array.isArray(segmentEntries) && segmentEntries.length > 0, 'No stitched segments were provided.', 'HYBRID_STITCH_EMPTY_SEGMENTS')
  const lines = []
  for (let index = 0; index < segmentEntries.length; index += 1) {
    const entry = segmentEntries[index]
    const segmentPath = typeof entry === 'string' ? entry : entry?.outputPath
    const duration = typeof entry === 'object' ? Number(entry?.duration) : null
    ensure(typeof segmentPath === 'string' && segmentPath.trim().length > 0, `Segment ${index} path is invalid.`, 'HYBRID_STITCH_INVALID_SEGMENT')
    lines.push(`file ${quoteConcatPath(segmentPath)}`)
    if (Number.isFinite(duration) && duration > 0) {
      lines.push(`duration ${duration}`)
    }
  }
  return `${lines.join('\n')}\n`
}

const callEncodeVideo = async (encodeOptions = {}) => {
  ensureElectronApi('encodeVideo')
  const result = await window.electronAPI.encodeVideo(encodeOptions)
  ensure(result?.success, result?.error || 'encodeVideo failed during hybrid stitch.', 'HYBRID_STITCH_ENCODE_FAILED')
  return result
}

const callMuxAudioVideo = async (muxOptions = {}) => {
  ensureElectronApi('muxAudioVideo')
  const result = await window.electronAPI.muxAudioVideo(muxOptions)
  ensure(result?.success, result?.error || 'muxAudioVideo failed during hybrid stitch.', 'HYBRID_STITCH_MUX_FAILED')
  return result
}

const callConcatVideoSegments = async (concatOptions = {}) => {
  ensureElectronApi('concatVideoSegments')
  const result = await window.electronAPI.concatVideoSegments(concatOptions)
  ensure(result?.success, result?.error || 'concatVideoSegments failed during hybrid stitch.', 'HYBRID_STITCH_CONCAT_FAILED')
  return result
}

/**
 * Strict hybrid stitch/mux orchestrator.
 * No fallback behavior: all validation and hook failures throw.
 */
export async function stitchHybridExport(options = {}) {
  const {
    concatListPath,
    segmentEntries,
    encode,
    mux,
  } = options

  ensureElectronApi('writeFile')
  ensure(typeof concatListPath === 'string' && concatListPath.trim().length > 0, 'concatListPath is required.', 'HYBRID_STITCH_NO_CONCAT_PATH')
  const concatContent = buildConcatListContent(segmentEntries)
  await window.electronAPI.writeFile(concatListPath, concatContent, CONCAT_LIST_ENCODING)

  let encodeResult = null
  if (encode != null) {
    ensure(typeof encode === 'object', 'encode options must be an object.', 'HYBRID_STITCH_INVALID_ENCODE_OPTIONS')
    encodeResult = await callConcatVideoSegments({
      ...encode,
      concatListPath,
    })
  }

  let muxResult = null
  if (mux != null) {
    ensure(typeof mux === 'object', 'mux options must be an object.', 'HYBRID_STITCH_INVALID_MUX_OPTIONS')
    muxResult = await callMuxAudioVideo(mux)
  }

  return {
    success: true,
    concatListPath,
    concatListEntries: segmentEntries.length,
    encodeResult,
    muxResult,
  }
}

export default stitchHybridExport
