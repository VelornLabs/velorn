import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAgentToolReceipts, sanitizeAgentLocalDiagnostics, missingAgentReplyText,
  receiptOutcomeLabel, agentStatusMessage } from './connectedAgentReceipts.mjs'
import { sanitizeConnectedAgentMessages } from './connectedAgentContext.mjs'
import { createConnectedAgentConversationStore } from './connectedAgentConversations.mjs'

const entry = (n, outcome = 'applied') => ({ id: `agent-receipt-00000000-0000-0000-0000-${String(n).padStart(12,'0')}`, toolName: 'edit_trim', outcome })
const receipts = (entries = [entry(1)]) => ({ version: 1, entries, omitted: 0 })
const diagnostics = [{ prediction: 1, finishReason: 'stop', publicContentChars: 0, parsedToolCalls: 0,
  promptTokens: 300, completionTokens: 10, answerRecovery: false }]

test('receipt projection keeps only canonical bounded metadata and the latest entries', () => {
  assert.equal(sanitizeAgentToolReceipts(null), undefined)
  assert.equal(sanitizeAgentToolReceipts({ version: 2, entries: [] }), undefined)
  assert.equal(sanitizeAgentToolReceipts(receipts([])), undefined)
  const clean = sanitizeAgentToolReceipts(receipts([
    { ...entry(1), arguments: { path: '/private/file' }, text: 'raw tool output', reasoning: 'private' },
    entry(1), { ...entry(2), outcome: 'success' }, { ...entry(3), outcome: ['applied'] },
    { ...entry(4), toolName: 'file:///private/tool' }, { ...entry(5), id: 'agent-receipt-' + '-'.repeat(36) },
  ]))
  assert.deepEqual(clean, { ...receipts(), omitted: 5 })
  const many = sanitizeAgentToolReceipts(receipts(Array.from({length: 70}, (_, i) => entry(i + 1, 'read'))))
  assert.equal(many.entries.length, 40)
  assert.equal(many.entries[0].id, entry(31).id)
  assert.equal(many.omitted, 30)
  assert.equal(sanitizeAgentToolReceipts({ ...receipts(), omitted: Number.MAX_SAFE_INTEGER }).omitted, 1000000)
  assert.equal(receiptOutcomeLabel('__proto__'), 'Outcome unconfirmed')
})

test('status wording does not turn preview, read, denial, uncertainty or omission into applied work', () => {
  for (const outcome of ['preview','read','no-change','returned','denied','failed','unconfirmed']) {
    assert.doesNotMatch(missingAgentReplyText(receipts([entry(1,outcome)])), /recorded \d+ applied/)
  }
  assert.match(missingAgentReplyText(receipts()), /recorded 1 applied action/)
  assert.match(missingAgentReplyText(receipts()), /do not confirm that the entire request finished/)
  assert.match(missingAgentReplyText(undefined), /No verified tool receipts/)
  assert.match(missingAgentReplyText(receipts()), /No tool actions were automatically retried/)
  for (const deliveryStatus of ['failed','reply-unavailable']) {
    assert.equal(agentStatusMessage({role:'assistant',deliveryStatus}), true)
    assert.equal(agentStatusMessage({role:'user',deliveryStatus}), false)
  }
})

test('diagnostics store counts and stop reasons only, with no free-form provider content', () => {
  const clean = sanitizeAgentLocalDiagnostics([{...diagnostics[0], content:'private text', reasoning:'private thought', error:'private error'},
    diagnostics[0], {...diagnostics[0], prediction:2, finishReason:'private', promptTokens:-1, completionTokens:Infinity},
    {...diagnostics[0], prediction:15}])
  assert.equal(clean.length,3)
  assert.deepEqual(clean[0], diagnostics[0])
  assert.equal(clean[1].finishReason,'unknown')
  assert.equal(clean[1].promptTokens,null)
  assert.equal(clean[1].completionTokens,null)
  assert.equal(clean[2].prediction,15, 'Diagnostic retention does not limit prediction indexes')
  assert.doesNotMatch(JSON.stringify(clean), /private|reasoning|error/)
})

test('bounded latest final-summary recovery metadata survives native and saved-renderer projection', async () => {
  const { default: native } = await import('../../electron/connectedAgentLocalDiagnostics.cjs')
  const source = Array.from({length:1000},(_,i)=>({...diagnostics[0],prediction:i+1,
    parsedToolCalls:i === 999 ? 1000000 : 49,answerRecovery:i===999}))
  const expected = source.slice(-14)
  assert.deepEqual(native.sanitizeLocalDiagnostics(source),expected)
  assert.deepEqual(sanitizeAgentLocalDiagnostics(source),expected)
  const message = sanitizeConnectedAgentMessages([{role:'assistant',text:'Final reply unavailable.',deliveryStatus:'reply-unavailable',localDiagnostics:source}])[0]
  assert.deepEqual(message.localDiagnostics,expected)
  assert.equal(message.localDiagnostics.at(-1).answerRecovery,true)
  assert.deepEqual(message.localDiagnostics.map(item=>item.prediction),Array.from({length:14},(_,i)=>987+i))
  assert.deepEqual(sanitizeAgentLocalDiagnostics(message.localDiagnostics),expected, 'Repeated history projection is idempotent')
})

test('renderer and native diagnostics agree on positive indexes and all numeric/enum boundaries', async () => {
  const { default: native } = await import('../../electron/connectedAgentLocalDiagnostics.cjs')
  const parity = value => assert.deepEqual(sanitizeAgentLocalDiagnostics(value) || [],native.sanitizeLocalDiagnostics(value))
  for (const prediction of [1,14,15,81,Number.MAX_SAFE_INTEGER]) {
    const source = [{...diagnostics[0],prediction}]
    parity(source)
    assert.equal(sanitizeAgentLocalDiagnostics(source)[0].prediction,prediction)
  }
  for (const prediction of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'81',null,undefined,{},[]]) {
    const source = [{...diagnostics[0],prediction}]
    parity(source); assert.equal(sanitizeAgentLocalDiagnostics(source),undefined)
  }
  for (const [key,maximum] of Object.entries({publicContentChars:2*1024*1024,parsedToolCalls:1000000,promptTokens:10000000,completionTokens:10000000})) {
    for (const value of [0,48,49,maximum,maximum+1,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER,'1',null,undefined,{},[]]) {
      const source = [{...diagnostics[0],[key]:value}]
      parity(source)
      assert.equal(sanitizeAgentLocalDiagnostics(source)[0][key],Number.isSafeInteger(value)&&value>=0&&value<=maximum?value:null)
    }
  }
  for (const finishReason of ['stop','length','tool_calls','function_call','content_filter','unknown','private',null,{},[]]) {
    parity([{...diagnostics[0],finishReason}])
  }
  for (const answerRecovery of [true,false,'true',1,null,undefined]) {
    const source = [{...diagnostics[0],answerRecovery}]
    parity(source); assert.equal(sanitizeAgentLocalDiagnostics(source)[0].answerRecovery,answerRecovery===true)
  }
  for (const value of [null,undefined,{},[],[null,{},[],{prediction:0}]]) parity(value)
})

test('malformed and duplicate recent metadata cannot backfill stale diagnostics or leak provider content', async () => {
  const { default: native } = await import('../../electron/connectedAgentLocalDiagnostics.cjs')
  const discarded = { get prediction() { throw Error('Discarded older metadata must not be inspected') } }
  const tail = [null,[],{},'raw provider output',{...diagnostics[0],prediction:0},{...diagnostics[0],prediction:1.5},
    {...diagnostics[0],prediction:81,content:'private text',reasoning:'private thought',arguments:{path:'/private/file'}},
    {...diagnostics[0],prediction:81,answerRecovery:true},
    {...diagnostics[0],prediction:82,parsedToolCalls:1000001,finishReason:'private',error:'private error'},
    {...diagnostics[0],prediction:5},{...diagnostics[0],prediction:Infinity},false,{...diagnostics[0],prediction:-1},
    {...diagnostics[0],prediction:83,answerRecovery:true}]
  const source = [discarded,...tail]
  const expected = [{...diagnostics[0],prediction:81},
    {...diagnostics[0],prediction:82,parsedToolCalls:null,finishReason:'unknown'},
    {...diagnostics[0],prediction:5},
    {...diagnostics[0],prediction:83,answerRecovery:true}]
  assert.deepEqual(sanitizeAgentLocalDiagnostics(source),expected)
  assert.deepEqual(native.sanitizeLocalDiagnostics(source),expected)
  assert.doesNotMatch(JSON.stringify(sanitizeAgentLocalDiagnostics(source)),/private|reasoning|arguments|error|raw provider/)
  assert.equal(sanitizeAgentLocalDiagnostics([diagnostics[0],...Array(14).fill(null)]),undefined)
})

test('long-turn diagnostics survive serialized reloads as detached latest metadata without becoming user claims', () => {
  const source = Array.from({length:81},(_,i)=>({...diagnostics[0],prediction:i+1,
    parsedToolCalls:i===80?1000000:49,answerRecovery:i===80,rawResponse:'private response',arguments:{path:'/private/file'}}))
  const expected = source.slice(-14).map(({rawResponse,arguments:args,...item})=>item)
  const user = {role:'user',text:'Continue the edit.',localDiagnostics:source}
  const assistant = {role:'assistant',text:'Final reply unavailable.',deliveryStatus:'reply-unavailable',localDiagnostics:source}
  const data = new Map(), storage = () => ({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)})
  const first = createConnectedAgentConversationStore({storage:storage()}), id = first.read('long-turn','lmstudio').activeId
  assert.equal(first.write('long-turn','lmstudio',id,[user,assistant]).persistent,true)
  assert.doesNotMatch([...data.values()].join('\n'),/private response|\/private\/file|rawResponse|arguments/)
  source.at(-1).parsedToolCalls=0
  // A different storage facade bypasses the per-storage RAM cache, exercising
  // the actual saved JSON parse rather than another detached in-memory read.
  const fresh = createConnectedAgentConversationStore({storage:storage()})
  const loaded = fresh.read('long-turn','lmstudio').conversations[0].messages
  assert.equal(loaded[0].localDiagnostics,undefined)
  assert.deepEqual(loaded[1].localDiagnostics,expected)
  assert.equal(loaded[1].localDiagnostics.at(-1).prediction,81)
  assert.equal(loaded[1].localDiagnostics.at(-1).answerRecovery,true)
  loaded[1].localDiagnostics.at(-1).parsedToolCalls=123
  assert.deepEqual(fresh.read('long-turn','lmstudio').conversations[0].messages[1].localDiagnostics,expected)
  assert.deepEqual(createConnectedAgentConversationStore({storage:storage()}).read('long-turn','lmstudio').conversations[0].messages[1].localDiagnostics,expected)
})

test('assistant receipt status persists across fresh stores and is detached; user claims are stripped', () => {
  const source = {role:'assistant',text:missingAgentReplyText(receipts()),deliveryStatus:'reply-unavailable',toolReceipts:receipts(),localDiagnostics:diagnostics}
  const user = {...source,role:'user',text:'User text'}
  const clean = sanitizeConnectedAgentMessages([user,source])
  assert.equal(clean[0].toolReceipts,undefined)
  assert.equal(clean[0].localDiagnostics,undefined)
  assert.equal(clean[0].deliveryStatus,undefined)
  assert.deepEqual(clean[1].toolReceipts,receipts())
  const data = new Map(), storage = {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}
  const store = createConnectedAgentConversationStore({storage}), id = store.read('fixture','lmstudio').activeId
  store.write('fixture','lmstudio',id,[user,source])
  const loaded = createConnectedAgentConversationStore({storage}).read('fixture','lmstudio').conversations[0].messages
  assert.deepEqual(loaded,clean)
  loaded[1].toolReceipts.entries[0].outcome = 'failed'
  loaded[1].localDiagnostics[0].promptTokens = 999
  assert.deepEqual(store.read('fixture','lmstudio').conversations[0].messages,clean)
  assert.deepEqual(store.read('fixture','codex').conversations[0].messages,[])
})
