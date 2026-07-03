/**
 * WebGL2 frame compositor for the export pipeline (phase 1 of GPU
 * compositing — see also CanvasPreviewRenderer for the 2D preview path,
 * which adopts this in a later phase).
 *
 * Replaces the per-frame canvas-2D composite chain: each clip layer becomes
 * a textured quad with true projective 3D (corners precomputed by the
 * exporter from the same projectClipPoint math the preview uses), color
 * adjustments run as shader stages mirroring applyAdjustmentGroupToRgb, and
 * blend modes use the W3C compositing formulas that back canvas
 * globalCompositeOperation.
 *
 * Alpha convention: everything inside the compositor is PREMULTIPLIED
 * (matching canvas 2D's backing store, and required for correct blur at
 * transparent edges). Straight alpha exists only at the boundaries: source
 * textures upload straight, blend-mode formulas unpremultiply to evaluate,
 * and the final readback pass unpremultiplies for the FFmpeg pipe (which
 * expects the same straight RGBA that getImageData produced).
 *
 * Kill switch: localStorage 'comfystudio-export-gpu' = '0' (checked by the
 * exporter via isGpuExportEnabled). WebGL2 init failure falls back to the
 * 2D path automatically.
 */

import {
  GLSL_EFFECT_VERTEX_SOURCE,
  GLSL_EFFECT_FRAGMENT_SOURCE,
  getAnimatedGlslEffectUniforms,
} from '../utils/glslEffects'

const GPU_EXPORT_FLAG_KEY = 'comfystudio-export-gpu'

export const isGpuExportEnabled = () => {
  try {
    return window.localStorage.getItem(GPU_EXPORT_FLAG_KEY) !== '0'
  } catch (_) {
    return true
  }
}

// canvas globalCompositeOperation blend modes beyond source-over. These need
// the destination pixel, which GL fixed-function blending can't provide, so
// they run through the ping-pong composite shader.
const BLEND_MODE_IDS = {
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
}

const MAX_BLUR_TAPS = 40

const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const LAYER_VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in float a_w;
uniform vec2 u_resolution;
out vec2 v_uv;
void main() {
  // Canvas-style pixel space (y down) to NDC. Multiplying xy by the
  // homogeneous w and emitting it as gl_Position.w makes the hardware
  // interpolate v_uv perspective-correct — this is what turns the old
  // affine-triangle approximation into true projective texturing.
  vec2 ndc = vec2(a_pos.x / u_resolution.x * 2.0 - 1.0, 1.0 - a_pos.y / u_resolution.y * 2.0);
  gl_Position = vec4(ndc * a_w, 0.0, a_w);
  v_uv = a_uv;
}
`

// Color stages mirror applyAdjustmentGroupToRgb in utils/adjustments.js
// exactly (same order, same per-stage clamping) so GPU and 2D exports match.
const COLOR_STAGES_GLSL = `
vec3 linearStage(vec3 c, float slope, float intercept) {
  return clamp(c * slope + intercept, 0.0, 1.0);
}

vec3 applyColorStages(vec3 c) {
  if (u_brightness != 0.0) {
    c = linearStage(c, max((100.0 + u_brightness) / 100.0, 0.0), 0.0);
  }
  if (u_contrast != 0.0) {
    float slope = max((100.0 + u_contrast) / 100.0, 0.0);
    c = linearStage(c, slope, 0.5 - 0.5 * slope);
  }
  if (u_saturation != 0.0) {
    float amount = max((100.0 + u_saturation) / 100.0, 0.0);
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = clamp(vec3(lum) + (c - vec3(lum)) * amount, 0.0, 1.0);
  }
  if (u_gain != 0.0) {
    c = linearStage(c, max((100.0 + u_gain) / 100.0, 0.0), 0.0);
  }
  if (u_gamma != 0.0) {
    float slope = max((100.0 + u_gamma * 0.5) / 100.0, 0.0);
    c = linearStage(c, slope, 0.5 - 0.5 * slope);
  }
  if (u_offset != 0.0) {
    c = linearStage(c, 1.0, u_offset / 200.0);
  }
  if (u_hue != 0.0) {
    float angle = u_hue * 0.017453292519943295;
    float cosA = cos(angle);
    float sinA = sin(angle);
    mat3 m = mat3(
      0.213 + cosA * 0.787 - sinA * 0.213,
      0.213 - cosA * 0.213 + sinA * 0.143,
      0.213 - cosA * 0.213 - sinA * 0.787,
      0.715 - cosA * 0.715 - sinA * 0.715,
      0.715 + cosA * 0.285 + sinA * 0.140,
      0.715 - cosA * 0.715 + sinA * 0.715,
      0.072 - cosA * 0.072 + sinA * 0.928,
      0.072 - cosA * 0.072 - sinA * 0.283,
      0.072 + cosA * 0.928 + sinA * 0.072
    );
    c = clamp(m * c, 0.0, 1.0);
  }
  return c;
}
`

const LAYER_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_alpha;
uniform bool u_inputPremultiplied;
uniform bool u_applyColor;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_gain;
uniform float u_gamma;
uniform float u_offset;
uniform float u_hue;
in vec2 v_uv;
out vec4 outColor;
${COLOR_STAGES_GLSL}
void main() {
  vec4 texel = texture(u_texture, v_uv);
  vec3 rgb = texel.rgb;
  float alpha = texel.a;
  if (u_inputPremultiplied && alpha > 0.0) {
    rgb /= alpha;
  }
  if (u_applyColor) {
    rgb = applyColorStages(rgb);
  }
  outColor = vec4(rgb * alpha, alpha) * u_alpha;
}
`

// Fullscreen color pass over the premultiplied stage (adjustment layers).
const COLOR_PASS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_gain;
uniform float u_gamma;
uniform float u_offset;
uniform float u_hue;
in vec2 v_uv;
out vec4 outColor;
${COLOR_STAGES_GLSL}
void main() {
  vec4 texel = texture(u_texture, v_uv);
  vec3 rgb = texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
  rgb = applyColorStages(rgb);
  outColor = vec4(rgb * texel.a, texel.a);
}
`

const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_opacity;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = texture(u_texture, v_uv) * u_opacity;
}
`

const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = u_color;
}
`

// Separable Gaussian on premultiplied pixels (SVG/CSS filters blur
// premultiplied too — straight-alpha blur bleeds dark halos at edges).
// Out-of-bounds taps read as transparent, matching filter edge behavior.
const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform vec2 u_direction;
uniform float u_sigma;
uniform int u_taps;
in vec2 v_uv;
out vec4 outColor;
void main() {
  float twoSigmaSq = 2.0 * u_sigma * u_sigma;
  vec4 sum = texture(u_texture, v_uv);
  float weightSum = 1.0;
  for (int i = 1; i <= ${MAX_BLUR_TAPS}; i++) {
    if (i > u_taps) break;
    float offset = float(i);
    float weight = exp(-(offset * offset) / twoSigmaSq);
    vec2 uvA = v_uv + u_direction * offset;
    vec2 uvB = v_uv - u_direction * offset;
    vec4 texelA = (uvA.x < 0.0 || uvA.x > 1.0 || uvA.y < 0.0 || uvA.y > 1.0) ? vec4(0.0) : texture(u_texture, uvA);
    vec4 texelB = (uvB.x < 0.0 || uvB.x > 1.0 || uvB.y < 0.0 || uvB.y > 1.0) ? vec4(0.0) : texture(u_texture, uvB);
    sum += (texelA + texelB) * weight;
    weightSum += 2.0 * weight;
  }
  outColor = sum / weightSum;
}
`

// W3C compositing spec formulas (the same ones behind canvas
// globalCompositeOperation blend modes): unpremultiply both sides, mix the
// blended color by backdrop alpha, then Porter-Duff source-over.
const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform float u_opacity;
uniform int u_blendMode;
in vec2 v_uv;
out vec4 outColor;

float blendChannel(float cb, float cs, int mode) {
  if (mode == 1) return cb * cs;
  if (mode == 2) return cb + cs - cb * cs;
  if (mode == 3) return cb <= 0.5 ? (2.0 * cs * cb) : (cs + (2.0 * cb - 1.0) - cs * (2.0 * cb - 1.0));
  if (mode == 4) return min(cb, cs);
  if (mode == 5) return max(cb, cs);
  if (mode == 6) return cb <= 0.0 ? 0.0 : (cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs)));
  if (mode == 7) return cb >= 1.0 ? 1.0 : (cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs));
  if (mode == 8) return cs <= 0.5 ? (2.0 * cs * cb) : (cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0));
  if (mode == 9) {
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cs <= 0.5 ? (cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)) : (cb + (2.0 * cs - 1.0) * (d - cb));
  }
  if (mode == 10) return abs(cb - cs);
  if (mode == 11) return cb + cs - 2.0 * cb * cs;
  return cs;
}

void main() {
  vec4 dst = texture(u_dst, v_uv);
  vec4 src = texture(u_src, v_uv) * u_opacity;
  vec3 cb = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 cs = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 blended = vec3(
    blendChannel(cb.r, cs.r, u_blendMode),
    blendChannel(cb.g, cs.g, u_blendMode),
    blendChannel(cb.b, cs.b, u_blendMode)
  );
  vec3 mixed = mix(cs, blended, dst.a);
  float outAlpha = src.a + dst.a * (1.0 - src.a);
  vec3 outRgb = mixed * src.a + dst.rgb * (1.0 - src.a);
  outColor = vec4(outRgb, outAlpha);
}
`

// Wrap passes for the GLSL effects program: the effect shaders were
// authored against straight-alpha input (the 2D path fed them
// unpremultiplied canvases), while the stage is premultiplied.
const UNPREMULT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  outColor = vec4(texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0), texel.a);
}
`

const PREMULT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  outColor = vec4(texel.rgb * texel.a, texel.a);
}
`

// Readback pass: unpremultiply and flip vertically so readPixels returns
// the same top-down straight RGBA that getImageData fed the FFmpeg pipe.
const FINAL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, vec2(v_uv.x, 1.0 - v_uv.y));
  vec3 rgb = texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
  outColor = vec4(rgb, texel.a);
}
`

const compileShader = (gl, type, source) => {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`GPU compositor shader compile failed: ${info}`)
  }
  return shader
}

const createProgram = (gl, vsSource, fsSource, attribBindings = null) => {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource)
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  // Pin attribute locations to match the vertexAttribPointer indices used
  // by the VAOs (bindings for attributes a shader lacks are ignored).
  const bindings = attribBindings || { a_pos: 0, a_uv: 1, a_w: 2 }
  for (const [name, location] of Object.entries(bindings)) {
    gl.bindAttribLocation(program, location, name)
  }
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`GPU compositor program link failed: ${info}`)
  }
  return program
}

const getUniforms = (gl, program, names) => {
  const uniforms = {}
  for (const name of names) {
    uniforms[name] = gl.getUniformLocation(program, name)
  }
  return uniforms
}

const COLOR_UNIFORM_NAMES = ['u_brightness', 'u_contrast', 'u_saturation', 'u_gain', 'u_gamma', 'u_offset', 'u_hue']

const parseCssColor = (color) => {
  if (typeof color !== 'string') return [0, 0, 0]
  const hex = color.trim().replace(/^#/, '')
  if (hex.length === 3) {
    return [
      parseInt(hex[0] + hex[0], 16) / 255,
      parseInt(hex[1] + hex[1], 16) / 255,
      parseInt(hex[2] + hex[2], 16) / 255,
    ]
  }
  if (hex.length === 6) {
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ]
  }
  return [0, 0, 0]
}

const hasColorStages = (settings) => {
  if (!settings) return false
  return (settings.brightness || 0) !== 0
    || (settings.contrast || 0) !== 0
    || (settings.saturation || 0) !== 0
    || (settings.gain || 0) !== 0
    || (settings.gamma || 0) !== 0
    || (settings.offset || 0) !== 0
    || (settings.hue || 0) !== 0
}

export const createGpuCompositor = ({ width, height, transparent = false } = {}) => {
  if (typeof document === 'undefined' || !width || !height) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let gl = null
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    })
  } catch (_) {
    gl = null
  }
  if (!gl) return null

  let contextLost = false
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    contextLost = true
  })

  let programs
  try {
    programs = {
      layer: createProgram(gl, LAYER_VS, LAYER_FS),
      colorPass: createProgram(gl, FULLSCREEN_VS, COLOR_PASS_FS),
      blit: createProgram(gl, FULLSCREEN_VS, BLIT_FS),
      fill: createProgram(gl, FULLSCREEN_VS, FILL_FS),
      blur: createProgram(gl, FULLSCREEN_VS, BLUR_FS),
      composite: createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS),
      final: createProgram(gl, FULLSCREEN_VS, FINAL_FS),
      unpremult: createProgram(gl, FULLSCREEN_VS, UNPREMULT_FS),
      premult: createProgram(gl, FULLSCREEN_VS, PREMULT_FS),
    }
  } catch (err) {
    console.warn('[GPU Compositor] Shader init failed, falling back to 2D:', err?.message || err)
    return null
  }

  const uniforms = {
    layer: getUniforms(gl, programs.layer, [
      'u_resolution', 'u_texture', 'u_alpha', 'u_inputPremultiplied', 'u_applyColor', ...COLOR_UNIFORM_NAMES,
    ]),
    colorPass: getUniforms(gl, programs.colorPass, ['u_texture', ...COLOR_UNIFORM_NAMES]),
    blit: getUniforms(gl, programs.blit, ['u_texture', 'u_opacity']),
    fill: getUniforms(gl, programs.fill, ['u_color']),
    blur: getUniforms(gl, programs.blur, ['u_texture', 'u_direction', 'u_sigma', 'u_taps']),
    composite: getUniforms(gl, programs.composite, ['u_dst', 'u_src', 'u_opacity', 'u_blendMode']),
    final: getUniforms(gl, programs.final, ['u_texture']),
    unpremult: getUniforms(gl, programs.unpremult, ['u_texture']),
    premult: getUniforms(gl, programs.premult, ['u_texture']),
  }

  // Fullscreen triangle-strip quad in clip space.
  const fullscreenVao = gl.createVertexArray()
  gl.bindVertexArray(fullscreenVao)
  const fullscreenVbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, fullscreenVbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  // Streaming layer quad: 4 vertices × (x, y, u, v, w).
  const layerVao = gl.createVertexArray()
  gl.bindVertexArray(layerVao)
  const layerVbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, layerVbo)
  gl.bufferData(gl.ARRAY_BUFFER, 4 * 5 * 4, gl.STREAM_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 8)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16)
  gl.bindVertexArray(null)
  const layerVertexData = new Float32Array(4 * 5)

  const createTarget = (targetWidth, targetHeight) => {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetWidth, targetHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture, fbo, width: targetWidth, height: targetHeight }
  }

  // Ping-pong stage pair + two full-res scratch targets (layer resolve,
  // blur/readback), mirroring the 2D path's offCanvas/adjustmentCanvas pool
  // but fixed-size instead of per-clip.
  const stages = [createTarget(width, height), createTarget(width, height)]
  let stageIndex = 0
  const scratchA = createTarget(width, height)
  const scratchB = createTarget(width, height)
  const downsampleTargets = new Map() // factor -> [targetA, targetB]

  // MSAA renderbuffer for layer quads so rotated/scaled clip edges stay
  // antialiased like canvas 2D drawImage. Fullscreen passes don't need it.
  const msaaSamples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0)
  let msaaFbo = null
  if (msaaSamples > 1) {
    const rb = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaaSamples, gl.RGBA8, width, height)
    msaaFbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFbo)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  const sourceTextures = new Map() // key -> { texture, version }

  // Double-buffered readback so the frame in flight to the FFmpeg pipe is
  // never overwritten by the next frame's readPixels.
  const readbackBuffers = [new Uint8Array(width * height * 4), new Uint8Array(width * height * 4)]
  let readbackIndex = 0

  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.SCISSOR_TEST)
  gl.clearColor(0, 0, 0, 0)

  const setPremultipliedSourceOver = () => {
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  const bindTarget = (target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, target.width, target.height)
  }

  const setColorUniforms = (programUniforms, settings) => {
    gl.uniform1f(programUniforms.u_brightness, Number(settings?.brightness) || 0)
    gl.uniform1f(programUniforms.u_contrast, Number(settings?.contrast) || 0)
    gl.uniform1f(programUniforms.u_saturation, Number(settings?.saturation) || 0)
    gl.uniform1f(programUniforms.u_gain, Number(settings?.gain) || 0)
    gl.uniform1f(programUniforms.u_gamma, Number(settings?.gamma) || 0)
    gl.uniform1f(programUniforms.u_offset, Number(settings?.offset) || 0)
    gl.uniform1f(programUniforms.u_hue, Number(settings?.hue) || 0)
  }

  const uploadSource = (source, key, version) => {
    let entry = sourceTextures.get(key)
    if (!entry) {
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry = { texture, version: null }
      sourceTextures.set(key, entry)
    }
    if (entry.version !== version) {
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      entry.version = version
    }
    return entry.texture
  }

  const drawFullscreen = () => {
    gl.bindVertexArray(fullscreenVao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  // Blit `texture` over the given target using premultiplied source-over —
  // the hardware fast path for 'normal' blend mode.
  const blitOnto = (texture, target, opacity = 1, blend = true) => {
    bindTarget(target)
    if (blend) {
      setPremultipliedSourceOver()
    } else {
      gl.disable(gl.BLEND)
    }
    gl.useProgram(programs.blit)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(uniforms.blit.u_texture, 0)
    gl.uniform1f(uniforms.blit.u_opacity, opacity)
    drawFullscreen()
  }

  const getDownsamplePair = (factor) => {
    let pair = downsampleTargets.get(factor)
    if (!pair) {
      const w = Math.max(1, Math.round(width / factor))
      const h = Math.max(1, Math.round(height / factor))
      pair = [createTarget(w, h), createTarget(w, h)]
      downsampleTargets.set(factor, pair)
    }
    return pair
  }

  const runBlurPass = (sourceTexture, target, direction, sigma, taps) => {
    bindTarget(target)
    gl.disable(gl.BLEND)
    gl.useProgram(programs.blur)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.uniform1i(uniforms.blur.u_texture, 0)
    gl.uniform2f(uniforms.blur.u_direction, direction[0] / target.width, direction[1] / target.height)
    gl.uniform1f(uniforms.blur.u_sigma, sigma)
    gl.uniform1i(uniforms.blur.u_taps, taps)
    drawFullscreen()
  }

  // Gaussian blur of scratchA in place (via scratchB), approximating CSS
  // blur(px). Large radii run at reduced resolution like Chromium does.
  const blurScratchA = (blurPx) => {
    const sigma = Math.max(0.01, Number(blurPx) || 0)
    if (sigma <= 0.01) return
    const factor = sigma <= 8 ? 1 : (sigma <= 24 ? 2 : 4)
    const effectiveSigma = sigma / factor
    const taps = Math.min(MAX_BLUR_TAPS, Math.max(1, Math.ceil(effectiveSigma * 3)))
    if (factor === 1) {
      runBlurPass(scratchA.texture, scratchB, [1, 0], effectiveSigma, taps)
      runBlurPass(scratchB.texture, scratchA, [0, 1], effectiveSigma, taps)
      return
    }
    const [smallA, smallB] = getDownsamplePair(factor)
    blitOnto(scratchA.texture, smallA, 1, false)
    runBlurPass(smallA.texture, smallB, [1, 0], effectiveSigma, taps)
    runBlurPass(smallB.texture, smallA, [0, 1], effectiveSigma, taps)
    blitOnto(smallA.texture, scratchA, 1, false)
  }

  // Composite a full-frame layer texture onto the stage with opacity +
  // blend mode. Normal blend draws straight onto the current stage; the
  // fancy modes sample the stage as a texture, so they write to the other
  // stage and swap.
  const compositeOntoStage = (sourceTexture, opacity, blendMode) => {
    const modeId = BLEND_MODE_IDS[blendMode] || 0
    if (modeId === 0) {
      blitOnto(sourceTexture, stages[stageIndex], opacity, true)
      return
    }
    const src = stages[stageIndex]
    const dstIndex = 1 - stageIndex
    bindTarget(stages[dstIndex])
    gl.disable(gl.BLEND)
    gl.useProgram(programs.composite)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.texture)
    gl.uniform1i(uniforms.composite.u_dst, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.uniform1i(uniforms.composite.u_src, 1)
    gl.uniform1f(uniforms.composite.u_opacity, opacity)
    gl.uniform1i(uniforms.composite.u_blendMode, modeId)
    drawFullscreen()
    stageIndex = dstIndex
  }

  // ---- GLSL effects pass (native port of utils/glslEffects.js) ----------
  // Same fragment shader and uniform math as the 2D path's renderer, run
  // FBO-to-FBO instead of bouncing through canvases and a second GL
  // context. The effect shaders expect straight alpha and v=0 at the image
  // bottom; the stage textures are premultiplied and bottom-up, so wrap
  // with unpremult/premult passes — orientation already matches.
  let glslEffectsPipeline = null
  const ensureGlslEffectsPipeline = () => {
    if (glslEffectsPipeline) return glslEffectsPipeline
    const program = createProgram(gl, GLSL_EFFECT_VERTEX_SOURCE, GLSL_EFFECT_FRAGMENT_SOURCE, { a_position: 0, a_texCoord: 1 })
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const texCoordBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    const uniformLocations = new Map()
    const locate = (name) => {
      if (!uniformLocations.has(name)) {
        uniformLocations.set(name, gl.getUniformLocation(program, name))
      }
      return uniformLocations.get(name)
    }
    glslEffectsPipeline = { program, vao, locate }
    return glslEffectsPipeline
  }

  const runFullscreenTexturePass = (program, programUniforms, sourceTexture, target) => {
    bindTarget(target)
    gl.disable(gl.BLEND)
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.uniform1i(programUniforms.u_texture, 0)
    drawFullscreen()
  }

  // Apply GLSL effects to scratchA; the premultiplied result lands in
  // scratchB (returned) so callers composite straight from there.
  const runGlslEffectsPass = (effects, clipTime) => {
    const pipeline = ensureGlslEffectsPipeline()
    runFullscreenTexturePass(programs.unpremult, uniforms.unpremult, scratchA.texture, scratchB)
    bindTarget(scratchA)
    gl.disable(gl.BLEND)
    gl.useProgram(pipeline.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, scratchB.texture)
    gl.uniform1i(pipeline.locate('u_image'), 0)
    gl.uniform2f(pipeline.locate('u_texelSize'), 1 / width, 1 / height)
    const values = getAnimatedGlslEffectUniforms(effects, clipTime)
    for (const key of Object.keys(values)) {
      const location = pipeline.locate(`u_${key}`)
      if (location) gl.uniform1f(location, values[key])
    }
    gl.bindVertexArray(pipeline.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    runFullscreenTexturePass(programs.premult, uniforms.premult, scratchA.texture, scratchB)
    return scratchB
  }

  // Render one layer sample (a textured quad with homogeneous corners) into
  // the bound accumulation target with source-over semantics.
  const drawQuadSample = (texture, corners, weight, colorSettings, inputPremultiplied) => {
    for (let i = 0; i < 4; i++) {
      const corner = corners[i]
      layerVertexData[i * 5] = corner.x
      layerVertexData[i * 5 + 1] = corner.y
      layerVertexData[i * 5 + 2] = corner.u
      layerVertexData[i * 5 + 3] = corner.v
      layerVertexData[i * 5 + 4] = corner.w
    }
    gl.useProgram(programs.layer)
    gl.uniform2f(uniforms.layer.u_resolution, width, height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(uniforms.layer.u_texture, 0)
    gl.uniform1f(uniforms.layer.u_alpha, weight)
    gl.uniform1i(uniforms.layer.u_inputPremultiplied, inputPremultiplied ? 1 : 0)
    const applyColor = hasColorStages(colorSettings)
    gl.uniform1i(uniforms.layer.u_applyColor, applyColor ? 1 : 0)
    if (applyColor) {
      setColorUniforms(uniforms.layer, colorSettings)
    }
    gl.bindVertexArray(layerVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, layerVbo)
    gl.bufferData(gl.ARRAY_BUFFER, layerVertexData, gl.STREAM_DRAW)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  // Accumulate samples into scratchA (through the MSAA buffer when
  // available), then blur, then GLSL effects, then composite onto the stage.
  const renderLayerSamples = (samples, { colorSettings = null, blurPx = null, glslEffects = null, opacity = 1, blendMode = 'normal', inputPremultiplied = false }) => {
    const accumulationTarget = msaaFbo
      ? { fbo: msaaFbo, width, height }
      : scratchA
    bindTarget(accumulationTarget)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    setPremultipliedSourceOver()
    for (const sample of samples) {
      drawQuadSample(sample.texture, sample.corners, sample.weight ?? 1, colorSettings, inputPremultiplied)
    }
    if (msaaFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scratchA.fbo)
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    if (blurPx != null && blurPx > 0) {
      blurScratchA(blurPx)
    }
    let compositeSource = scratchA.texture
    if (glslEffects) {
      compositeSource = runGlslEffectsPass(glslEffects.effects, glslEffects.clipTime).texture
    }
    compositeOntoStage(compositeSource, opacity, blendMode)
  }

  const renderFinalToScratchB = () => {
    bindTarget(scratchB)
    gl.disable(gl.BLEND)
    gl.useProgram(programs.final)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, stages[stageIndex].texture)
    gl.uniform1i(uniforms.final.u_texture, 0)
    drawFullscreen()
  }

  return {
    canvas,
    width,
    height,

    isContextLost: () => contextLost || gl.isContextLost(),

    beginFrame() {
      stageIndex = 0
      bindTarget(stages[0])
      gl.clearColor(0, 0, 0, transparent ? 0 : 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },

    /**
     * Composite one clip layer.
     * samples: [{ source, sourceKey, sourceVersion, corners, weight }]
     *   corners: 4 corners (TL, TR, BL, BR order for a triangle strip) of
     *   { x, y (canvas px), u, v (source UV), w (1/projection) } — computed
     *   by the exporter's getClipQuadCorners so geometry math stays in one
     *   place.
     * colorSettings: normalized non-tonal adjustment settings or null.
     * glslEffects: { effects, clipTime } to run the shared GLSL effect
     * shader on the assembled layer (post-blur, pre-composite) — the same
     * device-space order as the 2D managed-effects path.
     */
    drawLayer({ samples, colorSettings = null, blurPx = null, glslEffects = null, opacity = 1, blendMode = 'normal', inputPremultiplied = false }) {
      const prepared = []
      for (const sample of samples) {
        if (!sample?.source || !sample?.corners) continue
        prepared.push({
          texture: uploadSource(sample.source, sample.sourceKey, sample.sourceVersion),
          corners: sample.corners,
          weight: sample.weight ?? 1,
        })
      }
      if (prepared.length === 0) return
      renderLayerSamples(prepared, { colorSettings, blurPx, glslEffects, opacity, blendMode, inputPremultiplied })
    },

    /**
     * Adjustment layer with only color/blur adjustments: color-grade the
     * current stage, optionally blur, then draw it back over the stage as a
     * transformed quad (camera shake on adjustment layers moves the whole
     * snapshot, matching the 2D path).
     */
    drawAdjustment({ corners, colorSettings = null, blurPx = null, glslEffects = null, opacity = 1, blendMode = 'normal' }) {
      bindTarget(scratchA)
      gl.disable(gl.BLEND)
      gl.useProgram(programs.colorPass)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, stages[stageIndex].texture)
      gl.uniform1i(uniforms.colorPass.u_texture, 0)
      setColorUniforms(uniforms.colorPass, colorSettings || {})
      drawFullscreen()
      if (blurPx != null && blurPx > 0) {
        blurScratchA(blurPx)
      }
      // The processed stage must end up in scratchB: renderLayerSamples
      // accumulates INTO scratchA, which would otherwise read and write the
      // same texture. The GLSL pass already lands there; otherwise copy.
      if (glslEffects) {
        runGlslEffectsPass(glslEffects.effects, glslEffects.clipTime)
      } else {
        blitOnto(scratchA.texture, scratchB, 1, false)
      }
      // scratchB's texture rows are bottom-up relative to canvas space, so
      // flip V in the UVs for the transformed draw back over the stage.
      const flippedCorners = corners.map((corner) => ({ ...corner, v: 1 - corner.v }))
      renderLayerSamples(
        [{ texture: scratchB.texture, corners: flippedCorners, weight: 1 }],
        { opacity, blendMode, inputPremultiplied: true }
      )
    },

    /** Full-frame color overlay (fade/dip/flash transitions). */
    drawFill(colorCss, opacity) {
      const [r, g, b] = parseCssColor(colorCss)
      const a = Math.max(0, Math.min(1, opacity))
      bindTarget(stages[stageIndex])
      setPremultipliedSourceOver()
      gl.useProgram(programs.fill)
      gl.uniform4f(uniforms.fill.u_color, r * a, g * a, b * a, a)
      drawFullscreen()
    },

    /**
     * Read the finished frame as straight-alpha, top-down RGBA — the exact
     * layout getImageData fed the FFmpeg pipe. Alternates between two
     * buffers so the previous frame's in-flight pipe write stays valid.
     */
    readFramePixels() {
      renderFinalToScratchB()
      const buffer = readbackBuffers[readbackIndex]
      readbackIndex = 1 - readbackIndex
      gl.bindFramebuffer(gl.FRAMEBUFFER, scratchB.fbo)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return buffer
    },

    /**
     * Snapshot the current stage into a 2D canvas context (straight alpha,
     * top-down). Used to hand the composited stage to the legacy 2D path
     * for adjustment-layer features not yet ported (tonal, GLSL, managed
     * pixel effects).
     */
    readStageIntoContext(ctx2d) {
      renderFinalToScratchB()
      const buffer = readbackBuffers[readbackIndex]
      gl.bindFramebuffer(gl.FRAMEBUFFER, scratchB.fbo)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const imageData = new ImageData(new Uint8ClampedArray(buffer.buffer.slice(0, width * height * 4)), width, height)
      ctx2d.putImageData(imageData, 0, 0)
    },

    dispose() {
      for (const entry of sourceTextures.values()) {
        gl.deleteTexture(entry.texture)
      }
      sourceTextures.clear()
      const loseContext = gl.getExtension('WEBGL_lose_context')
      if (loseContext) loseContext.loseContext()
    },
  }
}
