const { contextBridge, ipcRenderer } = require('electron')

// Only a live renderer gesture may request these write-only UI operations.
// A boolean supplied by page/agent code is not accepted as gesture evidence.
function copyTextGesture(channel, text) {
  if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Copy requires a user gesture.'))
  return ipcRenderer.invoke(channel, text)
}

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform info
  platform: process.platform,
  isElectron: true,
  engineCandidateInfo: ipcRenderer.sendSync?.('engine-candidate:info') || null,
  writeClipboardText: text => copyTextGesture('text-clipboard:write', text),
  showTextCopyMenu: text => copyTextGesture('text-clipboard:menu', text),
  comfyRouter: {
    status: payload => ipcRenderer.invoke('comfy-router:status', payload),
    list: payload => ipcRenderer.invoke('comfy-router:list', payload),
    connect: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Connect requires a user gesture.'))
      return ipcRenderer.invoke('comfy-router:connect', payload)
    },
    clear: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Forget key requires a user gesture.'))
      return ipcRenderer.invoke('comfy-router:clear', payload)
    },
    openGuide: () => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Open guide requires a user gesture.'))
      return ipcRenderer.invoke('comfy-router:openGuide', {})
    },
    preview: payload => ipcRenderer.invoke('comfy-router:preview', payload),
    models: payload => ipcRenderer.invoke('comfy-router:models', payload),
    balance: payload => ipcRenderer.invoke('comfy-router:balance', payload),
    previewCreate: payload => ipcRenderer.invoke('comfy-router:previewCreate', payload),
    // Many different pictures under one price and one approval (the Director's keyframes).
    previewCreateBatch: payload => ipcRenderer.invoke('comfy-router:previewCreateBatch', payload),
    // A priced Create request can be approved by the click itself, so it is
    // forwarded only while that click's user activation is still live.
    submitCreate: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Generate requires a user gesture.'))
      return ipcRenderer.invoke('comfy-router:submitCreate', payload)
    },
    submit: payload => ipcRenderer.invoke('comfy-router:submit', payload),
    refresh: payload => ipcRenderer.invoke('comfy-router:refresh', payload),
    cancel: payload => ipcRenderer.invoke('comfy-router:cancel', payload),
    output: payload => ipcRenderer.invoke('comfy-router:output', payload),
    markImported: payload => ipcRenderer.invoke('comfy-router:markImported', payload),
    onChanged: callback => {
      const handler = () => callback()
      ipcRenderer.on('comfy-router:changed', handler)
      return () => ipcRenderer.removeListener('comfy-router:changed', handler)
    },
  },
  generationRuns: {
    list: payload => ipcRenderer.invoke('generation-runs:list', payload),
    submit: payload => ipcRenderer.invoke('generation-runs:submit', payload),
    adopt: payload => ipcRenderer.invoke('generation-runs:adopt', payload),
    recipe: payload => ipcRenderer.invoke('generation-runs:recipe', payload),
    control: payload => ipcRenderer.invoke('generation-runs:control', payload),
    observe: payload => ipcRenderer.invoke('generation-runs:observe', payload),
    onChanged: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('generation-runs:changed', handler)
      return () => ipcRenderer.removeListener('generation-runs:changed', handler)
    },
  },
  // The Sound tab's built-in local voice model. `read` returns checked bytes of one known model file.
  localVoice: {
    status: () => ipcRenderer.invoke('local-voice:status'),
    install: () => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Downloading requires a user gesture.'))
      return ipcRenderer.invoke('local-voice:install')
    },
    read: payload => ipcRenderer.invoke('local-voice:read', payload),
    onProgress: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('local-voice:progress', handler)
      return () => ipcRenderer.removeListener('local-voice:progress', handler)
    },
  },
  generationSpending: {
    revokeLocalTrust: payload => ipcRenderer.invoke('generation-spending:revoke-local-trust', payload),
    getStatus: () => ipcRenderer.invoke('generation-spending:status'),
    setPolicy: policy => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Changing generation spending requires a user gesture.'))
      return ipcRenderer.invoke('generation-spending:set-policy', { policy })
    },
    queue: payload => ipcRenderer.invoke('generation-spending:queue', payload),
    // A priced Sound request can be approved by the click itself, so it takes that
    // route only while the click's user activation is live; otherwise it is asked about.
    queuePriced: payload => ipcRenderer.invoke(globalThis.navigator?.userActivation?.isActive
      ? 'generation-spending:queue-priced' : 'generation-spending:queue', payload),
    cancel: requestId => ipcRenderer.invoke('generation-spending:cancel', { requestId }),
    // True while Velorn is asking whether a paid or unfamiliar job may run.
    onAsking: callback => {
      const handler = (_event, value) => callback(value === true)
      ipcRenderer.on('generation-spending:asking', handler)
      return () => ipcRenderer.removeListener('generation-spending:asking', handler)
    },
    onChanged: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('generation-spending:changed', handler)
      return () => ipcRenderer.removeListener('generation-spending:changed', handler)
    },
  },
  // Velorn network: this computer's own GPU sharing choices. Reading is free;
  // a change is forwarded only during a real click or key press.
  gpuShare: {
    status: () => ipcRenderer.invoke('gpu-share:status'),
    update: patch => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Sharing changes require a user gesture.'))
      return ipcRenderer.invoke('gpu-share:update', patch)
    },
    report: jobId => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Reporting requires a user gesture.'))
      return ipcRenderer.invoke('gpu-share:report', { jobId })
    },
    openJob: jobId => ipcRenderer.invoke('gpu-share:open-job', { jobId }),
    // For the accounts the service lists as reviewers: what waits to be looked at. Deciding and stopping an account need a real click.
    review: {
      list: () => ipcRenderer.invoke('gpu-review:list'),
      example: payload => ipcRenderer.invoke('gpu-review:example', payload),
      graph: payload => ipcRenderer.invoke('gpu-review:graph', payload),
      try: payload => globalThis.navigator?.userActivation?.isActive ? ipcRenderer.invoke('gpu-review:try', payload) : Promise.reject(new Error('This needs a click.')),
      decide: payload => globalThis.navigator?.userActivation?.isActive ? ipcRenderer.invoke('gpu-review:decide', payload) : Promise.reject(new Error('This needs a click.')),
      ban: payload => globalThis.navigator?.userActivation?.isActive ? ipcRenderer.invoke('gpu-review:ban', payload) : Promise.reject(new Error('This needs a click.')),
      dismiss: payload => globalThis.navigator?.userActivation?.isActive ? ipcRenderer.invoke('gpu-review:dismiss', payload) : Promise.reject(new Error('This needs a click.')),
      // What the reporting owner's computer sent along with a report. Shown only after a click.
      evidence: payload => globalThis.navigator?.userActivation?.isActive ? ipcRenderer.invoke('gpu-review:evidence', payload) : Promise.reject(new Error('This needs a click.')),
    },
    // The owner's own workflows: looking is free; adding, removing and testing need a real click.
    own: (() => {
      const clicked = (channel, payload) => globalThis.navigator?.userActivation?.isActive ? ipcRenderer.invoke(channel, payload) : Promise.reject(new Error('This needs a click.'))
      return {
        list: () => ipcRenderer.invoke('gpu-share-own:list'),
        candidates: () => ipcRenderer.invoke('gpu-share-own:candidates'),
        inspect: payload => ipcRenderer.invoke('gpu-share-own:inspect', payload),
        example: payload => ipcRenderer.invoke('gpu-share-own:example', payload),
        add: payload => clicked('gpu-share-own:add', payload),
        remove: payload => clicked('gpu-share-own:remove', payload),
        rename: payload => clicked('gpu-share-own:rename', payload),
        test: payload => clicked('gpu-share-own:test', payload),
        share: payload => clicked('gpu-share-own:share', payload),
        offer: payload => clicked('gpu-share-own:offer', payload),
      }
    })(),
    onChanged: callback => {
      const handler = () => callback()
      ipcRenderer.on('gpu-share:changed', handler)
      return () => ipcRenderer.removeListener('gpu-share:changed', handler)
    },
  },
  // Velorn network: run one of Velorn's own workflows on a computer that shares
  // its GPU with this account. Sending and cancelling need a real click.
  // What the paired phone had this computer make with one of its own workflows: the window saves it into the open project.
  phoneLocal: {
    pending: () => ipcRenderer.invoke('phone-local:pending'),
    take: jobId => ipcRenderer.invoke('phone-local:take', { jobId }),
    saved: jobId => ipcRenderer.invoke('phone-local:saved', { jobId }),
    onChanged: callback => { const listener = () => { try { callback() } catch { /* The window's own trouble. */ } }; ipcRenderer.on('phone-local:changed', listener); return () => ipcRenderer.removeListener('phone-local:changed', listener) },
  },
  gpuNetwork: {
    hosts: () => ipcRenderer.invoke('gpu-network:hosts'),
    // A job arrived that this window did not send (the paired phone asked for it): follow it.
    onChanged: callback => { const listener = () => { try { callback() } catch { /* The window's own trouble. */ } }; ipcRenderer.on('gpu-network:changed', listener); return () => ipcRenderer.removeListener('gpu-network:changed', listener) },
    current: () => ipcRenderer.invoke('gpu-network:current'),
    collect: () => ipcRenderer.invoke('gpu-network:collect'),
    forget: () => ipcRenderer.invoke('gpu-network:forget'),
    send: job => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Sending a job requires a user gesture.'))
      return ipcRenderer.invoke('gpu-network:send', job)
    },
    cancel: () => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Cancelling requires a user gesture.'))
      return ipcRenderer.invoke('gpu-network:cancel')
    },
    reportWorkflow: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Reporting requires a user gesture.'))
      return ipcRenderer.invoke('gpu-network:report-workflow', payload)
    },
  },
  mobileCompanion: {
    aiSharingVersion: 1,
    desktopAccountControlsVersion: 1,
    desktopAccountVersion: 1,
    desktopAccount: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Account changes require a user gesture.'))
      return ipcRenderer.invoke('mobile-companion:desktop-account', payload)
    },
    manageDesktopAccount: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Account changes require a user gesture.'))
      return ipcRenderer.invoke('mobile-companion:guided-unregister', payload)
    },
    connectPhoneAccount: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Phone setup requires a user gesture.'))
      return ipcRenderer.invoke('mobile-companion:guided-setup', payload)
    },
    disconnectPhoneDevice: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Disconnect requires a user gesture.'))
      return ipcRenderer.invoke('mobile-companion:guided-disconnect', payload)
    },
    disconnectPhoneAccount: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Disconnect requires a user gesture.'))
      return ipcRenderer.invoke('mobile-companion:guided-unregister', payload)
    },
    checkAccountRequests: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Checking Velorn account requests requires a user gesture.'))
      return ipcRenderer.invoke('mobile-companion:account-requests', payload)
    },
    getPreference: () => ipcRenderer.invoke('mobile-companion:preference'),
    decideNative: payload => ipcRenderer.invoke('mobile-companion:decide-native', payload),
    attach: payload => ipcRenderer.invoke('mobile-companion:attach', payload),
    detach: payload => ipcRenderer.invoke('mobile-companion:detach', payload),
    forget: payload => ipcRenderer.invoke('mobile-companion:forget', payload),
    enable: payload => ipcRenderer.invoke('mobile-companion:enable', payload),
    disable: payload => ipcRenderer.invoke('mobile-companion:disable', payload),
    publish: payload => ipcRenderer.invoke('mobile-companion:publish', payload),
    reply: payload => ipcRenderer.invoke('mobile-companion:reply', payload),
    onEvent: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('mobile-companion:event', handler)
      return () => ipcRenderer.removeListener('mobile-companion:event', handler)
    },
  },
  agentReviewMedia: {
    listPlayable: payload => ipcRenderer.invoke('agent-review-media:list-playable', payload),
    attachPlayable: payload => ipcRenderer.invoke('agent-review-media:attach-playable', payload),
    saveFrame: payload => ipcRenderer.invoke('agent-review-media:save-frame', payload),
    listFrames: payload => ipcRenderer.invoke('agent-review-media:list-frames', payload),
    onChanged: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('agent-review-media:changed', handler)
      return () => ipcRenderer.removeListener('agent-review-media:changed', handler)
    },
  },
  optionalSetup: {
    inspect: payload => ipcRenderer.invoke('optional-setup:inspect', payload),
  },
  lmStudioApp: {
    performAction: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Choose an LM Studio app action yourself to continue.'))
      return ipcRenderer.invoke('lm-studio-app:perform-action', payload)
    },
  },
  codexSetupInstaller: {
    plan: payload => ipcRenderer.invoke('codex-setup-installer:plan', payload),
    install: payload => ipcRenderer.invoke('codex-setup-installer:install', payload),
    status: payload => ipcRenderer.invoke('codex-setup-installer:status', payload),
    cancel: payload => ipcRenderer.invoke('codex-setup-installer:cancel', payload),
  },
  setupHelper: {
    status: payload => ipcRenderer.invoke('setup-helper:status', payload),
    send: payload => ipcRenderer.invoke('setup-helper:send', payload),
    cancel: payload => ipcRenderer.invoke('setup-helper:cancel', payload),
    reset: payload => ipcRenderer.invoke('setup-helper:reset', payload),
    performAction: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Choose a setup action yourself to continue.'))
      return ipcRenderer.invoke('setup-helper:performAction', payload)
    },
  },
  comfyCloudSetup: {
    current: () => ipcRenderer.invoke('comfy-cloud-setup:current'),
    // User-entered credential ingress only. Never part of an agent tool schema.
    save: payload => ipcRenderer.invoke('comfy-cloud-setup:save', payload),
    complete: payload => ipcRenderer.invoke('comfy-cloud-setup:complete', payload),
    onRequested: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('comfy-cloud-setup:requested', handler)
      return () => ipcRenderer.removeListener('comfy-cloud-setup:requested', handler)
    },
    onChanged: callback => {
      const handler = () => callback()
      ipcRenderer.on('comfy-cloud-setup:changed', handler)
      return () => ipcRenderer.removeListener('comfy-cloud-setup:changed', handler)
    },
  },
  comfyHostedSetup: {
    status: () => ipcRenderer.invoke('comfy-hosted-setup:status'),
    cancel: () => ipcRenderer.invoke('comfy-hosted-setup:cancel'),
    check: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Choose Check account access yourself to continue.'))
      return ipcRenderer.invoke('comfy-hosted-setup:check', payload)
    },
    clear: () => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Forgetting the hosted key requires a user gesture.'))
      return ipcRenderer.invoke('comfy-hosted-setup:clear')
    },
    openGuide: payload => {
      if (!globalThis.navigator?.userActivation?.isActive) return Promise.reject(new Error('Choose a Comfy guide yourself to continue.'))
      return ipcRenderer.invoke('comfy-hosted-setup:open-guide', payload)
    },
  },
  lmStudioSetup: {
    plan: payload => ipcRenderer.invoke('lm-studio-setup:plan', payload),
    download: payload => ipcRenderer.invoke('lm-studio-setup:download', payload),
    status: payload => ipcRenderer.invoke('lm-studio-setup:status', payload),
    cancel: payload => ipcRenderer.invoke('lm-studio-setup:cancel', payload),
    load: payload => ipcRenderer.invoke('lm-studio-setup:load', payload),
    agentDownloads: payload => ipcRenderer.invoke('lm-studio-setup:agent-downloads', payload),
    onChanged: callback => {
      const handler = () => callback()
      ipcRenderer.on('lm-studio-setup:changed', handler)
      return () => ipcRenderer.removeListener('lm-studio-setup:changed', handler)
    },
  },
  toolSetup: {
    plan: payload => ipcRenderer.invoke('tool-setup:plan', payload),
    download: payload => ipcRenderer.invoke('tool-setup:download', payload),
    status: payload => ipcRenderer.invoke('tool-setup:status', payload),
    cancel: payload => ipcRenderer.invoke('tool-setup:cancel', payload),
    open: payload => ipcRenderer.invoke('tool-setup:open', payload),
    agentDownloads: payload => ipcRenderer.invoke('tool-setup:agent-downloads', payload),
    onChanged: callback => {
      const handler = () => callback()
      ipcRenderer.on('tool-setup:changed', handler)
      return () => ipcRenderer.removeListener('tool-setup:changed', handler)
    },
  },
  connectedAgent: {
    aiSharingVersion: 1,
    reasoningControlVersion: 1,
    inspect: payload => ipcRenderer.invoke('connected-agent:inspect', payload),
    veeAvailability: () => ipcRenderer.invoke('connected-agent:vee-availability'),
    codexExecutable: payload => ipcRenderer.invoke('connected-agent:codex-executable', payload),
    codexLogin: payload => ipcRenderer.invoke('connected-agent:codex-login', payload),
    send: payload => ipcRenderer.invoke('connected-agent:send', payload),
    cancel: payload => ipcRenderer.invoke('connected-agent:cancel', payload),
    approveTool: payload => ipcRenderer.invoke('connected-agent:approve-tool', payload),
    setFullAccess: payload => ipcRenderer.invoke('connected-agent:set-full-access', payload),
    getFullAccessPreference: (payload) => ipcRenderer.invoke('connected-agent:get-full-access-preference', payload),
    capture: payload => ipcRenderer.invoke('connected-agent:capture', payload),
    onEvent: callback => {
      const handler = (_event, value) => callback(value)
      ipcRenderer.on('connected-agent:event', handler)
      return () => ipcRenderer.removeListener('connected-agent:event', handler)
    },
  },
  getSystemFonts: (forceRefresh = false) => ipcRenderer.invoke('fonts:listSystem', forceRefresh === true),
  
  // ============================================
  // Dialog Operations
  // ============================================
  
  /**
   * Open a directory picker dialog
   * @param {Object} options - { title, defaultPath }
   * @returns {Promise<string|null>} Selected directory path or null if cancelled
   */
  selectDirectory: (options) => ipcRenderer.invoke('dialog:selectDirectory', options),
  
  /**
   * Open a file picker dialog
   * @param {Object} options - { title, defaultPath, filters, multiple }
   * @returns {Promise<string|string[]|null>} Selected file path(s) or null if cancelled
   */
  selectFile: (options) => ipcRenderer.invoke('dialog:selectFile', options),
  
  /**
   * Open a save file dialog
   * @param {Object} options - { title, defaultPath, filters }
   * @returns {Promise<string|null>} Save path or null if cancelled
   */
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  
  // ============================================
  // File System Operations
  // ============================================
  
  /**
   * Check if a file or directory exists
   * @param {string} filePath 
   * @returns {Promise<boolean>}
   */
  exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  
  /**
   * Check if path is a directory
   * @param {string} filePath 
   * @returns {Promise<boolean>}
   */
  isDirectory: (filePath) => ipcRenderer.invoke('fs:isDirectory', filePath),
  
  /**
   * Create a directory (recursive by default)
   * @param {string} dirPath 
   * @param {Object} options - { recursive }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  createDirectory: (dirPath, options) => ipcRenderer.invoke('fs:createDirectory', dirPath, options),
  
  /**
   * Read a file
   * @param {string} filePath 
   * @param {Object} options - { encoding } - null for binary (returns base64)
   * @returns {Promise<{success: boolean, data?: string, encoding?: string, error?: string}>}
   */
  readFile: (filePath, options) => ipcRenderer.invoke('fs:readFile', filePath, options),
  
  /**
   * Read a file as ArrayBuffer
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, data?: ArrayBuffer, error?: string}>}
   */
  readFileAsBuffer: (filePath) => ipcRenderer.invoke('fs:readFileAsBuffer', filePath),
  
  /**
   * Write a file
   * @param {string} filePath 
   * @param {string|Object} data - String, JSON object, or base64 string
   * @param {Object} options - { encoding } - 'base64' for binary data
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  writeFile: (filePath, data, options) => ipcRenderer.invoke('fs:writeFile', filePath, data, options),
  
  /**
   * Write a file from ArrayBuffer (for binary files like videos, images)
   * @param {string} filePath 
   * @param {ArrayBuffer} arrayBuffer 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  writeFileFromArrayBuffer: (filePath, arrayBuffer) => ipcRenderer.invoke('fs:writeFileFromArrayBuffer', filePath, arrayBuffer),

  // ============================================
  // Export Operations
  // ============================================

  /**
   * Encode a frame sequence into a video file
   * @param {Object} options - { framePattern, fps, outputPath, audioPath, format }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  encodeVideo: (options) => ipcRenderer.invoke('export:encodeVideo', options),
  // High-quality animated GIF delivery uses a cancellable two-pass palette
  // encode after the renderer writes its lossless temporary PNG frames.
  encodeGif: (options) => ipcRenderer.invoke('export:gifEncode', options),
  abortGifEncode: (sessionId) => ipcRenderer.invoke('export:abortGifEncode', sessionId),
  generateOpticalFlowCache: (options) => ipcRenderer.invoke('opticalFlow:generate', options),
  cancelOpticalFlowCache: (jobId) => ipcRenderer.invoke('opticalFlow:cancel', jobId),
  onOpticalFlowProgress: (callback) => {
    const handler = (_event, progress) => callback(progress)
    ipcRenderer.on('opticalFlow:progress', handler)
    return () => ipcRenderer.removeListener('opticalFlow:progress', handler)
  },
  startFramePipe: (options) => ipcRenderer.invoke('export:startFramePipe', options),
  writeFrameToPipe: (sessionId, frameBuffer) => ipcRenderer.invoke('export:writeFrameToPipe', sessionId, frameBuffer),
  // True when this preload forwards a frame-pipe message port (see the
  // 'velorn:export-frame-pipe-port' listener at the end of this file).
  framePipePortSupported: true,
  finishFramePipe: (sessionId) => ipcRenderer.invoke('export:finishFramePipe', sessionId),
  abortFramePipe: (sessionId) => ipcRenderer.invoke('export:abortFramePipe', sessionId),
  muxAudioVideo: (options) => ipcRenderer.invoke('export:muxAudioVideo', options),

  /**
   * Mix timeline audio clips into a WAV file using FFmpeg
   * @param {Object} options - { projectPath, outputPath, rangeStart, rangeEnd, sampleRate, channels, clips, tracks, assets, timeoutMs }
   * @returns {Promise<{success: boolean, error?: string, clipCount?: number}>}
   */
  mixAudio: (options) => ipcRenderer.invoke('export:mixAudio', options),

  /**
   * Encode a mixed WAV into a delivery audio format (audio-only export)
   * @param {Object} options - { inputPath, outputPath, audioCodec, audioBitrateKbps, audioSampleRate, audioChannels, normalizeAudio, loudnessTarget }
   */
  encodeAudioFile: (options) => ipcRenderer.invoke('export:encodeAudioFile', options),

  // Export worker (run export in separate window so main UI stays responsive)
  runExportInWorker: (payload) => ipcRenderer.invoke('export:runInWorker', payload),
  getExportJobs: () => ipcRenderer.invoke('export:getJobs'),
  getExportActivity: () => ipcRenderer.invoke('export:getActivity'),
  onExportActivity: (cb) => {
    const handler = (_, activity) => cb(activity)
    ipcRenderer.on('export:activity', handler)
    return () => ipcRenderer.removeListener('export:activity', handler)
  },
  cancelExportJob: (jobId) => ipcRenderer.invoke('export:cancelJob', { jobId }),
  inspectExportFileNative: (args) => ipcRenderer.invoke('export:inspectFile', args),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportCancel: (cb) => {
    ipcRenderer.on('export:cancel-job', () => cb())
  },
  onExportProgress: (cb) => {
    const handler = (_, data, metadata) => cb(data, metadata)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },
  onExportComplete: (cb) => {
    const handler = (_, data, metadata) => cb(data, metadata)
    ipcRenderer.on('export:complete', handler)
    return () => ipcRenderer.removeListener('export:complete', handler)
  },
  onExportError: (cb) => {
    const handler = (_, err, metadata) => cb(err, metadata)
    ipcRenderer.on('export:error', handler)
    return () => ipcRenderer.removeListener('export:error', handler)
  },
  onExportJob: (cb) => {
    ipcRenderer.once('export:job', (_, job) => cb(job))
  },
  sendExportWorkerReady: () => ipcRenderer.send('export:workerReady'),
  sendExportProgress: (data) => ipcRenderer.send('export:progress', data),
  sendExportComplete: (data) => ipcRenderer.send('export:complete', data),
  sendExportError: (err) => ipcRenderer.send('export:error', err),

  /**
   * Check if FFmpeg supports NVIDIA NVENC encoders
   * @returns {Promise<{available: boolean, h264: boolean, h265: boolean, gpuName?: string | null, error?: string}>}
   */
  checkNvenc: (options) => ipcRenderer.invoke('export:checkNvenc', options),
  getHardwareExportFfmpegStatus: () => ipcRenderer.invoke('export:getHardwareFfmpegStatus'),
  setHardwareExportFfmpegPath: (filePath) => ipcRenderer.invoke('export:setHardwareFfmpegPath', filePath),
  resetHardwareExportFfmpegPath: () => ipcRenderer.invoke('export:resetHardwareFfmpegPath'),
  onHardwareExportFfmpegChanged: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('export:hardwareFfmpegChanged', handler)
    return () => ipcRenderer.removeListener('export:hardwareFfmpegChanged', handler)
  },

  // Direct NVIDIA RTX Video Super Resolution. The optional runtime is
  // managed by Velorn and does not require a running ComfyUI server.
  checkRtxVideoUpscaleRuntime: () => ipcRenderer.invoke('rtx:checkRuntime'),
  installRtxVideoUpscaleRuntime: () => ipcRenderer.invoke('rtx:installRuntime'),
  runRtxVideoUpscale: (options) => ipcRenderer.invoke('rtx:run', options),
  cancelRtxVideoUpscale: (jobId) => ipcRenderer.invoke('rtx:cancel', jobId),
  onRtxVideoUpscaleProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('rtx:progress', handler)
    return () => ipcRenderer.removeListener('rtx:progress', handler)
  },
  onRtxVideoUpscaleSetupProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('rtx:setupProgress', handler)
    return () => ipcRenderer.removeListener('rtx:setupProgress', handler)
  },

  /**
   * Make a local source safe for the renderer's decoders. mode 'remux'
   * (default): already-fast-start files are reused, other containers are
   * stream-copied to a temporary video-only MP4 without re-encoding. mode
   * 'transcode': sources whose codec the renderer cannot decode (ProRes,
   * DNx, ...) are re-encoded to a visually-transparent H.264 intermediate.
   * @param {{ inputPath: string, outputPath: string, mode?: 'remux' | 'transcode' }}
   * @returns {Promise<{ success: boolean, prepared?: boolean, outputPath?: string, error?: string }>}
   */
  prepareVideoSourceForExport: (options) => ipcRenderer.invoke('export:prepareVideoSource', options),

  /**
   * Read one bounded byte range of a local file (export frame source
   * windowed reads — the renderer's file:// fetch ignores Range headers).
   * @param {{ path: string, start: number, length: number }}
   * @returns {Promise<{ success: boolean, bytes?: ArrayBuffer, fileSize?: number, eof?: boolean, error?: string }>}
   */
  readFileRange: (options) => ipcRenderer.invoke('media:readFileRange', options),

  /**
   * Transcode video for playback cache (same resolution, constant-FPS H.264, keyframe every 6, no B-frames)
   * @param {{ inputPath: string, outputPath: string }}
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  transcodeForPlayback: (options) => ipcRenderer.invoke('playback:transcode', options),

  // Read-only progress for this window's shared playback/proxy queue.
  getMediaPreparationStatus: () => ipcRenderer.invoke('mediaPreparation:getStatus'),
  onMediaPreparationStatus: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('mediaPreparation:status', handler)
    return () => ipcRenderer.removeListener('mediaPreparation:status', handler)
  },

  /**
   * Inspect GIF structure without decoding it. Used to deterministically keep
   * single-frame GIFs as images and normalize multi-frame GIFs as video.
   * @param {{ inputPath: string }} options
   * @returns {Promise<{ success: boolean, animated?: boolean, frameCount?: number,
   *   width?: number, height?: number, duration?: number, fps?: number,
   *   hasTransparency?: boolean, loopCount?: number|null, error?: string }>}
   */
  probeGif: (options) => ipcRenderer.invoke('gif:probe', options),

  /**
   * Convert a probed animated GIF into a project-importable MP4 or alpha WebM.
   * @param {{ inputPath: string, outputDir: string, baseName?: string }} options
   */
  transcodeAnimatedGif: (options) => ipcRenderer.invoke('gif:transcodeAnimated', options),

  /**
   * Transcode a numbered image sequence (ordered frame paths + per-frame hold
   * durations) into an editing intermediate: H.264 mp4, or VP9 webm when the
   * frames carry alpha. Returns { success, outputPath, alpha, width, height,
   * duration } — the caller imports the result like any video file.
   * @param {{ entries: Array<{path: string, duration: number}>, fps: number,
   *   outputDir: string, baseName: string, alpha?: boolean|'auto',
   *   applyTrc?: string|null, jobId?: string }}
   */
  transcodeImageSequence: (options) => ipcRenderer.invoke('imageSequence:transcode', options),

  /**
   * Progress events for transcodeImageSequence jobs: { jobId, frame,
   * totalFrames }. Returns an unsubscribe function.
   */
  onImageSequenceProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('imageSequence:progress', handler)
    return () => ipcRenderer.removeListener('imageSequence:progress', handler)
  },

  /**
   * Transcode video to a low-res proxy (default 540p, CRF 28, keyframe every 6)
   * for fast multi-layer timeline preview. Only explicit proxy-review exports use these.
   * @param {{ inputPath: string, outputPath: string, targetHeight?: number }}
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  transcodeForProxy: (options) => ipcRenderer.invoke('proxy:transcode', options),
  
  /**
   * Delete a file
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
  trashAssetFiles: (payload) => ipcRenderer.invoke('fs:trashAssetFiles', payload),
  
  /**
   * Delete a directory
   * @param {string} dirPath 
   * @param {Object} options - { recursive }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteDirectory: (dirPath, options) => ipcRenderer.invoke('fs:deleteDirectory', dirPath, options),

  /**
   * Move a file or directory to the OS trash/recycle bin
   * @param {string} itemPath
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  trashItem: (itemPath) => ipcRenderer.invoke('fs:trashItem', itemPath),
  
  /**
   * Copy a file
   * @param {string} srcPath 
   * @param {string} destPath 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  copyFile: (srcPath, destPath) => ipcRenderer.invoke('fs:copyFile', srcPath, destPath),

  /**
   * Copy a directory recursively
   * @param {string} srcPath
   * @param {string} destPath
   * @returns {Promise<{success: boolean, copied?: number|null, error?: string}>}
   */
  copyDirectory: (srcPath, destPath) => ipcRenderer.invoke('fs:copyDirectory', srcPath, destPath),
  
  /**
   * Move/rename a file
   * @param {string} srcPath 
   * @param {string} destPath 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  moveFile: (srcPath, destPath) => ipcRenderer.invoke('fs:moveFile', srcPath, destPath),
  
  /**
   * List directory contents
   * @param {string} dirPath 
   * @param {Object} options - { includeStats }
   * @returns {Promise<{success: boolean, items: Array, error?: string}>}
   */
  listDirectory: (dirPath, options) => ipcRenderer.invoke('fs:listDirectory', dirPath, options),
  
  /**
   * Get file info (stats)
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, info?: Object, error?: string}>}
   */
  getFileInfo: (filePath) => ipcRenderer.invoke('fs:getFileInfo', filePath),
  
  // ============================================
  // Path Operations
  // ============================================
  
  /**
   * Join path segments
   * @param {...string} parts 
   * @returns {Promise<string>}
   */
  pathJoin: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  
  /**
   * Get directory name from path
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  pathDirname: (filePath) => ipcRenderer.invoke('path:dirname', filePath),
  
  /**
   * Get base name from path
   * @param {string} filePath 
   * @param {string} ext - Optional extension to remove
   * @returns {Promise<string>}
   */
  pathBasename: (filePath, ext) => ipcRenderer.invoke('path:basename', filePath, ext),
  
  /**
   * Get extension from path
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  pathExtname: (filePath) => ipcRenderer.invoke('path:extname', filePath),
  
  /**
   * Normalize a path
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  pathNormalize: (filePath) => ipcRenderer.invoke('path:normalize', filePath),
  
  /**
   * Get special app path
   * @param {string} name - home, appData, userData, documents, downloads, temp, etc.
   * @returns {Promise<string>}
   */
  getAppPath: (name) => ipcRenderer.invoke('path:getAppPath', name),

  /**
   * Check whether an absolute filesystem path exists (file or directory).
   * Resolves to false for missing paths, empty strings, or any error.
   * @param {string} filePath - Absolute path to check
   * @returns {Promise<boolean>}
   */
  pathExists: (filePath) => ipcRenderer.invoke('path:exists', filePath),
  
  // ============================================
  // Media URL Operations
  // ============================================
  
  /**
   * Get a URL for a local file (using the legacy comfystudio:// protocol)
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  getFileUrl: (filePath) => ipcRenderer.invoke('media:getFileUrl', filePath),
  
  /**
   * Get video stream info via ffprobe (Electron only)
   * @param {string} filePath
   * @returns {Promise<{success: boolean, duration?: number, width?: number, height?: number, fps?: number, hasAudio?: boolean, videoCodec?: string, audioCodec?: string, error?: string}>}
   */
  getVideoFps: (filePath) => ipcRenderer.invoke('media:getVideoFps', filePath),

  /**
   * Extract audio waveform peaks via ffmpeg (Electron only)
   * @param {string} mediaInput - file:// URL, legacy comfystudio:// URL, or absolute path
   * @param {object} options - { sampleCount?: number, sampleRate?: number }
   * @returns {Promise<{success: boolean, peaks?: number[], duration?: number, error?: string}>}
   */
  getAudioWaveform: (mediaInput, options = {}) => ipcRenderer.invoke('media:getAudioWaveform', mediaInput, options),

  /** Analyze a bounded local audio range outside the renderer; returns a summary only. */
  analyzeAudio: (request) => ipcRenderer.invoke('media:analyzeAudio', request),

  /**
   * Trim a short audio segment with FFmpeg and return a temporary WAV path.
   * @param {object} options - { inputPath, startSeconds, durationSeconds, outputName?, timeoutMs? }
   * @returns {Promise<{success: boolean, outputPath?: string, duration?: number, error?: string}>}
   */
  trimAudioSegment: (options = {}) => ipcRenderer.invoke('media:trimAudioSegment', options),

  /**
   * Extract a poster image from the first frames of a video via ffmpeg.
   * @param {string} inputPath - Absolute source file path
   * @param {string} outputPath - Absolute poster destination path
   * @param {object} options - { seekSeconds?: number, width?: number, quality?: number }
   * @returns {Promise<{success: boolean, width?: number, height?: number, error?: string}>}
   */
  extractVideoPoster: (inputPath, outputPath, options = {}) => ipcRenderer.invoke('media:extractVideoPoster', inputPath, outputPath, options),

  /**
   * Mix the full timeline's program audio into a single mono 16 kHz WAV file
   * via FFmpeg in the main process. Required for timeline-scope transcription
   * (decoding long videos in the renderer via Web Audio causes renderer OOMs).
   * @param {{ projectPath?: string, clips: Array, tracks: Array, assets: Array, duration: number, sampleRate?: number, timeoutMs?: number }} options
   * @returns {Promise<{success: boolean, outputPath?: string, size?: number, clipCount?: number, error?: string}>}
   */
  mixTimelineAudioForCaptions: (options = {}) => ipcRenderer.invoke('captions:mixTimelineAudio', options),

  /**
   * Local caption engine (whisper.cpp in the main process). Status reports
   * binary/model availability; install downloads them into userData; the
   * transcribe call returns word-level timings.
   */
  whisperEngineStatus: () => ipcRenderer.invoke('captions:whisperStatus'),
  whisperEngineInstall: (options = {}) => ipcRenderer.invoke('captions:whisperInstall', options),
  whisperTranscribe: (options = {}) => ipcRenderer.invoke('captions:whisperTranscribe', options),
  whisperRemoveModel: (options = {}) => ipcRenderer.invoke('captions:whisperRemoveModel', options),

  /**
   * Song listening for the music video: timed lyrics from a song file.
   * `songMapAnalyze({ inputPath })` resolves with { success, lines, voice,
   * duration } and reports { step, percent } through `onSongMapProgress`.
   */
  songMapStatus: () => ipcRenderer.invoke('songMap:status'),
  songMapAnalyze: (options = {}) => ipcRenderer.invoke('songMap:analyze', options),
  songMapCancel: () => ipcRenderer.invoke('songMap:cancel'),
  // Downloads what song listening needs (speech model, voice separator, lyric timer).
  songMapInstall: () => ipcRenderer.invoke('songMap:install'),
  onSongMapInstallProgress: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('songMap:installProgress', handler)
    return () => ipcRenderer.removeListener('songMap:installProgress', handler)
  },
  onSongMapProgress: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('songMap:progress', handler)
    return () => ipcRenderer.removeListener('songMap:progress', handler)
  },

  /**
   * Get a direct file:// URL for a local file
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  getFileUrlDirect: (filePath) => ipcRenderer.invoke('media:getFileUrlDirect', filePath),

  // ============================================
  // App Settings (persistent storage in userData)
  // ============================================
  
  /**
   * Get a setting value
   * @param {string} key - Optional, returns all settings if not provided
   * @returns {Promise<any>}
   */
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  
  /**
   * Set a setting value
   * @param {string} key 
   * @param {any} value 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  
  /**
   * Delete a setting
   * @param {string} key 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteSetting: (key) => ipcRenderer.invoke('settings:delete', key),

  // ============================================
  // MCP Server
  // ============================================

  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    updateSnapshot: (snapshot) => ipcRenderer.invoke('mcp:updateSnapshot', snapshot),
    onAction: (callback) => {
      const handler = (_event, request) => callback(request)
      ipcRenderer.on('mcp:action', handler)
      return () => ipcRenderer.removeListener('mcp:action', handler)
    },
    sendActionResult: (response) => ipcRenderer.send('mcp:actionResult', response),
  },

  // ============================================
  // Workflow Setup Manager
  // ============================================

  checkLocalComfyConnection: (payload = {}) => ipcRenderer.invoke('comfyui:checkLocalConnection', payload),
  loadComfyUiWorkflowGraph: (payload = {}) => ipcRenderer.invoke('comfyui:loadWorkflowGraph', payload),
  getComfyCloudCreditBalance: () => ipcRenderer.invoke('comfyui:getCloudCreditBalance'),
  validateWorkflowSetupRoot: (rootPath) => ipcRenderer.invoke('workflowSetup:validateRoot', rootPath),
  checkWorkflowSetupFiles: (payload = {}) => ipcRenderer.invoke('workflowSetup:checkFiles', payload),
  getWorkflowSetupDiskSpace: (payload = {}) => ipcRenderer.invoke('workflowSetup:diskSpace', payload),
  probeWorkflowSetupUrlSizes: (payload = {}) => ipcRenderer.invoke('workflowSetup:probeUrlSizes', payload),
  convertComfyWorkflowGraph: (payload = {}) => ipcRenderer.invoke('comfyui:convertWorkflowGraph', payload),
  captureComfyWorkflowGraph: (payload = {}) => ipcRenderer.invoke('comfyui:captureWorkflowGraph', payload),
  listSavedWorkflows: () => ipcRenderer.invoke('saved-workflows:list'),
  readSavedWorkflow: (payload = {}) => ipcRenderer.invoke('saved-workflows:read', payload),
  prepareSavedWorkflow: (payload = {}) => ipcRenderer.invoke('saved-workflows:prepare', payload),
  focusRendererWindow: () => ipcRenderer.invoke('window:focusRenderer'),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  installWorkflowSetup: (payload = {}) => ipcRenderer.invoke('workflowSetup:install', payload),
  onWorkflowSetupProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('workflowSetup:progress', handler)
    return () => ipcRenderer.removeListener('workflowSetup:progress', handler)
  },
  // A model ComfyUI asked for with its own Download button.
  comfyModelDownload: payload => ipcRenderer.invoke('comfy-model:download', payload),
  onDownloadProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
  onCaptionEngineProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('captions:engineProgress', handler)
    return () => ipcRenderer.removeListener('captions:engineProgress', handler)
  },

  // ============================================
  // Velorn Bridge
  // ============================================

  comfyBridge: {
    getStatus: () => ipcRenderer.invoke('comfyBridge:getStatus'),
    install: () => ipcRenderer.invoke('comfyBridge:install'),
  },

  // ============================================
  // ComfyUI Launcher (process manager)
  // ============================================

  comfyLauncher: {
    getState: () => ipcRenderer.invoke('comfyLauncher:getState'),
    getConfig: () => ipcRenderer.invoke('comfyLauncher:getConfig'),
    setConfig: (partial) => ipcRenderer.invoke('comfyLauncher:setConfig', partial),
    start: () => ipcRenderer.invoke('comfyLauncher:start'),
    stop: () => ipcRenderer.invoke('comfyLauncher:stop'),
    restart: () => ipcRenderer.invoke('comfyLauncher:restart'),
    detach: () => ipcRenderer.invoke('comfyLauncher:detach'),
    refresh: () => ipcRenderer.invoke('comfyLauncher:refresh'),
    getLogs: (options) => ipcRenderer.invoke('comfyLauncher:getLogs', options),
    appendLog: (payload) => ipcRenderer.invoke('comfyLauncher:appendLog', payload),
    openLogFile: () => ipcRenderer.invoke('comfyLauncher:openLogFile'),
    detectLaunchers: (payload) => ipcRenderer.invoke('comfyLauncher:detectLaunchers', payload),
    discoverConnections: () => ipcRenderer.invoke('comfyLauncher:discoverConnections'),
    probeConnection: (payload) => ipcRenderer.invoke('comfyLauncher:probeConnection', payload),
    pickLauncherScript: () => ipcRenderer.invoke('comfyLauncher:pickLauncherScript'),
    pickMacApp: () => ipcRenderer.invoke('comfyLauncher:pickMacApp'),
    describePortOwner: () => ipcRenderer.invoke('comfyLauncher:describePortOwner'),
    connectExternal: () => ipcRenderer.invoke('comfyLauncher:connectExternal'),
    onState: (cb) => {
      const handler = (_, state) => cb(state)
      ipcRenderer.on('comfyLauncher:state', handler)
      return () => ipcRenderer.removeListener('comfyLauncher:state', handler)
    },
    onLog: (cb) => {
      const handler = (_, entry) => cb(entry)
      ipcRenderer.on('comfyLauncher:log', handler)
      return () => ipcRenderer.removeListener('comfyLauncher:log', handler)
    },
  },

  // ============================================
  // Window Controls
  // ============================================

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  toggleFullScreenWindow: () => ipcRenderer.invoke('window:toggleFullScreen'),
  setViewerPresentation: (request) => ipcRenderer.invoke('viewer:setPresentation', request),
  getViewerPresentation: () => ipcRenderer.invoke('viewer:getPresentation'),
  onViewerPresentationChanged: (cb) => {
    const handler = (_, state) => cb(state)
    ipcRenderer.on('viewer:presentationChanged', handler)
    return () => ipcRenderer.removeListener('viewer:presentationChanged', handler)
  },
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onPrepareClose: (cb) => {
    const handler = async (_, request) => {
      if (typeof request?.id !== 'string') return
      let ok = false
      try { ok = await cb() === true } catch { /* Main keeps the window open. */ }
      ipcRenderer.send('window:closePrepared', { id: request.id, ok })
    }
    ipcRenderer.on('window:prepareClose', handler)
    return () => ipcRenderer.removeListener('window:prepareClose', handler)
  },
  onCloseCancelled: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('window:closeCancelled', handler)
    return () => ipcRenderer.removeListener('window:closeCancelled', handler)
  },
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  getWindowState: () => ipcRenderer.invoke('window:getState'),
  onWindowStateChanged: (cb) => {
    const handler = (_, state) => cb(state)
    ipcRenderer.on('window:stateChanged', handler)
    return () => ipcRenderer.removeListener('window:stateChanged', handler)
  },
})

// Also expose a simple check for detecting Electron
contextBridge.exposeInMainWorld('isElectron', true)

// Export frames are too big to pass through the bridge above cheaply (each
// call copies the frame several times on the page's main thread). Instead
// the page posts one end of a message channel here, and it is forwarded to
// the main process, which ties it to the page's own FFmpeg pipe session.
// A port cannot go through contextBridge, hence the window message.
if (typeof window !== 'undefined') window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.type !== 'velorn:export-frame-pipe-port') return
  const port = event.ports?.[0]
  if (!port || typeof data.sessionId !== 'string') return
  ipcRenderer.postMessage('export:attachFramePipePort', data.sessionId, [port])
})
