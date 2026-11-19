import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import * as envelope from '../../src/utils/audioVolumeEnvelope.mjs'
import * as eq from '../../src/utils/audioEq.mjs'
import * as gain from '../../src/utils/audioClipGain.js'
import * as fades from '../../src/utils/audioClipFades.js'
import * as ducking from '../../src/utils/audioDucking.mjs'
import * as sampling from '../../src/utils/frameSampling.js'
import * as cues from '../../src/utils/captionCueEditing.js'
import { TIMELINE_PROJECT_KEYS } from '../../src/services/projectDirtyTracker.js'

const require = createRequire(import.meta.url)
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL('../../src/stores/timelineStore.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'] }).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', compiled)(require, module, module.exports, { getItem: () => null, setItem() {}, removeItem() {} })
const timelineStore = module.exports.useTimelineStore
const initial = timelineStore.getState()

export const plain = value => JSON.parse(JSON.stringify(value))
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)) }
  throw new Error('Expected asynchronous state was not reached')
}
export function loadBody(relative, globals, names) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*(?:\r?\n|$)/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const)\s)/gm, '')
  return vm.runInNewContext(`'use strict';\n${source}\n;({${names.join(',')}})`, globals, { filename: relative })
}

export function fixture(options = {}) {
  const music = { id: 'music', name: 'Music', type: 'audio', assetId: 'music-source', trackId: 'music-track',
    startTime: 0, duration: 8, trimStart: 0, trimEnd: 8, sourceDuration: 8, speed: 1,
    gainDb: 0, fadeIn: 0, fadeOut: 0 }
  const dialogue = { ...music, id: 'voice', name: 'Dialogue', assetId: 'voice-source', trackId: 'voice-track' }
  const video = { id: 'video', type: 'video', assetId: 'video-source', trackId: 'video-track',
    startTime: 0, duration: 8, trimStart: 0, trimEnd: 4, sourceDuration: 4, speed: 0.5, sourceFps: 24,
    frameSampling: 'optical-flow', keyframes: {} }
  const project = { currentProjectHandle: '/synthetic/project', currentTimelineId: 'timeline-1', currentProject: { id: 'p', settings: { width: 1920, height: 1080, fps: 24 } } }
  const assets = { assets: [
    { id: music.assetId, name: 'Music', type: 'audio', duration: 8, path: 'assets/audio/music.wav' },
    { id: dialogue.assetId, name: 'Voice', type: 'audio', duration: 8, path: 'assets/audio/voice.wav' },
    { id: video.assetId, name: 'Video', type: 'video', duration: 4, absolutePath: '/synthetic/video.mp4', settings: { fps: 24 } },
  ], folders: [], getAssetById(id) { return this.assets.find(asset => asset.id === id) } }
  timelineStore.setState({ ...initial, clips: [music, dialogue, video],
    tracks: [{ id: 'video-track', type: 'video' }, { id: 'music-track', type: 'audio', volume: 100 }, { id: 'voice-track', type: 'audio', volume: 100 }],
    transitions: [], markers: [], timelineFps: 24, timelineSessionId: 'session-1', compoundEditContext: null,
    history: [], historyIndex: -1, selectedClipIds: ['music'], masterAudioVolume: 100, masterAudioInserts: [], inPoint: null, outPoint: null,
  })
  const counters = { analyze: 0, build: 0, cancel: 0, fonts: [] }
  const projectListeners = new Set()
  const projectStore = { getState: () => project, subscribe: callback => { projectListeners.add(callback); return () => projectListeners.delete(callback) } }
  const assetsStore = { getState: () => assets }
  const globals = { ...envelope, ...eq, ...gain, ...fades, ...ducking, ...sampling, ...cues, TIMELINE_PROJECT_KEYS,
    console, AbortController, URL, Blob, File, structuredClone, crypto: { randomUUID: () => 'test-session' },
    useTimelineStore: timelineStore, useAssetsStore: assetsStore, useProjectStore: projectStore,
    async analyzeAudioDucking(args) {
      counters.analyze++
      if (options.analyze) return options.analyze(args)
      return ducking.buildDuckingEnvelope(args.state.clips.find(clip => clip.id === args.musicId), [{ start: 2, end: 3 }], args.settings)
    },
    async buildOpticalFlowCache(id, settings) {
      counters.build++
      if (options.build) return options.build(id, settings, timelineStore)
      timelineStore.getState().setOpticalFlowCache(id, { status: 'ready', path: 'cache/synthetic.mp4', progress: 100 })
    },
    async cancelOpticalFlowCache() { counters.cancel++; return options.cancel ? options.cancel() : true },
    getOpticalFlowClipStatus: clip => ({ state: clip.opticalFlowCache?.status || 'missing', usable: clip.opticalFlowCache?.status === 'ready' }),
    async loadSystemFontFamilies(settings) {
      counters.fonts.push(settings)
      return { status: 'ready', source: 'system', families: ['Inter', 'Arial', 'Helvetica'], error: null }
    },
  }
  Object.assign(globals, loadBody('../../src/services/mcpContext.js', globals, ['captureMcpContext', 'assertMcpContext']))
  return { store: timelineStore, project, assets, projectStore, assetsStore, globals, counters,
    clip: id => timelineStore.getState().clips.find(clip => clip.id === id),
    notifyProject: () => projectListeners.forEach(callback => callback(project)),
    audio() { return loadBody('../../src/services/mcpAudioParity.js', globals, ['MCP_AUDIO_ACTIONS']).MCP_AUDIO_ACTIONS },
    captions(overrides = {}) {
      return loadBody('../../src/services/mcpCaptions.js', { ...globals,
        transcribeAsset: async () => ({ cues: [{ id: 'a', start: 0, end: 2, text: 'Hello world' }], audioDuration: 8 }),
        transcribeTimelineAudio: async () => ({ cues: [{ id: 'a', start: 0, end: 2, text: 'Hello world' }], audioDuration: 8 }),
        CAPTION_PRESETS: [{ id: 'kinetic-pop', name: 'Pop', fontFamily: 'Inter' }], DEFAULT_CAPTION_PRESET_ID: 'kinetic-pop',
        isElectron: () => true, saveCaptionSidecar: async () => ({}), buildKineticStyleWithColors: () => ({}),
        ...overrides,
      }, ['handleTranscribeCaptions', 'handleGetCaptionStatus', 'handleUpdateCaptionCues', 'handleGenerateCaptions'])
    },
  }
}
