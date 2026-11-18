import timeline from '../../src/stores/timelineStore'
import assets from '../../src/stores/assetsStore'
import project from '../../src/stores/projectStore'
import { runMcpAction, startMcpActionBridge } from '../../src/services/mcpActions'
import { buildMcpSnapshot, startMcpSnapshotPublisher } from '../../src/services/mcpSnapshot'
import { captureMcpContext, assertMcpContext } from '../../src/services/mcpContext'
import { MCP_EDITING_ACTIONS } from '../../src/services/mcpEditingParity'
import { MCP_AUDIO_ACTIONS } from '../../src/services/mcpAudioParity'
import { MCP_EXPORT_ACTIONS } from '../../src/services/mcpExportParity'
import { MCP_REVIEW_ACTIONS } from '../../src/services/mcpReviewParity'

const initial = timeline.getState()
const canvas = document.createElement('canvas')
canvas.width = 320; canvas.height = 180
canvas.getContext('2d').fillStyle = '#d96735'; canvas.getContext('2d').fillRect(0, 0, 320, 180)
const imageUrl = canvas.toDataURL()
let receiveMcpAction = null
let stopMcpBridge = null
function startMcpBridge() {
  stopMcpBridge?.()
  window.electronAPI = { ...window.electronAPI, mcp: {
    updateSnapshot: snapshot => window.parityPublishSnapshot(snapshot),
    onAction: callback => { receiveMcpAction = callback; return () => { receiveMcpAction = null } },
    sendActionResult: response => window.parityActionResult(response),
  } }
  const stopPublisher = startMcpSnapshotPublisher()
  const stopActions = startMcpActionBridge()
  stopMcpBridge = () => { stopPublisher(); stopActions() }
}

// Exercise the real create/import handlers without touching any real project.
// Only their native filesystem/store persistence boundaries are in-memory.
function prepareMemoryProjectStorage() {
  const files = new Set(['/synthetic/fixture-source.png'])
  const checked = value => {
    if (!String(value).startsWith('/synthetic/')) throw new Error(`Unexpected fixture path: ${value}`)
    return value
  }
  window.electronAPI = { ...window.electronAPI, isElectron: true,
    pathJoin: async (...parts) => checked(parts.join('/')),
    pathBasename: async value => checked(value).split('/').pop(),
    exists: async value => files.has(checked(value)),
    createDirectory: async value => { files.add(checked(value)); return { success: true } },
    copyFile: async (source, destination) => {
      if (!files.has(checked(source))) throw new Error('Unknown fixture source')
      files.add(checked(destination)); return { success: true }
    },
    getFileInfo: async value => { checked(value); return { success: true, info: { size: 100 } } },
    getFileUrlDirect: async value => { checked(value); return imageUrl },
  }
  project.setState({ currentProject: null, currentProjectHandle: null, currentTimelineId: null,
    defaultProjectsHandle: '/synthetic/projects', defaultProjectsLocation: '/synthetic/projects',
    saveProject: async () => project.getState().currentProject,
    createProject: async ({ name, width, height, fps }) => {
      const settings = { width, height, fps }, id = 'created-timeline'
      const currentProject = { name, settings, timelines: [{ id, name: 'Fresh timeline', ...settings }], assets: [] }
      assets.setState({ assets: [], folders: [] })
      timeline.setState({ ...initial, clips: [], transitions: [], markers: [], tracks: [{ id: 'v', type: 'video' }],
        timelineFps: fps, duration: 0, timelineSessionId: timeline.getState().timelineSessionId + 1 })
      project.setState({ currentProject, currentProjectHandle: `/synthetic/projects/${name}`, currentTimelineId: id })
      return currentProject
    },
  })
  assets.setState({ assets: [], folders: [] })
}
function reset() {
  const settings = { width: 1920, height: 1080, fps: 24 }
  project.setState({ currentProject: { name: 'Isolated parity fixture', settings, timelines: [{ id: 'test-timeline', name: 'Synthetic timeline', ...settings }] },
    currentProjectHandle: '/synthetic/mcp-parity-not-a-real-project', currentTimelineId: 'test-timeline' })
  assets.setState({ assets: [{ id: 'picture', name: 'Generated test swatch', type: 'image', url: imageUrl, duration: 10, width: 320, height: 180 },
    { id: 'audio', name: 'Test music provenance', type: 'audio', duration: 10,
      generatedMusic: { backend: 'yue2', model: 'test-only', measuredDurationSeconds: 10 } }], folders: [] })
  timeline.setState({ ...initial, timelineSessionId: timeline.getState().timelineSessionId + 1,
    tracks: [{ id: 'v', type: 'video', name: 'Video' }, { id: 'a', type: 'audio', name: 'Audio' }],
    clips: [0, 1].map(index => ({ id: `clip-${index}`, type: 'image', name: `Image ${index}`, assetId: 'picture', trackId: 'v',
      startTime: index * 5, duration: 5, trimStart: 0, trimEnd: 5, sourceDuration: 10, speed: 1,
      transform: { x: 0, y: 0, scaleX: 100, scaleY: 100, scaleLinked: true, rotation: 0, opacity: 100 }, effects: [] })).concat([
        { id: 'audio-1', name: 'Music', type: 'audio', assetId: 'audio', trackId: 'a', startTime: 0, duration: 10, trimStart: 0, trimEnd: 10,
          gainDb: 0, fadeIn: 0, fadeOut: 0, volumeEnvelope: { points: [{ time: 0, gainDb: -2 }], offsetSeconds: 0 } },
      ]), transitions: [], markers: [], timelineFps: 24, duration: 10, selectedClipIds: ['clip-0', 'clip-1'],
    playheadPosition: 2, inPoint: 1, outPoint: 9, history: [], historyIndex: -1 })
}
reset()
window.parity = { timeline, assets, project, reset, runMcpAction, buildMcpSnapshot, captureMcpContext, assertMcpContext,
  startMcpBridge, prepareMemoryProjectStorage, dispatchMcpRequest: request => receiveMcpAction(request),
  actions: [...Object.keys(MCP_EDITING_ACTIONS), ...Object.keys(MCP_AUDIO_ACTIONS), ...Object.keys(MCP_EXPORT_ACTIONS),
    ...Object.keys(MCP_REVIEW_ACTIONS), 'update_caption_cues', 'get_caption_status'] }
