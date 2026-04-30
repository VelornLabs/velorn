/**
 * Stylistic effects data model and rendering helpers.
 *
 * Effects live on each clip as `clip.effects = [{ id, type, enabled, settings }]`
 * and are ordered top-to-bottom in the inspector stack. The first entry is
 * applied first in the rendering pipeline (bottom of the stack in editing
 * terms), the last entry is applied last. Transform-based effects like
 * `cameraShake` contribute procedural transform overrides, while pixel
 * effects (`chromaticAberration`, `sharpen`, `filmGrain`, `vignette`) run
 * as a filter chain over the rendered clip.
 *
 * Effect parameters can be keyframed using the property id
 * `effect.<effectId>.<paramKey>` on the clip's keyframe map.
 */

import { getValueAtTime } from './keyframes'

const clampNumber = (value, min, max, fallback = 0) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const EFFECT_CATEGORIES = Object.freeze({
  motion: 'Motion',
  stylistic: 'Stylistic',
})

/**
 * Effect type registry. Keep stable ids – they are persisted on clip data.
 */
export const EFFECT_TYPES = Object.freeze([
  {
    id: 'cameraShake',
    label: 'Camera Shake',
    category: EFFECT_CATEGORIES.motion,
    icon: 'Waves',
    description: 'Procedural handheld motion. Intensity and speed are framerate-independent.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'speed', label: 'Speed', min: 0.5, max: 30, step: 0.5, unit: 'Hz' },
      { key: 'rotation', label: 'Rotation', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      intensity: 20,
      speed: 8,
      rotation: 30,
    }),
    presets: Object.freeze([
      { id: 'subtle', label: 'Subtle', settings: { intensity: 10, speed: 4, rotation: 10 } },
      { id: 'handheld', label: 'Handheld', settings: { intensity: 22, speed: 7, rotation: 30 } },
      { id: 'punchy', label: 'Punchy', settings: { intensity: 40, speed: 14, rotation: 45 } },
      { id: 'earthquake', label: 'Earthquake', settings: { intensity: 65, speed: 22, rotation: 70 } },
    ]),
  },
  {
    id: 'glslCameraShake',
    label: 'Camera Shake',
    category: EFFECT_CATEGORIES.motion,
    icon: 'Waves',
    description: 'GPU UV camera shake with procedural position, rotation, zoom, and shutter blur.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'speed', label: 'Speed', min: 0.25, max: 30, step: 0.25, unit: 'Hz' },
      { key: 'position', label: 'Position', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'rotation', label: 'Rotation', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'zoom', label: 'Zoom', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'motionBlur', label: 'Motion Blur', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'samples', label: 'Samples', min: 1, max: 24, step: 1 },
      { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1 },
    ],
    defaults: Object.freeze({
      intensity: 24,
      speed: 6,
      position: 55,
      rotation: 28,
      zoom: 18,
      motionBlur: 35,
      samples: 8,
      seed: 2341,
    }),
    presets: Object.freeze([
      { id: 'handheld', label: 'Handheld', settings: { intensity: 18, speed: 4.5, position: 45, rotation: 18, zoom: 8, motionBlur: 20, samples: 6, seed: 2341 } },
      { id: 'runAndGun', label: 'Run & Gun', settings: { intensity: 34, speed: 8, position: 70, rotation: 35, zoom: 20, motionBlur: 45, samples: 10, seed: 5341 } },
      { id: 'impact', label: 'Impact', settings: { intensity: 56, speed: 14, position: 80, rotation: 55, zoom: 35, motionBlur: 65, samples: 12, seed: 8912 } },
    ]),
  },
  {
    id: 'gaussianBlur',
    label: 'Gaussian Blur',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'Soft, even blur for dreamy focus pulls, privacy blur, or background defocus.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 80, step: 0.25, unit: 'px' },
    ],
    defaults: Object.freeze({
      amount: 8,
    }),
    presets: Object.freeze([
      { id: 'soft', label: 'Soft', settings: { amount: 4 } },
      { id: 'dream', label: 'Dreamy', settings: { amount: 12 } },
      { id: 'heavy', label: 'Heavy', settings: { amount: 28 } },
    ]),
  },
  {
    id: 'directionalBlur',
    label: 'Directional Blur',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'MoveRight',
    description: 'Streaks the image along an angle for motion smears and speed-ramp accents.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 80, step: 0.25, unit: 'px' },
      { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'samples', label: 'Samples', min: 3, max: 15, step: 2, unit: '' },
    ],
    defaults: Object.freeze({
      amount: 10,
      angle: 0,
      samples: 7,
    }),
    presets: Object.freeze([
      { id: 'horizontal', label: 'Horizontal', settings: { amount: 10, angle: 0, samples: 7 } },
      { id: 'vertical', label: 'Vertical', settings: { amount: 10, angle: 90, samples: 7 } },
      { id: 'speedLine', label: 'Speed Line', settings: { amount: 26, angle: 0, samples: 11 } },
    ]),
  },
  {
    id: 'glslDirectionalBlur',
    label: 'Directional Blur',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'MoveRight',
    description: 'GPU directional blur for motion streaks and speed-ramp accents.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 80, step: 0.25, unit: 'px' },
      { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'samples', label: 'Samples', min: 4, max: 32, step: 2 },
      { key: 'gain', label: 'Gain', min: 0, max: 200, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      amount: 12,
      angle: 0,
      samples: 16,
      gain: 100,
    }),
    presets: Object.freeze([
      { id: 'horizontal', label: 'Horizontal', settings: { amount: 12, angle: 0, samples: 16, gain: 100 } },
      { id: 'vertical', label: 'Vertical', settings: { amount: 12, angle: 90, samples: 16, gain: 100 } },
      { id: 'speedLine', label: 'Speed Line', settings: { amount: 28, angle: 0, samples: 24, gain: 105 } },
    ]),
  },
  {
    id: 'glslLensBlur',
    label: 'Lens Blur',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'GPU polygon bokeh blur with highlight bloom and subtle chromatic spread.',
    params: [
      { key: 'amount', label: 'Radius', min: 0, max: 48, step: 0.5, unit: 'px' },
      { key: 'sides', label: 'Sides', min: 3, max: 9, step: 1 },
      { key: 'highlights', label: 'Highlights', min: 0, max: 300, step: 1, unit: '%' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'chroma', label: 'Chroma', min: 0, max: 20, step: 0.25, unit: 'px' },
      { key: 'samples', label: 'Samples', min: 8, max: 40, step: 4 },
    ],
    defaults: Object.freeze({
      amount: 14,
      sides: 6,
      highlights: 70,
      threshold: 72,
      chroma: 1.5,
      samples: 24,
    }),
    presets: Object.freeze([
      { id: 'soft', label: 'Soft', settings: { amount: 8, sides: 7, highlights: 35, threshold: 75, chroma: 0.75, samples: 16 } },
      { id: 'cinematic', label: 'Cinematic', settings: { amount: 16, sides: 6, highlights: 75, threshold: 70, chroma: 1.5, samples: 24 } },
      { id: 'dream', label: 'Dream Bokeh', settings: { amount: 26, sides: 5, highlights: 130, threshold: 58, chroma: 3, samples: 32 } },
    ]),
  },
  {
    id: 'glslFisheye',
    label: 'Fisheye',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'GPU barrel and anti-barrel lens distortion.',
    params: [
      { key: 'amount', label: 'Distortion', min: -100, max: 100, step: 1, unit: '%' },
      { key: 'zoom', label: 'Auto Zoom', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      amount: 35,
      zoom: 45,
    }),
    presets: Object.freeze([
      { id: 'subtle', label: 'Subtle', settings: { amount: 18, zoom: 25 } },
      { id: 'fisheye', label: 'Fisheye', settings: { amount: 45, zoom: 50 } },
      { id: 'wide', label: 'Wide Lens', settings: { amount: -35, zoom: 25 } },
    ]),
  },
  {
    id: 'chromaticAberration',
    label: 'Chromatic Aberration',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Radio',
    description: 'Splits red and blue channels along an angle for a dreamy / lens-fringe look.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 40, step: 0.25, unit: 'px' },
      { key: 'angle', label: 'Angle', min: -180, max: 180, step: 1, unit: '°' },
    ],
    defaults: Object.freeze({
      amount: 6,
      angle: 0,
    }),
    presets: Object.freeze([
      { id: 'light', label: 'Light', settings: { amount: 3, angle: 0 } },
      { id: 'dreamy', label: 'Dreamy', settings: { amount: 8, angle: 0 } },
      { id: 'glitch', label: 'Glitch Hit', settings: { amount: 18, angle: 0 } },
      { id: 'vhs', label: 'VHS', settings: { amount: 12, angle: 90 } },
    ]),
  },
  {
    id: 'glslChromaWarp',
    label: 'Chroma Warp',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Radio',
    description: 'Radial spectrum-style chromatic aberration with optional barrel warp.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 20, step: 0.1, unit: 'px' },
      { key: 'distortion', label: 'Distortion', min: -100, max: 100, step: 1, unit: '%' },
      { key: 'saturation', label: 'Spectrum', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'iterations', label: 'Iterations', min: 4, max: 32, step: 2 },
    ],
    defaults: Object.freeze({
      amount: 4,
      distortion: 25,
      saturation: 100,
      iterations: 16,
    }),
    presets: Object.freeze([
      { id: 'subtle', label: 'Subtle', settings: { amount: 1.5, distortion: 8, saturation: 70, iterations: 12 } },
      { id: 'prism', label: 'Prism', settings: { amount: 5, distortion: 18, saturation: 100, iterations: 18 } },
      { id: 'warp', label: 'Warped', settings: { amount: 11, distortion: 35, saturation: 100, iterations: 24 } },
    ]),
  },
  {
    id: 'glslDigitalGlitch',
    label: 'Digital Glitch',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Radio',
    description: 'GPU digital glitch with horizontal slices, RGB split, block noise, and scanline bursts.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'speed', label: 'Speed', min: 0.25, max: 30, step: 0.25, unit: 'Hz' },
      { key: 'slice', label: 'Slice Offset', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'rgbOffset', label: 'RGB Offset', min: 0, max: 40, step: 0.25, unit: 'px' },
      { key: 'blockiness', label: 'Blockiness', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'bwNoise', label: 'B&W Noise', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1 },
    ],
    defaults: Object.freeze({
      amount: 35,
      speed: 10,
      slice: 45,
      rgbOffset: 8,
      blockiness: 35,
      bwNoise: 18,
      seed: 2048,
    }),
    presets: Object.freeze([
      { id: 'signalHit', label: 'Signal Hit', settings: { amount: 28, speed: 12, slice: 45, rgbOffset: 7, blockiness: 22, bwNoise: 10, seed: 2048 } },
      { id: 'datamosh', label: 'Datamosh', settings: { amount: 48, speed: 7, slice: 70, rgbOffset: 12, blockiness: 45, bwNoise: 18, seed: 4096 } },
      { id: 'corrupt', label: 'Corrupt', settings: { amount: 72, speed: 16, slice: 85, rgbOffset: 20, blockiness: 75, bwNoise: 45, seed: 8192 } },
    ]),
  },
  {
    id: 'sharpen',
    label: 'Sharpen',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'Adds crisp local contrast to soft footage without using AI.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      amount: 35,
    }),
    presets: Object.freeze([
      { id: 'subtle', label: 'Subtle', settings: { amount: 18 } },
      { id: 'crisp', label: 'Crisp', settings: { amount: 35 } },
      { id: 'strong', label: 'Strong', settings: { amount: 65 } },
    ]),
  },
  {
    id: 'glslSharpen',
    label: 'Sharpen',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'GPU shader sharpen for comparing against the standard Sharpen effect.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      amount: 35,
    }),
    presets: Object.freeze([
      { id: 'subtle', label: 'Subtle', settings: { amount: 18 } },
      { id: 'crisp', label: 'Crisp', settings: { amount: 35 } },
      { id: 'strong', label: 'Strong', settings: { amount: 65 } },
    ]),
  },
  {
    id: 'filmGrain',
    label: 'Film Grain',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Sparkles',
    description: 'Animated noise overlay. Use small Size values for 16mm, larger for Super8 / VHS.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'size', label: 'Size', min: 0.5, max: 5, step: 0.1, unit: 'px' },
      { key: 'monochrome', label: 'Monochrome', type: 'toggle' },
    ],
    defaults: Object.freeze({
      amount: 20,
      size: 1.2,
      monochrome: 1,
    }),
    presets: Object.freeze([
      { id: 'clean16mm', label: 'Clean 16mm', settings: { amount: 14, size: 1, monochrome: 1 } },
      { id: 'super8', label: 'Super8', settings: { amount: 32, size: 1.8, monochrome: 0 } },
      { id: 'vhs', label: 'Heavy VHS', settings: { amount: 55, size: 2.6, monochrome: 0 } },
    ]),
  },
  {
    id: 'glslFilmGrain',
    label: 'Film Grain',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Sparkles',
    description: 'GPU procedural film grain inspired by film-stock re-grain shaders.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'size', label: 'Size', min: 0.5, max: 6, step: 0.1, unit: 'px' },
      { key: 'color', label: 'Color', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'stock', label: 'Stock', min: 0, max: 9, step: 1 },
    ],
    defaults: Object.freeze({
      amount: 32,
      size: 1.4,
      color: 65,
      stock: 7,
    }),
    presets: Object.freeze([
      { id: 'fine5245', label: 'Fine 5245', settings: { amount: 22, size: 1.0, color: 55, stock: 0 } },
      { id: 'vision500t', label: '5218 500T', settings: { amount: 34, size: 1.5, color: 70, stock: 7 } },
      { id: 'bw', label: 'B&W', settings: { amount: 36, size: 1.3, color: 0, stock: 8 } },
      { id: 'push', label: 'Pushed', settings: { amount: 55, size: 2.2, color: 75, stock: 4 } },
    ]),
  },
  {
    id: 'glslFilmLook',
    label: 'Film Look',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Sun',
    description: 'GPU film print style color looks adapted from Flame film-look presets.',
    params: [
      { key: 'look', label: 'Look', min: 0, max: 8, step: 1 },
      { key: 'blend', label: 'Blend', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1, unit: '%' },
      { key: 'contrast', label: 'Contrast', min: 0, max: 200, step: 1, unit: '%' },
      { key: 'gamma', label: 'Gamma', min: 25, max: 200, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      look: 3,
      blend: 100,
      saturation: 100,
      contrast: 100,
      gamma: 100,
    }),
    presets: Object.freeze([
      { id: 'kodak2395', label: 'Kodak 2395', settings: { look: 3, blend: 100, saturation: 100, contrast: 100, gamma: 100 } },
      { id: 'agfa1978', label: 'Agfa 1978', settings: { look: 4, blend: 90, saturation: 90, contrast: 110, gamma: 100 } },
      { id: 'polaroid', label: 'Polaroid', settings: { look: 5, blend: 85, saturation: 110, contrast: 100, gamma: 100 } },
      { id: 'bw', label: 'B&W', settings: { look: 8, blend: 100, saturation: 100, contrast: 115, gamma: 90 } },
    ]),
  },
  {
    id: 'glslFlicker',
    label: 'Flicker',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Sparkles',
    description: 'Animated exposure, saturation, and contrast flicker.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'speed', label: 'Speed', min: 0.25, max: 30, step: 0.25, unit: 'Hz' },
      { key: 'brightness', label: 'Brightness', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'saturation', label: 'Saturation', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'contrast', label: 'Contrast', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'seed', label: 'Seed', min: 0, max: 9999, step: 1 },
    ],
    defaults: Object.freeze({
      amount: 35,
      speed: 8,
      brightness: 70,
      saturation: 15,
      contrast: 20,
      seed: 1337,
    }),
    presets: Object.freeze([
      { id: 'projector', label: 'Projector', settings: { amount: 24, speed: 10, brightness: 70, saturation: 10, contrast: 12, seed: 1337 } },
      { id: 'fluorescent', label: 'Fluorescent', settings: { amount: 38, speed: 18, brightness: 80, saturation: 0, contrast: 8, seed: 2244 } },
      { id: 'unstable', label: 'Unstable', settings: { amount: 62, speed: 7, brightness: 80, saturation: 45, contrast: 45, seed: 9182 } },
    ]),
  },
  {
    id: 'halation',
    label: 'Halation',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Sun',
    description: 'Warm red-orange glow around bright highlights, like film halation.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 200, step: 1, unit: '%' },
      { key: 'size', label: 'Size', min: 1, max: 80, step: 0.5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'warmth', label: 'Warmth', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      intensity: 60,
      size: 14,
      threshold: 65,
      warmth: 75,
    }),
    presets: Object.freeze([
      { id: 'subtle', label: 'Subtle Film', settings: { intensity: 35, size: 10, threshold: 70, warmth: 65 } },
      { id: 'print', label: 'Print Glow', settings: { intensity: 70, size: 16, threshold: 62, warmth: 80 } },
      { id: 'neonBleed', label: 'Neon Bleed', settings: { intensity: 120, size: 24, threshold: 55, warmth: 90 } },
    ]),
  },
  {
    id: 'vhsDamage',
    label: 'VHS / Analog Damage',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Radio',
    description: 'Scanlines, horizontal jitter, color bleed, and analog noise.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'jitter', label: 'Jitter', min: 0, max: 40, step: 0.5, unit: 'px' },
      { key: 'scanlines', label: 'Scanlines', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'colorBleed', label: 'Color Bleed', min: 0, max: 30, step: 0.25, unit: 'px' },
    ],
    defaults: Object.freeze({
      amount: 35,
      jitter: 5,
      scanlines: 35,
      colorBleed: 5,
    }),
    presets: Object.freeze([
      { id: 'cleanTape', label: 'Clean Tape', settings: { amount: 18, jitter: 2, scanlines: 20, colorBleed: 3 } },
      { id: 'musicVideo', label: '90s Music Video', settings: { amount: 38, jitter: 5, scanlines: 35, colorBleed: 6 } },
      { id: 'damaged', label: 'Damaged Tape', settings: { amount: 70, jitter: 14, scanlines: 60, colorBleed: 12 } },
    ]),
  },
  {
    id: 'glslVhsLook',
    label: 'VHS Look',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Radio',
    description: 'GPU VHS-style tape wave, scanlines, color bleed, and analog tint.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'resolution', label: 'Resolution', min: 20, max: 100, step: 1, unit: '%' },
      { key: 'wave', label: 'Tape Wave', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'bleed', label: 'Color Bleed', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'scanlines', label: 'Scanlines', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'tint', label: 'Tint', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'speed', label: 'Speed', min: 0.25, max: 10, step: 0.25, unit: 'x' },
    ],
    defaults: Object.freeze({
      amount: 45,
      resolution: 58,
      wave: 42,
      bleed: 45,
      scanlines: 35,
      tint: 30,
      speed: 1,
    }),
    presets: Object.freeze([
      { id: 'clean', label: 'Clean Tape', settings: { amount: 24, resolution: 70, wave: 20, bleed: 22, scanlines: 20, tint: 18, speed: 1 } },
      { id: 'analog', label: 'Analog', settings: { amount: 48, resolution: 55, wave: 45, bleed: 48, scanlines: 38, tint: 32, speed: 1.2 } },
      { id: 'damaged', label: 'Damaged', settings: { amount: 74, resolution: 38, wave: 78, bleed: 72, scanlines: 62, tint: 45, speed: 1.7 } },
    ]),
  },
  {
    id: 'glow',
    label: 'Glow',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'Sun',
    description: 'Soft diffusion / bloom. Threshold controls which brightness levels glow.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 200, step: 1, unit: '%' },
      { key: 'size', label: 'Size', min: 1, max: 80, step: 0.5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      intensity: 70,
      size: 12,
      threshold: 50,
    }),
    presets: Object.freeze([
      { id: 'dreamy', label: 'Dreamy Diffusion', settings: { intensity: 55, size: 18, threshold: 0 } },
      { id: 'soft', label: 'Soft Glow', settings: { intensity: 75, size: 14, threshold: 30 } },
      { id: 'bloom', label: 'Bloom', settings: { intensity: 90, size: 20, threshold: 60 } },
      { id: 'neon', label: 'Neon', settings: { intensity: 140, size: 10, threshold: 75 } },
    ]),
  },
  {
    id: 'letterbox',
    label: 'Letterbox',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'RectangleHorizontal',
    description: 'Crops to a target cinematic aspect ratio with black bars.',
    params: [
      { key: 'aspect', label: 'Aspect', min: 0.5, max: 3.5, step: 0.01, unit: ':1' },
      { key: 'opacity', label: 'Opacity', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'softness', label: 'Edge Softness', min: 0, max: 30, step: 0.5, unit: 'px' },
    ],
    defaults: Object.freeze({
      aspect: 2.39,
      opacity: 100,
      softness: 0,
    }),
    presets: Object.freeze([
      { id: 'cinemascope', label: 'Cinemascope 2.39', settings: { aspect: 2.39, opacity: 100, softness: 0 } },
      { id: 'anamorphic', label: 'Anamorphic 2.35', settings: { aspect: 2.35, opacity: 100, softness: 0 } },
      { id: 'widescreen', label: 'Widescreen 1.85', settings: { aspect: 1.85, opacity: 100, softness: 0 } },
      { id: 'academy', label: 'Academy 1.37', settings: { aspect: 1.37, opacity: 100, softness: 0 } },
      { id: 'square', label: 'Square 1:1', settings: { aspect: 1.0, opacity: 100, softness: 0 } },
      { id: 'vertical', label: 'Vertical 9:16', settings: { aspect: 0.5625, opacity: 100, softness: 0 } },
    ]),
  },
  {
    id: 'vignette',
    label: 'Vignette',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'Darkens the edges of the clip for a cinematic framing.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'size', label: 'Size', min: 10, max: 100, step: 1, unit: '%' },
      { key: 'softness', label: 'Softness', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      amount: 45,
      size: 70,
      softness: 60,
    }),
    presets: Object.freeze([
      { id: 'soft', label: 'Soft', settings: { amount: 25, size: 80, softness: 80 } },
      { id: 'cinematic', label: 'Cinematic', settings: { amount: 45, size: 65, softness: 60 } },
      { id: 'tunnel', label: 'Tunnel', settings: { amount: 75, size: 50, softness: 40 } },
    ]),
  },
  {
    id: 'glslVignette',
    label: 'Vignette',
    category: EFFECT_CATEGORIES.stylistic,
    icon: 'CircleDot',
    description: 'GPU shader vignette with the same basic controls as the standard version.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'size', label: 'Size', min: 10, max: 100, step: 1, unit: '%' },
      { key: 'softness', label: 'Softness', min: 0, max: 100, step: 1, unit: '%' },
    ],
    defaults: Object.freeze({
      amount: 45,
      size: 70,
      softness: 60,
    }),
    presets: Object.freeze([
      { id: 'soft', label: 'Soft', settings: { amount: 25, size: 80, softness: 80 } },
      { id: 'cinematic', label: 'Cinematic', settings: { amount: 45, size: 65, softness: 60 } },
      { id: 'tunnel', label: 'Tunnel', settings: { amount: 75, size: 50, softness: 40 } },
    ]),
  },
])

const LEGACY_EFFECTS_WITH_GLSL_REPLACEMENTS = new Set([
  'cameraShake',
  'directionalBlur',
  'chromaticAberration',
  'sharpen',
  'filmGrain',
  'vhsDamage',
  'vignette',
])

export const EFFECT_PICKER_TYPES = Object.freeze(
  EFFECT_TYPES.filter((type) => !LEGACY_EFFECTS_WITH_GLSL_REPLACEMENTS.has(type.id))
)

const EFFECT_PICKER_CATEGORY_DEFINITIONS = Object.freeze([
  {
    id: 'motion',
    label: 'Motion',
    effectIds: ['glslCameraShake'],
  },
  {
    id: 'blur-focus',
    label: 'Blur & Focus',
    effectIds: ['gaussianBlur', 'glslDirectionalBlur', 'glslLensBlur', 'glslSharpen'],
  },
  {
    id: 'lens-distortion',
    label: 'Lens & Distortion',
    effectIds: ['glslFisheye', 'glslChromaWarp'],
  },
  {
    id: 'film-color',
    label: 'Film & Color',
    effectIds: ['glslFilmGrain', 'glslFilmLook', 'glslFlicker', 'halation', 'glow'],
  },
  {
    id: 'analog-glitch',
    label: 'Analog & Glitch',
    effectIds: ['glslVhsLook', 'glslDigitalGlitch'],
  },
  {
    id: 'framing',
    label: 'Framing',
    effectIds: ['letterbox', 'glslVignette'],
  },
])

export const EFFECT_PICKER_GROUPS = Object.freeze(
  EFFECT_PICKER_CATEGORY_DEFINITIONS
    .map((category) => Object.freeze({
      id: category.id,
      label: category.label,
      effects: Object.freeze(
        category.effectIds
          .map((id) => EFFECT_PICKER_TYPES.find((type) => type.id === id))
          .filter(Boolean)
      ),
    }))
    .filter((category) => category.effects.length > 0)
)

const EFFECT_TYPE_MAP = new Map(EFFECT_TYPES.map((type) => [type.id, type]))
const STYLISTIC_EFFECT_IDS = new Set(
  EFFECT_TYPES.filter((type) => type.category === EFFECT_CATEGORIES.stylistic).map((type) => type.id)
)

export function getEffectTypeDefinition(typeId) {
  return EFFECT_TYPE_MAP.get(typeId) || null
}

export function isManagedEffectType(typeId) {
  return EFFECT_TYPE_MAP.has(typeId)
}

export function isStylisticEffectType(typeId) {
  return STYLISTIC_EFFECT_IDS.has(typeId)
}

export function getEffectPropertyId(effectId, paramKey) {
  return `effect.${effectId}.${paramKey}`
}

/**
 * Extract the effectId/paramKey from an effect property id, returning null
 * if the key is not an effect property.
 */
export function parseEffectPropertyId(propertyId) {
  if (typeof propertyId !== 'string') return null
  if (!propertyId.startsWith('effect.')) return null
  const rest = propertyId.slice('effect.'.length)
  const separator = rest.lastIndexOf('.')
  if (separator <= 0) return null
  return {
    effectId: rest.slice(0, separator),
    paramKey: rest.slice(separator + 1),
  }
}

/**
 * Normalize a raw effect object into a trusted shape, clamping each param to
 * its declared range and filling in defaults. Unknown types pass through
 * unchanged so existing effect types like `mask` keep working.
 */
export function normalizeEffectSettings(effect = {}) {
  if (!effect || typeof effect !== 'object') return effect
  const definition = EFFECT_TYPE_MAP.get(effect.type)
  if (!definition) return effect

  const rawSettings = effect.settings && typeof effect.settings === 'object'
    ? effect.settings
    : {}
  const normalized = {}
  for (const param of definition.params) {
    const incoming = Object.prototype.hasOwnProperty.call(rawSettings, param.key)
      ? rawSettings[param.key]
      : definition.defaults[param.key]
    if (param.type === 'toggle') {
      normalized[param.key] = incoming ? 1 : 0
    } else {
      normalized[param.key] = clampNumber(
        incoming,
        param.min,
        param.max,
        definition.defaults[param.key]
      )
    }
  }

  return {
    ...effect,
    settings: normalized,
  }
}

/**
 * Build the effect with any keyframed parameter values resolved at the given
 * clip-relative time.
 */
export function getAnimatedEffectSettings(clip, effect, clipTime) {
  if (!clip || !effect) return normalizeEffectSettings(effect)
  const definition = EFFECT_TYPE_MAP.get(effect.type)
  if (!definition) return normalizeEffectSettings(effect)

  const normalized = normalizeEffectSettings(effect).settings
  const keyframes = clip.keyframes || {}
  const animated = { ...normalized }

  for (const param of definition.params) {
    const propertyId = getEffectPropertyId(effect.id, param.key)
    const paramKeyframes = keyframes[propertyId]
    if (Array.isArray(paramKeyframes) && paramKeyframes.length > 0) {
      const base = normalized[param.key]
      const value = getValueAtTime(paramKeyframes, clipTime, base)
      if (param.type === 'toggle') {
        animated[param.key] = value >= 0.5 ? 1 : 0
      } else {
        animated[param.key] = clampNumber(value, param.min, param.max, base)
      }
    }
  }

  return { ...effect, settings: animated }
}

// ---------------------------------------------------------------------------
// Camera shake (procedural transform)
// ---------------------------------------------------------------------------

// djb2-style string hash -> 32-bit unsigned
function hashString(input) {
  const source = String(input || '')
  let hash = 5381
  for (let i = 0; i < source.length; i++) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0
  }
  return hash >>> 0
}

/**
 * Compute a deterministic shake offset for the given camera-shake effect at
 * the clip-relative time. Returns additive px offsets for X/Y and a degree
 * offset for rotation.
 */
export function getCameraShakeOffset(effect, clipTime) {
  if (!effect || effect.enabled === false) return { x: 0, y: 0, rotation: 0 }
  const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
  const { intensity = 0, speed = 0, rotation = 0 } = animated.settings || {}
  if (intensity <= 0 && rotation <= 0) return { x: 0, y: 0, rotation: 0 }

  const seed = hashString(effect.id || 'camera-shake')
  const tau = Math.PI * 2
  const phaseX = ((seed & 0xffff) / 0xffff) * tau
  const phaseY = (((seed >>> 16) & 0xffff) / 0xffff) * tau
  const phaseR = ((seed * 2654435761) >>> 0) / 0xffffffff * tau
  const t = Math.max(0, Number(clipTime) || 0)
  const omega = tau * Math.max(0, Number(speed) || 0)

  // Layered sinusoids emulate natural handheld micro-motion without looking
  // mechanical. The amplitude of each octave falls off so the primary wobble
  // dominates.
  const shakeIntensityPx = (Number(intensity) || 0) * 0.9 // 0..90 px at max
  const shakeRotationDeg = (Number(rotation) || 0) * 0.05 // 0..5 deg at max

  const xNoise =
    Math.sin(omega * t + phaseX) * 0.6
    + Math.sin(omega * 1.73 * t + phaseX * 1.21) * 0.3
    + Math.sin(omega * 2.41 * t + phaseX * 0.57) * 0.1

  const yNoise =
    Math.cos(omega * 0.91 * t + phaseY) * 0.6
    + Math.cos(omega * 1.57 * t + phaseY * 1.33) * 0.3
    + Math.cos(omega * 2.83 * t + phaseY * 0.73) * 0.1

  const rNoise =
    Math.sin(omega * 0.61 * t + phaseR) * 0.7
    + Math.sin(omega * 1.87 * t + phaseR * 1.09) * 0.3

  return {
    x: xNoise * shakeIntensityPx,
    y: yNoise * shakeIntensityPx,
    rotation: rNoise * shakeRotationDeg,
  }
}

/**
 * Fold all enabled camera-shake effects into a transform object.
 * Returns a *new* transform – the input transform is not mutated. Accepts
 * undefined and returns undefined so callers can forward it transparently.
 */
export function applyEffectsToTransform(transform, effects, clipTime) {
  if (!transform) return transform
  if (!Array.isArray(effects) || effects.length === 0) return transform

  let offsetX = 0
  let offsetY = 0
  let rotationOffset = 0

  for (const effect of effects) {
    if (!effect || effect.enabled === false) continue
    if (effect.type !== 'cameraShake') continue
    const shake = getCameraShakeOffset(effect, clipTime)
    offsetX += shake.x
    offsetY += shake.y
    rotationOffset += shake.rotation
  }

  if (offsetX === 0 && offsetY === 0 && rotationOffset === 0) {
    return transform
  }

  return {
    ...transform,
    positionX: (Number(transform.positionX) || 0) + offsetX,
    positionY: (Number(transform.positionY) || 0) + offsetY,
    rotation: (Number(transform.rotation) || 0) + rotationOffset,
  }
}

// ---------------------------------------------------------------------------
// Filter chain helpers (for preview SVG filter + export pixel pipeline)
// ---------------------------------------------------------------------------

/**
 * Returns the subset of a clip's effects that contribute to the pixel filter
 * chain. Vignette and letterbox are
 * applied as an overlay so it is excluded here.
 */
export function getFilterChainEffects(effects, clipTime) {
  if (!Array.isArray(effects) || effects.length === 0) return []
  const result = []
  for (const effect of effects) {
    if (!effect || effect.enabled === false) continue
    if (effect.type !== 'gaussianBlur'
      && effect.type !== 'directionalBlur'
      && effect.type !== 'chromaticAberration'
      && effect.type !== 'sharpen'
      && effect.type !== 'filmGrain'
      && effect.type !== 'glow'
      && effect.type !== 'halation'
      && effect.type !== 'vhsDamage') continue
    const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
    result.push(animated)
  }
  return result
}

/**
 * Returns the active, animated vignette effect (or null).
 */
export function getActiveVignetteEffect(effects, clipTime) {
  if (!Array.isArray(effects) || effects.length === 0) return null
  const vignette = effects.find((e) => e && e.enabled !== false && e.type === 'vignette')
  if (!vignette) return null
  return getAnimatedEffectSettings({ keyframes: null }, vignette, clipTime)
}

/**
 * Quick booleans used by the render path to decide whether to allocate
 * offscreen canvases / SVG filter nodes.
 */
export function hasCameraShakeEffect(effects) {
  return Array.isArray(effects)
    && effects.some((e) => e && e.enabled !== false && e.type === 'cameraShake')
}

export function hasPixelFilterEffect(effects) {
  return Array.isArray(effects)
    && effects.some((e) => (
      e
      && e.enabled !== false
      && (
        e.type === 'gaussianBlur'
        || e.type === 'directionalBlur'
        || e.type === 'chromaticAberration'
        || e.type === 'sharpen'
        || e.type === 'filmGrain'
        || e.type === 'glow'
        || e.type === 'halation'
        || e.type === 'vhsDamage'
      )
    ))
}

export function hasGlowEffect(effects) {
  return Array.isArray(effects)
    && effects.some((e) => e && e.enabled !== false && (e.type === 'glow' || e.type === 'halation'))
}

export function getActiveGlowEffects(effects) {
  if (!Array.isArray(effects)) return []
  return effects.filter((e) => e && e.enabled !== false && (e.type === 'glow' || e.type === 'halation'))
}

export function hasVignetteEffect(effects) {
  return Array.isArray(effects)
    && effects.some((e) => e && e.enabled !== false && e.type === 'vignette')
}

export function hasLetterboxEffect(effects) {
  return Array.isArray(effects)
    && effects.some((e) => e && e.enabled !== false && e.type === 'letterbox')
}

/**
 * Returns the active, animated letterbox effect (or null).
 */
export function getActiveLetterboxEffect(effects, clipTime) {
  if (!Array.isArray(effects) || effects.length === 0) return null
  const letterbox = effects.find((e) => e && e.enabled !== false && e.type === 'letterbox')
  if (!letterbox) return null
  return getAnimatedEffectSettings({ keyframes: null }, letterbox, clipTime)
}

export function hasAnyManagedEffect(effects) {
  return Array.isArray(effects)
    && effects.some((e) => e && e.enabled !== false && STYLISTIC_EFFECT_IDS.has(e.type) || e?.type === 'cameraShake')
}

/**
 * Build a stable SVG filter id for a clip's effect chain. Sanitizes non-word
 * characters so the id is safe to use in both DOM and CSS `url(#...)` refs.
 */
export function getClipEffectFilterId(clipId, layerKey = '') {
  const safeClipId = String(clipId || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeLayer = String(layerKey || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `clip-effects-${safeClipId}${safeLayer ? `-${safeLayer}` : ''}`
}

// ---------------------------------------------------------------------------
// Export / canvas pixel pipeline
// ---------------------------------------------------------------------------

/**
 * Seed the grain PRNG with a deterministic but time-varying value so grain
 * moves frame-to-frame during export but matches between runs.
 */
function grainSeedFor(effect, clipTime, frameIndex) {
  const idHash = hashString(effect?.id || 'grain')
  const timeSeed = Math.floor((Number(clipTime) || 0) * 1000)
  const frameSeed = Number.isFinite(frameIndex) ? Math.floor(frameIndex) : 0
  return (idHash ^ (timeSeed * 2654435761) ^ (frameSeed * 374761393)) >>> 0
}

function mulberry32(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Apply chromatic aberration pixel shift to image data in-place. Shifts the
 * red channel by `+offset`, the blue channel by `-offset` along the effect
 * angle. Leaves the green channel and alpha untouched.
 */
function applyChromaticAberrationToImageData(imageData, settings, canvasWidth, canvasHeight) {
  const amount = Number(settings?.amount) || 0
  if (amount <= 0) return
  const angleRad = ((Number(settings?.angle) || 0) * Math.PI) / 180
  const dx = Math.round(Math.cos(angleRad) * amount)
  const dy = Math.round(Math.sin(angleRad) * amount)
  if (dx === 0 && dy === 0) return

  const { data, width, height } = imageData
  const W = width || canvasWidth
  const H = height || canvasHeight
  const src = new Uint8ClampedArray(data)

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dstIndex = (y * W + x) * 4
      const redX = x - dx
      const redY = y - dy
      const blueX = x + dx
      const blueY = y + dy

      if (redX >= 0 && redX < W && redY >= 0 && redY < H) {
        data[dstIndex] = src[(redY * W + redX) * 4]
      }
      if (blueX >= 0 && blueX < W && blueY >= 0 && blueY < H) {
        data[dstIndex + 2] = src[(blueY * W + blueX) * 4 + 2]
      }
    }
  }
}

function applySharpenToImageData(imageData, settings) {
  const amount = Math.max(0, Math.min(100, Number(settings?.amount) || 0))
  if (amount <= 0) return

  const { data, width, height } = imageData
  if (!width || !height) return

  const src = new Uint8ClampedArray(data)
  const strength = (amount / 100) * 0.55
  const centerWeight = 1 + 4 * strength
  const adjacentWeight = -strength

  const sampleIndex = (x, y) => {
    const sx = Math.max(0, Math.min(width - 1, x))
    const sy = Math.max(0, Math.min(height - 1, y))
    return (sy * width + sx) * 4
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4
      const center = sampleIndex(x, y)
      const left = sampleIndex(x - 1, y)
      const right = sampleIndex(x + 1, y)
      const up = sampleIndex(x, y - 1)
      const down = sampleIndex(x, y + 1)

      for (let channel = 0; channel < 3; channel++) {
        const value =
          src[center + channel] * centerWeight
          + (src[left + channel] + src[right + channel] + src[up + channel] + src[down + channel]) * adjacentWeight
        data[dst + channel] = Math.max(0, Math.min(255, value))
      }
      data[dst + 3] = src[center + 3]
    }
  }
}

function applyFilmGrainToImageData(imageData, settings, clipTime, frameIndex) {
  const amount = Number(settings?.amount) || 0
  if (amount <= 0) return
  const monochrome = Number(settings?.monochrome) >= 0.5
  const strength = (amount / 100) * 0.65 // keep grain perceptually gentle
  const size = Math.max(0.5, Number(settings?.size) || 1)
  const random = mulberry32(grainSeedFor({ id: 'grain' }, clipTime, frameIndex))
  const { data, width, height } = imageData
  const stride = Math.max(1, Math.floor(size))
  const fullStrength = strength * 255

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (monochrome) {
        const noise = (random() * 2 - 1) * fullStrength
        for (let sy = 0; sy < stride && (y + sy) < height; sy++) {
          for (let sx = 0; sx < stride && (x + sx) < width; sx++) {
            const idx = ((y + sy) * width + (x + sx)) * 4
            data[idx] = Math.max(0, Math.min(255, data[idx] + noise))
            data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + noise))
            data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + noise))
          }
        }
      } else {
        const nR = (random() * 2 - 1) * fullStrength
        const nG = (random() * 2 - 1) * fullStrength
        const nB = (random() * 2 - 1) * fullStrength
        for (let sy = 0; sy < stride && (y + sy) < height; sy++) {
          for (let sx = 0; sx < stride && (x + sx) < width; sx++) {
            const idx = ((y + sy) * width + (x + sx)) * 4
            data[idx] = Math.max(0, Math.min(255, data[idx] + nR))
            data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + nG))
            data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + nB))
          }
        }
      }
    }
  }
}

function applyVhsDamageToImageData(imageData, effect, settings, clipTime, frameIndex) {
  const amount = Math.max(0, Math.min(100, Number(settings?.amount) || 0))
  const jitter = Math.max(0, Number(settings?.jitter) || 0)
  const scanlines = Math.max(0, Math.min(100, Number(settings?.scanlines) || 0))
  const colorBleed = Math.max(0, Number(settings?.colorBleed) || 0)
  if (amount <= 0 && jitter <= 0 && scanlines <= 0 && colorBleed <= 0) return

  const { data, width, height } = imageData
  const src = new Uint8ClampedArray(data)
  const random = mulberry32(grainSeedFor(effect, clipTime, frameIndex))
  const amountNorm = amount / 100
  const maxJitter = jitter * amountNorm
  const bleedPx = Math.round(colorBleed * amountNorm)
  const scanStrength = (scanlines / 100) * amountNorm
  const dropoutChance = amountNorm * 0.018

  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 8)
    const bandNoise = Math.sin((clipTime * 17 + band * 1.73) * Math.PI * 2)
    const rowShift = Math.round(bandNoise * maxJitter + (random() - 0.5) * maxJitter * 0.75)
    const scanPhase = y % 3
    const scanDarken = scanPhase === 0
      ? scanStrength * 54
      : (scanPhase === 1 ? scanStrength * 12 : 0)
    const dropout = random() < dropoutChance
    const dropoutShift = dropout ? Math.round((random() - 0.5) * maxJitter * 3) : 0
    const dropoutLift = dropout ? (random() * 2 - 1) * 52 * amountNorm : 0

    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4
      const sx = Math.max(0, Math.min(width - 1, x - rowShift - dropoutShift))
      const redX = Math.max(0, Math.min(width - 1, sx - bleedPx))
      const blueX = Math.max(0, Math.min(width - 1, sx + bleedPx))
      const srcBase = (y * width + sx) * 4
      const redBase = (y * width + redX) * 4
      const blueBase = (y * width + blueX) * 4
      const noise = (random() - 0.5) * 58 * amountNorm + dropoutLift

      data[dst] = Math.max(0, Math.min(255, src[redBase] + noise - scanDarken))
      data[dst + 1] = Math.max(0, Math.min(255, src[srcBase + 1] + noise * 0.55 - scanDarken))
      data[dst + 2] = Math.max(0, Math.min(255, src[blueBase + 2] + noise - scanDarken))
      data[dst + 3] = src[srcBase + 3]
    }
  }
}

/**
 * Apply pixel effects (chromatic aberration, sharpening, film grain, VHS damage)
 * to image data in-place. Vignette is handled separately via
 * `drawVignetteOverlay` because it composites on top rather than inside the
 * clip's pixel pipeline.
 */
export function applyPixelEffectsToImageData(imageData, effects, clipTime, frameIndex = 0) {
  if (!imageData?.data) return imageData
  if (!Array.isArray(effects) || effects.length === 0) return imageData
  const width = imageData.width
  const height = imageData.height

  for (const effect of effects) {
    if (!effect || effect.enabled === false) continue
    if (effect.type === 'chromaticAberration') {
      const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
      applyChromaticAberrationToImageData(imageData, animated.settings, width, height)
    } else if (effect.type === 'sharpen') {
      const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
      applySharpenToImageData(imageData, animated.settings)
    } else if (effect.type === 'filmGrain') {
      const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
      applyFilmGrainToImageData(imageData, animated.settings, clipTime, frameIndex)
    } else if (effect.type === 'vhsDamage') {
      const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
      applyVhsDamageToImageData(imageData, effect, animated.settings, clipTime, frameIndex)
    }
  }

  return imageData
}

export function applyBlurPassesToCanvas(canvas, ctx, width, height, effects, clipTime) {
  if (!canvas || !ctx || !Array.isArray(effects)) return

  let scratch = null
  let scratchCtx = null
  const ensureScratch = () => {
    if (!scratch) {
      scratch = document.createElement('canvas')
      scratch.width = width
      scratch.height = height
      scratchCtx = scratch.getContext('2d')
    }
    scratchCtx.save()
    scratchCtx.filter = 'none'
    scratchCtx.globalCompositeOperation = 'copy'
    scratchCtx.globalAlpha = 1
    scratchCtx.drawImage(canvas, 0, 0)
    scratchCtx.restore()
  }

  for (const effect of effects) {
    if (!effect || effect.enabled === false) continue
    const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
    if (effect.type === 'gaussianBlur') {
      const amount = Math.max(0, Number(animated.settings?.amount) || 0)
      if (amount <= 0) continue
      ensureScratch()
      ctx.save()
      ctx.filter = `blur(${amount}px)`
      ctx.globalCompositeOperation = 'copy'
      ctx.drawImage(scratch, 0, 0)
      ctx.restore()
    } else if (effect.type === 'directionalBlur') {
      const amount = Math.max(0, Number(animated.settings?.amount) || 0)
      if (amount <= 0) continue
      const samples = Math.max(3, Math.min(15, Math.round(Number(animated.settings?.samples) || 7)))
      const oddSamples = samples % 2 === 0 ? samples + 1 : samples
      const angleRad = ((Number(animated.settings?.angle) || 0) * Math.PI) / 180
      const dx = Math.cos(angleRad) * amount
      const dy = Math.sin(angleRad) * amount
      ensureScratch()
      ctx.save()
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'copy'
      ctx.globalAlpha = 0
      ctx.drawImage(scratch, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1 / oddSamples
      const half = (oddSamples - 1) / 2
      for (let i = 0; i < oddSamples; i++) {
        const t = half === 0 ? 0 : (i - half) / half
        ctx.drawImage(scratch, dx * t, dy * t)
      }
      ctx.restore()
    }
  }
}

/**
 * Apply glow / bloom passes to a canvas by blurring a thresholded copy and
 * screen-blending it back on top. Mutates the canvas in place. `effects` is
 * the full clip effect array; only enabled glow effects are processed, in
 * stack order. A fresh scratch canvas is reused between passes.
 */
export function applyGlowPassesToCanvas(canvas, ctx, width, height, effects, clipTime) {
  if (!canvas || !ctx) return
  const glows = getActiveGlowEffects(effects)
  if (glows.length === 0) return

  let scratch = null
  let scratchCtx = null
  let thresholdCanvas = null
  let thresholdCtx = null

  for (const effect of glows) {
    const animated = getAnimatedEffectSettings({ keyframes: null }, effect, clipTime)
    const { intensity = 0, size = 12, threshold = 0 } = animated.settings || {}
    if (intensity <= 0 || size <= 0) continue

    if (!scratch) {
      scratch = document.createElement('canvas')
      scratch.width = width
      scratch.height = height
      scratchCtx = scratch.getContext('2d')
    }

    // Step 1: copy source into scratch and optionally apply a soft brightness
    // threshold so only brighter pixels contribute to the glow.
    scratchCtx.save()
    scratchCtx.filter = 'none'
    scratchCtx.globalCompositeOperation = 'copy'
    scratchCtx.drawImage(canvas, 0, 0)
    scratchCtx.restore()

    if (threshold > 0) {
      if (!thresholdCanvas) {
        thresholdCanvas = document.createElement('canvas')
        thresholdCanvas.width = width
        thresholdCanvas.height = height
        thresholdCtx = thresholdCanvas.getContext('2d')
      }
      const imageData = scratchCtx.getImageData(0, 0, width, height)
      const data = imageData.data
      const cutoff = Math.max(0, Math.min(1, threshold / 100)) * 255
      const range = Math.max(1, 255 - cutoff)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const luma = 0.299 * r + 0.587 * g + 0.114 * b
        const t = Math.max(0, (luma - cutoff) / range)
        const gain = t * t // soft knee
        data[i] = r * gain
        data[i + 1] = g * gain
        data[i + 2] = b * gain
        // Keep alpha so blur respects silhouette.
      }
      scratchCtx.putImageData(imageData, 0, 0)
    }

    if (effect.type === 'halation') {
      const imageData = scratchCtx.getImageData(0, 0, width, height)
      const data = imageData.data
      const warmth = Math.max(0, Math.min(1, (Number(animated.settings?.warmth) || 0) / 100))
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        data[i] = Math.min(255, luma * (1.05 + warmth * 0.65))
        data[i + 1] = Math.min(255, luma * (0.55 + warmth * 0.22))
        data[i + 2] = Math.min(255, luma * (0.22 + warmth * 0.08))
      }
      scratchCtx.putImageData(imageData, 0, 0)
    }

    // Step 2: blur the scratch buffer using the canvas native filter.
    const blurPx = Math.max(0.5, Number(size) || 0)
    scratchCtx.save()
    scratchCtx.filter = `blur(${blurPx}px)`
    scratchCtx.globalCompositeOperation = 'copy'
    scratchCtx.drawImage(scratch, 0, 0)
    scratchCtx.restore()

    // Step 3: screen-blend the blurred glow back onto the source with the
    // intensity driving globalAlpha (cap at ~2x for a bright punch).
    ctx.save()
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'screen'
    ctx.globalAlpha = Math.max(0, Math.min(2, (Number(intensity) || 0) / 100))
    ctx.drawImage(scratch, 0, 0)
    ctx.restore()
  }
}

/**
 * Draw a vignette radial gradient over a canvas context. Coordinates are in
 * canvas pixels. The vignette fills the full canvas; size controls the
 * radius of the clear center, softness controls the feather, and amount
 * controls the darkness at the edges.
 */
export function drawVignetteOverlay(ctx, width, height, vignetteEffect, clipTime, options = {}) {
  if (!ctx || !vignetteEffect || vignetteEffect.enabled === false) return
  const animated = getAnimatedEffectSettings({ keyframes: null }, vignetteEffect, clipTime)
  const { amount = 0, size = 70, softness = 60 } = animated.settings || {}
  if (amount <= 0) return
  const compositeOperation = options.compositeOperation || 'source-over'

  const centerX = width / 2
  const centerY = height / 2
  const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY)
  const clearRadius = (Math.max(0, Math.min(100, size)) / 100) * maxRadius * 0.55
  const fullRadius = maxRadius * (1 - (Math.max(0, Math.min(100, softness)) / 100) * 0.25)
  const startRadius = Math.min(clearRadius, fullRadius * 0.98)

  const gradient = ctx.createRadialGradient(
    centerX,
    centerY,
    startRadius,
    centerX,
    centerY,
    fullRadius
  )
  gradient.addColorStop(0, 'rgba(0,0,0,0)')
  gradient.addColorStop(1, `rgba(0,0,0,${Math.max(0, Math.min(1, amount / 100))})`)

  ctx.save()
  ctx.globalCompositeOperation = compositeOperation
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/**
 * Draw letterbox bars over a canvas context at the given target aspect ratio.
 * Bars sit on top of everything else and clip the visible frame to the
 * requested aspect (horizontal bars for a wider target, vertical bars for a
 * narrower one). Softness adds a gradient feather at the bar edge.
 */
export function drawLetterboxOverlay(ctx, width, height, letterboxEffect, clipTime, options = {}) {
  if (!ctx || !letterboxEffect || letterboxEffect.enabled === false) return
  const animated = getAnimatedEffectSettings({ keyframes: null }, letterboxEffect, clipTime)
  const { aspect = 2.39, opacity = 100, softness = 0 } = animated.settings || {}
  const alpha = Math.max(0, Math.min(1, (Number(opacity) || 0) / 100))
  if (alpha <= 0) return
  const targetAspect = Math.max(0.1, Number(aspect) || 0)
  const containerAspect = width / height
  const compositeOperation = options.compositeOperation || 'source-over'
  const soft = Math.max(0, Number(softness) || 0)

  ctx.save()
  ctx.globalCompositeOperation = compositeOperation
  const barColor = `rgba(0,0,0,${alpha})`

  if (containerAspect > targetAspect) {
    // Wider than target -> pillarbox (left/right bars)
    const visibleWidth = height * targetAspect
    const barWidth = Math.max(0, (width - visibleWidth) / 2)
    if (barWidth <= 0) {
      ctx.restore()
      return
    }
    if (soft > 0) {
      const leftGrad = ctx.createLinearGradient(0, 0, barWidth + soft, 0)
      leftGrad.addColorStop(0, barColor)
      leftGrad.addColorStop(Math.max(0, (barWidth) / (barWidth + soft)), barColor)
      leftGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = leftGrad
      ctx.fillRect(0, 0, barWidth + soft, height)

      const rightGrad = ctx.createLinearGradient(width, 0, width - barWidth - soft, 0)
      rightGrad.addColorStop(0, barColor)
      rightGrad.addColorStop(Math.max(0, (barWidth) / (barWidth + soft)), barColor)
      rightGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = rightGrad
      ctx.fillRect(width - barWidth - soft, 0, barWidth + soft, height)
    } else {
      ctx.fillStyle = barColor
      ctx.fillRect(0, 0, barWidth, height)
      ctx.fillRect(width - barWidth, 0, barWidth, height)
    }
  } else if (containerAspect < targetAspect) {
    // Narrower than target -> letterbox (top/bottom bars)
    const visibleHeight = width / targetAspect
    const barHeight = Math.max(0, (height - visibleHeight) / 2)
    if (barHeight <= 0) {
      ctx.restore()
      return
    }
    if (soft > 0) {
      const topGrad = ctx.createLinearGradient(0, 0, 0, barHeight + soft)
      topGrad.addColorStop(0, barColor)
      topGrad.addColorStop(Math.max(0, barHeight / (barHeight + soft)), barColor)
      topGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = topGrad
      ctx.fillRect(0, 0, width, barHeight + soft)

      const bottomGrad = ctx.createLinearGradient(0, height, 0, height - barHeight - soft)
      bottomGrad.addColorStop(0, barColor)
      bottomGrad.addColorStop(Math.max(0, barHeight / (barHeight + soft)), barColor)
      bottomGrad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = bottomGrad
      ctx.fillRect(0, height - barHeight - soft, width, barHeight + soft)
    } else {
      ctx.fillStyle = barColor
      ctx.fillRect(0, 0, width, barHeight)
      ctx.fillRect(0, height - barHeight, width, barHeight)
    }
  }
  ctx.restore()
}

/**
 * Build the CSS that renders the preview-time letterbox overlay. Uses a
 * container-query sized inner rectangle centered within the clip area and a
 * huge box-shadow to paint the bars around it. Caller is responsible for
 * giving the wrapping node `containerType: 'size'`.
 */
export function buildLetterboxOverlayStyles(letterboxEffect, clipTime) {
  if (!letterboxEffect || letterboxEffect.enabled === false) return null
  const animated = getAnimatedEffectSettings({ keyframes: null }, letterboxEffect, clipTime)
  const { aspect = 2.39, opacity = 100, softness = 0 } = animated.settings || {}
  const alpha = Math.max(0, Math.min(1, (Number(opacity) || 0) / 100))
  if (alpha <= 0) return null
  const targetAspect = Math.max(0.1, Number(aspect) || 0)
  const soft = Math.max(0, Number(softness) || 0)
  const barColor = `rgba(0,0,0,${alpha})`
  const blurFilter = soft > 0 ? `blur(${soft}px)` : undefined

  return {
    wrapper: {
      position: 'absolute',
      inset: 0,
      overflow: 'hidden',
      pointerEvents: 'none',
      containerType: 'size',
      zIndex: 3,
    },
    inner: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: `min(100%, calc(100cqh * ${targetAspect}))`,
      height: `min(100%, calc(100cqw / ${targetAspect}))`,
      boxShadow: `0 0 0 9999px ${barColor}`,
      filter: blurFilter,
      WebkitFilter: blurFilter,
    },
  }
}

/**
 * Build the CSS that renders the preview-time vignette overlay div. The div
 * sits over the clip's rendered frame inside its transform container.
 */
export function buildVignetteOverlayStyle(vignetteEffect, clipTime) {
  if (!vignetteEffect || vignetteEffect.enabled === false) return null
  const animated = getAnimatedEffectSettings({ keyframes: null }, vignetteEffect, clipTime)
  const { amount = 0, size = 70, softness = 60 } = animated.settings || {}
  if (amount <= 0) return null

  const innerStop = Math.max(5, Math.min(95, size * 0.55))
  const outerFade = Math.max(0, Math.min(60, softness * 0.6))
  const outerStop = Math.min(100, innerStop + outerFade + 5)
  const alpha = Math.max(0, Math.min(1, amount / 100))

  return {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 2,
    background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${innerStop}%, rgba(0,0,0,${alpha}) ${outerStop}%, rgba(0,0,0,${alpha}) 100%)`,
  }
}

export { EFFECT_CATEGORIES }
