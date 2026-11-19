import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'

const loadConfig = (relative) => {
  const module = { exports: {} }
  const bundled = buildSync({
    entryPoints: [new URL(relative, import.meta.url).pathname],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    define: { 'import.meta.env.BASE_URL': '"/"' }, logLevel: 'silent',
  }).outputFiles[0].text
  Function('module', 'exports', bundled)(module, module.exports)
  return module.exports
}
const packs = loadConfig('../src/config/workflowDependencyPacks.js')
const installers = loadConfig('../src/config/workflowInstallCatalog.js')
const graph = (file) => JSON.parse(fs.readFileSync(new URL(`../public/workflows/${file}`, import.meta.url), 'utf8'))

// The local models the Director music video needs, and the workflow each belongs to.
const LOCAL = [
  ['flux2-klein', 'image_flux2_klein_4b.json', 3],
  ['minimax-h3-local-music', 'video_minimax_h3_local_music_shot.json', 5],
]

for (const [workflowId, file, count] of LOCAL) {
  test(`${workflowId}: every model file can be downloaded with one click`, () => {
    const pack = packs.getWorkflowDependencyPack(workflowId)
    assert.equal(pack.requiredModels.length, count)
    for (const model of pack.requiredModels) {
      const info = installers.getModelInstallInfo(model)
      assert.ok(info, `${model.filename} has a download entry`)
      assert.equal(installers.isModelAutoInstallable(model), true, `${model.filename} downloads without manual steps`)
      assert.match(info.downloadUrl, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/main\//)
      assert.ok(info.downloadUrl.endsWith(`/${model.filename}`), `${model.filename} downloads under its own name`)
      assert.ok(info.sizeBytes > 100e6, `${model.filename} has a real size, so the button can show it`)
      assert.match(info.licenseUrl, /^https:\/\//)
    }
  })

  test(`${workflowId}: the download list matches what the workflow actually loads`, () => {
    const pack = packs.getWorkflowDependencyPack(workflowId)
    const nodes = Object.values(graph(file))
    for (const model of pack.requiredModels) {
      assert.ok(nodes.some((node) => node.class_type === model.classType && node.inputs?.[model.inputKey] === model.filename),
        `${model.filename} is loaded by a ${model.classType} in ${file}`)
    }
    const classes = new Set(nodes.map((node) => node.class_type))
    for (const node of pack.requiredNodes) assert.ok(classes.has(node.classType), `${file} uses ${node.classType}`)
  })
}

test('the new MiniMax H3 and klein downloads are checked against a fingerprint', () => {
  for (const [subdir, filename] of [
    ['diffusion_models', 'flux-2-klein-4b-fp8.safetensors'],
    ['diffusion_models', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
    ['text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
    ['vae', 'minimax_h3_video_vae_fp16.safetensors'],
    ['vae', 'minimax_h3_audio_vae_fp32.safetensors'],
    ['loras', 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'],
  ]) {
    assert.match(installers.getModelInstallInfo({ targetSubdir: subdir, filename }).sha256, /^[0-9a-f]{64}$/)
  }
})
