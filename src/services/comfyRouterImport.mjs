// Shared import action for Cloud image and MCP. No provider URL or key ever
// reaches this layer; the native manager returns one validated image by job ID.
export function createRouterImageImporter({ getApi, getProject, getAssets, captureContext, isBusy, importFile, makeFile, resolveAssetUrl, measureDuration }) {
  const tasks = new Map()
  return async function importRouterImage(jobId, { previewOnly = true } = {}) {
    try {
      if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error('Choose a known Router image job.')
      const api = getApi()
      if (!api?.list || !api?.output) throw new Error('Cloud image import is unavailable. Restart Velorn.')
      const project = getProject(), handle = project.currentProjectHandle, context = captureContext()
      const assertCurrent = () => {
        const latest = captureContext()
        if (!project.currentProject || !handle || handle !== getProject().currentProjectHandle
          || context.session !== latest.session || context.projectKey !== latest.projectKey) throw new Error('The project changed. Return to the image’s original project before importing.')
        if (isBusy()) throw new Error('Wait for export to finish before importing this image.')
      }
      assertCurrent()
      const snapshot = await api.list({})
      assertCurrent()
      if (!snapshot?.success) throw new Error(snapshot?.error || 'Could not read Router jobs.')
      const job = snapshot.jobs?.find(item => (item.jobId || item.id) === jobId)
      if (!job || job.status !== 'COMPLETED' || job.errorType || job.outputAvailable === false) throw new Error('This Router image is not ready to import.')
      const findExisting = () => getAssets().assets.find(asset => asset?.routerGeneration?.jobId === jobId)
      const hasPreviewUrl = asset => typeof asset?.url === 'string' && Boolean(asset.url.trim())
      const prepareUrl = async asset => {
        if (hasPreviewUrl(asset)) return asset.url
        if (typeof resolveAssetUrl !== 'function') throw new Error('Image preview is unavailable. Restart Velorn before importing.')
        const url = await resolveAssetUrl(handle, asset)
        assertCurrent()
        if (typeof url !== 'string' || !url.trim()) throw new Error('Could not prepare the saved image preview. No asset was added.')
        return url
      }
      const showExisting = async existing => {
        const url = await prepareUrl(existing)
        assertCurrent()
        let current = findExisting()
        if (!current || current.id !== existing.id || current.path !== existing.path || current.absolutePath !== existing.absolutePath) {
          throw new Error('The project image changed while preparing its preview. Open it again.')
        }
        if (!hasPreviewUrl(current)) {
          if (typeof getAssets().updateAssetUrl !== 'function') throw new Error('Could not update the saved image preview. Restart Velorn.')
          getAssets().updateAssetUrl(current.id, url)
          current = findExisting()
        }
        assertCurrent()
        getAssets().setPreview?.(current)
        return { success: true, alreadyImported: true, assetId: current.id, jobId, message: 'This image is already in the project.' }
      }
      const existing = findExisting()
      if (previewOnly) return { success: true, previewOnly: true, jobId, alreadyImported: Boolean(existing), assetId: existing?.id || null,
        message: existing ? 'This image is already in the project.' : 'Retrieve the completed image and add one project asset. No generation or timeline change.', expectedContext: context }
      if (existing) {
        return await showExisting(existing)
      }
      const taskKey = `${context.session}:${context.projectKey}:${jobId}`
      if (tasks.has(taskKey)) return await tasks.get(taskKey)
      const task = (async () => {
        const output = await api.output({ jobId })
        assertCurrent()
        if (!output?.success) throw new Error(output?.error || 'Could not retrieve the completed Router image.')
        // A Create clip arrives as an MP4 or MOV file the native side already checked.
        const isVideo = output.kind === 'video'
        // Create speech, sounds and music arrive as a sound file the native side already checked.
        const isAudio = output.kind === 'audio'
        const validDescriptor = isAudio
          ? ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'].includes(output.mimeType) && /^velorn-router-[a-zA-Z0-9_-]+\.(mp3|wav|ogg|flac|m4a)$/.test(output.filename || '')
          : isVideo
          ? ['video/mp4', 'video/quicktime'].includes(output.mimeType) && /^velorn-router-[a-zA-Z0-9_-]+\.(mp4|mov)$/.test(output.filename || '')
          : ['image/png', 'image/jpeg', 'image/webp'].includes(output.mimeType) && /^velorn-router-[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(output.filename || '')
        if (!validDescriptor) throw new Error('The native image descriptor was invalid.')
        const bytes = output.bytes instanceof Uint8Array ? output.bytes : new Uint8Array(output.bytes)
        if (!bytes.length || bytes.byteLength > (isVideo ? 96 : isAudio ? 40 : 20) * 1024 * 1024) throw new Error(isVideo ? 'The returned clip exceeded the import limit.' : isAudio ? 'The returned audio exceeded the import limit.' : 'The returned image exceeded the import limit.')
        const file = makeFile([bytes], output.filename, { type: output.mimeType })
        const assetInfo = await importFile(handle, file, isAudio ? 'audio' : isVideo ? 'video' : 'images')
        assertCurrent()
        // importAsset owns the durable relative path, but intentionally does
        // not create the session URL used by the image preview and thumbnails.
        const url = await prepareUrl(assetInfo)
        assertCurrent()
        // The timeline needs a sound's real length. A length that cannot be read is left out, never guessed.
        let seconds = null
        if (isAudio && typeof measureDuration === 'function') {
          try { seconds = await measureDuration(url) } catch { seconds = null }
          assertCurrent()
        }
        const duplicate = findExisting()
        if (duplicate) return await showExisting(duplicate)
        const asset = getAssets().addAsset({ ...assetInfo, url, name: output.filename, type: isAudio ? 'audio' : isVideo ? 'video' : 'image', isImported: true,
          ...(Number.isFinite(seconds) && seconds > 0 ? { duration: seconds } : {}),
          source: 'comfy-router', routerGeneration: { version: 1, jobId, model: job.model, estimate: job.estimate,
            ...(job.create ? { modelLabel: job.modelLabel, estimateUsd: job.estimateUsd ?? null } : {}) } })
        if (!isAudio) getAssets().setPreview?.(asset)
        // The asset store is the authority for deduplication. A failed native
        // receipt must not make an already imported asset look unimported.
        let receiptSaved = true
        try { const receipt = await api.markImported?.({ jobId, assetId: asset.id }); receiptSaved = receipt?.success === true }
        catch { receiptSaved = false }
        return { success: true, assetId: asset.id, jobId, receiptSaved,
          message: isAudio ? 'Audio added to project assets. Add it to the timeline when you are ready.' : isVideo ? 'Clip added to project assets. Preview or add it to the timeline when you are ready.' : 'Image added to project assets. Preview or add it to the timeline when you are ready.' }
      })()
      tasks.set(taskKey, task)
      try { return await task } finally { tasks.delete(taskKey) }
    } catch (error) {
      return { success: false, code: 'ROUTER_IMPORT_FAILED', error: error?.message || 'The image could not be imported. No generation was retried.' }
    }
  }
}
