// Isolated UI/service exercise. Only an explicit ?live=1 uses the local GPU.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import GenerateMusicPopover from '../../src/components/GenerateMusicPopover'
import useTimelineStore from '../../src/stores/timelineStore'
import useAssetsStore from '../../src/stores/assetsStore'
import useProjectStore from '../../src/stores/projectStore'
import useMusicPopoverStore from '../../src/stores/musicPopoverStore'
import { comfyui } from '../../src/services/comfyui'
import { buildAceStepWorkflow, buildYue2Workflow, getMusicJobs, refreshMusicJobs } from '../../src/services/musicGeneration'
import { saveLocalComfyConnectionPort } from '../../src/services/localComfyConnection'

const live = new URLSearchParams(location.search).get('live') === '1'
const queued = []
let offline = false, missing = false
let mockAudioSeconds = 2
const objectInfo = {}
for (const graph of [buildAceStepWorkflow(), buildYue2Workflow()]) {
  for (const node of Object.values(graph)) {
    const required = Object.fromEntries(Object.entries(node.inputs).filter(([, value]) => !Array.isArray(value))
      .map(([key, value]) => [key, /^(ckpt_name|unet_name|vae_name|clip_name1|clip_name2)$/.test(key) ? [[value]] : [typeof value === 'string' ? 'STRING' : 'FLOAT']]))
    objectInfo[node.class_type] = { input: { required }, output: ['AUDIO'], output_node: node.class_type.startsWith('Save') }
  }
}
function wav() {
  const frames = 8000 * mockAudioSeconds, data = new ArrayBuffer(44 + frames * 2), view = new DataView(data)
  const text = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.sin(i * 0.17) * 1000, true)
  return data
}
const realFetch = window.fetch.bind(window)
if (!live) {
  comfyui.getObjectInfo = async () => missing ? { ...objectInfo, YuE2GenerateABC: undefined } : objectInfo
  comfyui.queuePrompt = async graph => { queued.push(graph); return 'music-test-' + queued.length }
  window.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:8189')) {
      if (offline) throw new Error('Fixture offline')
      const pathname = new URL(url).pathname
      if (pathname === '/system_stats') return Response.json({ system: {}, devices: [] })
      if (pathname.startsWith('/history/')) return Response.json({ [pathname.split('/').pop()]: { outputs: { 107: { audio: [{ filename: pathname.split('/').pop() + '.wav', subfolder: 'audio', type: 'output' }] } }, status: { completed: true, status_str: 'success' } } })
      if (pathname === '/view') return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } })
      throw new Error('Unexpected mock request: ' + url)
    }
    return realFetch(url, options)
  }
}
// Narrow bridge stand-in; the runner limits every path to its own temporary folder.
const files = (action, ...args) => window.musicTestFiles({ action, args })
window.electronAPI = {
  isElectron: true,
  getSetting: async key => key === 'comfyConnection' ? { port: 8189 } : null,
  pathJoin: (...parts) => files('join', ...parts), pathBasename: path => files('basename', path),
  createDirectory: path => files('mkdir', path), exists: path => files('exists', path),
  writeFileFromArrayBuffer: (path, data) => files('write', path, [...new Uint8Array(data)]),
  getFileInfo: path => files('stat', path), getFileUrlDirect: path => files('url', path),
}
await saveLocalComfyConnectionPort(8189)
useProjectStore.setState({ currentProject: { name: 'Isolated music test', settings: { fps: 24 }, timelines: [] }, currentProjectHandle: window.musicTestProject })
useAssetsStore.setState({ assets: [], folders: [] })
useTimelineStore.setState({ tracks: [{ id: 'audio-test', type: 'audio', name: 'Music' }], clips: [],
  playheadPosition: 6, inPoint: null, outPoint: null, duration: 30, history: [], historyIndex: -1 })
useMusicPopoverStore.setState({ backend: 'yue2', tags: 'gentle solo piano, instrumental, no vocals, slow reflective melody',
  lyrics: '', instrumental: true, variations: 1, durationSeconds: 12,
  yue2LengthMode: live ? 'custom' : 'automatic', yue2CustomDurationSeconds: 12, sessionPromptIds: [] })
window.musicTest = { queued, jobs: getMusicJobs, refresh: refreshMusicJobs, assets: useAssetsStore,
  timeline: useTimelineStore, project: useProjectStore, form: useMusicPopoverStore,
  setOffline: value => { offline = value }, setMissing: value => { missing = value },
  setMockAudioSeconds: value => { mockAudioSeconds = value } }
function Harness() {
  const [open, setOpen] = useState(true)
  return <div className="min-h-screen bg-sf-dark-950 text-sf-text-primary p-8">
    <h1 className="text-xl">Velorn · Music generator test</h1>
    <button onClick={() => setOpen(true)}>Open music</button>
    {open && <GenerateMusicPopover onClose={() => setOpen(false)} anchorRect={{ left: 60, top: 90, bottom: 110 }} />}
  </div>
}
createRoot(document.getElementById('root')).render(<Harness />)
