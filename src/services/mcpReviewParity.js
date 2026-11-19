import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import { resolveTrimPreviewSource } from '../utils/trimPreviewSource'
import { getTrimPreviewTimelineTime } from '../utils/trimPreview.mjs'
import { getTrimPreviewSeekTime } from '../utils/trimPreviewSeeking.mjs'
import { doesPresentedVideoFrameMatchTarget } from '../utils/previewVideoSeeking'
import { hasUsableProxy } from './proxyCache'
import { hasUsablePlaybackCache } from './playbackCache'
import { assertMcpContext, captureMcpContext, captureAgentInteractionContext } from './mcpContext'

const rates = [-8, -4, -2, -1, -0.5, -0.25, -0.125, 0.125, 0.25, 0.5, 1, 2, 4, 8]
const loops = ['normal', 'loop', 'loop-in-out', 'loop-selection', 'ping-pong']
export function getTransportState() {
  const state = useTimelineStore.getState()
  return { success: true, isPlaying: state.isPlaying, playbackRate: state.playbackRate,
    shuttleMode: state.shuttleMode, loopMode: state.loopMode,
    playheadPosition: state.playheadPosition, fps: state.timelineFps,
    inPoint: state.inPoint, outPoint: state.outPoint,
    playAround: state.playAround ? { startTime: state.playAround.startTime,
      endTime: state.playAround.endTime, returnTime: state.playAround.returnTime } : null,
    playbackJumpError: state.playbackJumpError || null, context: captureMcpContext(),
    agentContext: captureAgentInteractionContext() }
}

function controlTransport(payload = {}) {
  const operation = payload.operation || 'pause'
  const operations = ['play', 'pause', 'stop', 'step', 'rate', 'loop', 'play_around', 'cancel_play_around']
  if (!operations.includes(operation)) throw new Error('Unknown transport operation.')
  const state = useTimelineStore.getState()
  const rate = payload.rate ?? state.playbackRate ?? 1
  if (!rates.includes(rate)) throw new Error('Playback rate must be a supported forward/reverse speed from 1/8x to 8x.')
  if (operation === 'loop' && !loops.includes(payload.mode)) throw new Error('Choose a supported loop mode.')
  if (operation === 'loop' && payload.mode === 'loop-in-out'
    && !(Number.isFinite(state.inPoint) && Number.isFinite(state.outPoint) && state.outPoint > state.inPoint)) {
    throw new Error('Set valid In and Out points before enabling range looping.')
  }
  if (operation === 'loop' && payload.mode === 'loop-selection' && !state.selectedClipIds?.length) {
    throw new Error('Select at least one clip before enabling selection looping.')
  }
  const frames = payload.frames ?? 1
  if (operation === 'step' && (!Number.isInteger(frames) || Math.abs(frames) > 10000 || frames === 0)) {
    throw new Error('frames must be a nonzero integer between -10000 and 10000.')
  }
  const center = payload.centerSeconds ?? state.playheadPosition
  if (operation === 'play_around' && (!Number.isFinite(center) || center < 0 || center > state.getTimelineEndTime())) {
    throw new Error('Play Around center must be inside the timeline.')
  }
  if (payload.previewOnly !== false) return { previewOnly: true, operation, before: getTransportState(),
    suggestedApplyPayload: { ...payload, operation, ...(operation === 'play_around' ? { centerSeconds: center } : {}),
      ...(operation === 'play' || operation === 'rate' ? { rate } : {}), previewOnly: false } }
  assertMcpContext(payload.expectedContext, 'transport')
  switch (operation) {
    case 'play':
      if (state.playAround) state.cancelPlayAround()
      if (!useTimelineStore.getState().isPlaying) useTimelineStore.getState().togglePlay()
      useTimelineStore.getState().setPlaybackRate(rate)
      break
    case 'pause': state.shuttlePause(); break
    case 'stop': state.shuttlePause(); useTimelineStore.getState().setPlayheadPosition(0); break
    case 'step':
      state.shuttlePause()
      useTimelineStore.getState().setPlayheadPosition(state.playheadPosition + frames / state.timelineFps, { intent: 'frame-step' })
      break
    case 'rate': state.setPlaybackRate(rate); break
    case 'loop': state.setLoopMode(payload.mode); break
    case 'play_around':
      if (!state.startPlayAround(center)) throw new Error('There is no playable range around this position.')
      break
    case 'cancel_play_around': state.cancelPlayAround(); break
  }
  return { success: true, operation, transport: getTransportState(), undoable: false }
}

// Private decoder, like the two-up trim viewer: never seeks the live preview.
// Only publish a confirmed requested frame, otherwise return an honest failure.
function decodeSource(source, maxWidth) {
  return new Promise((resolve) => {
    const video = source.kind === 'video' ? document.createElement('video') : null
    const media = video || new Image()
    let callbackId = null
    let settled = false
    let seekStarted = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (callbackId !== null && video?.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId)
      media.onload = media.onerror = null
      if (video) {
        video.pause()
        video.removeEventListener('loadeddata', seek)
        video.removeEventListener('seeked', seeked)
        video.removeAttribute('src')
        video.load()
        video.remove()
      }
      resolve(result)
    }
    const draw = (presentedTime = null) => {
      try {
        const width = media.videoWidth || media.naturalWidth
        const height = media.videoHeight || media.naturalHeight
        if (!width || !height) throw new Error('Source has no decodable picture.')
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, maxWidth / width, 1080 / height)
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height)
        finish({ state: 'ready', dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height, presentedTime })
      } catch (error) { finish({ state: 'unavailable', warning: error.message }) }
    }
    const arm = () => {
      if (settled || !video.requestVideoFrameCallback) return
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        callbackId = null
        if (doesPresentedVideoFrameMatchTarget({ mediaTime: metadata.mediaTime, targetTime: source.time, fps: source.fps })) draw(metadata.mediaTime)
        else arm()
      })
    }
    const seeked = () => {
      if (!video.requestVideoFrameCallback && !video.seeking
        && doesPresentedVideoFrameMatchTarget({ mediaTime: video.currentTime, targetTime: source.time, fps: source.fps })) draw(video.currentTime)
    }
    const seek = () => {
      if (seekStarted || settled) return
      seekStarted = true
      const target = getTrimPreviewSeekTime(source.time, source.fps, video.duration)
      if (target === null) return finish({ state: 'unavailable', warning: 'Requested frame is outside the source.' })
      if (video.currentTime === 0 && Math.floor(source.time * source.fps + 1e-7) === 0) return draw(0)
      arm()
      try { video.currentTime = target } catch (error) { finish({ state: 'unavailable', warning: error.message }) }
    }
    const timer = setTimeout(() => finish({ state: 'unavailable', warning: 'The requested source frame could not be confirmed within 8 seconds.' }), 8000)
    media.onerror = () => finish({ state: 'unavailable', warning: 'Source media is missing or unsupported. Relink the media.' })
    if (video) {
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;'
      video.setAttribute('aria-hidden', 'true')
      document.body.appendChild(video)
      video.addEventListener('loadeddata', seek)
      video.addEventListener('seeked', seeked)
      video.src = source.url
      video.load()
    } else {
      media.onload = () => draw()
      media.src = source.url
    }
  })
}

async function inspectSourceFrame(payload = {}) {
  const context = captureMcpContext()
  const state = useTimelineStore.getState()
  const clip = state.clips.find(item => item.id === payload.clipId)
  if (!clip) throw new Error('Provide a valid clipId in the current timeline.')
  const edge = payload.edge || 'left'
  if (!['left', 'right'].includes(edge)) throw new Error('edge must be left or right.')
  const time = payload.timelineSeconds ?? getTrimPreviewTimelineTime(clip, edge, state.timelineFps)
  if (!Number.isFinite(time) || time < clip.startTime || time >= clip.startTime + clip.duration) {
    throw new Error('Requested timeline time must be inside the clip (the end boundary is excluded).')
  }
  const maxWidth = payload.maxWidth ?? 960
  if (!Number.isInteger(maxWidth) || maxWidth < 64 || maxWidth > 1920) throw new Error('maxWidth must be between 64 and 1920.')
  const asset = useAssetsStore.getState().assets.find(item => item.id === clip.assetId)
  const source = resolveTrimPreviewSource({ clip, asset, timelineTime: time, timelineFps: state.timelineFps,
    clips: state.clips, transitions: state.transitions, useProxyPlaybackForAssets: state.useProxyPlaybackForAssets,
    proxyUsable: hasUsableProxy(asset), playbackCacheUsable: hasUsablePlaybackCache(asset) })
  const frame = payload.includeImage === false || !['video', 'image'].includes(source.kind)
    ? { state: source.kind === 'unavailable' ? 'unavailable' : 'metadata-only' }
    : await decodeSource(source, maxWidth)
  assertMcpContext(context, 'source-frame inspection')
  const { url: _url, ...sampling } = source
  return { success: frame.state !== 'unavailable', clipId: clip.id, timelineSeconds: time, edge,
    source: sampling, frame, context, note: 'Source-only inspection, matching the trim viewer. Effects and timeline compositing are not shown.' }
}

async function inspectEditPoint(payload = {}) {
  const context = captureMcpContext()
  const state = useTimelineStore.getState()
  const outgoing = state.clips.find(clip => clip.id === payload.outgoingClipId)
  const incoming = state.clips.find(clip => clip.id === payload.incomingClipId)
  if (!outgoing || !incoming || outgoing.id === incoming.id) throw new Error('Provide two different current outgoingClipId and incomingClipId values.')
  const boundary = outgoing.startTime + outgoing.duration
  if (outgoing.trackId !== incoming.trackId || Math.abs(boundary - incoming.startTime) > 0.5 / state.timelineFps) {
    throw new Error('The outgoing and incoming clips must meet at the same edit on the same track.')
  }
  const frames = await Promise.all([
    inspectSourceFrame({ clipId: outgoing.id, edge: 'right', includeImage: payload.includeImage, maxWidth: payload.maxWidth }),
    inspectSourceFrame({ clipId: incoming.id, edge: 'left', includeImage: payload.includeImage, maxWidth: payload.maxWidth }),
  ])
  assertMcpContext(context, 'edit-point inspection')
  return { success: frames.every(frame => frame.success), editTimeSeconds: boundary,
    outgoing: frames[0], incoming: frames[1], context }
}

export const MCP_REVIEW_ACTIONS = {
  get_transport_state: getTransportState,
  control_transport: controlTransport,
  inspect_source_frame: inspectSourceFrame,
  inspect_edit_point: inspectEditPoint,
}
