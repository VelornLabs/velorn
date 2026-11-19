// Saves a clip, a picture or a piece of music that came back from the Velorn network into the
// open project, through the same import the Create tab uses. Once per job.
import { GENERATED_FOLDERS, generatedFolderId } from './generatedFolders.mjs'

const NAME = /^velorn-network-[A-Za-z0-9_-]{1,12}\.(mp4|mov|webm|png|mp3|flac|opus)$/
const TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'image/png', 'audio/mpeg', 'audio/flac', 'audio/ogg']
const SOUND_EXTENSION = { 'audio/mpeg': '.mp3', 'audio/flac': '.flac', 'audio/ogg': '.opus' }
const LIMIT = 96 * 1024 * 1024

export function createVelornNetworkSaver({ getProject, getAssets, importFile, makeFile, resolveAssetUrl, isBusy = () => false, measureDuration = null }) {
  return async function save({ jobId, filename, mimeType, bytes, hostName = '', prompt = '' } = {}) {
    try {
      if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId) || !NAME.test(filename || '') || !TYPES.includes(mimeType) || filename.endsWith('.png') !== (mimeType === 'image/png')
        || Object.hasOwn(SOUND_EXTENSION, mimeType) !== /\.(mp3|flac|opus)$/.test(filename) || (Object.hasOwn(SOUND_EXTENSION, mimeType) && !filename.endsWith(SOUND_EXTENSION[mimeType]))) throw new Error('The clip that came back could not be read.')
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      if (!data.length || data.byteLength > LIMIT) throw new Error('The clip that came back was empty or too large.')
      const project = getProject(), handle = project.currentProjectHandle
      if (!project.currentProject || !handle) return { success: false, needsProject: true, error: 'Open a project to save the clip.' }
      if (isBusy()) return { success: false, retry: true, error: 'Wait for the export to finish, then save the clip.' }
      const existing = getAssets().assets.find(asset => asset?.velornNetwork?.jobId === jobId)
      if (existing) return { success: true, alreadySaved: true, assetId: existing.id }
      const type = mimeType === 'image/png' ? 'image' : Object.hasOwn(SOUND_EXTENSION, mimeType) ? 'audio' : 'video'
      const info = await importFile(handle, makeFile([data], filename, { type: mimeType }), type)
      // The project may have been switched while the file was being copied.
      if (getProject().currentProjectHandle !== handle) throw new Error('The project changed while the clip was being saved. Try again.')
      const url = typeof info?.url === 'string' && info.url.trim() ? info.url : await resolveAssetUrl(handle, info)
      if (typeof url !== 'string' || !url.trim()) throw new Error('The saved clip could not be opened.')
      // The timeline needs a sound's real length. A length that cannot be read is left out, never guessed.
      let seconds = null
      if (type === 'audio' && typeof measureDuration === 'function') { try { seconds = await measureDuration(url) } catch { seconds = null } }
      // Filed in the Assets panel's "GPU sharing" folder, not loose at the top.
      const folderId = generatedFolderId(getAssets(), GENERATED_FOLDERS.shared)
      const asset = getAssets().addAsset({ ...info, url, name: filename, type, isImported: true, source: 'velorn-network', ...(folderId ? { folderId } : {}), ...(Number.isFinite(seconds) && seconds > 0 ? { duration: seconds } : {}),
        velornNetwork: { version: 1, jobId, hostName: String(hostName).slice(0, 80), prompt: String(prompt).slice(0, 2000) } })
      if (type !== 'audio') getAssets().setPreview?.(asset)
      return { success: true, assetId: asset.id }
    } catch (error) {
      return { success: false, error: error?.message || 'The clip could not be saved.' }
    }
  }
}
