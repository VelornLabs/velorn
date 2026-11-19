'use strict'

// Candidate-only Codex app-server client. The native caller must place this
// process in a dedicated runtime namespace BEFORE calling start(). Never reuse
// the personal Codex adapter or its authentication/configuration directories.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

const MODEL = 'gpt-6-luna'
const EFFORT = 'low'
const PROVIDER = 'velorn-funded-codex'
const TOKEN_ENV = 'VELO_CODEX_GATEWAY_TOKEN'
// The desktop owns one isolated namespace. Keep concurrent clients in that
// host from opening two turns against the same durable conversation.
const activeScopes = new Set()
const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && value.length > 0 && value.length < 512 && !/[\u0000-\u001f]/.test(value)
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f]/.test(value)
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function scopeKey(scope) {
  if (!object(scope) || !['accountId', 'projectId', 'chatId'].every(key => validId(scope[key]))) throw fault('VELO_ENGINE_SCOPE', 'A native account/project/chat scope is required.')
  return digest(JSON.stringify([scope.accountId, scope.projectId, scope.chatId]))
}
function localProviderUrl(value) {
  let url
  try { url = new URL(value) } catch { throw fault('VELO_ENGINE_PROVIDER', 'An isolated loopback gateway is required.') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) throw fault('VELO_ENGINE_PROVIDER', 'Only an explicit loopback gateway without credentials in its URL is accepted.')
  return url.href.replace(/\/$/, '')
}
function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (object(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function checkedMcp(mcpServers = {}, mcpEnv = {}, accessMode) {
  if (!object(mcpServers) || !object(mcpEnv) || (accessMode === 'chat' && Object.keys(mcpServers).length)) throw fault('VELO_ENGINE_CONFIG', 'Chat only cannot enable external tools.')
  const wantedEnv = new Set()
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!['velorn_session', 'velorn_generation'].includes(name) || !object(server) || !/^VELORN_AGENT_MCP_[A-F0-9]{16}$/.test(server.bearer_token_env_var)
      || !/^[a-f0-9]{64}$/.test(mcpEnv[server.bearer_token_env_var] || '')
      || (server.default_tools_approval_mode !== undefined && server.default_tools_approval_mode !== 'approve')
      || Object.keys(server).some(k => !['url', 'bearer_token_env_var', 'startup_timeout_sec', 'tool_timeout_sec', 'default_tools_approval_mode', 'enabled', 'required', 'enabled_tools'].includes(k))) throw fault('VELO_ENGINE_CONFIG', 'Only the native per-turn Velorn MCP gateway is accepted.')
    if (new URL(localProviderUrl(server.url)).pathname !== '/mcp') throw fault('VELO_ENGINE_CONFIG', 'Invalid local Velorn tool endpoint.')
    wantedEnv.add(server.bearer_token_env_var)
  }
  if (Object.keys(mcpEnv).some(name => !wantedEnv.has(name))) throw fault('VELO_ENGINE_CONFIG', 'Unrelated child environment entries are not accepted.')
  return JSON.parse(JSON.stringify(mcpServers))
}
function buildEngineConfig({ providerUrl, catalogPath, stateDir, accessMode = 'chat', gatewayBearerToken, mcpServers = {}, mcpEnv = {}, directGenerationWait = false }) {
  if (!['chat', 'velorn', 'full'].includes(accessMode) || !absolute(catalogPath) || !absolute(stateDir)) throw fault('VELO_ENGINE_CONFIG', 'Invalid native engine configuration.')
  const full = accessMode === 'full'
  const mcp = checkedMcp(mcpServers, mcpEnv, accessMode)
  return {
    model: MODEL, model_provider: PROVIDER, model_reasoning_effort: EFFORT,
    model_catalog_json: catalogPath,
    model_providers: { [PROVIDER]: {
      name: 'Velorn local funded gateway', base_url: localProviderUrl(providerUrl), wire_api: 'responses',
      capabilities: { remote_compaction: 'v2' },
      requires_openai_auth: false, supports_websockets: false,
      request_max_retries: 0, stream_max_retries: 0,
      ...(gatewayBearerToken ? { env_key: TOKEN_ENV } : {}),
    } },
    cli_auth_credentials_store: 'ephemeral', approval_policy: 'never', approvals_reviewer: 'user',
    sandbox_mode: full ? 'danger-full-access' : 'read-only',
    features: {
      code_mode: { enabled: accessMode !== 'chat', excluded_tool_namespaces: full ? [] : ['functions', 'clock'],
        ...(directGenerationWait && accessMode !== 'chat' ? { direct_only_tool_namespaces: ['mcp__velorn_generation'] } : {}) },
      code_mode_host: accessMode !== 'chat', shell_tool: full, unified_exec: full, view_image: full,
      plugins: false, apps: false, hooks: false, memories: false, shell_snapshot: false,
      multi_agent: false, browser_use: false, computer_use: false, image_generation: false,
      remote_control: false, responses_websockets: false, responses_websockets_v2: false,
      unbounded_connection_retries: false, skip_host_skill_discovery: true,
      api_key_cyber_access_programs: false, api_key_model_discovery: false,
      remote_plugin: false, tool_suggest: false, auth_elicitation: false, mentions_v2: false,
    },
    agents: { enabled: false }, mcp_servers: mcp, plugins: {}, hooks: {}, notify: [],
    project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
    allow_login_shell: false,
    shell_environment_policy: { inherit: 'core', exclude: [TOKEN_ENV, ...Object.keys(mcpEnv)], ignore_default_excludes: false },
    web_search: 'disabled', analytics: { enabled: false }, check_for_update_on_startup: false,
    log_dir: path.join(stateDir, 'logs'),
    otel: { exporter: 'none', trace_exporter: 'none', metrics_exporter: 'none', log_user_prompt: false, tool_result: { max_bytes: 0 } },
  }
}
function verifyEffectiveConfiguration(actual, expected) {
  const matches = (got, wanted, at = '') => {
    if (Array.isArray(wanted)) return Array.isArray(got) && got.length === wanted.length && got.every((value, index) => matches(value, wanted[index], at))
    if (!object(wanted)) return got === wanted
    if (!object(got) || !Object.entries(wanted).every(([key, value]) => matches(got[key], value, `${at}.${key}`))) return false
    return Object.entries(got).every(([key, value]) => key in wanted || value == null || value === false || (Array.isArray(value) && value.length === 0)
      || (at === '.features' && ['auth_elicitation', 'mentions_v2'].includes(key) && value === true)
      || (at.startsWith('.mcp_servers.') && key === 'environment_id' && value === 'local')
      || (at === '.otel' && ['environment', 'service_name'].includes(key) && typeof value === 'string'))
  }
  if (!object(actual) || !Object.entries(expected).every(([key, value]) => matches(actual[key], value, `.${key}`))
    || ['openai_base_url', 'model_instructions_file', 'experimental_instructions_file', 'experimental_compact_prompt_file', 'compact_prompt'].some(key => actual[key])) throw fault('VELO_ENGINE_CONFIGURATION_UNSAFE', 'The engine could not verify its model, provider, permissions and isolated integrations. No prompt was sent.')
}
function readRecord(file) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')) } finally { fs.closeSync(fd) }
  } catch (error) { if (error.code === 'ENOENT') return null; throw fault('VELO_ENGINE_STATE', 'The isolated engine state could not be read safely.') }
}
function writeRecord(file, value) {
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
}
function dynamicSpecs(tools, accessMode) {
  if (accessMode === 'chat') return []
  if (!Array.isArray(tools)) throw fault('VELO_ENGINE_TOOLS', 'Native tool definitions must be an array.')
  const seen = new Set()
  const specs = tools.map(tool => {
    if (!object(tool) || typeof tool.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tool.name) || seen.has(tool.name) || typeof tool.description !== 'string' || !object(tool.inputSchema)) throw fault('VELO_ENGINE_TOOLS', 'Invalid or duplicate native tool definition.')
    seen.add(tool.name)
    return { type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
  })
  return specs.length ? [{ type: 'namespace', name: 'velorn', description: 'Native Velorn project tools; permissions and spending remain enforced by Velorn.', tools: specs }] : []
}

function createVeloCodexEngine(options) {
  const { executablePath, catalogPath, stateDir, workspaceDir, scope,
    accessMode = 'chat', gatewayBearerToken, mcpServers = {}, mcpEnv = {}, tools = [], callHostTool,
    assertIsolatedRuntime, assertAuthorized, onEvent = () => {},
    spawnImpl = spawn, rpcTimeoutMs = 30000 } = options || {}
  if (![executablePath, catalogPath, stateDir, workspaceDir].every(absolute)
    || typeof assertIsolatedRuntime !== 'function' || typeof assertAuthorized !== 'function'
    || typeof onEvent !== 'function' || !Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) throw fault('VELO_ENGINE_CONFIG', 'Native paths, isolation and authority checks are required.')
  if (gatewayBearerToken !== undefined && (typeof gatewayBearerToken !== 'string' || !gatewayBearerToken || /[\r\n\u0000]/.test(gatewayBearerToken))) throw fault('VELO_ENGINE_CONFIG', 'Invalid local gateway capability.')
  const key = scopeKey(scope)
  const providerUrl = localProviderUrl(options.providerUrl)
  const config = buildEngineConfig({ providerUrl, catalogPath, stateDir, accessMode, gatewayBearerToken, mcpServers, mcpEnv,
    directGenerationWait: options.directGenerationWait === true })
  const specs = dynamicSpecs(tools, accessMode)
  const allowedTools = new Set(tools.map(t => t.name))
  const recordFile = path.join(stateDir, `${key}.json`)
  const receiptDir = path.join(stateDir, `${key}.calls`)
  const lockKey = `${stateDir}\0${key}`
  let ownsScope = false
  let child, record, threadId, starting, closed = false, closing = false, active = null, serial = 0, pendingStart = false
  let buffered = '', startedFresh = false, preparing = false
  const decoder = new StringDecoder('utf8')
  const rpcs = new Map(), hostCalls = new Map(), orphanEvents = []
  const emit = event => { try { onEvent(event) } catch { /* observer failure cannot repeat actions */ } }
  const save = patch => { record = { ...record, ...patch, updatedAt: new Date().toISOString() }; writeRecord(recordFile, record) }
  const uncertain = error => {
    if (record?.threadId && (active || pendingStart)) { try { save({ status: 'uncertain' }) } catch {} }
    for (const { reject, timer } of rpcs.values()) { clearTimeout(timer); reject(error) }
    rpcs.clear()
    if (active) { const turn = active; active = null; turn.signal?.removeEventListener('abort', turn.abort); turn.reject(error) }
  }
  function send(message) {
    if (!child || child.exitCode != null || child.signalCode || !child.stdin.writable) throw fault('VELO_ENGINE_TRANSPORT', 'The isolated engine is unavailable. Earlier actions may have completed.', { recoveryRequired: true })
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++serial
      const timer = setTimeout(() => {
        rpcs.delete(id)
        const error = fault('VELO_ENGINE_TRANSPORT', `The isolated engine did not acknowledge ${method}. Do not repeat uncertain actions.`, { recoveryRequired: true })
        reject(error)
        uncertain(error)
      }, rpcTimeoutMs)
      rpcs.set(id, { resolve, reject, timer })
      try { send({ id, method, params }) } catch (error) { clearTimeout(timer); rpcs.delete(id); reject(error) }
    })
  }
  async function handleTool(event) {
    const p = event.params
    if (!active || active.kind === 'compaction' || p?.threadId !== threadId || p.turnId !== active.turnId || p.namespace !== 'velorn'
      || accessMode === 'chat' || !allowedTools.has(p.tool) || !validId(p.callId) || typeof callHostTool !== 'function') {
      send({ id: event.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Velorn rejected an unscoped or unavailable tool. No action was performed.' }] } }); return
    }
    const callKey = digest(JSON.stringify([threadId, p.turnId, p.callId]))
    if (!hostCalls.has(callKey)) {
      const result = (async () => {
        const file = path.join(receiptDir, `${callKey}.json`)
        if (readRecord(file)) return { success: false, contentItems: [{ type: 'inputText', text: 'This tool call was already dispatched. It will not be repeated. Inspect the retained history and actual result before continuing.' }] }
        await assertAuthorized({ stage: 'tool', scope, accessMode, tool: p.tool, arguments: p.arguments, signal: active?.signal })
        if (!active || active.turnId !== p.turnId || active.signal?.aborted) throw fault('CANCELLED', 'The request was stopped before the host tool ran.')
        writeRecord(file, { version: 1, callKey, status: 'dispatched', tool: p.tool })
        const value = await callHostTool(p.tool, p.arguments, { threadId, turnId: p.turnId, callId: p.callId, signal: active.signal })
        writeRecord(file, { version: 1, callKey, status: 'returned', tool: p.tool })
        if (object(value) && Array.isArray(value.contentItems) && typeof value.success === 'boolean') return value
        const content = object(value) && Array.isArray(value.content) ? value.content : null
        const contentItems = content ? content.map(i => i.type === 'image' && /^image\//.test(i.mimeType) && typeof i.data === 'string'
          ? { type: 'inputImage', imageUrl: `data:${i.mimeType};base64,${i.data}` }
          : { type: 'inputText', text: i.type === 'text' && typeof i.text === 'string' ? i.text : JSON.stringify(i) }) : [{ type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }]
        return { success: value?.isError !== true, contentItems }
      })().catch(error => ({ success: false, contentItems: [{ type: 'inputText', text: error?.code === 'CANCELLED' ? 'The request was cancelled. Inspect before repeating earlier actions.' : 'The native Velorn tool failed or permission changed. Inspect the result; do not repeat uncertain actions automatically.' }] }))
      hostCalls.set(callKey, result)
    }
    send({ id: event.id, result: await hostCalls.get(callKey) })
  }
  function acceptEvent(event) {
    if (event.id != null && !event.method) {
      const pending = rpcs.get(event.id)
      if (!pending) return
      rpcs.delete(event.id); clearTimeout(pending.timer)
      event.error ? pending.reject(fault('VELO_ENGINE_RPC', String(event.error.message || 'Engine request failed.'), { rpcCode: event.error.code })) : pending.resolve(event.result)
      return
    }
    if (event.id != null) {
      if (pendingStart && !active && event.method === 'item/tool/call') { orphanEvents.push(event); return }
      if (event.method === 'item/tool/call') { handleTool(event).catch(error => uncertain(error)); return }
      // No auth refresh, tool elevation, user input or other authority is granted
      // by this transport. The native adapter must implement a reviewed path.
      send({ id: event.id, error: { code: -32601, message: 'This engine host does not grant this request.' } }); return
    }
    const p = event.params || {}
    if (p.threadId && threadId && p.threadId !== threadId) return
    if (pendingStart && !active) { orphanEvents.push(event); return }
    if (active && p.turnId && active.turnId && p.turnId !== active.turnId) return
    // Manual compaction acknowledges with {} rather than a turn identity. Its
    // own turn/started event establishes the operation identity, including when
    // that event races the RPC acknowledgement. No user/tool turn is replayed.
    if (active?.kind === 'compaction' && !active.turnId && event.method === 'turn/started' && validId(p.turn?.id)) {
      active.turnId = p.turn.id
      save({ status: 'running', lastTurnId: active.turnId })
      if (active.abortRequested || active.signal?.aborted) void cancel().catch(error => uncertain(error))
    }
    emit(event)
    if (!active) return
    if (event.method === 'item/completed' && p.item) active.items.push(p.item)
    if (event.method === 'thread/tokenUsage/updated') active.usage = p.tokenUsage
    if (event.method !== 'turn/completed' || p.turn?.id !== active.turnId) return
    const turn = active; active = null
    turn.signal?.removeEventListener('abort', turn.abort)
    const status = p.turn.status
    const compactionVerified = turn.kind !== 'compaction' || turn.items.some(item => item.type === 'contextCompaction')
    save({ status: status === 'completed' && compactionVerified ? 'completed' : 'uncertain', lastTurnId: p.turn.id,
      ...(turn.kind === 'compaction' ? { lastOperation: 'compaction' } : {}) })
    const publicMessages = turn.items.filter(i => i.type === 'agentMessage')
    const finalMessages = publicMessages.filter(i => i.phase === 'final_answer')
    // Commentary is already streamed as activity; do not copy it into the
    // final stored reply. Older/provider fixtures may omit the phase field.
    const text = (finalMessages.length ? finalMessages : publicMessages.slice(-1)).map(i => i.text || '').join('\n')
    const result = { threadId, turnId: p.turn.id, status, text, completedItems: turn.items, usage: turn.usage, resumed: turn.resumed,
      ...(turn.kind === 'compaction' ? { operation: 'compaction', compacted: status === 'completed' && compactionVerified } : {}) }
    if (status === 'completed' && !compactionVerified) {
      turn.reject(fault('VELO_ENGINE_COMPACTION_UNCONFIRMED', 'The engine did not confirm context compaction. Its retained history will not be replaced or replayed by Velorn.', { recoveryRequired: true, result })); return
    }
    if (status === 'failed') turn.reject(fault('VELO_ENGINE_TURN_FAILED', 'Velo could not finish this turn. Earlier actions may have completed; inspect before continuing.', { recoveryRequired: true, result, engineError: p.turn.error }))
    else turn.resolve(result)
  }
  async function start() {
    if (closed) throw fault('VELO_ENGINE_CLOSED', 'This engine client has been closed.')
    if (threadId) return { threadId, resumed: !startedFresh, recoveryRequired: record.status === 'uncertain' }
    if (starting) return starting
    starting = (async () => {
      if (activeScopes.has(lockKey)) throw fault('VELO_ENGINE_BUSY', 'This scoped Velo conversation already has an engine client.')
      activeScopes.add(lockKey); ownsScope = true
      if (await assertIsolatedRuntime({ executablePath, stateDir, workspaceDir }) !== true) throw fault('VELO_ENGINE_ISOLATION', 'The dedicated engine runtime is not isolated. No process was started.')
      await assertAuthorized({ stage: 'start', scope, accessMode })
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      if (fs.realpathSync(stateDir) !== path.resolve(stateDir)) throw fault('VELO_ENGINE_STATE', 'The isolated state directory must not use symbolic links.')
      fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 })
      if (fs.realpathSync(receiptDir) !== receiptDir) throw fault('VELO_ENGINE_STATE', 'The isolated receipt directory must not use symbolic links.')
      record = readRecord(recordFile)
      if (record && (record.version !== 1 || record.scopeKey !== key || record.model !== MODEL || record.provider !== PROVIDER || record.workspaceDir !== workspaceDir || !validId(record.threadId)
        || !['ready', 'completed', 'uncertain', 'dispatching', 'running'].includes(record.status))) throw fault('VELO_ENGINE_STATE', 'Stored engine history does not match this account, project and chat.')
      const env = { PATH: `${path.dirname(executablePath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', ...mcpEnv, ...(gatewayBearerToken ? { [TOKEN_ENV]: gatewayBearerToken } : {}) }
      const args = ['app-server', '--stdio', '--strict-config', ...Object.entries(config).flatMap(([name, value]) => ['-c', `${name}=${toml(value)}`])]
      child = spawnImpl(executablePath, args, { cwd: workspaceDir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
      child.on('error', () => uncertain(fault('VELO_ENGINE_PROCESS', 'The bundled engine could not start.', { recoveryRequired: true })))
      child.on('exit', () => { if (!closing) uncertain(fault('VELO_ENGINE_TRANSPORT', 'The engine stopped. Earlier actions may have completed.', { recoveryRequired: true })) })
      child.stdout.on('data', chunk => {
        buffered += decoder.write(chunk)
        let newline
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1)
          if (!line.trim()) continue
          try { acceptEvent(JSON.parse(line)) } catch { uncertain(fault('VELO_ENGINE_PROTOCOL', 'The engine protocol could not be verified.', { recoveryRequired: true })) }
        }
      })
      // Drain diagnostics without exposing environment, instructions or tool data
      // in a generic user-facing failure. A reviewed diagnostic sink can be added.
      child.stderr.on('data', () => {})
      await rpc('initialize', { clientInfo: { name: 'velorn_funded_engine', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      send({ method: 'initialized', params: {} })
      const auth = await rpc('account/read', { refreshToken: false })
      if (auth?.account !== null || auth?.requiresOpenaiAuth !== false) throw fault('VELO_ENGINE_PERSONAL_AUTH', 'The bundled engine must not use a personal Codex account. No prompt was sent.')
      const effective = await rpc('config/read', { includeLayers: false, cwd: workspaceDir })
      verifyEffectiveConfiguration(effective.config, config)
      const base = { model: MODEL, modelProvider: PROVIDER, cwd: workspaceDir, approvalPolicy: 'never', sandbox: accessMode === 'full' ? 'danger-full-access' : 'read-only' }
      let response
      if (record) {
        response = await rpc('thread/resume', { ...base, threadId: record.threadId, excludeTurns: true })
        if (response.thread?.id !== record.threadId || response.thread?.ephemeral !== false) throw fault('VELO_ENGINE_STATE', 'The stored thread could not be resumed safely.')
        if (['dispatching', 'running'].includes(record.status)) save({ status: 'uncertain' })
        threadId = response.thread.id
      }
      // A fresh Codex thread has no resumable rollout before its first turn.
      // Delay creation until runTurn supplies its current developer context.
      return { threadId: threadId || null, resumed: !!threadId, recoveryRequired: record?.status === 'uncertain' }
    })().catch(async error => { await close(); throw error })
    return starting
  }
  async function executeTurn({ input, firstInput, developerInstructions = '', signal, acknowledgeUncertain = false } = {}) {
    if (active || pendingStart) throw fault('VELO_ENGINE_BUSY', 'This chat already has an active engine turn.')
    if (!Array.isArray(input) || !input.length || (firstInput !== undefined && !Array.isArray(firstInput)) || typeof developerInstructions !== 'string') throw fault('VELO_ENGINE_INPUT', 'Native-validated message input is required.')
    if (signal?.aborted) throw fault('CANCELLED', 'The request was cancelled before sending.')
    await start()
    if (record?.status === 'uncertain' && !acknowledgeUncertain) throw fault('VELO_ENGINE_RECOVERY_REQUIRED', 'The previous turn may have completed actions. Inspect and explicitly continue; it will not be replayed.', { recoveryRequired: true })
    await assertAuthorized({ stage: 'turn', scope, accessMode, signal })
    if (signal?.aborted) throw fault('CANCELLED', 'The request was cancelled before sending.')
    // Fresh permissions/context are native developer input. The catalog's model
    // instructions remain intact; no historical messages are injected on resume.
    const base = { model: MODEL, modelProvider: PROVIDER, cwd: workspaceDir, developerInstructions, approvalPolicy: 'never', sandbox: accessMode === 'full' ? 'danger-full-access' : 'read-only' }
    if (threadId) {
      await rpc('thread/resume', { ...base, threadId, excludeTurns: true })
    } else {
      const response = await rpc('thread/start', { ...base, ephemeral: false, allowProviderModelFallback: false, dynamicTools: specs })
      if (!validId(response.thread?.id) || response.thread?.ephemeral !== false) throw fault('VELO_ENGINE_STATE', 'The engine did not create a durable isolated thread.')
      threadId = response.thread.id; startedFresh = true
      record = { version: 1, scopeKey: key, model: MODEL, provider: PROVIDER, workspaceDir, threadId, status: 'ready' }
      save({})
    }
    save({ status: 'dispatching' }); pendingStart = true
    let resolve, reject
    const done = new Promise((a, b) => { resolve = a; reject = b })
    try {
      const response = await rpc('turn/start', { threadId, model: MODEL, effort: EFFORT, input: startedFresh && firstInput?.length ? firstInput : input })
      if (!validId(response.turn?.id)) throw fault('VELO_ENGINE_PROTOCOL', 'The engine returned an invalid turn identity.', { recoveryRequired: true })
      active = { turnId: response.turn.id, resolve, reject, items: [], usage: null, signal, resumed: !startedFresh }
      active.abort = () => { cancel().catch(error => uncertain(error)) }
      signal?.addEventListener('abort', active.abort, { once: true })
      pendingStart = false; startedFresh = false
      save({ status: 'running', lastTurnId: active.turnId })
      for (const event of orphanEvents.splice(0)) acceptEvent(event)
      if (signal?.aborted) await cancel()
      return await done
    } catch (error) { pendingStart = false; if (record) save({ status: 'uncertain' }); throw error }
  }
  async function runTurn(request) {
    if (preparing || active || pendingStart) throw fault('VELO_ENGINE_BUSY', 'This scoped Velo turn is already running.')
    preparing = true
    try { return await executeTurn(request) } finally { preparing = false }
  }
  async function compactThread({ signal, acknowledgeUncertain = false } = {}) {
    if (preparing || active || pendingStart) throw fault('VELO_ENGINE_BUSY', 'This scoped Velo thread already has an active operation.')
    if (signal?.aborted) throw fault('CANCELLED', 'Context compaction was cancelled before sending.')
    preparing = true
    try {
      await start()
      if (!threadId || !record || !validId(record.lastTurnId)) throw fault('VELO_ENGINE_NO_HISTORY', 'An existing engine conversation with a prior turn is required for compaction.')
      if (record.status === 'uncertain' && !acknowledgeUncertain) throw fault('VELO_ENGINE_RECOVERY_REQUIRED', 'Inspect the previous uncertain operation before compacting. Nothing was replayed.', { recoveryRequired: true })
      await assertAuthorized({ stage: 'compaction', scope, accessMode, signal })
      if (signal?.aborted) throw fault('CANCELLED', 'Context compaction was cancelled before sending.')
      let resolve, reject
      const done = new Promise((a, b) => { resolve = a; reject = b })
      // Prevent a synchronous transport failure from becoming an unhandled
      // rejection while the RPC acknowledgement is still pending.
      done.catch(() => {})
      active = { kind: 'compaction', turnId: null, resolve, reject, items: [], usage: null, signal, resumed: true, abortRequested: false }
      active.abort = () => { if (!active) return; active.abortRequested = true; if (active.turnId) void cancel().catch(error => uncertain(error)) }
      signal?.addEventListener('abort', active.abort, { once: true })
      save({ status: 'dispatching', lastOperation: 'compaction' })
      try {
        await rpc('thread/compact/start', { threadId })
        if (signal?.aborted) active?.abort()
        return await done
      } catch (error) {
        if (active?.kind === 'compaction') { const operation = active; active = null; operation.signal?.removeEventListener('abort', operation.abort) }
        save({ status: 'uncertain' }); throw error
      }
    } finally { preparing = false }
  }
  async function cancel() {
    if (!active?.turnId) { if (active?.kind === 'compaction') active.abortRequested = true; return { stopped: false } }
    const turnId = active.turnId
    await rpc('turn/interrupt', { threadId, turnId })
    // Stop also cleans already-yielded native terminals owned by this thread.
    // This never cancels Velorn-managed ComfyUI jobs or another chat's process.
    await rpc('thread/backgroundTerminals/clean', { threadId })
    return { stopped: true, turnId }
  }
  async function close() {
    if (closing || closed) return
    closing = true
    if (active) { try { await cancel() } catch {} }
    if (child) {
      try { if (threadId) await rpc('thread/backgroundTerminals/clean', { threadId }) } catch {}
      try { child.stdin.end() } catch {}
      try { if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch {}
    }
    uncertain(fault('VELO_ENGINE_CLOSED', 'The isolated engine client closed. Inspect uncertain actions before continuing.', { recoveryRequired: true }))
    if (ownsScope) { activeScopes.delete(lockKey); ownsScope = false }
    closed = true; closing = false
  }
  return Object.freeze({ start, runTurn, compactThread, cancel, close, get scopeKey() { return key }, get threadId() { return threadId } })
}

module.exports = { MODEL, EFFORT, PROVIDER, scopeKey, buildEngineConfig, verifyEffectiveConfiguration, createVeloCodexEngine }
