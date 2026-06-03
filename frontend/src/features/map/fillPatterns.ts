import { Fill } from 'ol/style'

// ── QGIS-like polygon fill patterns ──────────────────────────────────────────
// Patterns are rendered onto a small tileable canvas and used as an OL Fill via
// CanvasPattern. Lines/dots are drawn in the fill colour over a transparent
// background, matching QGIS "line pattern" / "point pattern" fills.

export type FillPattern =
  | 'solid'
  | 'none'
  | 'horizontal'
  | 'vertical'
  | 'cross'
  | 'fdiagonal'
  | 'bdiagonal'
  | 'diagonal_cross'
  | 'dots'

export const FILL_PATTERN_OPTIONS: { value: FillPattern; label: string }[] = [
  { value: 'solid',          label: 'Solid' },
  { value: 'none',           label: 'No Fill' },
  { value: 'horizontal',     label: 'Horizontal lines' },
  { value: 'vertical',       label: 'Vertical lines' },
  { value: 'cross',          label: 'Cross (grid)' },
  { value: 'fdiagonal',      label: 'Diagonal /' },
  { value: 'bdiagonal',      label: 'Diagonal \\' },
  { value: 'diagonal_cross', label: 'Diagonal cross' },
  { value: 'dots',           label: 'Dots' },
]

function hexToRgba(hex: string, opacity: number): string {
  const h = (hex || '').replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : (h || 'ff6600')
  const n = parseInt(full.slice(0, 6) || 'ff6600', 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const a = Math.max(0, Math.min(1, isNaN(opacity) ? 0.5 : opacity))
  return `rgba(${r},${g},${b},${a})`
}

/**
 * Build an OpenLayers Fill for a polygon according to a QGIS-style pattern.
 * Returns `undefined` for the "none" pattern (no fill drawn).
 *
 * @param pattern  one of FillPattern
 * @param color    hex colour (e.g. "#ff6600")
 * @param opacity  0..1 alpha applied to the pattern/solid colour
 * @param spacing  px between repeated lines/dots (default 8)
 * @param lineWidth px stroke width for line patterns (default 1)
 */
export function makePatternFill(
  pattern: FillPattern,
  color: string,
  opacity: number,
  spacing = 8,
  lineWidth = 1,
): Fill | undefined {
  if (pattern === 'none') return undefined
  const paint = hexToRgba(color, opacity)
  if (pattern === 'solid' || !pattern) return new Fill({ color: paint })

  const size = Math.max(4, spacing)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return new Fill({ color: paint })

  ctx.strokeStyle = paint
  ctx.fillStyle = paint
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'square'
  ctx.beginPath()

  const mid = size / 2
  switch (pattern) {
    case 'horizontal':
      ctx.moveTo(0, mid); ctx.lineTo(size, mid)
      break
    case 'vertical':
      ctx.moveTo(mid, 0); ctx.lineTo(mid, size)
      break
    case 'cross':
      ctx.moveTo(0, mid); ctx.lineTo(size, mid)
      ctx.moveTo(mid, 0); ctx.lineTo(mid, size)
      break
    case 'fdiagonal':
      // forward "/" — three segments so the tile repeats seamlessly
      ctx.moveTo(0, size); ctx.lineTo(size, 0)
      ctx.moveTo(-1, 1);   ctx.lineTo(1, -1)
      ctx.moveTo(size - 1, size + 1); ctx.lineTo(size + 1, size - 1)
      break
    case 'bdiagonal':
      // back "\" — three segments for seamless tiling
      ctx.moveTo(0, 0); ctx.lineTo(size, size)
      ctx.moveTo(size - 1, -1); ctx.lineTo(size + 1, 1)
      ctx.moveTo(-1, size - 1);  ctx.lineTo(1, size + 1)
      break
    case 'diagonal_cross':
      ctx.moveTo(0, size); ctx.lineTo(size, 0)
      ctx.moveTo(-1, 1);   ctx.lineTo(1, -1)
      ctx.moveTo(size - 1, size + 1); ctx.lineTo(size + 1, size - 1)
      ctx.moveTo(0, 0); ctx.lineTo(size, size)
      ctx.moveTo(size - 1, -1); ctx.lineTo(size + 1, 1)
      ctx.moveTo(-1, size - 1);  ctx.lineTo(1, size + 1)
      break
    case 'dots':
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(mid, mid, Math.max(1, lineWidth), 0, 2 * Math.PI)
      ctx.fill()
      return new Fill({ color: ctx.createPattern(canvas, 'repeat') || paint })
  }
  ctx.stroke()
  return new Fill({ color: ctx.createPattern(canvas, 'repeat') || paint })
}
