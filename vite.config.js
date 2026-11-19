import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Detect if building for Electron
const isElectron = process.env.ELECTRON === 'true'

export default defineConfig({
  plugins: [react()],
  // Use relative paths for Electron (file:// protocol)
  base: './',
  // The built-in voice model's worker loads its library in pieces, which needs module workers.
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Native runtime builds can contain extracted Linux root filesystems with
    // system symlink cycles (for example /var/run -> /run). They are generated
    // artifacts, never renderer source, so keep Vite's recursive watcher out of
    // build/package output instead of letting chokidar terminate dev startup
    // with ELOOP.
    watch: {
      ignored: [
        '**/build/**',
        '**/release/**',
      ],
    },
    // Allow the JS Self-Profiling API in dev builds so playback performance
    // can be profiled from the console (new Profiler(...)).
    headers: {
      'Document-Policy': 'js-profiling',
    },
    // Proxy requests to ComfyUI to avoid CORS issues
    proxy: {
      '/system_stats': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/prompt': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/history': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/queue': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/interrupt': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/view': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/upload': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/workflow_templates': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/extensions': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReq', (proxyReq, req, res) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188');
            proxyReq.setHeader('Host', '127.0.0.1:8188');
          });
        }
      },
      '/ws': {
        target: 'ws://127.0.0.1:8188',
        ws: true,
        changeOrigin: true,
        secure: false,
        configure: (proxy, options) => {
          proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
            proxyReq.setHeader('Origin', 'http://127.0.0.1:8188')
            proxyReq.setHeader('Host', '127.0.0.1:8188')
          })
        }
      },
    },
  },
  build: {
    outDir: 'dist',
    // Ensure assets are relative for Electron
    assetsDir: 'assets',
    // Generate sourcemaps for debugging (optional, can disable for production)
    sourcemap: isElectron ? false : true,
    // Rollup options for better chunking
    rollupOptions: {
      output: {
        // Consistent chunk naming
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  // Optimize deps for Electron
  optimizeDeps: {
    exclude: [],
    // The voice library is prepared when the dev server starts. Left to be discovered later, Vite
    // finds it the first time a voice is made and reloads the whole window in the middle of it,
    // which looks like a crash.
    include: ['kokoro-js', '@huggingface/transformers'],
  },
})
