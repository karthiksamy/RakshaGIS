import { useEffect, useRef, useState, useCallback } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  Button, Select, Typography, Statistic, Spin, message,
  Tooltip, Divider, Tag, Row, Col, Slider, Alert, Dropdown,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  LineChartOutlined, AreaChartOutlined,
  AimOutlined, ReloadOutlined, GlobalOutlined, InfoCircleOutlined,
  CloseOutlined, ColumnHeightOutlined, ExportOutlined,
  FileImageOutlined, FilePdfOutlined, FileTextOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import api from '@/services/api'
import ElevationChart from './ElevationChart'

const { Text } = Typography

type Tool = 'none' | 'elevation' | 'profile' | 'slope'

// India bounding box
const INDIA_RECT = Cesium.Rectangle.fromDegrees(68.0, 6.5, 97.5, 37.5)

interface ElevPoint { dist: number; elev: number; lat: number; lon: number }
interface SlopeStats { min: number; max: number; avg: number; gridSize: number }
interface ClickedElev { lat: number; lon: number; elev: number }
interface SlopeGridData {
  elevGrid: number[]
  bbox: [number, number, number, number]  // [minLon, minLat, maxLon, maxLat] degrees
  gridN: number
}

// Color features by layer_name (consistent hash-based color)
function layerColor(name?: string | null): Cesium.Color {
  const s = name || 'layer'
  let h = 0
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h)
  const hue = Math.abs(h % 360) / 360
  return Cesium.Color.fromHsl(hue, 0.7, 0.55, 0.6)
}

// Build a Cesium imagery provider from a configured BasemapConfig (or a sensible
// public-OSM fallback). Handles {a-c}-style subdomain templates → Cesium {s}.
function makeCesiumImagery(basemap?: any): Cesium.ImageryProvider {
  let url = (basemap?.url_template || '').trim()
  let subdomains: string[] | undefined
  const m = url.match(/\{([a-z])-([a-z])\}/i)
  if (m) {
    subdomains = []
    for (let c = m[1].charCodeAt(0); c <= m[2].charCodeAt(0); c++) {
      subdomains.push(String.fromCharCode(c))
    }
    url = url.replace(m[0], '{s}')
  } else if (url.includes('{s}')) {
    subdomains = ['a', 'b', 'c']
  }
  // OSM provider or no template → public OSM tiles (works without the local tile server).
  if (!url || basemap?.provider === 'OSM') {
    url = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    subdomains = undefined
  }
  return new Cesium.UrlTemplateImageryProvider({
    url,
    subdomains,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 19,
    credit: new Cesium.Credit(basemap?.attribution || 'OpenStreetMap contributors'),
  })
}

// Add a single GeoJSON geometry to a Cesium datasource as draped/extruded entities.
// Handles polygon holes and multi-geometries (used by both project & external layers).
function addGeomEntity(
  ds: Cesium.CustomDataSource,
  geom: any,
  name: string,
  color: Cesium.Color,
  extrudedHeight: number,
) {
  if (!geom) return
  // GISFeatureSerializer (DRF-GIS GeometryField) can hand back the geometry as a
  // JSON string rather than a nested object — parse it so .type/.coordinates work.
  if (typeof geom === 'string') {
    try { geom = JSON.parse(geom) } catch { return }
  }
  if (!geom || !geom.type) return
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
    polys.forEach((poly: number[][][]) => {
      if (!poly || !poly.length) return
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(poly[0].flat()),
        poly.slice(1).map((hole) =>
          new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(hole.flat()))),
      )
      // IMPORTANT: a ground-clamped polygon (heightReference CLAMP_TO_GROUND) cannot
      // also be extruded — that combination throws in Cesium's render loop and blanks
      // the globe. So: drape on terrain when not extruding, else extrude as a volume.
      const polygon: any = extrudedHeight > 0
        ? { hierarchy, material: color, outline: true,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.4),
            height: 0, extrudedHeight }
        : { hierarchy, material: color, outline: false,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
      ds.entities.add({ name, polygon })
    })
  } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    const coords = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates
    coords.forEach((line: number[][]) => {
      ds.entities.add({
        name,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(line.flat()),
          width: 2, material: color, clampToGround: true,
        },
      })
    })
  } else if (geom.type === 'Point' || geom.type === 'MultiPoint') {
    const pts = geom.type === 'Point' ? [geom.coordinates] : geom.coordinates
    pts.forEach((p: number[]) => {
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p[0], p[1]),
        point: { pixelSize: 8, color, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
      })
    })
  }
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
  const [selectedArea, setSelectedArea] = useState<number | null>(null)
  const [selectedExtLayer, setSelectedExtLayer] = useState<number | null>(null)
  const [extFilterValue, setExtFilterValue] = useState<string | null>(null)
  const [extLoading, setExtLoading] = useState(false)
  const [featuresLoaded, setFeaturesLoaded] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [cesiumError, setCesiumError] = useState<string | null>(null)

  // Tool results
  const [clickedElev, setClickedElev] = useState<ClickedElev | null>(null)
  const [profileData, setProfileData] = useState<ElevPoint[]>([])
  const [slopeStats, setSlopeStats] = useState<SlopeStats | null>(null)
  const [slopeGridData, setSlopeGridData] = useState<SlopeGridData | null>(null)
  const [profileBuilding, setProfileBuilding] = useState(false)
  const [slopeBuilding, setSlopeBuilding] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Feature extrusion height (0 = drape flat on the terrain; >0 = raise as a volume).
  // Default 0 so parcels render as proper shapes clamped to the ground.
  const [extrusionH, setExtrusionH] = useState(0)

  const { data: terrainCfg } = useQuery<any>({
    queryKey: ['terrain-config'],
    queryFn: () => api.get('/core/terrain-config/').then(r => r.data),
  })

  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/?page_size=100').then(r => r.data.results ?? r.data),
  })

  // Active external DB layers (GLR plans etc.) available to drape on the terrain.
  const { data: extLayers = [] } = useQuery<any[]>({
    queryKey: ['ext-layers-active'],
    queryFn: () => api.get('/external/layers/').then(r => r.data.results ?? r.data),
  })

  // Configured basemaps — used as the globe imagery (consistent with the 2D map).
  const { data: basemaps = [] } = useQuery<any[]>({
    queryKey: ['basemaps'],
    queryFn: () => api.get('/gis/basemaps/').then(r => r.data.results ?? r.data),
  })
  const [selectedBasemap, setSelectedBasemap] = useState<number | null>(null)

  // Survey areas (named, e.g. "AFS Sulur") for the selected project.
  const { data: surveyAreas = [] } = useQuery<any[]>({
    queryKey: ['survey-areas-3d', selectedProject],
    queryFn: () => api.get(`/projects/survey-areas/?project=${selectedProject}`)
      .then(r => r.data.results ?? r.data),
    enabled: !!selectedProject,
  })

  // The column an external layer is filtered by (configured by the super admin):
  // office-name field → classification field → label column → first analysis column.
  // office_filter_field is the dedicated office-name column (same field the 2D
  // ExternalLayersPanel uses); it must take priority so the office dropdown appears.
  const extLayer = extLayers.find((l: any) => l.id === selectedExtLayer)
  const extFilterField: string =
    (extLayer?.office_filter_field || extLayer?.classification_field || extLayer?.label_column ||
     (extLayer?.analysis_columns || [])[0] || '').trim()

  // Distinct values of that column, for the value-filter dropdown.
  const { data: extFilterValues = [] } = useQuery<string[]>({
    queryKey: ['ext-distinct', selectedExtLayer, extFilterField],
    queryFn: () => api.get(`/external/layers/${selectedExtLayer}/distinct-values/`, {
      params: { field: extFilterField, limit: 500 },
    }).then(r => r.data?.values ?? []),
    enabled: !!selectedExtLayer && !!extFilterField,
  })

  // Default to the super-admin-configured default basemap (else first active).
  useEffect(() => {
    if (basemaps.length && selectedBasemap == null) {
      const pick =
        basemaps.find((b: any) => b.is_default && b.is_active) ??
        basemaps.find((b: any) => b.is_active) ??
        basemaps[0]
      if (pick) setSelectedBasemap(pick.id)
    }
  }, [basemaps])

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
        // terrainProvider was removed from the Viewer constructor in Cesium 1.107 —
        // setting it here silently does nothing in 1.107+, leaving the globe with an
        // undefined provider and crashing at computeMaximumLevelAtPosition.
        // Set it directly on the viewer after construction instead (see below).
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

      // terrainProvider + imageryProvider must both be set post-construction
      // (both options were removed from the Viewer constructor in Cesium 1.107/1.101).
      viewer.terrainProvider = tp
      viewer.imageryLayers.removeAll()
      viewer.imageryLayers.addImageryProvider(makeCesiumImagery())

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

  // Swap the globe imagery whenever the chosen basemap changes.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready) return
    const bm = basemaps.find((b: any) => b.id === selectedBasemap)
    viewer.imageryLayers.removeAll()
    viewer.imageryLayers.addImageryProvider(makeCesiumImagery(bm))
  }, [ready, selectedBasemap, basemaps])

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
        // sampleTerrainMostDetailed requires a CesiumTerrainProvider (needs availability).
        // EllipsoidTerrainProvider has no availability — fall back to the globe-picked height.
        const tp = viewer.terrainProvider
        const elev = (tp as any).availability
          ? (await Cesium.sampleTerrainMostDetailed(tp, [Cesium.Cartographic.fromDegrees(lon, lat)]))[0].height ?? carto.height ?? 0
          : carto.height ?? 0
        setClickedElev({ lat, lon, elev })
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
            const { stats, gridData } = await computeSlopeStats(viewer, slopeWaypointsRef.current[0], slopeWaypointsRef.current[1])
            setSlopeStats(stats)
            setSlopeGridData(gridData)
          } finally {
            setSlopeBuilding(false)
            setActiveTool('none')
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }
  }, [activeTool, ready])

  const loadProjectFeatures = useCallback(async (projectId: number, areaId?: number | null) => {
    const viewer = viewerRef.current
    if (!viewer) return
    // Remove previous feature datasources
    const toRemove = viewer.dataSources.getByName('project-features')
    toRemove.forEach((ds: any) => viewer.dataSources.remove(ds))

    try {
      // A specific survey area (e.g. "AFS Sulur") loads only that area's features;
      // otherwise the whole project loads.
      const res = areaId
        ? await api.get(`/projects/survey-areas/${areaId}/features/?limit=20000`)
        : await api.get(`/projects/features/?project=${projectId}&page_size=2000`)
      const raw = areaId ? (res.data?.features ?? []) : (res.data.results ?? res.data)
      // Normalise to { geometry, layer_name } regardless of endpoint shape.
      const features = areaId
        ? raw.map((f: any) => ({ geometry: f.geometry, layer_name: f.properties?.layer_name }))
        : raw
      if (!features.length) { message.info('No features found'); return }

      const ds = new Cesium.CustomDataSource('project-features')
      let drawn = 0
      features.forEach((f: any) => {
        try {
          addGeomEntity(ds, f.geometry, f.layer_name, layerColor(f.layer_name), extrusionH)
          drawn++
        } catch { /* skip a malformed feature without losing the rest */ }
      })
      await viewer.dataSources.add(ds)
      viewer.flyTo(ds, { duration: 1.5 }).catch(() => {})
      setFeaturesLoaded(true)
      message.success(`Loaded ${drawn} of ${features.length} features`)
    } catch {
      message.error('Failed to load features')
    }
  }, [extrusionH])

  // Drape an external DB layer (e.g. GLR plan) over the terrain.
  const loadExternalLayer = useCallback(async (
    extId: number, name: string, filterField?: string, filterValue?: string | null,
  ) => {
    const viewer = viewerRef.current
    if (!viewer) return
    const dsName = `ext-${extId}`
    // Replace any prior instance of this layer
    viewer.dataSources.getByName(dsName).forEach((ds: any) => viewer.dataSources.remove(ds))

    setExtLoading(true)
    try {
      // Geometry is returned in WGS84 by the backend; cap to keep the viewer responsive.
      // Optionally filter by the super-admin-configured column value.
      const params: Record<string, unknown> = { limit: 20000 }
      if (filterField && filterValue) {
        params.filter_field = filterField
        params.filter_value = filterValue
      }
      const res = await api.get(`/external/layers/${extId}/geojson/`, { params })
      const features = res.data?.features ?? []
      if (!features.length) { message.info(`No matching features in "${name}"`); return }

      const ds = new Cesium.CustomDataSource(dsName)
      const color = layerColor(name)
      features.forEach((f: any) => {
        try { addGeomEntity(ds, f.geometry, name, color, extrusionH) } catch { /* skip */ }
      })
      await viewer.dataSources.add(ds)
      viewer.flyTo(ds, { duration: 1.5 }).catch(() => {})
      setFeaturesLoaded(true)
      message.success(`Loaded "${name}" — ${features.length} feature(s)`)
    } catch {
      message.error(`Failed to load "${name}"`)
    } finally {
      setExtLoading(false)
    }
  }, [extrusionH])

  function clearAll() {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.entities.removeAll()
    const toRemove = viewer.dataSources.getByName('project-features')
    toRemove.forEach((ds: any) => viewer.dataSources.remove(ds))
    // Remove any draped external layers (named 'ext-<id>')
    for (let i = viewer.dataSources.length - 1; i >= 0; i--) {
      const ds = viewer.dataSources.get(i)
      if (ds?.name?.startsWith('ext-')) viewer.dataSources.remove(ds)
    }
    setFeaturesLoaded(false)
    setClickedElev(null)
    setProfileData([])
    setSlopeStats(null)
    setSlopeGridData(null)
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

  // ── Export helpers ──────────────────────────────────────────────────────────

  const exportPNG = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    try {
      viewer.render()
      viewer.scene.canvas.toBlob((blob) => {
        if (!blob) { message.error('PNG capture failed'); return }
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `rakshagis-terrain-${new Date().toISOString().slice(0, 10)}.png`
        a.click()
        URL.revokeObjectURL(url)
      }, 'image/png')
    } catch {
      message.error('PNG export failed — canvas may be unavailable')
    }
  }, [])

  const exportPDF = useCallback(async () => {
    setExporting(true)
    try {
      const { jsPDF } = await import('jspdf')
      const viewer = viewerRef.current
      const W = 297, H = 210  // A4 landscape mm
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

      // Header bar
      pdf.setFillColor(13, 13, 31)
      pdf.rect(0, 0, W, 22, 'F')
      pdf.setTextColor(79, 195, 247)
      pdf.setFontSize(14)
      pdf.text('RakshaGIS — Terrain Analysis Report', 10, 14)
      pdf.setTextColor(160, 160, 160)
      pdf.setFontSize(8)
      pdf.text(`Generated: ${new Date().toLocaleString()}   |   Terrain source: ${terrainLabel}`, 10, 20)

      // Globe screenshot
      if (viewer) {
        try {
          viewer.render()
          const imgData = viewer.scene.canvas.toDataURL('image/jpeg', 0.85)
          pdf.addImage(imgData, 'JPEG', 10, 26, W - 20, 110)
        } catch { /* tainted canvas — skip image */ }
      }

      // Analysis data
      let x = 10, y = 144
      pdf.setTextColor(30, 30, 30)

      if (clickedElev) {
        pdf.setFontSize(11); pdf.setTextColor(79, 195, 247)
        pdf.text('Point Elevation', x, y); y += 6
        pdf.setFontSize(9); pdf.setTextColor(50, 50, 50)
        pdf.text(`Latitude  : ${clickedElev.lat.toFixed(5)}°`, x + 4, y); y += 5
        pdf.text(`Longitude : ${clickedElev.lon.toFixed(5)}°`, x + 4, y); y += 5
        pdf.text(`Elevation : ${clickedElev.elev.toFixed(1)} m`, x + 4, y); y += 8
      }

      if (profileData.length > 0) {
        pdf.setFontSize(11); pdf.setTextColor(79, 195, 247)
        pdf.text('Elevation Profile', x, y); y += 6
        pdf.setFontSize(9); pdf.setTextColor(50, 50, 50)
        const minE = Math.min(...profileData.map(d => d.elev))
        const maxE = Math.max(...profileData.map(d => d.elev))
        const lenKm = ((profileData[profileData.length - 1]?.dist ?? 0) / 1000).toFixed(2)
        pdf.text(`Length    : ${lenKm} km`, x + 4, y); y += 5
        pdf.text(`Min elev  : ${minE.toFixed(1)} m`, x + 4, y); y += 5
        pdf.text(`Max elev  : ${maxE.toFixed(1)} m`, x + 4, y); y += 5
        pdf.text(`Relief    : ${(maxE - minE).toFixed(1)} m`, x + 4, y); y += 8
      }

      if (slopeStats) {
        pdf.setFontSize(11); pdf.setTextColor(79, 195, 247)
        pdf.text('Slope Analysis', x, y); y += 6
        pdf.setFontSize(9); pdf.setTextColor(50, 50, 50)
        const desc = slopeStats.avg < 5 ? 'Mostly flat' : slopeStats.avg < 15 ? 'Gentle slopes'
          : slopeStats.avg < 30 ? 'Moderate terrain' : 'Steep terrain'
        pdf.text(`Min slope : ${slopeStats.min.toFixed(1)}°`, x + 4, y); y += 5
        pdf.text(`Avg slope : ${slopeStats.avg.toFixed(1)}°  (${desc})`, x + 4, y); y += 5
        pdf.text(`Max slope : ${slopeStats.max.toFixed(1)}°`, x + 4, y); y += 5
        pdf.text(`Grid      : ${slopeStats.gridSize}×${slopeStats.gridSize} samples`, x + 4, y)
      }

      // Footer
      pdf.setTextColor(120, 120, 120); pdf.setFontSize(7)
      pdf.text('RakshaGIS — Defence GIS Platform', W - 10, H - 4, { align: 'right' })

      pdf.save(`rakshagis-terrain-${new Date().toISOString().slice(0, 10)}.pdf`)
      message.success('PDF exported')
    } catch (e) {
      message.error('PDF export failed')
    } finally {
      setExporting(false)
    }
  }, [clickedElev, profileData, slopeStats, terrainLabel])

  const exportProfileCSV = useCallback(() => {
    if (!profileData.length) return
    const rows = ['point,distance_m,latitude_deg,longitude_deg,elevation_m']
    profileData.forEach((p, i) =>
      rows.push(`${i + 1},${p.dist.toFixed(1)},${p.lat.toFixed(6)},${p.lon.toFixed(6)},${p.elev.toFixed(2)}`)
    )
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `elevation-profile-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    message.success('CSV exported')
  }, [profileData])

  const exportGeoTIFF = useCallback(async () => {
    if (!slopeGridData) return
    setExporting(true)
    try {
      message.loading({ content: 'Building GeoTIFF…', key: 'gtiff' })
      const res = await api.post('/core/terrain/export-geotiff/', slopeGridData, {
        responseType: 'blob',
      })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `slope-analysis-${new Date().toISOString().slice(0, 10)}.tif`
      a.click()
      URL.revokeObjectURL(url)
      message.success({ content: 'GeoTIFF exported (Band 1: elevation m, Band 2: slope°)', key: 'gtiff' })
    } catch {
      message.error({ content: 'GeoTIFF export failed', key: 'gtiff' })
    } finally {
      setExporting(false)
    }
  }, [slopeGridData])

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
          style={{ width: 180 }}
          size="small"
          showSearch
          optionFilterProp="label"
          options={projects.map((p: any) => ({ value: p.id, label: p.project_number || p.name }))}
          value={selectedProject}
          onChange={(v) => { setSelectedProject(v); setSelectedArea(null) }}
        />
        <Tooltip title="Optional: load only one survey area (e.g. AFS Sulur)">
          <Select
            placeholder="Survey area (all)"
            style={{ width: 170 }}
            size="small"
            allowClear
            showSearch
            optionFilterProp="label"
            disabled={!selectedProject}
            options={surveyAreas.map((a: any) => ({ value: a.id, label: a.name }))}
            value={selectedArea}
            onChange={(v) => setSelectedArea(v ?? null)}
          />
        </Tooltip>
        <Button
          size="small" type="primary"
          disabled={!selectedProject || !ready}
          onClick={() => selectedProject && loadProjectFeatures(selectedProject, selectedArea)}
        >
          {selectedArea ? 'Load Area' : 'Load Features'}
        </Button>

        <Divider type="vertical" style={{ borderColor: '#2a2a3e', height: 20 }} />

        <Select
          placeholder="External layer"
          style={{ width: 170 }}
          size="small"
          allowClear
          showSearch
          optionFilterProp="label"
          options={extLayers.map((l: any) => ({ value: l.id, label: l.display_name }))}
          value={selectedExtLayer}
          onChange={(v) => { setSelectedExtLayer(v ?? null); setExtFilterValue(null) }}
        />
        {extFilterField && (
          <Tooltip title={`Filter by ${extFilterField} (configured by admin)`}>
            <Select
              placeholder={extFilterField}
              style={{ width: 160 }}
              size="small"
              allowClear
              showSearch
              optionFilterProp="label"
              options={extFilterValues.map((v: string) => ({ value: v, label: v }))}
              value={extFilterValue}
              onChange={(v) => setExtFilterValue(v ?? null)}
            />
          </Tooltip>
        )}
        <Button
          size="small"
          loading={extLoading}
          disabled={!selectedExtLayer || !ready}
          onClick={() => {
            const l = extLayers.find((x: any) => x.id === selectedExtLayer)
            if (l) loadExternalLayer(l.id, l.display_name, extFilterField, extFilterValue)
          }}
        >
          Load Layer
        </Button>

        <Divider type="vertical" style={{ borderColor: '#2a2a3e', height: 20 }} />

        <Tooltip title="Globe basemap imagery">
          <Select
            placeholder="Basemap"
            style={{ width: 150 }}
            size="small"
            options={basemaps
              .filter((b: any) => b.is_active)
              .map((b: any) => ({ value: b.id, label: b.is_default ? `${b.name} ★` : b.name }))}
            value={selectedBasemap}
            onChange={setSelectedBasemap}
          />
        </Tooltip>

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

            {/* Export bar */}
            {(clickedElev || profileData.length > 0 || slopeStats) && (
              <>
                <Divider style={{ margin: '8px 0', borderColor: '#1a1a2e' }} />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Text style={{ color: '#666', fontSize: 10, marginRight: 2 }}>Export:</Text>
                  <Tooltip title="Screenshot of the 3D globe as PNG">
                    <Button
                      size="small" icon={<FileImageOutlined />}
                      loading={exporting} onClick={exportPNG}
                      style={{ fontSize: 11 }}
                    >PNG</Button>
                  </Tooltip>
                  <Tooltip title="PDF report — map screenshot + analysis stats">
                    <Button
                      size="small" icon={<FilePdfOutlined />}
                      loading={exporting} onClick={exportPDF}
                      style={{ fontSize: 11 }}
                    >PDF</Button>
                  </Tooltip>
                  {profileData.length > 0 && (
                    <Tooltip title="Elevation profile as CSV (point, distance, lat, lon, elevation)">
                      <Button
                        size="small" icon={<FileTextOutlined />}
                        onClick={exportProfileCSV}
                        style={{ fontSize: 11 }}
                      >CSV</Button>
                    </Tooltip>
                  )}
                  {slopeGridData && (
                    <Tooltip title="Slope analysis as GeoTIFF raster (Band 1: elevation m, Band 2: slope°)">
                      <Button
                        size="small" icon={<ExportOutlined />}
                        loading={exporting} onClick={exportGeoTIFF}
                        style={{ fontSize: 11 }}
                      >GeoTIFF</Button>
                    </Tooltip>
                  )}
                </div>
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

  const tp = viewer.terrainProvider
  const sampled = (tp as any).availability
    ? await Cesium.sampleTerrainMostDetailed(tp, positions)
    : positions  // EllipsoidTerrainProvider: heights remain 0 (no DEM data)

  return sampled.map((c, i) => ({
    dist: geoDist[i],
    elev: (c as Cesium.Cartographic).height ?? 0,
    lat: Cesium.Math.toDegrees(positions[i].latitude),
    lon: Cesium.Math.toDegrees(positions[i].longitude),
  }))
}

async function computeSlopeStats(
  viewer: Cesium.Viewer,
  corner1: Cesium.Cartesian3,
  corner2: Cesium.Cartesian3,
  gridN = 15,
): Promise<{ stats: SlopeStats; gridData: SlopeGridData }> {
  const c1 = Cesium.Cartographic.fromCartesian(corner1)
  const c2 = Cesium.Cartographic.fromCartesian(corner2)

  const minLonRad = Math.min(c1.longitude, c2.longitude)
  const maxLonRad = Math.max(c1.longitude, c2.longitude)
  const minLatRad = Math.min(c1.latitude, c2.latitude)
  const maxLatRad = Math.max(c1.latitude, c2.latitude)

  // Build grid (row 0 = southernmost, so north→south flip happens in backend)
  const positions: Cesium.Cartographic[] = []
  for (let row = 0; row < gridN; row++) {
    for (let col = 0; col < gridN; col++) {
      const lon = minLonRad + (col / (gridN - 1)) * (maxLonRad - minLonRad)
      const lat = minLatRad + (row / (gridN - 1)) * (maxLatRad - minLatRad)
      positions.push(new Cesium.Cartographic(lon, lat))
    }
  }

  const tp = viewer.terrainProvider
  const sampled = (tp as any).availability
    ? await Cesium.sampleTerrainMostDetailed(tp, positions)
    : positions  // EllipsoidTerrainProvider: heights remain 0 (no DEM data)

  // Raw elevation grid for GeoTIFF export (degrees bbox)
  const elevGrid = sampled.map(c => (c as Cesium.Cartographic).height ?? 0)
  const bbox: [number, number, number, number] = [
    Cesium.Math.toDegrees(minLonRad), Cesium.Math.toDegrees(minLatRad),
    Cesium.Math.toDegrees(maxLonRad), Cesium.Math.toDegrees(maxLatRad),
  ]

  const slopes: number[] = []
  const dx = haversineM(
    Cesium.Math.toDegrees(minLatRad), Cesium.Math.toDegrees(minLonRad),
    Cesium.Math.toDegrees(minLatRad), Cesium.Math.toDegrees(maxLonRad),
  ) / (gridN - 1)
  const dy = haversineM(
    Cesium.Math.toDegrees(minLatRad), Cesium.Math.toDegrees(minLonRad),
    Cesium.Math.toDegrees(maxLatRad), Cesium.Math.toDegrees(minLonRad),
  ) / (gridN - 1)

  for (let row = 1; row < gridN - 1; row++) {
    for (let col = 1; col < gridN - 1; col++) {
      const idx = row * gridN + col
      const h00 = elevGrid[idx] ?? 0
      const hE = elevGrid[idx + 1] ?? h00
      const hN = elevGrid[idx + gridN] ?? h00
      const dzdx = (hE - h00) / dx
      const dzdy = (hN - h00) / dy
      slopes.push(Math.atan(Math.sqrt(dzdx ** 2 + dzdy ** 2)) * (180 / Math.PI))
    }
  }

  const stats: SlopeStats = slopes.length
    ? {
        min: Math.min(...slopes),
        max: Math.max(...slopes),
        avg: slopes.reduce((a, b) => a + b, 0) / slopes.length,
        gridSize: gridN,
      }
    : { min: 0, max: 0, avg: 0, gridSize: gridN }

  return { stats, gridData: { elevGrid, bbox, gridN } }
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
