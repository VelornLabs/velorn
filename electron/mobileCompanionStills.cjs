'use strict'
const {randomBytes} = require('node:crypto')
// Only scoped persisted raster IDs are exposed. No LAN path or arbitrary file API.
function createMobileStillCatalog({getContext,store}) {
  let scope = '', entries = new Map(), pending = Promise.resolve()
  const keyFor = context => JSON.stringify([context?.contextId,context?.projectPath,context?.chatId])
  async function refresh() {
    const context = await getContext(), key = keyFor(context)
    if (!context?.projectPath || !context.chatId) {entries.clear();scope='';return []}
    if (scope !== key) {entries.clear();scope=key}
    const frames = await store.listFrames(context.projectPath,{chatId:context.chatId,turnIds:context.turnIds || [],includeData:false})
    const next = new Map(), cards = frames.map(frame => {
      const old = [...entries.values()].find(item=>item.frameId===frame.id)
      const mediaId = old?.mediaId || randomBytes(24).toString('hex')
      if (!frame.unavailable) next.set(mediaId,{mediaId,frameId:frame.id,projectPath:context.projectPath,chatId:context.chatId})
      return {id:frame.id,turnId:frame.turnId,label:frame.label,capturedAt:frame.capturedAt,timeSeconds:frame.timeSeconds,
        ...(frame.unavailable ? {unavailable:true,reason:'File unavailable'} : {url:`/media/reviews/${mediaId}`})}
    })
    if (keyFor(await getContext()) !== key || scope !== key) {entries.clear();return []}
    entries=next;return cards
  }
  function list() { const result=pending.then(refresh);pending=result.catch(()=>{});return result }
  async function open(id) {
    await list()
    const entry=entries.get(id), before=scope
    if (!entry) return null
    const frame=await store.readFrame(entry.projectPath,entry.frameId)
    if (!frame?.dataUrl || frame.unavailable || frame.chatId!==entry.chatId || keyFor(await getContext())!==before) return null
    const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(frame.dataUrl)
    return match ? {bytes:Buffer.from(match[2],'base64'),mime:match[1]} : null
  }
  return {list,open}
}
module.exports={createMobileStillCatalog}
