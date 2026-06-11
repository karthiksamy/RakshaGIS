import { useState, useCallback } from 'react'
import {
  Button, InputNumber, Select, Spin, Tag, Tooltip,
  Typography, Divider, Row, Col, Alert, DatePicker, TimePicker,
} from 'antd'
import {
  AreaChartOutlined, CompassOutlined, LineChartOutlined,
  NodeIndexOutlined, SwapOutlined, EyeOutlined,
  RadarChartOutlined, ColumnWidthOutlined,
  AlertOutlined, WarningOutlined, GlobalOutlined,
  DownloadOutlined, CloseOutlined, PlayCircleOutlined,
  DropboxOutlined, SunOutlined, CarOutlined,
  DiffOutlined, RocketOutlined, WifiOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '@/services/api'

const { Text } = Typography

// ── types ──────────────────────────────────────────────────────────────────

export interface SlopeGridData {
  elevGrid: number[]
  bbox: [number, number, number, number]
  gridN: number
}

export interface DEMLayer {
  id: string
  type: 'image' | 'geojson'
  label: string
  imageData?: string
  geojson?: object
  bbox: [number, number, number, number]
}

interface Props {
  gridData: SlopeGridData | null
  referenceGrid: SlopeGridData | null
  onOverlay: (layer: DEMLayer) => void
  onClearOverlays: () => void
  /** Capture the 3D globe with title bar, legend and statistics panels burnt in. */
  onScenePNG?: (
    toolLabel: string,
    legendItems: { label: string; color?: string }[],
    statLines: string[],
  ) => Promise<void> | void
}

// ── per-tool legends for the exported scene PNG ─────────────────────────────

const TOOL_LEGENDS: Record<string, { label: string; color?: string }[]> = {
  contours:       [{ label: 'Contour line',     color: '#d97706' },
                   { label: 'Index contour',    color: '#92400e' }],
  aspect_map:     [{ label: 'N',  color: '#5b9bd5' }, { label: 'NE', color: '#56ccf2' },
                   { label: 'E',  color: '#e74c3c' }, { label: 'SE', color: '#e67e22' },
                   { label: 'S',  color: '#f1c40f' }, { label: 'SW', color: '#2ecc71' },
                   { label: 'W',  color: '#1abc9c' }, { label: 'NW', color: '#9b59b6' }],
  curvature:      [{ label: 'Convex (ridge)',   color: '#ef4444' },
                   { label: 'Flat',             color: '#e5e7eb' },
                   { label: 'Concave (valley)', color: '#3b82f6' }],
  viewshed:       [{ label: 'Visible',          color: '#22c55e' },
                   { label: 'Hidden',           color: '#ef4444' },
                   { label: 'Observer',         color: '#facc15' }],
  volume:         [{ label: 'Cut (above plane)', color: '#fa8c16' },
                   { label: 'Fill (below plane)', color: '#2f54eb' }],
  cut_fill:       [{ label: 'Cut',              color: '#fa8c16' },
                   { label: 'Fill',             color: '#2f54eb' }],
  flood:          [{ label: 'Shallow water',    color: '#60a5fa' },
                   { label: 'Deep water',       color: '#1e3a8a' }],
  landslide:      [{ label: 'Low risk',         color: '#22c55e' },
                   { label: 'Moderate',         color: '#eab308' },
                   { label: 'High',             color: '#f97316' },
                   { label: 'Very high',        color: '#ef4444' }],
  watershed:      [{ label: 'Drainage basin',   color: '#08979c' },
                   { label: 'Outlet point',     color: '#facc15' }],
  cross_section:  [{ label: 'N–S profile',      color: '#4fc3f7' },
                   { label: 'E–W profile',      color: '#fa8c16' }],
  twi:            [{ label: 'Dry',              color: '#d97706' },
                   { label: 'Moist',            color: '#22c55e' },
                   { label: 'Wet / waterlogged', color: '#1d4ed8' }],
  solar_shadow:   [{ label: 'Sunlit',           color: '#fde047' },
                   { label: 'Shadow',           color: '#312e81' }],
  trafficability: [{ label: 'Easy going',       color: '#22c55e' },
                   { label: 'Moderate',         color: '#eab308' },
                   { label: 'Difficult',        color: '#f97316' },
                   { label: 'Impassable',       color: '#ef4444' }],
  change_detection: [{ label: 'Material gained', color: '#ef4444' },
                   { label: 'No change',        color: '#e5e7eb' },
                   { label: 'Material lost',    color: '#3b82f6' }],
  lz_assessment:  [{ label: 'Excellent LZ',     color: '#22c55e' },
                   { label: 'Marginal',         color: '#eab308' },
                   { label: 'Unsuitable',       color: '#ef4444' }],
  rf_coverage:    [{ label: 'Clear LoS',        color: '#22c55e' },
                   { label: 'Partial Fresnel',  color: '#eab308' },
                   { label: 'Blocked',          color: '#ef4444' },
                   { label: 'Tower',            color: '#facc15' }],
}

/** Flatten result.stats into monospace "Label  value unit" lines for the PNG. */
function buildStatLines(result: any): string[] {
  const s = result?.stats
  if (!s || typeof s !== 'object') return []
  const UNITS: [string, string][] = [
    ['_pct', ' %'], ['_m3', ' m³'], ['_m2', ' m²'], ['_km2', ' km²'],
    ['_deg', '°'], ['_mhz', ' MHz'], ['_m', ' m'],
  ]
  const lines: string[] = []
  for (const [k, v] of Object.entries(s)) {
    if (v == null || typeof v === 'object') continue
    let key = k, unit = ''
    for (const [suf, u] of UNITS) {
      if (key.endsWith(suf)) { key = key.slice(0, -suf.length); unit = u; break }
    }
    const label = key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
    const val = typeof v === 'number'
      ? (Number.isInteger(v) ? String(v) : (v as number).toFixed(2))
      : String(v)
    lines.push(`${label.padEnd(16)} ${val}${unit}`)
    if (lines.length >= 12) break
  }
  return lines
}

// ── tool catalogue ──────────────────────────────────────────────────────────

const TOOLS = [
  { id: 'contours',      label: 'Contours',     icon: <LineChartOutlined />,   color: '#1890ff',
    desc: 'Generate elevation contour lines from the DEM.' },
  { id: 'aspect_map',    label: 'Aspect',        icon: <CompassOutlined />,     color: '#52c41a',
    desc: 'Direction the slope faces (N/NE/E…). Colour wheel overlay.' },
  { id: 'curvature',     label: 'Curvature',     icon: <RadarChartOutlined />,  color: '#fa541c',
    desc: 'Profile, plan or total Laplacian curvature. Red=convex, Blue=concave.' },
  { id: 'viewshed',      label: 'Viewshed',      icon: <EyeOutlined />,         color: '#eb2f96',
    desc: 'Line-of-sight visibility from an observer point. Green=visible, Red=hidden.' },
  { id: 'volume',        label: 'Volume',        icon: <AreaChartOutlined />,   color: '#722ed1',
    desc: 'Volume above/below a reference plane. Orange=cut, Blue=fill.' },
  { id: 'cut_fill',      label: 'Cut & Fill',    icon: <SwapOutlined />,        color: '#2f54eb',
    desc: 'Earthwork cut-and-fill relative to a design elevation.' },
  { id: 'flood',         label: 'Flood',         icon: <AlertOutlined />,       color: '#0050b3',
    desc: 'Inundation simulation at a given water level. Shows depth gradient.' },
  { id: 'landslide',     label: 'Landslide Risk',icon: <WarningOutlined />,     color: '#cf1322',
    desc: 'Risk index combining slope, curvature and elevation. Red=very high.' },
  { id: 'watershed',     label: 'Watershed',     icon: <NodeIndexOutlined />,   color: '#08979c',
    desc: 'Delineate drainage basin using D8 flow direction algorithm.' },
  { id: 'cross_section',  label: 'Cross Sections', icon: <ColumnWidthOutlined />, color: '#d46b08',
    desc: 'N–S and E–W elevation cross-sections through the study area.' },
  { id: 'twi',            label: 'TWI',            icon: <DropboxOutlined />,    color: '#0891b2',
    desc: 'Topographic Wetness Index — ln(flow_acc × cell_area / tan(slope)). Identifies waterlogging-prone zones.' },
  { id: 'solar_shadow',   label: 'Solar Shadow',   icon: <SunOutlined />,        color: '#d97706',
    desc: 'Hillshade + shadow mask for a given date/time. Useful for LZ assessment and solar panel siting.' },
  { id: 'trafficability',    label: 'Trafficability',    icon: <CarOutlined />,     color: '#16a34a',
    desc: 'Off-road vehicle passability map combining slope and terrain roughness. Green=easy, Red=impassable.' },
  { id: 'change_detection', label: 'Change Detect',    icon: <DiffOutlined />,    color: '#a855f7',
    desc: 'Compare two DEMs (before/after) → cut/fill difference map. Load reference DEM first.' },
  { id: 'lz_assessment',   label: 'LZ Assessment',    icon: <RocketOutlined />,  color: '#0ea5e9',
    desc: 'Helicopter landing zone scoring: slope < 7°, clear radius, approach corridor. Green=excellent.' },
  { id: 'rf_coverage',     label: 'RF Coverage',      icon: <WifiOutlined />,    color: '#f59e0b',
    desc: 'Radio line-of-sight coverage with first Fresnel zone analysis. Green=clear LoS, Red=blocked.' },
]

// ── stat row ────────────────────────────────────────────────────────────────

function StatRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  padding: '2px 0', borderBottom: '1px solid #1a1a2e' }}>
      <Text style={{ color: '#888', fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color ?? '#e0e0e0', fontSize: 11, fontWeight: 600 }}>{value}</Text>
    </div>
  )
}

// ── mini SVG cross-section chart ─────────────────────────────────────────────

function CrossSectionChart({ points, label }: { points: {dist:number;elev:number}[]; label: string }) {
  if (!points.length) return null
  const W = 260, H = 80, PAD_L = 34, PAD_B = 18, PAD_T = 6, PAD_R = 8
  const cw = W - PAD_L - PAD_R, ch = H - PAD_T - PAD_B
  const minE = Math.min(...points.map(p => p.elev))
  const maxE = Math.max(...points.map(p => p.elev))
  const maxD = points[points.length - 1]?.dist || 1
  const eSpan = maxE - minE || 1

  const toX = (d: number) => PAD_L + (d / maxD) * cw
  const toY = (e: number) => PAD_T + ch - ((e - minE) / eSpan) * ch

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.dist).toFixed(1)},${toY(p.elev).toFixed(1)}`).join(' ')
  const fillPath = `${path} L${toX(maxD)},${(PAD_T + ch).toFixed(1)} L${PAD_L},${(PAD_T + ch).toFixed(1)} Z`

  // Y ticks
  const nTicks = 3
  const yTicks = Array.from({ length: nTicks + 1 }, (_, i) => minE + (i / nTicks) * eSpan)

  return (
    <div style={{ marginBottom: 8 }}>
      <Text style={{ color: '#4fc3f7', fontSize: 10, display: 'block', marginBottom: 2 }}>{label}</Text>
      <svg width={W} height={H} style={{ background: '#0a0d20', borderRadius: 4, display: 'block' }}>
        {yTicks.map((ev, i) => {
          const y = toY(ev)
          return (
            <g key={i}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="#1a2040" strokeWidth={0.5} />
              <text x={PAD_L - 2} y={y + 3} fontSize={7} fill="#556" textAnchor="end">{ev.toFixed(0)}</text>
            </g>
          )
        })}
        <path d={fillPath} fill="rgba(79,195,247,0.12)" />
        <path d={path} fill="none" stroke="#4fc3f7" strokeWidth={1.5} />
        <text x={PAD_L + cw / 2} y={H - 2} fontSize={7} fill="#556" textAnchor="middle">
          {(maxD / 1000).toFixed(2)} km
        </text>
        <text x={W - PAD_R} y={toY(maxE) - 3} fontSize={7} fill="#ff8080">▲{maxE.toFixed(0)}m</text>
        <text x={PAD_L + 2}  y={toY(minE) + 10} fontSize={7} fill="#80ff80">▼{minE.toFixed(0)}m</text>
      </svg>
    </div>
  )
}

// ── aspect rose ──────────────────────────────────────────────────────────────

function AspectRose({ stats }: { stats: Record<string, number> }) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW']
  const colors: Record<string,string> = {
    N:'#5b9bd5',NE:'#56ccf2',E:'#e74c3c',SE:'#e67e22',S:'#f1c40f',SW:'#2ecc71',W:'#1abc9c',NW:'#9b59b6'
  }
  const max_pct = Math.max(...dirs.map(d => stats[d] || 0), 1)
  const cx = 50, cy = 50, maxR = 38
  const angles: Record<string,number> = {N:-90,NE:-45,E:0,SE:45,S:90,SW:135,W:180,NW:-135}
  const spokes = dirs.map(d => {
    const r = (stats[d] || 0) / max_pct * maxR
    const a = angles[d] * Math.PI / 180
    return { d, r, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg width={100} height={100} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={maxR} fill="none" stroke="#1a1a2e" strokeWidth={0.5} />
        <circle cx={cx} cy={cy} r={maxR/2} fill="none" stroke="#1a1a2e" strokeWidth={0.5} />
        {/* octants */}
        {spokes.map(({ d, r, x, y }) => {
          const a = angles[d] * Math.PI / 180
          const xA = cx + 3 * Math.cos(a), yA = cy + 3 * Math.sin(a)
          return (
            <line key={d} x1={xA} y1={yA} x2={x} y2={y}
                  stroke={colors[d]} strokeWidth={4} strokeLinecap="round" opacity={0.85} />
          )
        })}
        <text x={cx} y={cy-maxR-3} fontSize={8} fill="#888" textAnchor="middle">N</text>
        <text x={cx} y={cy+maxR+10} fontSize={8} fill="#888" textAnchor="middle">S</text>
        <text x={cx+maxR+4} y={cy+3} fontSize={8} fill="#888">E</text>
        <text x={cx-maxR-12} y={cy+3} fontSize={8} fill="#888">W</text>
      </svg>
      <div style={{ flex: 1, fontSize: 10 }}>
        {dirs.map(d => (
          <div key={d} style={{ display: 'flex', gap: 4, marginBottom: 1 }}>
            <span style={{ color: colors[d], width: 20 }}>{d}</span>
            <div style={{ flex: 1, background: '#1a1a2e', borderRadius: 2, height: 8, overflow: 'hidden', marginTop: 1 }}>
              <div style={{ width: `${stats[d] || 0}%`, height: '100%', background: colors[d] }} />
            </div>
            <span style={{ color: '#888', width: 32, textAlign: 'right' }}>{(stats[d] || 0).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── parameter forms ──────────────────────────────────────────────────────────

function ContourParams({ params, setParams }: any) {
  return (
    <Row gutter={8}>
      <Col span={12}>
        <Text style={{ color: '#888', fontSize: 10 }}>Interval (m)</Text>
        <InputNumber size="small" min={1} max={1000} value={params.interval}
          onChange={v => setParams((p: any) => ({ ...p, interval: v }))}
          style={{ width: '100%' }} placeholder="auto" />
      </Col>
      <Col span={12}>
        <Text style={{ color: '#888', fontSize: 10 }}>Index every N</Text>
        <InputNumber size="small" min={2} max={20} value={params.index_factor ?? 5}
          onChange={v => setParams((p: any) => ({ ...p, index_factor: v }))}
          style={{ width: '100%' }} />
      </Col>
    </Row>
  )
}

function CurvatureParams({ params, setParams }: any) {
  return (
    <div>
      <Text style={{ color: '#888', fontSize: 10 }}>Curvature type</Text>
      <Select size="small" style={{ width: '100%' }}
        value={params.curvature_type ?? 'total'}
        onChange={v => setParams((p: any) => ({ ...p, curvature_type: v }))}
        options={[
          { value: 'total',   label: 'Total (Laplacian)' },
          { value: 'profile', label: 'Profile (slope direction)' },
          { value: 'plan',    label: 'Plan (contour direction)' },
        ]} />
    </div>
  )
}

function ViewshedParams({ params, setParams }: any) {
  return (
    <Row gutter={8}>
      <Col span={8}>
        <Text style={{ color: '#888', fontSize: 10 }}>Obs height (m)</Text>
        <InputNumber size="small" min={0} max={500} step={0.5}
          value={params.observer_height ?? 2}
          onChange={v => setParams((p: any) => ({ ...p, observer_height: v }))}
          style={{ width: '100%' }} />
      </Col>
      <Col span={8}>
        <Text style={{ color: '#888', fontSize: 10 }}>Obs Lat</Text>
        <InputNumber size="small" step={0.001}
          value={params.observer_lat}
          onChange={v => setParams((p: any) => ({ ...p, observer_lat: v }))}
          style={{ width: '100%' }} placeholder="auto" />
      </Col>
      <Col span={8}>
        <Text style={{ color: '#888', fontSize: 10 }}>Obs Lon</Text>
        <InputNumber size="small" step={0.001}
          value={params.observer_lon}
          onChange={v => setParams((p: any) => ({ ...p, observer_lon: v }))}
          style={{ width: '100%' }} placeholder="auto" />
      </Col>
    </Row>
  )
}

function VolumeParams({ params, setParams }: any) {
  return (
    <div>
      <Text style={{ color: '#888', fontSize: 10 }}>Reference elevation (m) — blank = min</Text>
      <InputNumber size="small" step={1}
        value={params.reference_elevation}
        onChange={v => setParams((p: any) => ({ ...p, reference_elevation: v }))}
        style={{ width: '100%' }} placeholder="= min elevation" />
    </div>
  )
}

function FloodParams({ params, setParams }: any) {
  return (
    <Row gutter={8}>
      <Col span={12}>
        <Text style={{ color: '#888', fontSize: 10 }}>Water level (m)</Text>
        <InputNumber size="small" step={1}
          value={params.water_level}
          onChange={v => setParams((p: any) => ({ ...p, water_level: v }))}
          style={{ width: '100%' }} placeholder="auto (min+5)" />
      </Col>
      <Col span={6}>
        <Text style={{ color: '#888', fontSize: 10 }}>Seed lat</Text>
        <InputNumber size="small" step={0.001}
          value={params.seed_lat}
          onChange={v => setParams((p: any) => ({ ...p, seed_lat: v }))}
          style={{ width: '100%' }} placeholder="auto" />
      </Col>
      <Col span={6}>
        <Text style={{ color: '#888', fontSize: 10 }}>Seed lon</Text>
        <InputNumber size="small" step={0.001}
          value={params.seed_lon}
          onChange={v => setParams((p: any) => ({ ...p, seed_lon: v }))}
          style={{ width: '100%' }} placeholder="auto" />
      </Col>
    </Row>
  )
}

function WatershedParams({ params, setParams }: any) {
  return (
    <Row gutter={8}>
      <Col span={12}>
        <Text style={{ color: '#888', fontSize: 10 }}>Pour point lat (blank = auto)</Text>
        <InputNumber size="small" step={0.001}
          value={params.pour_lat}
          onChange={v => setParams((p: any) => ({ ...p, pour_lat: v }))}
          style={{ width: '100%' }} placeholder="highest accumulation" />
      </Col>
      <Col span={12}>
        <Text style={{ color: '#888', fontSize: 10 }}>Pour point lon</Text>
        <InputNumber size="small" step={0.001}
          value={params.pour_lon}
          onChange={v => setParams((p: any) => ({ ...p, pour_lon: v }))}
          style={{ width: '100%' }} placeholder="highest accumulation" />
      </Col>
    </Row>
  )
}

function LZParams({ params, setParams }: any) {
  return (
    <>
      <Row gutter={8}>
        <Col span={8}>
          <Text style={{ color: '#888', fontSize: 10 }}>Radius (m)</Text>
          <InputNumber size="small" min={10} max={200} step={5}
            value={params.radius_m ?? 30}
            onChange={v => setParams((p: any) => ({ ...p, radius_m: v }))}
            style={{ width: '100%' }} />
        </Col>
        <Col span={8}>
          <Text style={{ color: '#888', fontSize: 10 }}>Approach dir°</Text>
          <InputNumber size="small" min={0} max={359} step={5}
            value={params.approach_deg ?? 270}
            onChange={v => setParams((p: any) => ({ ...p, approach_deg: v }))}
            style={{ width: '100%' }} />
        </Col>
        <Col span={8}>
          <Text style={{ color: '#888', fontSize: 10 }}>Clear dist (m)</Text>
          <InputNumber size="small" min={50} max={1000} step={50}
            value={params.approach_m ?? 200}
            onChange={v => setParams((p: any) => ({ ...p, approach_m: v }))}
            style={{ width: '100%' }} />
        </Col>
      </Row>
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Approach dir = direction helicopter arrives from (0°=N, 90°=E, 270°=W)
      </div>
    </>
  )
}

function RFParams({ params, setParams }: any) {
  return (
    <>
      <Row gutter={8} style={{ marginBottom: 4 }}>
        <Col span={12}>
          <Text style={{ color: '#888', fontSize: 10 }}>Tower Lat</Text>
          <InputNumber size="small" step={0.001}
            value={params.tower_lat}
            onChange={v => setParams((p: any) => ({ ...p, tower_lat: v }))}
            style={{ width: '100%' }} placeholder="auto (centre)" />
        </Col>
        <Col span={12}>
          <Text style={{ color: '#888', fontSize: 10 }}>Tower Lon</Text>
          <InputNumber size="small" step={0.001}
            value={params.tower_lon}
            onChange={v => setParams((p: any) => ({ ...p, tower_lon: v }))}
            style={{ width: '100%' }} placeholder="auto (centre)" />
        </Col>
      </Row>
      <Row gutter={8}>
        <Col span={8}>
          <Text style={{ color: '#888', fontSize: 10 }}>Height (m)</Text>
          <InputNumber size="small" min={1} max={500}
            value={params.tower_height_m ?? 30}
            onChange={v => setParams((p: any) => ({ ...p, tower_height_m: v }))}
            style={{ width: '100%' }} />
        </Col>
        <Col span={8}>
          <Text style={{ color: '#888', fontSize: 10 }}>Freq (MHz)</Text>
          <InputNumber size="small" min={1} max={6000}
            value={params.freq_mhz ?? 150}
            onChange={v => setParams((p: any) => ({ ...p, freq_mhz: v }))}
            style={{ width: '100%' }} />
        </Col>
        <Col span={8}>
          <Text style={{ color: '#888', fontSize: 10 }}>Rx height (m)</Text>
          <InputNumber size="small" min={0.5} max={50} step={0.5}
            value={params.rx_height_m ?? 2}
            onChange={v => setParams((p: any) => ({ ...p, rx_height_m: v }))}
            style={{ width: '100%' }} />
        </Col>
      </Row>
    </>
  )
}

function SolarParams({ params, setParams }: any) {
  return (
    <Row gutter={8}>
      <Col span={14}>
        <Text style={{ color: '#888', fontSize: 10 }}>Date</Text>
        <DatePicker
          size="small" style={{ width: '100%' }}
          value={params.date ? dayjs(params.date) : dayjs('2024-06-21')}
          onChange={d => setParams((p: any) => ({ ...p, date: d ? d.format('YYYY-MM-DD') : '2024-06-21' }))}
          allowClear={false}
        />
      </Col>
      <Col span={10}>
        <Text style={{ color: '#888', fontSize: 10 }}>Time (UTC)</Text>
        <TimePicker
          size="small" style={{ width: '100%' }} format="HH:mm" minuteStep={15}
          value={params.time ? dayjs(`2024-01-01 ${params.time}`) : dayjs('2024-01-01 12:00')}
          onChange={t => setParams((p: any) => ({ ...p, time: t ? t.format('HH:mm') : '12:00' }))}
          allowClear={false}
        />
      </Col>
    </Row>
  )
}

// ── result stats renderer ────────────────────────────────────────────────────

function ResultStats({ result }: { result: any }) {
  if (!result?.stats) return null
  const s = result.stats

  if (result.type === 'contours') return (
    <>
      <StatRow label="Contour interval" value={`${s.interval_m} m`} />
      <StatRow label="Total contours" value={s.count} />
      <StatRow label="Index every" value={`${s.index_every}th line`} />
      <StatRow label="Elevation range" value={`${s.min_elev_m} – ${s.max_elev_m} m`} />
      <StatRow label="Relief" value={`${s.relief_m} m`} />
    </>
  )

  if (result.type === 'aspect_map') return (
    <>
      <div style={{ marginBottom: 8 }}>
        <AspectRose stats={s} />
      </div>
      <StatRow label="Dominant aspect" value={s.dominant} color="#4fc3f7" />
      <StatRow label="Flat areas" value={`${s.flat_pct}%`} />
    </>
  )

  if (result.type === 'curvature') return (
    <>
      <StatRow label="Type" value={s.type} color="#4fc3f7" />
      <StatRow label="Concave (convergent)" value={`${s.concave_pct}%`} color="#5b9bd5" />
      <StatRow label="Convex (divergent)" value={`${s.convex_pct}%`} color="#e74c3c" />
      <StatRow label="Mean curvature" value={s.mean.toFixed(4)} />
    </>
  )

  if (result.type === 'viewshed') return (
    <>
      <StatRow label="Observer elev" value={`${s.observer_elev_m} m`} />
      <StatRow label="Observer height" value={`${s.observer_height_m} m`} />
      <StatRow label="Visible area" value={`${s.visible_pct}%`} color="#52c41a" />
      <StatRow label="Hidden area" value={`${s.not_visible_pct}%`} color="#ff4d4f" />
      <StatRow label="Visible cells" value={s.visible_cells} />
    </>
  )

  if (result.type === 'volume' || result.type === 'cut_fill') return (
    <>
      <StatRow label="Reference elev" value={`${s.reference_elevation_m} m`} />
      <StatRow label="Cut volume" value={`${s.cut_volume_m3.toLocaleString()} m³`} color="#fa8c16" />
      <StatRow label="Fill volume" value={`${s.fill_volume_m3.toLocaleString()} m³`} color="#1890ff" />
      <StatRow label="Net" value={`${s.net_volume_m3 >= 0 ? '+' : ''}${s.net_volume_m3.toLocaleString()} m³`}
        color={s.net_volume_m3 >= 0 ? '#fa8c16' : '#1890ff'} />
      <StatRow label="Cut area" value={`${s.cut_area_ha} ha`} color="#fa8c16" />
      <StatRow label="Fill area" value={`${s.fill_area_ha} ha`} color="#1890ff" />
    </>
  )

  if (result.type === 'flood') return (
    <>
      <StatRow label="Water level" value={`${s.water_level_m} m`} color="#1890ff" />
      <StatRow label="Max depth" value={`${s.max_depth_m} m`} />
      <StatRow label="Avg depth" value={`${s.avg_depth_m} m`} />
      <StatRow label="Flooded area" value={`${s.flooded_area_ha} ha`} color="#1890ff" />
      <StatRow label="Flooded %"  value={`${s.flooded_pct}%`} />
    </>
  )

  if (result.type === 'landslide') return (
    <>
      <StatRow label="Low risk"       value={`${s.low_pct}%`}       color="#52c41a" />
      <StatRow label="Moderate risk"  value={`${s.moderate_pct}%`}  color="#faad14" />
      <StatRow label="High risk"      value={`${s.high_pct}%`}      color="#fa8c16" />
      <StatRow label="Very high risk" value={`${s.very_high_pct}%`} color="#ff4d4f" />
      <StatRow label="Avg risk score" value={`${s.avg_score} / 100`} />
      {s.note && <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>{s.note}</div>}
    </>
  )

  if (result.type === 'watershed') return (
    <>
      <StatRow label="Watershed area" value={`${s.area_ha} ha`} color="#4fc3f7" />
      <StatRow label="Area (km²)"     value={`${s.area_km2} km²`} />
      <StatRow label="Pour lat"       value={`${s.pour_lat}°`} />
      <StatRow label="Pour lon"       value={`${s.pour_lon}°`} />
    </>
  )

  if (result.type === 'cross_section') return (
    <div style={{ marginTop: 4 }}>
      {(result.profiles || []).map((p: any) => (
        <div key={p.label} style={{ marginBottom: 10 }}>
          <CrossSectionChart points={p.points} label={`${p.label}  (${(p.length_m/1000).toFixed(2)} km)`} />
          <div style={{ display: 'flex', gap: 16, fontSize: 10 }}>
            <span style={{ color: '#80ff80' }}>▼ {p.stats.min_m} m</span>
            <span style={{ color: '#ff8080' }}>▲ {p.stats.max_m} m</span>
            <span style={{ color: '#aaa' }}>Relief: {p.stats.relief_m} m</span>
          </div>
        </div>
      ))}
    </div>
  )

  if (result.type === 'twi') return (
    <>
      <StatRow label="TWI min (5th pct)"  value={s.twi_min}  color="#0891b2" />
      <StatRow label="TWI mean"           value={s.twi_mean} />
      <StatRow label="TWI max (95th pct)" value={s.twi_max}  color="#0891b2" />
      <StatRow label="Waterlogging risk"  value={`${s.waterlogging_risk_pct}% of area`} color="#38bdf8" />
      <StatRow label="Cell area"          value={`${s.cell_area_m2} m²`} />
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Blue = high TWI (wet/waterlogged) · Brown = low TWI (dry/ridge)
      </div>
    </>
  )

  if (result.type === 'solar_shadow') return (
    <>
      <StatRow label="Date / Time"       value={`${s.date}  ${s.time} UTC`} color="#d97706" />
      <StatRow label="Sun elevation"     value={`${s.sun_elevation_deg}°`}  color="#fbbf24" />
      <StatRow label="Sun azimuth"       value={`${s.sun_azimuth_deg}°`} />
      <StatRow label="Shadowed area"     value={`${s.shadowed_area_pct}%`}  color="#60a5fa" />
      {s.sun_elevation_deg <= 0 && (
        <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>
          Sun is below horizon at this date/time — entire area in shadow.
        </div>
      )}
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Dark blue = shadow · Bright = direct sunlight
      </div>
    </>
  )

  if (result.type === 'trafficability') return (
    <>
      <StatRow label="Easy (0–8°)"      value={`${s.easy_pct}%`}       color="#22c55e" />
      <StatRow label="Moderate (8–15°)" value={`${s.moderate_pct}%`}   color="#eab308" />
      <StatRow label="Difficult (15–30°)" value={`${s.difficult_pct}%`} color="#f97316" />
      <StatRow label="Impassable (>30°)" value={`${s.impassable_pct}%`} color="#ef4444" />
      <StatRow label="Passable area"    value={`${s.passable_area_km2} km²`} color="#22c55e" />
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Green=Easy · Yellow=Moderate · Orange=Difficult · Red=Impassable
      </div>
    </>
  )

  if (result.type === 'change_detection') return (
    <>
      <StatRow label="Cut volume"   value={`${s.cut_volume_m3.toLocaleString()} m³`}  color="#ef4444" />
      <StatRow label="Fill volume"  value={`${s.fill_volume_m3.toLocaleString()} m³`} color="#3b82f6" />
      <StatRow label="Net change"   value={`${s.net_change_m3 >= 0 ? '+' : ''}${s.net_change_m3.toLocaleString()} m³`}
        color={s.net_change_m3 >= 0 ? '#3b82f6' : '#ef4444'} />
      <StatRow label="Cut area"     value={`${s.cut_area_pct}%`}  color="#ef4444" />
      <StatRow label="Fill area"    value={`${s.fill_area_pct}%`} color="#3b82f6" />
      <StatRow label="Max cut"      value={`${s.max_cut_m} m`}  color="#f87171" />
      <StatRow label="Max fill"     value={`${s.max_fill_m} m`} color="#60a5fa" />
      <StatRow label="RMSE"         value={`${s.rmse_m} m`} />
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Red=cut (material removed) · Blue=fill (material added)
      </div>
    </>
  )

  if (result.type === 'lz_assessment') return (
    <>
      <StatRow label="Excellent (≥80)" value={`${s.excellent_pct}%`}  color="#22c55e" />
      <StatRow label="Good (60–79)"    value={`${s.good_pct}%`}       color="#84cc16" />
      <StatRow label="Marginal (40–59)" value={`${s.marginal_pct}%`}  color="#eab308" />
      <StatRow label="Unsuitable (<40)" value={`${s.unsuitable_pct}%`} color="#ef4444" />
      <StatRow label="Candidate zones" value={s.candidate_zones}      color="#22c55e" />
      <StatRow label="LZ radius"       value={`${s.lz_radius_m} m`} />
      <StatRow label="Approach dir"    value={`${s.approach_dir_deg}°`} />
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Green=Excellent · Yellow=Good/Marginal · Red=Unsuitable
      </div>
    </>
  )

  if (result.type === 'rf_coverage') return (
    <>
      <StatRow label="Clear LoS"       value={`${s.excellent_los_pct}%`}   color="#22c55e" />
      <StatRow label="Minor Fresnel"   value={`${s.minor_fresnel_pct}%`}   color="#84cc16" />
      <StatRow label="Partial Fresnel" value={`${s.partial_fresnel_pct}%`} color="#eab308" />
      <StatRow label="No coverage"     value={`${s.no_coverage_pct}%`}     color="#ef4444" />
      <StatRow label="Tower height"    value={`${s.tower_height_m} m`} />
      <StatRow label="Frequency"       value={`${s.freq_mhz} MHz`} />
      <StatRow label="Tower location"  value={`${s.tower_lat?.toFixed(4)}°, ${s.tower_lon?.toFixed(4)}°`} />
      <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>
        Green=Clear LoS · Yellow=Fresnel partial · Red=Blocked · Yellow dot=Tower
      </div>
    </>
  )

  return null
}

// ── main component ────────────────────────────────────────────────────────────

export default function DEMAnalysisPanel({ gridData, referenceGrid, onOverlay, onClearOverlays, onScenePNG }: Props) {
  const [selected, setSelected]   = useState<string | null>(null)
  const [params, setParams]       = useState<Record<string, any>>({})
  const [loading, setLoading]     = useState(false)
  const [result, setResult]       = useState<any>(null)
  const [error, setError]         = useState<string | null>(null)
  const [overlaid, setOverlaid]   = useState<Set<string>>(new Set())

  const tool = TOOLS.find(t => t.id === selected)

  const runAnalysis = useCallback(async () => {
    if (!gridData || !selected) return
    if (selected === 'change_detection' && !referenceGrid) {
      setError('Load a reference DEM first using "Set as Reference" in the toolbar.')
      return
    }
    setLoading(true); setError(null); setResult(null)
    try {
      const extraParams = selected === 'change_detection' && referenceGrid
        ? { ...params, grid2: referenceGrid.elevGrid }
        : params
      const res = await api.post('/core/terrain/dem-analysis/', {
        type: selected,
        elevGrid: gridData.elevGrid,
        bbox:     gridData.bbox,
        gridN:    gridData.gridN,
        params:   extraParams,
      })
      setResult(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }, [gridData, referenceGrid, selected, params])

  const handleOverlay = useCallback(() => {
    if (!result) return
    const id = `dem-${result.type}-${Date.now()}`

    if (result.image) {
      onOverlay({ id, type: 'image', label: tool?.label ?? result.type,
                  imageData: result.image, bbox: result.bbox })
    } else if (result.geojson) {
      onOverlay({ id, type: 'geojson', label: tool?.label ?? result.type,
                  geojson: result.geojson, bbox: result.bbox })
    }
    setOverlaid(prev => new Set([...prev, id]))
  }, [result, tool, onOverlay])

  const datestamp = new Date().toISOString().slice(0, 10)

  const downloadImage = useCallback(async () => {
    if (!result) return
    const label = tool?.label ?? result.type

    // Scene capture: 3D globe + title bar + legend + statistics (like slope PNG)
    if (onScenePNG && (result.image || result.geojson)) {
      const alreadyOn = [...overlaid].some(id => id.startsWith(`dem-${result.type}-`))
      if (!alreadyOn) {
        handleOverlay()
        // wait for the camera flyTo (1.5 s) + overlay tile to render
        await new Promise(r => setTimeout(r, 2200))
      }
      await onScenePNG(label, TOOL_LEGENDS[result.type] ?? [], buildStatLines(result))
      return
    }

    // Fallback: raw analysis raster
    if (!result.image) return
    const a = document.createElement('a')
    a.href = result.image
    a.download = `dem-${result.type}-${datestamp}.png`
    a.click()
  }, [result, tool, onScenePNG, overlaid, handleOverlay, datestamp])

  const downloadGeoJSON = useCallback(() => {
    if (!result?.geojson) return
    const blob = new Blob([JSON.stringify(result.geojson, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dem-${result.type}-${datestamp}.geojson`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [result, datestamp])

  const downloadCSV = useCallback(() => {
    if (!result?.profiles) return
    const rows: string[] = ['profile,point,distance_m,elevation_m']
    result.profiles.forEach((p: any) => {
      p.points.forEach((pt: any, i: number) => {
        rows.push(`${p.label},${i + 1},${pt.dist.toFixed(1)},${pt.elev.toFixed(2)}`)
      })
    })
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dem-cross-sections-${datestamp}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [result, datestamp])


  return (
    <div style={{ padding: '0 4px' }}>
      {/* Tool grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 4, marginBottom: 8 }}>
        {TOOLS.map(t => (
          <Tooltip key={t.id} title={t.desc} placement="top">
            <button
              onClick={() => { setSelected(t.id); setResult(null); setError(null); setParams({}) }}
              style={{
                background: selected === t.id ? `${t.color}22` : '#0a0d20',
                border: `1px solid ${selected === t.id ? t.color : '#1a1a2e'}`,
                borderRadius: 6, padding: '6px 2px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              }}
            >
              <span style={{ color: t.color, fontSize: 16 }}>{t.icon}</span>
              <span style={{ color: selected === t.id ? t.color : '#888', fontSize: 9,
                             lineHeight: 1, textAlign: 'center' }}>{t.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>

      {!gridData && (
        <Alert type="info" showIcon style={{ fontSize: 11, padding: '4px 8px' }}
          message="Run slope analysis first to load elevation grid." />
      )}

      {tool && gridData && (
        <>
          <Divider style={{ margin: '6px 0', borderColor: '#1a1a2e' }} />
          <Text style={{ color: tool.color, fontSize: 11, fontWeight: 600 }}>
            {tool.icon} {tool.label}
          </Text>
          <div style={{ color: '#666', fontSize: 10, marginBottom: 8, marginTop: 2 }}>
            {tool.desc}
          </div>

          {/* Parameters */}
          <div style={{ marginBottom: 8 }}>
            {selected === 'contours'          && <ContourParams   params={params} setParams={setParams} />}
            {selected === 'curvature'         && <CurvatureParams params={params} setParams={setParams} />}
            {selected === 'viewshed'          && <ViewshedParams  params={params} setParams={setParams} />}
            {(selected === 'volume' || selected === 'cut_fill') &&
                                               <VolumeParams    params={params} setParams={setParams} />}
            {selected === 'flood'             && <FloodParams     params={params} setParams={setParams} />}
            {selected === 'watershed'         && <WatershedParams params={params} setParams={setParams} />}
            {selected === 'solar_shadow'      && <SolarParams     params={params} setParams={setParams} />}
            {selected === 'lz_assessment'     && <LZParams        params={params} setParams={setParams} />}
            {selected === 'rf_coverage'       && <RFParams        params={params} setParams={setParams} />}
            {selected === 'change_detection'  && (
              <div style={{ fontSize: 10, padding: '4px 6px', background: referenceGrid ? '#0a2a1a' : '#2a0a0a',
                            borderRadius: 4, border: `1px solid ${referenceGrid ? '#16a34a' : '#7f1d1d'}` }}>
                {referenceGrid
                  ? <span style={{ color: '#4ade80' }}>Reference DEM loaded ({referenceGrid.elevGrid.length} cells). Current DEM is "after".</span>
                  : <span style={{ color: '#f87171' }}>No reference DEM. Click "Set as Reference" in toolbar, then load new DEM.</span>}
              </div>
            )}
          </div>

          <Button
            type="primary" size="small" block icon={<PlayCircleOutlined />}
            loading={loading} onClick={runAnalysis}
            style={{ background: tool.color, borderColor: tool.color, marginBottom: 8 }}
          >
            Run {tool.label}
          </Button>
        </>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 12 }}>
          <Spin size="small" />
          <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>Computing…</div>
        </div>
      )}

      {error && (
        <Alert type="error" showIcon style={{ fontSize: 11, padding: '4px 8px' }}
          message={error} />
      )}

      {result && !loading && (
        <>
          <Divider style={{ margin: '6px 0', borderColor: '#1a1a2e' }} />

          {/* Stats */}
          <div style={{ marginBottom: 8 }}>
            <ResultStats result={result} />
          </div>

          {/* Image preview */}
          {result.image && (
            <div style={{ marginBottom: 8, position: 'relative' }}>
              <img src={result.image} alt={result.type}
                style={{ width: '100%', borderRadius: 4, imageRendering: 'pixelated',
                         border: '1px solid #1a1a2e' }} />
              <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4 }}>
                <Tag color={tool?.color} style={{ fontSize: 9, cursor: 'default' }}>
                  {tool?.label}
                </Tag>
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Overlay row */}
            <div style={{ display: 'flex', gap: 6 }}>
              {(result.image || result.geojson) && (
                <Button size="small" icon={<GlobalOutlined />} onClick={handleOverlay}
                  style={{ flex: 1, fontSize: 11, color: '#4fc3f7', borderColor: '#4fc3f7',
                           background: 'transparent' }}>
                  Overlay Globe
                </Button>
              )}
              <Tooltip title="Clear all globe overlays">
                <Button size="small" icon={<CloseOutlined />}
                  onClick={() => { onClearOverlays(); setOverlaid(new Set()) }}
                  style={{ background: 'transparent', borderColor: '#555', color: '#666' }} />
              </Tooltip>
            </div>

            {/* Download row */}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              <Text style={{ color: '#555', fontSize: 10, alignSelf: 'center', marginRight: 2 }}>
                Download:
              </Text>
              {(result.image || (onScenePNG && result.geojson)) && (
                <Tooltip title="Download annotated 3D scene PNG (legend + statistics)">
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadImage}
                    style={{ background: 'transparent', borderColor: '#3a3a5e',
                             color: '#aaa', fontSize: 10 }}>
                    PNG
                  </Button>
                </Tooltip>
              )}
              {result.geojson && (
                <Tooltip title="Download as GeoJSON (open in QGIS, ArcGIS, geojson.io)">
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadGeoJSON}
                    style={{ background: 'transparent', borderColor: '#3a3a5e',
                             color: '#52c41a', fontSize: 10 }}>
                    GeoJSON
                  </Button>
                </Tooltip>
              )}
              {result.profiles && (
                <Tooltip title="Download cross-section profiles as CSV">
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadCSV}
                    style={{ background: 'transparent', borderColor: '#3a3a5e',
                             color: '#faad14', fontSize: 10 }}>
                    CSV
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
