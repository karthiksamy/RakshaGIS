import { useRef, useEffect, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorTileLayer from 'ol/layer/VectorTile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import OSM from 'ol/source/OSM'
import XYZ from 'ol/source/XYZ'
import VectorTileSource from 'ol/source/VectorTile'
import MVT from 'ol/format/MVT'
import { fromLonLat } from 'ol/proj'
import { toStringXY } from 'ol/coordinate'
import { defaults as defaultControls, ScaleLine } from 'ol/control'
import Draw from 'ol/interaction/Draw'
import Select from 'ol/interaction/Select'
import { click } from 'ol/events/condition'
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style'
import { Tooltip, Button, Select as AntSelect, Space, Drawer, Descriptions, Tag } from 'antd'
import {
  DragOutlined, AimOutlined, EditOutlined,
  RadiusSettingOutlined, ColumnHeightOutlined,
  ZoomInOutlined, ZoomOutOutlined, GlobalOutlined,
  BarsOutlined,
} from '@ant-design/icons'
import { useAppStore } from '@/app/store'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { BasemapConfig, SurveyProject } from '@/types'
import 'ol/ol.css'

const INDIA_CENTER = fromLonLat([78.9629, 22.5937])

const TOOL_BUTTONS = [
  { key: 'pan', icon: <DragOutlined />, label: 'Pan' },
  { key: 'identify', icon: <AimOutlined />, label: 'Identify' },
  { key: 'draw_point', icon: <RadiusSettingOutlined />, label: 'Draw Point' },
  { key: 'draw_line', icon: <ColumnHeightOutlined />, label: 'Draw Line' },
  { key: 'draw_polygon', icon: <EditOutlined />, label: 'Draw Polygon' },
]

function makeBasemapSource(bm: BasemapConfig | null) {
  if (!bm || bm.provider === 'OSM') return new OSM()
  return new XYZ({ url: bm.url_template, crossOrigin: 'anonymous' })
}

function featureStyle(color: string) {
  return new Style({
    fill: new Fill({ color: color + '33' }),
    stroke: new Stroke({ color, width: 2 }),
    image: new CircleStyle({
      radius: 5,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: '#fff', width: 1 }),
    }),
  })
}

export default function MapPage() {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<Map | null>(null)
  const basemapLayer = useRef<TileLayer<OSM | XYZ> | null>(null)
  const projectLayer = useRef<VectorLayer<VectorSource> | null>(null)
  const drawInteraction = useRef<Draw | null>(null)

  const { mapTool, setMapTool, activeBasemap, setActiveBasemap, mapCoords, setMapCoords } = useAppStore()
  const [featureInfo, setFeatureInfo] = useState<Record<string, unknown> | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)

  const { data: basemaps } = useQuery<BasemapConfig[]>({
    queryKey: qk.basemaps(),
    queryFn: () => api.get('/gis/basemaps/').then((r) => r.data.results ?? r.data),
  })

  const { data: projects } = useQuery<{ results: SurveyProject[] }>({
    queryKey: qk.projects(),
    queryFn: () => api.get('/projects/').then((r) => r.data),
  })

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return

    const bm = new TileLayer({ source: new OSM(), zIndex: 0 })
    basemapLayer.current = bm

    // Admin boundary tiles from pg_tileserv
    const boundaryLayer = new VectorTileLayer({
      source: new VectorTileSource({
        format: new MVT(),
        url: '/tiles/public.gis_layers_district/{z}/{x}/{y}.pbf',
        maxZoom: 14,
      }),
      style: new Style({
        stroke: new Stroke({ color: '#4fc3f799', width: 1 }),
      }),
      zIndex: 1,
    })

    // Project features layer
    const src = new VectorSource()
    const vl = new VectorLayer({
      source: src,
      style: featureStyle('#00bcd4'),
      zIndex: 2,
    })
    projectLayer.current = vl

    const select = new Select({
      condition: click,
      layers: [vl],
      style: featureStyle('#ff9800'),
    })
    select.on('select', (e) => {
      if (e.selected.length > 0) {
        const props = e.selected[0].getProperties()
        setFeatureInfo(props)
        setDrawerOpen(true)
      }
    })

    const map = new Map({
      target: mapRef.current,
      layers: [bm, boundaryLayer, vl],
      view: new View({ center: INDIA_CENTER, zoom: 5 }),
      controls: defaultControls({ zoom: false }).extend([
        new ScaleLine({ units: 'metric' }),
      ]),
    })
    map.addInteraction(select)

    map.on('pointermove', (e) => {
      const lonLat = e.coordinate as [number, number]
      setMapCoords(lonLat)
    })

    mapInstance.current = map
    return () => {
      map.setTarget(undefined)
      mapInstance.current = null
    }
  }, [])

  // Update basemap when activeBasemap changes
  useEffect(() => {
    if (!basemapLayer.current) return
    basemapLayer.current.setSource(makeBasemapSource(activeBasemap))
  }, [activeBasemap])

  // Set default basemap once list loads
  useEffect(() => {
    if (basemaps && basemaps.length > 0 && !activeBasemap) {
      setActiveBasemap(basemaps[0])
    }
  }, [basemaps])

  // Handle tool changes
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return

    if (drawInteraction.current) {
      map.removeInteraction(drawInteraction.current)
      drawInteraction.current = null
    }

    const drawType =
      mapTool === 'draw_point' ? 'Point'
      : mapTool === 'draw_line' ? 'LineString'
      : mapTool === 'draw_polygon' ? 'Polygon'
      : null

    if (drawType && projectLayer.current) {
      const draw = new Draw({
        source: projectLayer.current.getSource()!,
        type: drawType as 'Point' | 'LineString' | 'Polygon',
      })
      map.addInteraction(draw)
      drawInteraction.current = draw
    }
  }, [mapTool])

  const handleZoom = useCallback((delta: number) => {
    const view = mapInstance.current?.getView()
    if (view) view.setZoom((view.getZoom() ?? 5) + delta)
  }, [])

  const formatCoords = () => {
    if (!mapCoords) return ''
    return toStringXY(mapCoords, 4)
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Map canvas */}
      <div ref={mapRef} className="ol-map" />

      {/* Floating toolbar */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          zIndex: 20,
        }}
      >
        {TOOL_BUTTONS.map((t) => (
          <Tooltip key={t.key} title={t.label} placement="right">
            <Button
              type={mapTool === t.key ? 'primary' : 'default'}
              icon={t.icon}
              size="small"
              onClick={() => setMapTool(t.key as any)}
              style={{
                background: mapTool === t.key ? '#1565c0' : 'rgba(20,20,30,0.85)',
                border: '1px solid #333',
                color: '#ddd',
                width: 32,
                height: 32,
              }}
            />
          </Tooltip>
        ))}

        <div style={{ height: 8 }} />

        <Tooltip title="Zoom in" placement="right">
          <Button
            icon={<ZoomInOutlined />}
            size="small"
            onClick={() => handleZoom(1)}
            style={{ background: 'rgba(20,20,30,0.85)', border: '1px solid #333', color: '#ddd', width: 32, height: 32 }}
          />
        </Tooltip>
        <Tooltip title="Zoom out" placement="right">
          <Button
            icon={<ZoomOutOutlined />}
            size="small"
            onClick={() => handleZoom(-1)}
            style={{ background: 'rgba(20,20,30,0.85)', border: '1px solid #333', color: '#ddd', width: 32, height: 32 }}
          />
        </Tooltip>
        <Tooltip title="Zoom to India" placement="right">
          <Button
            icon={<GlobalOutlined />}
            size="small"
            onClick={() => {
              const view = mapInstance.current?.getView()
              view?.animate({ center: INDIA_CENTER, zoom: 5, duration: 500 })
            }}
            style={{ background: 'rgba(20,20,30,0.85)', border: '1px solid #333', color: '#ddd', width: 32, height: 32 }}
          />
        </Tooltip>
      </div>

      {/* Basemap selector + layer toggle */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 20,
        }}
      >
        <AntSelect
          size="small"
          style={{ width: 160 }}
          placeholder="Basemap"
          value={activeBasemap?.id}
          onChange={(id) => {
            const bm = basemaps?.find((b) => b.id === id) ?? null
            setActiveBasemap(bm)
          }}
          options={basemaps?.map((b) => ({ label: b.name, value: b.id }))}
        />
        <Tooltip title="Layers" placement="left">
          <Button
            icon={<BarsOutlined />}
            size="small"
            onClick={() => setLayerPanelOpen(true)}
            style={{ background: 'rgba(20,20,30,0.85)', border: '1px solid #333', color: '#ddd', alignSelf: 'flex-end' }}
          />
        </Tooltip>
      </div>

      {/* Coordinate display */}
      {mapCoords && (
        <div className="map-coords">{formatCoords()}</div>
      )}

      {/* Feature info drawer */}
      <Drawer
        title="Feature Info"
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={320}
        styles={{ body: { background: '#0e0e1e' }, header: { background: '#0e0e1e', borderBottom: '1px solid #222' } }}
      >
        {featureInfo && (
          <Descriptions column={1} size="small">
            {Object.entries(featureInfo)
              .filter(([k]) => k !== 'geometry')
              .map(([k, v]) => (
                <Descriptions.Item key={k} label={<span style={{ color: '#aaa', fontSize: 12 }}>{k}</span>}>
                  <span style={{ color: '#e8e8e8', fontSize: 12 }}>{String(v ?? '')}</span>
                </Descriptions.Item>
              ))}
          </Descriptions>
        )}
      </Drawer>

      {/* Layer panel drawer */}
      <Drawer
        title="Layers"
        placement="right"
        open={layerPanelOpen}
        onClose={() => setLayerPanelOpen(false)}
        width={260}
        styles={{ body: { background: '#0e0e1e' }, header: { background: '#0e0e1e', borderBottom: '1px solid #222' } }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {[
            { label: 'District Boundaries', color: '#4fc3f7' },
            { label: 'Project Features', color: '#00bcd4' },
          ].map((l) => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 14, height: 14, background: l.color, borderRadius: 2, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: '#ccc' }}>{l.label}</span>
            </div>
          ))}

          <div style={{ marginTop: 16, borderTop: '1px solid #222', paddingTop: 12 }}>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>PROJECTS</div>
            {projects?.results?.map((p) => (
              <div key={p.id} style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: '#ddd' }}>{p.name}</span>
                <Tag
                  style={{ fontSize: 10, lineHeight: '16px', height: 16 }}
                  color={p.status === 'PUBLISHED' ? 'green' : p.status === 'DRAFT' ? 'default' : 'blue'}
                >
                  {p.status}
                </Tag>
              </div>
            ))}
          </div>
        </Space>
      </Drawer>
    </div>
  )
}
