// Builds only a static, synthetic UI preview. No dev proxy, Electron, real
// profile, Codex process, login, model server or application startup is used.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const output=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-codex-setup-preview-'))
const port=Number(process.env.VELORN_PREVIEW_PORT||5246),entry='/tests/fixtures/codex-setup-preview.html'
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local preview port')
await build({root,configFile:false,publicDir:false,base:'./',plugins:[react()],resolve:{alias:{'@':path.join(root,'src')}},build:{target:'esnext',outDir:output,emptyOutDir:false,sourcemap:false,rollupOptions:{input:[path.join(root,entry),path.join(root,'tests/fixtures/codex-setup-preview-frame.html'),path.join(root,'tests/fixtures/lmstudio-setup-preview.html')]}}})
const allowed=new Map()
async function inventory(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await inventory(file);else if(item.isFile())allowed.set('/'+path.relative(output,file).split(path.sep).join('/'),file)}}
await inventory(output)
// Existing browser regression harnesses use this path. It resolves to the
// same network-blocked RAM-only frame, not the unwrapped development fixture.
allowed.set('/tests/fixtures/connected-agent.html',allowed.get('/tests/fixtures/codex-setup-preview-frame.html'))
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}
const csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',csp);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer')
  if(req.headers.host!==`127.0.0.1:${port}`||!['GET','HEAD'].includes(req.method)){res.writeHead(403);return res.end('Preview only')}
  const pathname=new URL(req.url,`http://127.0.0.1:${port}`).pathname
  if(pathname==='/'){res.writeHead(302,{Location:entry});return res.end()}
  const file=allowed.get(pathname)
  if(!file){res.writeHead(404);return res.end('Not part of the preview')}
  try{const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:data)}catch{res.writeHead(500);res.end('Preview asset unavailable')}
})
server.listen(port,'127.0.0.1',()=>console.log(`PREVIEW READY http://127.0.0.1:${port}${entry}\nStatic assets: ${output}\nNo real Codex account, credentials or chats are used.`))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)))
