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
uniform vec2 u_velocityPx;
uniform float u_samples;
uniform float u_sharpness;
uniform float u_falloff;
// 0.0 = trail (smear extends one way, behind motion);
// 0.5 = centered shutter (smear extends both ways around the frame).
uniform float u_center;
varying vec2 v_texCoord;

void main() {
  float samples = clamp(u_samples, 2.0, 48.0);
  vec2 velocityUv = u_velocityPx * u_texelSize;
  vec4 accum = vec4(0.0);
  float total = 0.0;
  // Per-pixel jitter de-bands long smears: each pixel shifts its sample
  // positions by up to one step, turning visible stepping into fine noise.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;

  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    if (fi < samples) {
      float p = fi / max(1.0, samples - 1.0);
      // Centered: uniform box weights — a real shutter exposes the whole
      // interval evenly, so a constant-speed move reads as one even smear.
      // Trail: decaying weights. The pow base is floored: drivers may
      // compute p via reciprocal-multiply so (1.0 - p) can land a hair
      // NEGATIVE, and pow(negative, y) is undefined in GLSL — NaN on
      // ANGLE/D3D — which poisons the weight total and blanks the whole
      // layer at sample counts whose reciprocal rounds the wrong way.
      float weight = u_center > 0.25
        ? 1.0
        : pow(max(0.001, 1.0 - p), u_falloff);
      float pj = clamp(p + jitter / samples, 0.0, 1.0);
      vec4 sampleColor = texture2D(u_image, v_texCoord + velocityUv * (pj - u_center));
      accum.rgb += sampleColor.rgb * sampleColor.a * weight;
      accum.a += sampleColor.a * weight;
      total += weight;
    }
  }

  vec4 blurred = vec4(0.0);
  blurred.a = accum.a / max(0.0001, total);
  blurred.rgb = accum.a > 0.0001 ? accum.rgb / accum.a : vec3(0.0);

  vec4 sharp = texture2D(u_image, v_texCoord);
  vec4 color = mix(blurred, sharp, clamp(u_sharpness, 0.0, 1.0));
  gl_FragColor = color;
}
`

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

let webGlSupport = null
const rendererCache = new Map()

function createCanvas(width = 1, height = 1) {
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  return null
}

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

function createVelocityMotionBlurRenderer(width, height) {
  const canvas = createCanvas(width, height)
  const gl = canvas?.getContext?.('webgl', {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  }) || canvas?.getContext?.('experimental-webgl')
  if (!gl) throw new Error('WebGL is not available')

  const program = createProgram(gl)
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord')
  const imageLocation = gl.getUniformLocation(program, 'u_image')
  const texelSizeLocation = gl.getUniformLocation(program, 'u_texelSize')
  const velocityLocation = gl.getUniformLocation(program, 'u_velocityPx')
  const samplesLocation = gl.getUniformLocation(program, 'u_samples')
  const sharpnessLocation = gl.getUniformLocation(program, 'u_sharpness')
  const falloffLocation = gl.getUniformLocation(program, 'u_falloff')
  const centerLocation = gl.getUniformLocation(program, 'u_center')

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

  const render = (sourceCanvas, options = {}) => {
    if (!sourceCanvas) return false
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const velocityX = Number(options.velocityX) || 0
    const velocityY = Number(options.velocityY) || 0
    const samples = clamp(Math.round(Number(options.samples) || 8), 2, 48)
    // Sharpness mixes the unblurred frame back over the smear. 0 is the
    // physically correct default; callers pass the clip's setting through.
    const sharpness = clamp(Number(options.sharpness ?? 0), 0, 1)
    const falloff = clamp(Number(options.falloff ?? 0.85), 0.1, 4)
    const center = options.centered ? 0.5 : 0

    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas)

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
    gl.enableVertexAttribArray(texCoordLocation)
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0)

    gl.uniform1i(imageLocation, 0)
    gl.uniform2f(texelSizeLocation, 1 / width, 1 / height)
    // Canvas coordinates are Y-down, while the shader samples in flipped texture
    // coordinates. Keep X as-is, but invert Y so the smear trails behind motion.
    gl.uniform2f(velocityLocation, velocityX, -velocityY)
    gl.uniform1f(samplesLocation, samples)
    gl.uniform1f(sharpnessLocation, sharpness)
    gl.uniform1f(falloffLocation, falloff)
    gl.uniform1f(centerLocation, center)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  const dispose = () => {
    gl.deleteTexture(texture)
    gl.deleteBuffer(positionBuffer)
    gl.deleteBuffer(texCoordBuffer)
    gl.deleteProgram(program)
  }

  return { canvas, render, dispose }
}

function getRenderer(width, height) {
  const key = `${width}x${height}`
  const existing = rendererCache.get(key)
  if (existing) return existing
  const renderer = createVelocityMotionBlurRenderer(width, height)
  rendererCache.set(key, renderer)
  return renderer
}

export function canUseVelocityMotionBlur() {
  if (webGlSupport != null) return webGlSupport
  try {
    const canvas = createCanvas(1, 1)
    const gl = canvas?.getContext?.('webgl') || canvas?.getContext?.('experimental-webgl')
    webGlSupport = !!gl
  } catch {
    webGlSupport = false
  }
  return webGlSupport
}

export function applyVelocityMotionBlurToCanvas(canvas, ctx, width, height, options = {}) {
  if (!canvas || !ctx || !canUseVelocityMotionBlur()) return false
  try {
    const renderWidth = Math.max(1, Math.round(Number(width) || canvas.width || 1))
    const renderHeight = Math.max(1, Math.round(Number(height) || canvas.height || 1))
    const renderer = getRenderer(renderWidth, renderHeight)
    if (!renderer.render(canvas, options)) return false

    ctx.save()
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'copy'
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(renderer.canvas, 0, 0, renderWidth, renderHeight, 0, 0, width, height)
    ctx.restore()
    return true
  } catch (err) {
    console.warn('Velocity motion blur render failed; leaving canvas unchanged.', err)
    return false
  }
}
