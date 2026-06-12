import { useEffect, useRef, useState, useCallback } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  Button, Select, Typography, Statistic, Spin, message,
  Tooltip, Divider, Tag, Row, Col, Slider, Alert, Dropdown,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  LineChartOutlined, AreaChartOutlined, RadarChartOutlined,
  AimOutlined, ReloadOutlined, GlobalOutlined, InfoCircleOutlined,
  CloseOutlined, ColumnHeightOutlined,
  FileImageOutlined, FilePdfOutlined, FileTextOutlined, SyncOutlined,
  UploadOutlined, SplitCellsOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import api from '@/services/api'
import { watermarkAndDownload } from '@/utils/watermarkDownload'
import ElevationChart from './ElevationChart'
import DEMAnalysisPanel, { type DEMLayer } from './DEMAnalysisPanel'

const { Text } = Typography

type Tool = 'none' | 'elevation' | 'profile' | 'slope'

// India bounding box
const INDIA_RECT = Cesium.Rectangle.fromDegrees(68.0, 6.5, 97.5, 37.5)

interface ElevPoint { dist: number; elev: number; lat: number; lon: number }
interface SlopeCategories { flat: number; gentle: number; moderate: number; steep: number; verysteep: number }
interface SlopeStats { min: number; max: number; avg: number; gridSize: number; categories: SlopeCategories }
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
function makeCesiumImagery(basemap?: any): Cesium.ImageryProvider | Promise<Cesium.ImageryProvider> {
  if (basemap?.provider === 'ARCGIS' && basemap?.url_template) {
    return Cesium.ArcGisMapServerImageryProvider.fromUrl(basemap.url_template, {
      token: basemap.api_key || undefined,
    })
  }

  let url = (basemap?.url_template || '').trim()
    // WMTS REST template (GoogleMapsCompatible) → Cesium {z}/{y}/{x} placeholders
    .replace('{TileMatrix}', '{z}')
    .replace('{TileRow}', '{y}')
    .replace('{TileCol}', '{x}')
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
  const [autoArcGisTerrain, setAutoArcGisTerrain] = useState(false)
  const [arcgisTerrainLoading, setArcgisTerrainLoading] = useState(false)
  const [terrainExaggeration, setTerrainExaggeration] = useState(2)

  // Tool results
  const [clickedElev, setClickedElev] = useState<ClickedElev | null>(null)
  const [profileData, setProfileData] = useState<ElevPoint[]>([])
  const [slopeStats, setSlopeStats] = useState<SlopeStats | null>(null)
  const [slopeGridData, setSlopeGridData] = useState<SlopeGridData | null>(null)
  const [profileBuilding, setProfileBuilding] = useState(false)
  const [slopeBuilding, setSlopeBuilding] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [panelTab, setPanelTab] = useState<'analysis' | 'dem'>('analysis')
  const demLayerRefsRef = useRef<Map<string, Cesium.ImageryLayer | Cesium.GeoJsonDataSource>>(new Map())
  const gpxDataSourceRef = useRef<Cesium.CustomDataSource | null>(null)
  const gpxFileInputRef = useRef<HTMLInputElement>(null)
  const [gpxLoaded, setGpxLoaded] = useState(false)
  const [gpxName, setGpxName] = useState<string | null>(null)

  // Ad-hoc vector layer (shapefile zip / GeoJSON / KML / KMZ / GPKG) draped on terrain
  const vectorDsRef = useRef<Cesium.GeoJsonDataSource | null>(null)
  const vectorFileInputRef = useRef<HTMLInputElement>(null)
  const vectorBboxRef = useRef<[number, number, number, number] | null>(null)
  const [vectorLoaded, setVectorLoaded] = useState(false)
  const [vectorName, setVectorName] = useState<string | null>(null)
  const [vectorUploading, setVectorUploading] = useState(false)

  // ── LiDAR point cloud ──────────────────────────────────────────────────────
  const lidarFileInputRef = useRef<HTMLInputElement>(null)
  const lidarPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null)
  const [lidarLoaded, setLidarLoaded] = useState(false)
  const [lidarName, setLidarName] = useState<string | null>(null)
  const [lidarUploading, setLidarUploading] = useState(false)

  // ── Reference grid (for change detection) ─────────────────────────────────
  const [referenceGrid, setReferenceGrid] = useState<SlopeGridData | null>(null)

  // ── Comparison slider ──────────────────────────────────────────────────────
  const [splitMode, setSplitMode] = useState(false)
  const [splitPos, setSplitPos] = useState(0.5)         // 0–1 fraction from left
  const [splitRightId, setSplitRightId] = useState<number | null>(null)
  const splitDragging = useRef(false)
  const splitRightLayerRef = useRef<Cesium.ImageryLayer | null>(null)

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

    const token = terrainCfg?.cesium_ion_token ?? ''
    // Always override the default token. Cesium.js ships with an expiring built-in
    // token; if we leave it unset, Cesium uses that token and calls api.cesium.com
    // which returns 401. Setting any different value skips the credit-check request.
    // We use '' (no Ion features) unless a real token is configured.
    Cesium.Ion.defaultAccessToken = token || ''

    // Terrain provider
    let terrainProvider: Cesium.TerrainProvider = new Cesium.EllipsoidTerrainProvider()

    const initViewer = (tp: Cesium.TerrainProvider) => {
      if (!containerRef.current) return
      const viewer = new Cesium.Viewer(containerRef.current, {
        // baseLayer: false prevents the default Ion/Bing fromWorldImagery call during
        // construction — we add our own imagery provider immediately after.
        baseLayer: false as any,
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: true,
        vrButton: false,
        geocoder: false,
        homeButton: true,
        infoBox: false,
        sceneModePicker: true,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: true,
        navigationInstructionsInitiallyVisible: false,
        creditContainer: document.createElement('div'),
      })

      // terrainProvider + imageryProvider must both be set post-construction
      // (both options were removed from the Viewer constructor in Cesium 1.107/1.101).
      viewer.terrainProvider = tp
      viewer.imageryLayers.removeAll()
      // No basemap arg → always returns sync OSM provider
      viewer.imageryLayers.addImageryProvider(makeCesiumImagery() as Cesium.ImageryProvider)

      viewer.scene.globe.depthTestAgainstTerrain = true
      viewer.scene.globe.enableLighting = false
      viewer.scene.verticalExaggeration = 2

      // Override the home button to fly to India (prevents Ion default destination)
      viewer.homeButton.viewModel.command.beforeExecute.addEventListener(
        (e: any) => {
          e.cancel = true
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(82, 20, 3200000),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
            duration: 2,
          })
        }
      )

      // Fly to India with a tilted perspective so terrain looks 3D
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(82, 20, 3200000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
        duration: 2,
      })

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
        .catch(() => {
          // Local terrain server not reachable (tiles not yet set up or server
          // not started). Use flat ellipsoid — silently, without Ion fallback,
          // to avoid 401 "InvalidCredentials" when no real Ion token is set.
          // Users should run setup_terrain.sh and start terrain-server to enable 3D terrain.
          initViewer(new Cesium.EllipsoidTerrainProvider())
        })
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
    const providerOrPromise = makeCesiumImagery(bm)
    if (providerOrPromise instanceof Promise) {
      providerOrPromise.then((provider) => {
        if (!viewer.isDestroyed()) {
          viewer.imageryLayers.removeAll()
          viewer.imageryLayers.addImageryProvider(provider)
        }
      }).catch(() => {
        if (!viewer.isDestroyed()) {
          viewer.imageryLayers.removeAll()
          viewer.imageryLayers.addImageryProvider(makeCesiumImagery() as Cesium.ImageryProvider)
        }
      })
    } else {
      viewer.imageryLayers.removeAll()
      viewer.imageryLayers.addImageryProvider(providerOrPromise)
    }
  }, [ready, selectedBasemap, basemaps])

  // Comparison slider effect — applies Cesium SplitDirection to imagery layers
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready) return

    // Remove previous right-side comparison layer
    if (splitRightLayerRef.current) {
      viewer.imageryLayers.remove(splitRightLayerRef.current, true)
      splitRightLayerRef.current = null
    }

    if (!splitMode) {
      // Reset all layers to no split
      for (let i = 0; i < viewer.imageryLayers.length; i++) {
        viewer.imageryLayers.get(i).splitDirection = Cesium.SplitDirection.NONE
      }
      viewer.scene.splitPosition = 0.5
      return
    }

    // Left side — existing base imagery
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      viewer.imageryLayers.get(i).splitDirection = Cesium.SplitDirection.LEFT
    }
    viewer.scene.splitPosition = splitPos

    // Right side — add second basemap layer
    if (splitRightId !== null) {
      const bm = basemaps.find((b: any) => b.id === splitRightId)
      const provOrPromise = makeCesiumImagery(bm)
      const attach = (provider: Cesium.ImageryProvider) => {
        if (viewer.isDestroyed()) return
        const layer = viewer.imageryLayers.addImageryProvider(provider, 0)
        layer.splitDirection = Cesium.SplitDirection.RIGHT
        splitRightLayerRef.current = layer
      }
      if (provOrPromise instanceof Promise) {
        provOrPromise.then(attach).catch(() => {})
      } else {
        attach(provOrPromise)
      }
    }
  }, [ready, splitMode, splitPos, splitRightId, basemaps])

  // When any ARCGIS basemap with a token exists and no other terrain is configured,
  // automatically load ArcGIS World Elevation for real 3D terrain.
  // This does NOT depend on which basemap is selected — the first available
  // ARCGIS token is used as soon as the viewer is ready.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready || terrainCfg?.terrain_source !== 'none') return
    const arcgisBm = basemaps.find((b: any) => b.provider === 'ARCGIS' && b.api_key)
    if (arcgisBm) {
      setArcgisTerrainLoading(true)
      Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
        'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
        { token: arcgisBm.api_key },
      ).then((tp) => {
        if (!viewer.isDestroyed()) {
          viewer.terrainProvider = tp
          setAutoArcGisTerrain(true)
        }
      }).catch((err) => {
        console.warn('ArcGIS elevation terrain failed to load:', err)
      }).finally(() => setArcgisTerrainLoading(false))
    } else {
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider()
      setAutoArcGisTerrain(false)
    }
  }, [ready, basemaps, terrainCfg?.terrain_source])

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
        let elev: number
        if (hasRealTerrain(viewer)) {
          const tp = viewer.terrainProvider
          const sampled = await Cesium.sampleTerrainMostDetailed(tp, [Cesium.Cartographic.fromDegrees(lon, lat)])
          const h = sampled[0]?.height
          elev = (h != null && isFinite(h)) ? h : 0
        } else {
          const res = await apiElevation([{ lat, lon }])
          elev = res[0] ?? 0
        }
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

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready) return
    viewer.scene.verticalExaggeration = terrainExaggeration
  }, [terrainExaggeration, ready])

  const handleDemOverlay = useCallback((layer: DEMLayer) => {
    const viewer = viewerRef.current
    if (!viewer) return
    const [minLon, minLat, maxLon, maxLat] = layer.bbox
    const rect = Cesium.Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat)
    // Fly to a padded view (~60% margin) — flying to the exact bbox zooms in
    // past the basemap's available tile levels and the map turns blank.
    const padLon = Math.max((maxLon - minLon) * 0.6, 0.01)
    const padLat = Math.max((maxLat - minLat) * 0.6, 0.01)
    const flyRect = Cesium.Rectangle.fromDegrees(
      Math.max(minLon - padLon, -180), Math.max(minLat - padLat, -90),
      Math.min(maxLon + padLon, 180),  Math.min(maxLat + padLat, 90),
    )

    if (layer.type === 'image' && layer.imageData) {
      const provider = new Cesium.SingleTileImageryProvider({ url: layer.imageData, rectangle: rect })
      const il = viewer.imageryLayers.addImageryProvider(provider)
      il.alpha = 0.75
      demLayerRefsRef.current.set(layer.id, il)
      viewer.camera.flyTo({ destination: flyRect, duration: 1.5 })
    } else if (layer.type === 'geojson' && layer.geojson) {
      Cesium.GeoJsonDataSource.load(layer.geojson, {
        clampToGround: true,
        stroke: Cesium.Color.CYAN,
        fill: Cesium.Color.CYAN.withAlpha(0.2),
        strokeWidth: 1.5,
      }).then(ds => {
        ds.name = `dem-${layer.id}`
        viewer.dataSources.add(ds)
        demLayerRefsRef.current.set(layer.id, ds)
        viewer.camera.flyTo({ destination: flyRect, duration: 1.5 })
      })
    }
    message.success(`Overlay "${layer.label}" added to globe`)
  }, [])

  const handleClearDemOverlays = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    demLayerRefsRef.current.forEach((ref) => {
      if (ref instanceof Cesium.ImageryLayer) {
        viewer.imageryLayers.remove(ref, true)
      } else {
        viewer.dataSources.remove(ref as Cesium.GeoJsonDataSource, true)
      }
    })
    demLayerRefsRef.current.clear()
    message.info('DEM overlays cleared')
  }, [])

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
    handleClearDemOverlays()
    // Remove GPX data source
    if (gpxDataSourceRef.current) {
      viewer.dataSources.remove(gpxDataSourceRef.current)
      gpxDataSourceRef.current = null
    }
    setGpxLoaded(false)
    setGpxName(null)
    // Remove uploaded vector layer
    if (vectorDsRef.current) {
      viewer.dataSources.remove(vectorDsRef.current)
      vectorDsRef.current = null
    }
    vectorBboxRef.current = null
    setVectorLoaded(false)
    setVectorName(null)
    // Remove LiDAR point cloud
    if (lidarPointsRef.current) {
      viewer.scene.primitives.remove(lidarPointsRef.current)
      lidarPointsRef.current = null
    }
    setLidarLoaded(false)
    setLidarName(null)
  }

  const handleGpxImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const viewer = viewerRef.current
    if (!viewer) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const xml = new DOMParser().parseFromString(reader.result as string, 'text/xml')
        const ns = 'http://www.topografix.com/GPX/1/1'
        const ds = new Cesium.CustomDataSource(`gpx-${file.name}`)

        // Helper: parse <ele> child text
        const getEle = (node: Element) => {
          const el = node.getElementsByTagNameNS(ns, 'ele')[0] ?? node.getElementsByTagName('ele')[0]
          return el ? parseFloat(el.textContent || '0') : 0
        }
        const getName = (node: Element) => {
          const n = node.getElementsByTagNameNS(ns, 'name')[0] ?? node.getElementsByTagName('name')[0]
          return n?.textContent?.trim() || null
        }

        // Tracks → polylines
        const trksegs = [...xml.getElementsByTagNameNS(ns, 'trkseg'), ...xml.getElementsByTagName('trkseg')]
        trksegs.forEach((seg, si) => {
          const pts = [...seg.getElementsByTagNameNS(ns, 'trkpt'), ...seg.getElementsByTagName('trkpt')]
          if (pts.length < 2) return
          const positions = pts.map(p => {
            const lat = parseFloat(p.getAttribute('lat') || '0')
            const lon = parseFloat(p.getAttribute('lon') || '0')
            const ele = getEle(p)
            return Cesium.Cartesian3.fromDegrees(lon, lat, ele > 0 ? ele : undefined)
          })
          ds.entities.add({
            name: `Track segment ${si + 1}`,
            polyline: {
              positions,
              width: 3,
              material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: Cesium.Color.DEEPSKYBLUE }),
              clampToGround: true,
            },
          })
        })

        // Routes → polylines (orange)
        const rtepts = [...xml.getElementsByTagNameNS(ns, 'rte'), ...xml.getElementsByTagName('rte')]
        rtepts.forEach((rte, ri) => {
          const pts = [...rte.getElementsByTagNameNS(ns, 'rtept'), ...rte.getElementsByTagName('rtept')]
          if (pts.length < 2) return
          const positions = pts.map(p => {
            const lat = parseFloat(p.getAttribute('lat') || '0')
            const lon = parseFloat(p.getAttribute('lon') || '0')
            const ele = getEle(p)
            return Cesium.Cartesian3.fromDegrees(lon, lat, ele > 0 ? ele : undefined)
          })
          ds.entities.add({
            name: getName(rte) || `Route ${ri + 1}`,
            polyline: {
              positions,
              width: 3,
              material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: Cesium.Color.ORANGE }),
              clampToGround: true,
            },
          })
        })

        // Waypoints → pins
        const wpts = [...xml.getElementsByTagNameNS(ns, 'wpt'), ...xml.getElementsByTagName('wpt')]
        wpts.forEach(wpt => {
          const lat = parseFloat(wpt.getAttribute('lat') || '0')
          const lon = parseFloat(wpt.getAttribute('lon') || '0')
          const ele = getEle(wpt)
          const label = getName(wpt) || 'Waypoint'
          ds.entities.add({
            name: label,
            position: Cesium.Cartesian3.fromDegrees(lon, lat, ele > 0 ? ele : undefined),
            billboard: {
              image: '/cesium/marker.png',
              width: 24, height: 24,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            label: {
              text: label,
              font: '11px sans-serif',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -28),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          })
        })

        if (ds.entities.values.length === 0) {
          message.warning('No tracks, routes or waypoints found in GPX file')
          return
        }

        // Remove previous GPX layer if any
        if (gpxDataSourceRef.current) viewer.dataSources.remove(gpxDataSourceRef.current)
        viewer.dataSources.add(ds)
        gpxDataSourceRef.current = ds
        setGpxLoaded(true)
        setGpxName(file.name)
        viewer.zoomTo(ds)
        message.success(`GPX imported: ${ds.entities.values.length} features from ${file.name}`)
      } catch {
        message.error('Failed to parse GPX file')
      }
    }
    reader.readAsText(file)
    // Reset input so same file can be re-imported
    e.target.value = ''
  }, [])

  const handleLidarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const viewer = viewerRef.current
    if (!viewer) return
    e.target.value = ''

    setLidarUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post('/core/terrain/lidar-upload/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const { points, dem, point_count, min_lon, max_lon, min_lat, max_lat,
              min_elev, max_elev } = res.data

      // Remove previous LiDAR layer
      if (lidarPointsRef.current) viewer.scene.primitives.remove(lidarPointsRef.current)

      const collection = new Cesium.PointPrimitiveCollection()
      const xs: number[] = points.x
      const ys: number[] = points.y
      const zs: number[] = points.z
      const ints: number[] = points.i
      const elevRange = max_elev - min_elev || 1

      for (let idx = 0; idx < xs.length; idx++) {
        // Height-based colour: blue (low) → green → yellow → red (high)
        const t = (zs[idx] - min_elev) / elevRange
        const r = t < 0.5 ? 0 : Math.min(1, (t - 0.5) * 4)
        const g = t < 0.25 ? t * 4 : t < 0.75 ? 1 : (1 - t) * 4
        const b = t < 0.25 ? 1 : Math.max(0, 1 - t * 4)
        const bright = 0.5 + ints[idx] / 255 * 0.5
        collection.add({
          position: Cesium.Cartesian3.fromDegrees(xs[idx], ys[idx], zs[idx]),
          color: new Cesium.Color(r * bright, g * bright, b * bright, 1),
          pixelSize: 2,
        })
      }
      viewer.scene.primitives.add(collection)
      lidarPointsRef.current = collection

      // Fly to point cloud extent
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(min_lon, min_lat, max_lon, max_lat),
        duration: 1.5,
      })

      setLidarLoaded(true)
      setLidarName(file.name)
      message.success(`LiDAR: ${point_count.toLocaleString()} points loaded from ${file.name}`)

      // If DEM derived, load it as the slope grid for DEM analysis
      if (dem) {
        setSlopeGridData(dem)
        message.info('DEM derived from point cloud — DEM Analysis tools are now available')
      }
    } catch (err: any) {
      message.error(err?.response?.data?.error || 'LiDAR upload failed')
    } finally {
      setLidarUploading(false)
    }
  }, [])

  // ── Ad-hoc vector layer upload (shapefile/GeoJSON/KML/GPKG → drape on terrain) ──
  const handleVectorImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const viewer = viewerRef.current
    if (!file || !viewer) return
    e.target.value = ''
    setVectorUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await api.post('/core/terrain/vector-upload/', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const { geojson, bbox, feature_count, truncated } = res.data

      if (vectorDsRef.current) {
        viewer.dataSources.remove(vectorDsRef.current, true)
        vectorDsRef.current = null
      }
      const ds = await Cesium.GeoJsonDataSource.load(geojson, {
        clampToGround: true,
        stroke: Cesium.Color.fromCssColorString('#4fc3f7'),
        fill: Cesium.Color.fromCssColorString('#4fc3f7').withAlpha(0.25),
        strokeWidth: 2,
        markerColor: Cesium.Color.fromCssColorString('#4fc3f7'),
      })
      ds.name = 'uploaded-vector'
      await viewer.dataSources.add(ds)
      vectorDsRef.current = ds
      vectorBboxRef.current = bbox

      const [minLon, minLat, maxLon, maxLat] = bbox
      const padLon = Math.max((maxLon - minLon) * 0.3, 0.005)
      const padLat = Math.max((maxLat - minLat) * 0.3, 0.005)
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          Math.max(minLon - padLon, -180), Math.max(minLat - padLat, -90),
          Math.min(maxLon + padLon, 180), Math.min(maxLat + padLat, 90),
        ),
        duration: 1.5,
      })
      setVectorLoaded(true)
      setVectorName(file.name)
      message.success(
        `${feature_count} feature(s) loaded from ${file.name}` +
        `${truncated ? ' (truncated)' : ''} — press Analyze to run terrain analysis`,
      )
    } catch (err: any) {
      message.error(err?.response?.data?.error || 'Failed to load vector file')
    } finally {
      setVectorUploading(false)
    }
  }, [])

  // Run the slope/DEM analysis pipeline over the uploaded layer's extent —
  // fills slope statistics and enables every DEM Tools analysis.
  const analyzeVectorExtent = useCallback(async () => {
    const viewer = viewerRef.current
    const bbox = vectorBboxRef.current
    if (!viewer || !bbox) return
    const [minLon, minLat, maxLon, maxLat] = bbox
    setSlopeBuilding(true)
    setPanelOpen(true)
    try {
      const { stats, gridData } = await computeSlopeStats(
        viewer,
        Cesium.Cartesian3.fromDegrees(minLon, minLat),
        Cesium.Cartesian3.fromDegrees(maxLon, maxLat),
      )
      setSlopeStats(stats)
      setSlopeGridData(gridData)
      message.success('Analysis grid ready — slope statistics and DEM tools now cover the uploaded layer')
    } catch {
      message.error('Terrain analysis failed for this extent')
    } finally {
      setSlopeBuilding(false)
    }
  }, [])

  function flyToIndia() {
    viewerRef.current?.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(82, 20, 3200000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
      duration: 2,
    })
  }

  const terrainLabel =
    terrainCfg?.terrain_source === 'ion' ? 'Cesium ION' :
    terrainCfg?.terrain_source === 'local' ? 'Local Server' :
    autoArcGisTerrain ? 'ArcGIS Elevation' :
    'Ellipsoid (flat)'

  // ── Export helpers ──────────────────────────────────────────────────────────

  const composeScenePNG = useCallback(async (opts: {
    subtitle?: string
    legendTitle?: string
    legendItems?: { label: string; color?: string }[]
    statsTitle?: string
    statLines?: string[]
    filename: string
  }) => {
    const viewer = viewerRef.current
    if (!viewer) return
    setExporting(true)
    try {
      viewer.render()
      const src = viewer.scene.canvas
      const W = src.width, H = src.height
      const fs = Math.max(14, Math.round(W / 80))
      const rowH = Math.round(fs * 1.8)
      const pad = 12

      // Layout: title band ABOVE the scene, legend+stats band BELOW it —
      // panels never cover the basemap or the analysis overlay.
      const titleH = Math.round(fs * 4)
      const legendRows = opts.legendItems?.length ?? 0
      const statRows = opts.statLines?.length ?? 0
      const infoRows = Math.max(legendRows, statRows)
      const infoH = infoRows > 0 ? infoRows * rowH + Math.round(fs * 3.2) + pad : 0

      const out = document.createElement('canvas')
      out.width = W
      out.height = titleH + H + infoH
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('no 2d context')

      // ── Title band ───────────────────────────────────────────────
      ctx.fillStyle = '#0a0c1c'
      ctx.fillRect(0, 0, W, titleH)
      ctx.fillStyle = '#4fc3f7'
      ctx.font = `bold ${Math.round(fs * 1.15)}px sans-serif`
      ctx.fillText('RakshaGIS — Terrain Analysis', pad, Math.round(fs * 2))
      ctx.fillStyle = '#999'
      ctx.font = `${Math.round(fs * 0.82)}px sans-serif`
      const sub = opts.subtitle ? `  ·  ${opts.subtitle}` : ''
      ctx.fillText(`${new Date().toLocaleString()}  ·  ${terrainLabel}${sub}`, pad, Math.round(fs * 3.3))

      // ── 3D scene (unobstructed) ──────────────────────────────────
      ctx.drawImage(src, 0, titleH)

      // ── Point Elevation (top-right of the scene) ─────────────────
      if (clickedElev) {
        const elvLines = [
          `Lat : ${clickedElev.lat.toFixed(5)}°`,
          `Lon : ${clickedElev.lon.toFixed(5)}°`,
          `Elev: ${clickedElev.elev.toFixed(1)} m`,
        ]
        const eW = Math.round(fs * 16), eH = elvLines.length * rowH + Math.round(fs * 3.2)
        const eX = W - eW - pad, eY = titleH + pad
        ctx.fillStyle = 'rgba(10,12,28,0.85)'
        ctx.fillRect(eX, eY, eW, eH)
        ctx.fillStyle = '#4fc3f7'
        ctx.font = `bold ${Math.round(fs * 0.9)}px sans-serif`
        ctx.fillText('Point Elevation', eX + 10, eY + Math.round(fs * 1.6))
        elvLines.forEach((ln, i) => {
          ctx.fillStyle = '#ddd'
          ctx.font = `${Math.round(fs * 0.82)}px monospace`
          ctx.fillText(ln, eX + 10, eY + Math.round(fs * 2.9) + i * rowH)
        })
      }

      // ── North arrow (top-left of the scene) ──────────────────────
      const nax = 54, nay = titleH + 52
      ctx.strokeStyle = '#eee'; ctx.fillStyle = '#eee'; ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.moveTo(nax, nay + 30); ctx.lineTo(nax, nay); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(nax - 9, nay + 14); ctx.lineTo(nax, nay); ctx.lineTo(nax + 9, nay + 14)
      ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#bbb'; ctx.font = `bold ${Math.round(fs * 0.9)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('N', nax, nay + 46)
      ctx.textAlign = 'left'

      // ── Info band below the scene: legend (left) + stats (right) ─
      if (infoRows > 0) {
        const bandY = titleH + H
        ctx.fillStyle = '#0a0c1c'
        ctx.fillRect(0, bandY, W, infoH)

        if (opts.legendItems?.length) {
          const legendItems = opts.legendItems
          const legX = pad, legY = bandY + Math.round(pad / 2)
          ctx.fillStyle = '#4fc3f7'
          ctx.font = `bold ${Math.round(fs * 0.9)}px sans-serif`
          ctx.fillText(opts.legendTitle ?? 'Legend', legX + 10, legY + Math.round(fs * 1.6))
          legendItems.forEach((it, i) => {
            const iy = legY + Math.round(fs * 2.9) + i * rowH
            if (it.color) {
              ctx.fillStyle = it.color
              ctx.fillRect(legX + 10, iy - Math.round(fs * 0.95), Math.round(fs * 1.1), Math.round(fs * 1.1))
            }
            ctx.fillStyle = '#ddd'
            ctx.font = `${Math.round(fs * 0.82)}px monospace`
            ctx.fillText(it.label, legX + 10 + Math.round(fs * 1.5), iy)
          })
        }

        if (opts.statLines?.length) {
          const statLines = opts.statLines
          const stW = Math.round(fs * 0.62 * Math.max(
            (opts.statsTitle ?? '').length + 4,
            ...statLines.map(l => l.length + 3),
            26,
          ))
          const stX = W - stW - pad, stY = bandY + Math.round(pad / 2)
          ctx.fillStyle = '#4fc3f7'
          ctx.font = `bold ${Math.round(fs * 0.9)}px sans-serif`
          ctx.fillText(opts.statsTitle ?? 'Statistics', stX, stY + Math.round(fs * 1.6))
          statLines.forEach((ln, i) => {
            ctx.fillStyle = ln.startsWith('─') ? '#333' : '#ddd'
            ctx.font = `${Math.round(fs * 0.82)}px monospace`
            ctx.fillText(ln, stX, stY + Math.round(fs * 2.9) + i * rowH)
          })
        }
      }

      // ── Save (via C2PA/LP-DNA watermark service) ─────────────────
      const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/png'))
      if (!blob) { message.error('PNG capture failed'); return }
      await watermarkAndDownload(blob, opts.filename, 'image/png')
      message.success('PNG exported with provenance watermark')
    } catch {
      message.error('PNG export failed — canvas may be unavailable')
    } finally {
      setExporting(false)
    }
  }, [clickedElev, terrainLabel])

  const exportPNG = useCallback(async () => {
    const statLines = slopeStats ? [
      `Min  ${slopeStats.min.toFixed(1)}°`,
      `Avg  ${slopeStats.avg.toFixed(1)}°  (${
        slopeStats.avg < 5 ? 'Mostly flat'
        : slopeStats.avg < 15 ? 'Gentle slopes'
        : slopeStats.avg < 30 ? 'Moderate terrain' : 'Steep terrain'})`,
      `Max  ${slopeStats.max.toFixed(1)}°`,
      `Grid ${slopeStats.gridSize}×${slopeStats.gridSize} pts`,
      `─────────────────────`,
      `Flat      ${slopeStats.categories.flat.toFixed(1)}%`,
      `Gentle    ${slopeStats.categories.gentle.toFixed(1)}%`,
      `Moderate  ${slopeStats.categories.moderate.toFixed(1)}%`,
      `Steep     ${slopeStats.categories.steep.toFixed(1)}%`,
      `V.Steep   ${slopeStats.categories.verysteep.toFixed(1)}%`,
    ] : undefined
    await composeScenePNG({
      legendTitle: 'Slope Legend',
      legendItems: [
        { label: 'Flat      0–5°',   color: '#52c41a' },
        { label: 'Gentle   5–15°',   color: '#a0d911' },
        { label: 'Moderate 15–30°',  color: '#faad14' },
        { label: 'Steep    30–45°',  color: '#fa8c16' },
        { label: 'V.Steep  ≥45°',    color: '#ff4d4f' },
      ],
      statsTitle: 'Slope Statistics',
      statLines,
      filename: `rakshagis-terrain-${new Date().toISOString().slice(0, 10)}.png`,
    })
  }, [composeScenePNG, slopeStats])

  // Scene PNG for DEM Analysis tools — same layout, tool-specific legend/stats
  const demScenePNG = useCallback(async (
    toolLabel: string,
    legendItems: { label: string; color?: string }[],
    statLines: string[],
  ) => {
    const slug = toolLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await composeScenePNG({
      subtitle: toolLabel,
      legendTitle: `${toolLabel} Legend`,
      legendItems,
      statsTitle: `${toolLabel} Statistics`,
      statLines,
      filename: `rakshagis-dem-${slug}-${new Date().toISOString().slice(0, 10)}.png`,
    })
  }, [composeScenePNG])

  const exportPDF = useCallback(async () => {
    setExporting(true)
    try {
      const { jsPDF } = await import('jspdf')
      const viewer = viewerRef.current
      const W = 297, H = 210  // A4 landscape mm
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      const date = new Date().toLocaleString()
      let totalPages = 1
      if (profileData.length > 1) totalPages = 2

      // ── helper: page header ───────────────────────────────────────
      const drawHeader = (title: string, sub: string) => {
        pdf.setFillColor(10, 12, 28)
        pdf.rect(0, 0, W, 18, 'F')
        pdf.setTextColor(79, 195, 247)
        pdf.setFontSize(12)
        pdf.setFont('helvetica', 'bold')
        pdf.text(title, 10, 11)
        pdf.setFont('helvetica', 'normal')
        pdf.setTextColor(130, 130, 130)
        pdf.setFontSize(7)
        pdf.text(sub, 10, 17)
      }

      // ── helper: page footer ───────────────────────────────────────
      const drawFooter = (page: number) => {
        pdf.setFillColor(10, 12, 28)
        pdf.rect(0, H - 6, W, 6, 'F')
        pdf.setTextColor(80, 80, 80)
        pdf.setFontSize(6)
        pdf.setFont('helvetica', 'normal')
        pdf.text('RakshaGIS — Defence GIS Platform  ·  CONFIDENTIAL', 10, H - 1.5)
        pdf.text(`Page ${page} / ${totalPages}`, W - 10, H - 1.5, { align: 'right' })
      }

      // ════════════════════════════════════════════════════════════
      // PAGE 1: Map + Stats column + Legend strip
      // ════════════════════════════════════════════════════════════
      drawHeader('RakshaGIS — Terrain Analysis Report', `${date}   ·   Terrain: ${terrainLabel}`)

      // Map image (left column)
      const mapX = 10, mapY = 20, mapW = 172, mapH = 118
      if (viewer) {
        try {
          viewer.render()
          const img = viewer.scene.canvas.toDataURL('image/jpeg', 0.92)
          pdf.addImage(img, 'JPEG', mapX, mapY, mapW, mapH)
        } catch { /* tainted canvas */ }
      }
      pdf.setDrawColor(25, 40, 80); pdf.setLineWidth(0.3)
      pdf.rect(mapX, mapY, mapW, mapH)

      // Slope colour legend strip below map
      const legY2 = mapY + mapH + 2
      const legItems2 = [
        { l: 'Flat 0–5°',       r: 82,  g: 196, b: 26  },
        { l: 'Gentle 5–15°',    r: 160, g: 217, b: 17  },
        { l: 'Moderate 15–30°', r: 250, g: 173, b: 20  },
        { l: 'Steep 30–45°',    r: 250, g: 140, b: 22  },
        { l: 'V.Steep ≥45°',    r: 255, g: 77,  b: 79  },
      ]
      const lw2 = mapW / legItems2.length
      legItems2.forEach((it, i) => {
        pdf.setFillColor(it.r, it.g, it.b)
        pdf.rect(mapX + i * lw2, legY2, lw2, 3.5, 'F')
        pdf.setTextColor(200, 200, 200)
        pdf.setFontSize(5.5)
        pdf.setFont('helvetica', 'normal')
        pdf.text(it.l, mapX + i * lw2 + lw2 * 0.5, legY2 + 7.5, { align: 'center' })
      })

      // Right stats column
      const rx = 187, rw = W - rx - 5
      let ry = mapY

      // Stats box helper (draws box, returns next y)
      const sbox = (
        y: number, title: string, cr: number, cg: number, cb: number,
        rows: Array<{ l: string; v: string }>
      ) => {
        const rowH = 7, titleH = 9, bH = titleH + rows.length * rowH + 3
        pdf.setFillColor(13, 17, 40)
        pdf.rect(rx, y, rw, bH, 'F')
        pdf.setDrawColor(22, 35, 70); pdf.setLineWidth(0.15)
        pdf.rect(rx, y, rw, bH, 'S')
        pdf.setTextColor(cr, cg, cb)
        pdf.setFontSize(7.5); pdf.setFont('helvetica', 'bold')
        pdf.text(title, rx + 3, y + titleH - 1)
        rows.forEach((r, i) => {
          const ry2 = y + titleH + i * rowH + rowH - 1.5
          pdf.setTextColor(100, 105, 120); pdf.setFontSize(6); pdf.setFont('helvetica', 'normal')
          pdf.text(r.l, rx + 3, ry2)
          pdf.setTextColor(210, 215, 230); pdf.setFontSize(7); pdf.setFont('helvetica', 'bold')
          pdf.text(r.v, rx + rw - 3, ry2, { align: 'right' })
        })
        return y + bH + 2.5
      }

      if (clickedElev) {
        ry = sbox(ry, 'Point Elevation', 79, 195, 247, [
          { l: 'Latitude',  v: `${clickedElev.lat.toFixed(5)}°` },
          { l: 'Longitude', v: `${clickedElev.lon.toFixed(5)}°` },
          { l: 'Elevation', v: `${clickedElev.elev.toFixed(1)} m` },
        ])
      }

      if (profileData.length > 0) {
        const minE2 = Math.min(...profileData.map(d => d.elev))
        const maxE2 = Math.max(...profileData.map(d => d.elev))
        const lenKm2 = ((profileData[profileData.length - 1]?.dist ?? 0) / 1000)
        ry = sbox(ry, 'Elevation Profile', 82, 196, 26, [
          { l: 'Length',       v: `${lenKm2.toFixed(2)} km` },
          { l: 'Start elev',   v: `${profileData[0].elev.toFixed(1)} m` },
          { l: 'End elev',     v: `${profileData[profileData.length-1].elev.toFixed(1)} m` },
          { l: 'Highest',      v: `${maxE2.toFixed(1)} m` },
          { l: 'Lowest',       v: `${minE2.toFixed(1)} m` },
          { l: 'Relief',       v: `${(maxE2 - minE2).toFixed(1)} m` },
        ])
      }

      if (slopeStats) {
        const desc2 = slopeStats.avg < 5 ? 'Mostly flat'
          : slopeStats.avg < 15 ? 'Gentle' : slopeStats.avg < 30 ? 'Moderate' : 'Steep'
        ry = sbox(ry, 'Slope Analysis', 250, 173, 20, [
          { l: 'Min slope', v: `${slopeStats.min.toFixed(1)}°` },
          { l: 'Avg slope', v: `${slopeStats.avg.toFixed(1)}° — ${desc2}` },
          { l: 'Max slope', v: `${slopeStats.max.toFixed(1)}°` },
          { l: 'Grid',      v: `${slopeStats.gridSize}×${slopeStats.gridSize}` },
        ])

        // Category breakdown bars
        const cats2 = [
          { l: 'Flat 0–5°',       p: slopeStats.categories.flat,      r: 82,  g: 196, b: 26  },
          { l: 'Gentle 5–15°',    p: slopeStats.categories.gentle,     r: 160, g: 217, b: 17  },
          { l: 'Moderate 15–30°', p: slopeStats.categories.moderate,   r: 250, g: 173, b: 20  },
          { l: 'Steep 30–45°',    p: slopeStats.categories.steep,      r: 250, g: 140, b: 22  },
          { l: 'V.Steep ≥45°',    p: slopeStats.categories.verysteep,  r: 255, g: 77,  b: 79  },
        ]
        const cbH = cats2.length * 9.5 + 11
        pdf.setFillColor(13, 17, 40)
        pdf.rect(rx, ry, rw, cbH, 'F')
        pdf.setDrawColor(22, 35, 70); pdf.setLineWidth(0.15)
        pdf.rect(rx, ry, rw, cbH, 'S')
        pdf.setTextColor(79, 195, 247); pdf.setFontSize(7.5); pdf.setFont('helvetica', 'bold')
        pdf.text('Category Breakdown', rx + 3, ry + 8)
        let cy2 = ry + 11
        cats2.forEach(c => {
          pdf.setTextColor(145, 150, 160); pdf.setFontSize(6); pdf.setFont('helvetica', 'normal')
          pdf.text(c.l, rx + 3, cy2 + 4.5)
          pdf.setTextColor(c.r, c.g, c.b)
          pdf.text(`${c.p.toFixed(1)}%`, rx + rw - 3, cy2 + 4.5, { align: 'right' })
          pdf.setFillColor(18, 28, 55)
          pdf.rect(rx + 3, cy2 + 6, rw - 6, 2.5, 'F')
          if (c.p > 0) {
            pdf.setFillColor(c.r, c.g, c.b)
            pdf.rect(rx + 3, cy2 + 6, (rw - 6) * c.p / 100, 2.5, 'F')
          }
          cy2 += 9.5
        })
      }

      drawFooter(1)

      // ════════════════════════════════════════════════════════════
      // PAGE 2: Elevation Profile Chart (if data available)
      // ════════════════════════════════════════════════════════════
      if (profileData.length > 1) {
        pdf.addPage()
        drawHeader('RakshaGIS — Elevation Profile Chart',
          `${date}   ·   ${profileData.length} sample points   ·   ${terrainLabel}`)

        // Chart dimensions
        const cx = 22, cyt = 24, cw = 256, ch = 110
        const minE3 = Math.min(...profileData.map(d => d.elev))
        const maxE3 = Math.max(...profileData.map(d => d.elev))
        const eRange3 = maxE3 - minE3 || 1
        const maxDist3 = Math.max(profileData[profileData.length - 1]?.dist ?? 1, 1)
        const ePad3 = eRange3 * 0.12
        const eMin3 = minE3 - ePad3, eMax3 = maxE3 + ePad3
        const eSpan3 = eMax3 - eMin3

        // Chart background
        pdf.setFillColor(10, 13, 32)
        pdf.rect(cx, cyt, cw, ch, 'F')
        pdf.setDrawColor(22, 35, 70); pdf.setLineWidth(0.3)
        pdf.rect(cx, cyt, cw, ch)

        // Horizontal grid lines + Y labels
        const gridN3 = 5
        for (let i = 0; i <= gridN3; i++) {
          const gy3 = cyt + ch - (i / gridN3) * ch
          const ev3 = eMin3 + (i / gridN3) * eSpan3
          pdf.setDrawColor(20, 32, 65); pdf.setLineWidth(0.18)
          pdf.line(cx, gy3, cx + cw, gy3)
          pdf.setTextColor(80, 95, 118); pdf.setFontSize(5.5); pdf.setFont('helvetica', 'normal')
          pdf.text(`${ev3.toFixed(0)}m`, cx - 1.5, gy3 + 1.5, { align: 'right' })
        }

        // Vertical grid lines + X labels
        const xTicks = 6
        for (let i = 0; i <= xTicks; i++) {
          const gx3 = cx + (i / xTicks) * cw
          const dv3 = (i / xTicks) * maxDist3 / 1000
          pdf.setDrawColor(20, 32, 65); pdf.setLineWidth(0.18)
          pdf.line(gx3, cyt, gx3, cyt + ch)
          pdf.setTextColor(80, 95, 118); pdf.setFontSize(5.5)
          pdf.text(`${dv3.toFixed(dv3 < 10 ? 1 : 0)}km`, gx3, cyt + ch + 4.5, { align: 'center' })
        }

        // Axis labels
        pdf.setTextColor(120, 130, 150); pdf.setFontSize(6.5); pdf.setFont('helvetica', 'normal')
        pdf.text('Distance', cx + cw / 2, cyt + ch + 10, { align: 'center' })
        pdf.text('Elevation (m)', 4, cyt + ch / 2, { angle: 90 })

        // Profile polyline — coloured by elevation (green=low → red=high)
        pdf.setLineWidth(0.75)
        for (let i = 1; i < profileData.length; i++) {
          const p0 = profileData[i - 1], p1 = profileData[i]
          const px0 = cx + (p0.dist / maxDist3) * cw
          const py0 = cyt + ch - ((p0.elev - eMin3) / eSpan3) * ch
          const px1 = cx + (p1.dist / maxDist3) * cw
          const py1 = cyt + ch - ((p1.elev - eMin3) / eSpan3) * ch
          const ratio3 = Math.min(((p0.elev + p1.elev) / 2 - minE3) / eRange3, 1)
          const r3 = Math.round(82  + ratio3 * (255 - 82))
          const g3 = Math.round(196 - ratio3 * (196 - 55))
          const b3 = Math.round(26  + ratio3 * (79  - 26))
          pdf.setDrawColor(r3, g3, b3)
          pdf.line(px0, py0, px1, py1)
        }

        // Peak (▲) and valley (▼) markers
        const peakPt = profileData.reduce((a, b) => a.elev > b.elev ? a : b)
        const valPt  = profileData.reduce((a, b) => a.elev < b.elev ? a : b)
        const peakX = cx + (peakPt.dist / maxDist3) * cw
        const peakY = cyt + ch - ((peakPt.elev - eMin3) / eSpan3) * ch
        const valX  = cx + (valPt.dist / maxDist3) * cw
        const valY  = cyt + ch - ((valPt.elev - eMin3) / eSpan3) * ch

        pdf.setFillColor(255, 77, 79)
        pdf.circle(peakX, peakY, 2, 'F')
        pdf.setTextColor(255, 120, 120); pdf.setFontSize(6); pdf.setFont('helvetica', 'bold')
        pdf.text(`▲ ${peakPt.elev.toFixed(0)} m`, peakX + 3, peakY - 1)

        pdf.setFillColor(82, 196, 26)
        pdf.circle(valX, valY, 2, 'F')
        pdf.setTextColor(100, 220, 60); pdf.setFontSize(6)
        pdf.text(`▼ ${valPt.elev.toFixed(0)} m`, valX + 3, valY + 4.5)

        // Stats table below chart
        const sbY = cyt + ch + 17
        const statItems = [
          { l: 'Profile length',  v: `${(maxDist3 / 1000).toFixed(2)} km` },
          { l: 'Start elevation', v: `${profileData[0].elev.toFixed(1)} m` },
          { l: 'End elevation',   v: `${profileData[profileData.length-1].elev.toFixed(1)} m` },
          { l: 'Highest point',   v: `${maxE3.toFixed(1)} m` },
          { l: 'Lowest point',    v: `${minE3.toFixed(1)} m` },
          { l: 'Total relief',    v: `${(maxE3 - minE3).toFixed(1)} m` },
          { l: 'Sample points',   v: `${profileData.length}` },
          { l: 'Terrain',         v: terrainLabel },
        ]
        pdf.setFillColor(10, 13, 32)
        pdf.rect(cx, sbY, cw, 34, 'F')
        const cols3 = 4, colW3 = cw / cols3
        statItems.forEach((s, i) => {
          const scx = cx + (i % cols3) * colW3 + 4
          const scy = sbY + Math.floor(i / cols3) * 15 + 8
          pdf.setTextColor(80, 95, 115); pdf.setFontSize(6); pdf.setFont('helvetica', 'normal')
          pdf.text(s.l, scx, scy)
          pdf.setTextColor(205, 215, 230); pdf.setFontSize(8); pdf.setFont('helvetica', 'bold')
          pdf.text(s.v, scx, scy + 7)
        })

        drawFooter(2)
      }

      await watermarkAndDownload(
        pdf.output('blob'),
        `rakshagis-terrain-${new Date().toISOString().slice(0, 10)}.pdf`,
        'application/pdf',
      )
      message.success('PDF exported with provenance watermark')
    } catch (e) {
      console.error(e)
      message.error('PDF export failed')
    } finally {
      setExporting(false)
    }
  }, [clickedElev, profileData, slopeStats, terrainLabel])

  const exportProfileCSV = useCallback(async () => {
    if (!profileData.length) return
    const rows = ['point,distance_m,latitude_deg,longitude_deg,elevation_m']
    profileData.forEach((p, i) =>
      rows.push(`${i + 1},${p.dist.toFixed(1)},${p.lat.toFixed(6)},${p.lon.toFixed(6)},${p.elev.toFixed(2)}`)
    )
    try {
      await watermarkAndDownload(
        rows.join('\n'),
        `elevation-profile-${new Date().toISOString().slice(0, 10)}.csv`,
        'text/csv',
      )
      message.success('CSV exported with provenance watermark')
    } catch {
      message.error('CSV export failed — watermark service unavailable')
    }
  }, [profileData])

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

        <Tooltip title="DEM analysis tools: contours, viewshed, flood, landslide risk, watershed…">
          <Button
            size="small"
            icon={<RadarChartOutlined />}
            type={panelOpen && panelTab === 'dem' ? 'primary' : 'default'}
            onClick={() => { setPanelOpen(true); setPanelTab('dem') }}
            disabled={!ready}
          >
            DEM Tools
          </Button>
        </Tooltip>

        <Tooltip title={gpxLoaded ? `GPX loaded: ${gpxName} — click to replace` : 'Import GPX track/route/waypoints onto 3D globe'}>
          <Button
            size="small"
            icon={<UploadOutlined />}
            type={gpxLoaded ? 'primary' : 'default'}
            onClick={() => gpxFileInputRef.current?.click()}
            disabled={!ready}
          >
            GPX
          </Button>
        </Tooltip>
        <input
          ref={gpxFileInputRef}
          type="file"
          accept=".gpx"
          style={{ display: 'none' }}
          onChange={handleGpxImport}
        />

        <Tooltip title={vectorLoaded
          ? `Layer: ${vectorName} — click to replace`
          : 'Upload shapefile (.zip), GeoJSON, KML/KMZ or GPKG and drape it on the 3D terrain'}>
          <Button
            size="small"
            icon={<UploadOutlined />}
            type={vectorLoaded ? 'primary' : 'default'}
            loading={vectorUploading}
            onClick={() => vectorFileInputRef.current?.click()}
            disabled={!ready}
          >
            Vector
          </Button>
        </Tooltip>
        <input
          ref={vectorFileInputRef}
          type="file"
          accept=".zip,.geojson,.json,.kml,.kmz,.gpkg"
          style={{ display: 'none' }}
          onChange={handleVectorImport}
        />
        {vectorLoaded && (
          <Tooltip title="Sample the terrain across the uploaded layer's extent — enables slope statistics and all DEM analysis tools">
            <Button size="small" type="primary" ghost onClick={analyzeVectorExtent} disabled={!ready}>
              Analyze
            </Button>
          </Tooltip>
        )}

        <Tooltip title={lidarLoaded ? `LiDAR: ${lidarName} — click to reload` : 'Upload .las / .laz point cloud — displays in 3D and derives DEM'}>
          <Button
            size="small"
            icon={<UploadOutlined />}
            type={lidarLoaded ? 'primary' : 'default'}
            loading={lidarUploading}
            onClick={() => lidarFileInputRef.current?.click()}
            disabled={!ready}
          >
            LiDAR
          </Button>
        </Tooltip>
        <input
          ref={lidarFileInputRef}
          type="file"
          accept=".las,.laz"
          style={{ display: 'none' }}
          onChange={handleLidarUpload}
        />

        <Tooltip title={referenceGrid
          ? 'Reference DEM set — used by Change Detection analysis'
          : 'Set current slope grid as reference DEM for Change Detection'}>
          <Button
            size="small"
            type={referenceGrid ? 'primary' : 'default'}
            style={referenceGrid ? { borderColor: '#a855f7', background: '#a855f722' } : {}}
            onClick={() => {
              if (slopeGridData) {
                setReferenceGrid(slopeGridData)
                message.success('Reference DEM saved — load a new GeoTIFF to compare')
              } else {
                message.warning('Run slope analysis first to generate a DEM grid')
              }
            }}
            disabled={!ready}
          >
            {referenceGrid ? 'Ref Set' : 'Set Ref'}
          </Button>
        </Tooltip>

        <Tooltip title={splitMode ? 'Exit comparison mode' : 'Split-screen compare two basemaps side-by-side'}>
          <Button
            size="small"
            icon={<SplitCellsOutlined />}
            type={splitMode ? 'primary' : 'default'}
            onClick={() => {
              if (splitMode) {
                setSplitMode(false)
                setSplitRightId(null)
                setSplitPos(0.5)
              } else {
                setSplitMode(true)
              }
            }}
            disabled={!ready}
          >
            Compare
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

        <Tooltip title="Terrain vertical exaggeration — increase to make hills and mountains appear more dramatic">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#888', fontSize: 11 }}>Exag</span>
            <Slider
              min={1} max={5} step={0.5} value={terrainExaggeration}
              onChange={setTerrainExaggeration}
              style={{ width: 70 }}
              tooltip={{ formatter: (v) => `${v}×` }}
            />
          </div>
        </Tooltip>

        <Button size="small" icon={<ReloadOutlined />} onClick={clearAll} disabled={!ready} danger>
          Clear
        </Button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tag
            color={autoArcGisTerrain ? 'green' : arcgisTerrainLoading ? 'processing' : terrainCfg?.terrain_source === 'none' ? 'default' : 'blue'}
            icon={arcgisTerrainLoading ? <SyncOutlined spin /> : undefined}
          >
            Terrain: {arcgisTerrainLoading ? 'Loading ArcGIS…' : terrainLabel}
          </Tag>
          {!ready && <Spin size="small" />}
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
        {/* Cesium container */}
        <div ref={containerRef} style={{ flex: 1, height: '100%' }} />

        {/* ── Comparison slider overlay ── */}
        {splitMode && (
          <div
            style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${splitPos * 100}%`,
              width: 4, background: 'rgba(255,255,255,0.85)',
              cursor: 'ew-resize', zIndex: 20,
              boxShadow: '0 0 6px rgba(0,0,0,0.6)',
              transform: 'translateX(-2px)',
            }}
            onMouseDown={e => {
              e.preventDefault()
              splitDragging.current = true
              const onMove = (me: MouseEvent) => {
                if (!splitDragging.current) return
                const container = containerRef.current
                if (!container) return
                const rect = container.getBoundingClientRect()
                const frac = Math.max(0.05, Math.min(0.95, (me.clientX - rect.left) / rect.width))
                setSplitPos(frac)
                const viewer = viewerRef.current
                if (viewer) viewer.scene.splitPosition = frac
              }
              const onUp = () => {
                splitDragging.current = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
          >
            {/* Drag handle icon */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%,-50%)',
              background: 'white', borderRadius: 12,
              padding: '4px 6px', fontSize: 12, color: '#333',
              pointerEvents: 'none', whiteSpace: 'nowrap', lineHeight: 1,
            }}>
              ◀ ▶
            </div>
          </div>
        )}

        {/* Comparison right-side basemap selector (bottom-center) */}
        {splitMode && (
          <div style={{
            position: 'absolute', bottom: 48, left: `${splitPos * 100 + 2}%`,
            background: 'rgba(10,12,28,0.9)', border: '1px solid #2a2a4a',
            borderRadius: 6, padding: '4px 8px', zIndex: 20,
            maxWidth: 200,
          }}>
            <div style={{ color: '#888', fontSize: 9, marginBottom: 2 }}>RIGHT SIDE</div>
            <select
              value={splitRightId ?? ''}
              onChange={e => setSplitRightId(e.target.value ? Number(e.target.value) : null)}
              style={{
                background: '#0a0c1c', color: '#e0e0e0', border: '1px solid #2a2a4a',
                borderRadius: 4, fontSize: 11, padding: '2px 4px', width: '100%',
              }}
            >
              <option value="">— none —</option>
              {(basemaps as any[]).filter((b: any) => b.id !== selectedBasemap).map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}

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
            position: 'absolute', top: 8, right: 8, width: 360, maxHeight: 'calc(100% - 16px)',
            overflowY: 'auto', overflowX: 'hidden',
            background: 'rgba(13,13,31,0.97)', border: '1px solid #1a1a2e',
            borderRadius: 8, padding: 12, backdropFilter: 'blur(4px)',
          }}>
            {/* Panel header with tabs */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 2 }}>
                <button
                  onClick={() => setPanelTab('analysis')}
                  style={{
                    background: panelTab === 'analysis' ? 'rgba(79,195,247,0.15)' : 'transparent',
                    border: `1px solid ${panelTab === 'analysis' ? '#4fc3f7' : '#2a2a3e'}`,
                    borderRadius: 4, padding: '2px 10px', cursor: 'pointer',
                    color: panelTab === 'analysis' ? '#4fc3f7' : '#666', fontSize: 11, fontWeight: 600,
                  }}
                >Analysis</button>
                <button
                  onClick={() => setPanelTab('dem')}
                  style={{
                    background: panelTab === 'dem' ? 'rgba(250,140,22,0.15)' : 'transparent',
                    border: `1px solid ${panelTab === 'dem' ? '#fa8c16' : '#2a2a3e'}`,
                    borderRadius: 4, padding: '2px 10px', cursor: 'pointer',
                    color: panelTab === 'dem' ? '#fa8c16' : '#666', fontSize: 11, fontWeight: 600,
                  }}
                >DEM Tools</button>
              </div>
              <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setPanelOpen(false)} />
            </div>

            {/* DEM Analysis panel */}
            {panelTab === 'dem' && (
              <DEMAnalysisPanel
                gridData={slopeGridData}
                referenceGrid={referenceGrid}
                onOverlay={handleDemOverlay}
                onClearOverlays={handleClearDemOverlays}
                onScenePNG={demScenePNG}
              />
            )}

            {/* Analysis tab content */}
            {panelTab === 'analysis' && (<>

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
                    <Spin size="small" /> <Text style={{ color: '#888', fontSize: 11 }}> Sampling {Math.pow(50,2)} points…</Text>
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
                    <SlopeCategoryBar categories={slopeStats.categories} />
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
                </div>
              </>
            )}

            {/* Terrain info */}
            <Divider style={{ margin: '8px 0', borderColor: '#1a1a2e' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#666' }}>
              <InfoCircleOutlined />
              <span>
                Terrain: <strong style={{ color: autoArcGisTerrain ? '#52c41a' : '#888' }}>{terrainLabel}</strong>
                {terrainCfg?.terrain_source === 'none' && !autoArcGisTerrain && (
                  <> — flat (no elevation data). Select an ArcGIS basemap or set up a terrain server.</>
                )}
              </span>
            </div>
            </>)}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Elevation fallback (Open-Elevation via Django proxy) ─────────────────────
// Used when local terrain tiles are unavailable (EllipsoidTerrainProvider).

async function apiElevation(locs: { lat: number; lon: number }[]): Promise<number[]> {
  try {
    const res = await api.post('/core/elevation/', { locations: locs })
    const results: any[] = res.data?.results ?? []
    // Always return exactly locs.length values — a short/partial server
    // response would make the analysis grid invalid ("Invalid grid data")
    return locs.map((_, i) => results[i]?.elevation ?? 0)
  } catch {
    return locs.map(() => 0)
  }
}

function hasRealTerrain(viewer: Cesium.Viewer): boolean {
  // EllipsoidTerrainProvider is the only "flat" provider — anything else has real elevation.
  // Checking .availability was wrong: ArcGISTiledElevationTerrainProvider has no .availability.
  return !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)
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

  let elevs: number[]
  if (hasRealTerrain(viewer)) {
    const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions)
    elevs = sampled.map(c => (c as Cesium.Cartographic).height ?? 0)
  } else {
    elevs = await apiElevation(positions.map(c => ({
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    })))
  }

  return positions.map((c, i) => ({
    dist: geoDist[i],
    elev: elevs[i] ?? 0,
    lat: Cesium.Math.toDegrees(c.latitude),
    lon: Cesium.Math.toDegrees(c.longitude),
  }))
}

async function computeSlopeStats(
  viewer: Cesium.Viewer,
  corner1: Cesium.Cartesian3,
  corner2: Cesium.Cartesian3,
  gridN = 50,
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

  // Raw elevation grid for GeoTIFF export (degrees bbox)
  let elevGrid: number[]
  if (hasRealTerrain(viewer)) {
    const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions)
    elevGrid = sampled.map(c => (c as Cesium.Cartographic).height ?? 0)
  } else {
    elevGrid = await apiElevation(positions.map(c => ({
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    })))
  }
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

  const total = slopes.length || 1
  const pct = (fn: (s: number) => boolean) =>
    parseFloat((slopes.filter(fn).length / total * 100).toFixed(1))
  const categories: SlopeCategories = {
    flat:      pct(s => s < 5),
    gentle:    pct(s => s >= 5  && s < 15),
    moderate:  pct(s => s >= 15 && s < 30),
    steep:     pct(s => s >= 30 && s < 45),
    verysteep: pct(s => s >= 45),
  }

  const stats: SlopeStats = slopes.length
    ? {
        min: Math.min(...slopes),
        max: Math.max(...slopes),
        avg: slopes.reduce((a, b) => a + b, 0) / slopes.length,
        gridSize: gridN,
        categories,
      }
    : { min: 0, max: 0, avg: 0, gridSize: gridN, categories: { flat: 0, gentle: 0, moderate: 0, steep: 0, verysteep: 0 } }

  return { stats, gridData: { elevGrid, bbox, gridN } }
}

function SlopeCategoryBar({ categories }: { categories: SlopeCategories }) {
  const rows = [
    { label: 'Flat (0-5°)',      pct: categories.flat,      color: '#52c41a' },
    { label: 'Gentle (5-15°)',   pct: categories.gentle,    color: '#a0d911' },
    { label: 'Moderate (15-30°)', pct: categories.moderate, color: '#faad14' },
    { label: 'Steep (30-45°)',   pct: categories.steep,     color: '#fa8c16' },
    { label: 'V.Steep (≥45°)',   pct: categories.verysteep, color: '#ff4d4f' },
  ]
  return (
    <div style={{ marginTop: 8 }}>
      <Text style={{ color: '#888', fontSize: 10 }}>Area breakdown by slope class</Text>
      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
            <span style={{ color: '#aaa', width: 110, flexShrink: 0 }}>{r.label}</span>
            <div style={{ flex: 1, background: '#1a1a2e', borderRadius: 2, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${r.pct}%`, height: '100%', background: r.color, transition: 'width 0.4s' }} />
            </div>
            <span style={{ color: r.color, width: 36, textAlign: 'right', fontWeight: 600 }}>{r.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
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
