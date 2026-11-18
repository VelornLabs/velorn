'use strict'
// Opt-in bounded diagnostic through the actual desktop CHANNELS.send handler.
// Real renderer/store/native dispatch in RAM; fake IPC transport, no running app,
// disk bridge, export, capture, generation, settings changes or model tuning.
// node scripts/check-local-agent-desktop-chat.cjs --self-test
// node scripts/check-local-agent-desktop-chat.cjs --run --model <exact-loaded-id>
// Add --inspect-only for one read-only full-handler diagnostic, not the stress suite.
// Add --step-comparison for four fixed cumulative stages, capped at five minutes.
const path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { createRequire } = require('node:module'), { performance } = require('node:perf_hooks')
const repo = path.resolve(__dirname, '..')
const fs = require('node:fs'), os = require('node:os'), { EventEmitter } = require('node:events')
const req = createRequire(path.join(repo, 'package.json'))
const { buildSync } = req('esbuild')
const { createComfyStudioMcpServer } = req('./electron/mcpServer.js')
const { createAgentToolSession } = req('./electron/connectedAgentTools.cjs')
const { createAgentDispatchScope } = req('./electron/connectedAgentDispatch.cjs')
const { contextBytes } = req('./electron/connectedAgentLocalTools.cjs')
const { registerConnectedAgentIpc, CHANNELS } = req('./electron/connectedAgent.cjs')
const { createLocalPredictionDiagnostic } = req('./electron/connectedAgentLocalDiagnostics.cjs')
let selfCheck = false, model, reportFolder, runtimeEvidence = null, inspectOnly = false, stepComparison = false
const CASE_MS = 90000, OVERALL_MS = 600000, MAX_PREDICTIONS = 14
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
// Only public function-call arguments are selected; assistant content and
// private reasoning fields are never inspected or retained by this extractor.
function extractPublicDiscoveryCalls(toolCalls) {
 const matches=(Array.isArray(toolCalls)?toolCalls:[]).filter(call=>call?.function?.name==='discover_velorn_tools')
 const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value
 const calls=matches.slice(0,64).map(call=>{
  const raw=call.function.arguments,chars=typeof raw==='string'?raw.length:null
  const entry={toolCallId:typeof call.id==='string'&&call.id.length<=128?call.id:null,
   argumentsChars:chars,argumentsJsonValid:null,argumentsOmitted:chars===null||chars>4096,argumentsTruncated:false}
  if(entry.argumentsOmitted)return entry
  let args;try{args=JSON.parse(raw);entry.argumentsJsonValid=true}catch{entry.argumentsJsonValid=false;return entry}
  entry.argumentsType=type(args)
  if(!args||typeof args!=='object'||Array.isArray(args))return entry
  const keys=Object.keys(args)
  entry.argumentKeys=keys.slice(0,16).map(key=>key.slice(0,64));entry.argumentKeysOmitted=Math.max(0,keys.length-16)
  entry.argumentsTruncated=entry.argumentKeysOmitted>0||keys.some(key=>key.length>64)
  entry.suppliedArguments={};entry.argumentShapes={}
  const scalar=(value,max)=>{
   if(typeof value==='string'){if(value.length>max)entry.argumentsTruncated=true;return value.slice(0,max)}
   return value===null||typeof value==='boolean'||typeof value==='number'?value:{valueType:type(value)}
  }
  for(const key of ['names','query'])if(Object.hasOwn(args,key)){
   entry.argumentShapes[key]=type(args[key])
   if(key==='names'&&Array.isArray(args.names)){
    entry.suppliedArguments.names=args.names.slice(0,8).map(value=>scalar(value,128))
    entry.namesOmitted=Math.max(0,args.names.length-8)
    if(entry.namesOmitted)entry.argumentsTruncated=true
   }else entry.suppliedArguments[key]=scalar(args[key],256)
  }
  return entry
 })
 return {calls,callsOmitted:Math.max(0,matches.length-64)}
}
// Outgoing model-visible transport evidence, kept separate from native source
// evidence and scoring. Never retain full prompts, overview text or page bodies.
function extractModelVisibleToolEvidence(messages) {
 const maxMessages=64,maxRows=1000,maxHeaderChars=4096,maxOverviewChars=12000
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:null
 const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null
 const text=(value,max=128)=>typeof value==='string'&&value.length<=max?value:null
 const boolean=value=>typeof value==='boolean'?value:null
 const overviews=[],pages=[],discoveryResults=[]
 const outgoing=Array.isArray(messages)?messages:[]
 const discovery=extractPublicDiscoveryCalls(outgoing.filter(message=>message?.role==='assistant')
  .flatMap(message=>Array.isArray(message.tool_calls)?message.tool_calls:[]))
 const discoveryIds=new Set(discovery.calls.map(call=>call.toolCallId).filter(Boolean))
 let matchedDiscoveryResults=0
 let matchedMessages=0
 for(const message of outgoing){
  if(message?.role!=='tool'||typeof message.content!=='string')continue
  if(discoveryIds.has(message.tool_call_id)){
   if(++matchedDiscoveryResults>maxMessages)continue
   const evidence={toolCallId:text(message.tool_call_id),resultChars:message.content.length,
    resultOmitted:message.content.length>maxOverviewChars,resultJsonValid:null}
   discoveryResults.push(evidence)
   if(evidence.resultOmitted)continue
   let result;try{result=JSON.parse(message.content);evidence.resultJsonValid=true}catch{evidence.resultJsonValid=false;continue}
   if(!object(result))continue
   const progress=object(result.helperProgress)?result.helperProgress:{}
   Object.assign(evidence,{available:boolean(result.available),isError:boolean(result.isError),
    errorCode:text(result.error?.code),schemasChanged:boolean(result.schemasChanged),actionExecuted:boolean(result.actionExecuted),
    activated:Array.isArray(result.activated)?result.activated.slice(0,8).map(value=>text(value,64)):null,
    activatedOmitted:Array.isArray(result.activated)?Math.max(0,result.activated.length-8):0,
    madeProgress:boolean(progress.madeProgress),consecutiveNoProgressCalls:count(progress.consecutiveNoProgressCalls),
    maxNoProgressCalls:count(progress.maxNoProgressCalls)})
   continue
  }
  const split=message.content.indexOf('\n\n')
  if(split<0||split>maxHeaderChars)continue
  let header
  try{header=JSON.parse(message.content.slice(0,split))}catch{continue}
  if(!object(header))continue
  const overview=header.kind==='local-tool-result-overview'&&header.format==='timeline-overview-v1'
  if(!overview&&header.kind!=='local-tool-result-page')continue
  if(++matchedMessages>maxMessages)continue
  const identity={toolCallId:text(header.toolCallId),resultId:text(header.resultId)}
  if(overview){
   const body=message.content.slice(split+2)
   if(body.length>maxOverviewChars)continue
   let value
   try{value=JSON.parse(body)}catch{continue}
   if(!object(value)||value.kind!=='timeline-overview'||!Array.isArray(value.clips))continue
   const coverage=object(value.coverage)?value.coverage:{}
   overviews.push({...identity,overviewComplete:boolean(header.overviewComplete),
    detailedResultIncluded:boolean(header.detailedResultIncluded),
    bodyChars:count(header.bodyChars),observedBodyChars:body.length,
    detailTotalChars:count(header.totalChars),originalTotalChars:count(header.originalTotalChars),
    coverage:{returnedClips:count(coverage.returnedClips),totalClips:count(coverage.totalClips),
     allTimelineClipsIncluded:boolean(coverage.allTimelineClipsIncluded),
     allReturnedClipsListed:boolean(coverage.allReturnedClipsListed),clipLimitApplied:boolean(coverage.clipLimitApplied)},
    rows:value.clips.slice(0,maxRows).map(row=>{
     const timing=object(row?.computedTiming?.timeline)?row.computedTiming.timeline:{}
     return {id:text(row?.id,256),type:text(row?.type,64),trackId:text(row?.trackId,256),
      computedTimeline:{status:text(timing.status,64),startSeconds:number(timing.startSeconds),
       durationSeconds:number(timing.durationSeconds),endSeconds:number(timing.endSeconds),
       midpointSeconds:number(timing.midpointSeconds),endExclusive:boolean(timing.endExclusive)}}
    }),rowsOmitted:Math.max(0,value.clips.length-maxRows)})
  }else{
   const progress=object(header.deliveryProgress)?header.deliveryProgress:{}
   pages.push({...identity,format:text(header.format,64),representation:text(header.representation,64),
    offset:count(header.offset),endOffset:count(header.endOffset),nextOffset:count(header.nextOffset),
    totalChars:count(header.totalChars),bodyChars:count(header.bodyChars),
    complete:boolean(header.complete),truncated:boolean(header.truncated),endOfResult:boolean(header.endOfResult),
    newChars:count(progress.newChars),nextUnreadOffset:count(progress.nextUnreadOffset),
    allCharsDelivered:boolean(progress.allCharsDelivered)})
  }
 }
 return {overviews,pages,messagesOmitted:Math.max(0,matchedMessages-maxMessages),
  discoveryCalls:discovery.calls,discoveryCallsOmitted:discovery.callsOmitted,
  discoveryResults,discoveryResultsOmitted:Math.max(0,matchedDiscoveryResults-maxMessages)}
}
const storage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.localStorage = storage
const fakeWindow = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
let forbiddenNetworkCalls = 0
const noNetwork = async () => { forbiddenNetworkCalls++; throw Error('Fixture network is disabled.') }
const code = buildSync({ stdin: { contents: `
 export * from './src/services/mcpActions'; export * from './src/services/mcpContext'; export * from './src/services/mcpSnapshot';
 export { default as timeline } from './src/stores/timelineStore'; export { default as assets } from './src/stores/assetsStore';
 export { default as project } from './src/stores/projectStore';`, resolveDir: repo },
 bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react','zustand','zustand/*'],
 define: { 'import.meta.env.BASE_URL': '"/"' }, logOverride: { 'empty-import-meta':'silent' },
 loader: { '.glsl':'text','.png':'dataurl','.svg':'dataurl' } }).outputFiles[0].text
const moduleBox = { exports: {} }
// The bundled code runs in a browser in production. Electron's Node-only test
// runtime may omit Web Crypto; provide it to this renderer fixture, not globals.
const rendererGlobals = Object.create(globalThis, { crypto: { value: globalThis.crypto || crypto.webcrypto } })
Function('require','module','exports','localStorage','window','fetch','globalThis',code)(req,moduleBox,moduleBox.exports,storage,fakeWindow,noNetwork,rendererGlobals)
const { timeline, assets, project, buildMcpSnapshot, captureMcpContext, startMcpActionBridge } = moduleBox.exports
const initialTimeline = timeline.getState()
const reads = ['get_project','get_timeline','inspect_clip','get_transport_state','list_timelines','inspect_timeline_range','get_mcp_recipes','get_ai_review_passes','find_timeline_items','get_assets','check_media_health']
const records = []
let started, deadline, suiteTimer, activeCancel = null, totalPredictions = 0, suiteStop = null, repeatHistory = []
function seed() {
 project.setState({ currentProjectHandle:'/synthetic/stress-ram-only', currentTimelineId:'timeline-fixture',projectHistory:[],projectFuture:[],projectHistoryLastChangedAt:0,recentProjects:[],
  storyboardRevision:(project.getState().storyboardRevision||0)+1,currentProject:{name:'Review project',settings:{width:1920,height:1080,fps:24},
  timelines:[{id:'timeline-fixture',name:'Review sequence',width:1920,height:1080,fps:24}]}})
 let start=0
 const pictures=[3,4,4,3,3,3].map((duration,i)=>{const c={id:`clip-${i+1}`,name:`Picture ${i+1}`,assetId:`asset-${i+1}`,type:'video',trackId:'v1',
  startTime:start,duration,trimStart:0,trimEnd:duration,sourceDuration:10,sourceTimeScale:1,timelineFps:24,sourceFps:24,speed:1,reverse:false,url:`memory:picture-${i+1}`};start+=duration;return c})
 const clips=[...pictures,{id:'title-opening',name:'Opening title',type:'text',trackId:'titles',startTime:0,duration:3,textProperties:{text:'A different perspective'},transform:{opacity:100},keyframes:{}},
 {id:'title-closing',name:'Closing title',type:'text',trackId:'titles',startTime:17,duration:3,textProperties:{text:'Made in Velorn'},transform:{opacity:100},keyframes:{}},
 {id:'music',name:'Music',assetId:'asset-music',type:'audio',trackId:'a1',startTime:0,duration:20,trimStart:0,trimEnd:20,sourceDuration:30,url:'memory:music'}]
 timeline.setState({...initialTimeline,timelineSessionId:timeline.getState().timelineSessionId+1,clips,
  tracks:[{id:'v1',name:'Picture',type:'video',visible:true,muted:false,locked:false},{id:'titles',name:'Titles',type:'video',visible:true,muted:false,locked:false},{id:'a1',name:'Music',type:'audio',visible:true,muted:false,locked:false}],
  markers:[],transitions:[],history:[],historyIndex:-1,historyLastChangedAt:0,timelineFps:24,duration:30,playheadPosition:0,isPlaying:false,compoundEditContext:null,
  markerCounter:1,trackCounter:4,selectedClipIds:[],selectedMarkerId:null,selectedTransitionId:null,selectedGap:null,activeTrackId:'v1',inPoint:null,outPoint:null})
 assets.setState({assets:[...pictures.map(c=>({id:c.assetId,name:c.name,type:'video',duration:10,url:c.url,hasAudio:false,settings:{fps:24}})),{id:'asset-music',name:'Music',type:'audio',duration:30,url:'memory:music'}],folders:[],currentPreview:null})
 // Use normal project hydration once so later switch/restore normalization does
 // not manufacture differences against a hand-built unnormalized fixture.
 timeline.getState().loadFromProject(timeline.getState().getProjectData(),assets.getState().assets,24)
 project.setState(state=>({currentProject:{...state.currentProject,timelines:state.currentProject.timelines.map(t=>({...t,...timeline.getState().getProjectData()}))}}))
}
function state() { const t=timeline.getState();return clone({id:project.getState().currentTimelineId,clips:t.clips,tracks:t.tracks,markers:t.markers,transitions:t.transitions,assets:assets.getState().assets}) }
const clip = id => timeline.getState().clips.find(c=>c.id===id)
const timing = c => ({start:c.startTime,duration:c.duration,end:c.startTime+c.duration})
const snapshots = () => ({...state(),historyLength:timeline.getState().history.length,historyIndex:timeline.getState().historyIndex})
const nonTargets = (s,ids) => sha(s.clips.filter(c=>!ids.includes(c.id)))
const success = response => {assert.notEqual(response.isError,true,response.content?.map(c=>c.text||'').join('\n'));return JSON.parse(response.content.find(c=>c.type==='text').text)}
const applied = (r,name) => r.receipts.entries.filter(e=>e.toolName===name&&e.outcome==='applied').length
const nativeApplies = (r,name) => r.rendererActions.filter(e=>e.action===name&&e.previewOnly!==true).length
const check = (r,name,condition) => {r.assertions.push({name,passed:!!condition})}
const sameOthers = (r,b,ids) => check(r,'Non-target clip hash unchanged',nonTargets(b,ids)===nonTargets(state(),ids))
const trimArgs = {mode:'normal',clipId:'clip-6',edge:'end',deltaSeconds:-0.5,previewOnly:false}
const keys=[{property:'opacity',timeSeconds:0,value:0,easing:'linear'},{property:'opacity',timeSeconds:0.5,value:100,easing:'linear'},{property:'opacity',timeSeconds:2.5,value:100,easing:'linear'},{property:'opacity',timeSeconds:3,value:0,easing:'linear'}]
const cases=[
 {id:1,name:'fresh-timeline-and-inspection',writes:['create_timeline','switch_timeline'],prompt:'Inspect the current project, then create a new empty timeline named Fresh review, 12 seconds, 1920 by 1080 at 24 fps. Switch to it and inspect it. Confirm it has zero clips. Preserve the original timeline. Preview before applying.',
  direct:async call=>{await call('get_timeline',{});await call('create_timeline',{name:'Fresh review',durationSeconds:12,width:1920,height:1080,fps:24,previewOnly:false});await call('get_timeline',{})},
  verify:(r,b)=>{
   const ts=project.getState().currentProject.timelines,newTimeline=ts.find(t=>t.name==='Fresh review'),original=ts.find(t=>t.id===b.id)
   check(r,'Exactly one fresh timeline',ts.length===2&&newTimeline?.id===state().id)
   check(r,'Fresh timeline is empty',state().clips.length===0)
   check(r,'Exact requested sequence settings',newTimeline?.width===1920&&newTimeline.height===1080&&newTimeline.fps===24&&timeline.getState().duration===12)
   check(r,'Original clips, tracks, markers and transitions preserved',['clips','tracks','markers','transitions'].every(key=>sha(original?.[key]||[])===sha(b[key]||[])))
   check(r,'Project assets preserved',sha(state().assets)===sha(b.assets))
   check(r,'Native creation dispatched once',nativeApplies(r,'create_timeline')===1)
  }},
 {id:2,name:'duplicate-switch-preservation',writes:['duplicate_timeline','switch_timeline','add_timeline_markers'],prompt:'Duplicate the current Review sequence as Alternate review and switch to the duplicate. Add one marker at 2 seconds labelled Alternate only. Then switch back to the original Review sequence and inspect it. The original must have no new marker and its clips must remain unchanged. Preview edits first.',
  direct:async call=>{await call('get_timeline',{});await call('duplicate_timeline',{timelineId:'timeline-fixture',name:'Alternate review',switchToTimeline:true,previewOnly:false});await call('add_timeline_markers',{markers:[{timeSeconds:2,label:'Alternate only'}],previewOnly:false});await call('switch_timeline',{timelineId:'timeline-fixture',previewOnly:false});await call('get_timeline',{})},
  verify:(r,b)=>{const ts=project.getState().currentProject.timelines,d=ts.find(t=>t.name==='Alternate review');check(r,'Original active and unchanged',sha(state())===sha(b));check(r,'One duplicate retains its marker at 2 seconds',ts.length===2&&d?.markers?.length===1&&d.markers[0].label==='Alternate only'&&d.markers[0].time===2);check(r,'Duplicate clips preserved',sha(d?.clips)===sha(b.clips))}},
 {id:3,name:'unequal-duration-reorder',writes:['move_clips','trim_clips'],prompt:'Reorder only the six picture clips to Picture 1, Picture 4, Picture 3, Picture 2, Picture 5, Picture 6, packed contiguously from zero with no gaps or overlaps. Inspect the existing unequal durations; preserve each duration and source trim. Leave both title clips and music unchanged. Preview the complete batch before applying and inspect the final order and timings.',
  direct:async call=>{await call('get_timeline',{});await call('move_clips',{clips:[{clipId:'clip-4',startSeconds:3},{clipId:'clip-3',startSeconds:6},{clipId:'clip-2',startSeconds:10}],resolveOverlaps:false,previewOnly:false});await call('get_timeline',{})},
  verify:(r,b)=>{const pics=state().clips.filter(c=>c.trackId==='v1').sort((a,b)=>a.startTime-b.startTime);check(r,'Exact order',pics.map(c=>c.id).join(',')==='clip-1,clip-4,clip-3,clip-2,clip-5,clip-6');check(r,'Exact contiguous starts',pics.map(c=>c.startTime).join(',')==='0,3,6,10,14,17');check(r,'Picture durations and source trims preserved',pics.every(c=>{const x=b.clips.find(x=>x.id===c.id);return c.duration===x.duration&&c.trimStart===x.trimStart&&c.trimEnd===x.trimEnd}));sameOthers(r,b,['clip-1','clip-2','clip-3','clip-4','clip-5','clip-6'])}},
 {id:4,name:'existing-title-and-opacity-keyframes',writes:['update_text_clip','set_clip_keyframes'],prompt:'Change the existing Opening title to A clearer perspective. Do not create a new title. Preserve its 0–3 second timing. Give it clip-relative opacity keyframes: 0% at 0s, 100% at 0.5s, 100% at 2.5s, 0% at 3s, linear easing. Leave every other clip unchanged. Preview, apply, then inspect the existing title text and keyframes.',
  direct:async call=>{await call('get_timeline',{});await call('update_text_clip',{clipId:'title-opening',text:'A clearer perspective',previewOnly:false});await call('set_clip_keyframes',{clipId:'title-opening',keyframes:keys,replaceKeyframes:true,previewOnly:false});await call('inspect_clip',{clipId:'title-opening'})},
  verify:(r,b)=>{const c=clip('title-opening');check(r,'Existing title text and timing',c.textProperties.text==='A clearer perspective'&&c.startTime===0&&c.duration===3&&state().clips.length===b.clips.length);const k=c.keyframes.opacity||[];check(r,'Four exact linear opacity keyframes',k.length===4&&k.every((v,i)=>(v.time??v.timeSeconds)===keys[i].timeSeconds&&v.value===keys[i].value&&v.easing==='linear'));sameOthers(r,b,['title-opening'])}},
 {id:5,name:'invalid-batch-preview-no-mutation',writes:['move_clips'],previewOnly:true,prompt:'Preview only a batch move containing clip-1 to 1 second and missing-clip to 4 seconds. The second ID is intentionally invalid. Report whether the whole preview is rejected. Do not apply any move, do not substitute another clip, and leave the project unchanged.',
  direct:async(call,raw)=>{await call('get_timeline',{});const response=await raw('move_clips',{clips:[{clipId:'clip-1',startSeconds:1},{clipId:'missing-clip',startSeconds:4}],previewOnly:true});assert.equal(response.isError,true)},
  verify:(r,b)=>{
   check(r,'Authored state and history unchanged',sha(state())===sha(b)&&timeline.getState().history.length===0)
   check(r,'Exact invalid batch preview attempted',r.hostCalls.some(c=>c.name==='move_clips'&&c.previewOnly===true
    &&c.arguments?.clips?.length===2&&c.arguments.clips.some(c=>c.clipId==='clip-1'&&c.startSeconds===1)
    &&c.arguments.clips.some(c=>c.clipId==='missing-clip'&&c.startSeconds===4)))
   check(r,'Missing target explicitly rejected',r.publicToolResults.some(c=>c.name==='move_clips'&&c.isError&&/missing-clip/.test(c.text)))
   check(r,'No applies or approvals',r.rendererActions.every(c=>c.previewOnly!==false||reads.includes(c.action))&&r.approvals.length===0)
  }},
 {id:6,name:'denied-label-change',writes:['set_clip_label_color','set_clip_style'],deny:true,prompt:'Set only Picture 2 label color to orange #f97316. Preview before applying and request approval. If approval is declined, stop without making another attempt or any other change, and accurately report the denial.',
  direct:async(call,raw)=>{await call('get_timeline',{});await raw('set_clip_label_color',{clipIds:['clip-2'],color:'#f97316',previewOnly:false})},
  verify:(r,b)=>{check(r,'Denied approval occurred',r.approvals.some(a=>!a.accepted));check(r,'No state or history changes',sha(state())===sha(b)&&timeline.getState().history.length===0);check(r,'No checkpoint created',nativeApplies(r,'create_project_checkpoint')===0);check(r,'Native denied receipt',r.receipts.entries.some(e=>e.outcome==='denied'))}},
 {id:7,name:'explicit-checkpoint-two-edits-restore',writes:['create_project_checkpoint','restore_project_checkpoint','set_clip_label_color','set_clip_style','add_timeline_markers'],prompt:'Inspect the timeline and explicitly create a safety checkpoint named Before two edits. Change Picture 2 label to orange #f97316 and add one marker at 8 seconds labelled Temporary review. Then restore that exact checkpoint without saving files. Verify that both changes are gone and all clips are restored. Preview all changes before applying.',
  direct:async call=>{await call('get_timeline',{});const c=await call('create_project_checkpoint',{label:'Before two edits',previewOnly:false});await call('set_clip_label_color',{clipIds:['clip-2'],color:'#f97316',previewOnly:false});await call('add_timeline_markers',{markers:[{timeSeconds:8,label:'Temporary review'}],previewOnly:false});await call('restore_project_checkpoint',{checkpointId:c.result?.checkpointId||c.checkpointId,saveProject:false,previewOnly:false})},
  verify:(r,b)=>{check(r,'Authored state fully restored',sha(state())===sha(b));check(r,'Named checkpoint applied',r.rendererActions.some(a=>a.action==='create_project_checkpoint'&&a.previewOnly===false&&a.arguments.label==='Before two edits'));check(r,'Both edits really occurred',r.transitions.some(a=>a.picture2Label==='#f97316'&&a.markerLabels.includes('Temporary review')));check(r,'Restore dispatched once',nativeApplies(r,'restore_project_checkpoint')===1)}},
 {id:8,name:'absolute-trim-first-request',writes:['edit_trim','trim_clips'],prompt:'Make the last picture clip end at exactly 19.5 seconds, keeping its 17 second start fixed and every other clip unchanged. This is an absolute desired endpoint, not a request to trim half a second repeatedly. Inspect current timing, use a safety checkpoint and preview, apply only if needed, then inspect and report start, duration and end.',
  direct:async call=>{await call('get_timeline',{});await call('edit_trim',trimArgs);await call('inspect_clip',{clipId:'clip-6'})},verify:verifyTrim},
 {id:9,name:'absolute-trim-repeated-request',writes:['edit_trim','trim_clips'],repeat:true,prompt:'Again, make the last picture clip end at exactly 19.5 seconds, keeping its 17 second start fixed and every other clip unchanged. Inspect its current timing first. If it already satisfies that absolute desired endpoint, make no edit and report that no further trim was needed.',
  direct:async call=>{await call('get_timeline',{});await call('inspect_clip',{clipId:'clip-6'})},
  verify:(r,b)=>{check(r,'No second trim or other state mutation',sha(state())===sha(b)&&nativeApplies(r,'edit_trim')===0&&nativeApplies(r,'trim_clips')===0);check(r,'Desired endpoint retained',clip('clip-6').startTime===17&&clip('clip-6').duration===2.5);check(r,'No approval/checkpoint',r.approvals.length===0&&nativeApplies(r,'create_project_checkpoint')===0)}},
 {id:10,name:'trim-undo-redo-roundtrip',writes:['edit_trim','trim_clips','undo','redo'],prompt:'Shorten only the last picture at its end from 20 to 19.5 seconds, keeping its start at 17. Use a safety checkpoint and preview. Inspect the result, Undo the trim and inspect the original 20 second endpoint, then Redo and inspect the final 19.5 second endpoint. Do not repeat the trim to simulate Redo. Leave all other clips unchanged. Report the three verified states.',
  direct:async call=>{await call('get_timeline',{});await call('edit_trim',trimArgs);await call('inspect_clip',{clipId:'clip-6'});await call('undo',{scope:'timeline',previewOnly:false});await call('inspect_clip',{clipId:'clip-6'});await call('redo',{scope:'timeline',previewOnly:false});await call('inspect_clip',{clipId:'clip-6'})},
  verify:(r,b)=>{verifyTrim(r,b);check(r,'Native Undo and Redo applied once',applied(r,'undo')===1&&applied(r,'redo')===1);check(r,'Undo restored original timing',r.transitions.some(t=>t.action==='undo'&&t.previewOnly===false&&t.lastPicture?.end===20));check(r,'Redo restored edited timing',r.transitions.some(t=>t.action==='redo'&&t.previewOnly===false&&t.lastPicture?.end===19.5))}},
]
const inspectionCase={id:11,name:'read-only-desktop-inspection',writes:[],previewOnly:true,
 prompt:'Call get_timeline to inspect the current timeline. Count the actual video/image clips, and report the last picture clip start, duration and end in seconds. Do not use a planned shot count. Do not edit, generate, export, capture images or inspect other files.',
 direct:async call=>{await call('get_timeline',{includeClips:true})},
 verify:(r,b)=>{
  check(r,'Fresh timeline inspection occurred',r.hostCalls.some(c=>c.name==='get_timeline'))
  check(r,'Authored state and history unchanged',sha(state())===sha(b)&&timeline.getState().history.length===0)
  check(r,'No approvals or write receipts',r.approvals.length===0&&r.receipts.entries.every(e=>e.outcome==='read'))
 }}
function verifyTrim(r,b){check(r,'Desired timing',clip('clip-6').startTime===17&&clip('clip-6').duration===2.5);sameOthers(r,b,['clip-6']);check(r,'Exactly one trim dispatch',nativeApplies(r,'edit_trim')+nativeApplies(r,'trim_clips')===1);check(r,'Applied checkpoint',applied(r,'create_project_checkpoint')===1)}

const trimTools=['edit_trim','trim_clips']
const trimApplyCount=r=>trimTools.reduce((n,name)=>n+nativeApplies(r,name),0)
// Read only native public result JSON, never model prose or private reasoning.
// Extract before log truncation so a wrong-clip read cannot pass from RAM state.
function extractStepEvidence(name,result){
 if(result?.isError)return {}
 for(const block of result?.content||[]){
  if(block.type!=='text')continue
  let data;try{data=JSON.parse(block.text)}catch{continue}
  if(data?.success===false)continue
  const returned=name==='get_timeline'?data.clips?.find(x=>x.id==='clip-6'):name==='inspect_clip'?data.clip:null
  const read=returned?.id==='clip-6'&&Number.isFinite(returned.startTime)&&Number.isFinite(returned.duration)
   ?{id:returned.id,...timing(returned),sourceIn:returned.trimStart}:null
  const native=data.result||data
  const preview=trimTools.includes(name)&&native.success!==false&&native.previewOnly===true?native.plan?.summary:null
  if(read||preview)return {...(read?{returnedTarget:read}:{}),...(preview?{returnedTrimPreview:clone(preview)}:{})}
 }
 return {}
}
function exactTrimPreview(s){
 const after=s?.after?.[0],before=s?.before?.[0]
 return s?.changedCount===1&&s.before?.length===1&&s.after?.length===1
  &&before?.id==='clip-6'&&before.startTime===17&&before.duration===3
  &&after?.id==='clip-6'&&after.startTime===17&&after.duration===2.5&&after.trimStart===before.trimStart
}
function stepReadEvidence(r){
 const rows=r.publicToolResults
 const reads=rows.filter(x=>!x.isError&&['get_timeline','inspect_clip'].includes(x.name)&&x.returnedTarget)
 const firstTrim=rows.findIndex(x=>trimTools.includes(x.name))
 return {
  initial:reads.some(x=>x.name==='get_timeline'&&x.trimAppliesAtStart===0&&x.returnedTarget.start===17&&x.returnedTarget.duration===3
   &&(firstTrim<0||rows.indexOf(x)<firstTrim)),
  explicitPreview:rows.some(x=>!x.isError&&x.requestedPreviewOnly===true&&trimTools.includes(x.name)&&x.trimAppliesAtStart===0&&exactTrimPreview(x.returnedTrimPreview)),
  postApplyReads:reads.filter(x=>x.trimAppliesAtStart===1),
  verified:reads.some(x=>x.trimAppliesAtStart===1&&x.returnedTarget.start===17&&x.returnedTarget.duration===2.5&&x.returnedTarget.end===19.5),
 }
}
const stepPrefix='Call get_timeline to inspect the actual timeline. Identify the last picture clip and its observed start, duration and end. '
const stepTarget='Preview a normal end trim so that this clip ends at 19.5 seconds and lasts 2.5 seconds, preserving its 17 second start and source-in, with no ripple and every other clip unchanged. '
const stepApply='Then apply that trim once through Velorn’s normal approval and safety checkpoint process. '
const stepCases=[
 {id:12,name:'step-1-inspect',stage:1,writes:[],previewOnly:true,prompt:stepPrefix+'Report those observed values; make no edits.'},
 {id:13,name:'step-2-inspect-preview',stage:2,writes:trimTools,previewOnly:true,prompt:stepPrefix+stepTarget+'Report the proposed timing. Do not apply or request approval.'},
 {id:14,name:'step-3-inspect-preview-apply',stage:3,writes:trimTools,prompt:stepPrefix+stepTarget+stepApply+'Report the confirmed apply tool result; do not perform a separate post-apply inspection.'},
 {id:15,name:'step-4-inspect-preview-apply-verify',stage:4,writes:trimTools,prompt:stepPrefix+stepTarget+stepApply+'After application, inspect that clip again and report its verified start, duration and end.'},
].map(c=>({...c,verify:(r,b)=>verifyStep(c,r,b)}))
function verifyStep(c,r,b){
 const evidence=stepReadEvidence(r)
 check(r,'Successful target timeline inspection before preview or trim',evidence.initial)
 check(r,'Other authored structure preserved',['id','tracks','markers','transitions','assets'].every(k=>sha(state()[k])===sha(b[k])))
 check(r,'No fixture allowlist blocks',r.blockedTools.length===0)
 if(c.stage>=2){
  check(r,'Exact successful native trim preview',r.transitions.some(x=>x.success&&trimTools.includes(x.action)&&x.previewOnly===true&&exactTrimPreview(x.trimPreviewSummary)))
  check(r,'Explicit model preview before apply',evidence.explicitPreview)
 }
 if(c.stage<=2){
  check(r,'Entire authored state and history unchanged',sha(state())===sha(b)&&timeline.getState().history.length===0)
  check(r,'No approvals, applies or checkpoint',r.approvals.length===0&&trimApplyCount(r)===0&&nativeApplies(r,'create_project_checkpoint')===0)
 }else{
  verifyTrim(r,b)
  check(r,'Source-in preserved',clip('clip-6').trimStart===b.clips.find(x=>x.id==='clip-6').trimStart)
  check(r,'Exactly one confirmed trim receipt',trimTools.reduce((n,name)=>n+applied(r,name),0)===1)
  check(r,'Trim approval accepted',r.approvals.some(x=>trimTools.includes(x.toolName)&&x.accepted))
  r.stageCrossover=c.stage===3&&r.publicToolResults.some(x=>!x.isError&&['get_timeline','inspect_clip'].includes(x.name)&&x.trimAppliesAtStart===1)
  check(r,c.stage===4?'Fresh model target verification after apply':'No separate post-apply inspection',c.stage===4?evidence.verified:!r.stageCrossover)
 }
}

function completion(message) {
 return new Response(JSON.stringify({ choices:[{message,finish_reason:message.tool_calls?.length?'tool_calls':'stop'}],
  usage:{prompt_tokens:100,completion_tokens:20} }),{headers:{'Content-Type':'application/json'}})
}
const toolCall=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}})
function scriptedNativeCall(id,name,args,input){
 const definitions=input.tools||[]
 if(definitions.some(tool=>tool.function?.name===name))return toolCall(id,name,args)
 const router=definitions.find(tool=>tool.function?.name==='call_velorn_tool')
 assert.ok(router?.function?.parameters?.properties?.name?.enum?.includes(name),'Requested native tool must be immediately routable')
 return toolCall(id,'call_velorn_tool',{name,arguments:args})
}
async function fixture(c,r){
 const dispatchScope=createAgentDispatchScope(),pending=new Map(),handlers=new Map(),app=new EventEmitter()
 const allow=new Set([...reads,...c.writes,...(!c.previewOnly&&!c.deny?['create_project_checkpoint']:[])])
 let listener=null,serial=0,server,session,controller,providerFetch,lastToolResult,requestSequence=0,activeRequestId=null
 const aggregateReceipts={version:1,entries:[],omitted:0}
 function permitted(name,args={}){
  if(!allow.has(name)||args.saveProject===true)return false
  if(c.previewOnly&&!reads.includes(name)&&args.previewOnly!==true)return false
  if(['create_timeline','duplicate_timeline'].includes(name)&&args.previewOnly===false&&nativeApplies(r,name)>=1)return false
  return true
 }
 fakeWindow.electronAPI={mcp:{onAction(cb){listener=cb;return()=>{listener=null}},sendActionResult(response){
  const p=pending.get(response.id);assert.ok(p,'Unsolicited renderer completion');pending.delete(response.id)
  try{
   if(response.snapshotError||!server.updateSnapshot(response.snapshot))throw Error('Invalid fixture snapshot')
   dispatchScope.complete(p.scope,response,p.action)
   r.transitions.push({action:p.action,previewOnly:p.args.previewOnly,success:response.success!==false&&response.result?.success!==false,
    ...(trimTools.includes(p.action)&&p.args.previewOnly===true?{trimPreviewSummary:clone(response.result?.plan?.summary||null)}:{}),
    stateHash:sha(state()),lastPicture:clip('clip-6')?timing(clip('clip-6')):null,
    picture2Label:clip('clip-2')?.labelColor,markerLabels:timeline.getState().markers.map(m=>m.label)})
   if(response.success===false)throw Error(response.error||'Renderer action failed')
   p.resolve(response.result||{})
  }catch(error){p.reject(error)}
 }}}
 const stop=startMcpActionBridge()
 const performAction=request=>{
  assert.ok(permitted(request.action,request.payload),'Independent RAM action allowlist blocked dispatch')
  const scope=dispatchScope.current(),envelope={id:'desktop-fixture-'+c.id+'-'+(++serial),action:request.action,payload:request.payload||{},
   ...(scope&&!scope.trustedFullAccess?{agentGuard:structuredClone(scope.current)}:{})}
  const safeArgs=clone(envelope.payload);delete safeArgs.expectedContext;delete safeArgs.previewToken
  r.rendererActions.push({action:request.action,previewOnly:request.payload?.previewOnly,arguments:safeArgs})
  return new Promise((resolve,reject)=>{pending.set(envelope.id,{resolve,reject,scope,action:request.action,args:envelope.payload})
   Promise.resolve().then(()=>listener(envelope)).catch(error=>{pending.delete(envelope.id);reject(error)})})
 }
 server=createComfyStudioMcpServer({performAction});server.updateSnapshot(buildMcpSnapshot())
 const getToolContext=async()=>(await performAction({action:'get_transport_state'})).agentContext
 const executeTool=(name,args,guard,signal,{trustedFullAccess=false}={})=>{
  if(!permitted(name,args)){r.blockedTools.push(name);throw Error('Independent diagnostic allowlist blocked this tool. No action was dispatched.')}
  const publicArgs=clone(args);delete publicArgs.expectedContext;delete publicArgs.previewToken
  r.hostCalls.push({name,previewOnly:args.previewOnly,arguments:publicArgs})
  return dispatchScope.runTool(guard,signal,()=>server.callTool(name,args),{trustedFullAccess})
 }
 const recordApproval=details=>{
  const accepted=!c.deny&&permitted(details.toolName,details.arguments)
  r.approvals.push({toolName:details.toolName,accepted})
  return accepted
 }
 const makeObservedToolSession=async options=>{
  const observed=await createAgentToolSession(options)
  session=observed
  const original=observed.callTool
  observed.callTool=async(name,args)=>{
   const trimAppliesAtStart=trimApplyCount(r)
   const result=await original(name,args)
   lastToolResult=result
   r.publicToolResults.push({name,isError:result?.isError===true,trimAppliesAtStart,requestedPreviewOnly:args?.previewOnly,
    ...extractStepEvidence(name,result),lastPicture:clip('clip-6')?timing(clip('clip-6')):null,
    text:result?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n').slice(0,12000)})
   return result
  }
  return observed
 }
 // Diagnostic-only alternate transport hook. The returned session owns the
 // same context, approval, checkpoint, receipt and renderer-dispatch guards;
 // an external MCP gateway may expose it without exposing the raw server.
 // Its receipts are read from session.getReceipts(), not desktop send totals.
 const createGuardedSession=({signal,onEvent=()=>{},trustedFullAccess=false}={})=>makeObservedToolSession({
  getServer:()=>server,signal,expectedContext:captureMcpContext(),allowImages:false,
  autoApproveEdits:false,trustedFullAccess,getContext:getToolContext,
  executeTool:(name,args,guard)=>executeTool(name,args,guard,signal,{trustedFullAccess}),
  requestApproval:recordApproval,onEvent,
 })
 let event
 const contents=Object.assign(new EventEmitter(),{mainFrame:{},isDestroyed:()=>false,send:(_channel,value)=>{
  if(value.type==='approval'){
   const accepted=recordApproval(value)
   queueMicrotask(()=>handlers.get(CHANNELS.approveTool)(event,{requestId:value.requestId,approvalId:value.approvalId,approved:accepted}))
  }
  if(value.type==='timing')r.hostTiming.push(clone(value))
 }})
 const window={webContents:contents,isDestroyed:()=>false}
 controller=registerConnectedAgentIpc({
  ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler),removeHandler:channel=>handlers.delete(channel)},
  app,getMainWindow:()=>window,getMcpServer:()=>server,
  getToolContext,executeTool,makeToolSession:makeObservedToolSession,
  getGenerationSpendingStatus:async()=>({success:true,scope:'velorn-managed',policy:'local-only'}),
  fetchImpl:async(url,options)=>{
   assert.equal(url,'http://127.0.0.1:1234/v1/chat/completions','Only selected local prediction endpoint is allowed')
   const input=JSON.parse(options.body),system=input.messages.find(m=>m.role==='system')?.content||''
   // Assert composition inside the real native handler, never reconstruct or replace it.
   assert.ok(system.includes('Set previewOnly:false only when ready to request'), 'Desktop tool instructions missing')
   assert.ok(system.includes('Generation spending policy from the native host: local-only.'),'Native spending instructions missing')
   assert.ok(system.includes('To SHOW a preview to the user in chat'),'Desktop media instructions missing')
   r.instructionEvidence={desktopHandler:true,sha256:sha(system),characters:system.length,profile:'Tools enabled; Ask first; Text only; Research off; local-only spending'}
   assert.equal(input.temperature,undefined);assert.equal(input.reasoning_effort,undefined)
   return providerFetch(url,options,input)
  },
  toolTimeoutMs:CASE_MS,timeoutMs:CASE_MS,
 })
 event={sender:contents,senderFrame:contents.mainFrame}
 async function send(messages,fetchImpl){
  providerFetch=fetchImpl;lastToolResult=null
  activeRequestId='desktop-stress-'+c.id+'-'+(++requestSequence)
  try{
   const result=await handlers.get(CHANNELS.send)(event,{provider:'lmstudio',endpoint:'http://127.0.0.1:1234/v1',model,
    requestId:activeRequestId,conversationId:'isolated-desktop-stress',messages,context:buildMcpSnapshot(),images:[],
    toolsEnabled:true,expectedContext:captureMcpContext(),vision:false,allowToolImages:false,researchEnabled:false,autoApproveEdits:false})
   aggregateReceipts.entries.push(...(result.toolReceipts?.entries||[]))
   aggregateReceipts.omitted+=result.toolReceipts?.omitted||0
   return result
  }finally{activeRequestId=null}
 }
 async function scriptedCall(name,args,{malformedFinal=false}={}){
  let actionSent=false,count=0
  const result=await send([{role:'user',content:'Exercise this isolated fixture action through native approval: '+name}],async(_url,_options,input)=>{
   count++;assert.ok(count<=4,'Synthetic provider failed to complete')
   if(!actionSent){actionSent=true;return completion({tool_calls:[scriptedNativeCall('action-'+count,name,args,input)]})}
   return completion({content:malformedFinal?'I will continue now.\n<tool_call><function=undo>':'Synthetic provider completed its requested action.'})
  })
  if(malformedFinal){
   assert.equal(result.success,false);assert.equal(result.code,'INVALID_RESPONSE')
   assert.ok(result.toolReceipts.entries.some(e=>['edit_trim','trim_clips'].includes(e.toolName)&&e.outcome==='applied'))
   assert.equal(nativeApplies(r,'edit_trim')+nativeApplies(r,'trim_clips'),1)
   assert.equal(nativeApplies(r,'undo'),0)
  }else assert.equal(result.success,true,JSON.stringify(result))
  assert.ok(lastToolResult,'The actual native tool session did not receive the scripted call')
  return lastToolResult
 }
 async function scriptedRestoreRoundtrip({emptyFinal=false}={}){
  let index=0,awaiting=null,checkpointId=null,predictions=0
  const initial=sha(state())
  const steps=[['get_timeline',()=>({})],['create_project_checkpoint',()=>({label:'Single-turn restore',previewOnly:false})],
   ['add_timeline_markers',()=>({markers:[{timeSeconds:2,label:'Temporary single-turn marker'}],previewOnly:false})],
   ['restore_project_checkpoint',()=>({checkpointId,previewOnly:false})],['get_timeline',()=>({})]]
  const response=await send([{role:'user',content:'In this isolated fixture: inspect, checkpoint, add a temporary marker, restore that checkpoint, then inspect again.'}],async(_url,_options,input)=>{
   assert.ok(++predictions<=12,'Synthetic restore provider exceeded its bound')
   if(awaiting){
    const detail=success(lastToolResult)
    if(awaiting==='create_project_checkpoint')checkpointId=detail.result?.checkpointId||detail.checkpointId
    if(awaiting==='add_timeline_markers')assert.equal(timeline.getState().markers.length,1)
    if(awaiting==='restore_project_checkpoint')assert.equal(sha(state()),initial)
    if(awaiting==='get_timeline'&&index===steps.length)assert.equal(detail.markerCount,0)
    awaiting=null
   }
   if(index===steps.length)return completion({content:emptyFinal?'':'Synthetic restore and fresh inspection completed.'})
   const [name,args]=steps[index]
   awaiting=name;index++
   return completion({tool_calls:[scriptedNativeCall('action-'+predictions,name,args(),input)]})
  })
  assert.equal(index,steps.length)
  assert.equal(response.success,!emptyFinal)
  if(emptyFinal)assert.equal(response.code,'EMPTY_RESPONSE')
  assert.equal(sha(state()),initial)
  const entries=response.toolReceipts.entries
  assert.equal(entries.filter(e=>e.toolName==='restore_project_checkpoint'&&e.outcome==='applied').length,1)
  assert.equal(entries.filter(e=>e.toolName==='get_timeline'&&e.outcome==='read').length,2)
  assert.equal(nativeApplies(r,'restore_project_checkpoint'),1)
  assert.equal(nativeApplies(r,'add_timeline_markers'),1)
 }
 async function scriptedStep(){
  const steps=[['get_timeline',{includeClips:true}]]
  if(c.stage>=2)steps.push(['edit_trim',{...trimArgs,previewOnly:true}])
  if(c.stage>=3)steps.push(['edit_trim',trimArgs])
  if(c.stage===4)steps.push(['inspect_clip',{clipId:'clip-6'}])
  let index=0,predictions=0
  const response=await send([{role:'user',content:c.prompt}],async(_url,_options,input)=>{
   assert.ok(++predictions<=12,'Synthetic step sequence did not complete')
   if(index===steps.length)return completion({content:'Synthetic provider completed the fixed stage.'})
   const [name,args]=steps[index]
   index++
   return completion({tool_calls:[scriptedNativeCall('step-'+predictions,name,args,input)]})
  })
  assert.equal(response.success,true,response.error)
  assert.equal(index,steps.length)
 }
 return {send,scriptedCall,scriptedRestoreRoundtrip,scriptedStep,createGuardedSession,getReceipts:()=>aggregateReceipts,
  cancel(){if(activeRequestId)handlers.get(CHANNELS.cancel)(event,{requestId:activeRequestId})},
  close(){controller.dispose();stop();delete fakeWindow.electronAPI;assert.equal(pending.size,0)}}
}
function saveReport(){
 if(!reportFolder)return
 const summary={promptsAttempted:records.filter(r=>r.attempted).length,cases:records.length,
  executionPassed:records.filter(r=>r.executionPassed).length,publicFinalPresent:records.filter(r=>r.publicFinalPresent).length,
  inconclusive:records.filter(r=>r.inconclusive).length,elapsedSeconds:performance.now()/1000-started/1000,totalPredictions,suiteStop}
 fs.writeFileSync(path.join(reportFolder,'report.json'),JSON.stringify({
  kind:'velorn-native-desktop-chat-diagnostic',reportSchemaVersion:2,selfTest:selfCheck,model,runtimeEvidence,
  handler:'registerConnectedAgentIpc CHANNELS.send',profile:'Tools enabled, Ask first, Text only, Research off, local-only spending',
  diagnosticMode:inspectOnly?'read-only-inspection':stepComparison?'four-stage-comparison':'ten-case-stress',
  bounds:{cases:inspectOnly?1:stepComparison?4:10,perCaseMs:CASE_MS,overallMs:inspectOnly?CASE_MS:stepComparison?300000:OVERALL_MS,maxPredictionsPerCase:MAX_PREDICTIONS,selectiveRetries:0},
  summary,cases:records,qualified:false,
  interpretation:{executionPassed:'Fixture state assertions only, not agent verification or whole-request completion',
   publicFinalPresent:'Nonempty delivered reply only; correctness must be reviewed separately',
   answerOnly:'Tools disabled for this prediction; does not distinguish mandatory summary from empty-answer recovery',
   modelVisibleToolEvidence:'Selected structure and matched public discovery calls/results in outgoing messages, separate from native publicToolResults. Repeated entries are retained history, not new native observations. A terminal helper result may never reach another outgoing request and is not inferred. No prompt text, page bodies or private reasoning retained.'},
  productionFingerprint:{
   desktopHandler:sha(fs.readFileSync(path.join(repo,'electron/connectedAgent.cjs'),'utf8')),
   nativeTools:sha(fs.readFileSync(path.join(repo,'electron/connectedAgentTools.cjs'),'utf8')),
   localAdapter:sha(fs.readFileSync(path.join(repo,'electron/connectedAgentLocalTools.cjs'),'utf8')),
   localMessages:sha(fs.readFileSync(path.join(repo,'electron/localConversationMessages.cjs'),'utf8')),
   localTimelineOverview:sha(fs.readFileSync(path.join(repo,'electron/localAgentTimelineOverview.cjs'),'utf8')),
   localJson:sha(fs.readFileSync(path.join(repo,'electron/localAgentJson.cjs'),'utf8')),
   localToolResults:sha(fs.readFileSync(path.join(repo,'electron/localAgentToolResults.cjs'),'utf8')),
   localToolCatalog:sha(fs.readFileSync(path.join(repo,'electron/localAgentToolCatalog.cjs'),'utf8')),
   rendererActions:sha(fs.readFileSync(path.join(repo,'src/services/mcpActions.js'),'utf8'))},
  limitations:['Fake IPC transport, real native send handler and real renderer/store/native tool execution in RAM',
   'No live app mutation or app/UI automation; scripted fixture-only approval cards',
   'Research disabled and GPU coordinator omitted; currently loaded model/settings unchanged',
   'Fresh conversations except repeated desired-state pair; not a ten-turn endurance test',
   'No real-media capture/export, phone, persistence or packaged-platform acceptance',
   'A nonempty answer is not a correctness claim; manual review required',
   ...(stepComparison?['One sample per fixed-order stage cannot isolate a causal threshold; generation variability, order and cache effects remain']:[])]
 },null,2)+'\n',{mode:0o600})
}
async function runCase(c){
 if(performance.now()>=deadline||suiteStop){
  records.push({case:c.id,name:c.name,prompt:c.prompt,attempted:false,inconclusive:true,reason:'Combined deadline reached before this case.'});saveReport();return
 }
 if(c.repeat&&(clip('clip-6')?.startTime!==17||clip('clip-6')?.duration!==2.5)){
  records.push({case:c.id,name:c.name,prompt:c.prompt,attempted:false,inconclusive:true,
   reason:'Previous request did not establish the desired endpoint; already-satisfied idempotence cannot be tested.'})
  saveReport();console.log(JSON.stringify({event:'case-skipped',case:c.id,reason:'prerequisite-not-met'}));return
 }
 if(!c.repeat)seed()
 const before=state(),r={case:c.id,name:c.name,prompt:c.prompt,attempted:true,predictions:[],hostCalls:[],rendererActions:[],hostTiming:[],
  publicToolResults:[],approvals:[],blockedTools:[],transitions:[],assertions:[],beforeHash:sha(before),before:snapshots()}
 records.push(r)
 const f=await fixture(c,r),caseStarted=performance.now(),caseDeadline=Math.min(deadline,caseStarted+CASE_MS)
 activeCancel=()=>f.cancel()
 const timer=setTimeout(()=>{r.stopReason='case-90-second-deadline';f.cancel()},Math.max(1,caseDeadline-performance.now()))
 console.log(JSON.stringify({event:'case-start',case:c.id,name:c.name}))
 try{
  if(selfCheck){
   const raw=(name,args)=>f.scriptedCall(name,args),call=async(name,args)=>success(await raw(name,args))
   if(c.stage)await f.scriptedStep();else await c.direct(call,raw)
   r.responseSuccess=true;r.publicAnswer='Self-test: actual desktop handler, synthetic provider, no inference.'
  }else{
   const messages=c.repeat?[...repeatHistory,{role:'user',content:c.prompt}]:[{role:'user',content:c.prompt}]
   const response=await f.send(messages,async(url,options,input)=>{
    if(r.predictions.length>=MAX_PREDICTIONS||performance.now()>=caseDeadline){
     r.stopReason=r.predictions.length>=MAX_PREDICTIONS?'prediction-cap':'case-deadline';f.cancel();throw Error('Bounded diagnostic stopped')
    }
    totalPredictions++
    const entry={prediction:r.predictions.length+1,requestBytes:contextBytes(input),answerOnly:input.tool_choice==='none',
     modelVisibleToolEvidence:extractModelVisibleToolEvidence(input.messages)}
    r.predictions.push(entry)
    const response=await fetch(url,options)
    if(response.ok){
     const data=await response.clone().json()
     // Transport can observe tools disabled, but that alone cannot distinguish
     // a budget summary from empty-answer recovery. Do not invent that label.
     const {answerRecovery:_unavailable,...numeric}=createLocalPredictionDiagnostic(data,{prediction:entry.prediction})
     Object.assign(entry,numeric)
     // Tool names only: no private reasoning or raw generation output retained.
     entry.returnedToolNames=(data.choices?.[0]?.message?.tool_calls||[]).map(t=>t.function?.name||'invalid')
     entry.returnedDiscoveryCalls=extractPublicDiscoveryCalls(data.choices?.[0]?.message?.tool_calls)
    }else entry.httpStatus=response.status
    return response
   })
   r.responseSuccess=response.success;r.publicAnswer=response.text;r.deliveryStatus=response.deliveryStatus
   if(response.localDiagnostics)r.nativeLocalDiagnostics=clone(response.localDiagnostics)
   if(!response.success){r.errorCode=response.code;r.errorMessage=response.error}
   if(c.id===8){repeatHistory=[{role:'user',content:c.prompt}];if(response.success&&response.text?.trim())repeatHistory.push({role:'assistant',content:response.text})}
  }
 }catch(error){r.errorCode=error.code||'FIXTURE_OR_PROVIDER_ERROR';r.errorMessage=String(error.message||error).slice(0,1000)}
 finally{
  clearTimeout(timer);r.elapsedSeconds=(performance.now()-caseStarted)/1000;r.receipts=f.getReceipts();r.after=snapshots();r.afterHash=sha(state())
  try{c.verify(r,before)}catch(error){r.assertions.push({name:'Assertion evaluator',passed:false,message:String(error.message).slice(0,300)})}
  check(r,'No renderer network calls',forbiddenNetworkCalls===0);check(r,'Actual desktop instructions composed',r.instructionEvidence?.desktopHandler===true)
  r.fixtureLimited=r.blockedTools.length>0;r.executionPassed=r.assertions.every(a=>a.passed)
  r.publicFinalPresent=r.responseSuccess===true&&typeof r.publicAnswer==='string'&&r.publicAnswer.trim().length>0
  r.publicAnswerCorrectness='requires-manual-review'
  f.close();activeCancel=null;saveReport()
  console.log(JSON.stringify({event:'case-complete',case:c.id,executionPassed:r.executionPassed,publicFinalPresent:r.publicFinalPresent,
   error:r.errorCode,fixtureLimited:r.fixtureLimited,seconds:r.elapsedSeconds,failed:r.assertions.filter(a=>!a.passed)}))
 }
}
async function main(argv){
 const flags=new Set(argv)
 selfCheck=flags.has('--self-test')
 inspectOnly=flags.has('--inspect-only')
 stepComparison=flags.has('--step-comparison')
 assert.notEqual(inspectOnly&&stepComparison,true,'Use either --inspect-only or --step-comparison')
 const selectedCases=inspectOnly?[inspectionCase]:stepComparison?stepCases:cases
 const at=argv.indexOf('--model');model=at>=0?argv[at+1]:(selfCheck?'synthetic-provider':null)
 const run=flags.has('--run')
 if(!selfCheck&&!run){console.log(JSON.stringify({plan:selectedCases.map(({id,name,prompt})=>({id,name,prompt})),actualModelRequests:0},null,2));return}
 assert.notEqual(selfCheck&&run,true,'Use either --self-test or --run')
 assert.ok(typeof model==='string'&&model.trim()===model&&model.length<=200&&!/[\r\n]/.test(model),'Supply --model with the exact loaded model ID')
 assert.ok(argv.every((x,i)=>['--self-test','--run','--model','--inspect-only','--step-comparison'].includes(x)||i===at+1),'Unknown argument')
 if(run){
  const response=await fetch('http://127.0.0.1:1234/api/v1/models',{signal:AbortSignal.timeout(5000),redirect:'error'})
  assert.ok(response.ok,'Unable to inspect local model catalog')
  const data=await response.json(),row=data.models?.find(row=>row.loaded_instances?.some(instance=>instance.id===model))
  assert.ok(row,'Selected exact model instance is not already loaded; no model was loaded by this diagnostic')
  runtimeEvidence={modelKey:row.key,instanceId:model,quantization:row.quantization?.name,
   contextLength:row.loaded_instances.find(i=>i.id===model).config?.context_length}
 }
 reportFolder=fs.mkdtempSync(path.join(os.tmpdir(),selfCheck?'velorn-desktop-chat-selftest-':'velorn-desktop-chat-live-'))
 const overallMs=inspectOnly?CASE_MS:stepComparison?300000:OVERALL_MS
 started=performance.now();deadline=started+overallMs
 suiteTimer=setTimeout(()=>{suiteStop=inspectOnly?'inspection-90-second-deadline':stepComparison?'combined-5-minute-deadline':'combined-10-minute-deadline';activeCancel?.()},overallMs)
 console.log(JSON.stringify({event:'report',path:path.join(reportFolder,'report.json'),selfTest:selfCheck}))
 try{
  for(const c of selectedCases)await runCase(c)
  if(selfCheck&&!inspectOnly&&!stepComparison){
   seed()
   const c={id:'markup',writes:['edit_trim','undo']},r={hostCalls:[],rendererActions:[],hostTiming:[],publicToolResults:[],approvals:[],blockedTools:[],transitions:[]}
   const f=await fixture(c,r)
   try{await f.scriptedCall('edit_trim',trimArgs,{malformedFinal:true});console.log(JSON.stringify({event:'self-test-extra',name:'prose-plus-tool-markup-after-applied-edit',passed:true}))}
   finally{f.close()}
   for(const emptyFinal of [false,true]){
    seed()
    const c={id:'restore-single-turn',writes:['create_project_checkpoint','add_timeline_markers','restore_project_checkpoint']}
    const r={hostCalls:[],rendererActions:[],hostTiming:[],publicToolResults:[],approvals:[],blockedTools:[],transitions:[]}
    const f=await fixture(c,r)
    try{
     await f.scriptedRestoreRoundtrip({emptyFinal})
     console.log(JSON.stringify({event:'self-test-extra',name:emptyFinal?'single-turn-restore-empty-final-retains-receipts':'single-turn-restore-and-fresh-inspection',passed:true}))
    }finally{f.close()}
   }
  }
 }finally{
  clearTimeout(suiteTimer);saveReport()
  console.log(JSON.stringify({event:'summary',selfTest:selfCheck,report:path.join(reportFolder,'report.json'),
   promptsAttempted:records.filter(r=>r.attempted).length,executionPassed:records.filter(r=>r.executionPassed).length,
   publicFinalPresent:records.filter(r=>r.publicFinalPresent).length,totalPredictions,elapsedSeconds:(performance.now()-started)/1000}))
  delete globalThis.localStorage
 }
 if(selfCheck&&records.some(r=>!r.executionPassed||r.errorCode))process.exitCode=1
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1})
function setModel(value){
 assert.ok(typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200&&!/[\r\n]/.test(value),'Supply an exact model ID')
 model=value
}
// The RAM stores are module-scoped: diagnostic consumers must run fixtures
// sequentially, close their gateway/session before f.close(), and never seed
// while a prior fixture still has work in flight.
const diagnosticFixture={seed,state,snapshots,sha,stepCases,fixture,setModel,verifyStep,stepReadEvidence,
 completion,extractModelVisibleToolEvidence,exactTrimPreview,
 getFixtureDiagnostics:()=>({forbiddenNetworkCalls})}
module.exports={main,extractStepEvidence,stepReadEvidence,extractModelVisibleToolEvidence,extractPublicDiscoveryCalls,
 casePlan:cases.map(({id,name,prompt})=>({id,name,prompt})),
 ...diagnosticFixture,diagnosticFixture}
