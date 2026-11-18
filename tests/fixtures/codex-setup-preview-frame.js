import english from '../../public/lang/lang_en.json'
// I18n normally fetches dictionaries. Supply only bundled English in RAM;
// every other fetch is rejected, in addition to the server's connect-src none.
window.fetch=async(input,options={})=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href)
  if(url.origin!==location.origin||(options.method||input?.method||'GET')!=='GET')throw Error('Network disabled in setup preview')
  const data=url.pathname==='/tests/fixtures/lang/lang_en.json'?english
    :url.pathname==='/tests/fixtures/lang/languages.json'?{languages:[{code:'en',name:'English',file:'lang_en.json',direction:'ltr'}]}:null
  if(!data)throw Error('Network disabled in setup preview')
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
}
await import('./connected-agent.jsx')
