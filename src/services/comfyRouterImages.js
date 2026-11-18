import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { captureMcpContext } from './mcpContext'
import { isExportBusy } from '../stores/exportActivityStore'
import { importAsset, getProjectFileUrl, getAbsoluteFileUrl, isElectron } from './fileSystem'
import { createRouterImageImporter } from './comfyRouterImport.mjs'

export const importRouterImage = createRouterImageImporter({
  getApi: () => window.electronAPI?.comfyRouter,
  getProject: () => useProjectStore.getState(),
  getAssets: () => useAssetsStore.getState(),
  captureContext: captureMcpContext,
  isBusy: isExportBusy,
  importFile: importAsset,
  resolveAssetUrl: (projectHandle, asset) => isElectron() && asset.absolutePath
    ? getAbsoluteFileUrl(asset.absolutePath)
    : getProjectFileUrl(projectHandle, asset.path),
  makeFile: (...args) => new File(...args),
  // Reads only the file's own header to learn how long a sound is.
  measureDuration: url => new Promise(resolve => {
    const probe = new Audio()
    const done = value => { clearTimeout(timer); probe.onloadedmetadata = null; probe.onerror = null; probe.removeAttribute('src'); resolve(value) }
    const timer = setTimeout(() => done(null), 8000)
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : null)
    probe.onerror = () => done(null)
    probe.src = url
  }),
})
