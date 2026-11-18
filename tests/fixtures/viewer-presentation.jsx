// Actual preview, playback clock, transport and localization; only synthetic
// shape content. No App, filesystem/project handle, export or MCP connection.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../../src/index.css'
import PreviewPanel from '../../src/components/PreviewPanel'
import TransportControls from '../../src/components/TransportControls'
import Timeline from '../../src/components/Timeline'
import { I18nProvider } from '../../src/i18n/I18nContext'
import useTimelineStore from '../../src/stores/timelineStore'
import useAssetsStore from '../../src/stores/assetsStore'
import useProjectStore from '../../src/stores/projectStore'
import { DEFAULT_SHAPE_PROPERTIES } from '../../src/utils/shapes'

useProjectStore.setState({ currentProject: { name: 'Isolated viewer verification',
  settings: { fps: 24, width: 960, height: 540 }, timelines: [] }, currentProjectHandle: null, currentTimelineId: null })
useAssetsStore.setState({ assets: [], folders: [], previewMode: 'timeline', currentPreview: null,
  selectedAssetIds: [], isPlaying: false, mediaPreparation: null, sourceSeedRequest: null })
useTimelineStore.setState({
  clips: [{ id: 'synthetic-shape', name: 'Synthetic viewer shape', type: 'shape', trackId: 'picture',
    startTime: 0, duration: 60, trimStart: 0, trimEnd: 60, enabled: true, effects: [], keyframes: {},
    shapeProperties: { ...DEFAULT_SHAPE_PROPERTIES, width: 320, height: 240, fillColor: '#38bdf8' },
    transform: { positionX: 0, positionY: 0, scaleX: 100, scaleY: 100, rotation: 0, opacity: 100, scaleLinked: true } }],
  tracks: [{ id: 'picture', name: 'Synthetic picture', type: 'video', visible: true, locked: false }],
  duration: 60, timelineFps: 24, playheadPosition: 1, selectedClipIds: [], selectedTransitionId: null,
  selectedMarkerId: null, selectedGap: null, activeTrackId: 'picture', transitions: [], markers: [],
  history: [], historyIndex: -1, historyLastChangedAt: 0, inPoint: null, outPoint: null,
  isPlaying: false, playbackRate: 1, shuttleMode: false, playAround: null, playbackJump: null,
  playbackJumpError: null, compoundEditContext: null, loopMode: 'normal',
})

let originalPanel = null, originalCanvas = null
const panel = () => document.querySelector('[data-testid="viewer-host"] > div')
const canvas = () => panel()?.querySelector('canvas[data-preview-popout-source="canvas"]')
window.viewerPresentationTest = {
  markNodes() { originalPanel = panel(); originalCanvas = canvas(); return Boolean(originalPanel && originalCanvas) },
  snapshot() {
    const state = useTimelineStore.getState(), viewer = panel(), picture = canvas()
    const rectangle = viewer?.getBoundingClientRect()
    return {
      mounted: Boolean(viewer), samePanel: Boolean(viewer && viewer === originalPanel),
      sameCanvas: Boolean(picture && picture === originalCanvas),
      fullscreenOwnsPanel: Boolean(viewer && document.fullscreenElement === viewer),
      fullscreenEmpty: !document.fullscreenElement, fullscreenClass: Boolean(viewer?.classList.contains('fullscreen-panel')),
      editorOutsideFullscreen: !document.fullscreenElement?.contains(document.querySelector('[data-testid="editor-sibling"]')),
      viewerBounds: rectangle ? { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      playing: state.isPlaying, time: state.playheadPosition, rate: state.playbackRate,
      volume: useAssetsStore.getState().volume, historyCount: state.history.length,
      authored: JSON.stringify({ clips: state.clips, tracks: state.tracks, transitions: state.transitions,
        markers: state.markers, history: state.history, historyIndex: state.historyIndex,
        selectedClipIds: state.selectedClipIds, inPoint: state.inPoint, outPoint: state.outPoint }),
      canvasPixel: picture?.width && picture?.height
        ? Array.from(picture.getContext('2d').getImageData(Math.floor(picture.width / 2), Math.floor(picture.height / 2), 1, 1).data) : null,
    }
  },
  pause() { useTimelineStore.setState({ isPlaying: false, playbackRate: 1, shuttleMode: false }) },
  setTime(time) { useTimelineStore.getState().setPlayheadPosition(time, { snap: true, intent: 'frame-step' }) },
  seedEditingProbe() {
    useTimelineStore.getState().updateClipTransform('synthetic-shape', { positionX: 12 }, true)
    useTimelineStore.setState({ selectedClipIds: ['synthetic-shape'] })
  },
  failNextHtmlRequest() {
    const viewer = panel(), original = viewer.requestFullscreen
    viewer.requestFullscreen = function () {
      viewer.requestFullscreen = original
      return Promise.reject(new Error('Synthetic HTML fullscreen failure'))
    }
  },
}

function Fixture() {
  const [mounted, setMounted] = React.useState(true)
  React.useEffect(() => {
    window.viewerPresentationTest.setMounted = value => flushSync(() => setMounted(value))
  }, [])
  return <div className="flex h-screen flex-col bg-sf-dark-950 text-sf-text-primary">
    <header className="h-12 shrink-0 border-b border-sf-dark-700 p-3" data-testid="editor-sibling">Velorn · isolated editor outside the viewer</header>
    <div className="flex min-h-0 flex-1">
      <aside className="w-48 shrink-0 border-r border-sf-dark-700 p-3" data-testid="asset-sibling">Synthetic assets only</aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1" data-testid="viewer-host">{mounted && <PreviewPanel />}</div>
        <div data-testid="transport-host"><TransportControls /></div>
      </main>
    </div>
    <footer className="h-40 shrink-0 border-t border-sf-dark-700" data-testid="actual-timeline"><Timeline /></footer>
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
