import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Button, Space, Table, Input, Tag, Modal, Form, Select as AntSelect,
  Radio, message, Spin, Tooltip, Typography, Segmented, Alert,
} from 'antd'
import {
  ArrowLeftOutlined, SaveOutlined, BorderOuterOutlined, NodeIndexOutlined,
  ScissorOutlined, MergeCellsOutlined, PlusOutlined, DeleteOutlined, AimOutlined,
  DragOutlined, UndoOutlined, RedoOutlined,
} from '@ant-design/icons'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import OSM from 'ol/source/OSM'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import WebGLTileLayer from 'ol/layer/WebGLTile'
import GeoTIFFSource from 'ol/source/GeoTIFF'
import GeoJSON from 'ol/format/GeoJSON'
import MultiPoint from 'ol/geom/MultiPoint'
import Draw from 'ol/interaction/Draw'
import Modify from 'ol/interaction/Modify'
import Translate from 'ol/interaction/Translate'
import Snap from 'ol/interaction/Snap'
import DragBox from 'ol/interaction/DragBox'
import { defaults as defaultInteractions } from 'ol/interaction/defaults'
import { shiftKeyOnly } from 'ol/events/condition'
import { Style, Fill, Stroke, Circle as CircleStyle, Text as OLText } from 'ol/style'
import { getArea } from 'ol/sphere'
import * as turf from '@turf/turf'
import 'ol/ol.css'
import api from '@/services/api'

const { Text } = Typography

type Tool = 'select' | 'vertex' | 'move' | 'split' | 'add'

interface FeatureRow { id: number; survey_number: string; area_ha: number; feature_type: string }

const fmt = new GeoJSON()
const PROJ = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' } as const
const MAX_HISTORY = 60

// Collect all vertices of a geometry as a MultiPoint (for the vertex overlay).
function verticesOf(geom: any): MultiPoint | null {
  if (!geom) return null
  const t = geom.getType()
  if (t === 'Polygon') return new MultiPoint((geom.getCoordinates() as number[][][]).flat())
  if (t === 'MultiPolygon') return new MultiPoint((geom.getCoordinates() as number[][][][]).flat(2))
  if (t === 'LineString') return new MultiPoint(geom.getCoordinates() as number[][])
  if (t === 'MultiLineString') return new MultiPoint((geom.getCoordinates() as number[][][]).flat())
  return null
}

export default function BoundaryReviewPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()

  const mapDivRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const srcRef = useRef<VectorSource | null>(null)
  const scratchRef = useRef<VectorSource | null>(null)   // split line drawing
  const cogRef = useRef<WebGLTileLayer | null>(null)
  const modifyRef = useRef<Modify | null>(null)
  const drawRef = useRef<Draw | null>(null)
  const translateRef = useRef<Translate | null>(null)
  const snapRef = useRef<Snap | null>(null)
  const idCounter = useRef(0)
  const selectedIdsRef = useRef<Set<number>>(new Set())
  const toolRef = useRef<Tool>('select')

  // Undo/redo history — snapshots of the vector source as GeoJSON strings.
  const undoStackRef = useRef<string[]>([])
  const redoStackRef = useRef<string[]>([])
  const arrowBurstRef = useRef(false)   // coalesce a held-arrow nudge into one undo step

  const [tool, setTool] = useState<Tool>('select')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [rows, setRows] = useState<FeatureRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [areaMode, setAreaMode] = useState<'existing' | 'new'>('existing')
  const [saving, setSaving] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [saveForm] = Form.useForm()

  useEffect(() => { selectedIdsRef.current = new Set(selectedIds); srcRef.current?.changed() }, [selectedIds])
  useEffect(() => { toolRef.current = tool }, [tool])

  // ── Job (draft features + source GeoTIFF) ──────────────────────────────────
  const { data: job, isLoading } = useQuery<any>({
    queryKey: ['extraction-job-review', jobId],
    queryFn: () => api.get(`/ai/vision/status/${jobId}/`).then(r => r.data),
    enabled: !!jobId,
  })

  const { data: surveyAreas = [] } = useQuery<any[]>({
    queryKey: ['review-survey-areas', job?.project_id],
    queryFn: () => api.get('/projects/survey-areas/', { params: { project: job.project_id, page_size: 200 } })
      .then(r => r.data.results ?? r.data),
    enabled: !!job?.project_id && saveOpen,
  })

  // ── Sync the side-panel rows from the vector source ─────────────────────────
  const syncRows = useCallback(() => {
    const src = srcRef.current
    if (!src) return
    setRows(src.getFeatures().map(f => ({
      id: f.getId() as number,
      survey_number: (f.get('survey_number') ?? '') as string,
      area_ha: getArea(f.getGeometry()!) / 10000,
      feature_type: (f.get('feature_type') ?? 'parcel') as string,
    })))
  }, [])

  // ── Undo/redo machinery ─────────────────────────────────────────────────────
  const serialize = useCallback(() => {
    const src = srcRef.current
    return src ? fmt.writeFeatures(src.getFeatures(), PROJ) : ''
  }, [])

  const refreshHistoryFlags = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0)
    setCanRedo(redoStackRef.current.length > 0)
  }, [])

  // Capture the CURRENT state before a mutation. Clears the redo stack.
  const snapshot = useCallback(() => {
    const s = serialize()
    undoStackRef.current.push(s)
    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift()
    redoStackRef.current = []
    refreshHistoryFlags()
  }, [serialize, refreshHistoryFlags])

  const restore = useCallback((snap: string) => {
    const src = srcRef.current
    if (!src) return
    src.clear()
    if (snap) {
      const feats = fmt.readFeatures(snap, PROJ)   // ids + properties round-trip
      src.addFeatures(feats)
    }
    // Keep the id counter ahead of any restored ids so new features never collide.
    let maxId = idCounter.current
    src.getFeatures().forEach(f => { const id = f.getId(); if (typeof id === 'number' && id > maxId) maxId = id })
    idCounter.current = maxId
    // Drop selections that no longer exist.
    setSelectedIds(prev => prev.filter(id => src.getFeatureById(id)))
    syncRows()
  }, [syncRows])

  const undo = useCallback(() => {
    if (!undoStackRef.current.length) return
    redoStackRef.current.push(serialize())
    restore(undoStackRef.current.pop() as string)
    refreshHistoryFlags()
  }, [serialize, restore, refreshHistoryFlags])

  const redo = useCallback(() => {
    if (!redoStackRef.current.length) return
    undoStackRef.current.push(serialize())
    restore(redoStackRef.current.pop() as string)
    refreshHistoryFlags()
  }, [serialize, restore, refreshHistoryFlags])

  // ── Map init (basemap + editable vector layer) ──────────────────────────────
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return
    const src = new VectorSource()
    srcRef.current = src
    const scratch = new VectorSource()
    scratchRef.current = scratch

    const vector = new VectorLayer({
      source: src,
      zIndex: 10,
      style: (feature) => {
        const sel = selectedIdsRef.current.has(feature.getId() as number)
        const sn = (feature.get('survey_number') ?? '') as string
        const base = new Style({
          fill: new Fill({ color: sel ? 'rgba(82,196,26,0.35)' : 'rgba(24,144,255,0.18)' }),
          stroke: new Stroke({ color: sel ? '#52c41a' : '#1890ff', width: sel ? 3 : 1.6 }),
          text: new OLText({
            text: sn || '',
            font: '12px sans-serif',
            fill: new Fill({ color: '#fff' }),
            stroke: new Stroke({ color: '#000', width: 2 }),
            overflow: true,
          }),
        })
        if (!sel) return base
        // Draw the selected feature's vertices so the Vertex tool is discoverable.
        const vts = verticesOf(feature.getGeometry())
        if (!vts) return base
        return [base, new Style({
          geometry: vts,
          image: new CircleStyle({
            radius: 4, fill: new Fill({ color: '#52c41a' }),
            stroke: new Stroke({ color: '#fff', width: 1 }),
          }),
        })]
      },
    })
    const scratchLayer = new VectorLayer({
      source: scratch, zIndex: 20,
      style: new Style({ stroke: new Stroke({ color: '#fa541c', width: 2, lineDash: [6, 4] }) }),
    })

    const map = new Map({
      target: mapDivRef.current,
      layers: [new TileLayer({ source: new OSM(), zIndex: 0 }), vector, scratchLayer],
      view: new View({ center: [8600000, 2500000], zoom: 5 }),
      // Disable the default shift+drag zoom box so shift+drag is free for box-select.
      interactions: defaultInteractions({ shiftDragZoom: false }),
    })
    mapRef.current = map

    // Click: select (shift to toggle/multi-select) — only in the Select tool.
    map.on('singleclick', (e) => {
      if (toolRef.current !== 'select') return
      let hitId: number | null = null
      map.forEachFeatureAtPixel(e.pixel, (f) => {
        if (f.getId() != null) { hitId = f.getId() as number; return true }
      }, { layerFilter: (l) => l === vector })
      const shift = (e.originalEvent as MouseEvent).shiftKey
      setSelectedIds(prev => {
        if (hitId == null) return shift ? prev : []
        if (shift) return prev.includes(hitId) ? prev.filter(x => x !== hitId) : [...prev, hitId]
        return [hitId]
      })
    })

    // Shift+drag box-select (additive) — available in every tool.
    const dragBox = new DragBox({ condition: shiftKeyOnly })
    dragBox.on('boxend', () => {
      const ext = dragBox.getGeometry().getExtent()
      const hits: number[] = []
      src.forEachFeatureIntersectingExtent(ext, (f) => {
        const id = f.getId()
        if (id != null) hits.push(id as number)
      })
      setSelectedIds(prev => Array.from(new Set([...prev, ...hits])))
    })
    map.addInteraction(dragBox)

    return () => { map.setTarget(undefined); mapRef.current = null }
  }, [])

  // ── Load features + COG when the job arrives ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current, src = srcRef.current
    if (!map || !src || !job || loaded) return
    if (job.status !== 'DONE') return

    const feats = (job.draft_features || []).filter((f: any) => f?.geometry)
    const olFeats = fmt.readFeatures({ type: 'FeatureCollection', features: feats }, PROJ)
    olFeats.forEach(f => { f.setId(++idCounter.current) })
    src.addFeatures(olFeats)

    // GeoTIFF overlay for visual context (same source the main viewer uses).
    const cogUrl = job.source_geotiff?.cog_url
    if (cogUrl && !cogRef.current) {
      try {
        const cog = new WebGLTileLayer({
          source: new GeoTIFFSource({ sources: [{ url: cogUrl }] }),
          opacity: 0.85, zIndex: 1,
        })
        map.addLayer(cog)
        cogRef.current = cog
      } catch { /* COG optional */ }
    }

    if (src.getFeatures().length) {
      const ext = src.getExtent()
      if (ext && ext[0] !== Infinity) map.getView().fit(ext, { padding: [60, 60, 60, 60], maxZoom: 19, duration: 400 })
    }
    // Reset history for the freshly-loaded dataset.
    undoStackRef.current = []
    redoStackRef.current = []
    refreshHistoryFlags()
    syncRows()
    setLoaded(true)
  }, [job, loaded, syncRows, refreshHistoryFlags])

  // ── Tool wiring (edit interactions + snapping) ──────────────────────────────
  useEffect(() => {
    const map = mapRef.current, src = srcRef.current, scratch = scratchRef.current
    if (!map || !src || !scratch) return
    // Tear down previous interactions
    for (const ref of [modifyRef, drawRef, translateRef, snapRef]) {
      if (ref.current) { map.removeInteraction(ref.current as any); ref.current = null }
    }
    scratch.clear()

    if (tool === 'vertex') {
      // Modify = QGIS/ArcGIS vertex tool: drag a vertex to move it, click-drag a segment
      // to insert a vertex, Alt+click a vertex to delete it (OL Modify defaults).
      const modify = new Modify({ source: src })
      modify.on('modifystart', () => snapshot())
      modify.on('modifyend', () => syncRows())
      map.addInteraction(modify)
      modifyRef.current = modify
    } else if (tool === 'move') {
      // Translate = drag a whole feature. Snapshot once per drag for undo.
      const translate = new Translate({ layers: [(map.getLayers().getArray()[1] as VectorLayer<any>)] })
      translate.on('translatestart', () => snapshot())
      translate.on('translateend', (e) => {
        const f = e.features.item(0)
        if (f?.getId() != null) setSelectedIds([f.getId() as number])
        syncRows()
      })
      map.addInteraction(translate)
      translateRef.current = translate
    } else if (tool === 'add') {
      const draw = new Draw({ source: src, type: 'Polygon' })
      draw.on('drawstart', () => snapshot())
      draw.on('drawend', (e) => {
        e.feature.setId(++idCounter.current)
        e.feature.set('survey_number', '')
        e.feature.set('feature_type', 'parcel')
        setTimeout(() => { syncRows(); setSelectedIds([e.feature.getId() as number]) }, 0)
      })
      map.addInteraction(draw)
      drawRef.current = draw
    } else if (tool === 'split') {
      const draw = new Draw({ source: scratch, type: 'LineString' })
      draw.on('drawend', (e) => {
        const line = e.feature
        setTimeout(() => { scratch.clear(); doSplit(line) }, 0)
      })
      map.addInteraction(draw)
      drawRef.current = draw
    }

    // Snapping is helpful for every editing tool (topologically clean edits).
    if (tool !== 'select') {
      const snap = new Snap({ source: src })
      map.addInteraction(snap)
      snapRef.current = snap
    }
  }, [tool, syncRows, snapshot])

  // ── Keyboard: undo/redo, delete, deselect, arrow-key nudge ──────────────────
  useEffect(() => {
    const nudge = (key: string, big: boolean) => {
      const map = mapRef.current, src = srcRef.current
      if (!map || !src || !selectedIdsRef.current.size) return
      const res = map.getView().getResolution() ?? 1
      const step = res * (big ? 10 : 2)   // move by ~2px (or 10px with Shift)
      let dx = 0, dy = 0
      if (key === 'ArrowLeft') dx = -step
      else if (key === 'ArrowRight') dx = step
      else if (key === 'ArrowUp') dy = step
      else if (key === 'ArrowDown') dy = -step
      if (!arrowBurstRef.current) { snapshot(); arrowBurstRef.current = true }
      selectedIdsRef.current.forEach(id => {
        srcRef.current?.getFeatureById(id)?.getGeometry()?.translate(dx, dy)
      })
      src.changed()
      syncRows()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement)?.isContentEditable) return
      const meta = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (meta && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if (meta && (k === 'y')) { e.preventDefault(); redo(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIdsRef.current.size) { e.preventDefault(); deleteSelected() }
        return
      }
      if (e.key === 'Escape') { setSelectedIds([]); return }
      if (e.key.startsWith('Arrow') && selectedIdsRef.current.size) {
        e.preventDefault(); nudge(e.key, e.shiftKey)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.startsWith('Arrow')) arrowBurstRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, snapshot, syncRows])

  // ── Geometry edits ──────────────────────────────────────────────────────────
  function doSplit(olLine: any) {
    const src = srcRef.current!
    // Target = single selected polygon, else the first polygon the line crosses.
    const selIds = [...selectedIdsRef.current]
    let target = selIds.length === 1 ? src.getFeatureById(selIds[0]) : null
    const lineGeo = JSON.parse(fmt.writeFeature(olLine, PROJ))
    if (!target) {
      target = src.getFeatures().find(f => {
        try {
          const poly = JSON.parse(fmt.writeFeature(f, PROJ))
          return turf.booleanIntersects(lineGeo, poly)
        } catch { return false }
      }) || null
    }
    if (!target) { message.warning('Draw the split line across a polygon (or select one first)'); return }
    try {
      const poly = JSON.parse(fmt.writeFeature(target, PROJ))
      const cutter = turf.buffer(lineGeo, 0.0000006, { units: 'degrees' })
      const diff = cutter ? turf.difference(turf.featureCollection([poly, cutter])) : null
      const parts = diff ? turf.flatten(diff).features : []
      if (parts.length < 2) { message.warning('The line must fully cross the polygon to split it'); return }
      snapshot()
      const sn = target.get('survey_number') ?? ''
      src.removeFeature(target)
      parts.forEach(p => {
        const nf = fmt.readFeature(p, PROJ) as any
        nf.setId(++idCounter.current)
        nf.set('survey_number', sn)   // both halves inherit; user edits afterwards
        nf.set('feature_type', 'parcel')
        src.addFeature(nf)
      })
      message.success(`Split into ${parts.length} polygons`)
      setSelectedIds([]); syncRows()
    } catch { message.error('Split failed') }
  }

  function mergeSelected() {
    const src = srcRef.current!
    if (selectedIds.length < 2) { message.warning('Select 2+ polygons (shift-click) to merge'); return }
    try {
      const olFeats = selectedIds.map(id => src.getFeatureById(id)).filter(Boolean) as any[]
      const polys = olFeats.map(f => JSON.parse(fmt.writeFeature(f, PROJ)))
      let acc = polys[0]
      for (let i = 1; i < polys.length; i++) acc = turf.union(turf.featureCollection([acc, polys[i]]))
      if (!acc) { message.error('Merge produced no geometry'); return }
      snapshot()
      const sn = (olFeats.map(f => f.get('survey_number')).find(Boolean)) ?? ''
      olFeats.forEach(f => src.removeFeature(f))
      const merged = fmt.readFeature(acc, PROJ) as any
      merged.setId(++idCounter.current)
      merged.set('survey_number', sn)
      merged.set('feature_type', 'parcel')
      src.addFeature(merged)
      message.success('Merged selected polygons')
      setSelectedIds([merged.getId() as number]); syncRows()
    } catch { message.error('Merge failed') }
  }

  function deleteSelected() {
    const src = srcRef.current!
    if (!selectedIdsRef.current.size) { message.warning('Select polygons to delete'); return }
    snapshot()
    selectedIdsRef.current.forEach(id => { const f = src.getFeatureById(id); if (f) src.removeFeature(f) })
    setSelectedIds([]); syncRows()
  }

  function duplicateSelected() {
    const src = srcRef.current!
    if (!selectedIds.length) { message.warning('Select polygons to duplicate'); return }
    snapshot()
    const res = mapRef.current?.getView().getResolution() ?? 1
    const offset = res * 12
    const newIds: number[] = []
    selectedIds.forEach(id => {
      const f = src.getFeatureById(id); if (!f) return
      const clone = f.clone()
      clone.getGeometry()?.translate(offset, -offset)
      clone.setId(++idCounter.current)
      src.addFeature(clone)
      newIds.push(clone.getId() as number)
    })
    setSelectedIds(newIds); syncRows()
    message.success(`Duplicated ${newIds.length} polygon(s)`)
  }

  function setSurveyNumber(id: number, value: string) {
    srcRef.current?.getFeatureById(id)?.set('survey_number', value)
    setRows(prev => prev.map(r => (r.id === id ? { ...r, survey_number: value } : r)))
    srcRef.current?.changed()
  }

  function zoomTo(id: number) {
    const f = srcRef.current?.getFeatureById(id)
    const g = f?.getGeometry()
    if (g) mapRef.current?.getView().fit(g.getExtent(), { padding: [80, 80, 80, 80], maxZoom: 20, duration: 300 })
    setSelectedIds([id])
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function handleSave(values: any) {
    const src = srcRef.current!
    const fc = fmt.writeFeaturesObject(src.getFeatures(), PROJ)
    const features = fc.features.map((f: any) => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: { ...(f.properties || {}), survey_number: f.properties?.survey_number ?? '', source: 'classical_review' },
    }))
    if (!features.length) { message.warning('No polygons to save'); return }
    setSaving(true)
    try {
      const body: Record<string, any> = { layer_name: values.layer_name, features }
      if (areaMode === 'existing') body.survey_area_id = values.survey_area_id
      else body.new_area_name = values.new_area_name
      const res = await api.post(`/ai/vision/accept-features/${jobId}/`, body)
      message.success(`Saved ${res.data.created} polygon(s) to "${res.data.survey_area_name}"`)
      setSaveOpen(false)
      if (res.data.project_id) setTimeout(() => navigate(`/map?project=${res.data.project_id}`), 700)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  const notReady = job && job.status !== 'DONE'

  const toolHint: Record<Tool, string> = {
    select: 'Click a polygon to select · Shift-click to add/remove · Shift-drag to box-select',
    vertex: 'Drag a vertex to move · drag a segment to add a vertex · Alt-click a vertex to delete',
    move: 'Drag a polygon to move it · arrow keys nudge the selection (Shift = larger step)',
    split: 'Draw a line fully across a polygon to split it',
    add: 'Click to draw a new polygon · double-click to finish',
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0a0a1a' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px',
        background: '#0d0d1f', borderBottom: '1px solid #1a1a2e', flexWrap: 'wrap' }}>
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>Back</Button>
        <Text style={{ color: '#4fc3f7', fontWeight: 600 }}>Boundary Review — Job #{jobId}</Text>
        <Segmented
          size="small"
          value={tool}
          onChange={(v) => setTool(v as Tool)}
          options={[
            { value: 'select', label: 'Select', icon: <BorderOuterOutlined /> },
            { value: 'vertex', label: 'Vertex', icon: <NodeIndexOutlined /> },
            { value: 'move', label: 'Move', icon: <DragOutlined /> },
            { value: 'split', label: 'Split', icon: <ScissorOutlined /> },
            { value: 'add', label: 'Add', icon: <PlusOutlined /> },
          ]}
        />
        <Space.Compact size="small">
          <Tooltip title="Undo (Ctrl+Z)">
            <Button size="small" icon={<UndoOutlined />} onClick={undo} disabled={!canUndo} />
          </Tooltip>
          <Tooltip title="Redo (Ctrl+Y / Ctrl+Shift+Z)">
            <Button size="small" icon={<RedoOutlined />} onClick={redo} disabled={!canRedo} />
          </Tooltip>
        </Space.Compact>
        <Tooltip title="Merge selected polygons (shift-click to multi-select)">
          <Button size="small" icon={<MergeCellsOutlined />} onClick={mergeSelected}
            disabled={selectedIds.length < 2}>Merge</Button>
        </Tooltip>
        <Tooltip title="Duplicate selected polygons">
          <Button size="small" icon={<PlusOutlined />} onClick={duplicateSelected}
            disabled={!selectedIds.length}>Duplicate</Button>
        </Tooltip>
        <Tooltip title="Delete selected polygons (Del)">
          <Button size="small" danger icon={<DeleteOutlined />} onClick={deleteSelected}
            disabled={!selectedIds.length}>Delete</Button>
        </Tooltip>
        <div style={{ marginLeft: 'auto' }}>
          <Button type="primary" icon={<SaveOutlined />} disabled={!rows.length}
            onClick={() => { setAreaMode('existing'); saveForm.resetFields(); setSaveOpen(true) }}>
            Save to Survey Area
          </Button>
        </div>
      </div>

      {notReady && (
        <Alert type="warning" showIcon banner
          message={`Job is ${job.status} — only completed extractions can be reviewed.`} />
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Map */}
        <div style={{ flex: 1, position: 'relative' }}>
          <div ref={mapDivRef} style={{ position: 'absolute', inset: 0 }} />
          {(isLoading || (job && !loaded && !notReady)) && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}><Spin size="large" /></div>
          )}
          <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.7)', color: '#ddd', padding: '4px 12px', borderRadius: 16, fontSize: 12,
            maxWidth: '90%', textAlign: 'center' }}>
            {toolHint[tool]}
          </div>
        </div>

        {/* Side panel: polygon list + survey numbers */}
        <div style={{ width: 340, background: '#10101f', borderLeft: '1px solid #1a1a2e',
          display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '8px 12px', color: '#aaa', fontSize: 12, borderBottom: '1px solid #1a1a2e' }}>
            {rows.length} polygon(s) · {selectedIds.length} selected · edit Survey Numbers below
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={rows}
              rowClassName={(r) => (selectedIds.includes(r.id) ? 'review-row-sel' : '')}
              onRow={(r) => ({ onClick: () => zoomTo(r.id) })}
              columns={[
                { title: '#', dataIndex: 'id', width: 40, render: (_: any, __: any, i: number) => i + 1 },
                { title: 'Survey No.', dataIndex: 'survey_number',
                  render: (v: string, r: FeatureRow) => (
                    <Input
                      size="small" value={v} placeholder="—"
                      onClick={(e) => e.stopPropagation()}
                      onFocus={() => snapshot()}
                      onChange={(e) => setSurveyNumber(r.id, e.target.value)}
                    />
                  ) },
                { title: 'Area', dataIndex: 'area_ha', width: 78,
                  render: (v: number) => <Tag color="blue" style={{ fontSize: 10 }}>{v.toFixed(3)} ha</Tag> },
                { title: '', width: 36,
                  render: (_: any, r: FeatureRow) => (
                    <Tooltip title="Zoom to"><Button type="text" size="small" icon={<AimOutlined />}
                      onClick={(e) => { e.stopPropagation(); zoomTo(r.id) }} /></Tooltip>
                  ) },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Save modal */}
      <Modal
        title={<Space><SaveOutlined style={{ color: '#52c41a' }} />Save Reviewed Polygons</Space>}
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={() => saveForm.submit()}
        confirmLoading={saving}
        okText={`Save ${rows.length} Polygon(s)`}
      >
        <Form form={saveForm} layout="vertical" onFinish={handleSave}>
          <Form.Item name="layer_name" label="GIS Layer Name" rules={[{ required: true }]}
            initialValue="Reviewed Parcels">
            <Input placeholder="e.g. Reviewed_Parcels" />
          </Form.Item>
          <Form.Item label="Survey Area">
            <Radio.Group value={areaMode} onChange={e => setAreaMode(e.target.value)}
              optionType="button" buttonStyle="solid" style={{ marginBottom: 10 }}>
              <Radio.Button value="existing">Existing</Radio.Button>
              <Radio.Button value="new"><PlusOutlined /> Create New</Radio.Button>
            </Radio.Group>
            {areaMode === 'existing' ? (
              <Form.Item name="survey_area_id" noStyle rules={[{ required: true, message: 'Select a survey area' }]}>
                <AntSelect style={{ width: '100%' }} placeholder="Select survey area" showSearch optionFilterProp="label"
                  options={surveyAreas.map(a => ({ value: a.id, label: a.area_code ? `${a.name} (${a.area_code})` : a.name }))} />
              </Form.Item>
            ) : (
              <Form.Item name="new_area_name" noStyle rules={[{ required: true, message: 'Enter area name' }]}>
                <Input placeholder="e.g. Sector A — Reviewed" />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>

      <style>{`.review-row-sel td { background:#16331a !important; }`}</style>
    </div>
  )
}
