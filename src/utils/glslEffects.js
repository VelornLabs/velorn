import { getAnimatedEffectSettings } from './effects'

const GLSL_EFFECT_IDS = new Set([
  'glslCameraShake',
  'glslDirectionalBlur',
  'glslLensBlur',
  'glslFisheye',
  'glslChromaWarp',
  'glslDigitalGlitch',
  'glslSharpen',
  'glslFilmGrain',
  'glslFilmLook',
  'glslFlicker',
  'glslVhsLook',
  'glslVignette',
])

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`

const FRAGMENT_SHADER_SOURCE = `
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_texelSize;
uniform float u_shakeAmount;
uniform float u_shakeSpeed;
uniform float u_shakePosition;
uniform float u_shakeRotation;
uniform float u_shakeZoom;
uniform float u_shakeMotionBlur;
uniform float u_shakeSamples;
uniform float u_shakeSeed;
uniform float u_shakeTime;
uniform float u_dirBlurAmount;
uniform float u_dirBlurAngle;
uniform float u_dirBlurSamples;
uniform float u_dirBlurGain;
uniform float u_lensRadius;
uniform float u_lensSides;
uniform float u_lensHighlights;
uniform float u_lensThreshold;
uniform float u_lensChroma;
uniform float u_lensSamples;
uniform float u_fisheyeAmount;
uniform float u_fisheyeZoom;
uniform float u_chromaWarpAmount;
uniform float u_chromaWarpDistortion;
uniform float u_chromaWarpSaturation;
uniform float u_chromaWarpIterations;
uniform float u_glitchAmount;
uniform float u_glitchSpeed;
uniform float u_glitchSlice;
uniform float u_glitchRgbOffset;
uniform float u_glitchBlockiness;
uniform float u_glitchBwNoise;
uniform float u_glitchSeed;
uniform float u_sharpenAmount;
uniform float u_grainAmount;
uniform float u_grainSize;
uniform float u_grainColor;
uniform float u_grainStock;
uniform float u_grainTime;
uniform float u_filmLookBlend;
uniform float u_filmLookLook;
uniform float u_filmLookSaturation;
uniform float u_filmLookContrast;
uniform float u_filmLookGamma;
uniform float u_flickerAmount;
uniform float u_flickerSpeed;
uniform float u_flickerBrightness;
uniform float u_flickerSaturation;
uniform float u_flickerContrast;
uniform float u_flickerSeed;
uniform float u_vhsAmount;
uniform float u_vhsResolution;
uniform float u_vhsWave;
uniform float u_vhsBleed;
uniform float u_vhsScanlines;
uniform float u_vhsTint;
uniform float u_vhsSpeed;
uniform float u_vignetteAmount;
uniform float u_vignetteSize;
uniform float u_vignetteSoftness;
varying vec2 v_texCoord;

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 adjustSaturation(vec3 color, float saturation) {
  return mix(vec3(luminance(color)), color, saturation);
}

vec3 adjustContrast(vec3 color, float contrast) {
  return (color - vec3(0.5)) * contrast + vec3(0.5);
}

vec2 fisheyeUv(vec2 uv) {
  if (abs(u_fisheyeAmount) <= 0.001) return uv;
  vec2 center = vec2(0.5);
  vec2 delta = uv - center;
  float radius2 = dot(delta, delta);
  float amount = clamp(u_fisheyeAmount, -1.0, 1.0);
  float factor = 1.0 + amount * radius2 * 1.85;
  vec2 warped = center + delta / max(0.05, factor);
  float zoom = mix(1.0, 1.0 + abs(amount) * 0.42, clamp(u_fisheyeZoom, 0.0, 1.0));
  return center + (warped - center) / zoom;
}

vec4 sampleBaseSource(vec2 uv) {
  return texture2D(u_image, fisheyeUv(uv));
}

float shakeHash(float n) {
  return fract(sin(n) * 43758.5453123);
}

float shakeNoise(vec2 x) {
  vec2 p = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n = p.x + p.y * 157.0;
  return mix(
    mix(shakeHash(n + 0.0), shakeHash(n + 1.0), f.x),
    mix(shakeHash(n + 157.0), shakeHash(n + 158.0), f.x),
    f.y
  );
}

float shakeFbm(vec2 p) {
  mat2 m = mat2(0.80, -0.60, 0.60, 0.80);
  float f = 0.0;
  f += 0.5000 * shakeNoise(p); p = m * p * 2.02;
  f += 0.2500 * shakeNoise(p); p = m * p * 2.03;
  f += 0.1250 * shakeNoise(p); p = m * p * 2.01;
  f += 0.0625 * shakeNoise(p);
  return f / 0.9375;
}

vec2 shakeUv(vec2 uv, float timeOffset) {
  float aspect = u_texelSize.y / max(0.000001, u_texelSize.x);
  float t = max(0.0, u_shakeTime + timeOffset) * max(0.01, u_shakeSpeed) * 0.22;
  float seed = u_shakeSeed;

  vec2 centered = uv - vec2(0.5);
  centered.x *= aspect;

  float rotNoise = shakeFbm(vec2(t + seed * 0.013 + 56.78, t * 0.37 + seed * 0.017 + 12.4)) - 0.5;
  float rotation = rotNoise * u_shakeRotation * u_shakeAmount * 0.16;
  mat2 rot = mat2(cos(rotation), -sin(rotation), sin(rotation), cos(rotation));
  centered = rot * centered;

  float autoZoom = 1.0 + u_shakeAmount * (
    0.025 + u_shakePosition * 0.08 + u_shakeRotation * 0.035 + u_shakeZoom * 0.07
  );
  float zoomNoise = shakeFbm(vec2(t * 0.61 + seed * 0.011 + 24.23, t * 0.29 + seed * 0.019 + 91.35)) - 0.5;
  float zoom = autoZoom + zoomNoise * u_shakeZoom * u_shakeAmount * 0.09;
  centered /= max(0.1, zoom);

  centered.x /= aspect;

  vec2 posNoise = vec2(
    shakeFbm(vec2(t * 0.70 + seed * 0.007 + 344.14, t * 0.23 + seed * 0.013 + 123.51)),
    shakeFbm(vec2(t * 0.68 + seed * 0.009 + 546.35, t * 0.31 + seed * 0.017 + 5.45))
  ) - vec2(0.5);
  vec2 offset = posNoise * u_shakePosition * u_shakeAmount * vec2(0.12, 0.12);

  return centered + vec2(0.5) - offset;
}

vec4 sampleShakenSource(vec2 uv) {
  if (u_shakeAmount <= 0.001) {
    return sampleBaseSource(uv);
  }

  float samples = clamp(u_shakeSamples, 1.0, 24.0);
  float shutter = u_shakeMotionBlur * 0.08;
  vec4 accum = vec4(0.0);
  float total = 0.0;

  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    if (fi < samples) {
      float denom = max(1.0, samples - 1.0);
      float offset = (fi / denom - 0.5) * shutter;
      vec2 shakenUv = shakeUv(uv, offset);
      accum += sampleBaseSource(shakenUv);
      total += 1.0;
    }
  }

  return accum / max(1.0, total);
}

vec4 spectrumOffset(float t) {
  float lo = step(t, 0.5);
  float hi = 1.0 - lo;
  float x = clamp((t - 0.166667) / 0.666667, 0.0, 1.0);
  float w = clamp(1.0 - abs(2.0 * x - 1.0), 0.0, 1.0);
  vec3 rgb = vec3(lo, 1.0, hi) * vec3(1.0 - w, w, 1.0 - w);
  return vec4(rgb, luminance(rgb));
}

vec2 chromaWarpUv(vec2 uv, float amount) {
  vec2 center = vec2(0.5);
  vec2 cc = uv - center;
  float distortion = dot(cc * 0.3, cc);
  return uv + cc * amount * -0.05 - cc * distortion * u_chromaWarpDistortion;
}

vec4 applyChromaWarp(vec2 uv) {
  vec4 sumColor = vec4(0.0);
  vec4 sumWeight = vec4(0.0);
  float iterations = clamp(u_chromaWarpIterations, 4.0, 32.0);

  for (int i = 0; i < 32; i++) {
    float fi = float(i);
    if (fi < iterations) {
      float t = fi / max(1.0, iterations - 1.0);
      vec4 spectrum = spectrumOffset(t);
      vec4 weight = mix(vec4(1.0), spectrum, u_chromaWarpSaturation);
      vec2 warpedUv = chromaWarpUv(uv, u_chromaWarpAmount * t);
      sumColor += weight * sampleShakenSource(warpedUv);
      sumWeight += weight;
    }
  }

  return sumColor / max(sumWeight, vec4(0.0001));
}

vec3 applyDirectionalBlur(vec2 uv, vec3 baseColor) {
  if (u_dirBlurAmount <= 0.001) return baseColor;

  float samples = clamp(u_dirBlurSamples, 4.0, 32.0);
  vec2 direction = vec2(cos(u_dirBlurAngle), sin(u_dirBlurAngle)) * u_dirBlurAmount * u_texelSize;
  float jitter = shakeHash(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + u_shakeTime * 17.0) - 0.5;
  vec3 accum = vec3(0.0);
  float total = 0.0;

  for (int i = 0; i < 32; i++) {
    float fi = float(i);
    if (fi < samples) {
      float p = ((fi + jitter) / max(1.0, samples - 1.0)) - 0.5;
      float weight = 1.0 - abs(p * 2.0);
      accum += sampleShakenSource(uv + direction * p).rgb * weight;
      total += weight;
    }
  }

  return clamp((accum / max(0.0001, total)) * u_dirBlurGain, 0.0, 1.0);
}

vec3 applyDigitalGlitch(vec2 uv, vec3 currentColor) {
  if (u_glitchAmount <= 0.001) return currentColor;

  float t = floor(u_grainTime * max(0.01, u_glitchSpeed) * 6.0);
  float seed = u_glitchSeed * 0.013;
  float activity = mix(0.25, 1.0, shakeNoise(vec2(t * 0.11 + seed, t * 0.07 + seed * 2.0)));
  float amount = clamp(u_glitchAmount * activity, 0.0, 1.0);

  float rows = mix(12.0, 140.0, clamp(u_glitchBlockiness, 0.0, 1.0));
  float row = floor(uv.y * rows);
  float rowNoise = shakeNoise(vec2(row + seed * 37.0, t + seed * 11.0));
  float sliceMask = smoothstep(1.0 - amount * 0.75, 1.0, rowNoise);
  float sliceShift = (shakeNoise(vec2(row * 3.17 + seed, t * 2.0)) - 0.5) * u_glitchSlice * amount * sliceMask;

  vec2 blockGrid = vec2(mix(18.0, 90.0, u_glitchBlockiness), mix(10.0, 70.0, u_glitchBlockiness));
  vec2 block = floor(uv * blockGrid);
  float blockNoise = shakeNoise(block + vec2(t * 0.37 + seed, seed * 9.0));
  float blockMask = smoothstep(1.0 - amount * mix(0.15, 0.55, u_glitchBlockiness), 1.0, blockNoise);
  vec2 blockShift = (vec2(
    shakeNoise(block + vec2(13.0, t + seed)),
    shakeNoise(block + vec2(t + seed, 29.0))
  ) - 0.5) * u_glitchBlockiness * amount * blockMask * vec2(0.08, 0.025);

  vec2 glitchUv = uv + vec2(sliceShift, 0.0) + blockShift;
  float splitSign = sign(shakeNoise(vec2(row + t, seed)) - 0.5);
  vec2 split = vec2(u_glitchRgbOffset * u_texelSize.x * splitSign * amount, 0.0);

  vec3 col;
  col.r = sampleShakenSource(glitchUv + split * 1.2).r;
  col.g = sampleShakenSource(glitchUv).g;
  col.b = sampleShakenSource(glitchUv - split * 1.4).b;

  float lineMask = smoothstep(1.0 - amount * 0.38, 1.0, shakeNoise(vec2(row * 5.0, t * 2.0 + seed)));
  col = mix(col, vec3(0.0, luminance(col) * 1.7, 0.0), lineMask * amount);

  if (u_glitchBwNoise > 0.001) {
    float bwMask = smoothstep(1.0 - u_glitchBwNoise * amount, 1.0, blockNoise);
    float bit = step(0.5, luminance(col) + (shakeNoise(gl_FragCoord.xy * 0.25 + vec2(t)) - 0.5) * 0.25);
    col = mix(col, vec3(bit), bwMask * u_glitchBwNoise);
  }

  return clamp(mix(currentColor, col, amount), 0.0, 1.0);
}

float polygonApertureScale(float angle, float sides) {
  float sector = TAU / max(3.0, sides);
  float local = mod(angle + sector * 0.5, sector) - sector * 0.5;
  return cos(sector * 0.5) / max(0.18, cos(local));
}

vec3 lensBlurSample(vec2 uv, vec2 dir, float radiusNorm) {
  vec2 chromaOffset = dir * u_lensChroma * radiusNorm * u_texelSize;
  vec3 sampleColor = texture2D(u_image, uv).rgb;
  if (u_lensChroma > 0.001) {
    sampleColor.r = texture2D(u_image, uv + chromaOffset).r;
    sampleColor.b = texture2D(u_image, uv - chromaOffset).b;
  }

  float highlight = smoothstep(u_lensThreshold, 1.0, luminance(sampleColor));
  sampleColor *= 1.0 + highlight * u_lensHighlights;
  return sampleColor;
}

vec3 applyLensBlur(vec2 uv, vec3 baseColor) {
  vec3 accum = baseColor;
  float total = 1.0;
  float sampleCount = clamp(u_lensSamples, 8.0, 40.0);

  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    if (fi < sampleCount) {
      float angle = fi * 2.399963229728653 + 0.785398163397448;
      float radiusNorm = sqrt((fi + 0.5) / sampleCount);
      float aperture = polygonApertureScale(angle, u_lensSides);
      vec2 dir = vec2(cos(angle), sin(angle));
      vec2 sampleUv = uv + dir * radiusNorm * aperture * u_lensRadius * u_texelSize;
      accum += lensBlurSample(sampleUv, dir, radiusNorm);
      total += 1.0;
    }
  }

  return accum / total;
}

vec3 grainNoise(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 19.19);
  return fract((p.xxy + p.yxx) * p.zyx);
}

vec3 grainStockWeights(float stock) {
  if (stock < 0.5) return vec3(4.16, 5.31, 12.00);
  if (stock < 1.5) return vec3(2.91, 4.09, 7.50);
  if (stock < 2.5) return vec3(1.98, 2.05, 3.64);
  if (stock < 3.5) return vec3(4.08, 4.63, 5.78);
  if (stock < 4.5) return vec3(3.41, 4.48, 16.43);
  if (stock < 5.5) return vec3(1.50, 1.59, 1.96);
  if (stock < 6.5) return vec3(3.61, 4.05, 8.09);
  if (stock < 7.5) return vec3(2.73, 2.51, 11.60);
  if (stock < 8.5) return vec3(1.0);
  return vec3(4.0);
}

vec3 filmLookPreset(vec3 color, float look) {
  vec3 slope = vec3(1.0);
  vec3 offset = vec3(0.0);
  vec3 power = vec3(1.0);
  float saturation = 1.0;
  float contrast = 1.0;
  float gamma = 1.0;
  float filmCurve = 1.0;

  if (look < 0.5) {
    filmCurve = 0.0;
  } else if (look < 1.5) {
    slope = vec3(1.01, 1.0, 1.0); power = vec3(0.95, 1.0, 1.0); saturation = 1.2;
  } else if (look < 2.5) {
    slope = vec3(1.08, 1.19, 1.07); offset = vec3(0.04, -0.06, 0.02); power = vec3(1.07, 1.11, 1.20);
  } else if (look < 3.5) {
    slope = vec3(0.98, 1.0, 1.03); power = vec3(0.84, 0.97, 1.10);
  } else if (look < 4.5) {
    slope = vec3(1.12, 1.42, 1.19); offset = vec3(0.04, -0.06, 0.02); power = vec3(0.94, 0.81, 0.83); saturation = 0.7; contrast = 1.06;
  } else if (look < 5.5) {
    slope = vec3(0.65, 1.0, 0.8); offset = vec3(0.07, 0.0, 0.08); saturation = 1.4;
  } else if (look < 6.5) {
    slope = vec3(1.19, 1.1, 0.77); offset = vec3(-0.04, -0.08, -0.07); power = vec3(0.8); saturation = 0.9; gamma = 0.9;
  } else if (look < 7.5) {
    slope = vec3(1.02, 1.32, 1.09); offset = vec3(0.04, -0.06, 0.02); power = vec3(0.70, 0.44, 0.51); saturation = 0.8; gamma = 1.3;
  } else {
    saturation = 0.0; contrast = 1.1; gamma = 0.7;
  }

  vec3 graded = pow(max(color, vec3(0.0)), vec3(gamma * u_filmLookGamma));
  graded = pow(clamp(graded * slope + offset, 0.0, 1.0), power);
  graded = adjustSaturation(graded, saturation * u_filmLookSaturation);
  graded = adjustContrast(graded, contrast * u_filmLookContrast);
  vec3 curve = 1.0 / (1.0 + exp(-(graded - 0.5) * 7.0));
  graded = mix(graded, curve, filmCurve);
  return mix(color, clamp(graded, 0.0, 1.0), u_filmLookBlend);
}

vec3 applyFlicker(vec3 color) {
  if (u_flickerAmount <= 0.001) return color;
  float t = u_grainTime * max(0.01, u_flickerSpeed) * 0.2;
  float seed = u_flickerSeed;
  float b = shakeFbm(vec2(t + seed * 0.013, t * 0.31 + seed * 0.017)) - 0.5;
  float s = shakeFbm(vec2(t * 0.73 + seed * 0.019 + 11.0, t * 0.17 + seed * 0.023 + 29.0)) - 0.5;
  float c = shakeFbm(vec2(t * 0.61 + seed * 0.029 + 47.0, t * 0.43 + seed * 0.031 + 71.0)) - 0.5;
  color += b * u_flickerBrightness * u_flickerAmount * 0.32;
  color = adjustSaturation(color, 1.0 + s * u_flickerSaturation * u_flickerAmount * 1.6);
  color = adjustContrast(color, 1.0 + c * u_flickerContrast * u_flickerAmount * 1.8);
  return clamp(color, 0.0, 1.0);
}

vec3 applyVhsLook(vec2 uv, vec3 currentColor) {
  if (u_vhsAmount <= 0.001) return currentColor;
  float t = u_grainTime * 0.75 * max(0.01, u_vhsSpeed);
  float lowRes = mix(1.0, 0.22, clamp(u_vhsResolution, 0.0, 1.0));
  vec2 quantized = floor(uv / max(vec2(0.0001), u_texelSize / lowRes)) * (u_texelSize / lowRes);
  float lineNoise = shakeNoise(vec2(quantized.y * 240.0, t * 12.0)) - 0.5;
  float slowWave = sin(quantized.y * 42.0 + t * 3.1) * 0.5 + 0.5;
  vec2 warpedUv = quantized;
  warpedUv.x += (lineNoise * 0.018 + slowWave * 0.006) * u_vhsWave * u_vhsAmount;

  vec3 col = sampleShakenSource(warpedUv).rgb;
  float bleedPx = u_vhsBleed * u_vhsAmount * 8.0;
  vec2 bleed = vec2(bleedPx * u_texelSize.x, 0.0);
  col.r = sampleShakenSource(warpedUv + bleed * 0.8).r;
  col.b = sampleShakenSource(warpedUv - bleed * 1.1).b;

  float scan = sin(uv.y / max(0.000001, u_texelSize.y) * 3.14159);
  col *= 1.0 - (0.5 + 0.5 * scan) * u_vhsScanlines * u_vhsAmount * 0.28;
  col += (shakeNoise(vec2(uv.y * 900.0, t * 24.0)) - 0.5) * u_vhsAmount * 0.08;
  vec3 tint = vec3(0.88, 1.02, 1.18);
  col = mix(col, col * tint, u_vhsTint * u_vhsAmount);
  return clamp(mix(currentColor, col, u_vhsAmount), 0.0, 1.0);
}

void main() {
  vec4 color = u_chromaWarpAmount > 0.001 ? applyChromaWarp(v_texCoord) : sampleShakenSource(v_texCoord);

  color.rgb = applyDirectionalBlur(v_texCoord, color.rgb);

  if (u_lensRadius > 0.001) {
    color.rgb = applyLensBlur(v_texCoord, color.rgb);
  }

  color.rgb = applyVhsLook(v_texCoord, color.rgb);
  color.rgb = applyDigitalGlitch(v_texCoord, color.rgb);

  if (u_sharpenAmount > 0.001) {
    float strength = u_sharpenAmount * 0.55;
    vec3 left = texture2D(u_image, v_texCoord + vec2(-u_texelSize.x, 0.0)).rgb;
    vec3 right = texture2D(u_image, v_texCoord + vec2(u_texelSize.x, 0.0)).rgb;
    vec3 up = texture2D(u_image, v_texCoord + vec2(0.0, -u_texelSize.y)).rgb;
    vec3 down = texture2D(u_image, v_texCoord + vec2(0.0, u_texelSize.y)).rgb;
    color.rgb = clamp(color.rgb * (1.0 + 4.0 * strength) - (left + right + up + down) * strength, 0.0, 1.0);
  }

  if (u_grainAmount > 0.001) {
    float grainSize = max(0.35, u_grainSize);
    float frame = floor(max(0.0, u_grainTime) * 24.0);
    vec3 pos = vec3(gl_FragCoord.xy / grainSize, frame * 0.173) + frame * 37.0 + 50.0;
    vec3 grain = grainNoise(pos);
    vec3 centered = grain - vec3(0.5);
    vec3 weights = grainStockWeights(u_grainStock);
    float grayWeight = dot(weights, vec3(0.333333));
    weights = mix(vec3(grayWeight), weights, clamp(u_grainColor, 0.0, 1.0));
    weights = weights / 12.0;

    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float density = mix(1.20, 0.62, smoothstep(0.0, 1.0, luma));
    color.rgb = clamp(color.rgb + centered * weights * u_grainAmount * 0.42 * density, 0.0, 1.0);
  }

  if (u_filmLookBlend > 0.001) {
    color.rgb = filmLookPreset(color.rgb, u_filmLookLook);
  }

  color.rgb = applyFlicker(color.rgb);

  if (u_vignetteAmount > 0.001) {
    float dist = distance(v_texCoord, vec2(0.5, 0.5));
    float inner = mix(0.08, 0.62, u_vignetteSize);
    float outer = min(0.85, inner + mix(0.02, 0.42, u_vignetteSoftness));
    float shade = smoothstep(inner, outer, dist) * u_vignetteAmount;
    color.rgb *= 1.0 - shade;
  }

  gl_FragColor = color;
}
`

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader compile error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE)
  const program = gl.createProgram()
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Unknown shader link error'
    gl.deleteProgram(program)
    throw new Error(message)
  }

  return program
}

function getSourceDimensions(source) {
  return {
    width: source?.videoWidth || source?.naturalWidth || source?.width || 0,
    height: source?.videoHeight || source?.naturalHeight || source?.height || 0,
  }
}

function sourceIsReady(source) {
  if (!source) return false
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0
  }
  return getSourceDimensions(source).width > 0 && getSourceDimensions(source).height > 0
}

let webglSupportCache = null

export function canUseGlslEffects() {
  if (webglSupportCache != null) return webglSupportCache
  try {
    if (typeof document === 'undefined') {
      webglSupportCache = false
      return webglSupportCache
    }
    const canvas = document.createElement('canvas')
    webglSupportCache = Boolean(
      canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl')
    )
    return webglSupportCache
  } catch (_) {
    webglSupportCache = false
    return webglSupportCache
  }
}

export function isGlslEffectType(typeId) {
  return GLSL_EFFECT_IDS.has(typeId)
}

export function hasGlslEffect(effects) {
  return Array.isArray(effects)
    && effects.some((effect) => effect && effect.enabled !== false && isGlslEffectType(effect.type))
}

export function getAnimatedGlslEffectUniforms(effects, clipTime = 0) {
  const uniforms = {
    shakeAmount: 0,
    shakeSpeed: 6,
    shakePosition: 0.55,
    shakeRotation: 0.28,
    shakeZoom: 0.18,
    shakeMotionBlur: 0.35,
    shakeSamples: 8,
    shakeSeed: 2341,
    shakeTime: Math.max(0, Number(clipTime) || 0),
    dirBlurAmount: 0,
    dirBlurAngle: 0,
    dirBlurSamples: 16,
    dirBlurGain: 1,
    lensRadius: 0,
    lensSides: 6,
    lensHighlights: 0.7,
    lensThreshold: 0.72,
    lensChroma: 1.5,
    lensSamples: 24,
    fisheyeAmount: 0,
    fisheyeZoom: 0.45,
    chromaWarpAmount: 0,
    chromaWarpDistortion: 0,
    chromaWarpSaturation: 1,
    chromaWarpIterations: 16,
    glitchAmount: 0,
    glitchSpeed: 10,
    glitchSlice: 0.45,
    glitchRgbOffset: 8,
    glitchBlockiness: 0.35,
    glitchBwNoise: 0.18,
    glitchSeed: 2048,
    sharpenAmount: 0,
    grainAmount: 0,
    grainSize: 1.4,
    grainColor: 0.65,
    grainStock: 7,
    grainTime: Math.max(0, Number(clipTime) || 0),
    filmLookBlend: 0,
    filmLookLook: 3,
    filmLookSaturation: 1,
    filmLookContrast: 1,
    filmLookGamma: 1,
    flickerAmount: 0,
    flickerSpeed: 8,
    flickerBrightness: 0.7,
    flickerSaturation: 0.15,
    flickerContrast: 0.2,
    flickerSeed: 1337,
    vhsAmount: 0,
    vhsResolution: 0.58,
    vhsWave: 0.42,
    vhsBleed: 0.45,
    vhsScanlines: 0.35,
    vhsTint: 0.3,
    vhsSpeed: 1,
    vignetteAmount: 0,
    vignetteSize: 0.7,
    vignetteSoftness: 0.6,
  }

  if (!Array.isArray(effects)) return uniforms

  for (const effect of effects) {
    if (!effect || effect.enabled === false || !isGlslEffectType(effect.type)) continue
    const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
    const settings = animated.settings || {}
    if (effect.type === 'glslCameraShake') {
      uniforms.shakeAmount = clamp01(Number(settings.intensity || 0) / 100)
      uniforms.shakeSpeed = Math.max(0.25, Math.min(30, Number(settings.speed) || 6))
      uniforms.shakePosition = clamp01(Number(settings.position ?? 55) / 100)
      uniforms.shakeRotation = clamp01(Number(settings.rotation ?? 28) / 100)
      uniforms.shakeZoom = clamp01(Number(settings.zoom ?? 18) / 100)
      uniforms.shakeMotionBlur = clamp01(Number(settings.motionBlur ?? 35) / 100)
      uniforms.shakeSamples = Math.max(1, Math.min(24, Math.round(Number(settings.samples) || 8)))
      uniforms.shakeSeed = Math.max(0, Math.min(9999, Number(settings.seed) || 0))
    } else if (effect.type === 'glslDirectionalBlur') {
      uniforms.dirBlurAmount = Math.max(0, Math.min(80, Number(settings.amount) || 0))
      uniforms.dirBlurAngle = (Number(settings.angle) || 0) * Math.PI / 180
      uniforms.dirBlurSamples = Math.max(4, Math.min(32, Math.round(Number(settings.samples) || 16)))
      uniforms.dirBlurGain = Math.max(0, Math.min(2, Number(settings.gain ?? 100) / 100))
    } else if (effect.type === 'glslLensBlur') {
      uniforms.lensRadius = Math.max(0, Math.min(48, Number(settings.amount) || 0))
      uniforms.lensSides = Math.max(3, Math.min(9, Math.round(Number(settings.sides) || 6)))
      uniforms.lensHighlights = Math.max(0, Math.min(3, Number(settings.highlights ?? 70) / 100))
      uniforms.lensThreshold = clamp01(Number(settings.threshold ?? 72) / 100)
      uniforms.lensChroma = Math.max(0, Math.min(20, Number(settings.chroma) || 0))
      uniforms.lensSamples = Math.max(8, Math.min(40, Math.round(Number(settings.samples) || 24)))
    } else if (effect.type === 'glslFisheye') {
      uniforms.fisheyeAmount = Math.max(-1, Math.min(1, Number(settings.amount || 0) / 100))
      uniforms.fisheyeZoom = clamp01(Number(settings.zoom ?? 45) / 100)
    } else if (effect.type === 'glslChromaWarp') {
      uniforms.chromaWarpAmount = Math.max(0, Math.min(20, Number(settings.amount) || 0)) * 0.035
      uniforms.chromaWarpDistortion = Math.max(-1, Math.min(1, Number(settings.distortion || 0) / 100))
      uniforms.chromaWarpSaturation = clamp01(Number(settings.saturation ?? 100) / 100)
      uniforms.chromaWarpIterations = Math.max(4, Math.min(32, Math.round(Number(settings.iterations) || 16)))
    } else if (effect.type === 'glslDigitalGlitch') {
      uniforms.glitchAmount = clamp01(Number(settings.amount || 0) / 100)
      uniforms.glitchSpeed = Math.max(0.25, Math.min(30, Number(settings.speed) || 10))
      uniforms.glitchSlice = clamp01(Number(settings.slice ?? 45) / 100)
      uniforms.glitchRgbOffset = Math.max(0, Math.min(40, Number(settings.rgbOffset) || 0))
      uniforms.glitchBlockiness = clamp01(Number(settings.blockiness ?? 35) / 100)
      uniforms.glitchBwNoise = clamp01(Number(settings.bwNoise ?? 18) / 100)
      uniforms.glitchSeed = Math.max(0, Math.min(9999, Number(settings.seed) || 0))
    } else if (effect.type === 'glslSharpen') {
      uniforms.sharpenAmount = clamp01(Number(settings.amount || 0) / 100)
    } else if (effect.type === 'glslFilmGrain') {
      uniforms.grainAmount = clamp01(Number(settings.amount || 0) / 100)
      uniforms.grainSize = Math.max(0.5, Math.min(6, Number(settings.size) || 1.4))
      uniforms.grainColor = clamp01(Number(settings.color ?? 65) / 100)
      uniforms.grainStock = Math.max(0, Math.min(9, Math.round(Number(settings.stock) || 0)))
    } else if (effect.type === 'glslFilmLook') {
      uniforms.filmLookBlend = clamp01(Number(settings.blend ?? 100) / 100)
      uniforms.filmLookLook = Math.max(0, Math.min(8, Math.round(Number(settings.look) || 0)))
      uniforms.filmLookSaturation = Math.max(0, Math.min(2, Number(settings.saturation ?? 100) / 100))
      uniforms.filmLookContrast = Math.max(0, Math.min(2, Number(settings.contrast ?? 100) / 100))
      uniforms.filmLookGamma = Math.max(0.25, Math.min(2, Number(settings.gamma ?? 100) / 100))
    } else if (effect.type === 'glslFlicker') {
      uniforms.flickerAmount = clamp01(Number(settings.amount || 0) / 100)
      uniforms.flickerSpeed = Math.max(0.25, Math.min(30, Number(settings.speed) || 8))
      uniforms.flickerBrightness = clamp01(Number(settings.brightness ?? 70) / 100)
      uniforms.flickerSaturation = clamp01(Number(settings.saturation ?? 15) / 100)
      uniforms.flickerContrast = clamp01(Number(settings.contrast ?? 20) / 100)
      uniforms.flickerSeed = Math.max(0, Math.min(9999, Number(settings.seed) || 0))
    } else if (effect.type === 'glslVhsLook') {
      uniforms.vhsAmount = clamp01(Number(settings.amount || 0) / 100)
      uniforms.vhsResolution = clamp01(Number(settings.resolution ?? 58) / 100)
      uniforms.vhsWave = clamp01(Number(settings.wave ?? 42) / 100)
      uniforms.vhsBleed = clamp01(Number(settings.bleed ?? 45) / 100)
      uniforms.vhsScanlines = clamp01(Number(settings.scanlines ?? 35) / 100)
      uniforms.vhsTint = clamp01(Number(settings.tint ?? 30) / 100)
      uniforms.vhsSpeed = Math.max(0.25, Math.min(10, Number(settings.speed) || 1))
    } else if (effect.type === 'glslVignette') {
      uniforms.vignetteAmount = clamp01(Number(settings.amount || 0) / 100)
      uniforms.vignetteSize = clamp01(Number(settings.size ?? 70) / 100)
      uniforms.vignetteSoftness = clamp01(Number(settings.softness ?? 60) / 100)
    }
  }

  return uniforms
}

export function createGlslEffectRenderer(canvas) {
  const gl = canvas?.getContext?.('webgl', {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  }) || canvas?.getContext?.('experimental-webgl')

  if (!gl) {
    throw new Error('WebGL is not available')
  }

  const program = createProgram(gl)
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord')
  const imageLocation = gl.getUniformLocation(program, 'u_image')
  const texelSizeLocation = gl.getUniformLocation(program, 'u_texelSize')
  const shakeAmountLocation = gl.getUniformLocation(program, 'u_shakeAmount')
  const shakeSpeedLocation = gl.getUniformLocation(program, 'u_shakeSpeed')
  const shakePositionLocation = gl.getUniformLocation(program, 'u_shakePosition')
  const shakeRotationLocation = gl.getUniformLocation(program, 'u_shakeRotation')
  const shakeZoomLocation = gl.getUniformLocation(program, 'u_shakeZoom')
  const shakeMotionBlurLocation = gl.getUniformLocation(program, 'u_shakeMotionBlur')
  const shakeSamplesLocation = gl.getUniformLocation(program, 'u_shakeSamples')
  const shakeSeedLocation = gl.getUniformLocation(program, 'u_shakeSeed')
  const shakeTimeLocation = gl.getUniformLocation(program, 'u_shakeTime')
  const dirBlurAmountLocation = gl.getUniformLocation(program, 'u_dirBlurAmount')
  const dirBlurAngleLocation = gl.getUniformLocation(program, 'u_dirBlurAngle')
  const dirBlurSamplesLocation = gl.getUniformLocation(program, 'u_dirBlurSamples')
  const dirBlurGainLocation = gl.getUniformLocation(program, 'u_dirBlurGain')
  const lensRadiusLocation = gl.getUniformLocation(program, 'u_lensRadius')
  const lensSidesLocation = gl.getUniformLocation(program, 'u_lensSides')
  const lensHighlightsLocation = gl.getUniformLocation(program, 'u_lensHighlights')
  const lensThresholdLocation = gl.getUniformLocation(program, 'u_lensThreshold')
  const lensChromaLocation = gl.getUniformLocation(program, 'u_lensChroma')
  const lensSamplesLocation = gl.getUniformLocation(program, 'u_lensSamples')
  const fisheyeAmountLocation = gl.getUniformLocation(program, 'u_fisheyeAmount')
  const fisheyeZoomLocation = gl.getUniformLocation(program, 'u_fisheyeZoom')
  const chromaWarpAmountLocation = gl.getUniformLocation(program, 'u_chromaWarpAmount')
  const chromaWarpDistortionLocation = gl.getUniformLocation(program, 'u_chromaWarpDistortion')
  const chromaWarpSaturationLocation = gl.getUniformLocation(program, 'u_chromaWarpSaturation')
  const chromaWarpIterationsLocation = gl.getUniformLocation(program, 'u_chromaWarpIterations')
  const glitchAmountLocation = gl.getUniformLocation(program, 'u_glitchAmount')
  const glitchSpeedLocation = gl.getUniformLocation(program, 'u_glitchSpeed')
  const glitchSliceLocation = gl.getUniformLocation(program, 'u_glitchSlice')
  const glitchRgbOffsetLocation = gl.getUniformLocation(program, 'u_glitchRgbOffset')
  const glitchBlockinessLocation = gl.getUniformLocation(program, 'u_glitchBlockiness')
  const glitchBwNoiseLocation = gl.getUniformLocation(program, 'u_glitchBwNoise')
  const glitchSeedLocation = gl.getUniformLocation(program, 'u_glitchSeed')
  const sharpenAmountLocation = gl.getUniformLocation(program, 'u_sharpenAmount')
  const grainAmountLocation = gl.getUniformLocation(program, 'u_grainAmount')
  const grainSizeLocation = gl.getUniformLocation(program, 'u_grainSize')
  const grainColorLocation = gl.getUniformLocation(program, 'u_grainColor')
  const grainStockLocation = gl.getUniformLocation(program, 'u_grainStock')
  const grainTimeLocation = gl.getUniformLocation(program, 'u_grainTime')
  const filmLookBlendLocation = gl.getUniformLocation(program, 'u_filmLookBlend')
  const filmLookLookLocation = gl.getUniformLocation(program, 'u_filmLookLook')
  const filmLookSaturationLocation = gl.getUniformLocation(program, 'u_filmLookSaturation')
  const filmLookContrastLocation = gl.getUniformLocation(program, 'u_filmLookContrast')
  const filmLookGammaLocation = gl.getUniformLocation(program, 'u_filmLookGamma')
  const flickerAmountLocation = gl.getUniformLocation(program, 'u_flickerAmount')
  const flickerSpeedLocation = gl.getUniformLocation(program, 'u_flickerSpeed')
  const flickerBrightnessLocation = gl.getUniformLocation(program, 'u_flickerBrightness')
  const flickerSaturationLocation = gl.getUniformLocation(program, 'u_flickerSaturation')
  const flickerContrastLocation = gl.getUniformLocation(program, 'u_flickerContrast')
  const flickerSeedLocation = gl.getUniformLocation(program, 'u_flickerSeed')
  const vhsAmountLocation = gl.getUniformLocation(program, 'u_vhsAmount')
  const vhsResolutionLocation = gl.getUniformLocation(program, 'u_vhsResolution')
  const vhsWaveLocation = gl.getUniformLocation(program, 'u_vhsWave')
  const vhsBleedLocation = gl.getUniformLocation(program, 'u_vhsBleed')
  const vhsScanlinesLocation = gl.getUniformLocation(program, 'u_vhsScanlines')
  const vhsTintLocation = gl.getUniformLocation(program, 'u_vhsTint')
  const vhsSpeedLocation = gl.getUniformLocation(program, 'u_vhsSpeed')
  const vignetteAmountLocation = gl.getUniformLocation(program, 'u_vignetteAmount')
  const vignetteSizeLocation = gl.getUniformLocation(program, 'u_vignetteSize')
  const vignetteSoftnessLocation = gl.getUniformLocation(program, 'u_vignetteSoftness')

  const positionBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    1, 1,
  ]), gl.STATIC_DRAW)

  const texCoordBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ]), gl.STATIC_DRAW)

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const render = (source, effects, clipTime = 0, size = null) => {
    if (!sourceIsReady(source)) return false
    const sourceDimensions = getSourceDimensions(source)
    const width = Math.max(1, Math.round(Number(size?.width) || sourceDimensions.width))
    const height = Math.max(1, Math.round(Number(size?.height) || sourceDimensions.height))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const uniforms = getAnimatedGlslEffectUniforms(effects, clipTime)

    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
    gl.enableVertexAttribArray(texCoordLocation)
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0)

    gl.uniform1i(imageLocation, 0)
    gl.uniform2f(texelSizeLocation, 1 / width, 1 / height)
    gl.uniform1f(shakeAmountLocation, uniforms.shakeAmount)
    gl.uniform1f(shakeSpeedLocation, uniforms.shakeSpeed)
    gl.uniform1f(shakePositionLocation, uniforms.shakePosition)
    gl.uniform1f(shakeRotationLocation, uniforms.shakeRotation)
    gl.uniform1f(shakeZoomLocation, uniforms.shakeZoom)
    gl.uniform1f(shakeMotionBlurLocation, uniforms.shakeMotionBlur)
    gl.uniform1f(shakeSamplesLocation, uniforms.shakeSamples)
    gl.uniform1f(shakeSeedLocation, uniforms.shakeSeed)
    gl.uniform1f(shakeTimeLocation, uniforms.shakeTime)
    gl.uniform1f(dirBlurAmountLocation, uniforms.dirBlurAmount)
    gl.uniform1f(dirBlurAngleLocation, uniforms.dirBlurAngle)
    gl.uniform1f(dirBlurSamplesLocation, uniforms.dirBlurSamples)
    gl.uniform1f(dirBlurGainLocation, uniforms.dirBlurGain)
    gl.uniform1f(lensRadiusLocation, uniforms.lensRadius)
    gl.uniform1f(lensSidesLocation, uniforms.lensSides)
    gl.uniform1f(lensHighlightsLocation, uniforms.lensHighlights)
    gl.uniform1f(lensThresholdLocation, uniforms.lensThreshold)
    gl.uniform1f(lensChromaLocation, uniforms.lensChroma)
    gl.uniform1f(lensSamplesLocation, uniforms.lensSamples)
    gl.uniform1f(fisheyeAmountLocation, uniforms.fisheyeAmount)
    gl.uniform1f(fisheyeZoomLocation, uniforms.fisheyeZoom)
    gl.uniform1f(chromaWarpAmountLocation, uniforms.chromaWarpAmount)
    gl.uniform1f(chromaWarpDistortionLocation, uniforms.chromaWarpDistortion)
    gl.uniform1f(chromaWarpSaturationLocation, uniforms.chromaWarpSaturation)
    gl.uniform1f(chromaWarpIterationsLocation, uniforms.chromaWarpIterations)
    gl.uniform1f(glitchAmountLocation, uniforms.glitchAmount)
    gl.uniform1f(glitchSpeedLocation, uniforms.glitchSpeed)
    gl.uniform1f(glitchSliceLocation, uniforms.glitchSlice)
    gl.uniform1f(glitchRgbOffsetLocation, uniforms.glitchRgbOffset)
    gl.uniform1f(glitchBlockinessLocation, uniforms.glitchBlockiness)
    gl.uniform1f(glitchBwNoiseLocation, uniforms.glitchBwNoise)
    gl.uniform1f(glitchSeedLocation, uniforms.glitchSeed)
    gl.uniform1f(sharpenAmountLocation, uniforms.sharpenAmount)
    gl.uniform1f(grainAmountLocation, uniforms.grainAmount)
    gl.uniform1f(grainSizeLocation, uniforms.grainSize)
    gl.uniform1f(grainColorLocation, uniforms.grainColor)
    gl.uniform1f(grainStockLocation, uniforms.grainStock)
    gl.uniform1f(grainTimeLocation, uniforms.grainTime)
    gl.uniform1f(filmLookBlendLocation, uniforms.filmLookBlend)
    gl.uniform1f(filmLookLookLocation, uniforms.filmLookLook)
    gl.uniform1f(filmLookSaturationLocation, uniforms.filmLookSaturation)
    gl.uniform1f(filmLookContrastLocation, uniforms.filmLookContrast)
    gl.uniform1f(filmLookGammaLocation, uniforms.filmLookGamma)
    gl.uniform1f(flickerAmountLocation, uniforms.flickerAmount)
    gl.uniform1f(flickerSpeedLocation, uniforms.flickerSpeed)
    gl.uniform1f(flickerBrightnessLocation, uniforms.flickerBrightness)
    gl.uniform1f(flickerSaturationLocation, uniforms.flickerSaturation)
    gl.uniform1f(flickerContrastLocation, uniforms.flickerContrast)
    gl.uniform1f(flickerSeedLocation, uniforms.flickerSeed)
    gl.uniform1f(vhsAmountLocation, uniforms.vhsAmount)
    gl.uniform1f(vhsResolutionLocation, uniforms.vhsResolution)
    gl.uniform1f(vhsWaveLocation, uniforms.vhsWave)
    gl.uniform1f(vhsBleedLocation, uniforms.vhsBleed)
    gl.uniform1f(vhsScanlinesLocation, uniforms.vhsScanlines)
    gl.uniform1f(vhsTintLocation, uniforms.vhsTint)
    gl.uniform1f(vhsSpeedLocation, uniforms.vhsSpeed)
    gl.uniform1f(vignetteAmountLocation, uniforms.vignetteAmount)
    gl.uniform1f(vignetteSizeLocation, uniforms.vignetteSize)
    gl.uniform1f(vignetteSoftnessLocation, uniforms.vignetteSoftness)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  const dispose = () => {
    gl.deleteTexture(texture)
    gl.deleteBuffer(positionBuffer)
    gl.deleteBuffer(texCoordBuffer)
    gl.deleteProgram(program)
  }

  return { canvas, gl, render, dispose }
}

const exportRendererCache = new Map()

function getExportRenderer(width, height) {
  const key = `${width}x${height}`
  const existing = exportRendererCache.get(key)
  if (existing) return existing

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const renderer = createGlslEffectRenderer(canvas)
  exportRendererCache.set(key, renderer)
  return renderer
}

export function applyGlslEffectsToCanvas(canvas, ctx, width, height, effects, clipTime = 0) {
  if (!canvas || !ctx || !hasGlslEffect(effects)) return false
  try {
    const renderer = getExportRenderer(width, height)
    const rendered = renderer.render(canvas, effects, clipTime, { width, height })
    if (!rendered) return false
    ctx.save()
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'copy'
    ctx.drawImage(renderer.canvas, 0, 0, width, height)
    ctx.restore()
    return true
  } catch (err) {
    console.warn('GLSL effect render failed; leaving canvas unchanged.', err)
    return false
  }
}
