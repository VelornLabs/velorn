import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { Blob, File } from 'node:buffer'

import * as musicModels from '../src/services/musicGenerationModels.mjs'

// Exercise the complete service body without loading renderer stores or starting
// real ComfyUI jobs. Only static module bindings are replaced with test doubles.
const serviceSource = fs.readFileSync(new URL('../src/services/musicGeneration.js', import.meta.url), 'utf8')
const executableSource = serviceSource
  .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*(?:\r?\n|$)/gm, '')
  .replace(/^export\s+\*\s+from\s+['"][^'"]+['"];?[ \t]*(?:\r?\n|$)/gm, '')
  .replace(/^export\s+(?=(?:async\s+)?(?:function|const)\s)/gm, '')
const exportedNames = [...serviceSource.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map(match => match[1])

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function until(predicate) {
  for (let step = 0; step < 30; step++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected service checkpoint was not reached')
}

function plain(value) { return JSON.parse(JSON.stringify(value)) }

function audioOutput(filename = 'take.flac', subfolder = 'audio') {
  return { filename, subfolder, type: 'output' }
}

function completedHistory(files = [audioOutput()]) {
  return { status: { completed: true, status_str: 'success' }, outputs: { 107: { audio: files } } }
}

function harness(options = {}) {
  const state = {
    project: options.project === undefined ? '/projects/first' : options.project,
    httpBase: 'http://127.0.0.1:8189',
    now: 1_000_000,
    histories: new Map(),
    projects: new Map(),
    timers: new Map(),
    graphs: [], dependencyCalls: [], requests: [], imports: [], guarded: [], events: [], createdUrls: [], revokedUrls: [],
  }
  function assetsFor(project = state.project) {
    if (!state.projects.has(project)) {
      const store = {
        assets: [], folders: [],
        addFolder(folder) {
          const saved = { ...folder, id: `folder-${store.folders.length + 1}` }
          store.folders.push(saved)
          return saved
        },
        addAsset(asset) {
          const saved = { ...asset, id: `asset-${store.assets.length + 1}` }
          store.assets.push(saved)
          return saved
        },
      }
      state.projects.set(project, store)
    }
    return state.projects.get(project)
  }
  const context = {
    ...musicModels,
    console, Blob, File, URLSearchParams,
    Math: Object.assign(Object.create(Math), { random: () => 0.125 }),
    Date: class extends Date { static now() { return state.now } },
    CustomEvent: class { constructor(type) { this.type = type } },
    window: { dispatchEvent: event => state.events.push(event.type) },
    URL: {
      createObjectURL: () => { const url = `blob:test-${state.createdUrls.length + 1}`; state.createdUrls.push(url); return url },
      revokeObjectURL: url => state.revokedUrls.push(url),
    },
    setInterval(callback, milliseconds) {
      const id = Symbol('timer')
      state.timers.set(id, { callback, milliseconds })
      return id
    },
    clearInterval: id => state.timers.delete(id),
    useProjectStore: { getState: () => ({ currentProjectHandle: state.project }) },
    useAssetsStore: { getState: () => assetsFor() },
    markPromptHandledByApp: id => state.guarded.push(id),
    async checkWorkflowDependencies(id) {
      state.dependencyCalls.push(id)
      if (options.dependencies) return options.dependencies(id, state)
      return { status: 'ready', hasBlockingIssues: false }
    },
    comfyui: {
      getHttpBase: () => state.httpBase,
      async queuePrompt(graph) {
        state.graphs.push(graph)
        if (options.queue) return options.queue(graph, state.graphs.length, state)
        return `prompt-${state.graphs.length}`
      },
    },
    async importAsset(project, file, type) {
      state.imports.push({ project, file, type })
      if (options.importAsset) return options.importAsset(project, file, type, state)
      return { filename: file.name, relativePath: `assets/audio/${file.name}`, duration: 18.24, mimeType: file.type }
    },
    async fetch(url) {
      state.requests.push(url)
      if (options.fetch) {
        const response = await options.fetch(url, state)
        if (response !== undefined) return response
      }
      const parsed = new URL(url)
      if (parsed.pathname.startsWith('/history/')) {
        const promptId = decodeURIComponent(parsed.pathname.slice('/history/'.length))
        const entry = state.histories.get(promptId)
        return { ok: true, json: async () => entry ? { [promptId]: entry } : {} }
      }
      if (parsed.pathname === '/view') {
        return { ok: true, blob: async () => new Blob(['fake-audio'], { type: 'audio/flac' }) }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    },
  }
  const service = vm.runInNewContext(`'use strict';\n${executableSource}\n;({${exportedNames.join(',')}})`, context, {
    filename: 'musicGeneration.js',
  })
  return { service, state, assetsFor }
}

test('music requires an open project before model checks or queue writes', async () => {
  const { service, state } = harness({ project: null })
  await assert.rejects(service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' }), /Create or open a project/)
  assert.equal(state.dependencyCalls.length, 0)
  assert.equal(state.graphs.length, 0)
  assert.equal(state.timers.size, 0)
})

test('invalid backend and empty style are rejected without queueing', async () => {
  const { service, state } = harness()
  await assert.rejects(service.queueMusicGeneration({ backend: 'typo', tags: 'piano' }), /Unknown music model/)
  await assert.rejects(service.queueMusicGeneration({ backend: 'yue2', tags: '  ' }), /Describe the music/)
  assert.equal(state.graphs.length, 0)
  assert.equal(state.dependencyCalls.length, 0)
})

test('backend-specific dependency failures prevent queueing', async () => {
  for (const [dependencies, expected] of [
    [() => null, /Could not check/],
    [() => ({ status: 'error' }), /Could not check/],
    [() => { throw new Error('offline') }, /Could not check/],
    [() => ({ status: 'ready', hasBlockingIssues: true }), /YuE2 is not ready/],
  ]) {
    const { service, state } = harness({ dependencies })
    await assert.rejects(service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' }), expected)
    assert.deepEqual(state.dependencyCalls, ['music-gen-yue2'])
    assert.equal(state.graphs.length, 0)
  }
})

test('a project change during dependency checks prevents stale queue submission', async () => {
  const { service, state } = harness({
    dependencies: (_, state) => {
      state.project = '/projects/other'
      return { status: 'ready', hasBlockingIssues: false }
    },
  })
  await assert.rejects(service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' }), /project changed/)
  assert.equal(state.graphs.length, 0)
})

test('legacy callers use ACE-Step and omitted/null seeds are randomized rather than zero', async () => {
  const { service, state } = harness()
  const [job] = await service.queueMusicGeneration({ tags: '  ambient  ', seed: null, variations: 2 })
  assert.equal(job.backend, 'ace-step')
  assert.equal(job.durationMode, 'exact')
  assert.equal(job.tags, 'ambient')
  assert.equal(job.seed, 536870912)
  assert.equal(state.graphs[0]['94'].class_type, 'TextEncodeAceStepAudio1.5')
  assert.equal(state.graphs[0]['3'].inputs.seed, 536870912)
  assert.equal(state.graphs[1]['3'].inputs.seed, 536870913)
  assert.deepEqual(state.dependencyCalls, ['music-gen'])
  assert.deepEqual(state.guarded, ['prompt-1', 'prompt-2'])
  assert.equal(state.timers.size, 1)
  assert.ok(state.events.every(event => event === 'velorn-music-jobs-updated'))
})

test('YuE2 jobs use native graph, maximum duration and no invented ACE-Step controls', async () => {
  const { service, state } = harness()
  const [job] = await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano', lyrics: 'discard me', instrumental: true, durationSeconds: 32, seed: 0, bpm: 88, keyScale: 'A minor', timeSignature: '3' })
  assert.equal(job.backend, 'yue2')
  assert.equal(job.backendLabel, 'YuE2')
  assert.equal(job.durationMode, 'maximum')
  assert.equal(job.seed, 0)
  assert.equal(job.lyrics, '')
  assert.equal(Object.hasOwn(job, 'bpm'), false)
  assert.equal(Object.hasOwn(job, 'keyScale'), false)
  assert.equal(Object.hasOwn(job, 'timeSignature'), false)
  assert.equal(state.graphs[0]['95'].inputs.max_duration, 32)
  assert.deepEqual(state.graphs[0]['98'].inputs.seconds, ['95', 1])
  assert.match(state.graphs[0]['95'].inputs.style, /no vocals/)
  assert.deepEqual(state.dependencyCalls, ['music-gen-yue2'])
})

test('variation count stays bounded and supplied zero seed remains reproducible', async () => {
  const { service, state } = harness()
  const jobs = await service.queueMusicGeneration({ tags: 'piano', variations: 100, seed: 0 })
  assert.equal(jobs.length, 4)
  assert.deepEqual(plain(jobs.map(job => job.seed)), [0, 1, 2, 3])
  assert.equal(state.graphs.length, 4)
})

test('Automatic and custom YuE2 jobs freeze distinct limits without altering ACE-Step', async () => {
  for (const [options, mode, limit] of [
    [{ backend: 'yue2' }, 'automatic', 360],
    [{ backend: 'yue2', lengthMode: 'automatic', durationSeconds: 12 }, 'automatic', 360],
    [{ backend: 'yue2', durationSeconds: 45 }, 'custom', 45],
    [{ backend: 'yue2', lengthMode: 'custom', durationSeconds: 300 }, 'custom', 300],
    [{ backend: 'ace-step', durationSeconds: 300 }, 'exact', 240],
  ]) {
    const { service, state } = harness()
    const jobs = await service.queueMusicGeneration({ tags: 'piano', variations: 2, ...options })
    for (const job of jobs) {
      assert.equal(job.lengthMode, mode)
      assert.equal(job.durationSeconds, limit)
    }
    for (const graph of state.graphs) {
      assert.equal(mode === 'exact' ? graph['94'].inputs.duration : graph['95'].inputs.max_duration, limit)
    }
    assert.equal(jobs[0].completionWarning, null)
  }
})

test('invalid length modes fail before dependencies or side effects', async () => {
  const { service, state } = harness()
  await assert.rejects(service.queueMusicGeneration({ backend: 'yue2', lengthMode: 'forever', tags: 'piano' }), /automatic or custom song length/i)
  await assert.rejects(service.queueMusicGeneration({ backend: 'ace-step', lengthMode: 'automatic', tags: 'piano' }), /YuE2 only/)
  assert.equal(state.dependencyCalls.length, 0)
  assert.equal(state.graphs.length, 0)
})

test('a take at its ceiling remains usable with measured duration and an honest warning', async () => {
  for (const [mode, limit, measured] of [['automatic', 360, 360.04], ['custom', 45, 45]]) {
    const { service, state, assetsFor } = harness({
      importAsset: async (_, file) => ({ filename: file.name, relativePath: `assets/audio/${file.name}`, duration: measured }),
    })
    await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano', lengthMode: mode, durationSeconds: limit })
    state.histories.set('prompt-1', completedHistory())
    await service.refreshMusicJobs()
    const job = service.getMusicJobs()[0]
    const asset = assetsFor().assets[0]
    assert.equal(job.status, 'completed')
    assert.equal(job.measuredDurationSeconds, measured)
    assert.equal(asset.duration, measured)
    assert.equal(job.completion.status, 'limit-reached')
    assert.equal(job.completion.naturalEndingVerified, false)
    assert.equal(job.completion.truncated, null)
    assert.equal(asset.generatedMusic.lengthMode, mode)
    assert.equal(asset.generatedMusic.completionWarning, job.completionWarning)
    assert.match(job.completionWarning, new RegExp(`${limit}-second limit`))
    assert.equal(state.graphs.length, 1, 'No automatic retry when a limit is reached')
    assert.equal(state.imports.length, 1, 'No second import or trimming pass')
  }
})

test('shorter Automatic output is imported without padding or a claimed natural ending', async () => {
  const { service, state, assetsFor } = harness()
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory())
  await service.refreshMusicJobs()
  const job = service.getMusicJobs()[0]
  assert.equal(job.durationSeconds, 360)
  assert.equal(job.measuredDurationSeconds, 18.24)
  assert.equal(job.completion.status, 'unknown')
  assert.equal(job.completionWarning, null)
  assert.equal(job.completion.naturalEndingVerified, false)
  assert.equal(assetsFor().assets[0].duration, 18.24)
})

test('partial queue failure returns accepted jobs and leaves them guarded and polling', async () => {
  const { service, state, assetsFor } = harness({
    queue: (_, index) => {
      if (index === 2) throw new Error('queue unavailable')
      return `prompt-${index}`
    },
  })
  await assert.rejects(service.queueMusicGeneration({ backend: 'yue2', tags: 'piano', variations: 3 }), error => {
    assert.match(error.message, /queue unavailable/)
    assert.equal(error.queuedJobs.length, 1)
    assert.equal(error.queuedJobs[0].promptId, 'prompt-1')
    return true
  })
  assert.equal(service.getMusicJobs().length, 1)
  assert.deepEqual(state.guarded, ['prompt-1'])
  assert.equal(state.timers.size, 1)
  state.histories.set('prompt-1', completedHistory())
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'completed')
  assert.equal(assetsFor().assets.length, 1)
})

test('changing the ComfyUI connection stops later variations without losing already queued work', async () => {
  const { service, state } = harness({
    queue: (_, index, state) => {
      state.httpBase = 'http://127.0.0.1:9999'
      return `prompt-${index}`
    },
  })
  await assert.rejects(service.queueMusicGeneration({ tags: 'piano', variations: 2 }), error => {
    assert.match(error.message, /connection changed/)
    assert.equal(error.queuedJobs.length, 1)
    return true
  })
  await service.refreshMusicJobs()
  assert.equal(state.graphs.length, 1)
  assert.equal(state.requests[0], 'http://127.0.0.1:8189/history/prompt-1')
})

test('only final saver audio is collected, deduplicated by filename and subfolder', () => {
  const { service } = harness()
  const history = {
    outputs: {
      94: { audio: [audioOutput('planning.wav')] },
      18: { audio: [audioOutput('intermediate.wav')] },
      107: {
        audio: [audioOutput(), audioOutput(), audioOutput('take.flac', 'alternate'), { ...audioOutput('temp.wav'), type: 'temp' }, { ...audioOutput('input.wav'), type: 'input' }, audioOutput('image.png'), {}],
        duplicate: [audioOutput()],
        text: 'not a file list',
      },
    },
  }
  assert.deepEqual(plain(service.collectMusicAudioOutputs(history, 'yue2')), [
    { nodeId: '107', ...audioOutput() },
    { nodeId: '107', ...audioOutput('take.flac', 'alternate') },
  ])
  assert.deepEqual(plain(service.collectMusicAudioOutputs({ outputs: { 94: history.outputs[94] } }, 'yue2')), [])
})

test('successful import uses measured duration and portable model provenance, not requested length', async () => {
  const { service, state, assetsFor } = harness()
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano', durationSeconds: 30, seed: 87 })
  state.histories.set('prompt-1', completedHistory())
  await service.refreshMusicJobs()
  const [job] = service.getMusicJobs()
  const [asset] = assetsFor().assets
  assert.equal(job.status, 'completed')
  assert.equal(job.durationSeconds, 30)
  assert.equal(job.measuredDurationSeconds, 18.24)
  assert.equal(asset.duration, 18.24)
  assert.equal(asset.relativePath, 'assets/audio/take.flac')
  assert.equal(asset.generatedMusic.backend, 'yue2')
  assert.equal(asset.generatedMusic.workflowId, 'music-gen-yue2')
  assert.equal(asset.generatedMusic.durationMode, 'maximum')
  assert.equal(asset.generatedMusic.durationSeconds, 30)
  assert.equal(asset.generatedMusic.measuredDurationSeconds, 18.24)
  assert.equal(asset.generatedMusic.seed, 87)
  assert.equal(asset.generatedMusic.version, 1)
  assert.deepEqual(plain(asset.generatedMusic.modelFiles), [musicModels.YUE2_MODEL])
  assert.equal(asset.sourceFilename, 'take.flac')
  assert.equal(asset.sourceSubfolder, 'audio')
  assert.equal(asset.sourceNodeId, '107')
  assert.equal(state.imports[0].project, '/projects/first')
  assert.equal(state.imports[0].type, 'audio')
  assert.equal(assetsFor().folders[0].name, 'Generated Music')
})

test('overlapping polls serialize history/download/import and remain idempotent on later refreshes', async () => {
  const wait = deferred()
  const { service, state, assetsFor } = harness({
    importAsset: async (_, file) => {
      await wait.promise
      return { duration: 10, relativePath: `assets/audio/${file.name}` }
    },
  })
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory([audioOutput(), audioOutput()]))
  const first = service.refreshMusicJobs()
  await until(() => state.imports.length === 1)
  const second = service.refreshMusicJobs()
  const third = service.refreshMusicJobs()
  assert.equal(state.imports.length, 1)
  wait.resolve()
  await Promise.all([first, second, third])
  await service.refreshMusicJobs()
  assert.equal(state.requests.length, 2)
  assert.equal(state.imports.length, 1)
  assert.equal(assetsFor().assets.length, 1)
  assert.equal(state.timers.size, 0)
})

test('outputs wait for the originating project and never import into another project', async () => {
  const { service, state, assetsFor } = harness()
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory())
  state.project = '/projects/second'
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'awaiting-project')
  assert.equal(service.getMusicJobs()[0].belongsToCurrentProject, false)
  assert.equal(state.imports.length, 0)
  assert.equal(assetsFor('/projects/second').assets.length, 0)
  state.project = '/projects/first'
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'completed')
  assert.equal(state.imports.length, 1)
  assert.equal(assetsFor('/projects/first').assets.length, 1)
  assert.equal(assetsFor('/projects/second').assets.length, 0)
})

test('a project switch while downloading defers the import until the original project is active', async () => {
  const download = deferred()
  const { service, state, assetsFor } = harness({
    fetch: async url => {
      if (new URL(url).pathname === '/view') await download.promise
    },
  })
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory())
  const poll = service.refreshMusicJobs()
  await until(() => state.requests.some(url => new URL(url).pathname === '/view'))
  state.project = '/projects/second'
  download.resolve()
  await poll
  assert.equal(state.imports.length, 0)
  assert.equal(service.getMusicJobs()[0].status, 'awaiting-project')
  state.project = '/projects/first'
  await service.refreshMusicJobs()
  assert.equal(state.imports.length, 1)
  assert.equal(assetsFor('/projects/second').assets.length, 0)
  assert.equal(service.getMusicJobs()[0].status, 'completed')
})

test('a project switch during disk import retains the saved copy without adding it to the wrong project', async () => {
  const saved = deferred()
  const { service, state, assetsFor } = harness({
    importAsset: () => saved.promise,
  })
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory())
  const poll = service.refreshMusicJobs()
  await until(() => state.imports.length === 1)
  state.project = '/projects/second'
  saved.resolve({ duration: 14, relativePath: 'assets/audio/take.flac' })
  await poll
  assert.equal(service.getMusicJobs()[0].status, 'awaiting-project')
  assert.equal(assetsFor('/projects/second').assets.length, 0)
  assert.equal(assetsFor('/projects/first').assets.length, 0)
  state.project = '/projects/first'
  await service.refreshMusicJobs()
  assert.equal(state.imports.length, 1)
  assert.equal(state.requests.filter(url => new URL(url).pathname === '/view').length, 1)
  assert.equal(assetsFor('/projects/first').assets.length, 1)
  assert.equal(service.getMusicJobs()[0].status, 'completed')
})

test('an already imported output is reused without duplicate media files or assets', async () => {
  const { service, state, assetsFor } = harness()
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  assetsFor().assets.push({ id: 'existing', duration: 12, promptId: 'prompt-1', sourceFilename: 'take.flac', sourceSubfolder: 'audio' })
  state.histories.set('prompt-1', completedHistory())
  await service.refreshMusicJobs()
  assert.equal(state.imports.length, 0)
  assert.equal(assetsFor().assets.length, 1)
  assert.deepEqual(plain(service.getMusicJobs()[0].assetIds), ['existing'])
})

test('audio download failure is visible and never creates a ghost completed asset', async () => {
  const { service, state, assetsFor } = harness({
    fetch: url => new URL(url).pathname === '/view' ? { ok: false, status: 503 } : undefined,
  })
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory())
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'failed')
  assert.match(service.getMusicJobs()[0].error, /download generated audio \(503\)/)
  assert.equal(state.imports.length, 0)
  assert.equal(assetsFor().assets.length, 0)
})

test('disk import failure is visible and never falls back to an unsaved blob asset', async () => {
  const { service, state, assetsFor } = harness({ importAsset: () => { throw new Error('Disk full') } })
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  state.histories.set('prompt-1', completedHistory())
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'failed')
  assert.match(service.getMusicJobs()[0].error, /Disk full/)
  assert.equal(assetsFor().assets.length, 0)
  assert.equal(state.createdUrls.length, 0)
})

test('missing or invalid measured duration never substitutes the requested duration', async () => {
  for (const duration of [undefined, 0, -1, NaN]) {
    const { service, state, assetsFor } = harness({ importAsset: () => ({ duration, relativePath: 'assets/audio/take.flac' }) })
    await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano', durationSeconds: 30 })
    state.histories.set('prompt-1', completedHistory())
    await service.refreshMusicJobs()
    assert.equal(service.getMusicJobs()[0].status, 'failed')
    assert.match(service.getMusicJobs()[0].error, /duration could not be read/)
    assert.equal(assetsFor().assets.length, 0)
    assert.equal(service.getMusicJobs()[0].measuredDurationSeconds, null)
  }
})

test('transient history errors recover, while a completed graph without final audio fails clearly', async () => {
  let historyAttempts = 0
  const { service, state } = harness({
    fetch: url => {
      if (new URL(url).pathname.startsWith('/history/') && historyAttempts++ === 0) return { ok: false, status: 502 }
    },
  })
  await service.queueMusicGeneration({ backend: 'yue2', tags: 'piano' })
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'queued')
  assert.match(service.getMusicJobs()[0].error, /history \(502\)/)
  state.histories.set('prompt-1', { status: { completed: true }, outputs: { 94: { audio: [audioOutput('preview.wav')] } } })
  await service.refreshMusicJobs()
  assert.equal(service.getMusicJobs()[0].status, 'failed')
  assert.match(service.getMusicJobs()[0].error, /without a final audio file/)
})

test('execution errors and timeout surface their causes without importing anything', async () => {
  const { service, state, assetsFor } = harness()
  await service.queueMusicGeneration({ tags: 'piano', variations: 2 })
  state.histories.set('prompt-1', { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'out of memory' }]] } })
  await service.refreshMusicJobs()
  assert.match(service.getMusicJobs(['prompt-1'])[0].error, /out of memory/)
  assert.equal(service.getMusicJobs(['prompt-1'])[0].status, 'failed')
  state.now += 60 * 60 * 1000 + 1
  await service.refreshMusicJobs()
  assert.match(service.getMusicJobs(['prompt-2'])[0].error, /timed out/)
  assert.equal(service.getMusicJobs(['prompt-2'])[0].status, 'failed')
  assert.equal(assetsFor().assets.length, 0)
  assert.equal(state.imports.length, 0)
})
