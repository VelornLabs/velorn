const assert = require('node:assert/strict')
const test = require('node:test')
const os = require('node:os')
const path = require('node:path')

const {
  RUNTIME_PACKAGES,
  RUNTIME_WHEELS,
  buildRtxHelperArgs,
  getComfyPythonCandidates,
  getManagedRuntimePaths,
  getRuntimeCandidates,
  normalizeQuality,
} = require('../electron/rtxVideoUpscale')

// Synthetic absolute paths only; these tests never create or read this folder.
// The production helpers intentionally use the host's path implementation.
const fixtureRoot = path.resolve(os.tmpdir(), 'velorn-rtx-test')

test('pins and verifies every standalone RTX runtime wheel', () => {
  assert.deepEqual(RUNTIME_PACKAGES, [
    'numpy==2.2.6',
    'fastrlock==0.8.3',
    'cupy-cuda12x==13.6.0',
    'nvidia-vfx==0.1.0.1',
  ])
  assert.equal(RUNTIME_WHEELS.filter((wheel) => wheel.bootstrap).length, 1)
  assert.ok(RUNTIME_WHEELS.some((wheel) => wheel.package === 'nvidia-vfx'))
  for (const wheel of RUNTIME_WHEELS) {
    assert.match(wheel.url, /^https:\/\//)
    assert.match(wheel.sha256, /^[a-f0-9]{64}$/)
    assert.ok(wheel.size > 0)
  }
})

test('normalizes supported RTX quality values', () => {
  assert.equal(normalizeQuality('ultra'), 'ULTRA')
  assert.equal(normalizeQuality('unexpected'), 'HIGH')
})

test('keeps the standalone runtime ahead of compatible local fallbacks', () => {
  const userDataPath = path.join(fixtureRoot, 'VelornData')
  const portableRoot = path.join(fixtureRoot, 'ComfyUI_windows_portable')
  const candidates = getRuntimeCandidates({
    userDataPath,
    comfyRootPath: path.join(portableRoot, 'ComfyUI'),
  })
  assert.equal(candidates[0].kind, 'managed')
  assert.equal(candidates[0].pythonPath, path.join(userDataPath, 'rtx-runtime-v1', 'python', 'python.exe'))
  assert.ok(candidates.some((entry) => (
    entry.kind === 'compatible-local'
      && entry.pythonPath === path.join(portableRoot, 'python_embeded', 'python.exe')
  )))
})

test('finds common portable ComfyUI Python layouts as compatibility fallbacks', () => {
  const appsRoot = path.join(fixtureRoot, 'Apps')
  const portableRoot = path.join(appsRoot, 'ComfyUI_windows_portable')
  const comfyRoot = path.join(portableRoot, 'ComfyUI')
  const candidates = getComfyPythonCandidates(comfyRoot)
  assert.deepEqual(candidates, [
    path.join(comfyRoot, 'python_embeded', 'python.exe'),
    path.join(comfyRoot, 'python_embedded', 'python.exe'),
    path.join(portableRoot, 'python_embeded', 'python.exe'),
    path.join(portableRoot, 'python_embedded', 'python.exe'),
    path.join(appsRoot, 'python_embeded', 'python.exe'),
    path.join(appsRoot, 'python_embedded', 'python.exe'),
  ])
})

test('builds a bounded direct helper command', () => {
  const helperPath = path.join(fixtureRoot, 'Velorn app', 'rtx_vsr_stream.py')
  const inputPath = path.join(fixtureRoot, 'Renders', 'source clip.mp4')
  const outputPath = path.join(fixtureRoot, 'Renders', 'final clip.mp4')
  const ffmpegPath = path.join(fixtureRoot, 'Velorn app', 'ffmpeg.exe')
  const ffprobePath = path.join(fixtureRoot, 'Velorn app', 'ffprobe.exe')
  const options = {
    helperPath,
    inputPath,
    outputPath,
    width: 2160,
    height: 3840,
    quality: 'medium',
    ffmpegPath,
    ffprobePath,
  }
  const args = buildRtxHelperArgs(options)
  assert.deepEqual(args, [
    helperPath,
    '--input', inputPath,
    '--output', outputPath,
    '--width', '2160',
    '--height', '3840',
    '--quality', 'MEDIUM',
    '--ffmpeg', ffmpegPath,
    '--ffprobe', ffprobePath,
    '--encoder', 'h264_nvenc',
    '--cq', '18',
  ])
  assert.throws(() => buildRtxHelperArgs({ ...options, width: 8193 }), /cannot exceed 8192/)
  assert.throws(() => buildRtxHelperArgs({ ...options, height: 8193 }), /cannot exceed 8192/)
})

test('returns stable managed runtime paths', () => {
  const userDataPath = path.join(fixtureRoot, 'Users', 'Editor', 'AppData', 'Roaming', 'Velorn')
  const runtime = getManagedRuntimePaths(userDataPath)
  const expectedRoot = path.join(userDataPath, 'rtx-runtime-v1')
  assert.deepEqual(runtime, {
    root: expectedRoot,
    pythonDir: path.join(expectedRoot, 'python'),
    pythonPath: path.join(expectedRoot, 'python', 'python.exe'),
    manifestPath: path.join(expectedRoot, 'runtime.json'),
  })
})
