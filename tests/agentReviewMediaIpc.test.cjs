const test=require('node:test'),assert=require('node:assert/strict')
const {registerAgentReviewMediaIpc,CHANNELS}=require('../electron/agentReviewMediaIpc.cjs')
test('review IPC resolves native project, restricts renderer/frame and rejects stale expected paths',async()=>{
  const handlers=new Map(),calls=[],events=[],contents={mainFrame:{},isDestroyed:()=>false,send:(...args)=>events.push(args)}
  const window={webContents:contents,isDestroyed:()=>false},event={sender:contents,senderFrame:contents.mainFrame}
  let project='/synthetic/one'
  registerAgentReviewMediaIpc({ipcMain:{handle:(key,handler)=>handlers.set(key,handler)},getMainWindow:()=>window,getProjectPath:async()=>project,
    store:{saveFrame:async(...args)=>{calls.push(args);return args[1]},listFrames:async()=>[]}})
  const payload={projectPath:project,chatId:'chat-one',turnId:'turn-one',frame:{id:'review-one'}}
  assert.equal((await handlers.get(CHANNELS.saveFrame)(event,payload)).success,true)
  assert.equal(calls[0][0],project);assert.equal(events[0][1].chatId,'chat-one')
  assert.equal((await handlers.get(CHANNELS.saveFrame)({...event,senderFrame:{}},payload)).success,false)
  project='/synthetic/two'
  assert.equal((await handlers.get(CHANNELS.saveFrame)(event,payload)).success,false)
  assert.equal(calls.length,1,'An old capture never writes to the newly opened project')
  assert.equal((await handlers.get(CHANNELS.listFrames)(event,{projectPath:project,chatId:'chat-one',turnIds:['turn-one']})).success,true)
})
