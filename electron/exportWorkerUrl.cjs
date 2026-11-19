const path = require('path')
const { pathToFileURL } = require('url')

function resolveExportWorkerUrl({ isDev, mainUrl, electronDirectory }) {
  if (!isDev) {
    const url = pathToFileURL(path.join(electronDirectory, '../dist/index.html'))
    url.search = '?export=worker'
    return url.href
  }
  // Reuse this app window's local dev server, never a remote/web content URL.
  // This permits isolated checkouts without rendering against another app's 5173.
  try {
    const url = new URL(mainUrl)
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password) return `${url.origin}/?export=worker`
  } catch { /* conventional dev fallback */ }
  return 'http://127.0.0.1:5173/?export=worker'
}

module.exports = { resolveExportWorkerUrl }
