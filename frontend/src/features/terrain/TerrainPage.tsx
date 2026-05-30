import { useEffect, useRef, useState, useCallback } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  Button, Select, Space, Typography, Card, Statistic, Spin, message,
  Tooltip, Divider, Tag, Row, Col, Slider, Alert,
} from 'antd'
import {
  EnvironmentOutlined, LineChartOutlined, AreaChartOutlined,
  AimOutlined, ReloadOutlined, GlobalOutlined, InfoCircleOutlined,
  CloseOutlined, ColumnHeightOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import api from '@/services/api'
import ElevationChart from './ElevationChart'

const { Title, Text } = Typography

type Tool = 'none' | 'elevation' | 'profile' | 'slope'

// India bounding box
const INDIA_RECT = Cesium.Rectangle.fromDegrees(68.0, 6.5, 97.5, 37.5)

interface ElevPoint { dist: number; elev: number }
interface SlopeStats { min: number; max: number; avg: number; gridSize: number }
interface ClickedElev { lat: number; lon: number; elev: number }

// Color features by layer_name (consistent hash-based color)
function layerColor(name: string): Cesium.Color {
  let h = 0
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h)
  const hue = Math.abs(h % 360) / 360
  return Cesium.Color.fromHsl(hue, 0.7, 0.55, 0.6)
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export default function TerrainPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null)
  const profileWaypointsRef = useRef<Cesium.Cartesian3[]>([])
  const slopeWaypointsRef = useRef<Cesium.Cartesian3[]>([])

  const [ready, setReady] = useState(false)
  const [activeTool, setActiveTool] = useState<Tool>('none')
  const [selectedProject, setSelectedProject] = useState<number | null>(null)
  const [featuresLoaded, setFeaturesLoaded] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [cesiumError, setCesiumError] = useState<string | null>(null)

  // Tool results
  const [clickedElev, setClickedElev] = useState<ClickedElev | null>(null)
  const [profileData, setProfileData] = useState<ElevPoint[]>([])
  const [slopeStats, setSlopeStats] = useState<SlopeStats | null>(null)
  const [profileBuilding, setProfileBuilding] = useState(false)
  const [slopeBuilding, setSlopeBuilding] = useState(false)

  // Extrusion height slider (for features)
  const [extrusionH, setExtrusionH] = useState(10)

  const { data: terrainCfg } = useQuery<any>({
    queryKey: ['terrain-config'],
    queryFn: () => api.get('/core/terrain-config/').then(r => r.data),
  })

  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/?page_size=100').then(r => r.data.results ?? r.data),
  })

  // Init Cesium viewer
  useEffect(() => {
    if (!containerRef.current) return

    // Check if Cesium is properly loaded
    if (!Cesium || !Cesium.Viewer) {
      const err = 'Cesium library failed to load. Please refresh the page.'
      setCesiumError(err)
      console.error(err, Cesium)
      return
    }

    // Disable ION if no token
    const token = terrainCfg?.cesium_ion_token ?? ''
    Cesium.Ion.defaultAccessToken = token || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy'

    // Terrain provider
    let terrainProvider: Cesium.TerrainProvider = new Cesium.EllipsoidTerrainProvider()

    const initViewer = (tp: Cesium.TerrainProvider) => {
      if (!containerRef.current) return
      const viewer = new Cesium.Viewer(containerRef.current, {
        terrainProvider: tp,
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        vrButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: true,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        creditContainer: document.createElement('div'),
      })

      // Add imagery (post-construction — imageryProvider was removed from constructor in Cesium 1.101)
      viewer.imageryLayers.removeAll()
      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: '/osm-tiles/{z}/{x}/{y}.png',
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          maximumLevel: 18,
          credit: new Cesium.Credit('OpenStreetMap contributors'),
        })
      )

      // Remove default imagery (loaded by imageryProvider constructor above)
      // Do NOT do anything — UrlTemplateImageryProvider is passed directly

      viewer.scene.globe.depthTestAgainstTerrain = true
      viewer.scene.globe.enableLighting = false

      // Fly to India
      viewer.camera.flyTo({ destination: INDIA_RECT, duration: 2 })

      viewerRef.current = viewer
      setReady(true)
    }

    // Try local terrain first, fall back to ellipsoid
    const terrainUrl = terrainCfg?.terrain_tile_url
    const terrainSource = terrainCfg?.terrain_source ?? 'none'

    if (terrainSource === 'ion' && token) {
      Cesium.CesiumTerrainProvider.fromIonAssetId(1)
        .then((tp) => { terrainProvider = tp; initViewer(tp) })
        .catch(() => initViewer(new Cesium.EllipsoidTerrainProvider()))
    } else if (terrainSource === 'local' && terrainUrl) {
      Cesium.CesiumTerrainProvider.fromUrl(terrainUrl, { requestVertexNormals: true })
        .then((tp) => { terrainProvider = tp; initViewer(tp) })
        .catch(() => initViewer(new Cesium.EllipsoidTerrainProvider()))
    } else {
      initViewer(new Cesium.EllipsoidTerrainProvider())
    }

    return () => {
      handlerRef.current?.destroy()
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
      setReady(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrainCfg?.terrain_source])

  // Install click handler based on active tool
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready) return

    handlerRef.current?.destroy()
    handlerRef.current = null

    if (activeTool === 'none') return

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    handlerRef.current = handler

    if (activeTool === 'elevation') {
      handler.setInputAction(async (e: any) => {
        const ray = viewer.camera.getPickRay(e.position)
        if (!ray) return
        const cart = viewer.scene.globe.pick(ray, viewer.scene)
        if (!cart) return
        const carto = Cesium.Cartographic.fromCartesian(cart)
        const lat = Cesium.Math.toDegrees(carto.latitude)
        const lon = Cesium.Math.toDegrees(carto.longitude)
        const sampled = await Cesium.sampleTerrainMostDetailed(
          viewer.terrainProvider, [Cesium.Cartographic.fromDegrees(lon, lat)]
        )
        setClickedElev({ lat, lon, elev: sampled[0].height ?? carto.height ?? 0 })
        setPanelOpen(true)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }

    if (activeTool === 'profile') {
      profileWaypointsRef.current = []
      message.info('Click to add waypoints. Right-click to finish profile.', 3)

      handler.setInputAction((e: any) => {
        const ray = viewer.camera.getPickRay(e.position)
        if (!ray) return
        const cart = viewer.scene.globe.pick(ray, viewer.scene)
        if (cart) {
          profileWaypointsRef.current = [...profileWaypointsRef.current, cart]
          viewer.entities.add({
            position: cart,
            point: { pixelSize: 6, color: Cesium.Color.CYAN, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
          })
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

      handler.setInputAction(async () => {
        const pts = profileWaypointsRef.current
        if (pts.length < 2) { message.warning('Add at least 2 points'); return }
        setProfileBuilding(true)
        setPanelOpen(true)
        try {
          const result = await buildElevationProfile(viewer, pts)
          setProfileData(result)
        } finally {
          setProfileBuilding(false)
          setActiveTool('none')
        }
      }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)
    }

    if (activeTool === 'slope') {
      slopeWaypointsRef.current = []
      message.info('Click 2 corners to define analysis area.', 3)

      handler.setInputAction(async (e: any) => {
        const ray = viewer.camera.getPickRay(e.position)
        if (!ray) return
        const cart = viewer.scene.globe.pick(ray, viewer.scene)
        if (!cart) return
        slopeWaypointsRef.current = [...slopeWaypointsRef.current, cart]
        viewer.entities.add({
          position: cart,
          point: { pixelSize: 8, color: Cesium.Color.ORANGE, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
        })
        if (slopeWaypointsRef.current.length === 2) {
          setSlopeBuilding(true)
          setPanelOpen(true)
          try {
            const stats = await computeSlopeStats(viewer, slopeWaypointsRef.current[0], slopeWaypointsRef.current[1])
            setSlopeStats(stats)
          } finally {
            setSlopeBuilding(false)
            setActiveTool('none')
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }
  }, [activeTool, ready])

  const loadProjectFeatures = useCallback(async (projectId: number) => {
    const viewer = viewerRef.current
    if (!viewer) return
    // Remove previous feature datasources
    const toRemove = viewer.dataSources.getByName('project-features')
    toRemove.forEach((ds: any) => viewer.dataSources.remove(ds))

    try {
      const res = await api.get(`/projects/features/?project=${projectId}&page_size=2000`)
      const features = res.data.results ?? res.data
      if (!features.length) { message.info('No features found for this project'); return }

      const ds = new Cesium.CustomDataSource('project-features')
      await viewer.dataSources.add(ds)

      features.forEach((f: any) => {
        const color = layerColor(f.layer_name)
        const geom = f.geometry
        if (!geom) return

        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
          const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((c: any) => c[0])
          rings.forEach((ring: number[][]) => {
            const hierarchy = new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(ring.flat())
            )
            ds.entities.add({
              name: f.layer_name,
              polygon: {
                hierarchy,
                material: color,
                outline: true,
                outlineColor: Cesium.Color.WHITE.withAlpha(0.4),
                height: 0,
                extrudedHeight: extrusionH,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
            })
          })
        } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
          const coords = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates
          coords.forEach((line: number[][]) => {
            ds.entities.add({
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(line.flat()),
                width: 2,
                material: color,
                clampToGround: true,
              },
            })
          })
        } else if (geom.type === 'Point') {
          ds.entities.add({
            position: Cesium.Cartesian3.fromDegrees(geom.coordinates[0], geom.coordinates[1]),
            point: { pixelSize: 8, color, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
            label: {
              text: f.layer_name,
              font: '11px sans-serif',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -14),
            },
          })
        }
      })

      viewer.zoomTo(ds)
      setFeaturesLoaded(true)
      message.success(`Loaded ${features.length} features`)
    } catch {
      message.error('Failed to load project features')
    }
  }, [extrusionH])

  function clearAll() {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.entities.removeAll()
    const toRemove = viewer.dataSources.getByName('project-features')
    toRemove.forEach((ds: any) => viewer.dataSources.remove(ds))
    setFeaturesLoaded(false)
    setClickedElev(null)
    setProfileData([])
    setSlopeStats(null)
    profileWaypointsRef.current = []
    slopeWaypointsRef.current = []
    setActiveTool('none')
  }

  function flyToIndia() {
    viewerRef.current?.camera.flyTo({ destination: INDIA_RECT, duration: 2 })
  }

  const terrainLabel =
    terrainCfg?.terrain_source === 'ion' ? 'Cesium ION' :
    terrainCfg?.terrain_source === 'local' ? 'Local Server' :
    'Ellipsoid (flat)'

  if (cesiumError) {
    return (
      <div style={{ height: '100%', padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a1a' }}>
        <Alert
          type="error"
          message="3D Terrain Viewer Error"
          description={cesiumError}
          showIcon
          style={{ maxWidth: 500 }}
        />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a1a' }}>
      {/* Toolbar */}
      <div style={{
        padding: '8px 16px', background: '#0d0d1f', borderBottom: '1px solid #1a1a2e',
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <Text style={{ color: '#4fc3f7', fontWeight: 600, marginRight: 4 }}>
          3D Terrain Viewer
        </Text>

        <Select
          placeholder="Select project"
          style={{ width: 200 }}
          size="small"
          options={projects.map((p: any) => ({ value: p.id, label: p.project_number || p.name }))}
          value={selectedProject}
          onChange={setSelectedProject}
        />
        <Button
          size="small" type="primary"
          disabled={!selectedProject || !ready}
          onClick={() => selectedProject && loadProjectFeatures(selectedProject)}
        >
          Load Features
        </Button>

        <Divider type="vertical" style={{ borderColor: '#2a2a3e', height: 20 }} />

        <Tooltip title="Fly to India">
          <Button size="small" icon={<GlobalOutlined />} onClick={flyToIndia} disabled={!ready} />
        </Tooltip>

        <Tooltip title="Query elevation at a clicked point">
          <Button
            size="small"
            icon={<AimOutlined />}
            type={activeTool === 'elevation' ? 'primary' : 'default'}
            onClick={() => setActiveTool(t => t === 'elevation' ? 'none' : 'elevation')}
            disabled={!ready}
          >
            Elevation
          </Button>
        </Tooltip>

        <Tooltip title="Draw a line to plot elevation profile">
          <Button
            size="small"
            icon={<LineChartOutlined />}
            type={activeTool === 'profile' ? 'primary' : 'default'}
            onClick={() => setActiveTool(t => t === 'profile' ? 'none' : 'profile')}
            disabled={!ready}
          >
            Profile
          </Button>
        </Tooltip>

        <Tooltip title="Click 2 corners to analyse slope in an area">
          <Button
            size="small"
            icon={<AreaChartOutlined />}
            type={activeTool === 'slope' ? 'primary' : 'default'}
            onClick={() => setActiveTool(t => t === 'slope' ? 'none' : 'slope')}
            disabled={!ready}
          >
            Slope
          </Button>
        </Tooltip>

        <Divider type="vertical" style={{ borderColor: '#2a2a3e', height: 20 }} />

        <Tooltip title="Feature extrusion height (m)">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ColumnHeightOutlined style={{ color: '#888' }} />
            <Slider
              min={0} max={500} step={5} value={extrusionH}
              onChange={setExtrusionH}
              style={{ width: 80 }}
              tooltip={{ formatter: (v) => `${v}m` }}
            />
          </div>
        </Tooltip>

        <Button size="small" icon={<ReloadOutlined />} onClick={clearAll} disabled={!ready} danger>
          Clear
        </Button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tag color={terrainCfg?.terrain_source === 'none' ? 'default' : 'blue'}>
            Terrain: {terrainLabel}
          </Tag>
          {!ready && <Spin size="small" />}
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
        {/* Cesium container */}
        <div ref={containerRef} style={{ flex: 1, height: '100%' }} />

        {/* Active tool hint */}
        {activeTool !== 'none' && (
          <div style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '6px 14px',
            borderRadius: 20, fontSize: 12, pointerEvents: 'none',
          }}>
            {activeTool === 'elevation' && 'Left-click anywhere to query elevation'}
            {activeTool === 'profile' && 'Left-click to add waypoints · Right-click to compute profile'}
            {activeTool === 'slope' && `Click ${slopeWaypointsRef.current.length === 0 ? 'first' : 'second'} corner of analysis area`}
          </div>
        )}

        {/* Right analysis panel */}
        {panelOpen && (
          <div style={{
            position: 'absolute', top: 8, right: 8, width: 360,
            background: 'rgba(13,13,31,0.95)', border: '1px solid #1a1a2e',
            borderRadius: 8, padding: 12, backdropFilter: 'blur(4px)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ color: '#4fc3f7', fontWeight: 600, fontSize: 13 }}>Analysis</Text>
              <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setPanelOpen(false)} />
            </div>

            {/* Elevation query result */}
            {clickedElev && activeTool !== 'profile' && activeTool !== 'slope' && (
              <>
                <Row gutter={8}>
                  <Col span={12}>
                    <Statistic
                      title={<span style={{ color: '#888', fontSize: 11 }}>Elevation</span>}
                      value={clickedElev.elev.toFixed(1)}
                      suffix="m"
                      valueStyle={{ color: '#52c41a', fontSize: 20 }}
                    />
                  </Col>
                  <Col span={12}>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      <div>Lat: {clickedElev.lat.toFixed(5)}°</div>
                      <div>Lon: {clickedElev.lon.toFixed(5)}°</div>
                    </div>
                  </Col>
                </Row>
              </>
            )}

            {/* Elevation profile */}
            {(profileBuilding || profileData.length > 0) && (
              <>
                <Divider style={{ margin: '8px 0', borderColor: '#1a1a2e' }} />
                <Text style={{ color: '#aaa', fontSize: 12 }}>Elevation Profile</Text>
                {profileBuilding ? (
                  <div style={{ textAlign: 'center', padding: 16 }}>
                    <Spin size="small" /> <Text style={{ color: '#888', fontSize: 11 }}> Sampling terrain…</Text>
                  </div>
                ) : (
                  <>
                    <div style={{ marginTop: 8 }}>
                      <ElevationChart data={profileData} width={336} height={130} />
                    </div>
                    <Row gutter={8} style={{ marginTop: 8 }}>
                      {[
                        { label: 'Min', value: Math.min(...profileData.map(d => d.elev)).toFixed(0) + ' m' },
                        { label: 'Max', value: Math.max(...profileData.map(d => d.elev)).toFixed(0) + ' m' },
                        { label: 'Length', value: ((profileData[profileData.length - 1]?.dist ?? 0) / 1000).toFixed(2) + ' km' },
                      ].map(s => (
                        <Col span={8} key={s.label}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ color: '#888', fontSize: 10 }}>{s.label}</div>
                            <div style={{ color: '#e8e8e8', fontSize: 13, fontWeight: 600 }}>{s.value}</div>
                          </div>
                        </Col>
                      ))}
                    </Row>
                  </>
                )}
              </>
            )}

            {/* Slope analysis */}
            {(slopeBuilding || slopeStats) && (
              <>
                <Divider style={{ margin: '8px 0', borderColor: '#1a1a2e' }} />
                <Text style={{ color: '#aaa', fontSize: 12 }}>Slope Analysis</Text>
                {slopeBuilding ? (
                  <div style={{ textAlign: 'center', padding: 16 }}>
                    <Spin size="small" /> <Text style={{ color: '#888', fontSize: 11 }}> Sampling {Math.pow(15,2)} points…</Text>
                  </div>
                ) : slopeStats && (
                  <>
                    <Row gutter={8} style={{ marginTop: 8 }}>
                      {[
                        { label: 'Min slope', value: slopeStats.min.toFixed(1) + '°', color: '#52c41a' },
                        { label: 'Avg slope', value: slopeStats.avg.toFixed(1) + '°', color: '#faad14' },
                        { label: 'Max slope', value: slopeStats.max.toFixed(1) + '°', color: '#ff4d4f' },
                      ].map(s => (
                        <Col span={8} key={s.label}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ color: '#888', fontSize: 10 }}>{s.label}</div>
                            <div style={{ color: s.color, fontSize: 14, fontWeight: 600 }}>{s.value}</div>
                          </div>
                        </Col>
                      ))}
                    </Row>
                    <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
                      Sampled on {slopeStats.gridSize}×{slopeStats.gridSize} grid ·&nbsp;
                      {slopeStats.avg < 5 ? 'Mostly flat' : slopeStats.avg < 15 ? 'Gentle slopes' : slopeStats.avg < 30 ? 'Moderate terrain' : 'Steep terrain'}
                    </div>
                    <SlopeColorBar />
                  </>
                )}
              </>
            )}

            {/* Terrain info */}
            <Divider style={{ margin: '8px 0', borderColor: '#1a1a2e' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#666' }}>
              <InfoCircleOutlined />
              <span>
                Terrain: <strong style={{ color: '#888' }}>{terrainLabel}</strong>
                {terrainCfg?.terrain_source === 'none' && (
                  <> — flat (no elevation data). Set up a terrain server for real DEM.</>
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildElevationProfile(
  viewer: Cesium.Viewer,
  waypoints: Cesium.Cartesian3[],
  numSamples = 60,
): Promise<ElevPoint[]> {
  // Interpolate positions along polyline
  const totalLen = waypoints.slice(1).reduce((acc, wp, i) => {
    return acc + Cesium.Cartesian3.distance(waypoints[i], wp)
  }, 0)

  const positions: Cesium.Cartographic[] = []
  const distances: number[] = []
  let cumDist = 0

  for (let seg = 0; seg < waypoints.length - 1; seg++) {
    const segLen = Cesium.Cartesian3.distance(waypoints[seg], waypoints[seg + 1])
    const segSamples = Math.max(2, Math.round((segLen / totalLen) * numSamples))
    for (let k = seg === 0 ? 0 : 1; k <= segSamples; k++) {
      const t = k / segSamples
      const p = Cesium.Cartesian3.lerp(waypoints[seg], waypoints[seg + 1], t, new Cesium.Cartesian3())
      const c = Cesium.Cartographic.fromCartesian(p)
      positions.push(c)
      distances.push(
        cumDist + Cesium.Cartesian3.distance(waypoints[seg], p)
      )
    }
    cumDist += segLen
  }

  // Convert Cartesian distances to geodetic (haversine) distances
  const geoDist: number[] = [0]
  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1]
    const curr = positions[i]
    const d = haversineM(
      Cesium.Math.toDegrees(prev.latitude), Cesium.Math.toDegrees(prev.longitude),
      Cesium.Math.toDegrees(curr.latitude), Cesium.Math.toDegrees(curr.longitude),
    )
    geoDist.push(geoDist[i - 1] + d)
  }

  const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions)

  return sampled.map((c, i) => ({
    dist: geoDist[i],
    elev: c.height ?? 0,
  }))
}

async function computeSlopeStats(
  viewer: Cesium.Viewer,
  corner1: Cesium.Cartesian3,
  corner2: Cesium.Cartesian3,
  gridN = 15,
): Promise<SlopeStats> {
  const c1 = Cesium.Cartographic.fromCartesian(corner1)
  const c2 = Cesium.Cartographic.fromCartesian(corner2)

  const minLon = Math.min(c1.longitude, c2.longitude)
  const maxLon = Math.max(c1.longitude, c2.longitude)
  const minLat = Math.min(c1.latitude, c2.latitude)
  const maxLat = Math.max(c1.latitude, c2.latitude)

  // Build grid
  const positions: Cesium.Cartographic[] = []
  for (let row = 0; row < gridN; row++) {
    for (let col = 0; col < gridN; col++) {
      const lon = minLon + (col / (gridN - 1)) * (maxLon - minLon)
      const lat = minLat + (row / (gridN - 1)) * (maxLat - minLat)
      positions.push(new Cesium.Cartographic(lon, lat))
    }
  }

  const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions)

  const slopes: number[] = []
  const dx = haversineM(
    Cesium.Math.toDegrees(minLat), Cesium.Math.toDegrees(minLon),
    Cesium.Math.toDegrees(minLat), Cesium.Math.toDegrees(maxLon),
  ) / (gridN - 1)
  const dy = haversineM(
    Cesium.Math.toDegrees(minLat), Cesium.Math.toDegrees(minLon),
    Cesium.Math.toDegrees(maxLat), Cesium.Math.toDegrees(minLon),
  ) / (gridN - 1)

  for (let row = 1; row < gridN - 1; row++) {
    for (let col = 1; col < gridN - 1; col++) {
      const idx = row * gridN + col
      const h00 = sampled[idx]?.height ?? 0
      const hE = sampled[idx + 1]?.height ?? h00
      const hN = sampled[idx + gridN]?.height ?? h00
      const dzdx = (hE - h00) / dx
      const dzdy = (hN - h00) / dy
      const slopeDeg = Math.atan(Math.sqrt(dzdx ** 2 + dzdy ** 2)) * (180 / Math.PI)
      slopes.push(slopeDeg)
    }
  }

  if (!slopes.length) return { min: 0, max: 0, avg: 0, gridSize: gridN }

  return {
    min: Math.min(...slopes),
    max: Math.max(...slopes),
    avg: slopes.reduce((a, b) => a + b, 0) / slopes.length,
    gridSize: gridN,
  }
}

function SlopeColorBar() {
  const stops = [
    { slope: '0°', color: '#52c41a', label: 'Flat' },
    { slope: '5°', color: '#a0d911', label: '' },
    { slope: '15°', color: '#faad14', label: 'Gentle' },
    { slope: '30°', color: '#fa8c16', label: 'Moderate' },
    { slope: '45°+', color: '#ff4d4f', label: 'Steep' },
  ]
  return (
    <div style={{ marginTop: 8 }}>
      <Text style={{ color: '#888', fontSize: 10 }}>Slope severity scale</Text>
      <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
        {stops.map(s => (
          <div key={s.slope} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />
            <span style={{ color: '#888' }}>{s.slope}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
