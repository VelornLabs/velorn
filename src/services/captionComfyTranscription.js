import { comfyui } from './comfyui'
import { getBundledWorkflowPath } from '../config/workflowRegistry'
import { isElectron } from './fileSystem'
import { mixTimelineAudioToWav } from './timelineAudioMix'

const CAPTION_WORKFLOW_PATH = getBundledWorkflowPath('caption_qwen_asr_transcription.json')
const VIDEO_INPUT_NODE_ID = '18'
const SUBTITLE_TEXT_NODE_ID = '28'
const RAW_ASR_TIMING_NODE_ID = '9001'
const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 300

function createCue(start, end, text, index) {
  return {
    id: `cue-${index + 1}`,
    start: Math.round(start * 100) / 100,
    end: Math.round((end > start ? end : start + 0.4) * 100) / 100,
    text: String(text || '').trim(),
    words: [],
  }
}

function parseTimestampToSeconds(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return null
  const [, hh, mm, ss, ms] = match
  return (
    Number(hh) * 3600
    + Number(mm) * 60
    + Number(ss)
    + Number(ms) / 1000
  )
}

function parseLegacyQwenSubtitleLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed) return null

  const match = trimmed.match(/^([\d.]+)\s*-\s*([\d.]+)\s*:\s*(.+)$/)
  if (!match) return null

  const start = parseFloat(match[1])
  const end = parseFloat(match[2])
  const text = match[3].trim()

  if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return null
  return { start, end, text }
}

function parseLegacyQwenSubtitles(rawText) {
  const lines = String(rawText || '').split('\n')
  const cues = []

  for (const line of lines) {
    const parsed = parseLegacyQwenSubtitleLine(line)
    if (!parsed) continue
    cues.push(createCue(parsed.start, parsed.end, parsed.text, cues.length))
  }

  return cues
}

function parseSrtSubtitles(rawText) {
  const blocks = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)

  const cues = []

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length < 2) continue

    const timeLineIndex = lines[0].includes('-->') ? 0 : 1
    const timeLine = lines[timeLineIndex]
    const timeMatch = timeLine.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})$/)
    if (!timeMatch) continue

    const start = parseTimestampToSeconds(timeMatch[1])
    const end = parseTimestampToSeconds(timeMatch[2])
    const textLines = lines.slice(timeLineIndex + 1)
    const text = textLines.join(' ').replace(/\s+/g, ' ').trim()

    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue
    cues.push(createCue(start, end, text, cues.length))
  }

  return cues
}

export function parseCaptionSubtitles(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return []

  if (text.includes('-->')) {
    const srtCues = parseSrtSubtitles(text)
    if (srtCues.length > 0) return srtCues
  }

  return parseLegacyQwenSubtitles(text)
}

function formatSecondsAsSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000))
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const ss = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const mm = totalMinutes % 60
  const hh = Math.floor(totalMinutes / 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

export function formatCaptionCuesAsSrt(cues = []) {
  if (!Array.isArray(cues) || cues.length === 0) return ''
  return cues
    .map((cue, index) => {
      const start = Number(cue?.start) || 0
      const endRaw = Number(cue?.end)
      const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 0.4
      const text = String(cue?.text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
      if (!text) return null
      return [
        String(index + 1),
        `${formatSecondsAsSrtTimestamp(start)} --> ${formatSecondsAsSrtTimestamp(end)}`,
        text,
      ].join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

async function loadCaptionWorkflow() {
  const response = await fetch(CAPTION_WORKFLOW_PATH)
  if (!response.ok) {
    throw new Error(`Could not load caption workflow: ${response.status}`)
  }
  return await response.json()
}

const AUDIO_FILE_EXTS = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'opus'])

function isAudioFilename(name) {
  if (!name) return false
  const lower = String(name).toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_FILE_EXTS.has(lower.slice(dot + 1))
}

function buildCaptionWorkflow(baseWorkflow, uploadedFilename, options = {}) {
  const {
    language = 'Auto',
  } = options
  const workflow = JSON.parse(JSON.stringify(baseWorkflow))
  const loadNode = workflow[VIDEO_INPUT_NODE_ID]
  if (!loadNode) return workflow
  if (!loadNode.inputs || typeof loadNode.inputs !== 'object') loadNode.inputs = {}

  const classType = String(loadNode.class_type || '')
  const nodeIsAudioLoader = /audio/i.test(classType) // e.g. VHS_LoadAudioUpload
  const fileIsAudio = isAudioFilename(uploadedFilename)

  if (fileIsAudio && !nodeIsAudioLoader) {
    // Workflow ships with VHS_LoadVideo (uses OpenCV under the hood) but we're
    // handing it a WAV — cv2 can't decode that, which triggers the
    // "could not be loaded with cv" error. Swap the loader to VHS_LoadAudioUpload.
    loadNode.class_type = 'VHS_LoadAudioUpload'
    loadNode.inputs = {
      audio: uploadedFilename,
      start_time: 0,
      duration: 0,
    }
    if (loadNode._meta) loadNode._meta.title = 'Load Audio (Upload)'

    // VHS_LoadVideo's AUDIO output lives at slot 2; VHS_LoadAudioUpload exposes
    // a single AUDIO output at slot 0. Collapse any reference to the load node
    // to slot 0 so downstream wiring (e.g. UnifiedASRTranscribeNode.audio)
    // still connects after the swap.
    for (const node of Object.values(workflow)) {
      if (!node || !node.inputs || typeof node.inputs !== 'object') continue
      for (const key of Object.keys(node.inputs)) {
        const ref = node.inputs[key]
        if (Array.isArray(ref) && ref.length === 2 && String(ref[0]) === String(VIDEO_INPUT_NODE_ID)) {
          ref[1] = 0
        }
      }
    }
  } else if (nodeIsAudioLoader) {
    // Workflow was already switched to an audio loader manually — just fill
    // in the uploaded filename. Leave other loader params (start_time, etc.) alone.
    loadNode.inputs.audio = uploadedFilename
  } else {
    // Video loader + video file: original behaviour. We also mirror the
    // filename onto `audio` defensively in case a user swapped the loader
    // without code changes.
    loadNode.inputs.video = uploadedFilename
  }

  // Force the ASR node's in-process cache OFF. On Windows the cache-hit code
  // path does `print("💾 CACHE HIT: …")` with a non-BMP emoji, which travels
  // through wandb → colorama → comfyui-manager → ComfyUI's LogInterceptor and
  // eventually hits WriteFile on a pipe handle, where Windows rejects it with
  // OSError [Errno 22] Invalid argument. That crash masquerades as a
  // transcription failure on the second-and-later runs of the same timeline.
  // Disabling the cache avoids the emoji print entirely; the ASR pass is
  // still plenty fast (we only run it on demand).
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue
    if (String(node.class_type || '') !== 'UnifiedASRTranscribeNode') continue
    if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {}
    if ('language' in node.inputs) node.inputs.language = String(language || 'Auto')
    node.inputs.enable_asr_cache = false
  }

  workflow[RAW_ASR_TIMING_NODE_ID] = {
    inputs: { text: ['44', 1] },
    class_type: 'ShowText|pysssss',
    _meta: { title: 'Show Raw ASR Timing Data' },
  }

  return workflow
}

function extractOutputTextFromNodeOutput(nodeOutput) {
  if (!nodeOutput) return null

  for (const key of ['SUBTITLES', 'subtitles', 'TEXT', 'text', 'STRING', 'string', 'srt', 'SRT']) {
    const value = nodeOutput[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }

    if (Array.isArray(value)) {
      const joined = value
        .map((item) => (typeof item === 'string' ? item : ''))
        .join('\n')
        .trim()
      if (joined) return joined
    }
  }

  return null
}

function extractNodeTextFromHistory(history, promptId, nodeId) {
  const promptHistory = history?.[promptId]
  if (!promptHistory) return null

  const outputs = promptHistory.outputs || {}
  return extractOutputTextFromNodeOutput(outputs?.[nodeId])
}

function extractSubtitleTextFromHistory(history, promptId) {
  const promptHistory = history?.[promptId]
  if (!promptHistory) return null

  const outputs = promptHistory.outputs || {}

  for (const nodeId of Object.keys(outputs)) {
    if (String(nodeId) === String(RAW_ASR_TIMING_NODE_ID)) continue
    const nodeOutput = outputs[nodeId]
    if (!nodeOutput) continue

    const directText = extractOutputTextFromNodeOutput(nodeOutput)
    if (directText) return directText

    for (const key of Object.keys(nodeOutput)) {
      const value = nodeOutput[key]
      if (typeof value === 'string' && value.includes('-') && value.includes(':') && value.length > 10) {
        return value.trim()
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.includes('-') && item.includes(':') && item.length > 10) {
            return item.trim()
          }
        }
      }
    }
  }

  return null
}

function parseAsrTimingData(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return { words: [], language: '' }

  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return { words: [], language: '' }
  }

  const words = []
  for (const segment of Array.isArray(data?.segments) ? data.segments : []) {
    const segmentWords = Array.isArray(segment?.words) && segment.words.length > 0
      ? segment.words
      : [segment]
    for (const word of segmentWords) {
      const start = Number(word?.start)
      const end = Number(word?.end)
      const wordText = String(word?.text || '').trim()
      if (!wordText || !Number.isFinite(start) || !Number.isFinite(end)) continue
      words.push({
        start,
        end: end > start ? end : start + 0.08,
        text: wordText,
      })
    }
  }

  words.sort((a, b) => a.start - b.start)
  return {
    words,
    language: String(data?.language || '').trim(),
  }
}

async function uploadMediaToComfy(asset) {
  let fileToUpload = null
  const safeName = String(asset.name || `caption_source_${Date.now()}`)
    .replace(/[^a-zA-Z0-9_\-.\s]/g, '_')

  if (isElectron() && asset.absolutePath && window.electronAPI?.readFileAsBuffer) {
    const bufferResult = await window.electronAPI.readFileAsBuffer(asset.absolutePath)
    if (bufferResult?.success && bufferResult?.data) {
      const mimeType = asset.mimeType || 'video/mp4'
      fileToUpload = new File([bufferResult.data], safeName, { type: mimeType })
    }
  }

  if (!fileToUpload && asset.url) {
    const response = await fetch(asset.url)
    if (response.ok) {
      const blob = await response.blob()
      fileToUpload = new File([blob], safeName, { type: blob.type || 'video/mp4' })
    }
  }

  if (!fileToUpload) {
    throw new Error('Could not read the source media for upload to ComfyUI.')
  }

  const uploadResult = await comfyui.uploadFile(fileToUpload, safeName)
  return uploadResult.name || safeName
}

// Uploads an in-memory blob (typically a pre-mixed WAV for the timeline
// transcription path) to ComfyUI's upload endpoint.
async function uploadBlobToComfy(blob, filename) {
  if (!blob) throw new Error('No audio blob to upload.')
  const safeName = String(filename || `timeline_audio_${Date.now()}.wav`)
    .replace(/[^a-zA-Z0-9_\-.\s]/g, '_')
  const file = new File([blob], safeName, { type: blob.type || 'audio/wav' })
  const uploadResult = await comfyui.uploadFile(file, safeName)
  return uploadResult.name || safeName
}

// Turn a ComfyUI history entry with status_str === 'error' into a multi-line
// string the UI can render. Line 1 is the concise headline (always visible);
// lines 2+ are the full Python traceback and structured context, shown only
// when the user clicks "Show details". This is intentionally lossless —
// previously we truncated to 6 lines and collapsed newlines, which hid the
// actual root cause (e.g. a huggingface_hub download failure) behind an
// opaque generic message like "[Errno 22] Invalid argument".
function formatComfyExecutionError(promptHistory) {
  const messages = Array.isArray(promptHistory?.status?.messages)
    ? promptHistory.status.messages
    : []

  // Find the first proper execution_error tuple. Earlier tuples in the list
  // are just progress events (execution_start, execution_cached, etc.) and
  // don't contain the failure payload.
  const errorTuple = messages.find(
    (m) => Array.isArray(m) && typeof m[0] === 'string' && /execution_error/i.test(m[0])
  )
  const interruptTuple = messages.find(
    (m) => Array.isArray(m) && typeof m[0] === 'string' && /interrupt/i.test(m[0])
  )

  const primary = errorTuple?.[1] && typeof errorTuple[1] === 'object' ? errorTuple[1] : null

  // Build the one-line headline.
  const nodeId = primary?.node_id != null ? ` (node ${primary.node_id})` : ''
  const nodeType = primary?.node_type ? ` [${primary.node_type}]` : ''
  const exType = primary?.exception_type ? `${primary.exception_type}: ` : ''
  const exMsg = primary?.exception_message
    || primary?.error
    || primary?.message
    || (interruptTuple ? 'execution interrupted' : 'unknown error')
  const headline = `ComfyUI workflow failed — ${exType}${String(exMsg).split('\n')[0].trim()}${nodeId}${nodeType}`

  const detailLines = []

  // Full Python traceback. ComfyUI sometimes sends this as an array of
  // strings (one "File …" frame per entry) and sometimes as a single blob;
  // handle both without losing newlines (the UI renders details in a <pre>,
  // and split('\n').filter(Boolean) in the view will drop blanks on its own).
  const tb = primary?.traceback
  if (Array.isArray(tb) && tb.length) {
    detailLines.push('Traceback:')
    for (const entry of tb) {
      const text = String(entry).replace(/\r?\n+$/, '')
      if (!text) continue
      // Preserve multi-line entries so indentation of the offending code
      // line (2 spaces under File ..., line N) is visible.
      for (const sub of text.split(/\r?\n/)) detailLines.push(sub)
    }
  } else if (typeof tb === 'string' && tb.trim()) {
    detailLines.push('Traceback:')
    for (const sub of tb.split(/\r?\n/)) detailLines.push(sub)
  }

  // Auxiliary context ComfyUI sometimes attaches — useful when the traceback
  // alone doesn't obviously point at a specific input / upstream node.
  if (Array.isArray(primary?.executed) && primary.executed.length) {
    detailLines.push(`Executed nodes before failure: ${primary.executed.join(', ')}`)
  }
  if (primary?.current_inputs && typeof primary.current_inputs === 'object') {
    const keys = Object.keys(primary.current_inputs)
    if (keys.length) detailLines.push(`Failing node inputs: ${keys.join(', ')}`)
  }

  return [headline, ...detailLines].filter((l) => l != null && l !== undefined).join('\n')
}

async function pollForCompletion(promptId, onProgress) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    try {
      const history = await comfyui.getHistory(promptId)
      const promptHistory = history?.[promptId]

      if (promptHistory) {
        if (promptHistory.status?.status_str === 'error') {
          throw new Error(formatComfyExecutionError(promptHistory))
        }

        const outputs = promptHistory.outputs
        if (outputs && Object.keys(outputs).length > 0) {
          return history
        }
      }
    } catch (error) {
      if (error.message?.includes('failed')) throw error
    }

    if (typeof onProgress === 'function') {
      const elapsed = Math.round((attempt + 1) * POLL_INTERVAL_MS / 1000)
      onProgress({
        stage: 'transcribe',
        message: `Transcribing with Qwen3-ASR... (${elapsed}s)`,
      })
    }
  }

  throw new Error('Caption transcription timed out waiting for ComfyUI.')
}

export async function transcribeWithComfyUI(asset, { onProgress, language = 'Auto' } = {}) {
  if (!asset) {
    throw new Error('A source audio or video asset is required to generate captions.')
  }

  const connected = await comfyui.checkConnection()
  if (!connected) {
    throw new Error('ComfyUI is not connected. Start ComfyUI and try again.')
  }

  if (typeof onProgress === 'function') {
    onProgress({ stage: 'upload', message: 'Uploading media to ComfyUI...' })
  }

  const uploadedFilename = await uploadMediaToComfy(asset)

  if (typeof onProgress === 'function') {
    onProgress({ stage: 'workflow', message: 'Loading caption workflow...' })
  }

  const baseWorkflow = await loadCaptionWorkflow()
  const workflow = buildCaptionWorkflow(baseWorkflow, uploadedFilename, { language })

  if (typeof onProgress === 'function') {
    onProgress({ stage: 'queue', message: 'Queuing transcription on ComfyUI...' })
  }

  const promptId = await comfyui.queuePrompt(workflow)
  if (!promptId) {
    throw new Error('ComfyUI did not return a prompt ID for the caption workflow.')
  }

  if (typeof onProgress === 'function') {
    onProgress({ stage: 'transcribe', message: 'Transcribing with Qwen3-ASR...' })
  }

  const history = await pollForCompletion(promptId, onProgress)
  const subtitleText = extractNodeTextFromHistory(history, promptId, SUBTITLE_TEXT_NODE_ID)
    || extractSubtitleTextFromHistory(history, promptId)
  const rawAsrTimingText = extractNodeTextFromHistory(history, promptId, RAW_ASR_TIMING_NODE_ID)
  const asrTimingData = parseAsrTimingData(rawAsrTimingText)

  if (!subtitleText) {
    throw new Error(
      'ComfyUI completed the caption workflow but no subtitle text was found in the output. '
      + 'Make sure the Subtitle (QwenASR) node is installed and working in your ComfyUI.'
    )
  }

  const cues = parseCaptionSubtitles(subtitleText)
  if (cues.length === 0) {
    throw new Error('The caption workflow produced output but no timed cues could be parsed from:\n' + subtitleText.slice(0, 200))
  }

  const audioDuration = Number(asset.duration)
    || Number(asset.settings?.duration)
    || Math.max(...cues.map((cue) => cue.end), 0)
    || null

  const transcriptText = cues.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim()

  return {
    modelId: 'Qwen/Qwen3-ASR-0.6B',
    transcriptText,
    words: asrTimingData.words,
    asrLanguage: asrTimingData.language,
    cues,
    audioDuration,
    source: 'comfyui',
  }
}

/**
 * Transcribe the current timeline's program audio.
 *
 * Runs the same Qwen-ASR workflow used for per-asset captions, but against a
 * pre-mixed WAV of the live timeline so captions align with what the viewer
 * actually hears (respecting trims, gaps, mutes). Cue timings come back in
 * timeline time — no offset math needed at the overlay-placement step.
 */
export async function transcribeTimeline({ onProgress } = {}) {
  const report = (stage, message, progress) => {
    if (typeof onProgress === 'function') onProgress({ stage, message, progress })
  }

  const connected = await comfyui.checkConnection()
  if (!connected) {
    throw new Error('ComfyUI is not connected. Start ComfyUI and try again.')
  }

  report('mix', 'Mixing timeline audio…', 2)
  const mix = await mixTimelineAudioToWav({
    onProgress: (status, pct) => report('mix', status, pct),
  })

  report('upload', 'Uploading timeline audio to ComfyUI…', 40)
  const uploadedFilename = await uploadBlobToComfy(mix.blob, `timeline_${Date.now()}.wav`)

  report('workflow', 'Loading caption workflow…', 48)
  const baseWorkflow = await loadCaptionWorkflow()
  const workflow = buildCaptionWorkflow(baseWorkflow, uploadedFilename)

  report('queue', 'Queuing transcription on ComfyUI…', 52)
  const promptId = await comfyui.queuePrompt(workflow)
  if (!promptId) {
    throw new Error('ComfyUI did not return a prompt ID for the caption workflow.')
  }

  report('transcribe', 'Transcribing with Qwen3-ASR…', 58)
  const history = await pollForCompletion(promptId, onProgress)
  const subtitleText = extractSubtitleTextFromHistory(history, promptId)

  if (!subtitleText) {
    throw new Error(
      'ComfyUI completed the caption workflow but no subtitle text was found in the output. '
      + 'Make sure the Subtitle (QwenASR) node is installed and working in your ComfyUI.'
    )
  }

  const cues = parseCaptionSubtitles(subtitleText)
  if (cues.length === 0) {
    throw new Error('The caption workflow produced output but no timed cues could be parsed from:\n' + subtitleText.slice(0, 200))
  }

  const transcriptText = cues.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim()

  return {
    modelId: 'Qwen/Qwen3-ASR-0.6B',
    transcriptText,
    words: [],
    cues,
    audioDuration: mix.duration,
    source: 'comfyui-timeline',
  }
}
