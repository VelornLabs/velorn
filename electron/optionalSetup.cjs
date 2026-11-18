'use strict'

// Optional setup inspects existing integrations; it is not an installer,
// provider selector, credential broker or model-inference endpoint.
const CHANNEL = 'optional-setup:inspect'
const INTEGRATIONS = Object.freeze(['codex', 'lmstudio', 'comfyui'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535
const safeText = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
const absolutePath = value => /^(?:[\\/]|[a-z]:[\\/])/i.test(value)
const failure = (code, error) => ({ success: false, code, error })
const INVALID = () => failure('INVALID_REQUEST', 'Choose one optional integration: Codex, LM Studio or ComfyUI.')
const optionalNotice = 'Agents and ComfyUI are optional. Editing, captions and export do not require either unless you choose a feature that explicitly uses them.'

const tools = Object.freeze([
  {
    name: 'get_setup_status',
    description: 'Read-only, bounded check of one optional Velorn integration: Codex CLI/ChatGPT sign-in, the local LM Studio server/model readiness, or running local ComfyUI connections. Works without a project. Never signs in, installs, loads models, changes settings or sends a prompt. A service not responding does not prove software is missing.',
    inputSchema: { type: 'object', properties: { integration: { type: 'string', enum: INTEGRATIONS } }, required: ['integration'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'guide_agent_setup',
    description: 'Check Codex or LM Studio readiness and explain the next explicit user actions in Velorn Settings > Connections > Connect tools. Read only; does not select an agent/model, authenticate, install software or change settings. For ComfyUI connection changes use guide_comfyui_setup. All agent setup is optional.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['codex', 'lmstudio'] } }, required: ['provider'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
])
const names = new Set(tools.map(tool => tool.name))

function safeModels(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).slice(0, 100).flatMap(value => {
    // Model IDs are data, not paths, shell commands or instructions. Omit
    // absolute paths even if an unusual server presents one as a model ID.
    if (!object(value) || !safeText(value.id) || absolutePath(value.id) || seen.has(value.id)) return []
    seen.add(value.id)
    return [{ id: value.id,
      ...(safeText(value.displayName) && !absolutePath(value.displayName) ? { displayName: value.displayName } : {}),
      ...(typeof value.loaded === 'boolean' ? { loaded: value.loaded } : {}),
    }]
  })
}

function codexStatus(result) {
  const models = safeModels(result?.models)
  if (result?.available === true && result?.signedIn === true && result?.authMode === 'chatgpt') {
    return { state: 'ready', summary: 'Codex CLI is connected through ChatGPT. No prompt was sent.', models,
      nextActions: ['Choose Codex and a model in Agent settings when you want to use an agent.'] }
  }
  if (result?.code === 'CODEX_NOT_FOUND' || result?.installed === false) {
    return { state: 'missing', summary: 'A usable Codex CLI was not found. Nothing was installed.',
      nextActions: ['In Connect tools, use Setup help > Use automatic detection or open the official Codex CLI installation guide.', 'After installing, check again. ChatGPT desktop sign-in alone does not guarantee a usable Codex CLI.'] }
  }
  if (['CODEX_LOGIN_REQUIRED', 'CODEX_CHATGPT_REQUIRED'].includes(result?.code)
    || result?.installed === true && (result?.signedIn === false || result?.authMode && result.authMode !== 'chatgpt')) {
    return { state: 'signin', summary: 'Codex CLI needs sign-in through ChatGPT. No prompt was sent and API-key billing is not enabled.',
      nextActions: ['Choose Sign in with ChatGPT in Connect tools and complete the browser sign-in yourself.', 'Return to Velorn and check the connection again.'] }
  }
  return { state: 'problem', summary: 'Codex CLI could not be verified. No sign-in or prompt was started.',
    nextActions: ['Open Connect tools to check the installation and view its setup help. A failed process launch does not prove the CLI is missing.'] }
}

function localStatus(result) {
  if (result?.success !== true) return { state: 'unavailable', summary: 'The local LM Studio server could not be verified on port 1234. It may be stopped or require configuration; this does not show whether LM Studio is installed.',
    nextActions: ['Open LM Studio and check its local server configuration on port 1234. Velorn uses the local /v1 endpoint.', 'If LM Studio requires authentication, this Velorn connection does not supply a token. Do not expose the server to the internet or turn off required authentication to make setup work.', 'Check again after reviewing the server configuration.'] }
  const models = safeModels(result.models)
  if (!models.length || result.loadedModelStatus === 'available' && !models.some(model => model.loaded === true)) {
    return { state: 'needs-model', summary: models.length ? 'LM Studio is responding, but no loaded chat model was found.' : 'LM Studio is responding, but no chat model was found.', models,
      nextActions: ['Choose and load a chat model in LM Studio, then check again. This check does not download or load a model.', 'Select the model explicitly in Velorn Agent settings when you are ready.'] }
  }
  if (result.loadedModelStatus !== 'available') return { state: 'problem', summary: 'LM Studio is responding, but Velorn could not verify which chat model is loaded.', models,
    nextActions: ['Check the loaded model in LM Studio, then refresh. No inference request was made to test it.', 'Review the model in Agent settings before sending a message.'] }
  return { state: 'ready', summary: 'LM Studio is responding with a loaded chat model. No inference request was made; model capabilities have not been tested.', models,
    nextActions: ['Choose LM Studio and its model explicitly in Agent settings when you want to use it. Your current agent and chat are unchanged.'] }
}

function createOptionalSetup({ inspectProvider, comfySetup, getConfiguredPort } = {}) {
  const pending = new Map()
  async function check(integration) {
    if (integration !== 'comfyui') {
      const result = await inspectProvider?.({ provider: integration })
      if (['BUSY', 'CANCELLED', 'UNAUTHORIZED'].includes(result?.code)) return failure(result.code,
        result.code === 'BUSY' ? 'Another provider check or setup change is running. Try again when it finishes.' : 'The setup check was cancelled or the Velorn connection closed.')
      const status = integration === 'codex' ? codexStatus(result) : localStatus(result)
      return { success: true, integration, ...status }
    }
    const configuredPort = await getConfiguredPort?.()
    if (!validPort(configuredPort)) return failure('SETUP_UNAVAILABLE', 'The saved local ComfyUI port could not be read. No settings were changed.')
    if (typeof comfySetup?.discoverRunning !== 'function') return failure('SETUP_UNAVAILABLE', 'ComfyUI setup inspection is unavailable. Restart Velorn.')
    const found = await comfySetup.discoverRunning({ configuredPort })
    const connections = (Array.isArray(found) ? found : []).slice(0, 4).flatMap(value => validPort(value?.port) ? [{
      port: value.port, httpBase: `http://127.0.0.1:${value.port}`,
      deviceNames: (Array.isArray(value.deviceNames) ? value.deviceNames : []).filter(safeText).slice(0, 16),
    }] : [])
    const ready = connections.some(value => value.port === configuredPort)
    return { success: true, integration, state: ready ? 'ready' : 'unavailable', configuredPort, connections,
      summary: ready ? 'The configured local ComfyUI server is responding. Workflows and models were not checked.'
        : connections.length ? 'Running ComfyUI servers were found, but the configured connection is not responding. Choose which server to connect; no settings were changed.'
          : 'No ComfyUI server responded on the checked local ports. It may be stopped or use another port; this does not prove it is uninstalled.',
      nextActions: ready ? ['Use ComfyUI generation when you want it. The editor does not require it.']
        : [connections.length ? 'Choose an exact port in Connect tools, or ask the agent to preview guide_comfyui_setup for that port.' : 'Start your existing ComfyUI installation, then check again. Use ComfyUI connection settings if it uses another local port.', 'Connecting ComfyUI does not install models, run a workflow or spend credits.'],
    }
  }
  async function inspect(payload) {
    if (!object(payload) || Object.keys(payload).some(key => key !== 'integration') || !INTEGRATIONS.includes(payload.integration)) return INVALID()
    const integration = payload.integration
    if (pending.has(integration)) return pending.get(integration)
    const operation = check(integration).catch(() => failure('SETUP_UNAVAILABLE', 'This setup check could not finish. No settings were changed.')).finally(() => pending.delete(integration))
    pending.set(integration, operation)
    return operation
  }
  async function guide(payload) {
    if (!object(payload) || Object.keys(payload).some(key => key !== 'provider') || !['codex', 'lmstudio'].includes(payload.provider)) return INVALID()
    const status = await inspect({ integration: payload.provider })
    return status.success ? { ...status, optional: true, notice: optionalNotice,
      location: 'Velorn Settings > Connections > Connect tools',
      changesMade: false, userActionRequired: status.state !== 'ready',
    } : status
  }
  return { inspect, guide }
}

function registerOptionalSetupIpc({ ipcMain, app, getMainWindow, setup }) {
  let disposed = false
  function authorized(event) {
    const window = getMainWindow()
    return !disposed && window && !window.isDestroyed() && event?.sender && !event.sender.isDestroyed()
      && event.sender === window.webContents && event.senderFrame && event.senderFrame === window.webContents.mainFrame
  }
  ipcMain.handle(CHANNEL, async (event, payload) => {
    if (!authorized(event)) return failure('UNAUTHORIZED', 'Setup checks are restricted to the main Velorn window.')
    const result = await setup.inspect(payload)
    return authorized(event) ? result : failure('UNAUTHORIZED', 'The Velorn setup window changed.')
  })
  const dispose = () => { disposed = true; ipcMain.removeHandler(CHANNEL); app?.removeListener('will-quit', dispose) }
  app?.on('will-quit', dispose)
  return { dispose }
}

module.exports = { CHANNEL, INTEGRATIONS, tools, names, createOptionalSetup, registerOptionalSetupIpc }
