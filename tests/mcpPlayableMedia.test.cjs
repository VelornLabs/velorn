'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createComfyStudioMcpServer}=require('../electron/mcpServer.js')
test('get_assets requires exact IDs for explicit chat sharing and returns only selected project assets',async()=>{
 const server=createComfyStudioMcpServer()
 const assets=[{id:'music',type:'audio',path:'assets/Music.flac'},{id:'film',type:'video',path:'assets/Film.mp4'},{id:'image',type:'image',path:'assets/Image.png'}]
 server.updateSnapshot({schemaVersion:2,project:{name:'Synthetic',path:'/synthetic/media'},currentTimeline:null,assets,timelines:[],folders:[]})
 const json=result=>JSON.parse(result.content[0].text)
 const ordinary=json(await server.callTool('get_assets',{}));assert.equal(ordinary.reviewMedia,undefined)
 assert.equal((await server.callTool('get_assets',{showInChat:true})).isError,true)
 const selected=json(await server.callTool('get_assets',{showInChat:true,assetIds:['music','film']}))
 assert.equal(selected.reviewMedia,true);assert.deepEqual(selected.assetIds,['music','film'])
 assert.deepEqual(selected.assets.map(a=>a.id),['music','film'])
 const schema=server.tools.find(t=>t.name==='get_assets').inputSchema.properties
 assert.equal(schema.showInChat.type,'boolean');assert.equal(schema.assetIds.type,'array')
})
