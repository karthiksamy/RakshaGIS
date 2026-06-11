import { useCallback, useEffect, useRef, useState } from 'react'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import OSM from 'ol/source/OSM'
import GeoJSON from 'ol/format/GeoJSON'
import Feature from 'ol/Feature'
import OLPoint from 'ol/geom/Point'
import { fromLonLat, toLonLat } from 'ol/proj'
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style'
import {
  Alert, Badge, Button, Card, Form, Input, Modal, Select, Space, Tag,
  Typography, message,
} from 'antd'
import {
  AimOutlined, CloudDownloadOutlined, CloudSyncOutlined, EnvironmentOutlined,
  PlusCircleOutlined, WifiOutlined, DisconnectOutlined, DeleteOutlined,
} from '@ant-design/icons'
import api from '@/services/api'
import {
  cacheProject, getCachedProject, listCachedProjects, removeCachedProject,
  queueFeature, getOutbox, removeFromOutbox,
  type CachedProject, type OutboxFeature,
} from '@/utils/offlineStore'

const { Title, Text } = Typography

const featureStyle = new Style({
  fill: new Fill({ color: 'rgba(79,195,247,0.15)' }),
  stroke: new Stroke({ color: '#4fc3f7', width: 1.5 }),
  image: new CircleStyle({ radius: 5, fill: new Fill({ color: '#4fc3f7' }) }),
})
const pendingStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: '#faad14' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})
const gpsStyle = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: 'rgba(82,196,26,0.9)' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
})

/** Offline-first field companion for surveyors in remote defence estates. */
export default function FieldCompanionPage() {
  const mapDivRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const cachedSrcRef = useRef(new VectorSource())
  const pendingSrcRef = useRef(new VectorSource())
  const gpsSrcRef = useRef(new VectorSource())

  const [online, setOnline] = useState(navigator.onLine)
  const [projects, setProjects] = useState<{ id: number; name: string; project_number: string }[]>([])
  const [cached, setCached] = useState<CachedProject[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [outbox, setOutbox] = useState<OutboxFeature[]>([])
  const [caching, setCaching] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [addMode, setAddMode] = useState(false)
  const addModeRef = useRef(false)
  const [noteModal, setNoteModal] = useState<{ lon: number; lat: number } | null>(null)
  const [noteForm] = Form.useForm()

  const refreshLocal = useCallback(async () => {
    setCached(await listCachedProjects())
    setOutbox(await getOutbox())
  }, [])

  // ── map init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return
    const map = new Map({
      target: mapDivRef.current,
      layers: [
        new TileLayer({ source: new OSM() }),
        new VectorLayer({ source: cachedSrcRef.current, style: featureStyle }),
        new VectorLayer({ source: pendingSrcRef.current, style: pendingStyle }),
        new VectorLayer({ source: gpsSrcRef.current, style: gpsStyle }),
      ],
      view: new View({ center: fromLonLat([78.9, 21.0]), zoom: 5 }),
    })
    map.on('singleclick', (evt) => {
      if (!addModeRef.current) return
      const [lon, lat] = toLonLat(evt.coordinate)
      setNoteModal({ lon, lat })
    })
    mapRef.current = map
    return () => { map.setTarget(undefined); mapRef.current = null }
  }, [])

  const syncNow = useCallback(async () => {
    if (!navigator.onLine) { message.warning('Still offline'); return }
    setSyncing(true)
    let ok = 0, fail = 0
    try {
      const pending = await getOutbox()
      for (const item of pending) {
        try {
          await api.post('/projects/features/', item.payload)
          await removeFromOutbox(item.outbox_id)
          ok++
        } catch {
          fail++
        }
      }
    } finally {
      await refreshLocal()
      setSyncing(false)
      if (ok) message.success(`Synced ${ok} feature(s) to the server`)
      if (fail) message.error(`${fail} feature(s) failed to sync — kept in outbox`)
    }
  }, [refreshLocal])

  // ── online/offline tracking + auto-sync ─────────────────────────────────────
  useEffect(() => {
    const goOnline = () => { setOnline(true); syncNow() }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [syncNow])

  // ── initial data ────────────────────────────────────────────────────────────
  useEffect(() => {
    refreshLocal()
    if (navigator.onLine) {
      api.get('/projects/?page_size=200')
        .then(r => setProjects((r.data.results ?? r.data).map((p: any) =>
          ({ id: p.id, name: p.name, project_number: p.project_number }))))
        .catch(() => { /* offline or error — cached list is enough */ })
    }
  }, [refreshLocal])

  // ── render active project + outbox on the map ──────────────────────────────
  useEffect(() => {
    cachedSrcRef.current.clear()
    pendingSrcRef.current.clear()
    if (!activeId) return
    getCachedProject(activeId).then(cp => {
      if (!cp) return
      const fmt = new GeoJSON({ featureProjection: 'EPSG:3857' })
      cp.features.forEach((f: any) => {
        if (!f.geometry) return
        try {
          const olf = fmt.readFeature({ type: 'Feature', geometry: f.geometry, properties: f.attributes ?? {} })
          cachedSrcRef.current.addFeature(olf as Feature)
        } catch { /* skip unparsable geometry */ }
      })
      const extent = cachedSrcRef.current.getExtent()
      if (extent[0] !== Infinity) {
        mapRef.current?.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 17, duration: 600 })
      }
    })
    outbox.filter(o => o.payload.project === activeId).forEach(o => {
      pendingSrcRef.current.addFeature(new Feature(
        new OLPoint(fromLonLat(o.payload.geometry.coordinates))))
    })
  }, [activeId, outbox])

  // ── actions ─────────────────────────────────────────────────────────────────
  async function downloadProject(pid: number) {
    setCaching(true)
    try {
      const proj = projects.find(p => p.id === pid)
      const feats = await api.get(`/projects/features/?project=${pid}`).then(r => r.data.results ?? r.data)
      await cacheProject({
        id: pid,
        name: proj?.name ?? `Project ${pid}`,
        project_number: proj?.project_number ?? '',
        cached_at: new Date().toISOString(),
        features: feats,
      })
      await refreshLocal()
      setActiveId(pid)
      message.success(`Cached ${feats.length} features for offline use`)
    } catch {
      message.error('Failed to cache project — check connection')
    } finally {
      setCaching(false)
    }
  }

  function locateMe() {
    if (!navigator.geolocation) { message.error('Geolocation not available'); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coord = fromLonLat([pos.coords.longitude, pos.coords.latitude])
        gpsSrcRef.current.clear()
        gpsSrcRef.current.addFeature(new Feature(new OLPoint(coord)))
        mapRef.current?.getView().animate({ center: coord, zoom: 17, duration: 600 })
      },
      () => message.error('Could not get GPS position'),
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  async function saveNote(values: { name: string; note: string }) {
    if (!noteModal || !activeId) return
    const f: OutboxFeature = {
      outbox_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      payload: {
        project: activeId,
        layer_name: 'Field Notes',
        geometry_type: 'POINT',
        geometry: { type: 'Point', coordinates: [noteModal.lon, noteModal.lat] },
        attributes: {
          name: values.name,
          note: values.note ?? '',
          captured_at: new Date().toISOString(),
          source: 'field-companion',
        },
      },
    }
    await queueFeature(f)
    await refreshLocal()
    setNoteModal(null)
    noteForm.resetFields()
    message.success(online ? 'Saved — press Sync to upload' : 'Saved offline — will sync when back in coverage')
  }

  const activeCached = cached.find(c => c.id === activeId)
  const pendingCount = outbox.length

  return (
    <div style={{ display: 'flex', height: '100%', background: '#050510' }}>
      {/* Side panel */}
      <div style={{ width: 320, padding: 16, overflowY: 'auto', borderRight: '1px solid #1a1a2e' }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <Title level={5} style={{ color: '#4fc3f7', margin: 0 }}>
              <EnvironmentOutlined /> Field Companion
            </Title>
            {online
              ? <Tag icon={<WifiOutlined />} color="green">Online</Tag>
              : <Tag icon={<DisconnectOutlined />} color="red">Offline</Tag>}
          </Space>

          <Alert
            type="info" showIcon style={{ fontSize: 11, padding: '4px 8px' }}
            message="Cache a project while in coverage. In the field: mark your GPS position, add point notes — they queue locally and sync automatically when back online."
          />

          {online && (
            <Card size="small" title={<span style={{ fontSize: 12 }}>Cache a project</span>}
              styles={{ body: { padding: 10 } }}>
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  size="small" showSearch style={{ flex: 1 }} placeholder="Select project"
                  filterOption={(i, o) => String(o?.label ?? '').toLowerCase().includes(i.toLowerCase())}
                  options={projects.map(p => ({ value: p.id, label: `${p.project_number} — ${p.name}` }))}
                  onSelect={(v: number) => downloadProject(v)}
                />
                <Button size="small" icon={<CloudDownloadOutlined />} loading={caching} />
              </Space.Compact>
            </Card>
          )}

          <Card size="small" title={<span style={{ fontSize: 12 }}>Cached projects ({cached.length})</span>}
            styles={{ body: { padding: 8 } }}>
            {cached.length === 0 && <Text style={{ color: '#555', fontSize: 11 }}>Nothing cached yet</Text>}
            {cached.map(c => (
              <div key={c.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '4px 6px', borderRadius: 4, cursor: 'pointer', marginBottom: 2,
                  background: activeId === c.id ? 'rgba(79,195,247,0.12)' : 'transparent',
                  border: `1px solid ${activeId === c.id ? '#4fc3f7' : 'transparent'}`,
                }}
                onClick={() => setActiveId(c.id)}>
                <div>
                  <div style={{ color: '#e0e0e0', fontSize: 12 }}>{c.project_number || c.name}</div>
                  <div style={{ color: '#555', fontSize: 10 }}>
                    {c.features.length} features · {new Date(c.cached_at).toLocaleDateString()}
                  </div>
                </div>
                <Button size="small" type="text" danger icon={<DeleteOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeCachedProject(c.id).then(refreshLocal)
                    if (activeId === c.id) setActiveId(null)
                  }} />
              </div>
            ))}
          </Card>

          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Button block icon={<AimOutlined />} onClick={locateMe}>My GPS Location</Button>
            <Button
              block type={addMode ? 'primary' : 'default'} icon={<PlusCircleOutlined />}
              disabled={!activeId}
              onClick={() => { addModeRef.current = !addMode; setAddMode(!addMode) }}>
              {addMode ? 'Tap map to place note…' : 'Add Point / Note'}
            </Button>
            <Badge count={pendingCount} size="small" offset={[-6, 6]} style={{ background: '#faad14' }}>
              <Button block icon={<CloudSyncOutlined />} loading={syncing}
                disabled={!online || pendingCount === 0} onClick={syncNow}>
                Sync {pendingCount > 0 ? `(${pendingCount} pending)` : ''}
              </Button>
            </Badge>
          </Space>

          {activeCached && (
            <Text style={{ color: '#555', fontSize: 10 }}>
              Viewing: {activeCached.name} — cached {new Date(activeCached.cached_at).toLocaleString()}
            </Text>
          )}
        </Space>
      </div>

      {/* Map */}
      <div ref={mapDivRef} style={{ flex: 1 }} />

      {/* New note modal */}
      <Modal
        title="New Field Note"
        open={!!noteModal}
        onCancel={() => setNoteModal(null)}
        onOk={() => noteForm.submit()}
        okText="Save"
        destroyOnClose
      >
        {noteModal && (
          <Form form={noteForm} layout="vertical" onFinish={saveNote} style={{ marginTop: 8 }}>
            <Text style={{ color: '#888', fontSize: 11 }}>
              {noteModal.lat.toFixed(6)}°N, {noteModal.lon.toFixed(6)}°E
            </Text>
            <Form.Item name="name" label="Name" rules={[{ required: true }]} style={{ marginTop: 8 }}>
              <Input placeholder="e.g. Boundary stone BS-14" maxLength={120} />
            </Form.Item>
            <Form.Item name="note" label="Note">
              <Input.TextArea rows={3} placeholder="Observations…" maxLength={2000} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  )
}
