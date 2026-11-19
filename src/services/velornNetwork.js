import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { isExportBusy } from '../stores/exportActivityStore'
import { importAsset, getProjectFileUrl, getAbsoluteFileUrl, isElectron } from './fileSystem'
import { createVelornNetworkSaver } from './velornNetworkSave.mjs'
import { createVelornNetworkFollower } from './velornNetworkJob.mjs'

// The one follower for this window: the Create tab sends through it and shows
// its progress; VelornNetworkSaver keeps it going when Create is not on screen.
const save = createVelornNetworkSaver({
  getProject: () => useProjectStore.getState(), getAssets: () => useAssetsStore.getState(), isBusy: isExportBusy,
  importFile: importAsset, makeFile: (...args) => new File(...args),
  resolveAssetUrl: (handle, asset) => isElectron() && asset.absolutePath ? getAbsoluteFileUrl(asset.absolutePath) : getProjectFileUrl(handle, asset.path),
  // How long a piece of music is, read from the file's own header (never decoded in the window).
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
// The same saving, for a result that was made on this computer for the paired phone.
export const saveNetworkResult = save
export const velornNetwork = createVelornNetworkFollower({
  getApi: () => (typeof window !== 'undefined' ? window.electronAPI?.gpuNetwork : null), save,
  hasProject: () => { const project = useProjectStore.getState(); return Boolean(project.currentProject && project.currentProjectHandle) },
})
