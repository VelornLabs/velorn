const test = require('node:test')
const assert = require('node:assert/strict')
const { createAgentRunTiming } = require('../electron/connectedAgentRunTiming.cjs')
test('long Full access runs report beyond the former thirty-minute ceiling', () => {
  let time=0;const events=[],timing=createAgentRunTiming({now:()=>time,emit:event=>events.push(event)})
  time=2*60*60*1000;timing.finish('completed')
  assert.equal(events.at(-1).durationMs,time)
})
test('timings use one origin and overlapping tools retain independent elapsed durations', () => {
  let time = 0; const events = [], timing = createAgentRunTiming({now:()=>time,emit:e=>events.push(e)})
  time = 100
  assert.deepEqual(timing.event({type:'timing',phase:'setup',continuity:'continued',secret:'not forwarded'}), {type:'timing',phase:'setup',durationMs:100,continuity:'continued'})
  time = 150; timing.event({type:'tool',callId:'a',status:'running'})
  time = 200; timing.event({type:'tool',callId:'b',status:'running'})
  time = 250
  assert.equal(timing.event({type:'tool',callId:'a',status:'completed'}).durationMs,100)
  assert.equal(timing.event({type:'tool',callId:'b',status:'failed'}).durationMs,50)
  time = 300; timing.finish('completed'); timing.finish('failed')
  assert.deepEqual(events,[{type:'timing',phase:'first-update',durationMs:150},{type:'timing',phase:'total',durationMs:300,outcome:'completed'}])
})
test('status is not a public model update and unknown tool start time is not fabricated', () => {
  const events = [], timing = createAgentRunTiming({now:()=>50,emit:e=>events.push(e)})
  timing.event({type:'status',text:'Connecting'})
  assert.equal(events.length,0)
  assert.equal(timing.event({type:'tool',callId:'unknown',status:'failed'}).durationMs,undefined)
  timing.finish('cancelled')
  assert.equal(events.at(-1).outcome,'cancelled')
})
