// A look at the Create tab outside the app, against a PRETEND Comfy. Nothing
// here talks to the network or to Electron. Open with the Vite dev server:
//   /tests/manual/create-harness.html?as=connected   (or new, nocredits, blocked, oldkey, lost, failed)
import { createRoot } from 'react-dom/client'
import catalog from '../../electron/createModels.json'
import CreateWorkspace from '../../src/components/CreateWorkspace.jsx'

const scenario = new URLSearchParams(location.search).get('as') || 'new'
const state = { configured: scenario !== 'new', polls: 0 }
const later = (value, ms = 350) => new Promise(resolve => setTimeout(() => resolve(value), ms))
const failures = {
  nocredits: { success: false, code: 'COMFY_ROUTER_ACCESS', diagnostics: { httpStatus: 402, errorType: 'insufficient_credits' } },
  blocked: { success: false, code: 'COMFY_ROUTER_PROVIDER', diagnostics: { httpStatus: 400, errorType: 'content_policy_violation' } },
  oldkey: { success: false, code: 'COMFY_ROUTER_ACCESS', queueNotEnabled: true, diagnostics: { httpStatus: 403, errorType: 'not_enabled' } },
  lost: { success: false, code: 'COMFY_ROUTER_UNCERTAIN' },
  failed: { success: false, code: 'COMFY_ROUTER_PROVIDER', diagnostics: { httpStatus: 500 } },
}
const view = m => ({ id: m.id, kind: m.kind, name: m.name, note: m.note, default: m.default === true, refusalCharged: m.refusalCharged,
  firmQuote: m.quote === 'firm', editQuote: m.editQuote !== false,
  ...(m.kind === 'voice' ? { characters: m.characters, usdPer1kCharacters: m.usdPer1kCharacters }
    : m.kind === 'sound' || m.kind === 'music' ? { seconds: m.seconds, usdPerAudioSecond: m.usdPerAudioSecond }
    : m.kind === 'video' ? { seconds: m.seconds, resolutions: Object.keys(m.usdPerSecond), usdPerSecond: m.usdPerSecond } : { sizes: Object.keys(m.usdPerImage), usdPerImage: m.usdPerImage }) })
// ?pending=1 also shows the models and voices that are still waiting for a real check.
const everything = new URLSearchParams(location.search).has('pending')
window.electronAPI = { comfyRouter: {
  models: () => later({ success: true, models: catalog.models.filter(m => everything || !m.pending).map(view), buttonApprovalUsd: 2, creditsPerUsd: catalog.creditsPerUsd,
    voices: catalog.voices.filter(v => everything || v.verified).map(v => ({ id: v.id, name: v.name, note: v.note })) }, 50),
  status: () => later({ success: true, configured: state.configured, remembered: state.configured, canRemember: true, policy: 'ask-cloud' }, 50),
  connect: ({ apiKey }) => later(apiKey === 'bad' ? { success: false, code: 'COMFY_ROUTER_AUTH' } : (state.configured = true, { success: true, remembered: true })),
  clear: () => later((state.configured = false, { success: true })),
  openGuide: () => later({ success: true }),
  previewCreate: ({ modelId, choices }) => {
    const m = catalog.models.find(x => x.id === modelId)
    const usd = m.kind === 'voice' ? m.usdPer1kCharacters * choices.prompt.length / 1000 : m.kind === 'sound' || m.kind === 'music' ? m.usdPerAudioSecond * choices.seconds
      : m.kind === 'video' ? m.usdPerSecond[choices.resolution] * choices.seconds : m.usdPerImage[choices.size]
    state.kind = m.kind
    return later({ success: true, planId: 'plan', buttonApproval: Boolean(usd) && usd <= 2, estimate: usd ? { usd, firm: m.quote === 'firm' && !choices.picture } : null })
  },
  submitCreate: () => later(failures[scenario] || { success: true, job: { jobId: 'job', status: 'IN_QUEUE', kind: state.kind || 'image', modelLabel: 'Pretend model', retryAfterMs: 0 } }),
  refresh: () => later({ success: true, job: { jobId: 'job', status: ++state.polls > 3 ? 'COMPLETED' : 'IN_PROGRESS', kind: state.kind || 'image', modelLabel: 'Pretend model', chargedUsd: 0.0569, chargedCredits: 12 } }),
  cancel: () => later({ success: true }),
  // ?as=leftover pretends a clip was still being made when Velorn was last closed.
  list: () => later({ success: true, jobs: scenario === 'leftover' ? [{ jobId: 'job', create: true, status: 'IN_PROGRESS', kind: 'video', modelLabel: 'Pretend model',
    canRefresh: true, needsReconnect: false, createdAt: Date.now() - 20 * 60 * 1000, retryAfterMs: 0 }] : [] }),
  output: () => later({ success: false, error: 'This is the harness: there is no real result to save.' }),
  onChanged: () => () => {},
} }
// ?tab=sound shows the Sound tab (voice, music, effects) instead of Create.
// ?voice pretends the built-in voice model is downloaded and fetches its real files from
// their public addresses (about 115 MB, cached by the browser), so the model can be heard
// here. This is the one part of the harness that uses the network.
if (new URLSearchParams(location.search).has('voice')) {
  const MODEL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/'
  const RUNTIME = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/'
  window.electronAPI.localVoice = {
    status: async () => ({ success: true, installed: true, installing: false, totalBytes: 119e6, doneBytes: 119e6 }),
    install: async () => ({ success: true, installed: true }),
    read: async ({ path }) => { const reply = await fetch((path.endsWith('.wasm') ? RUNTIME : MODEL) + path); return reply.ok ? { success: true, bytes: new Uint8Array(await reply.arrayBuffer()) } : { success: false, error: `HTTP ${reply.status}` } },
    onProgress: () => () => {},
  }
}
// ?player shows the sound player on its own, with a bundled voice sample.
if (new URLSearchParams(location.search).has('player')) {
  const [{ default: SoundPlayer }, { default: sample }] = await Promise.all([import('../../src/components/SoundPlayer.jsx'), import('../../src/assets/sound/voice-af_heart.wav')])
  await import('../../src/components/CreateWorkspace.css')
  createRoot(document.getElementById('root')).render(<div className="vcreate" data-mode="sound" data-place={new URLSearchParams(location.search).get('player') || 'cloud'}><div className="vc-inner"><div className="vc-result" data-count="1"><SoundPlayer src={sample} label="voice" /></div></div></div>)
} else createRoot(document.getElementById('root')).render(<CreateWorkspace mode={new URLSearchParams(location.search).get('tab') === 'sound' ? 'sound' : 'create'} />)
