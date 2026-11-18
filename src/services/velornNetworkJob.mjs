// "Run on Velorn network" as the Create tab sees it: computers that share their
// GPU appear as video and picture models, and the one job in flight is followed
// from here until its clip or picture is in the project. No React, no window,
// so it can be tested.
export const NETWORK_WORKFLOW = 'ltx23-i2v'
// LTX 2.3 from a description alone; the one above starts from a picture.
export const NETWORK_VIDEO_TEXT = 'ltx23-t2v'
// MiniMax H3 pictures: one workflow makes a picture from a description, the other edits one.
export const NETWORK_PICTURE = Object.freeze({ make: 'h3-t2i', edit: 'h3-edit' })
export const isPictureWorkflow = id => id === NETWORK_PICTURE.make || id === NETWORK_PICTURE.edit
// How a shared workflow is named everywhere in Create. The computer that ran it is named only afterwards, as a thank-you.
export const networkLabel = workflowId => `${isPictureWorkflow(workflowId) ? 'MiniMax H3' : 'LTX 2.3'} · Shared GPU`
// What a job makes. A job for an owner's own workflow says so itself; Velorn's own are known by their id.
export const jobKind = job => ['image', 'video', 'music'].includes(job?.kind) ? job.kind : isPictureWorkflow(job?.workflowId) ? 'image' : 'video'
const nounOf = job => jobKind(job) === 'image' ? 'picture' : jobKind(job) === 'music' ? 'song' : 'clip'
// The stage texts speak of a clip; a picture job says picture.
const stageText = (key, job) => { const text = NETWORK_STAGE[key]; return text && nounOf(job) === 'picture' ? text.replace('The clip', 'The picture').replace('a few minutes', 'a minute or two') : text && nounOf(job) === 'song' ? text.replace('The clip', 'The song').replace('the clip', 'the song') : text }
export const NETWORK_PRICE = 'free, on the Velorn network'
// Every whole second the shared workflow accepts.
const SECONDS = Object.freeze([3, 4, 5, 6, 7, 8, 9, 10])
const RESOLUTIONS = Object.freeze(['720p', '1080p'])
export const NETWORK_STAGE = Object.freeze({ waiting: 'Waiting for the other computer to pick it up.', claimed: 'The other computer accepted it.', preparing: 'Getting ready.',
  queued: 'Waiting its turn on the other computer.', running: 'Being made. This usually takes a few minutes.',
  collecting: 'Almost done. The clip is on its way back.', sending: 'Almost done. The clip is on its way back.' })

// What Create lists is the workflow, not the computer: one model per shared
// workflow family, with whether it can be used right now. Velorn picks the
// computer when the job is sent (networkCandidates). A family nobody offers at
// the moment is still listed, as not available, once this account has seen it
// offered (`known`); an account that was never offered anything sees nothing.
// Velorn used to offer LTX 2.3 and MiniMax H3 as its own cards. Since 2026-11-16 it offers none (Jaime: owners share
// whatever they want; Velorn does not choose). The list is empty, so only creators' own workflows become cards.
const FAMILIES = Object.freeze([])
// Where a computer remembers which shared workflows it has been offered (see networkModels' `known`).
// The five shapes an owner's own workflow can have.
const OWN_SHAPES = Object.freeze({
  'text-to-picture': { kind: 'image', needsImage: false, note: 'Makes a picture from your description.' },
  'picture-edit': { kind: 'image', needsImage: true, note: 'Changes a picture you add.' },
  'picture-to-video': { kind: 'video', needsImage: true, note: 'Makes a clip from a picture you add.' },
  'text-to-video': { kind: 'video', needsImage: false, note: 'Makes a clip from your description.' },
  'text-to-music': { kind: 'music', needsImage: false, note: 'Makes music from your description. Add lyrics to have them sung.' } })
export const NETWORK_KNOWN_KEY = 'velorn.network.known.v1'
export const NETWORK_STATE = Object.freeze({ ready: 'Ready', busy: 'Busy', unavailable: 'Not available' })
const canUse = host => !Number.isInteger(host.remainingToday) || host.remainingToday > 0
export function networkModels(hosts, { known = [] } = {}) {
  const list = (Array.isArray(hosts) ? hosts : []).filter(host => host && typeof host.hostId === 'string' && Array.isArray(host.workflows))
  const models = []
  for (const family of FAMILIES) {
    const offering = list.filter(host => family.workflows.some(id => host.workflows.includes(id)))
    if (!offering.length && !family.workflows.some(id => Array.isArray(known) && known.includes(id))) continue
    const usable = offering.filter(canUse)
    const state = !usable.length ? 'unavailable' : usable.some(host => host.idle !== false) ? 'ready' : 'busy'
    const has = id => usable.some(host => host.workflows.includes(id))
    const note = state === 'unavailable' ? (offering.length ? 'You\'ve used today\'s free jobs. Check again later.' : 'No shared computer is offering this right now. Try again later.')
      : `Free, on a shared GPU through the Velorn network. ${family.kind === 'image' && !(has(NETWORK_PICTURE.make) && has(NETWORK_PICTURE.edit)) ? (has(NETWORK_PICTURE.make) ? 'Makes a picture from a description. About two minutes.' : 'Edits a picture you add. About two minutes.')
        : family.kind === 'video' && !(has(NETWORK_WORKFLOW) && has(NETWORK_VIDEO_TEXT)) ? (has(NETWORK_VIDEO_TEXT) ? 'Makes a clip from your description.' : 'Starts from a picture.') : family.lead}${state === 'busy' ? ' Every shared computer is busy, so there is a wait.' : ''}`
    models.push({ id: family.id, kind: family.kind, network: true, state, name: networkLabel(family.workflows[0]), note, characters: { max: 2000 }, ...family.extra,
      // What the family can do right now: from the description alone, and from a picture.
      ...(family.kind === 'image' ? { makes: has(NETWORK_PICTURE.make), edits: has(NETWORK_PICTURE.edit) } : { makes: has(NETWORK_VIDEO_TEXT), edits: has(NETWORK_WORKFLOW) }),
      hosts: offering.map(host => ({ hostId: host.hostId, hostName: String(host.name || 'A Velorn computer').slice(0, 80), ownComputer: host.sameAccount === true, idle: host.idle !== false,
        waiting: Number.isInteger(host.waiting) ? host.waiting : 0, usable: canUse(host), ...(Number.isInteger(host.remainingToday) ? { left: host.remainingToday } : {}), workflows: family.workflows.filter(id => host.workflows.includes(id)) })) })
  }
  // Then each owner's own workflows: one line each, under the name they gave it, with who made it.
  // It lives on its maker's computer, so that computer's state is its state.
  for (const host of list) {
    for (const entry of (Array.isArray(host.own) ? host.own : []).slice(0, 12)) {
      if (!entry || typeof entry.id !== 'string' || !Object.hasOwn(OWN_SHAPES, entry.shape) || typeof entry.name !== 'string' || !entry.name.trim()) continue
      const shape = OWN_SHAPES[entry.shape], maker = String(host.maker || 'A Velorn creator').slice(0, 40)
      const state = !canUse(host) ? 'unavailable' : host.idle !== false ? 'ready' : 'busy'
      models.push({ id: `network-own:${host.hostId}:${entry.id}`, kind: shape.kind, network: true, own: true, ownId: entry.id, shape: entry.shape, needsImage: shape.needsImage, maker, state,
        name: entry.name.slice(0, 60), characters: { max: 2000 }, ...(shape.kind === 'video' ? { seconds: { offered: [5] }, resolutions: ['720p'] } : shape.kind === 'music' ? { lyrics: { max: 3000 } } : { sizes: ['1K'] }),
        note: state === 'unavailable' ? 'You\'ve used today\'s free jobs. Check again later.' : `By ${maker}. ${shape.note} Free, on their shared GPU.${state === 'busy' ? ' Busy right now, so there is a wait.' : ''}`,
        hosts: [{ hostId: host.hostId, hostName: String(host.name || 'A Velorn computer').slice(0, 80), ownComputer: host.sameAccount === true, idle: host.idle !== false,
          waiting: Number.isInteger(host.waiting) ? host.waiting : 0, usable: canUse(host), ...(Number.isInteger(host.remainingToday) ? { left: host.remainingToday } : {}), workflows: [entry.id] }] })
    }
  }
  return models
}
// The computers to try for one job, best first: the person's own, then a free
// one, then the shortest queue. The next is tried only when one turns the job away.
export function networkCandidates(model, workflowId) {
  return (Array.isArray(model?.hosts) ? model.hosts : []).filter(host => host.usable && host.workflows.includes(workflowId))
    .sort((a, b) => Number(b.ownComputer) - Number(a.ownComputer) || Number(b.idle) - Number(a.idle) || a.waiting - b.waiting || a.hostName.localeCompare(b.hostName))
}
// A refusal that only means "not this computer, not now": worth asking the next one.
export const tryNextComputer = code => ['GPU_NETWORK_HOST_BUSY', 'GPU_NETWORK_HOST_UNAVAILABLE', 'GPU_NETWORK_WORKFLOW_UNAVAILABLE', 'GPU_NETWORK_DAILY_LIMIT'].includes(code)
// The workflow ids in a list of computers, for remembering what this account has been offered.
export const offeredWorkflows = hosts => [...new Set((Array.isArray(hosts) ? hosts : []).flatMap(host => Array.isArray(host?.workflows) ? host.workflows : []))].filter(id => FAMILIES.some(family => family.workflows.includes(id))).sort()

// Follows the one job this account has on the network. `save` puts the clip in
// the open project; the job is cleared from the network only after that.
// State: { phase: 'idle' | 'sending' | 'running' | 'saving' | 'done' | 'failed', job?, text?, hostOnline?, assetId?, error?, cancelled? }
export function createVelornNetworkFollower({ getApi, save, hasProject = () => true, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), every = 3000 }) {
  let state = { phase: 'idle' }, loop = null, held = null // held: the collected clip, so a retried save does not fetch it again
  const listeners = new Set()
  const set = next => { state = next; for (const listener of [...listeners]) { try { listener(state) } catch { /* A listener's own trouble. */ } } }
  const live = () => ['sending', 'running', 'saving'].includes(state.phase)

  async function run() {
    const api = getApi()
    if (!api?.current) return
    for (;;) {
      let now
      try { now = await api.current() } catch { now = null }
      if (!now?.success) { if (!state.job) return; await sleep(every); continue }
      if (!now.job) {
        held = null
        if (state.job) set({ phase: 'failed', job: state.job, error: 'That job is no longer on the Velorn network. Nothing was saved.' })
        return
      }
      const job = now.job, status = now.state?.status
      if (status === 'failed' || status === 'cancelled') {
        held = null
        try { await api.forget() } catch { /* Cleared on the next look. */ }
        set({ phase: 'failed', job, cancelled: status === 'cancelled', error: now.state.error || 'The job did not finish.' })
        return
      }
      if (status !== 'done') set({ phase: 'running', job, text: stageText(now.state?.progress, job) || stageText(status, job) || 'Working on it.', hostOnline: now.state?.hostOnline !== false })
      else if (!hasProject()) set({ phase: 'running', job, text: `The ${nounOf(job)} is ready. Open a project within 15 minutes and it will be saved there.`, hostOnline: true })
      else {
        set({ phase: 'saving', job })
        let problem = ''
        try {
          if (held?.jobId !== job.jobId) {
            const clip = await api.collect()
            if (clip?.success) held = { jobId: job.jobId, filename: clip.filename, mimeType: clip.mimeType, bytes: clip.bytes }
            else problem = clip?.error || `The ${nounOf(job)} could not be collected.`
          }
          if (held?.jobId === job.jobId) {
            const saved = await save({ ...held, hostName: job.hostName, prompt: job.prompt })
            if (saved?.success) {
              held = null
              try { await api.forget() } catch { /* Forgotten by the network by itself after a while. */ }
              set({ phase: 'done', job, assetId: saved.assetId })
              return
            }
            problem = saved?.error || `The ${nounOf(job)} could not be saved.`
          }
        } catch { problem = `The ${nounOf(job)} could not be saved.` }
        set({ phase: 'running', job, text: `${problem} Trying again.`, hostOnline: true })
      }
      await sleep(every)
    }
  }
  function follow() {
    if (!loop) loop = run().catch(() => {}).finally(() => { loop = null })
    return loop
  }

  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    // Picks up a job left from before (Velorn was closed, or the project changed).
    resume() { return state.phase === 'idle' ? follow() : loop || Promise.resolve() },
    async send(request) {
      const api = getApi()
      if (!api?.send || live()) return { success: false, error: live() ? 'You already have a job on the Velorn network. Wait for it to finish.' : 'The Velorn network is not available here.' }
      set({ phase: 'sending' })
      let sent
      try { sent = await api.send(request) } catch { sent = null }
      if (!sent?.success || !sent.job) { set({ phase: 'idle' }); return { success: false, ...(sent?.code ? { code: sent.code } : {}), error: sent?.error || 'The job could not be sent.' } }
      set({ phase: 'running', job: sent.job, text: NETWORK_STAGE.waiting, hostOnline: true })
      void follow()
      return { success: true, job: sent.job }
    },
    async cancel() { try { await getApi()?.cancel?.() } catch { /* Shown on the next look. */ } },
    // The screen has shown how the job ended.
    clear() { if (state.phase === 'done' || state.phase === 'failed') set({ phase: 'idle' }) },
    idle: () => loop || Promise.resolve(),
  }
}
