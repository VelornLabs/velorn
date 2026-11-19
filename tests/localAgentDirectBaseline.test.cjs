'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {assistantEnvelope,parseCall,runTurn,SCOPE,formatMcpResult}=require('../scripts/check-local-agent-direct-baseline.cjs')
const reply=message=>new Response(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?.length?'tool_calls':'stop'}]}))
const tool=(name,args,id='call1')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}})
const record=()=>({predictions:[],events:[],scopeBlocks:[]})
test('minimal envelope never retains private provider fields',()=>{
 const result=assistantEnvelope({role:'assistant',content:'Public',reasoning_content:'PRIVATE',reasoning:'PRIVATE',extra:'PRIVATE',tool_calls:[tool('get_timeline',{})]})
 assert.ok(!JSON.stringify(result).includes('PRIVATE'))
 assert.equal(assistantEnvelope({content:'<think>PRIVATE</think>text'}).content,null)
})
test('calls require parsed JSON objects and function type; prose is never executable',()=>{
 assert.deepEqual(parseCall(tool('trim_clips',{clipId:'x',previewOnly:false})),{name:'trim_clips',args:{clipId:'x',previewOnly:false}})
 assert.throws(()=>parseCall({type:'function',id:'a',function:{name:'x',arguments:'not json'}}))
 assert.throws(()=>parseCall(tool('x',[])))
})
test('direct apply executes once without preview/checkpoint/approval or argument rewrites',async()=>{
 const r=record(),executed=[],requests=[]
 let round=0
 const args={clipId:'clip-6',durationSeconds:2.5,previewOnly:false}
 await runTurn({model:'fixture',tools:[],prompt:'Apply',signal:new AbortController().signal,record:r,
  fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return ++round===1?reply({tool_calls:[tool('trim_clips',args)]}):reply({content:'Applied.'})},
  callTool:async(method,params)=>{executed.push({method,params});return {content:[{type:'text',text:'{"success":true}'}]}}})
 assert.equal(executed.length,1);assert.deepEqual(executed[0].params,{name:'trim_clips',arguments:args})
 assert.equal(r.final,'Applied.');assert.equal(requests[0].max_tokens,undefined)
 assert.equal(requests[0].reasoning_effort,undefined);assert.equal(requests[0].temperature,undefined)
 assert.equal(requests[1].messages.at(-1).content,'{"content":[{"type":"text","text":"{\\"success\\":true}"}]}')
})
test('raw native errors are delivered to the model without automatic retry or repair',async()=>{
 const r=record();let rounds=0,calls=0
 const result={isError:true,content:[{type:'text',text:'missing clip'}]}
 await runTurn({model:'fixture',tools:[],prompt:'edit',signal:new AbortController().signal,record:r,
  fetchImpl:async()=>++rounds===1?reply({tool_calls:[tool('trim_clips',{clipId:'missing',previewOnly:false})]}):reply({content:'The clip was missing.'}),
  callTool:async()=>{calls++;return result}})
 assert.equal(calls,1);assert.deepEqual(r.events[0].result,result)
})
test('unrelated file/settings/spending tools remain outside experiment authority',async()=>{
 for(const name of ['open_project','install_workflow_setup','queue_comfyui_workflow','export_timeline'])assert.equal(SCOPE.has(name),false)
 let calls=0;const r=record()
 await assert.rejects(runTurn({model:'fixture',tools:[],prompt:'edit',signal:new AbortController().signal,record:r,
  fetchImpl:async()=>reply({tool_calls:[tool('open_project',{})]}),callTool:async()=>{calls++}}),{code:'OUTSIDE_EXPERIMENT_SCOPE'})
 assert.equal(calls,0)
})
test('an app-session checkpoint cannot restore an unrelated project',async()=>{
 const r=record();let calls=0
 await assert.rejects(runTurn({model:'fixture',tools:[],prompt:'edit',signal:new AbortController().signal,record:r,
  fetchImpl:async()=>reply({tool_calls:[tool('restore_project_checkpoint',{previewOnly:false})]}),callTool:async()=>{calls++}}),{code:'OUTSIDE_EXPERIMENT_SCOPE'})
 assert.equal(calls,0)
})
test('a checkpoint deliberately created by this model turn can be restored directly',async()=>{
 const r=record();let calls=0,rounds=0
 await runTurn({model:'fixture',tools:[],prompt:'edit',signal:new AbortController().signal,record:r,
  fetchImpl:async()=>{rounds++;return rounds===1?reply({tool_calls:[tool('create_project_checkpoint',{previewOnly:false})]}):rounds===2?reply({tool_calls:[tool('restore_project_checkpoint',{checkpointId:'fresh-id',previewOnly:false},'call2')]}):reply({content:'Restored.'})},
  callTool:async()=>{calls++;return {content:[{type:'text',text:JSON.stringify({success:true,result:{checkpointId:'fresh-id'}})}]}}})
 assert.equal(calls,2)
})
test('truncated public text is retained but not reported as completed delivery',async()=>{
 const r=record()
 await runTurn({model:'fixture',tools:[],prompt:'inspect',signal:new AbortController().signal,record:r,
  fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'Partial public answer'},finish_reason:'length'}]}))})
 assert.equal(r.final,'Partial public answer');assert.equal(r.publicFinalPresent,true);assert.equal(r.deliveryComplete,false)
})
test('whitespace compaction preserves every envelope/block field and JSON token',()=>{
 const result={isError:true,meta:{important:1},content:[{type:'text',text:'{ "x": 9007199254740993, "x": 2, "s": "keep  spaces" }',annotations:{priority:1}},{type:'text',text:'plain  text'},{type:'image',mimeType:'image/png',data:'unchanged'}]}
 assert.equal(formatMcpResult(result),JSON.stringify(result))
 const compact=JSON.parse(formatMcpResult(result,true))
 assert.equal(compact.content[0].text,'{"x":9007199254740993,"x":2,"s":"keep  spaces"}')
 assert.equal(compact.content[1].text,'plain  text')
 assert.deepEqual(compact.content[2],result.content[2]);assert.equal(compact.isError,true)
 assert.deepEqual(compact.meta,result.meta);assert.deepEqual(compact.content[0].annotations,result.content[0].annotations)
 assert.equal(result.content[0].text.includes(' "x"'),true)
})
