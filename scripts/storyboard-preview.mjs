// Synthetic, RAM-only playground for the experimental Reference board. This is not
// the app or an Electron profile: no native bridge or ComfyUI proxies run here.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const cacheDir = await mkdtemp(path.join(tmpdir(), 'velorn-storyboard-preview-'))
const server = await createServer({
  configFile: false, root, cacheDir, plugins: [react()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  optimizeDeps: { entries: ['tests/fixtures/storyboard.html'] },
  server: { host: '127.0.0.1', port: 5199, strictPort: true,
    watch: { ignored: ['**/build/**', '**/dist/**', '**/release/**'] } },
})
await server.listen()
console.log('Reference board playground: http://127.0.0.1:5199/tests/fixtures/storyboard.html')
console.log('Synthetic media only. Demo edits reset on refresh; your regular app and projects are untouched.')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
