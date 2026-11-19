'use strict'
// Where a downloaded model file should go.
//
// ComfyUI keeps models in <ComfyUI>/models/<type>, and lets a person add other
// folders per type in extra_model_paths.yaml. Someone who keeps their models in
// a central place has said so in that file, so a download follows it:
//   1. a folder for this type from a section marked `is_default: true`
//      (ComfyUI's own "save here first" rule), else
//   2. the first folder the file lists for this type, else
//   3. <ComfyUI>/models/<type>, as before.
// Pure: nothing here touches the disk. The caller checks the folder exists.
const path = require('node:path')

function chooseModelDownloadFolder({ modelsPath, targetSubdir = '', extra = null, keysFor = key => [key] } = {}) {
  if (typeof modelsPath !== 'string' || !modelsPath) throw new TypeError('modelsPath is required.')
  const type = String(targetSubdir || '').trim()
  const fallback = { folder: type ? path.join(modelsPath, type) : modelsPath, source: 'comfyui' }
  if (!type || !extra) return fallback
  const keys = keysFor(type).filter(Boolean)
  for (const [map, source] of [[extra.defaultPathsByKey, 'extra-default'], [extra.pathsByKey, 'extra']]) {
    if (!(map instanceof Map)) continue
    for (const key of keys) {
      const folders = map.get(key)
      if (Array.isArray(folders) && typeof folders[0] === 'string' && folders[0]) return { folder: folders[0], source, key, configPath: extra.configPath || '' }
    }
  }
  return fallback
}

module.exports = { chooseModelDownloadFolder }
