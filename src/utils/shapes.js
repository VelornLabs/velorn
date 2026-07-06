export const SHAPE_TYPES = Object.freeze([
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'roundedRectangle', label: 'Rounded Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'polygon', label: 'Polygon' },
  { value: 'line', label: 'Line' },
])

export const DEFAULT_LINE_THICKNESS = 8
export const DEFAULT_POLYGON_SIDES = 6

export const SHAPE_FILL_TYPES = Object.freeze([
  { value: 'solid', label: 'Solid' },
  { value: 'linearGradient', label: 'Linear Gradient' },
  { value: 'radialGradient', label: 'Radial Gradient' },
])

export const DEFAULT_SHAPE_PROPERTIES = Object.freeze({
  shapeType: 'rectangle',
  width: 640,
  height: 640,
  sizeLinked: true,
  fillType: 'solid',
  fillColor: '#38bdf8',
  fillColorB: '#a855f7',
  fillOpacity: 100,
  gradientAngle: 0,
  gradientCenterX: 50,
  gradientCenterY: 50,
  gradientRadius: 100,
  strokeColor: '#ffffff',
  strokeOpacity: 100,
  strokeWidth: 0,
  cornerRadius: 24,
  sides: DEFAULT_POLYGON_SIDES,
})

const SHAPE_TYPE_SET = new Set(SHAPE_TYPES.map((shape) => shape.value))
const SHAPE_FILL_TYPE_SET = new Set(SHAPE_FILL_TYPES.map((fill) => fill.value))
const SHAPE_TYPE_ALIASES = Object.freeze({
  roundrect: 'roundedRectangle',
  roundedrect: 'roundedRectangle',
  rounded_rectangle: 'roundedRectangle',
  circle: 'ellipse',
  oval: 'ellipse',
  triangle: 'polygon',
  pentagon: 'polygon',
  hexagon: 'polygon',
  heptagon: 'polygon',
  octagon: 'polygon',
})

const SHAPE_FILL_TYPE_ALIASES = Object.freeze({
  color: 'solid',
  solidcolor: 'solid',
  gradient: 'linearGradient',
  linear: 'linearGradient',
  lineargradient: 'linearGradient',
  linear_gradient: 'linearGradient',
  'linear-gradient': 'linearGradient',
  radial: 'radialGradient',
  radialgradient: 'radialGradient',
  radial_gradient: 'radialGradient',
  'radial-gradient': 'radialGradient',
})

const SHAPE_TYPE_SIDE_ALIASES = Object.freeze({
  triangle: 3,
  pentagon: 5,
  hexagon: 6,
  heptagon: 7,
  octagon: 8,
})

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

const normalizeColor = (value, fallback) => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback
}

export const normalizeShapeType = (value) => {
  if (SHAPE_TYPE_SET.has(value)) return value
  const normalized = String(value || '').trim().toLowerCase()
  return SHAPE_TYPE_ALIASES[normalized] || DEFAULT_SHAPE_PROPERTIES.shapeType
}

export const normalizeShapeFillType = (value) => {
  if (SHAPE_FILL_TYPE_SET.has(value)) return value
  const normalized = String(value || '').trim().toLowerCase()
  return SHAPE_FILL_TYPE_ALIASES[normalized] || DEFAULT_SHAPE_PROPERTIES.fillType
}

export const getShapeDisplayName = (shapeProperties = {}) => {
  const shapeType = normalizeShapeType(shapeProperties.shapeType)
  const fillType = normalizeShapeFillType(shapeProperties.fillType || shapeProperties.gradientType)
  const gradientPrefix = fillType === 'linearGradient'
    ? 'Linear Gradient '
    : fillType === 'radialGradient'
      ? 'Radial Gradient '
      : ''
  if (shapeType === 'polygon') {
    const sides = Math.round(clampNumber(shapeProperties.sides ?? shapeProperties.polygonSides, 3, 64, DEFAULT_POLYGON_SIDES))
    if (sides === 3) return `${gradientPrefix}Triangle`
    if (sides === 5) return `${gradientPrefix}Pentagon`
    if (sides === 6) return `${gradientPrefix}Hexagon`
    if (sides === 7) return `${gradientPrefix}Heptagon`
    if (sides === 8) return `${gradientPrefix}Octagon`
    return `${gradientPrefix}${sides}-Sided Polygon`
  }
  const label = SHAPE_TYPES.find((shape) => shape.value === shapeType)?.label || 'Shape'
  return `${gradientPrefix}${label}`
}

export const normalizeShapeProperties = (shapeProperties = {}) => {
  const input = shapeProperties && typeof shapeProperties === 'object' ? shapeProperties : {}
  const rawShapeType = String(input.shapeType || '').trim().toLowerCase()
  const shapeType = normalizeShapeType(input.shapeType)
  const sizeLinked = shapeType === 'line'
    ? input.sizeLinked === true
    : input.sizeLinked !== false
  const hasWidth = Object.prototype.hasOwnProperty.call(input, 'width')
  const hasHeight = Object.prototype.hasOwnProperty.call(input, 'height')
  let width = clampNumber(input.width, 1, 20000, DEFAULT_SHAPE_PROPERTIES.width)
  let height = clampNumber(
    input.height,
    1,
    20000,
    shapeType === 'line' ? DEFAULT_LINE_THICKNESS : DEFAULT_SHAPE_PROPERTIES.height
  )
  if (shapeType !== 'line' && sizeLinked && hasWidth && !hasHeight) {
    height = width
  } else if (shapeType !== 'line' && sizeLinked && hasHeight && !hasWidth) {
    width = height
  }

  return {
    shapeType,
    width,
    height,
    sizeLinked,
    fillType: normalizeShapeFillType(input.fillType || input.gradientType),
    fillColor: normalizeColor(input.fillColor, DEFAULT_SHAPE_PROPERTIES.fillColor),
    fillColorB: normalizeColor(
      input.fillColorB || input.gradientColor || input.gradientColorB || input.colorB,
      DEFAULT_SHAPE_PROPERTIES.fillColorB
    ),
    fillOpacity: clampNumber(input.fillOpacity, 0, 100, DEFAULT_SHAPE_PROPERTIES.fillOpacity),
    gradientAngle: clampNumber(input.gradientAngle, -3600, 3600, DEFAULT_SHAPE_PROPERTIES.gradientAngle),
    gradientCenterX: clampNumber(input.gradientCenterX, -100, 200, DEFAULT_SHAPE_PROPERTIES.gradientCenterX),
    gradientCenterY: clampNumber(input.gradientCenterY, -100, 200, DEFAULT_SHAPE_PROPERTIES.gradientCenterY),
    gradientRadius: clampNumber(input.gradientRadius, 1, 400, DEFAULT_SHAPE_PROPERTIES.gradientRadius),
    strokeColor: normalizeColor(input.strokeColor, DEFAULT_SHAPE_PROPERTIES.strokeColor),
    strokeOpacity: clampNumber(input.strokeOpacity, 0, 100, DEFAULT_SHAPE_PROPERTIES.strokeOpacity),
    strokeWidth: clampNumber(input.strokeWidth, 0, 2000, DEFAULT_SHAPE_PROPERTIES.strokeWidth),
    cornerRadius: clampNumber(input.cornerRadius, 0, 10000, DEFAULT_SHAPE_PROPERTIES.cornerRadius),
    sides: Math.round(clampNumber(
      input.sides ?? input.polygonSides,
      3,
      64,
      SHAPE_TYPE_SIDE_ALIASES[rawShapeType] || DEFAULT_SHAPE_PROPERTIES.sides
    )),
  }
}

export const getShapeCanvasRect = (shapeProperties = {}, canvasWidth = 1920, canvasHeight = 1080) => {
  const props = normalizeShapeProperties(shapeProperties)
  const width = Math.max(1, Number(props.width) || DEFAULT_SHAPE_PROPERTIES.width)
  const height = Math.max(1, Number(props.height) || DEFAULT_SHAPE_PROPERTIES.height)
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  }
}

const roundedRectPath = (ctx, x, y, width, height, radius) => {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2))
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, safeRadius)
    return
  }
  ctx.moveTo(x + safeRadius, y)
  ctx.lineTo(x + width - safeRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  ctx.lineTo(x + width, y + height - safeRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  ctx.lineTo(x + safeRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  ctx.lineTo(x, y + safeRadius)
  ctx.quadraticCurveTo(x, y, x + safeRadius, y)
}

export const getShapePolygonPoints = (width, height, sides = DEFAULT_POLYGON_SIDES) => {
  const safeSides = Math.round(clampNumber(sides, 3, 64, DEFAULT_POLYGON_SIDES))
  const cx = width / 2
  const cy = height / 2
  const rx = width / 2
  const ry = height / 2

  return Array.from({ length: safeSides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / safeSides
    return {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    }
  })
}

const polygonPath = (ctx, x, y, width, height, sides) => {
  const points = getShapePolygonPoints(width, height, sides)
  points.forEach((point, index) => {
    const px = x + point.x
    const py = y + point.y
    if (index === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  })
  ctx.closePath()
}

const getShapeFillStyle = (ctx, x, y, width, height, props) => {
  if (props.fillType === 'linearGradient') {
    const angle = (Number(props.gradientAngle) || 0) * Math.PI / 180
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    const cx = x + width / 2
    const cy = y + height / 2
    const halfLength = (Math.abs(width * dx) + Math.abs(height * dy)) / 2
    const gradient = ctx.createLinearGradient(
      cx - dx * halfLength,
      cy - dy * halfLength,
      cx + dx * halfLength,
      cy + dy * halfLength
    )
    gradient.addColorStop(0, props.fillColor)
    gradient.addColorStop(1, props.fillColorB)
    return gradient
  }

  if (props.fillType === 'radialGradient') {
    const cx = x + width * ((Number(props.gradientCenterX) || 50) / 100)
    const cy = y + height * ((Number(props.gradientCenterY) || 50) / 100)
    const radius = Math.max(width, height) * ((Number(props.gradientRadius) || 100) / 100) / 2
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, radius))
    gradient.addColorStop(0, props.fillColor)
    gradient.addColorStop(1, props.fillColorB)
    return gradient
  }

  return props.fillColor
}

export const drawShape = (ctx, rect, clip) => {
  const inheritedAlpha = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1
  const props = normalizeShapeProperties(clip?.shapeProperties || {})
  const width = Math.max(1, Number(rect?.width) || props.width)
  const height = Math.max(1, Number(rect?.height) || props.height)
  const x = Number(rect?.x) || 0
  const y = Number(rect?.y) || 0
  const strokeWidth = props.shapeType === 'line'
    ? Math.max(1, height)
    : Math.max(0, Number(props.strokeWidth) || 0)

  ctx.save()
  ctx.beginPath()

  if (props.shapeType === 'ellipse') {
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  } else if (props.shapeType === 'polygon') {
    polygonPath(ctx, x, y, width, height, props.sides)
  } else if (props.shapeType === 'line') {
    ctx.moveTo(x, y + height / 2)
    ctx.lineTo(x + width, y + height / 2)
  } else if (props.shapeType === 'roundedRectangle') {
    roundedRectPath(ctx, x, y, width, height, props.cornerRadius)
  } else {
    ctx.rect(x, y, width, height)
  }

  if (props.shapeType === 'line' || strokeWidth > 0) {
    ctx.globalAlpha = inheritedAlpha * (props.shapeType === 'line' ? props.fillOpacity / 100 : props.strokeOpacity / 100)
    ctx.strokeStyle = props.shapeType === 'line'
      ? getShapeFillStyle(ctx, x, y, width, height, props)
      : props.strokeColor
    ctx.lineWidth = strokeWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke()
  }

  if (props.shapeType !== 'line' && props.fillOpacity > 0) {
    ctx.globalAlpha = inheritedAlpha * (props.fillOpacity / 100)
    ctx.fillStyle = getShapeFillStyle(ctx, x, y, width, height, props)
    ctx.fill()
  }

  ctx.restore()
}

export const getShapeSvgProps = (shapeProperties = {}) => {
  const props = normalizeShapeProperties(shapeProperties)
  const fillOpacity = props.shapeType === 'line' ? 0 : props.fillOpacity / 100
  const strokeWidth = props.shapeType === 'line'
    ? Math.max(1, props.height)
    : props.strokeWidth
  const strokeColor = props.shapeType === 'line'
    ? props.fillColor
    : props.strokeColor
  return {
    ...props,
    fillOpacity,
    strokeWidth,
    strokeColor,
    strokeOpacity: props.shapeType === 'line' ? props.fillOpacity / 100 : props.strokeOpacity / 100,
  }
}
