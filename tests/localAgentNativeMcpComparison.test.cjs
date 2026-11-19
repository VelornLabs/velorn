const test=require('node:test'),assert=require('node:assert/strict')
const {filterNativeResult,semanticScore}=require('../scripts/check-local-agent-native-mcp.cjs')
test('native public evidence excludes private reasoning, unknown fields and intermediate text from final',()=>{
 const result=filterNativeResult({model_instance_id:'fixture',private:'SECRET',output:[
  {type:'reasoning',content:'SECRET'}, {type:'message',content:'I will inspect.'},
  {type:'tool_call',tool:'get_timeline',arguments:{secret:'SECRET'},output:'SECRET'},
  {type:'message',content:'Observed timing: 17, 3, 20.'}],stats:{input_tokens:123,private:'SECRET'}})
 assert.equal(result.publicAnswer,'Observed timing: 17, 3, 20.')
 assert.deepEqual(result.returnedToolNames,['get_timeline'])
 assert.ok(!JSON.stringify(result).includes('SECRET'))
})
test('invalid tool call invalidates preceding prose as final',()=>{
 const result=filterNativeResult({output:[{type:'message',content:'Ready.'},{type:'invalid_tool_call',metadata:{type:'invalid_name',tool_name:'bogus'}}]})
 assert.equal(result.publicAnswer,'')
 assert.equal(result.invalidToolCalls[0].toolName,'bogus')
})
test('private thought tags in a mislabeled message are not retained',()=>{
 assert.equal(filterNativeResult({output:[{type:'message',content:'<think>PRIVATE</think>Answer'}]}).publicAnswer,'')
})
test('semantic score only relaxes legacy explicit preview flag, never native effect checks',()=>{
 assert.equal(semanticScore({assertions:[{name:'Explicit model preview before apply',passed:false},{name:'Exact successful native trim preview',passed:true}]}),true)
 assert.equal(semanticScore({assertions:[{name:'Exact successful native trim preview',passed:false}]}),false)
})
