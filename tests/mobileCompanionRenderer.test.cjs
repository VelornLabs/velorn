const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')
const { transformSync } = require('esbuild')
const code = transformSync(fs.readFileSync(require.resolve('../src/components/MobileCompanion.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code
const receiptsModule = { exports: {} }
vm.runInNewContext(transformSync(fs.readFileSync(require.resolve('../src/utils/connectedAgentReceipts.mjs'), 'utf8'), { format: 'cjs' }).code,
  { module: receiptsModule, exports: receiptsModule.exports })

// Deterministic hook harness, no browser/server/model or real project involved.
function fixture({ remembered = false, initiallyReady = true, preference = {} } = {}) {
  let index = 0, effects = [], rerender = false, listener, enabled = false, result
  const slots = [], calls = [], intervals = new Map()
  const equal = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]))
  const react = {
    useState(initial) { const i = index++; slots[i] ||= {value: typeof initial === 'function' ? initial() : initial}; return [slots[i].value,value => { const next = typeof value === 'function' ? value(slots[i].value) : value; if (!Object.is(next,slots[i].value)) { slots[i].value = next; rerender = true } }] },
    useRef(initial) { const i = index++; slots[i] ||= {current:initial}; return slots[i] },
    useMemo(fn,deps) { const i = index++; if (!equal(slots[i]?.deps,deps)) slots[i] = {value:fn(),deps}; return slots[i].value },
    useEffect(fn,deps) { const i = index++; if (!equal(slots[i]?.deps,deps)) { const old = slots[i]; slots[i] = {deps}; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn() }) } },
  }
  const api = {
    ready: initiallyReady,
    async getPreference() { return { success: true, enabled: remembered, ...preference } },
    onEvent(fn) { listener = fn; return () => { if (listener === fn) listener = null } },
    async attach(payload) { calls.push(['attach',payload]); if (remembered && api.ready) enabled = true; return {success:true,status:{enabled,paired:enabled}} },
    async detach(payload) { calls.push(['detach',payload]); return {success:true} },
    async enable(payload) { remembered = true; enabled = true; calls.push(['enable',payload]); return {success:true,status:{enabled:true,paired:true}} },
    async disable(payload) { remembered = false; enabled = false; calls.push(['disable',payload]); return {success:true} },
    async forget(payload) { remembered = false; enabled = false; calls.push(['forget',payload]); return {success:true} },
    async publish(payload) { calls.push(['publish',payload]); return {success:true} },
    async reply(payload) { calls.push(['reply',payload]); return {success:true} },
    async decideNative(payload) { calls.push(['decideNative',payload]); return {success:true} },
  }
  const options = {scopeKey:'project:provider:chat',chatId:'chat',model:'model',messages:[],models:[],projectName:'Synthetic',provider:'codex',
    visible:false,settingsOpen:true,busy:false,loading:false,exportBusy:false,isCurrent:() => true,
    async onSend(text) { calls.push(['send',text]); return {success:true,status:'completed'} },
    onModels:async () => {},onModel(value) { options.model = value; rerender = true },onAccess(mode,bundle) { calls.push(['access',mode,bundle]) },
    onApproval:async (id,approved) => { calls.push(['approval',id,approved]); return {success:true,status:'completed'} },onStop:() => calls.push(['stop']) }
  const captureApi = { async capture(payload) { calls.push(['capture',payload]); return {success:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='} } }
  const module = {exports:{}}
  vm.runInNewContext(code,{module,exports:module.exports,crypto:{randomUUID},window:{electronAPI:{mobileCompanion:api,
    connectedAgent:captureApi }},
    require(name) {
      if (name === 'react') return react
      if (name.endsWith('.css')) return {}
      if (name.includes('connectedAgentContext')) return {redactConnectedAgentText:text => text}
      if (name.includes('connectedAgentReceipts')) return receiptsModule.exports
      if (name.includes('mobileCompanionProjectAdapter')) return {mobileProjects:{list:async () => [{id:'project',name:'Synthetic',current:true}],open:async () => {}}}
      if (name.includes('projectDirtyTracker')) return {isProjectDirty:() => false}
      throw Error(name)
    },setInterval(fn) { const id = randomUUID(); intervals.set(id,fn); return id },clearInterval:id => intervals.delete(id)})
  function render() { index = 0; rerender = false; result = module.exports.useMobileCompanion({ ...options }); const next = effects; effects = []; next.forEach(fn => fn()) }
  async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (rerender) render() } }
  render()
  return {calls,options,api,captureApi,flush,render,publish:async () => { for (const tick of intervals.values()) await tick() },emit:event => listener(event),get result() { return result },
    context:() => [...calls].reverse().find(([kind]) => kind === 'attach')?.[1].snapshot.contextId,
    async command(command) { listener({type:'command',scope:[...calls].reverse().find(([kind]) => kind === 'attach')[1].scope,command}); await flush() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}
test('computer label uses remembered native metadata, keeps drafts stable, and clears drafts for a new scope', async () => {
  const f = fixture(); await f.flush();
  assert.equal(f.result.computerName, 'My computer');
  f.emit({ type: 'status', status: { enabled: false, guided: { computerName: 'Creator desktop' } } }); await f.flush();
  assert.equal(f.result.computerName, 'Creator desktop');
  f.result.setComputerName('My edit'); await f.flush();
  f.emit({ type: 'status', status: { enabled: false, guided: { computerName: 'Creator desktop' } } }); await f.flush();
  assert.equal(f.result.computerName, 'My edit');
  f.result.setComputerName(null); await f.flush();
  assert.equal(f.result.computerName, 'Creator desktop');
  f.result.setComputerName('Unsaved rename'); await f.flush();
  f.options.scopeKey = 'another-project:provider:chat'; f.render(); await f.flush();
  assert.notEqual(f.result.computerName, 'Unsaved rename');
  f.emit({ type: 'status', status: { enabled: false, guided: { computerName: { token: 'invalid' } } } }); await f.flush();
  assert.equal(f.result.computerName, 'My computer');
  f.unmount();
});

test('phone capability flags distinguish hosted-only packaged builds from older native builds', async () => {
  for (const [preference, expected] of [
    [{ available: true, guidedAvailable: true, legacyAvailable: false }, { available: true, guidedAvailable: true, legacyAvailable: false }],
    [{ available: true, guidedAvailable: true, legacyAvailable: true }, { available: true, guidedAvailable: true, legacyAvailable: true }],
    [{ available: true }, { available: true, guidedAvailable: false, legacyAvailable: true }],
    [{}, { available: false, guidedAvailable: false, legacyAvailable: false }],
  ]) {
    const f = fixture({ preference }); await f.flush()
    for (const [key, value] of Object.entries(expected)) assert.equal(f.result[key], value, key)
    assert.equal(f.calls.some(([kind]) => ['enable', 'send', 'access'].includes(kind)), false)
    f.unmount()
  }
})
test('phone send works while desktop chat is hidden and does not require a desktop accept',async () => {
  const f = fixture(); await f.flush(); await f.result.enable(); await f.flush()
  await f.command({id:'send-1',kind:'message',contextId:f.context(),text:'Review this shot.'})
  assert.deepEqual(f.calls.find(([kind]) => kind === 'send'),['send','Review this shot.'])
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'reply').map(([,p]) => p.result.status),['accepted','completed'])
  f.unmount(); assert.equal(f.calls.some(([kind]) => kind === 'disable'),false)
  assert.ok(f.calls.some(([kind]) => kind === 'detach'))
})
test('model changes attach a fresh context while preserving window pairing, old commands are rejected',async () => {
  const f = fixture(); await f.flush(); await f.result.enable(); await f.flush()
  const oldContext = f.context(), oldScope = f.calls.find(([kind]) => kind === 'attach')[1].scope
  await f.command({id:'model-1',kind:'model',contextId:oldContext,model:'another-model'})
  assert.notEqual(f.context(),oldContext)
  assert.equal(f.calls.filter(([kind]) => kind === 'attach').at(-1)[1].scope,oldScope)
  await f.command({id:'stale',kind:'message',contextId:oldContext,text:'Do not send'})
  assert.equal(f.calls.some(([kind]) => kind === 'send'),false)
  assert.equal(f.calls.filter(([kind,p]) => kind === 'reply' && p.id === 'stale').at(-1)[1].result.success,false)
  f.unmount()
})
test('phone chat navigation projects metadata only, works hidden and completes across context rotation without replay', async () => {
  const f = fixture(); await f.flush()
  f.options.chats = [{ id: 'other', title: 'Other chat', provider: 'lmstudio', updatedAt: 123, current: false, messages: ['private'], path: '/private' }]
  f.options.onNewChat = () => { f.calls.push(['new-chat']); return { success: true, status: 'completed' } }
  f.options.onSelectChat = (id, provider) => {
    f.calls.push(['select-chat', id, provider]); f.options.scopeKey = `project:${provider}:${id}`; f.options.chatId = id; f.options.provider = provider
    f.render(); return { success: true, status: 'completed' }
  }
  f.render(); await f.result.enable(); await f.flush()
  const snapshot = f.calls.find(([kind]) => kind === 'enable')[1].snapshot
  assert.equal(snapshot.chatNavigation, true)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.chats)), [{ id: 'other', title: 'Other chat', provider: 'lmstudio', updatedAt: 123, current: false }])
  const context = f.context(), command = { id: 'select', kind: 'chat', contextId: context, chatId: 'other', provider: 'lmstudio' }
  await f.command(command)
  assert.notEqual(f.context(), context)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'select-chat'), [['select-chat', 'other', 'lmstudio']])
  assert.deepEqual(f.calls.filter(([kind, p]) => kind === 'reply' && p.id === 'select').map(([, p]) => p.result.status), ['accepted', 'completed'])
  await f.command(command)
  assert.equal(f.calls.filter(([kind]) => kind === 'select-chat').length, 1)
  await f.command({ id: 'new', kind: 'new-chat', contextId: f.context() })
  await f.command({ id: 'new', kind: 'new-chat', contextId: f.context() })
  assert.equal(f.calls.filter(([kind]) => kind === 'new-chat').length, 1)
  assert.equal(f.calls.some(([kind]) => kind === 'send' || kind === 'approval' || kind === 'access'), false)
  f.unmount()
})

test('phone chat navigation rechecks busy state and context after native acceptance', async () => {
  const f = fixture(); await f.flush()
  f.options.onNewChat = () => f.calls.push(['new-chat'])
  f.options.busy = true; f.render()
  await f.command({ id: 'busy-new', kind: 'new-chat', contextId: f.context() })
  assert.equal(f.calls.some(([kind]) => kind === 'new-chat'), false)
  f.options.busy = false; f.render()
  const reply = f.api.reply
  f.api.reply = async payload => {
    const result = await reply(payload)
    if (payload.result.status === 'accepted') { f.options.scopeKey = 'another-project'; f.render() }
    return result
  }
  await f.command({ id: 'changed-after-ack', kind: 'new-chat', contextId: f.context() })
  assert.equal(f.calls.some(([kind]) => kind === 'new-chat'), false)
  assert.equal(f.calls.filter(([kind]) => kind === 'reply').at(-1)[1].result.success, false)
  f.unmount()
})
test('phone thinking changes update the one desktop setting and rotate context without sending a model request', async () => {
  const f = fixture()
  f.options.reasoningEffort = 'medium'
  f.options.reasoningOptions = [{ id: 'low', label: 'Light' }, { id: 'medium', label: 'Medium' }]
  f.options.onReasoning = effort => { f.options.reasoningEffort = effort; f.render() }
  f.render(); await f.flush(); await f.result.enable(); await f.flush()
  const previous = f.context()
  await f.command({ id: 'thinking-one', kind: 'reasoning', contextId: previous, effort: 'low' })
  assert.equal(f.options.reasoningEffort, 'low')
  assert.notEqual(f.context(), previous)
  const snapshot = f.calls.filter(([kind]) => kind === 'attach').at(-1)[1].snapshot
  assert.equal(snapshot.reasoningEffort, 'low')
  assert.equal(snapshot.reasoningOptions.length, 2)
  await f.command({ id: 'stale-thinking', kind: 'reasoning', contextId: previous, effort: 'medium' })
  assert.equal(f.options.reasoningEffort, 'low')
  assert.equal(f.calls.some(([kind]) => kind === 'send'), false)
  f.unmount()
})
test('approval and stop are routed during phone work, ordinary commands are blocked',async () => {
  const f = fixture(); await f.flush(); f.options.busy = true; f.options.phoneRequest = true; f.render(); await f.flush()
  await f.command({id:'approve',kind:'approval',contextId:f.context(),approvalId:'approval',approved:true})
  assert.ok(f.calls.some(([kind]) => kind === 'approval'))
  await f.command({id:'stop',kind:'stop',contextId:f.context()}); assert.ok(f.calls.some(([kind]) => kind === 'stop'))
  await f.command({id:'message',kind:'message',contextId:f.context(),text:'Second message'})
  assert.equal(f.calls.some(([kind]) => kind === 'send'),false)
  f.unmount()
})

test('phone full-access command waits for native confirmation instead of reporting premature success', async () => {
  const f = fixture(); await f.flush(); await f.result.enable(); await f.flush()
  let resolve
  f.options.onAccess = () => new Promise(done => { resolve = done })
  f.render()
  await f.command({ id: 'full-access', kind: 'access', contextId: f.context(), mode: 'full' })
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'reply').map(([,p]) => p.result.status), ['accepted'])
  f.emit({ type: 'native-approvals', approvals: [{ approvalId: 'native', reviewToken: 'once', title: 'Full access?' }] })
  await f.flush(); assert.equal(f.result.nativeApprovals.length, 1)
  await f.result.decideNative(f.result.nativeApprovals[0], false, false)
  assert.equal(f.calls.find(([kind]) => kind === 'decideNative')[1].approved, false)
  resolve({ success: false, error: 'Full access declined.' }); await f.flush()
  assert.equal(f.calls.filter(([kind]) => kind === 'reply').at(-1)[1].result.success, false)
  f.unmount()
})

test('phone publishes the shared permission state and can stop desktop-origin work', async () => {
  const f = fixture(); await f.flush()
  Object.assign(f.options, { fullAccess: true, researchEnabled: true, spendingPolicy: 'ask-cloud' })
  f.render(); await f.result.enable(); await f.flush()
  const snapshot = f.calls.find(([kind]) => kind === 'enable')[1].snapshot
  assert.equal(snapshot.protocol, 3); assert.equal(snapshot.fullAccess, true)
  assert.equal(snapshot.researchEnabled, true); assert.equal(snapshot.spendingPolicy, 'ask-cloud')
  f.options.busy = true; f.options.phoneRequest = false; f.render(); await f.flush()
  await f.command({ id: 'stop-desktop', kind: 'stop', contextId: f.context() })
  assert.ok(f.calls.some(([kind]) => kind === 'stop'))
  f.unmount()
})

test('chat review stills follow Share images, independently of desktop preview consent', async () => {
  const f = fixture(); await f.flush(); await f.result.enable(); await f.flush()
  const shown = []
  f.options.reviews = [{id:'review-current',label:'Timeline frame',dataUrl:'data:image/jpeg;base64,/9j/2Q==',capturedAt:Date.now(),timeSeconds:1.5}]
  f.options.onShowReview = id => {shown.push(id);return {success:true,status:'completed'}}
  f.render(); await f.publish()
  const reviews = () => f.calls.filter(([kind])=>kind==='publish').at(-1)[1].snapshot.reviews
  assert.equal(reviews().length,0)
  await f.command({id:'denied-review',kind:'show-review',reviewId:'review-current',contextId:f.context()})
  assert.equal(shown.length,0)
  // Full access includes workspace previews, but hidden/settings UI still
  // cannot capture a workspace. Chat attachments do not depend on visibility.
  f.options.fullAccess = true; f.options.shareReviewImages = true
  f.render();await f.flush();await f.publish()
  assert.equal(f.result.sharePreview,true)
  assert.equal(reviews().length,1)
  assert.equal(f.calls.filter(([kind])=>kind==='publish').at(-1)[1].snapshot.preview,null)
  await f.command({id:'show-review',kind:'show-review',reviewId:'review-current',contextId:f.context()})
  assert.deepEqual(shown,['review-current'])
  f.result.setSharePreview(true);await f.flush();await f.publish()
  assert.equal(reviews().length,1)
  f.result.setSharePreview(false);await f.flush();await f.publish()
  assert.equal(reviews().length,1,'Turning off workspace previews does not hide chat attachments')
  f.options.shareReviewImages = false;f.render();await f.flush();await f.publish()
  assert.equal(reviews().length,0)
  await f.command({id:'revoked-review',kind:'show-review',reviewId:'review-current',contextId:f.context()})
  assert.deepEqual(shown,['review-current'])
  f.unmount()
})

test('review images remain bounded and require an enabled phone connection, not just full access', async () => {
  const f = fixture(); await f.flush()
  f.options.fullAccess = true
  f.options.reviews = Array.from({length:14},(_,i)=>({id:`review-${i}`,turnId:`turn-${i}`,dataUrl:'x'.repeat(250000)}))
  f.render();await f.result.enable();await f.flush();await f.publish()
  const reviews = () => f.calls.filter(([kind])=>kind==='publish').at(-1)[1].snapshot.reviews
  assert.equal(reviews().length,0,'Full access alone is not an image-sharing receipt')
  f.options.shareReviewImages = true;f.render();await f.flush();await f.publish()
  assert.equal(JSON.stringify(reviews().map(frame=>frame.id)),JSON.stringify(['review-8','review-9','review-10','review-11','review-12','review-13']))
  assert.equal(reviews().at(-1).turnId,'turn-13')
  await f.result.disable();await f.flush()
  const before = f.calls.filter(([kind])=>kind==='publish').length
  await f.publish()
  assert.equal(f.calls.filter(([kind])=>kind==='publish').length,before,'Disconnect stops all image publication')
  f.unmount()
})

test('phone receives current public activity without command output; heartbeat preserves its update time', async () => {
  const f = fixture(); await f.flush(); await f.result.enable(); await f.flush()
  f.options.busy = true
  f.options.liveActivity = [
    {id:'p',kind:'progress',status:'completed',text:'Checking the shot boundaries.'},
    {id:'t',kind:'tool',status:'running',toolName:'Shell command',summary:'do not publish command',output:'do not publish output'},
  ]
  f.render(); await f.publish()
  const latest = () => f.calls.filter(([kind]) => kind === 'publish').at(-1)[1].snapshot.activity
  assert.equal(latest().items.length,2); assert.equal(latest().items[0].text,'Checking the shot boundaries.')
  assert.equal(latest().items[1].status,'running'); assert.equal(latest().items[1].summary,'')
  assert.doesNotMatch(JSON.stringify(latest()),/do not publish/)
  const timestamp = latest().updatedAt; assert.ok(timestamp > 0)
  await f.publish(); assert.equal(latest().updatedAt,timestamp)
  f.options.liveActivity = [{...f.options.liveActivity[1],status:'failed'}]; f.render(); await f.publish()
  assert.equal(latest().items[0].status,'failed')
  f.options.liveActivity = []; f.render(); await f.publish()
  assert.equal(latest().items.length,0); assert.equal(latest().updatedAt,0)
  f.unmount()
})

test('phone publishes restored per-turn tool receipts and request status without replaying or exposing private fields', async () => {
  const f = fixture(); await f.flush(); await f.result.enable(); await f.flush()
  const toolReceipts = { version: 1, omitted: 0, entries: [{
    id: 'agent-receipt-11111111-1111-4111-8111-111111111111', toolName: 'edit_trim', outcome: 'applied',
    output: 'private result', arguments: 'private arguments', reasoning: 'private thought',
  }] }
  f.options.messages = [
    { role: 'user', turnId: 'trim-turn', text: 'Trim this shot.', deliveryStatus: 'reply-unavailable', toolReceipts },
    { role: 'assistant', turnId: 'trim-turn', text: 'A final reply was not provided.', deliveryStatus: 'reply-unavailable', toolReceipts },
    { role: 'assistant', turnId: 'failed-turn', text: 'The request stopped.', deliveryStatus: 'failed', toolReceipts: { ...toolReceipts, entries: [{ ...toolReceipts.entries[0], outcome: 'unconfirmed' }] } },
    { role: 'assistant', turnId: 'ordinary-turn', text: 'A normal reply.', deliveryStatus: 'pretend-status', toolReceipts: { version: 99, entries: [] } },
  ]
  f.render(); await f.publish()
  const latest = () => f.calls.filter(([kind]) => kind === 'publish').at(-1)[1].snapshot.messages
  const messages = JSON.parse(JSON.stringify(latest()))
  assert.deepEqual(messages[0], { role: 'user', turnId: 'trim-turn', text: 'Trim this shot.' })
  assert.equal(messages[1].deliveryStatus, 'reply-unavailable')
  assert.deepEqual(messages[1].toolReceipts, { version: 1, omitted: 0, entries: [{ id: toolReceipts.entries[0].id, toolName: 'edit_trim', outcome: 'applied' }] })
  assert.equal(messages[2].deliveryStatus, 'failed')
  assert.equal(messages[2].toolReceipts.entries[0].outcome, 'unconfirmed')
  assert.deepEqual(messages[3], { role: 'assistant', turnId: 'ordinary-turn', text: 'A normal reply.' })
  assert.doesNotMatch(JSON.stringify(messages), /private|arguments|reasoning|output/)
  await f.publish()
  assert.deepEqual(JSON.parse(JSON.stringify(latest())), messages)
  assert.equal(f.calls.some(([kind]) => kind === 'send'), false)
  f.unmount()
})

test('remembered phone restores while hidden without an enable dialog or command replay', async () => {
  const f = fixture({ remembered: true }); await f.flush()
  assert.equal(f.result.enabled, true)
  assert.equal(f.calls.some(([kind]) => ['enable', 'send', 'access'].includes(kind)), false)
  await f.result.disable(); await f.flush()
  const attaches = f.calls.filter(([kind]) => kind === 'attach').length
  await f.publish(); await f.flush()
  assert.equal(f.result.enabled, false)
  assert.equal(f.calls.filter(([kind]) => kind === 'attach').length, attaches, 'Stop is not undone by retries')
  f.unmount()
})

test('startup readiness retry reattaches only remembered sharing and never resends a command', async () => {
  const f = fixture({ remembered: true, initiallyReady: false }); await f.flush()
  assert.equal(f.result.enabled, false)
  f.options.loading = true; f.api.ready = true; f.render()
  await f.publish(); await f.flush()
  assert.equal(f.result.enabled, false, 'Wait for fresh project context')
  f.options.loading = false; f.render(); await f.publish(); await f.flush()
  assert.equal(f.result.enabled, true)
  assert.equal(f.calls.some(([kind]) => ['enable', 'send', 'access'].includes(kind)), false)
  await f.result.forget(); await f.flush(); await f.publish(); await f.flush()
  assert.equal(f.result.enabled, false)
  f.unmount()
})

test('failed publication recovers from fresh native attach without repeating accepted work', async () => {
  const f = fixture({ remembered: true }); await f.flush()
  await f.command({id:'one-send',kind:'message',contextId:f.context(),text:'Read the timeline.'})
  f.api.publish = async () => { throw Error('Restart') }
  await f.publish(); await f.flush(); assert.equal(f.result.enabled, false)
  f.api.publish = async () => ({success:true})
  await f.publish(); await f.flush(); assert.equal(f.result.enabled, true)
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1)
  f.unmount()
})

test('phone bundle forwards its version and publishes only the completed bundle marker', async () => {
  const f = fixture({remembered:true}); await f.flush()
  await f.command({id:'bundle',kind:'access',mode:'full',bundleVersion:1,contextId:f.context()})
  assert.equal(f.calls.find(([kind])=>kind==='access')[2].bundleVersion,1)
  f.options.fullAccess = true; f.options.fullAccessBundleVersion = 1; f.render(); await f.publish()
  assert.equal(f.calls.filter(([kind])=>kind==='publish').at(-1)[1].snapshot.fullAccessBundleVersion,1)
  f.unmount()
})

test('full access includes visible workspace sharing even with Agent hidden; unrelated tabs are not captured', async () => {
  const f = fixture({remembered:true}); await f.flush()
  Object.assign(f.options,{fullAccess:true,activeTab:'editor',visible:true,settingsOpen:false,
    workspaceRef:{current:{getBoundingClientRect:()=>({x:0,y:0,width:400,height:200})}}})
  f.render(); await f.flush()
  assert.equal(f.result.sharePreview,true)
  assert.equal(f.calls.filter(([kind])=>kind==='capture').length,1)
  f.options.visible=false; f.render(); await f.result.capture()
  assert.equal(f.calls.filter(([kind])=>kind==='capture').length,2,'Hidden Agent does not hide the actual Editor')
  f.options.activeTab='generate'; f.render(); await f.flush(); await f.result.capture()
  assert.equal(f.calls.filter(([kind])=>kind==='capture').length,2)
  f.options.visible=true; f.options.fullAccess=false; f.render(); await f.flush(); await f.result.capture()
  assert.equal(f.result.sharePreview,false)
  assert.equal(f.result.preview,null)
  assert.equal(f.calls.filter(([kind])=>kind==='capture').length,2)
  f.unmount()
})

test('explicit settings refresh captures only the workspace while automatic and phone preview remain blocked there', async () => {
  for (const activeTab of ['editor', 'storyboard']) {
    const f = fixture({ remembered: true }); await f.flush()
    Object.assign(f.options, { fullAccess: true, activeTab, visible: true, settingsOpen: true,
      workspaceRef: { current: { getBoundingClientRect: () => ({ x: 11.2, y: 20.4, width: 640.8, height: 359.7 }) } } })
    f.render(); await f.flush()
    assert.equal(f.calls.filter(([kind]) => kind === 'capture').length, 0, 'Opening settings never captures automatically')
    assert.equal((await f.result.capture()).success, false)
    await f.command({ id: `phone-preview-${activeTab}`, kind: 'preview', contextId: f.context() })
    assert.equal(f.calls.filter(([kind]) => kind === 'reply').at(-1)[1].result.success, false)
    assert.equal(f.calls.filter(([kind]) => kind === 'capture').length, 0, 'Phone cannot bypass the settings capture guard')
    assert.equal((await f.result.refreshPreview()).success, true)
    await f.flush()
    const captures = f.calls.filter(([kind]) => kind === 'capture')
    assert.equal(captures.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(captures[0][1])), { rect: { x: 12, y: 21, width: 640, height: 359 } })
    assert.equal(f.result.preview.workspace, activeTab)
    f.unmount()
  }
})

test('explicit preview refresh retains consent, active-work and visible-workspace checks', async () => {
  for (const condition of ['no-consent', 'busy', 'loading', 'exportBusy', 'other-tab', 'no-workspace', 'hidden-workspace']) {
    const f = fixture({ remembered: true }); await f.flush()
    Object.assign(f.options, { fullAccess: true, activeTab: 'editor', visible: true, settingsOpen: true,
      workspaceRef: { current: { getBoundingClientRect: () => ({ x: 0, y: 0, width: 640, height: 360 }) } } })
    if (condition === 'no-consent') f.options.fullAccess = false
    else if (condition === 'other-tab') f.options.activeTab = 'generate'
    else if (condition === 'no-workspace') f.options.workspaceRef.current = null
    else if (condition === 'hidden-workspace') f.options.workspaceRef.current.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 })
    else f.options[condition] = true
    f.render(); await f.flush()
    const result = await f.result.refreshPreview(); await f.flush()
    assert.equal(result.success, false, condition)
    assert.equal(f.calls.some(([kind]) => kind === 'capture'), false, condition)
    assert.equal(f.result.preview, null, condition)
    assert.ok(f.result.notice, `${condition} gives feedback in settings`)
    f.unmount()
  }
})

test('explicit refresh discards an image when the desktop changes while native capture is pending', async () => {
  for (const change of ['context', 'settings', 'loading', 'busy', 'exportBusy', 'consent', 'tab', 'bounds', 'target']) {
    const f = fixture({ remembered: true }); await f.flush()
    const bounds = { x: 0, y: 0, width: 640, height: 360 }
    Object.assign(f.options, { fullAccess: true, activeTab: 'editor', visible: true, settingsOpen: true,
      workspaceRef: { current: { getBoundingClientRect: () => ({ ...bounds }) } } })
    f.render(); await f.flush()
    let resolveCapture
    f.captureApi.capture = payload => { f.calls.push(['capture', payload]); return new Promise(resolve => { resolveCapture = resolve }) }
    const refreshing = f.result.refreshPreview()
    assert.equal(typeof resolveCapture, 'function', change)
    if (change === 'context') f.options.scopeKey = 'other-project'
    else if (change === 'settings') f.options.settingsOpen = false
    else if (change === 'consent') f.options.fullAccess = false
    else if (change === 'tab') f.options.activeTab = 'storyboard'
    else if (change === 'bounds') bounds.width = 600
    else if (change === 'target') f.options.workspaceRef = { current: { getBoundingClientRect: () => ({ ...bounds }) } }
    else f.options[change] = true
    f.render(); await f.flush()
    resolveCapture({ success: true, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' })
    const result = await refreshing; await f.flush()
    assert.equal(result.success, false, change)
    assert.equal(f.result.preview, null, change)
    f.unmount()
  }
})

test('desktop mirror sends local trust only for an eligible approved native card', async () => {
  const f = fixture({remembered:true}); await f.flush()
  const approval={approvalId:'trust',reviewToken:'one',allowLocalTrust:true}
  await f.result.decideNative(approval,true,true,true)
  await f.result.decideNative(approval,false,true,true)
  await f.result.decideNative({...approval,allowLocalTrust:false},true,true,true)
  const decisions=f.calls.filter(([kind])=>kind==='decideNative').map(([,payload])=>payload)
  assert.equal(decisions[0].trustLocal,true)
  assert.equal(Object.hasOwn(decisions[1],'trustLocal'),false)
  assert.equal(Object.hasOwn(decisions[2],'trustLocal'),false)
  f.unmount()
})

test('native decision failures remain actionable after the approval disappears and can be dismissed', async () => {
  for (const failure of ['result', 'throw']) {
    const f = fixture({ remembered: true }); await f.flush()
    const approval = { approvalId: 'paid-generation', reviewToken: 'one', title: 'Approve generation?' }
    f.emit({ type: 'native-approvals', approvals: [approval] }); await f.flush()
    f.api.decideNative = async payload => {
      f.calls.push(['decideNative', payload])
      if (failure === 'throw') throw Error('The approval connection was lost.')
      return { success: false, error: 'This approval expired.' }
    }
    await f.result.decideNative(approval, true, false); await f.flush()
    assert.match(f.result.requestError, /approval/)
    f.emit({ type: 'native-approvals', approvals: [] }); await f.flush()
    assert.equal(f.result.nativeApprovals.length, 0)
    assert.ok(f.result.requestError, 'Removing the completed card does not swallow its failure')
    f.emit({ type: 'status', status: { enabled: false } }); await f.flush()
    assert.equal(f.result.enabled, false)
    assert.ok(f.result.requestError, 'A disconnected phone still leaves actionable feedback')
    f.result.dismissRequestError(); await f.flush()
    assert.equal(f.result.requestError, '')
    f.unmount()
  }
})

test('failed legacy phone decisions keep feedback when the pending message is cleared', async () => {
  for (const failure of ['accept-ack', 'decline-ack', 'send-throw', 'send-result']) {
    const f = fixture({ remembered: true }); await f.flush()
    Object.assign(f.options, { visible: true, settingsOpen: false }); f.render(); await f.flush()
    const scope = f.calls.find(([kind]) => kind === 'attach')[1].scope
    f.emit({ type: 'message', id: 'pending-message', scope, text: 'Review this shot.' }); await f.flush()
    assert.equal(f.result.pending.id, 'pending-message')
    if (failure === 'send-throw') f.options.onSend = async () => { throw Error('The model request failed.') }
    else if (failure === 'send-result') f.options.onSend = async () => ({ success: false, error: 'The desktop is busy. No message was sent.' })
    else f.api.reply = async payload => { f.calls.push(['reply', payload]); return { success: false, error: 'This phone request expired.' } }
    f.render(); await f.result.decide(failure !== 'decline-ack'); await f.flush()
    assert.equal(f.result.pending, null)
    assert.ok(f.result.requestError, failure)
    assert.equal(f.result.notice, f.result.requestError)
    f.options.scopeKey = 'another-project'; f.render(); await f.flush()
    assert.equal(f.result.requestError, '', 'A new context does not inherit another conversation’s error')
    f.unmount()
  }
})

test('a stale native decision failure does not appear in the new conversation', async () => {
  const f = fixture({ remembered: true }); await f.flush()
  let resolveDecision
  f.api.decideNative = () => new Promise(resolve => { resolveDecision = resolve })
  const deciding = f.result.decideNative({ approvalId: 'old-approval', reviewToken: 'once' }, true, false)
  f.options.scopeKey = 'new-project:provider:chat'; f.render(); await f.flush()
  resolveDecision({ success: false, error: 'An old approval expired.' }); await deciding; await f.flush()
  assert.equal(f.result.requestError, '')
  assert.equal(f.result.notice, '')
  f.unmount()
})

test('pausing phone sharing preserves the native linked account status', async () => {
  const f = fixture({ remembered: true }); await f.flush()
  const status = { enabled: false, guided: { registered: true, enabled: false, account: { displayName: 'Fixture Account' } } }
  const disable = f.api.disable
  f.api.disable = async payload => ({ ...await disable(payload), status })
  await f.result.disable(); await f.flush()
  assert.equal(f.result.enabled, false)
  assert.equal(f.result.connection.guided.registered, true)
  assert.equal(f.result.connection.guided.account.displayName, 'Fixture Account')
  f.unmount()
})

test('account mutations recheck busy/export scope, latch duplicate clicks and ignore stale completion', async () => {
  const f = fixture(); await f.flush()
  const pending = []
  f.api.connectPhoneAccount = payload => { f.calls.push(['account-connect', payload]); return new Promise(resolve => pending.push(resolve)) }
  f.api.disconnectPhoneAccount = payload => { f.calls.push(['account-disconnect', payload]); return new Promise(resolve => pending.push(resolve)) }
  f.api.disconnectPhoneDevice = payload => { f.calls.push(['device-disconnect', payload]); return new Promise(resolve => pending.push(resolve)) }
  f.api.manageDesktopAccount = payload => { f.calls.push(['account-action', payload]); return new Promise(resolve => pending.push(resolve)) }
  for (const blocked of ['busy', 'loading', 'exportBusy']) {
    f.options[blocked] = true; f.render()
    await f.result.connectPhoneAccount(); await f.result.disconnectPhoneAccount(); await f.result.disconnectPhoneDevice('phone')
    await f.result.manageDesktopAccount('sign-out'); await f.result.manageDesktopAccount('switch-account')
    f.options[blocked] = false; f.render()
  }
  assert.equal(f.calls.some(([kind]) => /account-|device-/.test(kind)), false)
  const connecting = f.result.connectPhoneAccount()
  await f.result.connectPhoneAccount(); await f.result.disconnectPhoneAccount(); await f.result.disconnectPhoneDevice('phone')
  assert.equal(f.calls.filter(([kind]) => kind === 'account-connect').length, 1)
  pending.shift()({ success: true, status: { enabled: true, guided: { registered: true } } }); await connecting; await f.flush()
  const disconnecting = f.result.disconnectPhoneAccount()
  await f.result.disconnectPhoneAccount()
  assert.equal(f.calls.filter(([kind]) => kind === 'account-disconnect').length, 1)
  f.options.scopeKey = 'different-project'; f.render(); await f.flush()
  const currentStatus = f.result.connection
  pending.shift()({ success: true, status: { stale: true } }); await disconnecting; await f.flush()
  assert.equal(f.result.connection, currentStatus)
  const switching = f.result.manageDesktopAccount('switch-account')
  await f.result.manageDesktopAccount('switch-account'); await f.result.manageDesktopAccount('sign-out')
  assert.equal(f.calls.filter(([kind]) => kind === 'account-action').length, 1)
  const payload = f.calls.find(([kind]) => kind === 'account-action')[1]
  assert.equal(payload.action, 'switch-account'); assert.ok(payload.snapshot.contextId)
  pending.shift()({ success: true, cancelled: true, status: currentStatus }); await switching; await f.flush()
  assert.equal(f.result.notice, '')
  f.unmount()
})
