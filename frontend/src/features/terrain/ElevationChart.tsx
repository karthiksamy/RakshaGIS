interface Point { dist: number; elev: number }

interface Props {
  data: Point[]
  width?: number
  height?: number
}

export default function ElevationChart({ data, width = 320, height = 130 }: Props) {
  if (!data.length) return null

  const pad = { t: 12, r: 12, b: 28, l: 44 }
  const w = width - pad.l - pad.r
  const h = height - pad.t - pad.b

  const elevs = data.map(d => d.elev)
  const minE = Math.min(...elevs)
  const maxE = Math.max(...elevs)
  const rangeE = maxE - minE || 1
  const maxD = data[data.length - 1]?.dist ?? 1

  const sx = (d: number) => pad.l + (d / maxD) * w
  const sy = (e: number) => pad.t + h - ((e - minE) / rangeE) * h

  const linePath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${sx(d.dist).toFixed(1)},${sy(d.elev).toFixed(1)}`)
    .join(' ')

  const fillPath =
    linePath +
    ` L${sx(maxD).toFixed(1)},${(pad.t + h).toFixed(1)}` +
    ` L${sx(0).toFixed(1)},${(pad.t + h).toFixed(1)} Z`

  const yTicks = 4
  const xTicks = 4

  return (
    <svg
      width={width}
      height={height}
      style={{ fontFamily: 'monospace', fontSize: 10, display: 'block' }}
    >
      {/* Grid lines */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const e = minE + (rangeE * i) / yTicks
        const y = sy(e)
        return (
          <g key={i}>
            <line x1={pad.l} y1={y} x2={pad.l + w} y2={y} stroke="#2a2a3e" strokeWidth={1} />
            <text x={pad.l - 4} y={y + 3} textAnchor="end" fill="#666" fontSize={9}>
              {e.toFixed(0)}
            </text>
          </g>
        )
      })}

      {/* X axis ticks */}
      {Array.from({ length: xTicks + 1 }, (_, i) => {
        const d = (maxD * i) / xTicks
        const x = sx(d)
        return (
          <g key={i}>
            <line x1={x} y1={pad.t + h} x2={x} y2={pad.t + h + 4} stroke="#444" />
            <text x={x} y={pad.t + h + 13} textAnchor="middle" fill="#666" fontSize={9}>
              {(d / 1000).toFixed(1)}km
            </text>
          </g>
        )
      })}

      {/* Axes */}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + h} stroke="#444" />
      <line x1={pad.l} y1={pad.t + h} x2={pad.l + w} y2={pad.t + h} stroke="#444" />

      {/* Y label */}
      <text
        x={10}
        y={pad.t + h / 2}
        textAnchor="middle"
        fill="#666"
        fontSize={9}
        transform={`rotate(-90, 10, ${pad.t + h / 2})`}
      >
        Elev (m)
      </text>

      {/* Fill */}
      <path d={fillPath} fill="rgba(79,195,247,0.15)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="#4fc3f7" strokeWidth={2} strokeLinejoin="round" />

      {/* Min/max labels */}
      <text x={pad.l + 2} y={pad.t + 9} fill="#52c41a" fontSize={9}>
        max {maxE.toFixed(0)}m
      </text>
      <text x={pad.l + 2} y={pad.t + h - 2} fill="#faad14" fontSize={9}>
        min {minE.toFixed(0)}m
      </text>
    </svg>
  )
}
