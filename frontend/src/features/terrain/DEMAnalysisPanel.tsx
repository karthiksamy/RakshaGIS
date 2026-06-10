import { useState, useCallback } from 'react'
import {
  Button, InputNumber, Select, Spin, Tag, Tooltip,
  Typography, Divider, Row, Col, Alert,
} from 'antd'
import {
  AreaChartOutlined, CompassOutlined, LineChartOutlined,
  NodeIndexOutlined, SwapOutlined, EyeOutlined,
  RadarChartOutlined, ColumnWidthOutlined,
  AlertOutlined, WarningOutlined, GlobalOutlined,
  DownloadOutlined, CloseOutlined, PlayCircleOutlined,
} from '@ant-design/icons'
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
  onOverlay: (layer: DEMLayer) => void
  onClearOverlays: () => void
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
  { id: 'cross_section', label: 'Cross Sections',icon: <ColumnWidthOutlined />, color: '#d46b08',
    desc: 'N–S and E–W elevation cross-sections through the study area.' },
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

  return null
}

// ── main component ────────────────────────────────────────────────────────────

export default function DEMAnalysisPanel({ gridData, onOverlay, onClearOverlays }: Props) {
  const [selected, setSelected]   = useState<string | null>(null)
  const [params, setParams]       = useState<Record<string, any>>({})
  const [loading, setLoading]     = useState(false)
  const [result, setResult]       = useState<any>(null)
  const [error, setError]         = useState<string | null>(null)
  const [overlaid, setOverlaid]   = useState<Set<string>>(new Set())

  const tool = TOOLS.find(t => t.id === selected)

  const runAnalysis = useCallback(async () => {
    if (!gridData || !selected) return
    setLoading(true); setError(null); setResult(null)
    try {
      const res = await api.post('/core/terrain/dem-analysis/', {
        type: selected,
        elevGrid: gridData.elevGrid,
        bbox:     gridData.bbox,
        gridN:    gridData.gridN,
        params:   params,
      })
      setResult(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }, [gridData, selected, params])

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

  const downloadImage = useCallback(() => {
    if (!result?.image) return
    const a = document.createElement('a')
    a.href = result.image
    a.download = `dem-${result.type}-${new Date().toISOString().slice(0,10)}.png`
    a.click()
  }, [result])

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
            {selected === 'contours'     && <ContourParams  params={params} setParams={setParams} />}
            {selected === 'curvature'    && <CurvatureParams params={params} setParams={setParams} />}
            {selected === 'viewshed'     && <ViewshedParams  params={params} setParams={setParams} />}
            {(selected === 'volume' || selected === 'cut_fill') &&
                                            <VolumeParams    params={params} setParams={setParams} />}
            {selected === 'flood'        && <FloodParams     params={params} setParams={setParams} />}
            {selected === 'watershed'    && <WatershedParams params={params} setParams={setParams} />}
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
          <div style={{ display: 'flex', gap: 6 }}>
            {(result.image || result.geojson) && (
              <Button size="small" icon={<GlobalOutlined />} onClick={handleOverlay}
                style={{ flex: 1, fontSize: 11, color: '#4fc3f7', borderColor: '#4fc3f7',
                         background: 'transparent' }}>
                Overlay Globe
              </Button>
            )}
            {result.image && (
              <Tooltip title="Download PNG">
                <Button size="small" icon={<DownloadOutlined />} onClick={downloadImage}
                  style={{ background: 'transparent', borderColor: '#555', color: '#888' }} />
              </Tooltip>
            )}
            <Tooltip title="Clear all overlays">
              <Button size="small" icon={<CloseOutlined />}
                onClick={() => { onClearOverlays(); setOverlaid(new Set()) }}
                style={{ background: 'transparent', borderColor: '#555', color: '#888' }} />
            </Tooltip>
          </div>
        </>
      )}
    </div>
  )
}
