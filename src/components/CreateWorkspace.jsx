import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Check, ChevronDown, Cloud, Monitor, ExternalLink, FolderOpen, Image as ImageIcon, Library, Mic, Music, Play, Plus, SlidersHorizontal, Square, Video, Volume2, X } from 'lucide-react'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import { importRouterImage } from '../services/comfyRouterImages'
import {
  COMFY_CLOUD, TEMPOS, cloudVoiceWorkflow, tempoBpm, withTempo, IDEAS, KIND_ORDER, LOCAL_MUSIC, LOCAL_SOUND, LOCAL_VOICE, stableAudioWorkflow, LOCAL_PRICE, MOODS, placeOf, soniloWorkflow, NOUN, PLACEHOLDERS, SOUND_KINDS, lengthLabel, localMusicProblem, localMusicRequest, SHAPES, SIZE_LABELS, RESOLUTION_LABELS, PICTURE_TYPES, PICTURE_MAX_BYTES, capital, isAudioKind, rateText, chargedText, creditsText, defaultModel, fitNote, fitOptions, footnote,
  goLabel, needText, pictureTypeFor, priceText, problemFor, problemForJob, recordedPrice, sameDeal, unfinishedCreateJobs, usablePictures,
} from '../services/createFlow.mjs'
import { NETWORK_KNOWN_KEY, NETWORK_PICTURE, NETWORK_PRICE, NETWORK_STATE, NETWORK_VIDEO_TEXT, NETWORK_WORKFLOW, jobKind, networkCandidates, networkLabel, networkModels, offeredWorkflows, tryNextComputer } from '../services/velornNetworkJob.mjs'
import { velornNetwork } from '../services/velornNetwork'
import SoundRings from './SoundRings'
import SoundPlayer from './SoundPlayer'
import LocalVoiceSetup from './LocalVoiceSetup'
import SoundModelSetup from './SoundModelSetup'
import './CreateWorkspace.css'
import starterExplorer from '../assets/create/starter-explorer.webp'
import starterNebula from '../assets/create/starter-nebula.webp'
import starterCar from '../assets/create/starter-car.webp'
import starterRobot from '../assets/create/starter-robot.webp'
import starterCity from '../assets/create/starter-city.webp'

// Starter cards shown until the person has pictures of their own. Each was made
// with Create (Nano Banana Pro) from the description it carries; choosing a card
// puts that description in the box. Order is left to right, centre card third.
const STARTERS = [
  { src: starterNebula, name: 'A nebula', prompt: 'A vast nebula in violet, deep blue and rose pink, with a bright cluster of young stars at its heart and thin dark dust lanes crossing it, ultra-detailed space photograph, rich colour, no text' },
  { src: starterRobot, name: 'A friendly robot', prompt: 'A friendly small robot with round glass eyes sitting on a crate and holding a glowing paper lantern, surrounded by floating fireflies in a night garden, soft 3D animated film style, warm and charming' },
  { src: starterExplorer, name: 'An explorer', prompt: 'A lone astronaut standing on a ridge of dark volcanic rock, looking up at a huge ringed planet that fills the sky, warm golden light on the suit, deep blue shadows, cinematic film still, shallow depth of field' },
  { src: starterCar, name: 'A concept car', prompt: 'A sleek silver concept car parked on a reflective black floor inside a glass observation deck in orbit, Earth glowing through the windows behind it, studio lighting, premium car photography, no text or logos' },
  { src: starterCity, name: 'A city at dusk', prompt: 'A futuristic city at dusk seen from a high balcony, slender towers with gold-lit windows, a pale moon and a second smaller moon in a purple sky, light trails of flying vehicles, atmospheric haze' },
]

const KIND_LOOK = { image: { label: 'Image', Icon: ImageIcon }, video: { label: 'Video', Icon: Video },
  voice: { label: 'Voice', Icon: Mic }, sound: { label: 'Effects', Icon: Volume2 }, music: { label: 'Music', Icon: Music } }
// A short recording of each voice, played before anything is spent. A voice
// without a recording simply has no play button.
const SAMPLES = Object.fromEntries(Object.entries(import.meta.glob('../assets/sound/voice-*.{mp3,wav}', { eager: true, import: 'default' }))
  .map(([file, url]) => [/voice-([a-z0-9_-]+)\.(?:mp3|wav)$/.exec(file)?.[1], url]).filter(([id]) => id))
const CREATE_KINDS = ['image', 'video']
const EACH_KIND = value => Object.fromEntries(KIND_ORDER.map(id => [id, value()]))
const DOCKED = ['generating', 'result', 'trouble', 'rules']
// Whether this computer has already shown the Velorn network's rules.
// v2 (2026-11-16): the IP address is kept. v3 (2026-11-17): a reported job's result goes to reviewers. Each change shows the rules once more.
const NETWORK_RULES_KEY = 'velorn.network.rules.v3'
const networkRulesSeen = () => { try { return Boolean(window.localStorage.getItem(NETWORK_RULES_KEY)) } catch { return false } }
// The shared workflows this computer has ever been offered. One that nobody offers right now is then shown as not available, not hidden.
const networkKnown = () => { try { const list = JSON.parse(window.localStorage.getItem(NETWORK_KNOWN_KEY) || '[]'); return Array.isArray(list) ? list.filter(id => typeof id === 'string').slice(0, 20) : [] } catch { return [] } }
const NETWORK_DOT = { ready: '#4ADE80', busy: '#FBBF24', unavailable: '#71717A' }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function encode(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
async function readPicture(file) {
  if (!PICTURE_TYPES.includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP picture.')
  if (file.size > PICTURE_MAX_BYTES) throw new Error('That picture is larger than 10 MB. Choose a smaller one.')
  // `owned` marks a preview link this tab made and must release later.
  return { name: file.name, mimeType: file.type, base64: encode(new Uint8Array(await file.arrayBuffer())), url: URL.createObjectURL(file), owned: true }
}
// A picture that is already in the project's assets.
async function readAssetPicture(asset) {
  const mimeType = pictureTypeFor(asset)
  if (!mimeType) throw new Error('Only PNG, JPEG and WebP pictures can be used here.')
  let buffer = null
  if (asset.absolutePath && window.electronAPI?.readFileAsBuffer) {
    const read = await window.electronAPI.readFileAsBuffer(asset.absolutePath)
    if (read?.success) buffer = read.data
  }
  if (!buffer && asset.url) buffer = await (await fetch(asset.url)).arrayBuffer()
  if (!buffer) throw new Error('That picture could not be opened from the project.')
  const bytes = new Uint8Array(buffer)
  if (!bytes.length) throw new Error('That picture could not be opened from the project.')
  if (bytes.length > PICTURE_MAX_BYTES) throw new Error('That picture is larger than 10 MB. Choose a smaller one.')
  return { name: asset.name || 'Project picture', mimeType, base64: encode(bytes), url: asset.url, owned: false }
}
const release = picture => { if (picture?.owned && picture.url) URL.revokeObjectURL(picture.url) }

// One screen, two tabs: Create makes pictures and clips, Sound makes voice,
// music and effects. They share the key, the prices and the whole request flow.
// mode 'create' and 'sound' are the two tabs of that name. mode 'shared' is the same box inside the GPU sharing tab:
// it offers only what shared GPUs offer, picked from cards instead of the model list, and Create no longer lists those.
export default function CreateWorkspace({ mode = 'create', onShare = null }) {
  const sound = mode === 'sound'
  const sharedOnly = mode === 'shared'
  const api = typeof window !== 'undefined' ? window.electronAPI?.comfyRouter : null
  const [models, setModels] = useState([])
  const [rate, setRate] = useState(null) // Comfy credits per dollar
  const [status, setStatus] = useState(null)
  const [kind, setKind] = useState(sound ? 'voice' : 'image')
  const [lyrics, setLyrics] = useState('')
  const [place, setPlace] = useState('cloud') // Sound tab: made in the cloud, or on this computer
  const [localReady, setLocalReady] = useState({}) // local model id -> true, false, or null while checking
  const [allVoices, setAllVoices] = useState(false)
  const [playing, setPlaying] = useState('') // the voice whose sample is playing
  const player = useRef(null)
  useEffect(() => () => { player.current?.pause() }, [])
  const [chosen, setChosen] = useState({})
  const [elevenVoices, setVoices] = useState([]) // ElevenLabs voices, from the main process
  const [wanted, setWanted] = useState(() => EACH_KIND(() => ({})))
  const [prompts, setPrompts] = useState(() => EACH_KIND(() => ''))
  const [pictures, setPictures] = useState({ image: null, video: null })
  const [pictureUse, setPictureUse] = useState('start')
  const [step, setStep] = useState('compose')
  const [pop, setPop] = useState(null)
  const [keyValue, setKeyValue] = useState('')
  const [keyError, setKeyError] = useState('')
  const [notice, setNotice] = useState('')
  const [trouble, setTrouble] = useState(null)
  const [jobs, setJobs] = useState([]) // the requests of the current run
  const [results, setResults] = useState([]) // what they produced, in the order they finished
  const [placed, setPlaced] = useState({}) // assetId -> true once added to the timeline
  const [live, setLive] = useState(null) // { signature, estimate } from Comfy at click time
  const [resumed, setResumed] = useState(false) // the current run was picked up from before, not started just now
  const pending = useRef(null) // a prepared request waiting for a fresh click
  const run = useRef(0)
  const watched = useRef(new Set()) // requests this tab has already followed since Velorn opened
  const stepNow = useRef(step); stepNow.current = step
  const projectPath = useProjectStore(state => (typeof state.currentProjectHandle === 'string' ? state.currentProjectHandle : state.currentProject?.name || ''))
  const fileInput = useRef(null)
  // Workflows that computers share with this account show as video and picture models; which computer runs a job is Velorn's choice.
  const net = sharedOnly && typeof window !== 'undefined' ? window.electronAPI?.gpuNetwork : null
  const [netHosts, setNetHosts] = useState([])
  const [netProblem, setNetProblem] = useState('') // why the list of shared GPUs could not be read, in the person's words
  const [netLoaded, setNetLoaded] = useState(false)
  const [netKnown, setNetKnown] = useState(networkKnown)
  useEffect(() => {
    const seen = offeredWorkflows(netHosts)
    if (!seen.some(id => !netKnown.includes(id))) return
    const next = [...new Set([...netKnown, ...seen])].sort()
    setNetKnown(next)
    try { window.localStorage.setItem(NETWORK_KNOWN_KEY, JSON.stringify(next)) } catch { /* Remembered for this run. */ }
  }, [netHosts, netKnown])
  const netState = useSyncExternalStore(velornNetwork.subscribe, velornNetwork.state)
  // A small menu (models, options, add a picture) closes when the person clicks anywhere else or presses Escape.
  useEffect(() => {
    if (!['models', 'opts', 'add'].includes(pop)) return undefined
    const away = event => { if (!event.target?.closest?.('.vc-pop, [aria-expanded="true"]')) setPop(null) }
    const key = event => { if (event.key === 'Escape') setPop(null) }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key) }
  }, [pop])
  const netStarted = useRef('') // the network job started from this box, as opposed to one picked up
  const [reporting, setReporting] = useState(false)
  const [reported, setReported] = useState('') // the job whose workflow was reported
  const reportWorkflow = async result => {
    setReporting(false)
    try { const sent = await net.reportWorkflow(result.reportable); if (sent?.success) setReported(result.jobId); else setNotice(sent?.error || 'That could not be reported.') }
    catch { setNotice('That could not be reported.') }
  }
  const loadNetHosts = useCallback(async () => {
    if (!net?.hosts) return
    try {
      const listed = await net.hosts()
      setNetHosts(listed?.success && Array.isArray(listed.hosts) ? listed.hosts : [])
      setNetProblem(listed?.success ? (listed.banned ? 'This account can no longer send jobs on the Velorn network.' : '') : listed?.error || 'The Velorn network could not be reached.')
    } catch { setNetHosts([]); setNetProblem('The Velorn network could not be reached.') }
    setNetLoaded(true)
  }, [net])
  // What is free changes by the minute, so the cards are checked again now and then while they are on screen.
  useEffect(() => { void loadNetHosts(); if (!net) return undefined; const timer = setInterval(() => { if (!document.hidden) void loadNetHosts() }, 15000); return () => clearInterval(timer) }, [loadNetHosts, net])

  const refreshStatus = useCallback(async () => {
    if (!api?.status) return
    try { const next = await api.status({}); if (next?.success) setStatus(next) } catch { /* keep the last known status */ }
  }, [api])
  useEffect(() => {
    let active = true
    ;(async () => {
      if (!api?.models) return
      try { const listed = await api.models({}); if (active && listed?.success) { setModels([...listed.models, ...COMFY_CLOUD, ...LOCAL_MUSIC, ...LOCAL_SOUND, ...LOCAL_VOICE]); setRate(listed.creditsPerUsd || null); setVoices(Array.isArray(listed.voices) ? listed.voices : []) } } catch { /* shown as unavailable below */ }
      if (active) refreshStatus()
    })()
    return () => { active = false; run.current++ }
  }, [api, refreshStatus])
  const held = useRef(pictures); held.current = pictures
  useEffect(() => () => { for (const picture of Object.values(held.current)) release(picture) }, [])
  const projectAssets = useAssetsStore(state => state.assets)
  const projectPictures = useMemo(() => usablePictures(projectAssets), [projectAssets])
  // Once this project has five pictures made here, they take the place of the starter cards.
  const ownResults = useMemo(() => projectPictures.filter(asset => asset.source === 'comfy-router').slice(0, 5), [projectPictures])

  const video = kind === 'video'
  const audio = isAudioKind(kind)
  const noun = NOUN(kind)
  // Create offers pictures and clips. Voice, effects and music are built and
  // tested underneath, but wait for their own Sound tab before they are shown.
  // The Sound tab always offers its three kinds; a kind with no model on this side says so.
  const kinds = sound ? SOUND_KINDS : CREATE_KINDS.filter(id => models.some(m => m.kind === id))
  const loop = kind === 'sound' && place === 'cloud' && wanted.sound.loop === true
  const withLyrics = kind === 'music' && wanted.music.vocals === true
  const shared = useMemo(() => (sharedOnly ? networkModels(netHosts, { known: netKnown }) : []), [sharedOnly, netHosts, netKnown])
  const ofKind = useMemo(() => (sharedOnly ? shared : models).filter(m => m.kind === kind && (!sound || placeOf(m) === place)), [models, shared, sharedOnly, kind, sound, place])
  // The cards are grouped by who shares them. Two creators may pick the same name, so a group is one computer, not one name.
  const sharedGroups = useMemo(() => {
    const groups = new Map()
    for (const m of shared) {
      const id = m.hosts?.[0]?.hostId || m.id
      if (!groups.has(id)) groups.set(id, { id, name: m.maker || 'A Velorn creator', list: [] })
      groups.get(id).list.push(m)
    }
    return [...groups.values()]
  }, [shared])
  // In the GPU sharing tab a card is the choice of model and of what to make at once. Until one is picked, the first that can run is.
  useEffect(() => {
    if (!sharedOnly || !shared.length || shared.some(m => m.kind === kind && m.id === chosen[kind])) return
    const first = shared.find(m => m.state === 'ready') || shared[0]
    setKind(first.kind); setChosen(all => ({ ...all, [first.kind]: first.id }))
  }, [sharedOnly, shared, kind, chosen])
  const model = ofKind.find(m => m.id === chosen[kind]) || defaultModel(ofKind, kind)
  const picture = audio ? null : pictures[kind]
  const editing = kind === 'image' && Boolean(picture)
  // Each voice model brings its own voices; ElevenLabs' come from the main process.
  const voices = kind === 'voice' && model?.voices ? model.voices : elevenVoices
  const options = fitOptions(model, wanted[kind], { voices })
  const bpm = kind === 'music' ? tempoBpm(wanted.music.tempo) : null
  // A shared GPU makes one picture per job.
  const count = kind === 'image' && !model?.network && [2, 4].includes(wanted.image.count) ? wanted.image.count : 1
  const prompt = prompts[kind]
  const connected = Boolean(status?.configured)
  const signature = JSON.stringify([model?.id, options, count, loop, prompt.trim(), picture ? [picture.name, picture.base64.length, video ? pictureUse : ''] : null])
  // A sung Sonilo song has its own rate.
  const priced = model?.usdPerAudioSecondSung && withLyrics ? { ...model, usdPerAudioSecond: model.usdPerAudioSecondSung } : model
  const each = recordedPrice(priced, options, { hasPicture: Boolean(picture), characters: prompt.trim().length })
  const recorded = each && { usd: each.usd * count, firm: each.firm }
  const shown = live?.signature === signature ? live.estimate && { usd: live.estimate.usd, firm: live.estimate.firm } : recorded
  // Speech has no price until there is something to say, so the rate is shown instead.
  const shownText = !model ? '' : model.network ? NETWORK_PRICE : model.local ? LOCAL_PRICE : !shown && kind === 'voice' && model ? rateText(model, rate) : priceText(shown, { editing, rate })
  const busy = step === 'sending' || step === 'generating'
  const docked = DOCKED.includes(step)
  const runVideo = jobs.some(item => item.kind === 'video')
  const runNetwork = jobs.some(item => item.network)

  const setOption = (name, value) => setWanted(all => ({ ...all, [kind]: { ...all[kind], [name]: value } }))
  const apply = useCallback(problem => {
    setTrouble(null); setKeyError(''); setNotice('')
    if (problem.screen === 'connect') { setKeyError(problem.keyError || ''); setStep('connect'); refreshStatus() }
    else if (problem.screen === 'nocredits') setStep('nocredits')
    else if (problem.screen === 'trouble') { setTrouble(problem); setStep('trouble') }
    else { setNotice(problem.notice || ''); setStep('compose') }
  }, [refreshStatus])

  // Saves one finished request into the project. Returns the result, or a message when it could not be saved.
  const collect = useCallback(async finished => {
    const saved = await importRouterImage(finished.jobId, { previewOnly: false })
    if (!saved?.success) return { error: saved?.error || 'The result could not be added to your project.' }
    const asset = useAssetsStore.getState().assets.find(item => item.id === saved.assetId)
    return { jobId: finished.jobId, assetId: saved.assetId, url: asset?.url || '', type: asset?.type || finished.kind, chargedUsd: finished.chargedUsd, chargedCredits: finished.chargedCredits, modelLabel: finished.modelLabel }
  }, [])
  // Ends a run: show what was made, or explain why nothing was.
  const settle = useCallback((made, failures, unsaved, token) => {
    if (token !== run.current) return
    if (made.length) {
      setResults(made); setStep('result')
      const missing = failures.length + unsaved.length
      setNotice(missing ? `${missing} of ${made.length + missing} ${missing === 1 ? "wasn't" : "weren't"} made or saved. The ${made.length === 1 ? 'one' : 'ones'} that worked ${made.length === 1 ? 'is' : 'are'} below.` : '')
    } else if (unsaved.length) {
      setTrouble({ kind: 'unsaved', title: "It finished, but couldn't be saved", body: unsaved[0].error,
        note: 'Nothing new was generated. The result stays on Comfy for 24 hours.', primary: 'Try saving again', retry: unsaved.map(item => item.job) })
      setStep('trouble')
    } else apply(failures[0])
  }, [apply])

  // Watches every request of a run until each has finished, saving results as they arrive.
  const follow = useCallback(async (started, token, about = null) => {
    // A run picked up from before is described by its own requests, not by what the box shows now.
    const context = about ? { model: null, kind: about.kind } : { model, kind }
    const nounOf = context.kind === 'video' ? 'video' : 'image'
    const waiting = new Map(started.map(item => [item.jobId, item]))
    const made = [], failures = [], unsaved = []
    let misses = 0
    while (waiting.size && token === run.current) {
      await wait(Math.max(2500, Math.min(...[...waiting.values()].map(item => item.retryAfterMs || 0), 15000)))
      for (const current of [...waiting.values()]) {
        if (token !== run.current) return
        let answer
        try { answer = await api.refresh({ jobId: current.jobId }) } catch { answer = null }
        if (token !== run.current) return
        if (!answer?.success) {
          if (++misses < 4 * started.length && !['COMFY_ROUTER_AUTH', 'COMFY_ROUTER_KEY_REQUIRED', 'COMFY_ROUTER_UNCERTAIN'].includes(answer?.code)) continue
          failures.push(answer?.code ? problemFor(answer, context) : { screen: 'trouble', kind: 'lost', title: 'We lost touch with Comfy',
            body: `Your ${nounOf} may still be on its way. Check your Comfy usage page before generating again, or you could pay twice for the same thing.`,
            note: "Velorn won't send this request again on its own.", primary: 'Back to Create' })
          waiting.delete(current.jobId); continue
        }
        misses = 0
        const next = answer.job
        waiting.set(next.jobId, next)
        setJobs(all => all.map(item => (item.jobId === next.jobId ? next : item)))
        if (next.status === 'COMPLETED') {
          waiting.delete(next.jobId)
          const saved = await collect(next)
          if (token !== run.current) return
          if (saved.error) unsaved.push({ job: next, error: saved.error }); else { made.push(saved); setResults([...made]) }
        } else if (next.status === 'FAILED' || next.status === 'CANCELLED' || next.status === 'UNCERTAIN') { waiting.delete(next.jobId); failures.push(problemForJob(next, context)) }
      }
    }
    settle(made, failures, unsaved, token)
  }, [api, collect, kind, model, settle])

  // Requests that were still being made when Velorn closed (or that finished but
  // were never saved) are picked up again: watched and collected, never re-sent.
  // Runs when the tab opens, when a key arrives, and when the project changes.
  const followNow = useRef(follow); followNow.current = follow
  useEffect(() => {
    if (!api?.list || !connected) return undefined
    let active = true
    ;(async () => {
      let listed
      try { listed = await api.list({}) } catch { return }
      if (!active || !listed?.success || stepNow.current !== 'compose') return
      // Each tab picks up only what it makes, so the two never follow the same request.
      const left = unfinishedCreateJobs(listed.jobs, Date.now()).filter(item => !watched.current.has(item.jobId) && isAudioKind(item.kind) === sound)
      if (!left.length) return
      for (const item of left) watched.current.add(item.jobId)
      const token = ++run.current
      setJobs(left); setResults([]); setPlaced({}); setNotice(''); setPop(null); setResumed(true); setStep('generating')
      followNow.current(left, token, { kind: left[0].kind || 'image' })
    })()
    return () => { active = false }
  }, [api, connected, projectPath])

  // Music is made by ComfyUI on this computer, through the same service as the
  // timeline's Music button. No key, no price, nothing sent to Comfy. The
  // service saves the finished audio into the project by itself.
  const generateLocal = async () => {
    if (withLyrics && !lyrics.trim()) { setNotice('Write the lyrics, or choose Instrumental.'); return }
    const token = ++run.current
    setStep('sending')
    const cloud = model.via === 'comfyui', plain = model.via === 'workflow', builtin = model.via === 'builtin'
    let read, queued
    try {
      if (builtin) {
        const service = await import('../services/localVoice')
        read = service.getLocalVoiceJobs
        queued = await service.queueLocalVoice({ text: prompt, voice: options.voice, label: model.name })
      } else if (plain) {
        const service = await import('../services/soundGeneration')
        read = service.getSoundJobs
        queued = await service.queueSoundWorkflow({ workflow: stableAudioWorkflow({ prompt, seconds: options.seconds, seed: Math.floor(Math.random() * 2 ** 32) }),
          outputNodeId: '8', label: model.name, title: prompt.trim(), cloud: false })
      } else if (cloud) {
        const service = await import('../services/soundGeneration')
        read = service.getSoundJobs
        const seed = Math.floor(Math.random() * 2 ** 31)
        const built = model.kind === 'voice' ? cloudVoiceWorkflow(model, { text: prompt, voice: options.voice, seed })
          : { outputNodeId: '2', workflow: soniloWorkflow({ prompt: withTempo(prompt, bpm), seconds: options.seconds, lyrics: withLyrics ? lyrics : '', seed }) }
        queued = await service.queueSoundWorkflow({ ...built, label: model.name, title: prompt.trim(), cloud: true })
      } else {
        const service = await import('../services/musicGeneration')
        read = service.getMusicJobs
        queued = await service.queueMusicGeneration(localMusicRequest(model, prompt, options, withLyrics ? lyrics : '', bpm))
      }
    } catch (error) {
      if (token === run.current) { setNotice(builtin ? error?.message || 'The voice could not be made.' : cloud ? error?.message || 'The request could not be sent. Check that ComfyUI is running.' : localMusicProblem(error)); setStep('compose') }
      return
    }
    if (token !== run.current) return
    const started = queued.map(item => ({ jobId: item.promptId, kind: model.kind, local: !cloud, slow: model.kind === 'music', modelLabel: model.name, status: 'IN_QUEUE' }))
    setJobs(started); setResults([]); setPlaced({}); setResumed(false); setStep('generating')
    const ids = started.map(item => item.jobId)
    while (token === run.current) {
      await wait(builtin ? 500 : 3000)
      if (token !== run.current) return
      const now = read(ids)
      const failed = now.find(item => item.status === 'failed')
      if (failed || !now.length) {
        setTrouble({ kind: 'local', title: `The ${NOUN(model.kind)} wasn't made`, body: failed?.error || (builtin ? 'Velorn lost track of this request.' : 'ComfyUI lost track of this request.'),
          note: cloud ? 'Your Comfy usage page shows whether this attempt was charged.' : 'Nothing was charged: this ran on your computer.', primary: 'Back' })
        setStep('trouble'); return
      }
      if (now.every(item => item.status === 'completed')) {
        const assets = useAssetsStore.getState().assets
        const made = now.flatMap(item => item.assetIds).map(id => assets.find(asset => asset.id === id)).filter(Boolean)
          .map(asset => ({ jobId: asset.promptId || asset.id, assetId: asset.id, url: asset.url, type: 'audio', modelLabel: model.name, local: !cloud, viaComfy: cloud }))
        if (!made.length) { setNotice('It was made, but it is no longer in the project.'); setStep('compose'); return }
        setResults(made); setNotice(''); setStep('result'); return
      }
    }
  }

  // A clip or a picture made on a shared GPU. The follower outside this tab sends
  // it, watches it and saves the result; the effect below shows where it stands.
  const generateNetwork = async ({ agreed = false } = {}) => {
    const pictureJob = model.kind === 'image'
    // A creator's own workflow says what it starts from; Velorn's own are known.
    if (model.own && model.needsImage && !picture) { setNotice(`Add a picture first. ${model.name} starts from it.`); return }
    if (model.own && !model.needsImage && picture) { setNotice(`${model.name} starts from the description only. Remove the picture, or choose another model.`); return }
    if (!model.own && !pictureJob && !picture && !model.makes) { setNotice('Add a picture first. The clip starts from it.'); return }
    if (!model.own && !pictureJob && picture && !model.edits) { setNotice('No shared computer makes a clip from a picture right now. Remove the picture to make one from the description, or choose another workflow.'); return }
    if (model.state === 'unavailable') { setNotice(model.note); void loadNetHosts(); return }
    if (!model.own && pictureJob && picture && !model.edits) { setNotice('No shared computer edits pictures right now. Remove the picture to make one from the description, or choose another model.'); return }
    if (!model.own && pictureJob && !picture && !model.makes) { setNotice('No shared computer makes pictures from a description right now. Add a picture to edit, or choose another model.'); return }
    const workflowId = model.own ? model.ownId : !pictureJob ? (picture ? NETWORK_WORKFLOW : NETWORK_VIDEO_TEXT) : picture ? NETWORK_PICTURE.edit : NETWORK_PICTURE.make
    const computers = networkCandidates(model, workflowId)
    if (!computers.length) { setNotice('No shared computer can take this right now. Try again later.'); void loadNetHosts(); return }
    if (!projectPath) { setNotice(`Open or save a project first, so the ${pictureJob ? 'picture' : 'clip'} has somewhere to go.`); return }
    // Someone else's computer: the rules are shown once on this computer before the first job goes.
    if (computers.some(computer => !computer.ownComputer) && !agreed && !networkRulesSeen()) { setNotice(''); setStep('rules'); return }
    if (agreed) { try { window.localStorage.setItem(NETWORK_RULES_KEY, String(Date.now())) } catch { /* Shown again next time. */ } }
    run.current++
    setStep('sending')
    // An edit keeps its picture's own shape, so only a new picture is given one.
    const choices = model.own ? { prompt: prompt.trim() } : !pictureJob ? { prompt: prompt.trim(), shape: options.shape, size: options.resolution, seconds: options.seconds }
      : picture ? { prompt: prompt.trim() } : { prompt: prompt.trim(), shape: options.shape }
    const image = picture ? { mimeType: picture.mimeType, bytes: Uint8Array.from(atob(picture.base64), char => char.charCodeAt(0)) } : null
    // The best computer first; the next one only when a computer turns the job away.
    let sent = null
    for (const computer of computers) {
      sent = await velornNetwork.send({ hostId: computer.hostId, hostName: computer.hostName, workflowId, choices, image,
        ...(model.own ? { label: `${model.name} · by ${model.maker}`, kind: model.kind } : {}) })
      if (sent.success || !tryNextComputer(sent.code)) break
    }
    if (sent.success) { netStarted.current = sent.job.jobId; return }
    setNotice(sent.error); setStep('compose'); void loadNetHosts()
  }
  useEffect(() => {
    if (!sharedOnly) return
    const showing = jobs.length > 0 && jobs.every(item => item.network) && (step === 'generating' || step === 'sending')
    const free = step === 'compose' || step === 'sending' || showing
    if (!free || !netState.job) return
    const label = netState.job.label || networkLabel(netState.job.workflowId)
    const made = jobKind(netState.job)
    if (netState.phase === 'running' || netState.phase === 'saving') {
      if (showing && jobs[0].jobId === netState.job.jobId && step === 'generating') return
      run.current++
      setJobs([{ jobId: netState.job.jobId, kind: made, network: true, modelLabel: label, status: 'IN_PROGRESS' }])
      setResults([]); setPlaced({}); setPop(null); setNotice(''); setResumed(netStarted.current !== netState.job.jobId); setStep('generating')
    } else if (netState.phase === 'done') {
      const asset = useAssetsStore.getState().assets.find(item => item.id === netState.assetId)
      velornNetwork.clear(); void loadNetHosts()
      if (asset) { setResults([{ jobId: netState.job.jobId, assetId: asset.id, url: asset.url, type: made, modelLabel: label, network: true, madeOn: netState.job.hostName,
        // A creator's own workflow can be reported by the person who just used it.
        ...(/^own-[a-f0-9]{16}$/.test(netState.job.workflowId || '') && netState.job.hostId ? { reportable: { hostId: netState.job.hostId, workflowId: netState.job.workflowId } } : {}) }]); setNotice(''); setStep('result') }
      else { setNotice(`Your ${made === 'image' ? 'picture' : 'clip'} is in the project’s assets.`); setStep('compose') }
    } else if (netState.phase === 'failed') {
      velornNetwork.clear(); void loadNetHosts()
      if (netState.cancelled) { setNotice('Stopped. Nothing was saved.'); setStep('compose') }
      else { setTrouble({ kind: 'network', title: `The ${made === 'image' ? 'picture' : 'video'} wasn't made`, body: netState.error, note: 'Nothing was charged: the Velorn network is free.', primary: 'Back' }); setStep('trouble') }
    }
  }, [sharedOnly, netState, step, jobs, loadNetHosts])

  const generate = async () => {
    if (busy || !api || !model) return
    setPop(null); setNotice('')
    if (!prompt.trim()) { setNotice(editing ? 'Describe what should change first.' : kind === 'voice' ? 'Write what the voice should say first.' : 'Write a description first.'); return }
    if (kind === 'voice' && !options.voice) { setNotice('No voice is available yet.'); return }
    if (model.network) return generateNetwork()
    if (model.local || model.via === 'comfyui') return generateLocal()
    if (!connected) { setKeyError(''); setStep('connect'); return }
    const token = ++run.current
    setStep('sending')
    try {
      let planId = pending.current?.signature === signature ? pending.current.planId : null
      if (!planId) {
        const choices = { prompt: prompt.trim(), ...options, ...(loop ? { loop: true } : {}), ...(picture ? { picture: { mimeType: picture.mimeType, base64: picture.base64 }, ...(video ? { pictureUse } : {}) } : {}) }
        const plan = await api.previewCreate({ modelId: model.id, choices, ...(count > 1 ? { count } : {}) })
        if (token !== run.current) return
        if (!plan?.success) return apply(problemFor(plan, { model, kind }))
        const quoted = plan.estimate ? { usd: plan.estimate.usd, firm: plan.estimate.firm } : null
        setLive({ signature, estimate: plan.estimate })
        pending.current = { signature, planId: plan.planId }
        // The click approved the price that was on the button. If Comfy's price
        // is higher, show it and wait for a fresh click.
        if (plan.buttonApproval && !sameDeal(shown, quoted)) {
          setNotice(`Comfy's price for this is ${priceText(quoted, { rate })}. Press Generate again to go ahead.`); setStep('compose'); return
        }
        planId = plan.planId
      }
      let sent
      try { sent = await api.submitCreate({ planId }) }
      catch { setNotice('Press Generate once more to send it.'); setStep('compose'); return }
      if (token !== run.current) return
      pending.current = null
      if (!sent?.success) return apply(problemFor(sent, { model, kind }))
      const started = sent.jobs?.length ? sent.jobs : [sent.job]
      for (const item of started) watched.current.add(item.jobId)
      setJobs(started); setResults([]); setPlaced({}); setResumed(false); setStep('generating')
      if (sent.partial) setNotice(`Only ${started.length} of ${count} could be sent. ${sent.stopped?.code === 'COMFY_ROUTER_UNCERTAIN' ? 'One has an unclear outcome: check your Comfy usage page before generating again.' : 'Comfy refused the next one, so the rest were not sent.'}`)
      follow(started, token)
    } catch {
      if (token === run.current) apply(problemFor({}, { model, kind }))
    }
  }

  const stop = async () => {
    if (!jobs.length) return
    if (runNetwork) { setNotice('Stop requested.'); return velornNetwork.cancel() }
    setNotice('Stop requested. Comfy may still finish and charge for it.')
    for (const item of jobs) { try { await api.cancel({ jobId: item.jobId }) } catch { /* the status check reports what happened */ } }
  }
  const backToCompose = () => { run.current++; setTrouble(null); setStep('compose') }
  const connect = async () => {
    if (!keyValue.trim() || !api) return
    setKeyError('')
    let answer
    try { answer = await api.connect({ apiKey: keyValue.trim() }) } catch { answer = { success: false } }
    setKeyValue('')
    if (!answer?.success) { setKeyError(problemFor(answer).keyError || answer?.error || 'Velorn could not reach Comfy. Check your connection and try again.'); return }
    await refreshStatus(); setStep('compose')
    setNotice(answer.remembered ? 'Connected. Your key is remembered on this computer. You can forget it in Settings, under ComfyUI Connection.' : 'Connected. Your key is kept until Velorn closes.')
  }
  const usePicture = (next, forKind = kind) => { setPictures(all => { release(all[forKind]); return { ...all, [forKind]: next } }); setNotice('') }
  const addPicture = async event => {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    try { usePicture(await readPicture(file)) } catch (error) { setNotice(error.message) }
  }
  const addFromProject = async (asset, forKind = kind) => {
    setPop(null)
    try { usePicture(await readAssetPicture(asset), forKind); return true } catch (error) { setNotice(error?.message || 'That picture could not be opened from the project.'); return false }
  }
  // Carry a finished picture straight into the next request.
  const reuseResult = async (result, forKind) => {
    const asset = useAssetsStore.getState().assets.find(item => item.id === result?.assetId)
    if (!asset) { setNotice('That picture is no longer in the project.'); return }
    run.current++
    if (await addFromProject(asset, forKind)) { setKind(forKind); if (forKind === 'video') setPictureUse('start'); setStep('compose') }
  }
  // Puts a result at the end of the first unlocked video track. One undo removes it.
  const addToTimeline = result => {
    const asset = useAssetsStore.getState().assets.find(item => item.id === result.assetId)
    const timeline = useTimelineStore.getState()
    const lane = asset?.type === 'audio' ? 'audio' : 'video'
    const track = (timeline.tracks || []).find(item => item.type === lane && !item.locked)
    if (!asset || !track) { setNotice(asset ? `There is no unlocked ${lane} track to add this to.` : 'That result is no longer in the project.'); return }
    const clip = timeline.addClip(track.id, asset)
    if (!clip) { setNotice('It could not be added to the timeline. It is still in your assets.'); return }
    setPlaced(all => ({ ...all, [result.assetId]: true })); setNotice(`Added to the end of ${track.name || `the ${lane} track`}.`)
  }
  const removePicture = () => setPictures(all => { release(all[kind]); return { ...all, [kind]: null } })

  if (!api?.models) return <div className="vcreate" data-layout="open"><p className="vc-muted">Create is available in the Velorn desktop app.</p></div>
  const roleLabel = video ? (pictureUse === 'reference' && !model?.network ? 'Use as reference' : 'Start from this picture') : 'Edit this picture'
  const summary = kind === 'voice' ? voices.find(v => v.id === options.voice)?.name || 'Voice' : audio ? `${options.seconds} seconds` : `${SHAPES.find(s => s.id === options.shape)?.label} · ${video ? `${options.seconds} seconds${options.resolution !== '720p' ? ` · ${options.resolution}` : ''}` : `${count} ${count === 1 ? 'image' : 'images'}${options.size !== '1K' ? ` · ${options.size}` : ''}`}`
  const note = fitNote(model, wanted[kind])
  const audioOptions = kind === 'voice'
    ? <div className="vc-group" role="group" aria-label="Voice"><span>Voice</span>
        <div className="vc-voices">{voices.map(v => <button key={v.id} type="button" className="vc-opt vc-voice" aria-pressed={options.voice === v.id} onClick={() => setOption('voice', v.id)}>{v.name}<small>{v.note}</small></button>)}</div>
      </div>
    : <div className="vc-group" role="group" aria-label="Length"><span>Length</span>
        <div className="vc-opts" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>{(model?.seconds?.offered || []).map(n => <button key={n} type="button" className="vc-opt" aria-pressed={options.seconds === n} onClick={() => setOption('seconds', n)}>{n < 60 ? `${n} seconds` : `${n / 60} ${n === 60 ? 'minute' : 'minutes'}`}</button>)}</div>
      </div>
  const playSample = id => {
    player.current?.pause()
    // Listening to a voice is choosing it: the one you heard last is the one that will speak.
    if (!busy) setWanted(all => ({ ...all, voice: { ...all.voice, voice: id } }))
    if (playing === id || !SAMPLES[id]) { setPlaying(''); return }
    const next = new Audio(SAMPLES[id])
    player.current = next
    next.onended = () => setPlaying(current => (current === id ? '' : current))
    next.play().then(() => setPlaying(id)).catch(() => setPlaying(''))
  }
  const pickedOutside = voices.findIndex(v => v.id === options.voice) >= 5
  const shownVoices = allVoices || pickedOutside ? voices : voices.slice(0, 5)
  const hasSamples = voices.some(v => SAMPLES[v.id])
  // What to start from in the Sound tab. Shown on the opening screen and again
  // under a finished result, so another voice, mood or idea is one click away.
  const emptySide = sound && !model && models.length > 0
  const waitingOnLocal = Boolean(model?.local) && localReady[model.id] === false
  const soundStrips = sound && <>
        {emptySide && <p className="vc-empty-side" role="status">{place === 'local'
          ? 'There is no local model for this in Velorn yet. It is made in the Cloud for now.'
          : 'There is no cloud model for this yet.'} <button type="button" className="vc-quiet" onClick={() => setPlace(place === 'local' ? 'cloud' : 'local')}>Switch to {place === 'local' ? 'Cloud' : 'Local'}</button></p>}
        {model?.via === 'builtin' && <LocalVoiceSetup key={model.id} model={model}
          onReady={ready => setLocalReady(all => (all[model.id] === ready ? all : { ...all, [model.id]: ready }))} onUseCloud={() => setPlace('cloud')} />}
        {model?.local && model.workflowId && <SoundModelSetup key={model.id} model={model} what={kind === 'music' ? 'Songs' : 'Effects'}
          onReady={ready => setLocalReady(all => (all[model.id] === ready ? all : { ...all, [model.id]: ready }))} onUseCloud={() => setPlace('cloud')} />}
        {kind === 'voice' && model && voices.length > 0 && <section className="vc-strip" aria-label="Pick a voice">
          <div className="vc-row vc-between">
            <span className="vc-small" style={{ fontSize: 13 }}>{hasSamples ? 'Press play to hear a voice, free. The highlighted one will speak.' : 'Pick a voice. The highlighted one will speak.'}</span>
            {voices.length > 5 && !pickedOutside && <button type="button" className="vc-quiet" style={{ minHeight: 44 }} onClick={() => setAllVoices(all => !all)}>{allVoices ? 'Fewer voices' : `All ${voices.length} voices`}</button>}
          </div>
          <div className="vc-voice-cards">{shownVoices.map(v => <div key={v.id} className="vc-voice-card" data-picked={options.voice === v.id}>
            {SAMPLES[v.id] && <button type="button" className="vc-play" aria-label={playing === v.id ? `Stop ${v.name}'s sample` : `Play ${v.name}'s sample`} onClick={() => playSample(v.id)}>
              {playing === v.id ? <Square aria-hidden="true" size={14} fill="currentColor" /> : <Play aria-hidden="true" size={15} fill="currentColor" />}</button>}
            <button type="button" className="vc-voice-pick" aria-pressed={options.voice === v.id} disabled={busy} onClick={() => setOption('voice', v.id)}><b>{v.name}</b><small>{v.note}</small></button>
            {options.voice === v.id && <Check aria-hidden="true" size={16} color="#C4B8FF" strokeWidth={2.6} style={{ flex: '0 0 auto' }} />}
          </div>)}</div>
        </section>}
        {kind === 'music' && <section className="vc-strip vc-row" aria-label="Start from a mood" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <span className="vc-small" style={{ fontSize: 13 }}>Start from a mood</span>
          {MOODS.map(mood => <button key={mood.name} type="button" className="vc-mood" disabled={busy} onClick={() => { setPrompts(all => ({ ...all, music: mood.prompt })); setNotice('') }}>{mood.name}</button>)}
        </section>}
        {kind === 'sound' && <section className="vc-ideas" aria-label="Ideas to start from">
          {IDEAS.map(text => <button key={text} type="button" className="vc-idea" disabled={busy} onClick={() => { setPrompts(all => ({ ...all, sound: text })); setNotice('') }}><span><Volume2 aria-hidden="true" size={16} /></span>{text}</button>)}
        </section>}
  </>
  const troubleAction = () => {
    if (trouble?.kind === 'failed') return generate()
    if (trouble?.kind === 'unsaved' && trouble.retry?.length) {
      const token = ++run.current; setStep('generating')
      return (async () => {
        const made = [], unsaved = []
        for (const item of trouble.retry) { const saved = await collect(item); if (token !== run.current) return; if (saved.error) unsaved.push({ job: item, error: saved.error }); else made.push(saved) }
        settle(made, [], unsaved, token)
      })()
    }
    backToCompose()
  }

  return (
    <div className="vcreate" data-mode={mode} data-place={sound ? place : undefined} data-layout={docked ? 'docked' : 'open'}>
    <div className="vc-inner">
      {sharedOnly ? <header className="vc-shared-head">
        <div><h1 className="vc-shared-title">GPU sharing</h1><p className="vc-muted">Free. Made on other creators’ computers when they are not using them.</p></div>
        {onShare && <button type="button" className="vc-line" onClick={onShare}><Monitor aria-hidden="true" size={16} />Share my GPU</button>}
      </header> : <h1 className="vc-title">What do you want to <span className="vc-title-glow">{sound ? 'hear' : 'make'}</span>?</h1>}
      {sharedOnly && !docked && (shared.length === 0
        ? <p className="vc-muted vc-shared-empty" role="status">{!netLoaded ? 'Looking for shared GPUs…' : netProblem || 'Nothing is shared with this account yet. When a creator invites you, or opens a workflow to everyone, it shows here.'}</p>
        : sharedGroups.map(group => <section key={group.id} className="vc-shared-group" aria-label={`Workflows shared by ${group.name}`}>
            {/* One header per creator: the name they chose, and how many of their workflows are here. */}
            <h2 className="vc-shared-label"><span className="vc-shared-maker">{group.name}</span><span>{group.list.length} {group.list.length === 1 ? 'workflow' : 'workflows'}</span></h2>
            <div className="vc-shared-grid">{group.list.map(m => <button key={m.id} type="button" className="vc-shared-card" aria-pressed={m.id === model?.id} disabled={busy}
              onClick={() => { setKind(m.kind); setChosen(all => ({ ...all, [m.kind]: m.id })); setPop(null); setNotice('') }}>
              <span className="vc-shared-name">{m.name}</span>
              <span className="vc-shared-what">{m.kind === 'image' ? 'pictures' : 'video'}</span>
              <span className="vc-shared-note">{m.state === 'unavailable' ? m.note : m.note.replace(`By ${m.maker}. `, '').replace(' Free, on their shared GPU.', '')}</span>
              <span className="vc-shared-state"><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: NETWORK_DOT[m.state] }} />{NETWORK_STATE[m.state]}</span>
            </button>)}</div>
          </section>))}
      {sound && <div className="vc-place" role="group" aria-label="Where it is made">
        <button type="button" aria-pressed={place === 'cloud'} disabled={busy} onClick={() => { setPlace('cloud'); setPop(null); setNotice('') }}><Cloud aria-hidden="true" size={16} />Cloud<small>Comfy credits</small></button>
        <button type="button" aria-pressed={place === 'local'} disabled={busy} onClick={() => { setPlace('local'); setPop(null); setNotice('') }}><Monitor aria-hidden="true" size={16} />Local<small>free, this computer</small></button>
      </div>}
      {!docked && sound && <>
        <div className="vc-swave" aria-hidden="true"><span className="vc-swave-glow" /><span className="vc-swave-bars" data-kind={kind} /></div>
        {soundStrips}
      </>}
      {!docked && !sound && !sharedOnly && (ownResults.length === 5
        ? <div className="vc-fan" role="group" aria-label="Your recent pictures">{ownResults.map(asset => <button key={asset.id} type="button" className="vc-card" disabled={busy}
            title="Use this picture" aria-label={`Use your picture ${asset.name || ''}`} onClick={() => addFromProject(asset)}><img src={asset.url} alt="" loading="lazy" /></button>)}</div>
        : <div className="vc-fan" role="group" aria-label="Ideas to start from">{STARTERS.map(card => <button key={card.name} type="button" className="vc-card" disabled={busy}
            title={`${card.name}: use this description`} aria-label={`${card.name}: put this description in the box`}
            onClick={() => { setKind('image'); setPrompts(all => ({ ...all, image: card.prompt })); setPop(null); setNotice('') }}><img src={card.src} alt="" /></button>)}</div>)}

      {step === 'generating' && <section className="vc-stage vc-rise" aria-live="polite">
        <div className="vc-coming" aria-hidden="true">
          <span className="vc-coming-glow" />
          <div className="vc-frame" style={{ aspectRatio: sound || jobs.some(item => isAudioKind(item.kind)) ? '3 / 1' : options.shape === 'square' ? '1 / 1' : options.shape === 'portrait' ? '9 / 16' : '16 / 9' }}>
            <span className="vc-frame-rim" />{sound ? <SoundRings className="vc-frame-rings" />
              : <span className="vc-frame-inner"><span className="vc-frame-cloud" /><span className="vc-frame-stars" /><span className="vc-frame-sweep" /></span>}
          </div>
        </div>
        <h2>{resumed ? 'Picking up where you left off' : jobs.length > 1 ? `Creating your ${jobs.length} images` : `Creating your ${noun}`}</h2>
        <p className="vc-muted">{resumed ? `${jobs.length > 1 ? `${jobs.length} requests were` : `Your ${NOUN(jobs[0]?.kind)} was`} still being made when you left. Nothing is sent or charged again. ` : 'You can keep working. '}
          {jobs.length > 1 ? 'They are' : 'It is'} saved to your project when {jobs.length > 1 ? 'they finish' : 'it finishes'}.</p>
        {(runVideo || runNetwork || jobs.some(item => item.slow) || (jobs.length > 1 && results.length > 0)) && <span className="vc-small" style={{ fontSize: 13.5 }}>{jobs.length > 1 && results.length > 0 ? `${results.length} of ${jobs.length} ready.` : runNetwork ? `${netState.text || 'Working on it.'}${netState.hostOnline === false ? ' The other computer is not answering right now.' : ''}` : runVideo ? 'Videos can take a few minutes.' : jobs.some(item => item.local) ? 'Music is made on this computer and can take several minutes.' : 'A song can take a minute or two.'}</span>}
        {/* Speech and sounds are sent in one go and finish in seconds; there is nothing to stop. */}
        {!jobs.every(item => isAudioKind(item.kind)) && <><button type="button" className="vc-line" onClick={stop}>Stop</button>
        {!runNetwork && <span className="vc-small">Stopping may not prevent a charge.</span>}</>}
      </section>}

      {step === 'rules' && <section className="vc-stage vc-rise" aria-label="Before you use a shared GPU">
        <h2>Before you use a shared GPU</h2>
        <p>This clip is made on someone else’s computer. Its owner can see your description and your picture.</p>
        <p>Every job is tied to your Velorn account. Velorn keeps your description, your IP address and a fingerprint of the picture and the clip for 30 days, to stop abuse. The owner can report a job; Velorn’s reviewers then see the result, and it is deleted once they decide.</p>
        <p><strong>No nudity and no sexual acts.</strong> Sending them gets your account and your internet connection banned from the Velorn network.</p>
        <div className="vc-row" style={{ justifyContent: 'center' }}>
          <button type="button" className="vc-go" onClick={() => void generateNetwork({ agreed: true })}>I understand, send it</button>
          <button type="button" className="vc-line" style={{ minHeight: 48 }} onClick={backToCompose}>Cancel</button>
        </div>
      </section>}

      {step === 'trouble' && trouble && <section className="vc-stage vc-rise" role="alert">
        <AlertTriangle aria-hidden="true" size={30} color="#FF9B8A" strokeWidth={1.8} />
        <h2>{trouble.title}</h2>
        <p>{trouble.body}</p>
        <span className="vc-small" style={{ fontSize: 13.5 }}>{trouble.note}</span>
        <div className="vc-row" style={{ justifyContent: 'center' }}>
          <button type="button" className="vc-go" onClick={troubleAction}>{trouble.primary}</button>
          {trouble.secondary && <button type="button" className="vc-line" style={{ minHeight: 48 }} onClick={backToCompose}>{trouble.secondary}</button>}
        </div>
      </section>}

      {step === 'result' && results.length > 0 && <section className="vc-result vc-rise" data-count={results.length}>
        <div className="vc-result-grid">{results.map(result => <figure key={result.assetId} className="vc-result-item">
          {result.type === 'video' ? <video src={result.url} controls playsInline /> : result.type === 'audio' ? <SoundPlayer src={result.url} path={useAssetsStore.getState().assets.find(asset => asset.id === result.assetId)?.absolutePath || ''} label={NOUN(result.kind || kind)} /> : <img src={result.url} alt={`Your new ${noun}`} />}
          <figcaption className="vc-row" style={{ padding: '0 4px' }}>
            <button type="button" className="vc-line" disabled={Boolean(placed[result.assetId])} onClick={() => addToTimeline(result)}>{placed[result.assetId] ? <><Check aria-hidden="true" size={15} />On the timeline</> : 'Add to timeline'}</button>
            {result.type === 'image' && <>
              <button type="button" className="vc-line" onClick={() => reuseResult(result, 'image')}>Edit this picture</button>
              <button type="button" className="vc-line" onClick={() => reuseResult(result, 'video')}>Make a video from it</button>
            </>}
          </figcaption>
        </figure>)}</div>
        <div className="vc-row vc-between" style={{ padding: '0 4px' }}>
          <span className="vc-row vc-muted" style={{ gap: 8, fontSize: 14.5 }}><Check aria-hidden="true" size={15} />Saved to your project's assets</span>
          <span className="vc-small">{results[0].modelLabel}{results[0].network ? ` · free, made on ${results[0].madeOn || 'a shared computer'}` : results[0].local ? ' · made on this computer, free' : results[0].viaComfy ? ' · charged through ComfyUI' : chargedText(results) ? ` · ${chargedText(results)}` : ''}</span>
        </div>
        {results[0].reportable && <div className="vc-row" style={{ padding: '0 4px', gap: 10, justifyContent: 'flex-end' }}>
          {reported === results[0].jobId ? <span className="vc-small">Reported. Thank you.</span>
            : reporting ? <><span className="vc-small">Report it as not doing what it says?</span>
                <button type="button" className="vc-quiet" onClick={() => void reportWorkflow(results[0])}>Yes, report</button>
                <button type="button" className="vc-quiet" onClick={() => setReporting(false)}>Cancel</button></>
            : <button type="button" className="vc-quiet" onClick={() => setReporting(true)}>Report this workflow</button>}
        </div>}
      </section>}

      {sound && step === 'result' && soundStrips}

      <div className="vc-box-wrap" style={sharedOnly && shared.length === 0 && step === 'compose' ? { display: 'none' } : undefined}>
        <section className="vc-box" aria-label={sound ? 'Sound' : 'Create'}>
          {!audio && <div className="vc-row">
            <input ref={fileInput} type="file" accept={PICTURE_TYPES.join(',')} className="vc-hidden" tabIndex={-1} aria-hidden="true" onChange={addPicture} />
            <div style={{ position: 'relative' }}>
              <button type="button" className="vc-round" aria-label="Add a picture" aria-expanded={pop === 'add'} disabled={busy} onClick={() => setPop(pop === 'add' ? null : 'add')}><Plus aria-hidden="true" size={18} /></button>
              {pop === 'add' && <div className="vc-pop vc-pop-add" role="group" aria-label="Add a picture" style={{ bottom: 'auto', top: 'calc(100% + 8px)' }}>
                <button type="button" className="vc-item" onClick={() => setPop('project')}><span className="vc-row" style={{ gap: 10 }}><Library aria-hidden="true" size={16} />From this project</span><span className="vc-cost">{projectPictures.length}</span></button>
                <button type="button" className="vc-item" onClick={() => { setPop(null); fileInput.current?.click() }}><span className="vc-row" style={{ gap: 10 }}><FolderOpen aria-hidden="true" size={16} />From your computer</span></button>
              </div>}
            </div>
            {!picture && <span className="vc-muted" style={{ fontSize: 14 }}>{video ? 'Add a picture to start from or use as a reference' : 'Add a picture to edit or use as a reference'}</span>}
            {picture && <div className="vc-media vc-rise">
              <img src={picture.url} alt={picture.name} />
              {video && !model?.network
                ? <button type="button" className="vc-chip" style={{ minHeight: 38, background: '#3A3A3F' }} aria-label={`How to use it: ${roleLabel}. Press to change.`}
                    onClick={() => setPictureUse(use => (use === 'start' ? 'reference' : 'start'))}>{roleLabel}<ChevronDown aria-hidden="true" size={14} /></button>
                : <span className="vc-chip" style={{ minHeight: 38, background: '#3A3A3F' }}>{roleLabel}</span>}
              <button type="button" className="vc-quiet" style={{ minHeight: 38, padding: '0 8px' }} aria-label="Remove picture" onClick={removePicture}><X aria-hidden="true" size={15} /></button>
            </div>}
          </div>}

          {!audio && pop === 'project' && <div className="vc-panel vc-rise">
            <div className="vc-row vc-between"><h2>Pictures in this project</h2><button type="button" className="vc-quiet" style={{ minHeight: 32 }} onClick={() => setPop(null)}>Close</button></div>
            {projectPictures.length === 0
              ? <p>There are no PNG, JPEG or WebP pictures in this project yet. Pictures you make here are added automatically.</p>
              : <div className="vc-grid">{projectPictures.map(asset => <button key={asset.id} type="button" className="vc-thumb" title={asset.name} onClick={() => addFromProject(asset)}>
                <img src={asset.url} alt={asset.name || 'Project picture'} loading="lazy" /><span>{asset.name}</span></button>)}</div>}
          </div>}

          <label style={{ display: 'block' }}>
            <span className="vc-hidden">Describe what you want</span>
            <textarea className="vc-prompt" rows={3} maxLength={model?.characters?.max || 4000} value={prompt} disabled={busy}
              placeholder={editing ? 'Describe what should change…' : PLACEHOLDERS[kind]}
              onChange={event => setPrompts(all => ({ ...all, [kind]: event.target.value }))} />
          </label>
          {sound && withLyrics && <label style={{ display: 'block' }}>
            <span className="vc-hidden">Lyrics</span>
            <textarea className="vc-prompt vc-lyrics" rows={3} maxLength={3000} value={lyrics} disabled={busy} placeholder="Write the lyrics…" onChange={event => setLyrics(event.target.value)} />
          </label>}
          {sound && kind !== 'voice' && step !== 'connect' && step !== 'nocredits' && <div className="vc-inline">
            {kind === 'music' && <div className="vc-inline-group" role="group" aria-label="Vocals"><span>Vocals</span>
              <button type="button" className="vc-opt" aria-pressed={!withLyrics} disabled={busy} onClick={() => setOption('vocals', false)}>Instrumental</button>
              <button type="button" className="vc-opt" aria-pressed={withLyrics} disabled={busy} onClick={() => setOption('vocals', true)}>With lyrics</button></div>}
            {kind === 'music' && <div className="vc-inline-group" role="group" aria-label="Tempo"><span>Tempo</span>
              {TEMPOS.map(item => <button key={item.id} type="button" className="vc-opt" aria-pressed={(wanted.music.tempo || 'auto') === item.id} disabled={busy} title={item.bpm ? `${item.bpm} beats a minute` : 'Let the model decide'} onClick={() => setOption('tempo', item.id)}>{item.label}</button>)}</div>}
            <div className="vc-inline-group" role="group" aria-label="Length"><span>Length</span>
              {(model?.seconds?.offered || []).map(n => <button key={n} type="button" className="vc-opt" aria-pressed={options.seconds === n} disabled={busy} onClick={() => setOption('seconds', n)}>{lengthLabel(n)}</button>)}</div>
            {kind === 'sound' && model && !model.local && <div className="vc-inline-group" role="group" aria-label="Repeat"><span>Repeat</span>
              <button type="button" className="vc-opt" aria-pressed={!loop} disabled={busy} onClick={() => setOption('loop', false)}>Plays once</button>
              <button type="button" className="vc-opt" aria-pressed={loop} disabled={busy} onClick={() => setOption('loop', true)}>Loops smoothly</button></div>}
          </div>}

          {notice && <p className="vc-notice vc-rise" role="status">{notice}</p>}

          {step === 'nocredits' && <div className="vc-panel vc-rise" role="alert">
            <h2>Not enough Comfy credits for this</h2>
            <p>{needText(shown, rate)} Add credits at platform.comfy.org, then come back and try again.</p>
            <div className="vc-row">
              <button type="button" className="vc-line" style={{ minHeight: 48 }} onClick={() => { setStep('compose'); setPop('models') }}>Choose a cheaper model</button>
              <button type="button" className="vc-quiet" onClick={() => setStep('compose')}>Back</button>
            </div>
          </div>}

          {step === 'connect' && <div className="vc-panel vc-rise">
            <h2>One step before your first {noun}</h2>
            <p>This runs on Comfy's servers and uses credits from your own Comfy account. What you wrote stays as it is.</p>
            <form className="vc-row" style={{ alignItems: 'flex-end' }} onSubmit={event => { event.preventDefault(); connect() }}>
              <label className="vc-hidden" htmlFor="vc-key">Comfy key</label>
              <input id="vc-key" className="vc-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} placeholder="Paste your Comfy key"
                value={keyValue} onChange={event => setKeyValue(event.target.value)} />
              <button type="submit" className="vc-go" disabled={!keyValue.trim()}>Connect</button>
            </form>
            {keyError && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={18} style={{ flex: '0 0 auto', marginTop: 1 }} />{keyError}</p>}
            <span className="vc-small">{status?.canRemember ? 'Your key is stored on this computer, encrypted by its password store. It is never shown again.' : "This computer has no protected password store, so the key is kept only until Velorn closes."}</span>
            <div className="vc-row vc-between" style={{ fontSize: 14, alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 320px' }}>
                <div><button type="button" className="vc-line" onClick={() => api.openGuide?.().catch(() => {})}>Get a Comfy key<ExternalLink aria-hidden="true" size={15} /></button></div>
                <span className="vc-small">No key yet? This opens Comfy's key page in your browser. Sign in, create a key, copy it, and paste it above.</span>
              </div>
              <button type="button" className="vc-quiet" onClick={() => setStep('compose')}>Not now</button>
            </div>
          </div>}

          {step !== 'connect' && step !== 'nocredits' && <div className="vc-row vc-between">
            <div className="vc-row" style={{ gap: 8 }}>
              {/* In the GPU sharing tab the card above is the choice. Once a result is showing the cards are out of view, so this is the way back to them. */}
              {sharedOnly ? (docked && <button type="button" className="vc-chip" disabled={busy} onClick={() => { setPop(null); setNotice(''); setTrouble(null); setStep('compose') }}><ChevronDown aria-hidden="true" size={14} style={{ transform: 'rotate(90deg)' }} />All workflows</button>) : <><div className="vc-seg" role="group" aria-label="What to make">
                {kinds.map(id => { const { label, Icon } = KIND_LOOK[id]; return <button key={id} type="button" aria-pressed={kind === id} disabled={busy} onClick={() => { setKind(id); setPop(null); setNotice('') }}><Icon aria-hidden="true" size={16} />{label}</button> })}
              </div>
              <div style={{ position: 'relative' }}>
                <button type="button" className="vc-chip" aria-expanded={pop === 'models'} disabled={busy} onClick={() => { if (pop !== 'models') void loadNetHosts(); setPop(pop === 'models' ? null : 'models') }}>{model?.name || 'Model'}<ChevronDown aria-hidden="true" size={14} /></button>
                {pop === 'models' && <div className="vc-pop vc-pop-models" role="group" aria-label="Model">
                  {ofKind.map((m, index) => <Fragment key={m.id}>
                  {/* Workflows other creators made and share come last, under their own heading. */}
                  {m.own && !ofKind[index - 1]?.own && <div className="vc-pop-heading" role="presentation">From creators</div>}
                  <button type="button" className="vc-item" aria-pressed={m.id === model?.id}
                    onClick={() => { setChosen(all => ({ ...all, [kind]: m.id })); setPop(null) }}>
                    <span>{m.name}<small>{m.note}</small></span>
                    {(() => { const price = recordedPrice(m, wanted[kind], { hasPicture: Boolean(picture), characters: prompt.trim().length })
                      const perK = !price && m.kind === 'voice'
                      const credits = perK ? creditsText(m.usdPer1kCharacters, rate) : price ? creditsText(price.usd, rate) : ''
                      if (m.network) return <span className="vc-cost">Free<small style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: NETWORK_DOT[m.state] }} />{NETWORK_STATE[m.state]}</small></span>
                      if (m.local) return <span className="vc-cost">Free<small>on this computer</small></span>
                      return <span className="vc-cost">{perK ? `$${m.usdPer1kCharacters.toFixed(2)} per 1,000 characters` : priceText(price, { editing })}{credits && <small>{credits}</small>}</span> })()}
                  </button></Fragment>)}
                </div>}
              </div></>}
              {sound && kind === 'voice' && model && voices.length > 0 && <button type="button" className="vc-chip" disabled={busy} aria-label={`Voice: ${summary}. Show all voices.`}
                onClick={() => { setAllVoices(true); if (step !== 'result') { setTrouble(null); setStep('compose') } }}><Mic aria-hidden="true" size={15} />{summary}</button>}
              {!sound && !model?.own && <div style={{ position: 'relative' }}>
                <button type="button" className="vc-chip" aria-expanded={pop === 'opts'} disabled={busy} onClick={() => setPop(pop === 'opts' ? null : 'opts')}><SlidersHorizontal aria-hidden="true" size={16} />{summary}</button>
                {pop === 'opts' && <div className="vc-pop vc-pop-opts">
                  {audio ? audioOptions : <><div className="vc-group" role="group" aria-label="Shape"><span>Shape</span>
                    <div className="vc-opts">{SHAPES.map(s => <button key={s.id} type="button" className="vc-opt" aria-pressed={options.shape === s.id} onClick={() => setOption('shape', s.id)}>
                      <span aria-hidden="true" className="vc-shape" style={{ width: s.w, height: s.h }} />{s.label}</button>)}</div>
                  </div>
                  {video ? <>
                    <div className="vc-group" role="group" aria-label="Length"><span>Length</span>
                      <div className="vc-opts">{(model?.seconds?.offered || []).map(n => <button key={n} type="button" className="vc-opt" aria-pressed={options.seconds === n} onClick={() => setOption('seconds', n)}>{n} seconds</button>)}</div>
                    </div>
                    <div className="vc-group" role="group" aria-label="Detail"><span>Detail</span>
                      <div className="vc-opts">{(model?.resolutions || []).map(r => <button key={r} type="button" className="vc-opt" aria-pressed={options.resolution === r} onClick={() => setOption('resolution', r)}>{RESOLUTION_LABELS[r]}</button>)}</div>
                    </div>
                  </> : <>
                    {!model?.network && <div className="vc-group" role="group" aria-label="How many"><span>How many</span>
                      <div className="vc-opts">{[1, 2, 4].map(n => <button key={n} type="button" className="vc-opt" aria-pressed={count === n} onClick={() => setOption('count', n)}>{n}</button>)}</div>
                      {count > 1 && <span className="vc-small">Each picture is its own request and is charged separately.</span>}
                    </div>}
                    <div className="vc-group" role="group" aria-label="Size"><span>Size</span>
                    <div className="vc-opts">{(model?.sizes || []).map(size => <button key={size} type="button" className="vc-opt" aria-pressed={options.size === size} onClick={() => setOption('size', size)}>{SIZE_LABELS[size]}</button>)}</div>
                    </div>
                  </>}</>}
                  {note && <span className="vc-small">{note}</span>}
                  <div className="vc-row vc-between" style={{ paddingTop: 12, borderTop: '1px solid #2A2A2D', fontSize: 14 }}><span className="vc-muted">With these choices</span><span style={{ fontWeight: 500 }}>{shownText}</span></div>
                </div>}
              </div>}
            </div>
            <div className="vc-row" style={{ gap: '10px 14px', marginLeft: 'auto' }}>
              <span className="vc-muted" style={{ fontSize: 14 }}>{capital(shownText)}</span>
              <button type="button" className="vc-go" disabled={busy || !model || waitingOnLocal} onClick={generate}>{goLabel({ step, kind, editing })}</button>
            </div>
          </div>}
        </section>
        {!docked && (model || !sound) && <p className="vc-small" style={{ fontSize: 14, textAlign: 'center' }}>
          {footnote({ connected, remembered: status?.remembered, model, price: shown })}
        </p>}
      </div>
    </div>
    </div>
  )
}
