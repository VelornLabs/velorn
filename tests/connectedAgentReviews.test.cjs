const test = require('node:test'), assert = require('node:assert/strict')
const { reviewFrames, validReviewImage } = require('../electron/connectedAgentReviews.cjs')
const { sanitizePublication } = require('../electron/mobileCompanion.cjs')
const { validateCommand } = require('../electron/mobileCompanionControl.cjs')
const jpeg = 'data:image/jpeg;base64,/9j/2Q=='
const result = (metadata, image = jpeg) => ({ content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: 'image/jpeg', data: image.split(',')[1] }] })
test('review images only use bounded native raster blocks and supported inspection tools', () => {
  assert.equal(validReviewImage(jpeg), true)
  for (const input of ['https://example.test/a.jpg','file:///private','data:image/svg+xml;base64,PHN2Zz4=',jpeg+'junk']) assert.equal(validReviewImage(input),false)
  assert.equal(validReviewImage(jpeg,5),false)
  assert.deepEqual(reviewFrames('arbitrary_tool',result({})),[])
  assert.deepEqual(reviewFrames('inspect_timeline_frame',{...result({}),isError:true}),[])
  const [frame] = reviewFrames('inspect_timeline_frame',result({timeline:{id:'timeline-1'},frame:{timeSeconds:1.5},privatePath:'/not/projected'}))
  assert.equal(frame.label,'Timeline frame'); assert.equal(frame.timeSeconds,1.5)
  assert.equal(frame.timelineId,'timeline-1'); assert.equal(frame.privatePath,undefined)
  assert.match(reviewFrames('inspect_source_frame',result({result:{timelineSeconds:2,context:{timelineId:'t'}}}))[0].label,/Source.*no effects/)
  const sheet = reviewFrames('inspect_timeline_range',result({timeline:{id:'t'},range:{startSeconds:0}}))[0]
  assert.equal(sheet.timeSeconds,undefined,'never invent a time for a contact sheet')
})
test('mobile projects bounded stills without paths and only accepts current known navigation IDs', () => {
  const frame = {id:'review-test',turnId:'turn-one',dataUrl:jpeg,label:'Timeline frame',capturedAt:Date.now(),timeSeconds:1.5,timelineId:'/not/projected'}
  const snapshot = sanitizePublication({protocol:3,contextId:'context-1',provider:'codex',available:true,reviews:[frame],messages:[{role:'assistant',turnId:'turn-one',text:'Shown.'}]})
  assert.equal(snapshot.reviews.length,1); assert.equal(snapshot.reviews[0].timelineId,undefined)
  assert.equal(snapshot.reviews[0].turnId,'turn-one');assert.equal(snapshot.messages[0].turnId,'turn-one')
  const cmd = {id:'cmd-1',kind:'show-review',contextId:'context-1',reviewId:'review-test'}
  assert.deepEqual(validateCommand(cmd,snapshot),cmd)
  for (const value of [{...cmd,reviewId:'review-other'},{...cmd,contextId:'old'},{...cmd,timeSeconds:500}]) assert.throws(()=>validateCommand(value,snapshot))
  assert.throws(()=>validateCommand(cmd,{...snapshot,busy:true}))
  assert.throws(()=>validateCommand(cmd,{...snapshot,reviews:[]}))
  assert.equal(sanitizePublication({reviews:[{...frame,dataUrl:'https://example.test/image'}]}).reviews.length,0)
})
