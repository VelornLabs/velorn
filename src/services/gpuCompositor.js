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
import {
  ADJUSTMENT_STAGES_GLSL,
  ADJUSTMENT_COLOR_PASS_FS,
  buildAdjustmentUniformValues,
} from '../utils/adjustmentsGpu'
import {
  VELOCITY_BLUR_VERTEX_SOURCE,
  VELOCITY_BLUR_FRAGMENT_SOURCE,
} from '../utils/velocityMotionBlur'

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

// Color stage + tonal math lives in utils/adjustmentsGpu.js — shared with
// the preview's standalone grade pass so both grade through one shader.

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
${ADJUSTMENT_STAGES_GLSL}
void main() {
  vec4 texel = texture(u_texture, v_uv);
  vec3 rgb = texel.rgb;
  float alpha = texel.a;
  if (u_inputPremultiplied && alpha > 0.0) {
    rgb /= alpha;
  }
  if (u_applyColor) {
    rgb = applyGroupStages(rgb, float[7](u_brightness, u_contrast, u_saturation, u_gain, u_gamma, u_offset, u_hue));
  }
  outColor = vec4(rgb * alpha, alpha) * u_alpha;
}
`

// Mask application mirroring the export path's luminance loop exactly: the
// layer's alpha is REPLACED by the mask's straight-rgb average luminance.
// Undrawn mask regions read luminance 0, so inverted masks make the area
// outside the clip opaque black — that is the 2D export's behavior (the
// preview's destination-in/out semantics differ; parity here is with
// export).
const MASK_FS = `#version 300 es
precision highp float;
uniform sampler2D u_layer;
uniform sampler2D u_mask;
uniform bool u_invert;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 layer = texture(u_layer, v_uv);
  vec4 mask = texture(u_mask, v_uv);
  vec3 maskRgb = mask.a > 0.0 ? mask.rgb / mask.a : vec3(0.0);
  float lum = (maskRgb.r + maskRgb.g + maskRgb.b) / 3.0;
  float alpha = u_invert ? 1.0 - lum : lum;
  vec3 layerRgb = layer.a > 0.0 ? layer.rgb / layer.a : vec3(0.0);
  outColor = vec4(layerRgb * alpha, alpha);
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

// ---- Managed pixel-effect passes ------------------------------------------
// GPU ports of the ImageData effects in utils/effects.js. They run on
// STRAIGHT alpha inside an unpremult/premult wrap (the 2D versions operate
// on getImageData values) and use texelFetch for pixel-exact sampling.
// Noise effects reconstruct the exact mulberry32 stream the CPU versions
// consume: the generator is counter-based, so the k-th call's output is a
// pure hash of (seed + k * 0x6D2B79F5).
const MULBERRY_GLSL = `
float mulberryAt(uint seed, uint k) {
  uint t = seed + k * 0x6D2B79F5u;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return float(t ^ (t >> 14)) / 4294967296.0;
}
`

// Chromatic aberration: red sampled at -shift, blue at +shift (canvas
// space; texture rows are flipped so the y offset negates). Out-of-bounds
// samples leave the channel unchanged, like the JS bounds check.
const CHROMAB_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform ivec2 u_size;
uniform ivec2 u_shift;
in vec2 v_uv;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = texelFetch(u_texture, p, 0);
  ivec2 redP = ivec2(p.x - u_shift.x, p.y + u_shift.y);
  if (redP.x >= 0 && redP.x < u_size.x && redP.y >= 0 && redP.y < u_size.y) {
    outColor.r = texelFetch(u_texture, redP, 0).r;
  }
  ivec2 blueP = ivec2(p.x + u_shift.x, p.y - u_shift.y);
  if (blueP.x >= 0 && blueP.x < u_size.x && blueP.y >= 0 && blueP.y < u_size.y) {
    outColor.b = texelFetch(u_texture, blueP, 0).b;
  }
}
`

// 5-tap cross unsharp kernel with edge-clamped samples, alpha preserved.
const SHARPEN_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform ivec2 u_size;
uniform float u_strength;
in vec2 v_uv;
out vec4 outColor;
ivec2 clampP(ivec2 p, ivec2 size) {
  return clamp(p, ivec2(0), size - 1);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 center = texelFetch(u_texture, p, 0);
  vec3 adjacent = texelFetch(u_texture, clampP(p + ivec2(-1, 0), u_size), 0).rgb
    + texelFetch(u_texture, clampP(p + ivec2(1, 0), u_size), 0).rgb
    + texelFetch(u_texture, clampP(p + ivec2(0, -1), u_size), 0).rgb
    + texelFetch(u_texture, clampP(p + ivec2(0, 1), u_size), 0).rgb;
  vec3 value = center.rgb * (1.0 + 4.0 * u_strength) - adjacent * u_strength;
  outColor = vec4(clamp(value, 0.0, 1.0), center.a);
}
`

// Film grain: one noise value (or RGB triple) per stride×stride block,
// consumed in the same row-major block order as the CPU loop.
const GRAIN_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform ivec2 u_size;
uniform uint u_seed;
uniform int u_stride;
uniform float u_strength;
uniform bool u_mono;
in vec2 v_uv;
out vec4 outColor;
${MULBERRY_GLSL}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int canvasY = u_size.y - 1 - p.y;
  int blocksPerRow = (u_size.x + u_stride - 1) / u_stride;
  int blockIndex = (canvasY / u_stride) * blocksPerRow + (p.x / u_stride);
  vec4 texel = texelFetch(u_texture, p, 0);
  vec3 rgb = texel.rgb;
  if (u_mono) {
    float n = (mulberryAt(u_seed, uint(blockIndex) + 1u) * 2.0 - 1.0) * u_strength;
    rgb = clamp(rgb + n, 0.0, 1.0);
  } else {
    uint base = uint(blockIndex) * 3u;
    rgb.r = clamp(rgb.r + (mulberryAt(u_seed, base + 1u) * 2.0 - 1.0) * u_strength, 0.0, 1.0);
    rgb.g = clamp(rgb.g + (mulberryAt(u_seed, base + 2u) * 2.0 - 1.0) * u_strength, 0.0, 1.0);
    rgb.b = clamp(rgb.b + (mulberryAt(u_seed, base + 3u) * 2.0 - 1.0) * u_strength, 0.0, 1.0);
  }
  outColor = vec4(rgb, texel.a);
}
`

// VHS damage: per-row shift/scanline/dropout parameters precomputed on the
// CPU into a height×1 float texture (they consume the random stream
// sequentially and conditionally); per-pixel noise reconstructed from the
// row's recorded stream position. Values are in the CPU version's 0–255
// units, normalized at use.
const VHS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform sampler2D u_rows;
uniform ivec2 u_size;
uniform uint u_seed;
uniform float u_noiseAmp;
uniform int u_bleed;
in vec2 v_uv;
out vec4 outColor;
${MULBERRY_GLSL}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int canvasY = u_size.y - 1 - p.y;
  vec4 row = texelFetch(u_rows, ivec2(canvasY, 0), 0);
  int sx = clamp(p.x - int(row.x), 0, u_size.x - 1);
  int redX = clamp(sx - u_bleed, 0, u_size.x - 1);
  int blueX = clamp(sx + u_bleed, 0, u_size.x - 1);
  vec4 src = texelFetch(u_texture, ivec2(sx, p.y), 0);
  float red = texelFetch(u_texture, ivec2(redX, p.y), 0).r;
  float blue = texelFetch(u_texture, ivec2(blueX, p.y), 0).b;
  float noise = (mulberryAt(u_seed, uint(row.w) + uint(p.x) + 1u) - 0.5) * u_noiseAmp + row.z;
  float scan = row.y;
  outColor = vec4(
    clamp(red + (noise - scan) / 255.0, 0.0, 1.0),
    clamp(src.g + (noise * 0.55 - scan) / 255.0, 0.0, 1.0),
    clamp(blue + (noise - scan) / 255.0, 0.0, 1.0),
    src.a
  );
}
`

// Glow pre-passes (premultiplied in/out, straight math inside).
const GLOW_THRESHOLD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_cutoff;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  vec3 rgb = texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  float range = max(1.0 / 255.0, 1.0 - u_cutoff);
  float k = max(0.0, (luma - u_cutoff) / range);
  outColor = vec4(rgb * (k * k) * texel.a, texel.a);
}
`

const HALATION_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_warmth;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  vec3 rgb = texel.a > 0.0 ? texel.rgb / texel.a : vec3(0.0);
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  vec3 tint = vec3(
    min(1.0, luma * (1.05 + u_warmth * 0.65)),
    min(1.0, luma * (0.55 + u_warmth * 0.22)),
    min(1.0, luma * (0.22 + u_warmth * 0.08))
  );
  outColor = vec4(tint * texel.a, texel.a);
}
`

// Vignette / letterbox: the canvas gradients drawn with source-atop reduce
// to darkening the premultiplied color by the gradient alpha (black
// overlays), leaving alpha untouched.
const VIGNETTE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_start;
uniform float u_full;
uniform float u_amount;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  float r = distance(gl_FragCoord.xy, u_resolution * 0.5);
  float k = clamp((r - u_start) / max(0.0001, u_full - u_start), 0.0, 1.0);
  outColor = vec4(texel.rgb * (1.0 - k * u_amount), texel.a);
}
`

const LETTERBOX_FS = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_barSize;
uniform float u_soft;
uniform float u_alpha;
uniform bool u_horizontal;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  float c = u_horizontal ? (u_resolution.y - gl_FragCoord.y) : gl_FragCoord.x;
  float dim = u_horizontal ? u_resolution.y : u_resolution.x;
  float edgeDist = min(c, dim - c);
  float bar = edgeDist <= u_barSize
    ? 1.0
    : (u_soft > 0.0 ? clamp(1.0 - (edgeDist - u_barSize) / u_soft, 0.0, 1.0) : 0.0);
  outColor = vec4(texel.rgb * (1.0 - bar * u_alpha), texel.a);
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
      colorPass: createProgram(gl, FULLSCREEN_VS, ADJUSTMENT_COLOR_PASS_FS),
      blit: createProgram(gl, FULLSCREEN_VS, BLIT_FS),
      fill: createProgram(gl, FULLSCREEN_VS, FILL_FS),
      blur: createProgram(gl, FULLSCREEN_VS, BLUR_FS),
      composite: createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS),
      final: createProgram(gl, FULLSCREEN_VS, FINAL_FS),
      unpremult: createProgram(gl, FULLSCREEN_VS, UNPREMULT_FS),
      premult: createProgram(gl, FULLSCREEN_VS, PREMULT_FS),
      mask: createProgram(gl, FULLSCREEN_VS, MASK_FS),
      chromab: createProgram(gl, FULLSCREEN_VS, CHROMAB_FS),
      sharpen: createProgram(gl, FULLSCREEN_VS, SHARPEN_FS),
      grain: createProgram(gl, FULLSCREEN_VS, GRAIN_FS),
      vhs: createProgram(gl, FULLSCREEN_VS, VHS_FS),
      glowThreshold: createProgram(gl, FULLSCREEN_VS, GLOW_THRESHOLD_FS),
      halation: createProgram(gl, FULLSCREEN_VS, HALATION_FS),
      vignette: createProgram(gl, FULLSCREEN_VS, VIGNETTE_FS),
      letterbox: createProgram(gl, FULLSCREEN_VS, LETTERBOX_FS),
    }
  } catch (err) {
    console.warn('[GPU Compositor] Shader init failed, falling back to 2D:', err?.message || err)
    return null
  }

  const uniforms = {
    layer: getUniforms(gl, programs.layer, [
      'u_resolution', 'u_texture', 'u_alpha', 'u_inputPremultiplied', 'u_applyColor', ...COLOR_UNIFORM_NAMES,
    ]),
    colorPass: getUniforms(gl, programs.colorPass, ['u_texture', 'u_global', 'u_shadows', 'u_midtones', 'u_highlights', 'u_groupActive']),
    blit: getUniforms(gl, programs.blit, ['u_texture', 'u_opacity']),
    fill: getUniforms(gl, programs.fill, ['u_color']),
    blur: getUniforms(gl, programs.blur, ['u_texture', 'u_direction', 'u_sigma', 'u_taps']),
    composite: getUniforms(gl, programs.composite, ['u_dst', 'u_src', 'u_opacity', 'u_blendMode']),
    final: getUniforms(gl, programs.final, ['u_texture']),
    unpremult: getUniforms(gl, programs.unpremult, ['u_texture']),
    premult: getUniforms(gl, programs.premult, ['u_texture']),
    mask: getUniforms(gl, programs.mask, ['u_layer', 'u_mask', 'u_invert']),
    chromab: getUniforms(gl, programs.chromab, ['u_texture', 'u_size', 'u_shift']),
    sharpen: getUniforms(gl, programs.sharpen, ['u_texture', 'u_size', 'u_strength']),
    grain: getUniforms(gl, programs.grain, ['u_texture', 'u_size', 'u_seed', 'u_stride', 'u_strength', 'u_mono']),
    vhs: getUniforms(gl, programs.vhs, ['u_texture', 'u_rows', 'u_size', 'u_seed', 'u_noiseAmp', 'u_bleed']),
    glowThreshold: getUniforms(gl, programs.glowThreshold, ['u_texture', 'u_cutoff']),
    halation: getUniforms(gl, programs.halation, ['u_texture', 'u_warmth']),
    vignette: getUniforms(gl, programs.vignette, ['u_texture', 'u_resolution', 'u_start', 'u_full', 'u_amount']),
    letterbox: getUniforms(gl, programs.letterbox, ['u_texture', 'u_resolution', 'u_barSize', 'u_soft', 'u_alpha', 'u_horizontal']),
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
  let maskScratch = null // lazy third full-res target; only mask users pay
  const getMaskScratch = () => {
    if (!maskScratch) maskScratch = createTarget(width, height)
    return maskScratch
  }

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

  const setColorPassUniforms = (settings) => {
    const values = buildAdjustmentUniformValues(settings)
    gl.uniform1fv(uniforms.colorPass.u_global, values.global)
    gl.uniform1fv(uniforms.colorPass.u_shadows, values.shadows)
    gl.uniform1fv(uniforms.colorPass.u_midtones, values.midtones)
    gl.uniform1fv(uniforms.colorPass.u_highlights, values.highlights)
    gl.uniform1fv(uniforms.colorPass.u_groupActive, values.groupActive)
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

  // Gaussian blur of `target` in place (via `temp`), approximating CSS
  // blur(px). Large radii run at reduced resolution like Chromium does.
  const runGaussianBlur = (target, temp, blurPx) => {
    const sigma = Math.max(0.01, Number(blurPx) || 0)
    if (sigma <= 0.01) return
    const factor = sigma <= 8 ? 1 : (sigma <= 24 ? 2 : 4)
    const effectiveSigma = sigma / factor
    const taps = Math.min(MAX_BLUR_TAPS, Math.max(1, Math.ceil(effectiveSigma * 3)))
    if (factor === 1) {
      runBlurPass(target.texture, temp, [1, 0], effectiveSigma, taps)
      runBlurPass(temp.texture, target, [0, 1], effectiveSigma, taps)
      return
    }
    const [smallA, smallB] = getDownsamplePair(factor)
    blitOnto(target.texture, smallA, 1, false)
    runBlurPass(smallA.texture, smallB, [1, 0], effectiveSigma, taps)
    runBlurPass(smallB.texture, smallA, [0, 1], effectiveSigma, taps)
    blitOnto(smallA.texture, target, 1, false)
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

  // ---- ES-1.00 effect pipelines (glslEffects / velocityMotionBlur) ------
  // Both ports run the original shaders verbatim, FBO-to-FBO instead of
  // bouncing through canvases and second GL contexts. They expect straight
  // alpha and v=0 at the image bottom; the stage textures are premultiplied
  // and bottom-up, so callers wrap them in unpremult/premult passes —
  // orientation already matches.
  let es1QuadVao = null
  const ensureEs1QuadVao = () => {
    if (es1QuadVao) return es1QuadVao
    es1QuadVao = gl.createVertexArray()
    gl.bindVertexArray(es1QuadVao)
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
    return es1QuadVao
  }
  const createEs1Pipeline = (vsSource, fsSource) => {
    const program = createProgram(gl, vsSource, fsSource, { a_position: 0, a_texCoord: 1 })
    const uniformLocations = new Map()
    const locate = (name) => {
      if (!uniformLocations.has(name)) {
        uniformLocations.set(name, gl.getUniformLocation(program, name))
      }
      return uniformLocations.get(name)
    }
    return { program, vao: ensureEs1QuadVao(), locate }
  }
  let glslEffectsPipeline = null
  const ensureGlslEffectsPipeline = () => (
    glslEffectsPipeline || (glslEffectsPipeline = createEs1Pipeline(GLSL_EFFECT_VERTEX_SOURCE, GLSL_EFFECT_FRAGMENT_SOURCE))
  )
  let velocityPipeline = null
  const ensureVelocityPipeline = () => (
    velocityPipeline || (velocityPipeline = createEs1Pipeline(VELOCITY_BLUR_VERTEX_SOURCE, VELOCITY_BLUR_FRAGMENT_SOURCE))
  )

  // Bind everything for a fullscreen pass; the caller may set extra
  // uniforms before drawFullscreen().
  const beginFullscreenPass = (program, programUniforms, sourceTexture, target) => {
    bindTarget(target)
    gl.disable(gl.BLEND)
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    gl.uniform1i(programUniforms.u_texture, 0)
  }

  const runFullscreenTexturePass = (program, programUniforms, sourceTexture, target) => {
    beginFullscreenPass(program, programUniforms, sourceTexture, target)
    drawFullscreen()
  }

  // Apply GLSL effects to `cur`; the premultiplied result lands in `other`
  // (three hops: unpremult cur→other, effect other→cur, premult cur→other).
  const runGlslEffectsPass = (effects, clipTime, cur, other) => {
    const pipeline = ensureGlslEffectsPipeline()
    runFullscreenTexturePass(programs.unpremult, uniforms.unpremult, cur.texture, other)
    bindTarget(cur)
    gl.disable(gl.BLEND)
    gl.useProgram(pipeline.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, other.texture)
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
    runFullscreenTexturePass(programs.premult, uniforms.premult, cur.texture, other)
  }

  // Velocity motion blur — utils/velocityMotionBlur.js's shader, same
  // three-hop wrap; the premultiplied result lands in `other`.
  const runVelocityPass = (values, cur, other) => {
    const pipeline = ensureVelocityPipeline()
    runFullscreenTexturePass(programs.unpremult, uniforms.unpremult, cur.texture, other)
    bindTarget(cur)
    gl.disable(gl.BLEND)
    gl.useProgram(pipeline.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, other.texture)
    gl.uniform1i(pipeline.locate('u_image'), 0)
    gl.uniform2f(pipeline.locate('u_texelSize'), 1 / width, 1 / height)
    gl.uniform2f(pipeline.locate('u_velocityPx'), values.velocityPx[0], values.velocityPx[1])
    gl.uniform1f(pipeline.locate('u_samples'), values.samples)
    gl.uniform1f(pipeline.locate('u_sharpness'), values.sharpness)
    gl.uniform1f(pipeline.locate('u_falloff'), values.falloff)
    gl.uniform1f(pipeline.locate('u_center'), values.center)
    gl.bindVertexArray(pipeline.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    runFullscreenTexturePass(programs.premult, uniforms.premult, cur.texture, other)
  }

  // Per-row VHS parameters, re-uploaded per pass (height×1 RGBA32F —
  // sampling float textures is core WebGL2; only rendering to them needs
  // an extension).
  let vhsRowTexture = null
  const uploadVhsRows = (rowData) => {
    if (!vhsRowTexture) {
      vhsRowTexture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, vhsRowTexture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, vhsRowTexture)
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, rowData.length / 4, 1, 0, gl.RGBA, gl.FLOAT, rowData)
    return vhsRowTexture
  }

  const PIXEL_PASS_TYPES = new Set(['chromaticAberration', 'sharpen', 'filmGrain', 'vhsDamage'])

  // Managed-effect chain over the assembled layer, in
  // applyClipManagedEffectsToOffCanvas order (pixel effects → glow → GLSL →
  // vignette → letterbox). cur/other stay within the scratchA/scratchB
  // pair; maskScratch doubles as the glow buffer (mask work has already
  // finished when this runs). Returns [cur, other].
  const runManagedPassChain = (passes, startCur, startOther) => {
    let cur = startCur
    let other = startOther
    const swap = () => { const t = cur; cur = other; other = t }

    // Pixel passes operate on straight alpha; group them in one wrap.
    const pixelPasses = passes.filter((pass) => PIXEL_PASS_TYPES.has(pass.type))
    if (pixelPasses.length > 0) {
      runFullscreenTexturePass(programs.unpremult, uniforms.unpremult, cur.texture, other)
      swap()
      for (const pass of pixelPasses) {
        if (pass.type === 'chromaticAberration') {
          beginFullscreenPass(programs.chromab, uniforms.chromab, cur.texture, other)
          gl.uniform2i(uniforms.chromab.u_size, width, height)
          gl.uniform2i(uniforms.chromab.u_shift, pass.dx, pass.dy)
        } else if (pass.type === 'sharpen') {
          beginFullscreenPass(programs.sharpen, uniforms.sharpen, cur.texture, other)
          gl.uniform2i(uniforms.sharpen.u_size, width, height)
          gl.uniform1f(uniforms.sharpen.u_strength, pass.strength)
        } else if (pass.type === 'filmGrain') {
          beginFullscreenPass(programs.grain, uniforms.grain, cur.texture, other)
          gl.uniform2i(uniforms.grain.u_size, width, height)
          gl.uniform1ui(uniforms.grain.u_seed, pass.seed)
          gl.uniform1i(uniforms.grain.u_stride, pass.stride)
          gl.uniform1f(uniforms.grain.u_strength, pass.strength)
          gl.uniform1i(uniforms.grain.u_mono, pass.monochrome ? 1 : 0)
        } else {
          const rows = uploadVhsRows(pass.rowData)
          beginFullscreenPass(programs.vhs, uniforms.vhs, cur.texture, other)
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, rows)
          gl.uniform1i(uniforms.vhs.u_rows, 1)
          gl.uniform2i(uniforms.vhs.u_size, width, height)
          gl.uniform1ui(uniforms.vhs.u_seed, pass.seed)
          gl.uniform1f(uniforms.vhs.u_noiseAmp, pass.noiseAmp)
          gl.uniform1i(uniforms.vhs.u_bleed, pass.bleedPx)
        }
        drawFullscreen()
        swap()
      }
      runFullscreenTexturePass(programs.premult, uniforms.premult, cur.texture, other)
      swap()
    }

    for (const pass of passes) {
      if (pass.type === 'glow') {
        const glowBuffer = getMaskScratch()
        blitOnto(cur.texture, glowBuffer, 1, false)
        if (pass.hasThreshold) {
          beginFullscreenPass(programs.glowThreshold, uniforms.glowThreshold, glowBuffer.texture, other)
          gl.uniform1f(uniforms.glowThreshold.u_cutoff, pass.cutoff)
          drawFullscreen()
          blitOnto(other.texture, glowBuffer, 1, false)
        }
        if (pass.halation) {
          beginFullscreenPass(programs.halation, uniforms.halation, glowBuffer.texture, other)
          gl.uniform1f(uniforms.halation.u_warmth, pass.warmth)
          drawFullscreen()
          blitOnto(other.texture, glowBuffer, 1, false)
        }
        runGaussianBlur(glowBuffer, other, pass.blurPx)
        // Screen-blend the glow over the layer via the shared composite
        // shader (canvas 'screen' + globalAlpha semantics).
        bindTarget(other)
        gl.disable(gl.BLEND)
        gl.useProgram(programs.composite)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, cur.texture)
        gl.uniform1i(uniforms.composite.u_dst, 0)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, glowBuffer.texture)
        gl.uniform1i(uniforms.composite.u_src, 1)
        gl.uniform1f(uniforms.composite.u_opacity, pass.opacity)
        gl.uniform1i(uniforms.composite.u_blendMode, BLEND_MODE_IDS.screen)
        drawFullscreen()
        swap()
      } else if (pass.type === 'glslEffects') {
        runGlslEffectsPass(pass.effects, pass.clipTime, cur, other)
        swap()
      } else if (pass.type === 'vignette') {
        beginFullscreenPass(programs.vignette, uniforms.vignette, cur.texture, other)
        gl.uniform2f(uniforms.vignette.u_resolution, width, height)
        gl.uniform1f(uniforms.vignette.u_start, pass.startRadius)
        gl.uniform1f(uniforms.vignette.u_full, pass.fullRadius)
        gl.uniform1f(uniforms.vignette.u_amount, pass.amount)
        drawFullscreen()
        swap()
      } else if (pass.type === 'letterbox') {
        beginFullscreenPass(programs.letterbox, uniforms.letterbox, cur.texture, other)
        gl.uniform2f(uniforms.letterbox.u_resolution, width, height)
        gl.uniform1f(uniforms.letterbox.u_barSize, pass.barSize)
        gl.uniform1f(uniforms.letterbox.u_soft, pass.soft)
        gl.uniform1f(uniforms.letterbox.u_alpha, pass.alpha)
        gl.uniform1i(uniforms.letterbox.u_horizontal, pass.horizontal ? 1 : 0)
        drawFullscreen()
        swap()
      }
    }
    return [cur, other]
  }

  // Global + tonal color grade of `cur` into `other` (premultiplied in/out).
  const runColorPass = (settings, cur, other) => {
    bindTarget(other)
    gl.disable(gl.BLEND)
    gl.useProgram(programs.colorPass)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, cur.texture)
    gl.uniform1i(uniforms.colorPass.u_texture, 0)
    setColorPassUniforms(settings || {})
    drawFullscreen()
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

  // Draw quads into `resolveTarget` (through the MSAA buffer when
  // available) with premultiplied source-over accumulation.
  const accumulateSamples = (samples, colorSettings, inputPremultiplied, resolveTarget) => {
    const accumulationTarget = msaaFbo
      ? { fbo: msaaFbo, width, height }
      : resolveTarget
    bindTarget(accumulationTarget)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    setPremultipliedSourceOver()
    for (const sample of samples) {
      drawQuadSample(sample.texture, sample.corners, sample.weight ?? 1, colorSettings, inputPremultiplied)
    }
    if (msaaFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolveTarget.fbo)
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
  }

  // Assemble one layer and composite it onto the stage. The pass order
  // matches the 2D recipes exactly:
  //   accumulate (per-sample color) → pre-blur → velocity blur → mask blur
  //   → mask apply → tonal → blur → managed chain (pixel fx → glow → GLSL
  //   → vignette → letterbox) → post color → post blur → composite.
  // Plain clips use colorSettings+preBlurPx (draw-time filter position);
  // tonal clips use tonalSettings+blurPx (color handled post-accumulation
  // like applyAdvancedAdjustments); masked clips use mask.blurPx pre-apply
  // and postColorSettings/postBlurPx (color applied at composite time in
  // the 2D path).
  const renderLayerSamples = (samples, {
    colorSettings = null,
    preBlurPx = null,
    velocity = null,
    mask = null,
    tonalSettings = null,
    blurPx = null,
    managedPasses = null,
    postColorSettings = null,
    postBlurPx = null,
    opacity = 1,
    blendMode = 'normal',
    inputPremultiplied = false,
  }) => {
    let cur = scratchA
    let other = scratchB
    const swap = () => { const t = cur; cur = other; other = t }

    accumulateSamples(samples, colorSettings, inputPremultiplied, cur)

    if (preBlurPx != null && preBlurPx > 0) {
      runGaussianBlur(cur, other, preBlurPx)
    }

    if (velocity) {
      runVelocityPass(velocity, cur, other)
      swap()
    }

    if (mask) {
      const maskTarget = getMaskScratch()
      accumulateSamples([{ texture: mask.texture, corners: mask.corners, weight: 1 }], null, false, maskTarget)
      if (mask.blurPx != null && mask.blurPx > 0) {
        runGaussianBlur(cur, other, mask.blurPx)
        runGaussianBlur(maskTarget, other, mask.blurPx)
      }
      bindTarget(other)
      gl.disable(gl.BLEND)
      gl.useProgram(programs.mask)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, cur.texture)
      gl.uniform1i(uniforms.mask.u_layer, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, maskTarget.texture)
      gl.uniform1i(uniforms.mask.u_mask, 1)
      gl.uniform1i(uniforms.mask.u_invert, mask.invert ? 1 : 0)
      drawFullscreen()
      swap()
    }

    if (tonalSettings) {
      runColorPass(tonalSettings, cur, other)
      swap()
    }

    if (blurPx != null && blurPx > 0) {
      runGaussianBlur(cur, other, blurPx)
    }

    if (managedPasses && managedPasses.length > 0) {
      const [nextCur, nextOther] = runManagedPassChain(managedPasses, cur, other)
      cur = nextCur
      other = nextOther
    }

    if (postColorSettings) {
      runColorPass(postColorSettings, cur, other)
      swap()
    }

    if (postBlurPx != null && postBlurPx > 0) {
      runGaussianBlur(cur, other, postBlurPx)
    }

    compositeOntoStage(cur.texture, opacity, blendMode)
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
     * colorSettings: normalized non-tonal adjustment settings applied
     * per-sample (plain clips). preBlurPx: gaussian right after
     * accumulation (draw-time filter position). velocity: uniform values
     * from buildVelocityBlurUniformValues. tonalSettings: full settings
     * incl. tonal groups, applied post-accumulation. mask: { source,
     * sourceKey, sourceVersion, corners, invert, blurPx } —
     * alpha-replacement mask. managedPasses: descriptors from
     * buildManagedEffectGpuPasses (pixel fx → glow → GLSL → vignette →
     * letterbox). postColorSettings/postBlurPx: color+blur applied after
     * the managed chain (masked clips, where the 2D path filtered at
     * composite time).
     */
    drawLayer({
      samples,
      colorSettings = null,
      preBlurPx = null,
      velocity = null,
      mask = null,
      tonalSettings = null,
      blurPx = null,
      managedPasses = null,
      postColorSettings = null,
      postBlurPx = null,
      opacity = 1,
      blendMode = 'normal',
      inputPremultiplied = false,
    }) {
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
      let preparedMask = null
      if (mask?.source && mask?.corners) {
        preparedMask = {
          texture: uploadSource(mask.source, mask.sourceKey, mask.sourceVersion),
          corners: mask.corners,
          invert: !!mask.invert,
          blurPx: mask.blurPx ?? null,
        }
      }
      renderLayerSamples(prepared, {
        colorSettings,
        preBlurPx,
        velocity,
        mask: preparedMask,
        tonalSettings,
        blurPx,
        managedPasses,
        postColorSettings,
        postBlurPx,
        opacity,
        blendMode,
        inputPremultiplied,
      })
    },

    /**
     * Adjustment layer with only color/blur adjustments: color-grade the
     * current stage, optionally blur, then draw it back over the stage as a
     * transformed quad (camera shake on adjustment layers moves the whole
     * snapshot, matching the 2D path).
     */
    drawAdjustment({ corners, colorSettings = null, blurPx = null, managedPasses = null, opacity = 1, blendMode = 'normal' }) {
      // colorSettings may include tonal groups — the color pass handles
      // global + shadows/midtones/highlights in one shader.
      runColorPass(colorSettings || {}, stages[stageIndex], scratchA)
      if (blurPx != null && blurPx > 0) {
        runGaussianBlur(scratchA, scratchB, blurPx)
      }
      let processed = scratchA
      if (managedPasses && managedPasses.length > 0) {
        const [chainResult] = runManagedPassChain(managedPasses, scratchA, scratchB)
        processed = chainResult
      }
      // renderLayerSamples accumulates INTO scratchA; the source it samples
      // must not alias it.
      if (processed === scratchA) {
        blitOnto(scratchA.texture, scratchB, 1, false)
        processed = scratchB
      }
      // The processed stage's texture rows are bottom-up relative to canvas
      // space, so flip V in the UVs for the transformed draw back over the
      // stage.
      const flippedCorners = corners.map((corner) => ({ ...corner, v: 1 - corner.v }))
      renderLayerSamples(
        [{ texture: processed.texture, corners: flippedCorners, weight: 1 }],
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
     * Blit the finished stage to the compositor's own canvas (the default
     * framebuffer) for live-preview display. The stage is premultiplied and
     * bottom-up, which matches the default framebuffer's presentation, so a
     * plain blit shows upright. Callers drawImage(compositor.canvas) into
     * their display canvas in the same task (the drawing buffer is not
     * preserved across frames).
     */
    present() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.disable(gl.BLEND)
      gl.useProgram(programs.blit)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, stages[stageIndex].texture)
      gl.uniform1i(uniforms.blit.u_texture, 0)
      gl.uniform1f(uniforms.blit.u_opacity, 1)
      drawFullscreen()
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
