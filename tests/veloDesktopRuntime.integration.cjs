'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createDesktopRuntime } = require('../electron/veloDesktopRuntime.cjs')
const { createVeloCodexEngine } = require('../electron/veloCodexEngine.cjs')
test('actual bundled app-server starts with separate OS home and no personal auth; no inference', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-desktop-native-proof-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = createDesktopRuntime({ runtimeRoot: path.resolve(__dirname, '../../runtime'), profileRoot: root })
  const account = runtime.account('synthetic-account')
  assert.equal(runtime.account('synthetic-account').stateDir, account.stateDir)
  assert.notEqual(runtime.account('different-account').stateDir, account.stateDir)
  const catalogPath = path.join(account.catalogs, 'synthetic.json')
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'Synthetic no-inference catalog',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Light' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, upgrade: null,
    base_instructions: 'Offline start-only fixture. Do not make any inference.',
    supports_reasoning_summaries: true, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text', context_window: 200000,
    effective_context_window_percent: 95, experimental_supported_tools: [], tool_mode: 'code_mode_only',
    truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false,
    input_modalities: ['text'], additional_speed_tiers: [], service_tiers: [], default_service_tier: null }] }))
  for (const mode of ['chat', 'velorn', 'full']) {
    let diagnostic = ''
    const engine = createVeloCodexEngine({ executablePath: runtime.executablePath, catalogPath, stateDir: account.stateDir,
      workspaceDir: root, scope: { accountId: 'synthetic', projectId: 'fixture', chatId: mode },
      providerUrl: 'http://127.0.0.1:1/v1', gatewayBearerToken: 'SYNTHETIC_ONLY',
      accessMode: mode, assertIsolatedRuntime: runtime.verify, assertAuthorized: async () => true,
      spawnImpl: (...args) => { const child = account.spawnEngine(...args); child.stderr.on('data', chunk => { diagnostic += chunk }); return child } })
    try { const value = await engine.start(); assert.equal(value.threadId, null); assert.equal(value.recoveryRequired, false) }
    catch (error) { throw new Error(mode + ': ' + diagnostic.slice(-3000), { cause: error }) }
    finally { await engine.close() }
  }
  assert.ok(fs.existsSync(path.join(account.engineHome, '.codex')), 'Codex state is in its private runtime home')
})
