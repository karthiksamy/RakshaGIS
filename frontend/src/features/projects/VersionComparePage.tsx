import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Select, Space, Typography, Spin } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import OSM from 'ol/source/OSM'
import GeoJSON from 'ol/format/GeoJSON'
import { Style, Stroke, Fill } from 'ol/style'
import { fromLonLat } from 'ol/proj'
import 'ol/ol.css'
import api from '@/services/api'
import type { ProjectLayerFolder, SurveyProject } from '@/types'

const { Title } = Typography

const STYLE_A = new Style({
  stroke: new Stroke({ color: '#2196f3', width: 2 }),
  fill: new Fill({ color: 'rgba(33,150,243,0.15)' }),
})
const STYLE_B = new Style({
  stroke: new Stroke({ color: '#ff9800', width: 2 }),
  fill: new Fill({ color: 'rgba(255,152,0,0.15)' }),
})

function buildFlatFolders(items: any[]): ProjectLayerFolder[] {
  return items.map((f) => ({ ...f, children: [] }))
}

function MapPanel({
  containerId,
  view,
  folderId,
}: {
  containerId: string
  view: View
  folderId: number | null
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<Map | null>(null)
  const vectorLayer = useRef<VectorLayer<VectorSource> | null>(null)

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return
    const vl = new VectorLayer({
      source: new VectorSource(),
      style: containerId === 'map-a' ? STYLE_A : STYLE_B,
    })
    vectorLayer.current = vl
    mapInstance.current = new Map({
      target: mapRef.current,
      view,
      layers: [new TileLayer({ source: new OSM() }), vl],
    })
    return () => mapInstance.current?.setTarget(undefined)
  }, [])

  useEffect(() => {
    if (!folderId || !vectorLayer.current) return
    const src = vectorLayer.current.getSource()!
    src.clear()
    api.get(`/projects/features/?folder=${folderId}&is_deleted=false`).then((res) => {
      const features = res.data.results ?? res.data.features ?? []
      if (features.length === 0) return
      const fmt = new GeoJSON()
      const fc = { type: 'FeatureCollection', features }
      const parsed = fmt.readFeatures(fc, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })
      src.addFeatures(parsed)
    })
  }, [folderId])

  return (
    <div
      ref={mapRef}
      id={containerId}
      style={{ flex: 1, height: '100%', border: '1px solid #1a1a2e' }}
    />
  )
}

export default function VersionComparePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const pid = Number(id)

  const [folderA, setFolderA] = useState<number | null>(null)
  const [folderB, setFolderB] = useState<number | null>(null)

  // Shared view so both maps pan/zoom together
  const sharedView = useRef(
    new View({
      center: fromLonLat([80.27, 13.08]),
      zoom: 10,
    })
  )

  const { data: project } = useQuery<SurveyProject>({
    queryKey: ['project', pid],
    queryFn: () => api.get(`/projects/${pid}/`).then((r) => r.data),
  })

  const { data: folders = [] } = useQuery<ProjectLayerFolder[]>({
    queryKey: ['folders-flat', pid],
    queryFn: () =>
      api.get(`/projects/folders/?project=${pid}`).then((r) => buildFlatFolders(r.data.results ?? r.data)),
  })

  const versionFolders = folders.filter((f) => f.folder_type === 'VERSION')
  const versionOptions = versionFolders.map((f) => ({
    value: f.id,
    label: f.is_final ? `${f.name} (Final)` : f.name,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header bar */}
      <div
        style={{
          padding: '8px 16px',
          background: '#0a0a1a',
          borderBottom: '1px solid #1a1a2e',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate(`/projects/${pid}`)} />
        <Title level={5} style={{ margin: 0, color: '#e8e8e8', fontSize: 13 }}>
          {project?.name} — Version Compare
        </Title>
        <div style={{ flex: 1 }} />
        <Space>
          <span style={{ color: '#2196f3', fontSize: 12, fontWeight: 600 }}>Version A:</span>
          <Select
            style={{ width: 160 }}
            size="small"
            options={versionOptions}
            value={folderA}
            onChange={setFolderA}
            placeholder="Select version"
            allowClear
          />
          <span style={{ color: '#ff9800', fontSize: 12, fontWeight: 600 }}>Version B:</span>
          <Select
            style={{ width: 160 }}
            size="small"
            options={versionOptions}
            value={folderB}
            onChange={setFolderB}
            placeholder="Select version"
            allowClear
          />
        </Space>
      </div>

      {/* Legend */}
      <div
        style={{
          padding: '4px 16px',
          background: '#0e0e1e',
          borderBottom: '1px solid #1a1a2e',
          display: 'flex',
          gap: 24,
          fontSize: 11,
          color: '#aaa',
          flexShrink: 0,
        }}
      >
        <span>
          <span style={{ display: 'inline-block', width: 16, height: 3, background: '#2196f3', marginRight: 4, verticalAlign: 'middle' }} />
          Version A
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 16, height: 3, background: '#ff9800', marginRight: 4, verticalAlign: 'middle' }} />
          Version B
        </span>
        <span style={{ marginLeft: 'auto' }}>Pan/Zoom is synchronized between both maps</span>
      </div>

      {/* Two maps side by side */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <MapPanel containerId="map-a" view={sharedView.current} folderId={folderA} />
        <MapPanel containerId="map-b" view={sharedView.current} folderId={folderB} />
      </div>
    </div>
  )
}
