'use strict'
// The song listening engine (onnxruntime-node) is built with Microsoft's C++
// compiler and needs the Visual C++ runtime files. Windows does not ship them,
// so on a PC where nothing else installed them the engine cannot be loaded
// (ERR_DLOPEN_FAILED). Velorn therefore carries its own copies, placed beside
// the engine: Windows looks in the folder of the file being loaded first.
//
// The copies come from the "Redist" folder of the Visual Studio that is on the
// build machine, which is the folder Microsoft provides for exactly this use.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// What onnxruntime_binding.node and onnxruntime.dll import from the runtime
// (read from their import tables, onnxruntime-node 1.31.1).
const VC_RUNTIME_FILES = Object.freeze(['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
const ENGINE_FOLDER = Object.freeze(['app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64'])
const ENGINE_FILE = 'onnxruntime_binding.node'
const fail = message => Object.assign(new Error(message), { code: 'WINDOWS_VC_RUNTIME' })

const engineFolder = resourcesPath => path.join(resourcesPath, ...ENGINE_FOLDER)

// A 64-bit Windows program file: "MZ", then "PE\0\0" and the x64 machine number.
function isX64Program(filePath, fsImpl = fs) {
  let data
  try { data = fsImpl.readFileSync(filePath) } catch { return false }
  if (data.length < 0x40 || data.toString('latin1', 0, 2) !== 'MZ') return false
  const at = data.readUInt32LE(0x3c)
  return at + 6 <= data.length && data.toString('latin1', at, at + 4) === 'PE\0\0' && data.readUInt16LE(at + 4) === 0x8664
}

const complete = (folder, fsImpl = fs) => VC_RUNTIME_FILES.every(name => isX64Program(path.join(folder, name), fsImpl))

// The newest x64 runtime folder of a Visual Studio "Redist\MSVC" tree.
function newestIn(redistRoot, fsImpl = fs) {
  let versions
  try { versions = fsImpl.readdirSync(redistRoot) } catch { return null }
  const order = name => name.split('.').map(part => Number(part) || 0)
  versions = versions.filter(name => /^\d+(\.\d+)+$/.test(name)).sort((a, b) => { const x = order(a), y = order(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0 })
  for (const version of versions) {
    let kits
    try { kits = fsImpl.readdirSync(path.join(redistRoot, version, 'x64')) } catch { continue }
    for (const kit of kits.filter(name => /^Microsoft\.VC\d+\.CRT$/.test(name)).sort().reverse()) {
      const folder = path.join(redistRoot, version, 'x64', kit)
      if (complete(folder, fsImpl)) return folder
    }
  }
  return null
}

// Where the build machine keeps Microsoft's redistributable runtime files.
// VELORN_VC_REDIST_DIR names the folder directly (for a machine without Visual Studio).
function findVcRuntimeSource({ env = process.env, fsImpl = fs, execFileSyncImpl = execFileSync } = {}) {
  if (env.VELORN_VC_REDIST_DIR) return complete(env.VELORN_VC_REDIST_DIR, fsImpl) ? env.VELORN_VC_REDIST_DIR : null
  const roots = []
  if (env.VCToolsRedistDir) roots.push(path.dirname(path.resolve(env.VCToolsRedistDir)))
  const vswhere = path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  try {
    const listed = execFileSyncImpl(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    for (const line of String(listed).split(/\r?\n/)) if (line.trim()) roots.push(path.join(line.trim(), 'VC', 'Redist', 'MSVC'))
  } catch { /* No Visual Studio installer on this machine. */ }
  for (const root of roots) { const found = newestIn(root, fsImpl); if (found) return found }
  return null
}

// Copies the runtime files beside the engine in a packed Windows app.
function stageVcRuntime({ resourcesPath, sourceDir, fsImpl = fs } = {}) {
  const target = engineFolder(resourcesPath)
  if (!isX64Program(path.join(target, ENGINE_FILE), fsImpl)) throw fail(`The song engine was not found in the packed app (${path.join(target, ENGINE_FILE)}), so its Visual C++ runtime files cannot be placed.`)
  if (!sourceDir || !complete(sourceDir, fsImpl)) throw fail('The Visual C++ runtime files were not found on this build machine. Install the Visual Studio C++ build tools, or point VELORN_VC_REDIST_DIR at a folder holding the x64 files: ' + VC_RUNTIME_FILES.join(', ') + '.')
  for (const name of VC_RUNTIME_FILES) fsImpl.copyFileSync(path.join(sourceDir, name), path.join(target, name))
  return target
}

// The check a finished Windows package must pass: every runtime file sits beside the engine.
function verifyVcRuntime({ resourcesPath, fsImpl = fs } = {}) {
  const target = engineFolder(resourcesPath)
  if (!isX64Program(path.join(target, ENGINE_FILE), fsImpl)) throw fail(`The song engine is missing from the packed app: ${path.join(target, ENGINE_FILE)}`)
  const missing = VC_RUNTIME_FILES.filter(name => !isX64Program(path.join(target, name), fsImpl))
  if (missing.length) throw fail(`The packed Windows app lacks Visual C++ runtime files beside the song engine: ${missing.join(', ')}. Song listening would not start on a PC without them.`)
  return target
}

module.exports = { VC_RUNTIME_FILES, engineFolder, isX64Program, findVcRuntimeSource, stageVcRuntime, verifyVcRuntime }
