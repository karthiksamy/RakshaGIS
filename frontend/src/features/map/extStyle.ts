import type { FillPattern } from './fillPatterns'

// Default external-layer colour (orange) — kept for backward compatibility with
// layers that never had an explicit style configured.
export const EXT_DEFAULT_FILL = '#ff6600'

// Full QGIS-like style schema persisted in ExternalLayer.style. Every field is
// optional in storage — legacy layers held only { color, opacity } and still
// resolve correctly through resolveExtStyle().
export interface ExtStyleResolved {
  fillColor: string
  fillOpacity: number       // 0..1
  fillPattern: FillPattern
  strokeColor: string
  strokeWidth: number
  strokeOpacity: number     // 0..1
  strokeStyle: string       // solid | dash | dot | dashdot | longdash
  strokeCap: CanvasLineCap
  strokeJoin: CanvasLineJoin
  pointShape: string        // circle | square | triangle | diamond | star | cross | x
  pointSize: number
}

export const EXT_STYLE_DEFAULTS: ExtStyleResolved = {
  fillColor: EXT_DEFAULT_FILL, fillOpacity: 0.25, fillPattern: 'solid',
  strokeColor: EXT_DEFAULT_FILL, strokeWidth: 1.8, strokeOpacity: 1,
  strokeStyle: 'solid', strokeCap: 'round', strokeJoin: 'round',
  pointShape: 'circle', pointSize: 5,
}

/** Normalise a raw style JSON (incl. legacy {color, opacity}) into the full schema. */
export function resolveExtStyle(raw?: Record<string, unknown>): ExtStyleResolved {
  const s = raw || {}
  const num = (v: unknown, d: number) => (typeof v === 'number' && !isNaN(v) ? v : d)
  const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d)
  // Legacy layers stored a single `color` (used for both fill + stroke) and `opacity` (fill alpha).
  const legacy = str(s.color, EXT_DEFAULT_FILL)
  return {
    fillColor:     str(s.fillColor, legacy),
    fillOpacity:   num(s.fillOpacity, num(s.opacity, EXT_STYLE_DEFAULTS.fillOpacity)),
    fillPattern:   str(s.fillPattern, EXT_STYLE_DEFAULTS.fillPattern) as FillPattern,
    strokeColor:   str(s.strokeColor, legacy),
    strokeWidth:   num(s.strokeWidth, EXT_STYLE_DEFAULTS.strokeWidth),
    strokeOpacity: num(s.strokeOpacity, EXT_STYLE_DEFAULTS.strokeOpacity),
    strokeStyle:   str(s.strokeStyle, EXT_STYLE_DEFAULTS.strokeStyle),
    strokeCap:     str(s.strokeCap, EXT_STYLE_DEFAULTS.strokeCap) as CanvasLineCap,
    strokeJoin:    str(s.strokeJoin, EXT_STYLE_DEFAULTS.strokeJoin) as CanvasLineJoin,
    pointShape:    str(s.pointShape, EXT_STYLE_DEFAULTS.pointShape),
    pointSize:     num(s.pointSize, EXT_STYLE_DEFAULTS.pointSize),
  }
}

export const STROKE_STYLE_OPTIONS = [
  { value: 'solid',    label: 'Solid' },
  { value: 'dash',     label: 'Dashed' },
  { value: 'dot',      label: 'Dotted' },
  { value: 'dashdot',  label: 'Dash-dot' },
  { value: 'longdash', label: 'Long dash' },
]

export const POINT_SHAPE_OPTIONS = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'x'] as const
