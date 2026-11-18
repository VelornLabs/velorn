// Real Storyboard UI, project services and MCP dispatcher. Every media byte is
// synthetic and every filesystem/preference operation stays in this page's RAM.
// This fixture never imports App or the production Electron main/preload.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'

const projectRoot = '/fixture-only/storyboard/project'
const secondRoot = '/fixture-only/storyboard/second-project'
const standaloneStoryboard = new URLSearchParams(window.location.search).get('view') === 'storyboard'
let resetView = () => {}
const clone = value => value === undefined ? undefined : structuredClone(value)
const files = new Map(), directories = new Set([projectRoot, secondRoot])
const preferences = new Map(), media = new Map(), calls = [], forbiddenCalls = []
const checked = value => {
  const text = String(value)
  if (!text.startsWith('/fixture-only/storyboard/') || text.split('/').includes('..')) {
    throw new Error(`Path outside the in-memory Storyboard fixture: ${text}`)
  }
  return text
}
const record = (method, value) => calls.push({ method, value: clone(value) })
const forbidden = method => async value => {
  forbiddenCalls.push({ method, value: clone(value) })
  throw new Error(`Forbidden native fixture action: ${method}`)
}
window.electronAPI = {
  isElectron: true, platform: 'linux',
  pathJoin: async (...parts) => checked(parts.join('/').replace(/\/+/g, '/')),
  pathBasename: async value => checked(value).split('/').pop(),
  exists: async value => directories.has(checked(value)) || files.has(value) || media.has(value),
  isDirectory: async value => directories.has(checked(value)),
  createDirectory: async value => { directories.add(checked(value)); record('createDirectory', value); return { success: true } },
  writeFile: async (value, data) => {
    checked(value)
    if (!value.endsWith('.comfystudio')) throw new Error(`Unexpected fixture document: ${value}`)
    files.set(value, String(data)); record('writeFile', value); return { success: true }
  },
  readFile: async value => { checked(value); record('readFile', value); return files.has(value)
    ? { success: true, data: files.get(value) } : { success: false, error: 'Missing in-memory fixture file' } },
  listDirectory: async value => { checked(value); return { success: true, items: [...files.keys()]
    .filter(name => name.startsWith(value + '/') && !name.slice(value.length + 1).includes('/'))
    .map(name => ({ path: name, name: name.split('/').pop(), isFile: true, modified: '2026-09-26T00:00:00.000Z' })) } },
  deleteFile: async value => { checked(value); if (!value.includes('/autosave/')) return forbidden('deleteFile')(value)
    files.delete(value); record('deleteFixtureSnapshot', value); return { success: true } },
  getFileUrlDirect: async value => { checked(value); if (!media.has(value)) throw new Error('Synthetic media is missing'); return media.get(value) },
  getSetting: async key => preferences.get(key) ?? null,
  setSetting: async (key, value) => { preferences.set(key, clone(value)); record('setSetting', key); return { success: true } },
  getMediaPreparationStatus: async () => ({ activeCount: 0, queuedCount: 0, jobs: [] }),
  onMediaPreparationStatus: () => () => {},
  selectFile: forbidden('selectFile'), selectDirectory: forbidden('selectDirectory'),
  writeFileFromArrayBuffer: async (value, data) => {
    checked(value)
    if (![`${projectRoot}/project.thumbnail.webp`, `${secondRoot}/project.thumbnail.webp`].includes(value)) {
      return forbidden('writeFileFromArrayBuffer')(value)
    }
    // A normal native save may capture a project thumbnail. Keep these bytes
    // only in fixture RAM; arbitrary binary writes remain forbidden.
    files.set(value, data.slice(0)); record('writeFixtureThumbnail', { path: value, bytes: data.byteLength })
    return { success: true }
  },
  copyFile: forbidden('copyFile'), trashAssetFiles: forbidden('trashAssetFiles'),
  transcodeForPlayback: forbidden('transcodeForPlayback'), transcodeForProxy: forbidden('transcodeForProxy'),
  comfyLauncher: { start: forbidden('comfyLauncher.start'), stop: forbidden('comfyLauncher.stop'), restart: forbidden('comfyLauncher.restart') },
}

const scenes = [
  { title: 'A signal in the city', word: 'SIGNAL', color: '#37d7db', description: 'A lone creator notices a pulse of light moving through the sleeping city.' },
  { title: 'Following the thread', word: 'SEARCH', color: '#a88cfa', description: 'The pulse becomes a trail of connected windows, inviting us deeper into the network.' },
  { title: 'A human connection', word: 'CONNECT', color: '#ffae72', description: 'Two distant silhouettes meet across a luminous bridge. Technology brings their stories together.' },
  { title: 'A new day begins', word: 'DAWN', color: '#b3df85', description: 'The skyline opens into warm daylight, leaving room for the next story.' },
]
function drawScene(scene, index) {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
  const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 640, 360)
  gradient.addColorStop(0, '#101622'); gradient.addColorStop(1, scene.color + '88')
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 360)
  ctx.strokeStyle = scene.color + '33'; ctx.lineWidth = 1
  for (let x = 24; x < 640; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 360); ctx.stroke() }
  for (let y = 20; y < 360; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(640, y); ctx.stroke() }
  ctx.fillStyle = '#101824'
  for (let building = 0; building < 12; building++) {
    const height = 45 + ((building * 31 + index * 23) % 125), x = building * 57 - 8
    ctx.fillRect(x, 315 - height, 41, height)
    ctx.fillStyle = scene.color + '66'
    for (let y = 325 - height; y < 300; y += 16) ctx.fillRect(x + 12, y, 5, 5)
    ctx.fillStyle = '#101824'
  }
  ctx.strokeStyle = scene.color; ctx.lineWidth = 3; ctx.beginPath()
  ctx.moveTo(25, 260); ctx.bezierCurveTo(175, 320 - index * 30, 320, 90, 615, 195); ctx.stroke()
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(342 + index * 22, 173, 7, 0, Math.PI * 2); ctx.fill()
  ctx.fillRect(338 + index * 22, 182, 8, 26)
  ctx.fillStyle = '#f2f6fd'; ctx.font = '700 34px sans-serif'; ctx.fillText(scene.word, 32, 67)
  ctx.font = '13px sans-serif'; ctx.fillStyle = '#c6d2e3'; ctx.fillText(`0${index + 1}  /  SYNTHETIC STORYBOARD STUDY`, 33, 92)
  ctx.fillStyle = '#101622aa'; ctx.fillRect(0, 315, 640, 45)
  ctx.font = '15px sans-serif'; ctx.fillStyle = '#eef3fa'; ctx.fillText(scene.title, 25, 343)
  return canvas
}
const canvases = scenes.map(drawScene)
const imageUrls = canvases.map(canvas => canvas.toDataURL('image/png'))
function drawCharacterReference(name, color, side = false) {
  const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 360
  const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 480, 360)
  gradient.addColorStop(0, '#16202c'); gradient.addColorStop(1, color + '88')
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 480, 360)
  ctx.strokeStyle = color + '44'; ctx.lineWidth = 1
  for (let x = 20; x < 480; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 360); ctx.stroke() }
  const x = side ? 250 : 220
  ctx.fillStyle = '#151927'; ctx.beginPath(); ctx.moveTo(x - 100, 320); ctx.quadraticCurveTo(x - 80, 220, x, 215)
  ctx.quadraticCurveTo(x + 95, 220, x + 110, 320); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#d6ab91'; ctx.fillRect(x - 16, 180, 34, 55); ctx.beginPath(); ctx.ellipse(x, 151, side ? 34 : 44, 58, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#1d2535'; ctx.beginPath(); ctx.ellipse(x - 5, 119, 47, 41, -0.15, Math.PI, 2 * Math.PI)
  ctx.lineTo(x + 42, 174); ctx.lineTo(x + 20, 128); ctx.lineTo(x - 42, 152); ctx.closePath(); ctx.fill()
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x - 23, 225); ctx.lineTo(x - 65, 302); ctx.stroke()
  ctx.fillStyle = '#edf3f8'; ctx.font = '700 25px sans-serif'; ctx.fillText(name.toUpperCase(), 25, 42)
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#c0ccda'; ctx.fillText('SYNTHETIC CHARACTER REFERENCE', 26, 64)
  ctx.fillStyle = '#101622dd'; ctx.fillRect(0, 318, 480, 42)
  ctx.font = '13px sans-serif'; ctx.fillStyle = '#edf3f8'; ctx.fillText(side ? 'Profile study · dark jacket · teal accent' : 'Front study · dark jacket · teal accent', 23, 344)
  return canvas.toDataURL('image/png')
}
function drawPropReference() {
  const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 360
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#172631'; ctx.fillRect(0, 0, 480, 360)
  ctx.strokeStyle = '#62e0dc'; ctx.lineWidth = 3; ctx.strokeRect(182, 91, 116, 199)
  ctx.fillStyle = '#090f19'; ctx.fillRect(188, 97, 104, 187)
  ctx.strokeStyle = '#37d7db'; ctx.beginPath(); ctx.arc(240, 174, 24, 0, Math.PI * 2); ctx.stroke()
  ctx.fillStyle = '#eefaff'; ctx.beginPath(); ctx.arc(240, 174, 6, 0, Math.PI * 2); ctx.fill()
  ctx.font = '700 24px sans-serif'; ctx.fillText('THE SIGNAL', 28, 45)
  ctx.font = '12px sans-serif'; ctx.fillStyle = '#bbcbdc'; ctx.fillText('SYNTHETIC PROP / LIGHT MOTIF', 29, 66)
  return canvas.toDataURL('image/png')
}
const wallReferences = standaloneStoryboard ? [] : [
  { id: 'character-mara-front', name: 'Mara — front study.png', url: drawCharacterReference('Mara', '#37d7db') },
  { id: 'character-mara-profile', name: 'Mara — profile study.png', url: drawCharacterReference('Mara', '#83bdf3', true) },
  { id: 'signal-prop', name: 'The signal — prop reference.png', url: drawPropReference() },
]
const dataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob)
})
async function makeVideo() {
  if (!MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) throw new Error('Fixture needs Chromium VP8 MediaRecorder support')
  const stream = canvases[1].captureStream(8), chunks = []
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
  const finished = new Promise((resolve, reject) => { recorder.ondataavailable = event => chunks.push(event.data)
    recorder.onstop = resolve; recorder.onerror = reject })
  recorder.start()
  for (let index = 0; index < 8; index++) {
    const ctx = canvases[1].getContext('2d'); ctx.fillStyle = '#a88cfa'; ctx.fillRect(28 + index * 10, 300, 6, 6)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  recorder.stop(); await finished; stream.getTracks().forEach(track => track.stop())
  return dataUrl(new Blob(chunks, { type: 'video/webm' }))
}
async function makeAudio() {
  const sampleRate = 8000, samples = sampleRate * 45, buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer)
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples * 2, true)
  for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.sin(index * Math.PI * 440 / sampleRate) * 900, true)
  return dataUrl(new Blob([buffer], { type: 'audio/wav' }))
}
const [videoUrl, audioUrl] = await Promise.all([makeVideo(), makeAudio()])
const seededAssets = [
  ...wallReferences.map(asset => ({ ...asset, type: 'image', path: `assets/images/${asset.id}.png`, width: 480, height: 360, duration: 5 })),
  ...scenes.map((scene, index) => ({ id: `reference-${index + 1}`, type: 'image', name: `${scene.word.toLowerCase()}-reference.png`,
    path: `assets/images/reference-${index + 1}.png`, url: imageUrls[index], width: 640, height: 360, duration: 5 })),
  ...[1, 2].map(index => ({ id: `take-${index}`, type: 'video', name: `Signal motion study ${index}.webm`,
    path: `assets/video/take-${index}.webm`, url: videoUrl, thumbnail: imageUrls[index], poster: { url: imageUrls[index] },
    duration: 0.8, width: 640, height: 360, fps: 8, hasAudio: false })),
  { id: 'song-1', type: 'audio', name: 'Signal synthetic pulse.wav', path: 'assets/audio/song.wav', url: audioUrl, duration: 45 },
].map(asset => ({ ...asset, isImported: true, createdAt: '2026-09-26T00:00:00.000Z' }))
for (const root of [projectRoot, secondRoot]) for (const asset of seededAssets) media.set(`${root}/${asset.path}`, asset.url)

const [{ default: StoryboardPanel }, { default: project }, { default: timeline }, { default: assets }, storyboard,
  { runMcpAction }, { buildMcpSnapshot }, dirty] = await Promise.all([
  import('../../src/components/StoryboardPanel'), import('../../src/stores/projectStore'),
  import('../../src/stores/timelineStore'), import('../../src/stores/assetsStore'), import('../../src/services/storyboard'),
  import('../../src/services/mcpActions'), import('../../src/services/mcpSnapshot'), import('../../src/services/projectDirtyTracker'),
])
const ProductionWorkspace = standaloneStoryboard ? null : (await import('../../src/components/ProductionWorkspace')).default
const timelineDefaults = timeline.getState()
dirty.attachProjectDirtyWatchers({ timelineStore: timeline, assetsStore: assets, projectStore: project })
function reset({ empty = false, name = empty ? 'Empty reference board — isolated fixture' : 'Signal — synthetic reference board', root = projectRoot } = {}) {
  const settings = { width: 1920, height: 1080, fps: 24 }
  timeline.setState({ ...timelineDefaults, clips: [], transitions: [], markers: [], selectedClipIds: [],
    tracks: [{ id: 'video-1', name: 'Video 1', type: 'video', visible: true, locked: false, muted: false }],
    duration: 20, timelineFps: 24, isPlaying: false, history: [], historyIndex: -1,
    timelineSessionId: timeline.getState().timelineSessionId + 1 })
  assets.setState({ assets: clone(seededAssets), folders: [], folderCounter: 1, currentPreview: null, mediaPreparation: null })
  project.setState({ currentProject: { name, settings, timelines: [{ id: 'fixture-timeline', name: 'Timeline 1', ...settings }],
    assets: clone(seededAssets), folders: [] }, currentProjectHandle: root, currentTimelineId: 'fixture-timeline',
    autoSaveEnabled: false, projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0, error: null })
  if (!empty) {
    storyboard.applyStoryboardEdit({ operation: 'update_board', patch: { title: 'SIGNAL / A technology story',
      brief: 'A four-shot study about technology bringing people together. All reference images and media are synthetic fixture assets.', songAssetId: 'song-1',
      ...(!standaloneStoryboard ? { referenceAssetIds: ['signal-prop'] } : {}) } })
    scenes.forEach((scene, index) => storyboard.applyStoryboardEdit({ operation: 'add_shot', shot: {
      title: scene.title, description: scene.description, durationSeconds: 5 + index,
      status: ['planned', 'in-progress', 'review', 'approved'][index], referenceAssetIds: [`reference-${index + 1}`],
    } }))
    const demoShotId = storyboard.getStoryboard().shots[1].id
    storyboard.applyStoryboardEdit({ operation: 'attach_take', shotId: demoShotId, assetId: 'take-1', label: 'Version A · flowing signal' })
    storyboard.applyStoryboardEdit({ operation: 'attach_take', shotId: demoShotId, assetId: 'take-2', label: 'Version B · restrained motion' })
    if (!standaloneStoryboard) {
      storyboard.applyStoryboardEdit({ operation: 'start_production', productionType: 'music-video', targetDurationSeconds: 45 })
      storyboard.applyStoryboardEdit({ operation: 'update_production', patch: { approach: 'story',
        concept: 'A creator follows a luminous signal through a sleeping city and finds a human connection at dawn.',
        visualStyle: 'Cinematic blue-hour neon shifting into warm dawn.', castMode: 'needed', locationMode: 'needed' } })
      const cast = storyboard.applyStoryboardEdit({ operation: 'add_cast_member', member: { name: 'Mara', role: 'Lead performer',
        description: 'A thoughtful creator following the signal. Dark jacket, teal accent; keep wardrobe consistent.', referenceAssetIds: ['character-mara-front', 'character-mara-profile'] } })
      const location = storyboard.applyStoryboardEdit({ operation: 'add_location', location: { name: 'Signal city',
        description: 'A neon skyline opening into warm daylight.', referenceAssetIds: ['reference-4'] } })
      storyboard.getStoryboard().shots.forEach((shot, index) => {
        storyboard.applyStoryboardEdit({ operation: 'update_shot', shotId: shot.id, patch: { durationSeconds: [10, 12, 11, 12][index],
          storyboardAssetId: `reference-${index + 1}`,
          referenceAssetIds: index === 1 ? [`reference-${index + 1}`, 'signal-prop'] : [`reference-${index + 1}`] } })
        storyboard.applyStoryboardEdit({ operation: 'set_shot_direction', shotId: shot.id, patch: {
          castIds: [cast.memberId], locationId: location.locationId, lipSync: false, notes: 'Restrained camera movement; preserve the recurring light motif.' } })
      })
      for (const stage of ['concept', 'cast-locations', 'animatic']) storyboard.applyStoryboardEdit({ operation: 'review_production_stage', stage, decision: 'approve' })
    }
  }
  project.setState({ projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0 })
  dirty.markProjectClean()
  resetView()
}
reset()
window.storyboardTest = {
  ready: false, reset, runMcpAction,
  apply: request => storyboard.applyStoryboardEdit(request),
  snapshot: () => ({ board: clone(storyboard.getStoryboard()), revision: storyboard.getStoryboardRevision(),
    projectName: project.getState().currentProject?.name, projectHandle: project.getState().currentProjectHandle,
    historyCount: project.getState().projectHistory.length, futureCount: project.getState().projectFuture.length,
    timelineHistoryCount: timeline.getState().history.length, timelineHistoryIndex: timeline.getState().historyIndex,
    dirty: dirty.isProjectDirty(), timeline: JSON.stringify(timeline.getState().getProjectData()),
    assetIds: assets.getState().assets.map(asset => asset.id), calls: clone(calls), forbiddenCalls: clone(forbiddenCalls),
    filePaths: [...files.keys()], error: project.getState().error }),
  getMcpSnapshot: buildMcpSnapshot,
  timelineSnapshot: () => {
    const summarize = data => ({ duration: data.duration,
      tracks: (data.tracks || []).map(({ id, type, name }) => ({ id, type, name })),
      clips: (data.clips || []).map(clip => ({ id: clip.id, assetId: clip.assetId, type: clip.type, trackId: clip.trackId,
        startTime: clip.startTime, duration: clip.duration, trimStart: Number(clip.trimStart) || 0 })) })
    return { currentTimelineId: project.getState().currentTimelineId, active: summarize(timeline.getState().getProjectData()),
      timelines: project.getState().currentProject?.timelines.map(item => ({ id: item.id, name: item.name, ...summarize(item) })) || [] }
  },
  rawStoryboard: () => clone(project.getState().currentProject?.storyboard),
  setRawStoryboard: board => project.setState(state => ({ currentProject: { ...state.currentProject, storyboard: clone(board) } })),
  markClean: () => dirty.markProjectClean(),
  setNoProject: () => project.setState({ currentProject: null, currentProjectHandle: null, projectHistory: [], projectFuture: [] }),
  removeAsset: id => assets.setState(state => ({ assets: state.assets.filter(asset => asset.id !== id) })),
  restoreAsset: id => assets.setState(state => ({ assets: [...state.assets.filter(asset => asset.id !== id), clone(seededAssets.find(asset => asset.id === id))] })),
  setAssetName: (id, name) => assets.setState(state => ({ assets: state.assets.map(asset => asset.id === id ? { ...asset, name } : asset) })),
  setBrokenImagePreview: (id, broken) => assets.setState(state => ({ assets: state.assets.map(asset => asset.id === id
    ? { ...asset, url: broken ? 'data:image/png;base64,AA==' : seededAssets.find(original => original.id === id)?.url }
    : asset) })),
  setVideoPosterPresent: (id, present) => assets.setState(state => ({ assets: state.assets.map(asset => asset.id === id
    ? { ...asset, poster: present ? clone(seededAssets.find(original => original.id === id)?.poster) : null }
    : asset) })),
  save: () => project.getState().saveProject(),
  saved: () => JSON.parse(files.get(`${projectRoot}/project.comfystudio`) || 'null'),
  reopen: () => project.getState().openProject(projectRoot),
  switchProject: () => reset({ empty: true, name: 'Another isolated project', root: secondRoot }),
  seedTimelineEdit: () => {
    timeline.getState().saveToHistory()
    timeline.setState(state => ({ tracks: state.tracks.map(track => ({ ...track, name: 'Fixture timeline edit' })) }))
  },
  undo: () => runMcpAction('undo', { previewOnly: false }),
  redo: () => runMcpAction('redo', { previewOnly: false }),
}
function Fixture() {
  const [panelVisible, setPanelVisible] = React.useState(true)
  const [panelHeight, setPanelHeight] = React.useState(null)
  const [viewVersion, setViewVersion] = React.useState(0)
  resetView = () => setViewVersion(version => version + 1)
  window.storyboardTest.setPanelVisible = setPanelVisible
  window.storyboardTest.setPanelHeight = setPanelHeight
  React.useEffect(() => { window.storyboardTest.ready = true }, [])
  return <div className="h-screen min-w-0 flex flex-col bg-sf-dark-950 text-sf-text-primary" data-testid="storyboard-fixture">
    <header className="shrink-0 flex flex-wrap items-center gap-3 border-b border-sf-dark-700 p-3 text-xs">
      <span>Velorn · isolated {standaloneStoryboard ? 'Storyboard' : 'read-only reference board'}</span>
      {!standaloneStoryboard && <button onClick={() => reset({ empty: true })}>Clear synthetic board</button>}
      <button onClick={() => reset()}>Reset synthetic demo</button>
      <span className="text-sf-text-muted">Synthetic media · RAM only · resets on refresh · no real files, generation or app settings</span>
    </header>
    <main className="flex-1 min-h-0 min-w-0" style={panelHeight ? { flex: '0 0 auto', height: panelHeight } : undefined}>
      {panelVisible && (standaloneStoryboard ? <StoryboardPanel key={viewVersion} /> : <ProductionWorkspace key={viewVersion} />)}
    </main>
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
