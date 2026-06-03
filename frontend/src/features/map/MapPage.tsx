import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { useProjectWebSocket } from '@/hooks/useProjectWebSocket'
import CollabPresence from './CollabPresence'
import { useSearchParams } from 'react-router-dom'
import Graticule from 'ol/layer/Graticule'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import WebGLTileLayer from 'ol/layer/WebGLTile'
import GeoTIFFSource from 'ol/source/GeoTIFF'
import VectorTileLayer from 'ol/layer/VectorTile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import OSM from 'ol/source/OSM'
import XYZ from 'ol/source/XYZ'
import VectorTileSource from 'ol/source/VectorTile'
import MVT from 'ol/format/MVT'
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj'
import { unByKey } from 'ol/Observable'
import { toStringXY } from 'ol/coordinate'
import { defaults as defaultControls, ScaleLine } from 'ol/control'
import Draw from 'ol/interaction/Draw'
import Modify from 'ol/interaction/Modify'
import Snap from 'ol/interaction/Snap'
import SelectInteraction from 'ol/interaction/Select'
import DragBox from 'ol/interaction/DragBox'
import { getLength, getArea } from 'ol/sphere'
import { LineString, Polygon } from 'ol/geom'
import { click } from 'ol/events/condition'
import Feature from 'ol/Feature'
import OLPoint from 'ol/geom/Point'
import { Style, Fill, Stroke, Circle as CircleStyle, Text, RegularShape } from 'ol/style'
import Translate from 'ol/interaction/Translate'
import Collection from 'ol/Collection'
import { shiftKeyOnly } from 'ol/events/condition'
import {
  Tooltip, Button, Select as AntSelect, Space, Drawer, Descriptions, Tag,
  Slider, InputNumber, message, Modal, Input, ColorPicker, Popover, Divider, Switch,
  Tabs, Badge, Form, Radio, Collapse, Segmented, Dropdown, Checkbox, AutoComplete, Spin,
} from 'antd'
import {
  DragOutlined, AimOutlined, EditOutlined,
  RadiusSettingOutlined, ColumnHeightOutlined,
  ZoomInOutlined, ZoomOutOutlined, GlobalOutlined,
  BarsOutlined, ColumnWidthOutlined, RadiusUpleftOutlined,
  PlusOutlined, DeleteOutlined, CloseOutlined,
  UndoOutlined, PrinterOutlined, TableOutlined,
  EnvironmentOutlined, BookOutlined, CheckCircleOutlined,
  SelectOutlined, FontColorsOutlined, WarningOutlined,
  ApartmentOutlined, ScissorOutlined, HeatMapOutlined, ApiOutlined,
  CopyOutlined, LockOutlined, UnlockOutlined, FilterOutlined,
  CalculatorOutlined, FullscreenOutlined, SwapOutlined,
  SettingOutlined, EyeOutlined, EyeInvisibleOutlined,
  MergeCellsOutlined, DownloadOutlined, ClearOutlined,
  HistoryOutlined, RetweetOutlined,
  SearchOutlined, NodeIndexOutlined, FunctionOutlined, SisternodeOutlined,
  RadiusUprightOutlined, MinusCircleOutlined, FileAddOutlined, UploadOutlined,
  CloudServerOutlined,
} from '@ant-design/icons'
import TileWMS from 'ol/source/TileWMS'
import HeatmapLayer from 'ol/layer/Heatmap'
import GeoJSON from 'ol/format/GeoJSON'
import { useAppStore } from '@/app/store'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type {
  BasemapConfig, SurveyProject, GeoTiffLayer, BufferRingResult,
  ProjectLayerFolder, GISFeature, MapBookmark, TopoIssue,
} from '@/types'
import BufferAnalysisModal, { BUFFER_COLORS } from './BufferAnalysisModal'
import AttributeTablePanel from './AttributeTablePanel'
import PrintLayoutModal, { type LayerLegendItem } from './PrintLayoutModal'
import MapExportModal from './MapExportModal'
import TempLayersPanel, { getTempLayerColor } from './TempLayersPanel'
import ExternalLayersPanel from './ExternalLayersPanel'
import { makePatternFill } from './fillPatterns'
import { resolveExtStyle, type ExtStyleResolved } from './extStyle'
import DraggableModal from '@/components/DraggableModal'
import NewLayerModal from './NewLayerModal'
import ImportGISModal from './ImportGISModal'
import 'ol/ol.css'

const INDIA_CENTER = fromLonLat([78.9629, 22.5937])
const DRAW_ROLES = ['SDO', 'SURVEYOR']
const BOOKMARKS_KEY = 'raksha_map_bookmarks'
const DEFAULT_LAYER_COLOR = '#00bcd4'

interface LayerStyle {
  visible: boolean
  locked: boolean
  opacity: number          // 0–100 overall layer opacity

  fillColor: string
  fillOpacity: number      // 0–100
  fillPattern: 'solid' | 'none' | 'hatched' | 'crosshatched'

  strokeColor: string
  strokeWidth: number
  strokeOpacity: number    // 0–100
  strokeStyle: 'solid' | 'dash' | 'dot' | 'dashdot' | 'longdash'
  strokeCap: 'butt' | 'round' | 'square'
  strokeJoin: 'miter' | 'round' | 'bevel'

  pointShape: 'circle' | 'square' | 'triangle' | 'star' | 'cross' | 'diamond' | 'x'
  pointSize: number
  pointRotation: number

  showLabels: boolean
  labelField: string
  labelFontSize: number
  labelBold: boolean
  labelColor: string
  labelHaloColor: string
  labelHaloWidth: number
  labelOffsetY: number
  labelPlacement: 'center' | 'above' | 'below' | 'left' | 'right'

  minZoom: number
  maxZoom: number
}

const DEFAULT_LAYER_STYLE: LayerStyle = {
  visible: true,
  locked: false,
  opacity: 100,
  fillColor: DEFAULT_LAYER_COLOR,
  fillOpacity: 20,
  fillPattern: 'solid',
  strokeColor: DEFAULT_LAYER_COLOR,
  strokeWidth: 2,
  strokeOpacity: 100,
  strokeStyle: 'solid',
  strokeCap: 'round',
  strokeJoin: 'round',
  pointShape: 'circle',
  pointSize: 6,
  pointRotation: 0,
  showLabels: false,
  labelField: 'feature_id',
  labelFontSize: 11,
  labelBold: false,
  labelColor: '#ffffff',
  labelHaloColor: '#000000',
  labelHaloWidth: 2,
  labelOffsetY: -14,
  labelPlacement: 'above',
  minZoom: 0,
  maxZoom: 22,
}

const LINE_DASH: Record<string, number[] | undefined> = {
  solid: undefined, dash: [10, 5], dot: [2, 5], dashdot: [10, 5, 2, 5], longdash: [20, 5],
}

function hexAlpha(hex: string, pct: number, layerOpacity: number) {
  const a = Math.round((pct / 100) * (layerOpacity / 100) * 255)
  return hex.replace(/^#/, '') + a.toString(16).padStart(2, '0')
}

function makeOLImage(s: LayerStyle) {
  const fillAlpha = hexAlpha(s.fillColor, s.fillOpacity, s.opacity)
  const strokeAlpha = hexAlpha(s.strokeColor, s.strokeOpacity, s.opacity)
  const stroke = s.strokeWidth > 0 ? new Stroke({
    color: `#${strokeAlpha}`,
    width: s.strokeWidth,
    lineDash: LINE_DASH[s.strokeStyle],
    lineCap: s.strokeCap as CanvasLineCap,
    lineJoin: s.strokeJoin as CanvasLineJoin,
  }) : undefined
  const fill = new Fill({ color: `#${fillAlpha}` })
  const rot = (s.pointRotation * Math.PI) / 180
  const r = s.pointSize
  if (s.pointShape === 'circle') return new CircleStyle({ radius: r, fill, stroke })
  const shapeCfg: Record<string, [number, number | undefined, number]> = {
    square:   [4, undefined,    Math.PI / 4],
    triangle: [3, undefined,    0],
    diamond:  [4, undefined,    0],
    star:     [5, r / 2.5,      0],
    cross:    [4, 0,            0],
    x:        [4, 0,            Math.PI / 4],
  }
  const [pts, r2, angle] = shapeCfg[s.pointShape] ?? [4, undefined, Math.PI / 4]
  return new RegularShape({ points: pts, radius: r, radius2: r2, angle, rotation: rot, fill, stroke })
}

function getLayerStyle(styles: Record<string, LayerStyle>, ln: string): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...styles[ln] }
}

const PRIMARY_TOOLS = [
  { key: 'pan',      icon: <DragOutlined />,    label: 'Pan / Navigate',   desc: 'Drag to pan the map' },
  { key: 'identify', icon: <AimOutlined />,     label: 'Identify Feature', desc: 'Click a feature to view its attributes' },
]

const SELECT_TOOLS = [
  { key: 'box_select',      icon: <SelectOutlined />,        label: 'Box Select',       desc: 'Drag a rectangle to select features' },
  { key: 'select_location', icon: <RadiusUprightOutlined />, label: 'Select by Polygon',desc: 'Draw a polygon to select features' },
  { key: 'coord_picker',    icon: <EnvironmentOutlined />,   label: 'Pick Coordinates', desc: 'Click to get lat/lon coordinates' },
]

const MEASURE_TOOLS = [
  { key: 'measure', icon: <ColumnWidthOutlined />,  label: 'Measure Distance/Area', desc: 'Draw a line to measure distance or area' },
  { key: 'buffer',  icon: <RadiusUpleftOutlined />, label: 'Buffer Analysis',       desc: 'Create buffer zones around features' },
]

const DRAW_TOOLS = [
  { key: 'draw_point',   icon: <RadiusSettingOutlined />, label: 'Draw Point',   desc: 'Digitize a point feature' },
  { key: 'draw_line',    icon: <ColumnHeightOutlined />,  label: 'Draw Line',    desc: 'Digitize a line / polyline feature' },
  { key: 'draw_polygon', icon: <EditOutlined />,          label: 'Draw Polygon', desc: 'Digitize a polygon feature' },
]

const EDIT_TOOLS = [
  { key: 'vertex_tool',     icon: <NodeIndexOutlined />,    label: 'Vertex Tool',          desc: 'Edit vertices of selected features' },
  { key: 'move_feature',    icon: <DragOutlined />,          label: 'Move Feature',         desc: 'Drag selected features to a new position' },
  { key: 'copy_move',       icon: <CopyOutlined />,          label: 'Copy and Move',        desc: 'Duplicate then move selected features' },
  { key: 'rotate_feature',  icon: <RetweetOutlined />,       label: 'Rotate',               desc: 'Rotate selected features by an angle' },
  { key: 'scale_feature',   icon: <FullscreenOutlined />,    label: 'Scale',                desc: 'Scale selected features by a factor' },
  { key: 'simplify_feature',icon: <FunctionOutlined />,      label: 'Simplify Geometry',    desc: 'Reduce vertex count of selected features' },
  { key: 'add_part',        icon: <PlusOutlined />,           label: 'Add Part',             desc: 'Add a new part to a multi-geometry feature' },
  { key: 'delete_part',     icon: <MinusCircleOutlined />,   label: 'Delete Part',          desc: 'Remove a part from a multi-geometry feature' },
  { key: 'reshape_feature', icon: <EditOutlined />,          label: 'Reshape Feature',      desc: 'Redraw part of a feature boundary' },
  { key: 'offset_curve',    icon: <SwapOutlined />,          label: 'Offset Curve',         desc: 'Create a parallel offset of a line' },
  { key: 'reverse_line',    icon: <RetweetOutlined />,       label: 'Reverse Line',         desc: 'Flip the direction of a line feature' },
  { key: 'trim_extend',     icon: <ScissorOutlined />,       label: 'Trim / Extend',        desc: 'Trim or extend line to another line' },
  { key: 'split_feature',   icon: <ScissorOutlined />,       label: 'Split Feature',        desc: 'Split a feature with a drawn line' },
  { key: 'split_parts',     icon: <SisternodeOutlined />,    label: 'Split Parts (Explode)',desc: 'Explode multi-geometry to single parts' },
  { key: 'merge_features',  icon: <MergeCellsOutlined />,    label: 'Merge Features',       desc: 'Merge selected features into one geometry' },
  { key: 'merge_attributes',icon: <ApartmentOutlined />,     label: 'Merge Attributes',     desc: 'Combine attributes from selected features' },
  { key: 'delete_feature',  icon: <DeleteOutlined />,        label: 'Delete Feature(s)',    desc: 'Delete one or more selected features' },
]

const BASE_TOOL_BUTTONS = [...PRIMARY_TOOLS, ...SELECT_TOOLS, ...MEASURE_TOOLS]
const DRAW_TOOL_BUTTONS = [...DRAW_TOOLS, ...EDIT_TOOLS]

function makeBasemapSource(bm: BasemapConfig | null) {
  if (!bm || bm.provider === 'OSM') return new OSM()
  return new XYZ({ url: bm.url_template, crossOrigin: 'anonymous' })
}

function loadBookmarks(): MapBookmark[] {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '[]') } catch { return [] }
}

// ── External-layer thematic (classification-based) styling ───────────────────
const EXT_NULL_KEY = '__null__'

interface ExtClassColor { color: string; opacity?: number }
interface ExtLayerConfig {
  id: number
  display_name?: string
  classification_field?: string
  classification_colors?: Record<string, ExtClassColor>
  style?: Record<string, unknown>
  feature_count?: number | null
  min_zoom?: number
  bbox?: number[] | null
}

// Layers larger than this load by viewport (bbox); smaller ones load fully once.
const EXT_BBOX_THRESHOLD = 5000

interface ExtSearchResult {
  layer_id: number
  layer_name: string
  id: number | string
  label: string
  match_field?: string | null
  match_value?: string | null
  geometry: Record<string, unknown>
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let h: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (h) clearTimeout(h)
    h = setTimeout(() => fn(...args), ms)
  }) as T
}
interface ExtClassLegend {
  title: string
  field: string
  entries: { value: string; color: string; opacity: number }[]
}

function hexToRgba(hex: string, opacity: number): string {
  const h = (hex || '').replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n = parseInt(full || 'ff6600', 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const a = Math.max(0, Math.min(1, isNaN(opacity) ? 0.5 : opacity))
  return `rgba(${r},${g},${b},${a})`
}

function makeExtImage(cfg: ExtStyleResolved, stroke?: Stroke) {
  // Points use a solid fill (patterns are invisible at point scale).
  const fill = new Fill({ color: hexToRgba(cfg.fillColor, Math.max(cfg.fillOpacity, 0.6)) })
  const r = cfg.pointSize
  if (cfg.pointShape === 'circle') return new CircleStyle({ radius: r, fill, stroke })
  const shapeCfg: Record<string, [number, number | undefined, number]> = {
    square:   [4, undefined, Math.PI / 4],
    triangle: [3, undefined, 0],
    diamond:  [4, undefined, 0],
    star:     [5, r / 2.5,   0],
    cross:    [4, 0,         0],
    x:        [4, 0,         Math.PI / 4],
  }
  const [pts, r2, angle] = shapeCfg[cfg.pointShape] ?? [4, undefined, Math.PI / 4]
  return new RegularShape({ points: pts, radius: r, radius2: r2, angle, fill, stroke })
}

function buildOLExtStyle(cfg: ExtStyleResolved): Style {
  const stroke = cfg.strokeWidth > 0 ? new Stroke({
    color: hexToRgba(cfg.strokeColor, cfg.strokeOpacity),
    width: cfg.strokeWidth,
    lineDash: LINE_DASH[cfg.strokeStyle],
    lineCap: cfg.strokeCap,
    lineJoin: cfg.strokeJoin,
  }) : undefined
  const fill = makePatternFill(cfg.fillPattern, cfg.fillColor, cfg.fillOpacity)
  return new Style({ stroke, fill, image: makeExtImage(cfg, stroke) })
}

/** Build an OL style (or per-feature style function) for an external layer. */
function makeExtStyle(layer?: ExtLayerConfig): Style | ((f: any) => Style) {
  const base = resolveExtStyle(layer?.style)
  const field = (layer?.classification_field || '').trim()
  const colors = layer?.classification_colors || {}
  if (!field || Object.keys(colors).length === 0) {
    // Flat single-symbol style (stroke + pattern fill from the configured schema).
    return buildOLExtStyle(base)
  }
  // Thematic: per-class fill colour/opacity, but keep the configured stroke + pattern.
  const cache: Record<string, Style> = {}
  const styleFor = (raw: unknown): Style => {
    const key = raw == null || String(raw).trim() === '' ? EXT_NULL_KEY : String(raw).trim()
    if (cache[key]) return cache[key]
    const cfg = colors[key] || colors[EXT_NULL_KEY] || { color: '#bdbdbd', opacity: 0.5 }
    const color = cfg.color || '#bdbdbd'
    const st = buildOLExtStyle({
      ...base,
      fillColor: color,
      strokeColor: color,
      fillOpacity: cfg.opacity == null ? 0.5 : cfg.opacity,
    })
    cache[key] = st
    return st
  }
  return (feature: any) => styleFor(feature.get(field))
}

/** Build legend rows for a classified external layer (null = no legend). */
function makeExtLegend(layer?: ExtLayerConfig): ExtClassLegend | null {
  const field = (layer?.classification_field || '').trim()
  const colors = layer?.classification_colors || {}
  if (!field || Object.keys(colors).length === 0) return null
  const entries = Object.entries(colors).map(([value, cfg]) => ({
    value: value === EXT_NULL_KEY ? 'Null / Others' : value,
    color: cfg.color || '#bdbdbd',
    opacity: cfg.opacity == null ? 0.5 : cfg.opacity,
  }))
  return { title: layer?.display_name || 'Layer', field, entries }
}

export default function MapPage() {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<Map | null>(null)
  const basemapLayer = useRef<TileLayer<OSM | XYZ> | null>(null)
  const projectLayer = useRef<VectorLayer<VectorSource> | null>(null)
  const projectSource = useRef<VectorSource | null>(null)  // exposed for collab updates
  const selectLayer = useRef<VectorLayer<VectorSource> | null>(null)
  const measureLayer = useRef<VectorLayer<VectorSource> | null>(null)
  const bufferLayer = useRef<VectorLayer<VectorSource> | null>(null)
  const drawInteraction = useRef<Draw | null>(null)
  const modifyInteraction = useRef<Modify | null>(null)
  const snapInteraction = useRef<Snap | null>(null)
  const dragBoxInteraction = useRef<DragBox | null>(null)
  const cogLayers = useRef<Record<number, WebGLTileLayer>>({})
  const heatmapLayerRef = useRef<HeatmapLayer | null>(null)
  const wmsLayersRef = useRef<Record<string, TileLayer<TileWMS>>>({})
  type UndoEntry =
    | { type: 'draw'; feature: Feature }
    | { type: 'move'; geoms: { id: number; geomGeoJSON: Record<string, unknown> }[] }
  const undoStack = useRef<UndoEntry[]>([])
  const layerStylesRef = useRef<Record<string, LayerStyle>>({})
  const dragLayerRef = useRef<string | null>(null)
  const translateRef = useRef<Translate | null>(null)
  const clipboardRef = useRef<any[]>([])  // copied OL features
  const activeManageLayerRef = useRef<string | null>(null)
  const tempLayerRefs = useRef<Record<number, VectorLayer<VectorSource>>>({})
  const [tempLayerPanelOpen, setTempLayerPanelOpen] = useState(false)
  const [tempVisibleIds, setTempVisibleIds] = useState<Set<number>>(new Set())
  // External DB layers (key = 'ext:{id}')
  const extLayerRefs = useRef<Record<string, VectorLayer<VectorSource>>>({})
  // moveend listeners for viewport (bbox) loaded external layers, keyed by 'ext:{id}'
  const extMoveKeys = useRef<Record<string, any>>({})
  const [extVisibleIds, setExtVisibleIds] = useState<Set<string>>(new Set())
  // Classification legends for visible external layers, keyed by 'ext:{id}'
  const [extClassLegends, setExtClassLegends] = useState<Record<string, ExtClassLegend>>({})
  // New shapes drawn by a CEO/ADEO surveyor can be shared with the parent DEO (default Yes).
  const [deoVisible, setDeoVisible] = useState(true)
  const deoVisibleRef = useRef(true)
  useEffect(() => { deoVisibleRef.current = deoVisible }, [deoVisible])
  const [extLayersPanelOpen, setExtLayersPanelOpen] = useState(false)

  // External-layer keyword search
  const [extSearchValue, setExtSearchValue] = useState('')
  const [extSearchResults, setExtSearchResults] = useState<ExtSearchResult[]>([])
  const [extSearchLoading, setExtSearchLoading] = useState(false)
  const searchHighlightLayer = useRef<VectorLayer<VectorSource> | null>(null)

  const {
    mapTool, setMapTool,
    activeBasemap, setActiveBasemap,
    mapCoords, setMapCoords,
    selectedProjectId, setSelectedProjectId,
    selectedFolderId, setSelectedFolderId,
    user,
  } = useAppStore()
  const canDraw = user ? DRAW_ROLES.includes(user.role) : false
  const isCantonmentUploader = user?.role === 'SURVEYOR'
  const [selectedAreaStatus, setSelectedAreaStatus] = useState<string | null>(null)

  // DGDE/PDDE (national/command) get a simplified, read-only viewer: pick an office,
  // see only its PUBLISHED layers with basic controls. No draw/edit tools or feature lists.
  const simplified = user?.organisation_level === 'DGDE' || user?.organisation_level === 'PDDE'
  const [officeFilter, setOfficeFilter] = useState<number | null>(null)
  const { data: officeOptions = [] } = useQuery<any[]>({
    queryKey: ['map-offices'],
    queryFn: () => api.get('/accounts/organisations/').then(r => r.data.results ?? r.data),
    enabled: simplified,
  })

  // ── Real-time collaboration ─────────────────────────────────────────────────
  const {
    connected: collabConnected,
    reconnecting: collabReconnecting,
    presenceUsers,
    lockedFeatures,
    setEventHandler: setCollabHandler,
    sendFeatureCreated: wsSendCreated,
    sendFeatureUpdated: wsSendUpdated,
    sendFeatureDeleted: wsSendDeleted,
  } = useProjectWebSocket(selectedProjectId)
  // isReadOnly and toolButtons are computed after surveyAreas / flatFolders queries below
  const [searchParams, setSearchParams] = useSearchParams()

  const [featureInfo, setFeatureInfo] = useState<Record<string, unknown> | null>(null)
  const [featureModalMeta, setFeatureModalMeta] = useState<{ layerLabel: string; layerType: string } | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [measureResult, setMeasureResult] = useState<string | null>(null)
  const [cogOpacities, setCogOpacities] = useState<Record<number, number>>({})
  const [cogVisible, setCogVisible] = useState<Record<number, boolean>>({})
  const [layerStyles, setLayerStyles] = useState<Record<string, LayerStyle>>({})
  const [layerOrder, setLayerOrder] = useState<string[]>([])
  const [expandedLayer, setExpandedLayer] = useState<string | null>(null)
  const [activeManageLayer, setActiveManageLayer] = useState<string | null>(null)
  const [calcFieldModal, setCalcFieldModal] = useState<{ ln: string } | null>(null)
  const [calcField, setCalcField] = useState('')
  const [calcValue, setCalcValue] = useState('')
  const [calcTarget, setCalcTarget] = useState<'selected' | 'all'>('selected')
  const [selectAttrModal, setSelectAttrModal] = useState<{ ln: string } | null>(null)
  const [attrField, setAttrField] = useState('')
  const [attrOp, setAttrOp] = useState('=')
  const [attrValue, setAttrValue] = useState('')
  const [moveLayerActive, setMoveLayerActive] = useState<string | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  // When Move Feature is clicked with no selection, we auto-switch to box_select
  // and resume move once selection is done
  const pendingMoveRef = useRef(false)
  // Survey-area-wise map mode: null = "All Areas" overview (read-only)
  const [selectedSurveyAreaId, setSelectedSurveyAreaId] = useState<number | null>(null)

  // Draw layer chooser
  const [drawLayerModal, setDrawLayerModal] = useState(false)
  const [drawLayerChoice, setDrawLayerChoice] = useState<'new' | 'existing'>('existing')
  const [drawNewLayerName, setDrawNewLayerName] = useState('')
  const [drawExistingLayer, setDrawExistingLayer] = useState('')
  const pendingDrawFeatureRef = useRef<Feature | null>(null)
  const pendingDrawTypeRef = useRef<string>('')

  // Active layer preset — set by "New Layer" deep-link (?layer=NAME&folder=ID)
  // When set, drawn features skip the "choose layer" modal and go straight to this layer
  const [activeDrawLayer, setActiveDrawLayer] = useState<{ name: string; folderId: number } | null>(null)
  const activeDrawLayerRef = useRef<{ name: string; folderId: number } | null>(null)
  const [newLayerModalOpen, setNewLayerModalOpen] = useState(false)
  const [importGISModalOpen, setImportGISModalOpen] = useState(false)

  // Buffer analysis state
  const [bufferDistances, setBufferDistances] = useState<number[]>([50, 100, 200, 500])
  const [bufferUnit, setBufferUnit] = useState<'meters' | 'kilometers'>('meters')
  const [bufferPoint, setBufferPoint] = useState<[number, number] | null>(null)
  const [bufferResults, setBufferResults] = useState<BufferRingResult[]>([])
  const [bufferLoading, setBufferLoading] = useState(false)
  const [bufferModalOpen, setBufferModalOpen] = useState(false)
  const [bufferMode, setBufferMode] = useState<'point' | 'layer' | 'feature'>('point')
  const [bufferDissolve, setBufferDissolve] = useState(false)
  const [bufferLayerName, setBufferLayerName] = useState('')

  // ArcGIS-like feature state
  const [attrTableOpen, setAttrTableOpen] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  const [mapExportOpen, setMapExportOpen] = useState(false)
  const [gotoOpen, setGotoOpen] = useState(false)
  const [gotoLat, setGotoLat] = useState('')
  const [gotoLon, setGotoLon] = useState('')
  const [bookmarks, setBookmarks] = useState<MapBookmark[]>(loadBookmarks)
  const [bookmarkName, setBookmarkName] = useState('')
  const [topoIssues, setTopoIssues] = useState<TopoIssue[]>([])
  const [topoLoading, setTopoLoading] = useState(false)
  const [topoOpen, setTopoOpen] = useState(false)

  // Coordinate picker
  const [coordModalOpen, setCoordModalOpen] = useState(false)
  const [coordResult, setCoordResult] = useState<{ lat: number; lon: number } | null>(null)

  // WMS import
  const [wmsModalOpen, setWmsModalOpen] = useState(false)
  const [wmsUrl, setWmsUrl] = useState('')
  const [wmsLayerName, setWmsLayerName] = useState('')
  const [wmsTitle, setWmsTitle] = useState('')
  const [wmsSrs, setWmsSrs] = useState('EPSG:4326')
  const [wmsLayerList, setWmsLayerList] = useState<{ id: string; title: string }[]>([])

  // Heatmap
  const [heatmapVisible, setHeatmapVisible] = useState(false)
  const [heatmapLoading, setHeatmapLoading] = useState(false)

  // Merge
  const [merging, setMerging] = useState(false)

  // Snapping
  const [snapVertex, setSnapVertex] = useState(true)
  const [snapEdge, setSnapEdge] = useState(false)
  const [snapMidpoint, setSnapMidpoint] = useState(false)

  // Extent history
  const extentHistory = useRef<{center: number[]; zoom: number}[]>([])
  const extentHistoryIdx = useRef(-1)
  const [canHistBack, setCanHistBack] = useState(false)
  const [canHistFwd, setCanHistFwd] = useState(false)

  // Map controls
  const [graticuleVisible, setGraticuleVisible] = useState(false)
  const [mapLocked, setMapLocked] = useState(false)
  const graticuleRef = useRef<Graticule | null>(null)

  // Swipe comparison
  const [swiperActive, setSwiperActive] = useState(false)
  const [swiperLayer, setSwiperLayer] = useState<string | null>(null)
  const [swiperPos, setSwiperPos] = useState(50)

  // Graduated / unique-value renderer
  const [graduatedModal, setGraduatedModal] = useState<{ln: string} | null>(null)
  const [gradField, setGradField] = useState('')
  const [gradMode, setGradMode] = useState<'graduated' | 'unique'>('unique')
  const [gradBreaks, setGradBreaks] = useState(5)
  const [graduatedRules, setGraduatedRules] = useState<Record<string, Record<string, string[]>>>({})
  const graduatedRulesRef = useRef<Record<string, Record<string, string[]>>>({})
  const graduatedFieldRef = useRef<Record<string, string>>({})

  // Editing operation modals
  const [rotateModalOpen, setRotateModalOpen]         = useState(false)
  const [rotateAngle, setRotateAngle]                 = useState(0)
  const [scaleModalOpen, setScaleModalOpen]           = useState(false)
  const [scaleFactor, setScaleFactor]                 = useState(1.0)
  const [simplifyModalOpen, setSimplifyModalOpen]     = useState(false)
  const [simplifyTolerance, setSimplifyTolerance]     = useState(0.5)  // metres
  const [offsetModalOpen, setOffsetModalOpen]         = useState(false)
  const [offsetDistance, setOffsetDistance]           = useState(10)   // metres
  const [toolGroupsCollapsed, setToolGroupsCollapsed] = useState<Set<string>>(new Set())

  // Analysis modals
  const [dissolveModal, setDissolveModal] = useState(false)
  const [spatialJoinModal, setSpatialJoinModal] = useState(false)
  const [clipModal, setClipModal] = useState(false)
  const [summaryModal, setSummaryModal] = useState(false)
  const [nearModal, setNearModal] = useState(false)
  const [hullModal, setHullModal] = useState(false)
  const [centroidModal, setCentroidModal] = useState(false)
  const [findReplaceModal, setFindReplaceModal] = useState<{ln: string} | null>(null)
  const [analysisLayer, setAnalysisLayer] = useState('')
  const [analysisLayer2, setAnalysisLayer2] = useState('')
  const [analysisField, setAnalysisField] = useState('')
  const [analysisOutLayer, setAnalysisOutLayer] = useState('')
  const [findVal, setFindVal] = useState('')
  const [replaceVal, setReplaceVal] = useState('')
  const [summaryData, setSummaryData] = useState<any>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)

  // Select by location draw ref
  const selectLocationDraw = useRef<Draw | null>(null)

  const { data: basemaps } = useQuery<BasemapConfig[]>({
    queryKey: qk.basemaps(),
    queryFn: () => api.get('/gis/basemaps/').then((r) => r.data.results ?? r.data),
  })

  const qc = useQueryClient()

  const { data: projects } = useQuery<{ results: SurveyProject[] }>({
    queryKey: qk.projects(),
    queryFn: () => api.get('/projects/').then((r) => r.data),
  })

  // Auto-select project: honour ?project= URL param first, then stored ID, then most recent
  useEffect(() => {
    if (!projects?.results?.length) return
    const projectParam = searchParams.get('project')
    if (projectParam) {
      const pid = Number(projectParam)
      if (projects.results.some((p) => p.id === pid)) {
        setSelectedProjectId(pid)
        // Remove param from URL so it doesn't persist after selection
        setSearchParams(prev => { prev.delete('project'); return prev }, { replace: true })
        return
      }
    }
    if (selectedProjectId) {
      const exists = projects.results.some((p) => p.id === selectedProjectId)
      if (!exists) setSelectedProjectId(projects.results[0].id)
    } else {
      setSelectedProjectId(projects.results[0].id)
    }
  }, [projects])

  const { data: surveyAreas = [], status: areasStatus } = useQuery<{ id: number; name: string; folder: number | null; status: string }[]>({
    queryKey: qk.surveyAreas(selectedProjectId ?? 0),
    queryFn: () =>
      selectedProjectId
        ? api.get(`/projects/survey-areas/?project=${selectedProjectId}&page_size=200`).then(r => r.data.results ?? r.data)
        : Promise.resolve([]),
    enabled: !!selectedProjectId,
  })

  // Flat folder list for ancestor-chain lookup
  const { data: flatFolders = [] } = useQuery<{ id: number; parent: number | null; folder_type: string; is_final: boolean; name: string }[]>({
    queryKey: ['folders-flat', selectedProjectId],
    queryFn: () =>
      selectedProjectId
        ? api.get(`/projects/folders/?project=${selectedProjectId}&page_size=500`).then(r => r.data.results ?? r.data)
        : Promise.resolve([]),
    enabled: !!selectedProjectId,
  })

  // Walk up the folder parent chain and return the first survey area whose linked
  // folder matches the given folder or any of its ancestors.
  function findAreaForFolder(folderId: number | null): (typeof surveyAreas)[0] | undefined {
    if (!folderId || !surveyAreas.length) return undefined
    const parentMap: Record<number, number | null> = {}
    flatFolders.forEach(f => { parentMap[f.id] = f.parent })
    let current: number | null = folderId
    while (current !== null && current !== undefined) {
      const matched = surveyAreas.find(a => a.folder === current)
      if (matched) return matched
      current = Object.prototype.hasOwnProperty.call(parentMap, current) ? parentMap[current] : null
    }
    return undefined
  }

  // Update area status whenever selectedFolderId changes (used for banner display)
  useEffect(() => {
    if (!selectedFolderId) { setSelectedAreaStatus(null); return }
    const area = findAreaForFolder(selectedFolderId)
    setSelectedAreaStatus(area?.status ?? null)
  }, [selectedFolderId, surveyAreas, flatFolders])

  // Deep-link: ?area=ID → auto-select that survey area once areas are loaded
  // Also: ?layer=NAME&geomtype=POINT|LINE|POLYGON&folder=ID&tool=draw_*
  //   → set active draw layer and activate the correct draw tool
  useEffect(() => {
    const areaParam = searchParams.get('area')
    const layerParam = searchParams.get('layer')
    const folderParam = searchParams.get('folder')
    const toolParam = searchParams.get('tool')
    if (!surveyAreas.length && !areaParam) return

    let applied = false

    if (areaParam) {
      const areaId = Number(areaParam)
      const found = surveyAreas.find((a) => a.id === areaId)
      if (found) { setSelectedSurveyAreaId(areaId); applied = true }
    }

    if (layerParam && folderParam) {
      setActiveDrawLayer({ name: layerParam, folderId: Number(folderParam) })
      if (toolParam && ['draw_point', 'draw_line', 'draw_polygon'].includes(toolParam)) {
        // Slight delay so the area selection + read-only check settles first
        setTimeout(() => setMapTool(toolParam as any), 300)
      }
      message.success(
        `Layer "${layerParam}" is active — draw on the map to add features. Press Esc to exit draw mode.`,
        5,
      )
      applied = true
    }

    if (applied) setSearchParams({}, { replace: true })
  }, [surveyAreas])

  // Keep activeDrawLayerRef in sync so the draw interaction's drawend closure always reads current
  useEffect(() => { activeDrawLayerRef.current = activeDrawLayer }, [activeDrawLayer])

  // Computed here (before isReadOnly) so it's available in the lock check below
  const selectedSurveyArea = surveyAreas.find((a) => a.id === selectedSurveyAreaId) ?? null

  // Lock logic (survey-area-wise):
  // - No area selected (All Areas overview) → always read-only
  // - Area selected → locked unless that area's status is DRAFT or RETURNED
  const isReadOnly = !canDraw || (() => {
    if (areasStatus === 'pending') return true
    if (surveyAreas.length === 0) return false          // project has no survey areas at all
    if (!selectedSurveyAreaId) return true              // All Areas mode → read-only
    return !['DRAFT', 'RETURNED'].includes(selectedSurveyArea?.status ?? '')
  })()
  // Overview mode = no area selected; hide NAVIGATE / SELECTION / DRAW / EDIT from toolbar
  const isOverviewMode = surveyAreas.length > 0 && !selectedSurveyAreaId
  const toolButtons = !isReadOnly ? [...BASE_TOOL_BUTTONS, ...DRAW_TOOL_BUTTONS] : BASE_TOOL_BUTTONS

  const { data: activeVersion } = useQuery<ProjectLayerFolder>({
    queryKey: qk.activeVersion(selectedProjectId ?? 0),
    queryFn: () =>
      api.get(`/projects/${selectedProjectId}/active-version/`).then((r) => r.data),
    enabled: !!selectedProjectId && canDraw,
    staleTime: 0,
  })

  const newVersionMutation = useMutation({
    mutationFn: () =>
      api.post(`/projects/${selectedProjectId}/active-version/`).then((r) => r.data as ProjectLayerFolder),
    onSuccess: (folder) => {
      qc.setQueryData(qk.activeVersion(selectedProjectId ?? 0), folder)
      qc.invalidateQueries({ queryKey: ['folders', selectedProjectId] })
      setSelectedFolderId(folder.id)
      message.success(`New version created: ${folder.name}`)
    },
  })

  const { data: geotiffs = [] } = useQuery<GeoTiffLayer[]>({
    queryKey: qk.geotiffs(selectedProjectId ?? 0),
    queryFn: () =>
      selectedProjectId
        ? api.get(`/projects/geotiffs/?project=${selectedProjectId}&status=DONE`).then((r) => r.data.results ?? r.data)
        : Promise.resolve([]),
    enabled: !!selectedProjectId,
  })

  const { data: mapFeatures = [] } = useQuery<GISFeature[]>({
    queryKey: ['map-features', simplified ? `org:${officeFilter}` : selectedProjectId],
    queryFn: () => {
      // DGDE/PDDE: load the picked office's PUBLISHED features (backend enforces status).
      if (simplified) {
        return officeFilter
          ? api.get(`/projects/features/?organisation=${officeFilter}&is_deleted=false`).then((r) => r.data.results ?? r.data)
          : Promise.resolve([])
      }
      return selectedProjectId
        ? api.get(`/projects/features/?project=${selectedProjectId}&is_deleted=false`).then((r) => r.data.results ?? r.data)
        : Promise.resolve([])
    },
    enabled: simplified ? !!officeFilter : !!selectedProjectId,
  })

  const rawLayerNames = useMemo(
    () => [...new Set(mapFeatures.map((f) => f.layer_name))].filter(Boolean),
    [mapFeatures]
  )

  // Returns true if this folder (or its ancestor) is linked to a locked survey area
  function isFeatureFolderLocked(folderId: number | null): boolean {
    if (!folderId || surveyAreas.length === 0) return false
    const area = findAreaForFolder(folderId)
    return !!area && !['DRAFT', 'RETURNED'].includes(area.status)
  }

  // Layer names that belong only to DRAFT / RETURNED areas — shown in draw layer chooser
  const editableLayerNames = useMemo(() => {
    if (surveyAreas.length === 0) return rawLayerNames
    return rawLayerNames.filter((ln) => {
      const featsInLayer = mapFeatures.filter((f) => f.layer_name === ln)
      if (featsInLayer.length === 0) return true
      return featsInLayer.some((f) => !isFeatureFolderLocked(f.folder))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawLayerNames, mapFeatures, surveyAreas, flatFolders])

  // Keep layerOrder in sync: add new layers at the end, remove stale ones
  useEffect(() => {
    setLayerOrder((prev) => {
      const existing = new Set(prev)
      const newOnes = rawLayerNames.filter((n) => !existing.has(n))
      const pruned = prev.filter((n) => rawLayerNames.includes(n))
      return newOnes.length ? [...pruned, ...newOnes] : pruned
    })
  }, [rawLayerNames.join(',')])

  // ── Survey-area-wise view helpers ──────────────────────────────────────────

  // All folder IDs (self + every descendant) of the selected survey area's linked folder
  const selectedAreaFolderIds = useMemo<Set<number> | null>(() => {
    if (!selectedSurveyArea?.folder) return null
    const result = new Set<number>()
    const queue = [selectedSurveyArea.folder]
    while (queue.length) {
      const cur = queue.shift()!
      result.add(cur)
      flatFolders.filter((f) => f.parent === cur).forEach((f) => queue.push(f.id))
    }
    return result
  }, [selectedSurveyArea, flatFolders])

  // Latest non-final VERSION folder within the selected area's subtree — draw target
  const areaActiveFolderId = useMemo<number | null>(() => {
    if (!selectedAreaFolderIds) return null
    const candidates = flatFolders
      .filter((f) => f.folder_type === 'VERSION' && !f.is_final && selectedAreaFolderIds.has(f.id))
    if (!candidates.length) return null
    // Return the one created last (largest id is a good proxy)
    return candidates.reduce((a, b) => (a.id > b.id ? a : b)).id
  }, [selectedAreaFolderIds, flatFolders])

  // Features restricted to the selected area (all when no area chosen)
  const visibleFeatures = useMemo(
    () => selectedAreaFolderIds
      ? mapFeatures.filter((f) => f.folder != null && selectedAreaFolderIds.has(f.folder))
      : mapFeatures,
    [mapFeatures, selectedAreaFolderIds]
  )

  // Layer names derived from visible features (respects area filter)
  const visibleRawLayerNames = useMemo(
    () => [...new Set(visibleFeatures.map((f) => f.layer_name))].filter(Boolean),
    [visibleFeatures]
  )
  // ── End survey-area-wise helpers ────────────────────────────────────────────

  // Auto-create the folder tree for any selected DRAFT/RETURNED area that has none.
  // This ensures features are always scoped to an area, never floating in "All Areas".
  useEffect(() => {
    if (!selectedSurveyArea) return
    if (!['DRAFT', 'RETURNED'].includes(selectedSurveyArea.status)) return
    if (selectedSurveyArea.folder !== null) return

    api.post(`/projects/survey-areas/${selectedSurveyArea.id}/ensure-folder/`)
      .then((r) => {
        qc.setQueryData<typeof surveyAreas>(
          qk.surveyAreas(selectedProjectId ?? 0),
          (old) => old ? old.map((a) => a.id === r.data.id ? r.data : a) : old,
        )
        qc.invalidateQueries({ queryKey: ['folders-flat', selectedProjectId] })
      })
      .catch(() => {})
  }, [selectedSurveyAreaId, selectedSurveyArea?.folder])

  const layerNames = useMemo(
    () => layerOrder.filter((n) => visibleRawLayerNames.includes(n)),
    [layerOrder, visibleRawLayerNames]
  )

  // Print legend: visible vector layers + visible GeoTIFF layers
  const printLegend = useMemo<LayerLegendItem[]>(() => {
    const vectorItems: LayerLegendItem[] = layerNames
      .filter((ln) => getLayerStyle(layerStyles, ln).visible)
      .map((ln) => ({ name: ln, color: getLayerStyle(layerStyles, ln).strokeColor, type: 'vector' }))
    const rasterItems: LayerLegendItem[] = geotiffs
      .filter((g) => cogVisible[g.id] !== false)
      .map((g) => ({ name: g.name, color: '#b4c8dc', type: 'raster' }))
    return [...vectorItems, ...rasterItems]
  }, [layerNames, layerStyles, geotiffs, cogVisible])

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return

    const bm = new TileLayer({ source: new OSM(), zIndex: 0 })
    basemapLayer.current = bm

    const boundaryLayer = new VectorTileLayer({
      source: new VectorTileSource({
        format: new MVT(),
        url: '/tiles/public.gis_layers_district/{z}/{x}/{y}.pbf',
        maxZoom: 14,
      }),
      style: new Style({ stroke: new Stroke({ color: '#4fc3f799', width: 1 }) }),
      zIndex: 1,
    })

    // Project features layer with full per-layer style
    const src = new VectorSource()
    const vl = new VectorLayer({
      source: src,
      style: (feature) => {
        const ln = (feature.get('layer_name') as string) ?? ''

        // Graduated/unique-value override
        const gradRules = (graduatedRulesRef.current || {})[ln]
        const gradFld   = (graduatedFieldRef.current || {})[ln]
        if (gradRules && gradFld) {
          const attrs = feature.get('attributes') as Record<string, unknown> | undefined
          const val   = String(attrs?.[gradFld] ?? '')
          const colors = gradRules[val]
          if (colors) {
            const [fc, sc] = colors
            return [
              new Style({ fill: new Fill({ color: fc + '55' }), stroke: new Stroke({ color: sc, width: 2 }), image: new CircleStyle({ radius: 6, fill: new Fill({ color: fc }), stroke: new Stroke({ color: '#fff', width: 1 }) }) }),
            ]
          }
        }

        const s = getLayerStyle(layerStylesRef.current, ln)
        if (!s.visible) return new Style()
        const zoom = vl.get('_mapZoom') as number ?? 10
        if (zoom < s.minZoom || zoom > s.maxZoom) return new Style()

        const strokeAlpha = hexAlpha(s.strokeColor, s.strokeOpacity, s.opacity)
        const fillAlpha   = hexAlpha(s.fillColor,   s.fillOpacity,   s.opacity)
        const stroke = s.strokeWidth > 0 ? new Stroke({
          color: `#${strokeAlpha}`,
          width: s.strokeWidth,
          lineDash: LINE_DASH[s.strokeStyle],
          lineCap: s.strokeCap as CanvasLineCap,
          lineJoin: s.strokeJoin as CanvasLineJoin,
        }) : undefined
        const fill = s.fillPattern === 'none' ? undefined : new Fill({ color: `#${fillAlpha}` })

        const labelVal = s.showLabels
          ? String(feature.get(s.labelField) ?? feature.get('feature_id') ?? '')
          : undefined
        const PLACEMENT_OFF: Record<string, [number, number]> = {
          center: [0, 0], above: [0, -(s.pointSize + 6)],
          below: [0, s.pointSize + 6], left: [-(s.pointSize + 6), 0], right: [s.pointSize + 6, 0],
        }
        const [ox] = PLACEMENT_OFF[s.labelPlacement] ?? [0, 0]
        const text = labelVal !== undefined ? new Text({
          text: labelVal,
          font: `${s.labelBold ? 'bold ' : ''}${s.labelFontSize}px sans-serif`,
          fill: new Fill({ color: s.labelColor }),
          stroke: s.labelHaloWidth > 0
            ? new Stroke({ color: s.labelHaloColor, width: s.labelHaloWidth * 2 })
            : undefined,
          offsetX: ox,
          offsetY: s.labelOffsetY,
          overflow: true,
        }) : undefined

        return new Style({ fill, stroke, image: makeOLImage(s), text })
      },
      zIndex: 10,   // always above GeoTIFF (zIndex 2)
    })
    projectLayer.current = vl
    projectSource.current = src

    // Box-select highlight layer (orange)
    const selSrc = new VectorSource()
    const selLayer = new VectorLayer({
      source: selSrc,
      style: new Style({
        fill: new Fill({ color: 'rgba(255,152,0,0.25)' }),
        stroke: new Stroke({ color: '#ff9800', width: 2.5 }),
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color: '#ff9800' }),
          stroke: new Stroke({ color: '#fff', width: 1.5 }),
        }),
      }),
      zIndex: 11,   // always above project features
    })
    selectLayer.current = selLayer

    const measureSrc = new VectorSource()
    const ml = new VectorLayer({
      source: measureSrc,
      style: new Style({
        stroke: new Stroke({ color: '#ff5722', width: 2, lineDash: [6, 4] }),
        fill: new Fill({ color: 'rgba(255,87,34,0.1)' }),
        image: new CircleStyle({ radius: 4, fill: new Fill({ color: '#ff5722' }) }),
      }),
      zIndex: 3,
    })
    measureLayer.current = ml

    const bufferSrc = new VectorSource()
    const bl = new VectorLayer({
      source: bufferSrc,
      zIndex: 4,
      style: (feature) => {
        if (feature.get('_type') === 'center') {
          return new Style({
            image: new CircleStyle({
              radius: 8,
              fill: new Fill({ color: '#ff1744' }),
              stroke: new Stroke({ color: '#fff', width: 2 }),
            }),
          })
        }
        return undefined
      },
    })
    bufferLayer.current = bl

    // Enhanced click handler that works with all layers including external layers
    const handleMapClick = (e: any) => {
      const pixel = e.pixel
      let featureFound = false

      const map = mapInstance.current
      if (!map) return

      map.forEachFeatureAtPixel(pixel, (feature: any, layer: any) => {
        if (featureFound) return

        // Skip internal/utility layers
        if (layer === boundaryLayer || layer === bl) return
        // Skip measure layer and select layer (no useful attributes)
        if (layer === ml || layer === selLayer) return

        const props = feature.getProperties()
        const displayProps: Record<string, unknown> = { ...props }
        delete displayProps.geometry

        // Determine layer type and label for the modal header
        let layerLabel = 'Feature'
        let layerType = 'project'
        if (layer) {
          const tempId = layer.get('_tempLayerId')
          const extKey = layer.get('_extLayerKey')
          if (tempId != null) {
            layerType = 'temp'
            layerLabel = `Temp Layer #${tempId}`
          } else if (extKey != null) {
            layerType = 'external'
            layerLabel = `External Layer (${extKey})`
          } else if (displayProps.layer_name) {
            layerType = 'project'
            layerLabel = String(displayProps.layer_name)
          }
        }

        setFeatureInfo(displayProps)
        setFeatureModalMeta({ layerLabel, layerType })
        setDrawerOpen(true)
        featureFound = true
      })
    }

    const identifySelect = new SelectInteraction({
      condition: click,
      layers: [vl],
      style: new Style({
        fill: new Fill({ color: 'rgba(21,101,192,0.3)' }),
        stroke: new Stroke({ color: '#1565c0', width: 2.5 }),
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color: '#1565c0' }),
          stroke: new Stroke({ color: '#fff', width: 1.5 }),
        }),
      }),
    })
    identifySelect.on('select', (e) => {
      if (e.selected.length > 0) {
        const props = e.selected[0].getProperties()
        const displayProps: Record<string, unknown> = { ...props }
        delete displayProps.geometry
        const layerLabel = displayProps.layer_name ? String(displayProps.layer_name) : 'Feature'
        setFeatureInfo(displayProps)
        setFeatureModalMeta({ layerLabel, layerType: 'project' })
        setDrawerOpen(true)
      }
    })

    const map = new Map({
      target: mapRef.current,
      layers: [bm, boundaryLayer, vl, selLayer, ml, bl],
      view: new View({ center: INDIA_CENTER, zoom: 5 }),
      controls: defaultControls({ zoom: false }).extend([new ScaleLine({ units: 'metric' })]),
    })
    map.addInteraction(identifySelect)
    
    // Add generic click handler for external layers and other features
    map.on('singleclick', handleMapClick)

    map.on('pointermove', (e) => {
      setMapCoords(e.coordinate as [number, number])
    })

    mapInstance.current = map

    // Extent history tracking
    map.getView().on('change:center', () => {
      const v = map.getView()
      const entry = { center: v.getCenter()!, zoom: v.getZoom()! }
      extentHistory.current = extentHistory.current.slice(0, extentHistoryIdx.current + 1)
      extentHistory.current.push(entry)
      extentHistoryIdx.current = extentHistory.current.length - 1
      setCanHistBack(extentHistoryIdx.current > 0)
      setCanHistFwd(false)
    })

    return () => {
      map.setTarget(undefined)
      mapInstance.current = null
    }
  }, [])

  // Sync layerStyles state → ref and push zoom into layer prop for min/max zoom checks
  useEffect(() => {
    layerStylesRef.current = layerStyles
    projectLayer.current?.changed()
  }, [layerStyles])

  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    const listener = () => {
      const z = map.getView().getZoom() ?? 10
      projectLayer.current?.set('_mapZoom', z)
      projectLayer.current?.changed()
    }
    map.getView().on('change:resolution', listener)
    return () => map.getView().un('change:resolution', listener)
  }, [])

  // Auto-load all active external layers on map init
  useEffect(() => {
    if (!mapInstance.current) return
    
    ;(async () => {
      try {
        const res = await api.get('/external/layers/')
        const extLayers = res.data.results ?? res.data
        if (!Array.isArray(extLayers)) return
        
        for (const layer of extLayers) {
          const key = `ext:${layer.id}`
          if (extVisibleIds.has(key)) continue  // Already loaded
          // showExtLayer handles fetching (viewport-based for large layers).
          showExtLayer(key, layer)
        }
      } catch (err) {
        console.warn('⚠️ Failed to fetch external layers:', err)
      }
    })()
  }, [])

  // Update basemap
  useEffect(() => {
    if (!basemapLayer.current) return
    basemapLayer.current.setSource(makeBasemapSource(activeBasemap))
  }, [activeBasemap])

  useEffect(() => {
    if (basemaps && basemaps.length > 0 && !activeBasemap) {
      // Prefer the super-admin-configured default; fall back to first active, then first.
      const pick =
        basemaps.find((b) => b.is_default && b.is_active) ??
        basemaps.find((b) => b.is_active) ??
        basemaps[0]
      setActiveBasemap(pick)
    }
  }, [basemaps])

  // Auto-set folder from active version
  useEffect(() => {
    if (activeVersion) setSelectedFolderId(activeVersion.id)
  }, [activeVersion?.id])

  useEffect(() => {
    setSelectedFolderId(null)
    undoStack.current = []
  }, [selectedProjectId])

  // When a specific survey area is selected, use its active VERSION folder as draw target.
  // Fall back to the area's root folder when no VERSION folder exists — this ensures
  // saved features always land inside selectedAreaFolderIds and appear in the area view.
  useEffect(() => {
    if (selectedSurveyAreaId) {
      setSelectedFolderId(areaActiveFolderId ?? selectedSurveyArea?.folder ?? null)
    } else if (!selectedSurveyAreaId && activeVersion) {
      setSelectedFolderId(activeVersion.id)
    }
  }, [areaActiveFolderId, selectedSurveyAreaId, selectedSurveyArea?.folder])

  // Clear selection and cancel active edit tools when survey area changes.
  // Prevents stale cross-area selections from being edited.
  useEffect(() => {
    selectLayer.current?.getSource()?.clear()
    setSelectedCount(0)
    setMapTool('pan')
  }, [selectedSurveyAreaId])

  // Register collaboration event handler — applies remote edits to the OL source
  useEffect(() => {
    setCollabHandler((event) => {
      const src = projectSource.current
      if (!src) return
      const fmt = new GeoJSON()

      if (event.type === 'feature_created' && event.feature) {
        // Add remote feature to OL source (don't re-add if already there)
        const fid = event.feature.id
        if (fid && src.getFeatureById(fid)) return
        try {
          const olFeat = fmt.readFeature(
            { type: 'Feature', id: fid, geometry: event.feature.geometry, properties: event.feature },
            { featureProjection: 'EPSG:3857' }
          ) as Feature
          olFeat.setId(fid)
          olFeat.set('layer_name', event.feature.layer_name || 'Remote')
          olFeat.set('attributes', event.feature.attributes || {})
          src.addFeature(olFeat)
          qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
        } catch {}
      }

      if (event.type === 'feature_updated' && event.feature_id) {
        const olFeat = src.getFeatureById(event.feature_id)
        if (olFeat && event.geometry) {
          try {
            const newGeom = fmt.readGeometry(event.geometry, { featureProjection: 'EPSG:3857' })
            olFeat.setGeometry(newGeom)
          } catch {}
        }
        qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
      }

      if (event.type === 'feature_deleted' && event.feature_id) {
        const olFeat = src.getFeatureById(event.feature_id)
        if (olFeat) src.removeFeature(olFeat)
        qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
      }
    })
  }, [setCollabHandler, selectedProjectId, qc])

  // Load project features into OL layer (filtered to selected area)
  // Diff-based: add features not yet on map, remove features no longer visible.
  // Never calls src.clear() — prevents drawn-but-unsaved features from flickering
  // and avoids the "feature disappears after save" race with the query refetch.
  useEffect(() => {
    const src = projectLayer.current?.getSource()
    if (!src) return
    const fmt = new GeoJSON()
    const visibleIdSet = new Set(visibleFeatures.map(f => f.id))

    // Remove OL features that no longer belong in the current view.
    // Only touch features with numeric IDs (= saved to backend).
    // Features with string/undefined IDs are unsaved draws — leave them alone.
    src.getFeatures().forEach(feat => {
      const id = feat.getId()
      if (typeof id === 'number' && !visibleIdSet.has(id)) {
        src.removeFeature(feat)
      }
    })

    // Add backend features not already present in the source
    const existingIds = new Set(src.getFeatures().map(f => f.getId()))
    visibleFeatures.forEach(f => {
      if (existingIds.has(f.id)) return
      try {
        const olFeature = fmt.readFeature(
          {
            type: 'Feature',
            geometry: f.geometry,
            properties: { ...f.attributes, id: f.id, layer_name: f.layer_name, feature_id: f.feature_id, folder: f.folder },
          },
          { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }
        ) as Feature
        olFeature.setId(f.id)
        src.addFeature(olFeature)
      } catch (_) {}
    })
  }, [visibleFeatures])

  // Simplified DGDE/PDDE viewer: frame the picked office's published features once loaded.
  useEffect(() => {
    if (!simplified) return
    const src = projectLayer.current?.getSource()
    const map = mapInstance.current
    if (!src || !map || visibleFeatures.length === 0) return
    const ext = src.getExtent()
    if (ext && ext[0] !== Infinity) {
      map.getView().fit(ext, { padding: [60, 60, 60, 60], maxZoom: 17, duration: 500 })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simplified, officeFilter, visibleFeatures.length])

  // Sync COG layers
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    const currentIds = new Set(geotiffs.map((g) => g.id))
    Object.entries(cogLayers.current).forEach(([idStr, layer]) => {
      const id = Number(idStr)
      if (!currentIds.has(id)) {
        map.removeLayer(layer)
        delete cogLayers.current[id]
      }
    })
    geotiffs.forEach((g) => {
      if (!g.cog_url || cogLayers.current[g.id]) return
      const src = new GeoTIFFSource({ sources: [{ url: g.cog_url }] })
      const visible = g.is_visible !== false
      const layer = new WebGLTileLayer({ source: src, opacity: g.opacity, zIndex: 2, visible })
      map.addLayer(layer)
      cogLayers.current[g.id] = layer
      setCogOpacities((prev) => ({ ...prev, [g.id]: g.opacity }))
      setCogVisible((prev) => ({ ...prev, [g.id]: visible }))
    })
  }, [geotiffs])

  // Sync cogVisible state to OL layers
  useEffect(() => {
    Object.entries(cogVisible).forEach(([idStr, vis]) => {
      cogLayers.current[Number(idStr)]?.setVisible(vis)
    })
  }, [cogVisible])

  // Shared helper: render buffer rings onto the buffer layer
  function renderBufferRings(rings: BufferRingResult[], centerPt?: [number, number]) {
    const fmt = new GeoJSON()
    const src = bufferLayer.current?.getSource()
    src?.clear()
    if (centerPt) {
      const [lng, lat] = centerPt
      const [x, y] = fromLonLat([lng, lat])
      src?.addFeature(new Feature({ geometry: new OLPoint([x, y]), _type: 'center' }))
    }
    rings.forEach((ring, idx) => {
      const color = BUFFER_COLORS[idx % BUFFER_COLORS.length]
      const f = fmt.readFeature(ring.buffer_geojson, {
        dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
      }) as Feature
      f.setStyle(new Style({
        fill: new Fill({ color: color + '22' }),
        stroke: new Stroke({ color, width: 2, lineDash: [8, 4] }),
      }))
      src?.addFeature(f)
      ring.parcels.forEach((p) => {
        const pf = fmt.readFeature(p.geometry, {
          dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
        }) as Feature
        pf.setStyle(new Style({
          fill: new Fill({ color: 'rgba(244,67,54,0.2)' }),
          stroke: new Stroke({ color: '#f44336', width: 1.5 }),
        }))
        src?.addFeature(pf)
      })
    })
  }

  // Feature / layer buffer runner (no map click needed)
  function runFeatureBuffer() {
    if (!selectedProjectId) { message.warning('Select a project first'); return }
    const payload: Record<string, unknown> = {
      distances: bufferDistances, unit: bufferUnit, dissolve: bufferDissolve,
    }
    if (bufferMode === 'layer') {
      if (!bufferLayerName) { message.warning('Select a layer'); return }
      payload.layer_name = bufferLayerName
      payload.project_id = selectedProjectId
    } else {
      // feature mode — use selected OL features
      const selSrc = selectLayer.current?.getSource()
      const ids = (selSrc?.getFeatures() ?? []).map((f) => f.getId()).filter(Boolean)
      if (ids.length === 0) {
        message.warning('No features selected. Use Box Select or Identify tool first.')
        return
      }
      payload.feature_ids = ids
    }
    const src = bufferLayer.current?.getSource()
    src?.clear()
    setBufferLoading(true)
    api.post('/projects/buffer/', payload)
      .then((r) => {
        const resp = r.data as { center_lng: number; center_lat: number; rings: BufferRingResult[] }
        const rings = resp.rings ?? (Array.isArray(r.data) ? r.data : [])
        setBufferResults(rings)
        renderBufferRings(rings)
        setBufferModalOpen(true)
      })
      .catch((err) => message.error(err?.response?.data?.detail || 'Buffer analysis failed'))
      .finally(() => setBufferLoading(false))
  }

  // Buffer click handler — point mode only
  useEffect(() => {
    const map = mapInstance.current
    if (!map || mapTool !== 'buffer' || bufferMode !== 'point') return

    function handleClick(e: any) {
      const [clickLng, clickLat] = toLonLat(e.coordinate as [number, number])
      const src = bufferLayer.current?.getSource()
      src?.clear()
      src?.addFeature(new Feature({ geometry: new OLPoint(e.coordinate), _type: 'center' }))
      setBufferLoading(true)
      api.post('/projects/buffer/', { lng: clickLng, lat: clickLat, distances: bufferDistances, unit: bufferUnit, dissolve: bufferDissolve })
        .then((r) => {
          const resp = r.data as { center_lng: number; center_lat: number; rings: BufferRingResult[] }
          const rings = resp.rings ?? (Array.isArray(r.data) ? r.data : [])
          const centerLng = resp.center_lng ?? clickLng
          const centerLat = resp.center_lat ?? clickLat
          src?.clear()
          src?.addFeature(new Feature({ geometry: new OLPoint(fromLonLat([centerLng, centerLat])), _type: 'center' }))
          setBufferPoint([centerLng, centerLat])
          setBufferResults(rings)
          renderBufferRings(rings, [centerLng, centerLat])
          setBufferModalOpen(true)
        })
        .catch((err) => { message.error(err?.response?.data?.detail || 'Buffer analysis failed') })
        .finally(() => { setBufferLoading(false) })
    }

    map.on('singleclick', handleClick as any)
    return () => { map.un('singleclick', handleClick as any) }
  }, [mapTool, bufferDistances, bufferUnit, bufferDissolve, bufferMode])

  // ── Temporary layer show/hide ──────────────────────────────────────────────
  function showTempLayer(id: number, geojson: Record<string, unknown>) {
    const map = mapInstance.current
    if (!map) return
    // Remove existing if already shown
    if (tempLayerRefs.current[id]) {
      map.removeLayer(tempLayerRefs.current[id])
    }
    const color = getTempLayerColor(id)
    const src = new VectorSource({ features: new GeoJSON().readFeatures(geojson, { featureProjection: 'EPSG:3857' }) })
    // Convert hex color to rgba for semi-transparent fill
    const hexToRgba = (hex: string, alpha: number) => {
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      return `rgba(${r},${g},${b},${alpha})`
    }
    const lyr = new VectorLayer({
      source: src,
      style: (feat) => {
        const geomType = feat.getGeometry()?.getType() ?? ''
        const stroke = new Stroke({ color, width: 2.5 })
        if (geomType === 'Point' || geomType === 'MultiPoint') {
          return new Style({ image: new CircleStyle({ radius: 7, stroke, fill: new Fill({ color }) }) })
        }
        return new Style({ stroke, fill: new Fill({ color: hexToRgba(color, 0.18) }) })
      },
      zIndex: 80,
      properties: { _tempLayerId: id },
    })
    map.addLayer(lyr)
    tempLayerRefs.current[id] = lyr
    setTempVisibleIds(prev => new Set([...prev, id]))
    // Fit view to the layer extent
    const extent = src.getExtent()
    if (extent && extent[0] !== Infinity) {
      map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 17, duration: 500 })
    }
  }

  function hideTempLayer(id: number) {
    const map = mapInstance.current
    if (!map) return
    if (tempLayerRefs.current[id]) {
      map.removeLayer(tempLayerRefs.current[id])
      delete tempLayerRefs.current[id]
    }
    setTempVisibleIds(prev => { const s = new Set(prev); s.delete(id); return s })
  }

  // ── External DB layer show/hide (read-only, no edit controls) ─────────────
  // Small layers load fully once; large layers (> EXT_BBOX_THRESHOLD) load by
  // viewport (bbox) on every pan/zoom and are gated below the layer's min_zoom.
  function showExtLayer(key: string, layer?: ExtLayerConfig) {
    const map = mapInstance.current
    if (!map || !layer) return
    // Clean any prior instance (layer + moveend listener)
    if (extLayerRefs.current[key]) map.removeLayer(extLayerRefs.current[key])
    if (extMoveKeys.current[key]) { unByKey(extMoveKeys.current[key]); delete extMoveKeys.current[key] }

    const src = new VectorSource()
    const lyr = new VectorLayer({
      source: src,
      style: makeExtStyle(layer),
      zIndex: 75,
      properties: { _extLayerKey: key, _readOnly: true },
    })
    map.addLayer(lyr)
    extLayerRefs.current[key] = lyr
    setExtVisibleIds(prev => new Set([...prev, key]))

    const legend = makeExtLegend(layer)
    setExtClassLegends(prev => {
      const next = { ...prev }
      if (legend) next[key] = legend; else delete next[key]
      return next
    })

    const count = layer.feature_count ?? 0
    const useBbox = count > EXT_BBOX_THRESHOLD
    const minZoom = layer.min_zoom ?? 0

    const loadFeatures = async (withBbox: boolean) => {
      const view = map.getView()
      const params: Record<string, unknown> = {}
      if (withBbox) {
        if ((view.getZoom() ?? 0) < minZoom) { src.clear(); return }  // zoom gating
        const ext4326 = transformExtent(
          view.calculateExtent(map.getSize()), 'EPSG:3857', 'EPSG:4326',
        )
        params.bbox = ext4326.join(',')
        params.limit = 50000
      } else {
        params.limit = Math.min(Math.max(count + 100, 20000), 200000)
      }
      try {
        const r = await api.get(`/external/layers/${layer.id}/geojson/`, { params })
        const feats = new GeoJSON().readFeatures(r.data, { featureProjection: 'EPSG:3857' })
        src.clear()
        src.addFeatures(feats)
      } catch { /* leave existing features on transient error */ }
    }

    if (useBbox) {
      // Fit to the layer's stored extent (if known) before the first viewport load
      if (layer.bbox && layer.bbox.length === 4) {
        const ext = transformExtent(layer.bbox as number[], 'EPSG:4326', 'EPSG:3857')
        if (ext[0] !== Infinity) map.getView().fit(ext, { padding: [40, 40, 40, 40], maxZoom: 14, duration: 400 })
      }
      const handler = debounce(() => loadFeatures(true), 350)
      extMoveKeys.current[key] = map.on('moveend', handler)
      loadFeatures(true)
    } else {
      loadFeatures(false).then(() => {
        const extent = src.getExtent()
        if (extent && extent[0] !== Infinity) {
          map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 16, duration: 500 })
        }
      })
    }
  }

  function hideExtLayer(key: string) {
    const map = mapInstance.current
    if (!map) return
    if (extMoveKeys.current[key]) { unByKey(extMoveKeys.current[key]); delete extMoveKeys.current[key] }
    if (extLayerRefs.current[key]) {
      map.removeLayer(extLayerRefs.current[key])
      delete extLayerRefs.current[key]
    }
    setExtVisibleIds(prev => { const s = new Set(prev); s.delete(key); return s })
    setExtClassLegends(prev => { const n = { ...prev }; delete n[key]; return n })
  }

  /** Re-apply a layer's style live (no feature reload). Used by the style editor. */
  function restyleExtLayer(key: string, layer: ExtLayerConfig) {
    const lyr = extLayerRefs.current[key]
    if (!lyr) return
    lyr.setStyle(makeExtStyle(layer))
    lyr.changed()
    const legend = makeExtLegend(layer)
    setExtClassLegends(prev => {
      const next = { ...prev }
      if (legend) next[key] = legend; else delete next[key]
      return next
    })
  }

  // ── External-layer keyword search ─────────────────────────────────────────
  const runExtSearch = useMemo(() => debounce(async (q: string) => {
    if (q.trim().length < 2) { setExtSearchResults([]); setExtSearchLoading(false); return }
    setExtSearchLoading(true)
    try {
      const r = await api.get('/external/layers/search/', { params: { q: q.trim() } })
      setExtSearchResults(r.data?.results ?? [])
    } catch {
      setExtSearchResults([])
    } finally {
      setExtSearchLoading(false)
    }
  }, 350), [])

  function flyToSearchResult(res: ExtSearchResult) {
    const map = mapInstance.current
    if (!map || !res.geometry) return
    let feat: Feature
    try {
      feat = new GeoJSON().readFeature(res.geometry, {
        dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
      }) as Feature
    } catch { return }

    // Lazily create a dedicated highlight layer above everything
    if (!searchHighlightLayer.current) {
      searchHighlightLayer.current = new VectorLayer({
        source: new VectorSource(),
        zIndex: 999,
        style: new Style({
          stroke: new Stroke({ color: '#ffeb3b', width: 3 }),
          fill: new Fill({ color: 'rgba(255,235,59,0.25)' }),
          image: new CircleStyle({ radius: 8, stroke: new Stroke({ color: '#ffeb3b', width: 3 }),
                                   fill: new Fill({ color: 'rgba(255,235,59,0.5)' }) }),
        }),
      })
      map.addLayer(searchHighlightLayer.current)
    }
    const hsrc = searchHighlightLayer.current.getSource()!
    hsrc.clear()
    hsrc.addFeature(feat)

    const extent = feat.getGeometry()?.getExtent()
    if (extent && extent[0] !== Infinity) {
      map.getView().fit(extent, { padding: [80, 80, 80, 80], maxZoom: 18, duration: 600 })
    }
    // Auto-clear the highlight after a few seconds
    window.setTimeout(() => { try { hsrc.clear() } catch { /* noop */ } }, 6000)
  }

  // DragBox (box select) interaction
  useEffect(() => {
    const map = mapInstance.current
    if (!map || mapTool !== 'box_select') return
    if (isOverviewMode) {
      message.warning('Select a survey area first to use Box Select.')
      setMapTool('pan')
      return
    }
    const src = projectLayer.current?.getSource()
    const selSrc = selectLayer.current?.getSource()
    if (!src || !selSrc) return

    const dragBox = new DragBox({})
    dragBox.on('boxend', () => {
      const extent = dragBox.getGeometry().getExtent()
      const selected: Feature[] = []
      src.forEachFeatureIntersectingExtent(extent, (f) => selected.push(f as Feature))
      selSrc.clear()
      selected.forEach((f) => {
        const clone = f.clone()
        clone.setId(f.getId())   // OL clone() does not copy the feature ID — restore it
        selSrc.addFeature(clone)
      })
      setSelectedCount(selected.length)
      if (selected.length > 0) {
        // Auto-resume Move if box_select was triggered from Move Feature
        if (pendingMoveRef.current) {
          pendingMoveRef.current = false
          setMapTool('move_feature')
        } else {
          message.info(`${selected.length} feature(s) selected`)
        }
      } else {
        message.warning('No features found in selection box')
      }
    })

    map.addInteraction(dragBox)
    dragBoxInteraction.current = dragBox
    return () => {
      map.removeInteraction(dragBox)
      dragBoxInteraction.current = null
      // Do NOT clear selSrc here — selection must persist so Move/Copy/Rotate can use it
    }
  }, [mapTool])

  // Clear box-selection when switching to tools that don't use it
  const SELECTION_TOOLS = new Set(['box_select', 'move_feature', 'copy_move', 'rotate_feature', 'scale_feature', 'identify', 'buffer', 'attribute_select', 'spatial_select'])
  useEffect(() => {
    if (!SELECTION_TOOLS.has(mapTool)) {
      selectLayer.current?.getSource()?.clear()
      setSelectedCount(0)
    }
  }, [mapTool])

  // Click-to-delete handler — fires when delete_feature is active and no features pre-selected
  useEffect(() => {
    const map = mapInstance.current
    const src = projectLayer.current?.getSource()
    if (!map || mapTool !== 'delete_feature' || !src || isReadOnly) return

    const mapRef2 = map   // non-null local for closure

    function handleClick(e: any) {
      const hit = mapRef2.forEachFeatureAtPixel(
        e.pixel,
        (f) => f,
        { layerFilter: (l) => l === projectLayer.current },
      ) as Feature | undefined

      if (!hit) {
        message.info('No feature at that location — click directly on a feature to delete it')
        return
      }
      const id = hit.getId()
      const folderId = hit.get('folder') as number | null
      const layerName = hit.get('layer_name') ?? 'feature'
      if (isFeatureFolderLocked(folderId)) {
        const area = findAreaForFolder(folderId)
        message.error(
          `This feature belongs to "${area?.name ?? 'a survey area'}" (${area?.status ?? 'locked'}) — deletion not allowed.`,
          4
        )
        return
      }
      Modal.confirm({
        title: 'Delete feature?',
        content: `Layer: ${layerName}. This cannot be undone.`,
        okText: 'Delete', okButtonProps: { danger: true },
        onOk: async () => {
          await api.delete(`/projects/features/${id}/`).catch(() => {})
          qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
          if (typeof id === 'number') wsSendDeleted(id)
          message.success('Feature deleted')
        },
      })
    }

    map.on('singleclick', handleClick as any)
    return () => { map.un('singleclick', handleClick as any) }
  }, [mapTool, selectedProjectId, wsSendDeleted])

  // Coordinate picker click handler
  useEffect(() => {
    const map = mapInstance.current
    if (!map || mapTool !== 'coord_picker') return
    function handleClick(e: any) {
      const [lon, lat] = toLonLat(e.coordinate as [number, number])
      setCoordResult({ lat, lon })
      setCoordModalOpen(true)
    }
    map.on('singleclick', handleClick as any)
    return () => { map.un('singleclick', handleClick as any) }
  }, [mapTool])

  // Heatmap layer toggle
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    if (!heatmapVisible) {
      if (heatmapLayerRef.current) {
        map.removeLayer(heatmapLayerRef.current)
        heatmapLayerRef.current = null
      }
      return
    }
    setHeatmapLoading(true)
    const url = selectedProjectId
      ? `/gis/heatmap/?project=${selectedProjectId}`
      : '/gis/heatmap/'
    api.get(url).then((r) => {
      const raw = Array.isArray(r.data) ? r.data : (r.data?.results ?? [])
      if (!raw.length) { message.info('No point features found for heatmap'); return }
      const points: { lat: number; lon: number; weight: number }[] = raw
      const src = new VectorSource({
        features: points.map((p) => {
          const f = new Feature({ geometry: new OLPoint(fromLonLat([p.lon, p.lat])) })
          f.set('weight', Math.min(1, (p.weight ?? 1) / 10000))
          return f
        }),
      })
      const layer = new HeatmapLayer({ source: src as any, blur: 20, radius: 14, weight: (f) => f.get('weight'), zIndex: 6 })
      if (heatmapLayerRef.current) map.removeLayer(heatmapLayerRef.current)
      heatmapLayerRef.current = layer
      map.addLayer(layer)
    }).catch((e) => { message.error(e?.response?.data?.detail || 'Failed to load heatmap data') })
    .finally(() => setHeatmapLoading(false))
  }, [heatmapVisible])

  // Sync graduatedRules state → ref
  useEffect(() => {
    graduatedRulesRef.current = graduatedRules
  }, [graduatedRules])

  // Graticule
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    if (graticuleVisible) {
      if (!graticuleRef.current) {
        const g = new Graticule({
          strokeStyle: new Stroke({ color: '#4fc3f733', width: 0.5, lineDash: [4, 4] }),
          showLabels: true,
          wrapX: false,
          zIndex: 12,
        })
        graticuleRef.current = g
        map.addLayer(g)
      }
    } else {
      if (graticuleRef.current) {
        map.removeLayer(graticuleRef.current)
        graticuleRef.current = null
      }
    }
  }, [graticuleVisible])

  // Map Lock
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    map.getInteractions().forEach((i) => {
      const name = i.constructor.name
      if (['DragPan', 'MouseWheelZoom', 'PinchZoom', 'DoubleClickZoom', 'KeyboardPan', 'KeyboardZoom'].includes(name)) {
        i.setActive(!mapLocked)
      }
    })
  }, [mapLocked])

  // Select by location
  useEffect(() => {
    const map = mapInstance.current
    if (!map || mapTool !== 'select_location') return
    const draw = new Draw({ type: 'Polygon', source: new VectorSource() })
    selectLocationDraw.current = draw
    draw.on('drawend', (e) => {
      const geom = e.feature.getGeometry() as Polygon
      const src = projectLayer.current?.getSource()
      if (!src) return
      const selected: Feature[] = []
      src.getFeatures().forEach((f) => {
        const fg = f.getGeometry()
        if (fg && geom.intersectsExtent(fg.getExtent())) {
          selected.push(f)
        }
      })
      selectLayer.current?.getSource()?.clear()
      selectLayer.current?.getSource()?.addFeatures(selected)
      setSelectedCount(selected.length)
      message.info(`Selected ${selected.length} feature(s) by location`)
      setMapTool('pan')
    })
    map.addInteraction(draw)
    return () => {
      map.removeInteraction(draw)
      selectLocationDraw.current = null
    }
  }, [mapTool])

  // Swipe
  useEffect(() => {
    const map = mapInstance.current
    if (!map || !swiperActive || !swiperLayer) return
    const layer = projectLayer.current
    if (!layer) return

    function prerender(e: any) {
      const ctx = e.context as CanvasRenderingContext2D
      const size = map!.getSize()!
      const width = size[0] * (swiperPos / 100)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, width, size[1])
      ctx.clip()
    }
    function postrender(e: any) {
      const ctx = e.context as CanvasRenderingContext2D
      ctx.restore()
    }
    layer.on('prerender' as any, prerender)
    layer.on('postrender' as any, postrender)
    map.render()
    return () => {
      layer.un('prerender' as any, prerender)
      layer.un('postrender' as any, postrender)
      map.render()
    }
  }, [swiperActive, swiperLayer, swiperPos])

  // Merge selected features
  async function handleMergeSelected() {
    const selSrc = selectLayer.current?.getSource()
    if (!selSrc) return
    const featureIds: number[] = []
    selSrc.getFeatures().forEach((f) => { const id = f.getId(); if (id) featureIds.push(id as number) })
    if (featureIds.length < 2) { message.warning('Select at least 2 features to merge'); return }
    if (!selectedProjectId) { message.warning('No project selected'); return }
    setMerging(true)
    try {
      await api.post('/projects/features/merge/', { feature_ids: featureIds, project: selectedProjectId })
      message.success(`Merged ${featureIds.length} features`)
      selSrc.clear()
      setSelectedCount(0)
      qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Merge failed')
    } finally {
      setMerging(false)
    }
  }

  // Add WMS layer to map
  function handleAddWmsLayer() {
    if (!wmsUrl || !wmsLayerName) { message.warning('Enter WMS URL and layer name'); return }
    const id = `wms-${Date.now()}`
    const layer = new TileLayer({
      source: new TileWMS({
        url: wmsUrl,
        params: { LAYERS: wmsLayerName, TILED: true, SRS: wmsSrs },
        serverType: 'geoserver',
        crossOrigin: 'anonymous',
      }),
      opacity: 0.75,
      zIndex: 7,
    })
    mapInstance.current?.addLayer(layer)
    wmsLayersRef.current[id] = layer
    setWmsLayerList((prev) => [...prev, { id, title: wmsTitle || wmsLayerName }])
    setWmsModalOpen(false)
    setWmsUrl('')
    setWmsLayerName('')
    setWmsTitle('')
    setWmsSrs('EPSG:4326')
    message.success('WMS layer added')
  }

  function removeWmsLayer(id: string) {
    const layer = wmsLayersRef.current[id]
    if (layer) { mapInstance.current?.removeLayer(layer); delete wmsLayersRef.current[id] }
    setWmsLayerList((prev) => prev.filter((l) => l.id !== id))
  }

  // All write-capable tool keys — blocked when survey area is locked
  const WRITE_TOOLS = new Set([
    'draw_point', 'draw_line', 'draw_polygon',
    'vertex_tool', 'edit_features',
    'move_feature', 'copy_move', 'rotate_feature', 'scale_feature',
    'simplify_feature', 'add_part', 'delete_part', 'reshape_feature',
    'offset_curve', 'reverse_line', 'trim_extend',
    'split_feature', 'split_parts', 'merge_features', 'merge_attributes',
    'delete_feature',
  ])

  // Tool changes (draw, measure, modify)
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return

    // Redirect any write tool back to pan when read-only
    if (isReadOnly && WRITE_TOOLS.has(mapTool)) {
      if (isOverviewMode) {
        message.warning('Select a survey area first to use editing tools.')
      } else {
        message.warning('This survey area is locked — editing is not allowed until it is returned for revision.')
      }
      setMapTool('pan')
      return
    }

    if (drawInteraction.current) { map.removeInteraction(drawInteraction.current); drawInteraction.current = null }
    if (modifyInteraction.current) { map.removeInteraction(modifyInteraction.current); modifyInteraction.current = null }
    if (snapInteraction.current) { map.removeInteraction(snapInteraction.current); snapInteraction.current = null }

    const drawType =
      mapTool === 'draw_point' ? 'Point'
      : mapTool === 'draw_line' ? 'LineString'
      : mapTool === 'draw_polygon' ? 'Polygon'
      : null

    if (mapTool === 'measure' && measureLayer.current) {
      measureLayer.current.getSource()!.clear()
      setMeasureResult(null)
      const draw = new Draw({ source: measureLayer.current.getSource()!, type: 'LineString' })
      draw.on('drawend', (e) => {
        const geom = e.feature.getGeometry() as LineString
        const lengthM = getLength(geom)
        setMeasureResult(`Length: ${(lengthM / 1000).toFixed(3)} km (${lengthM.toFixed(0)} m)`)
      })
      map.addInteraction(draw)
      drawInteraction.current = draw
    }

    // Vertex tool — edit vertices on all features in the project layer
    if (!isReadOnly && (mapTool === 'vertex_tool' || mapTool === 'edit_features') && projectLayer.current) {
      const src = projectLayer.current.getSource()!
      const modify = new Modify({ source: src })
      modify.on('modifyend', (e) => {
        const fmt = new GeoJSON()
        let lockedAlert = false
        e.features.forEach((f: any) => {
          const id = ((f as Feature).getId() ?? (f as Feature).get('id')) as number
          if (!id) return
          const folderId = (f as Feature).get('folder') as number | null
          // Skip features outside the currently selected area
          if (selectedAreaFolderIds && folderId != null && !selectedAreaFolderIds.has(folderId)) return
          if (isFeatureFolderLocked(folderId)) {
            if (!lockedAlert) {
              const area = findAreaForFolder(folderId)
              message.error(
                `This feature belongs to "${area?.name ?? 'a survey area'}" (${area?.status ?? 'locked'}) — editing is not allowed.`,
                4
              )
              lockedAlert = true
            }
            qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
            return
          }
          const gf = fmt.writeFeatureObject(f as Feature, {
            dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
          })
          api.patch(`/projects/features/${id}/`, { geometry: gf.geometry }).catch(() => {})
        })
      })
      map.addInteraction(modify)
      modifyInteraction.current = modify
      const snap = new Snap({ source: src })
      map.addInteraction(snap)
      snapInteraction.current = snap
      message.info('Vertex Tool active — drag vertices to edit, then click away to save', 2)
    }

    // Move Feature — translate only selected features
    if (mapTool === 'move_feature') {
      const selSrc = selectLayer.current?.getSource()
      const selFeats = selSrc?.getFeatures() ?? []
      if (!selFeats.length) {
        pendingMoveRef.current = true
        setMapTool('box_select')
        message.info('Draw a box around the features you want to move — Move will activate automatically', 3)
        return
      }
      const fmt = new GeoJSON()
      // Snapshot pre-move geometries for undo
      const preGeoms = selFeats
        .filter((f) => !!(f.getId() ?? f.get('id')))
        .map((f) => ({
          id: (f.getId() ?? f.get('id')) as number,
          geomGeoJSON: JSON.parse(fmt.writeGeometry(f.getGeometry()!, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })) as Record<string, unknown>,
        }))
      const collection = new Collection(selFeats)
      const translate = new Translate({ features: collection })
      translate.on('translateend', (e) => {
        let lockedAlert = false
        let savedCount = 0
        // Push pre-move snapshot for undo before applying the new positions
        if (preGeoms.length) undoStack.current.push({ type: 'move', geoms: preGeoms })
        e.features.forEach((f: any) => {
          const id = ((f as Feature).getId() ?? (f as Feature).get('id')) as number
          if (!id) return
          const folderId = (f as Feature).get('folder') as number | null
          // Skip features that don't belong to the currently selected area
          if (selectedAreaFolderIds && folderId != null && !selectedAreaFolderIds.has(folderId)) return
          if (isFeatureFolderLocked(folderId)) {
            if (!lockedAlert) {
              const area = findAreaForFolder(folderId)
              message.error(
                `Feature belongs to "${area?.name ?? 'a survey area'}" (${area?.status ?? 'locked'}) — move rejected.`,
                4
              )
              lockedAlert = true
            }
            qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
            return
          }
          const gf = fmt.writeFeatureObject(f as Feature, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
          savedCount++
          api.patch(`/projects/features/${id}/`, { geometry: gf.geometry })
            .then(() => qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] }))
            .catch(() => {})
        })
        if (savedCount > 0) message.success(`Moved ${savedCount} feature(s) — press Undo to restore`)
      })
      map.addInteraction(translate)
      translateRef.current = translate
      message.info('Move active — drag selected features. Press Pan (or Esc) when done.', 3)
    }

    // Copy and Move — clone selected features, then move copies
    if (mapTool === 'copy_move') {
      const selSrc = selectLayer.current?.getSource()
      const selFeats = selSrc?.getFeatures() ?? []
      if (!selFeats.length || !selectedProjectId) {
        message.warning('Box-select features and open a project first'); setMapTool('pan'); return
      }
      const fmt = new GeoJSON()
      const clones = selFeats.map((f) => f.clone())
      const projSrc = projectLayer.current?.getSource()
      if (projSrc) clones.forEach((c) => projSrc.addFeature(c))
      const collection = new Collection(clones)
      const translate = new Translate({ features: collection })
      const copyFolderId = selectedFolderId ?? selectedSurveyArea?.folder ?? null
      translate.on('translateend', async (e) => {
        const saved: GISFeature[] = []
        for (const f of e.features.getArray() as Feature[]) {
          const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
          await api.post('/projects/features/', {
            project: selectedProjectId,
            folder: copyFolderId,
            layer_name: f.get('layer_name') ?? 'polygon_layer',
            geometry_type: gf.geometry?.type?.toUpperCase() === 'POINT' ? 'POINT' : gf.geometry?.type?.toUpperCase() === 'LINESTRING' ? 'LINE' : 'POLYGON',
            geometry: gf.geometry, attributes: {},
            ...(isCantonmentUploader ? { deo_visible: deoVisibleRef.current } : {}),
          }).then((r) => { f.setId(r.data.id); saved.push(r.data) }).catch(() => {})
        }
        qc.setQueryData<GISFeature[]>(['map-features', selectedProjectId], (old) =>
          old ? [...old, ...saved] : saved
        )
        message.success(`Copied & moved ${clones.length} feature(s)`)
        setMapTool('pan')
      })
      map.addInteraction(translate)
      translateRef.current = translate
      message.info('Copy+Move active — drag the copied features to position.', 3)
    }

    // Rotate, Scale, Simplify, Offset — open the respective modal, interaction happens on confirm
    if (mapTool === 'rotate_feature') {
      const selSrc = selectLayer.current?.getSource()
      if (!selSrc?.getFeatures().length) { message.warning('Select features first'); setMapTool('pan'); return }
      setRotateAngle(0)
      setRotateModalOpen(true)
      setMapTool('pan')
      return
    }

    if (mapTool === 'scale_feature') {
      const selSrc = selectLayer.current?.getSource()
      if (!selSrc?.getFeatures().length) { message.warning('Select features first'); setMapTool('pan'); return }
      setScaleFactor(1.0)
      setScaleModalOpen(true)
      setMapTool('pan')
      return
    }

    if (mapTool === 'simplify_feature') {
      const selSrc = selectLayer.current?.getSource()
      if (!selSrc?.getFeatures().length) { message.warning('Select features first'); setMapTool('pan'); return }
      setSimplifyTolerance(0.5)
      setSimplifyModalOpen(true)
      setMapTool('pan')
      return
    }

    if (mapTool === 'offset_curve') {
      const selSrc = selectLayer.current?.getSource()
      if (!selSrc?.getFeatures().length) { message.warning('Select a line feature first'); setMapTool('pan'); return }
      setOffsetDistance(10)
      setOffsetModalOpen(true)
      setMapTool('pan')
      return
    }

    // Reverse Line direction
    if (mapTool === 'reverse_line') {
      const selSrc = selectLayer.current?.getSource()
      const feats = selSrc?.getFeatures() ?? []
      const lineFts = feats.filter((f) => {
        const g = f.getGeometry()
        return g?.getType() === 'LineString' || g?.getType() === 'MultiLineString'
      })
      if (!lineFts.length) { message.warning('Select a line feature first'); setMapTool('pan'); return }
      const fmt = new GeoJSON()
      lineFts.forEach((f) => {
        const id = (f.getId() ?? f.get('id')) as number
        if (!id) return
        const g = f.getGeometry()
        if (g?.getType() === 'LineString') {
          const ls = g as LineString
          ls.setCoordinates([...ls.getCoordinates()].reverse())
        }
        const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
        api.patch(`/projects/features/${id}/`, { geometry: gf.geometry })
          .then(() => qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] }))
          .catch(() => {})
      })
      message.success(`Reversed ${lineFts.length} line(s)`)
      setMapTool('pan')
      return
    }

    // Split Parts (explode multi-geometry to single parts)
    if (mapTool === 'split_parts') {
      const selSrc = selectLayer.current?.getSource()
      const ids = (selSrc?.getFeatures().map((f) => f.getId()).filter(Boolean) as number[]) ?? []
      if (!ids.length) { message.warning('Select features first'); setMapTool('pan'); return }
      Modal.confirm({
        title: `Explode ${ids.length} feature(s) to single parts?`,
        content: 'Multi-geometry features will be split into individual features.',
        onOk: async () => {
          let total = 0
          for (const id of ids) {
            try {
              const r = await api.post(`/projects/features/${id}/split-parts/`)
              total += r.data.count ?? 1
            } catch { /* skip */ }
          }
          selSrc?.clear(); setSelectedCount(0)
          qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
          message.success(`Exploded to ${total} parts`)
        },
      })
      setMapTool('pan')
      return
    }

    // Merge Attributes only (keep first feature, copy attributes from others)
    if (mapTool === 'merge_attributes') {
      const selSrc = selectLayer.current?.getSource()
      const feats = selSrc?.getFeatures() ?? []
      if (feats.length < 2) { message.warning('Select 2+ features to merge attributes'); setMapTool('pan'); return }
      const ids = feats.map((f) => f.getId()).filter(Boolean) as number[]
      api.post('/projects/features/merge-attributes/', {
        project: selectedProjectId, feature_ids: ids,
      }).then(() => {
        qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
        message.success('Attributes merged')
      }).catch((e) => message.error(e?.response?.data?.detail || 'Merge attributes failed'))
      setMapTool('pan')
      return
    }

    // Delete Feature(s) — if already selected show confirm; otherwise stay active for click-to-delete
    if (mapTool === 'delete_feature') {
      const selSrc = selectLayer.current?.getSource()
      const ids = (selSrc?.getFeatures().map((f) => f.getId()).filter(Boolean) as number[]) ?? []
      if (ids.length > 0) {
        Modal.confirm({
          title: `Delete ${ids.length} selected feature(s)?`,
          content: 'This action cannot be undone.',
          okText: 'Delete', okButtonProps: { danger: true },
          onOk: async () => {
            await Promise.all(ids.map((id) => api.delete(`/projects/features/${id}/`).catch(() => {})))
            selSrc?.clear(); setSelectedCount(0)
            qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
            message.success(`Deleted ${ids.length} feature(s)`)
          },
          onCancel: () => setMapTool('pan'),
        })
        setMapTool('pan')
      }
      // else: no selection yet — stay in delete mode; the dedicated click-to-delete
      // useEffect below will handle single-click deletion
      return
    }

    // Stubs for complex tools not yet fully implemented
    if (mapTool === 'add_part') {
      message.info('Add Part: select a multi-geometry feature, then draw the new part')
      // TODO: Draw + attach to existing multi-geometry via API
    }
    if (mapTool === 'delete_part') {
      message.info('Delete Part: click a part of a multi-geometry feature to remove it')
      // TODO: Click handler to identify and remove a sub-geometry
    }
    if (mapTool === 'reshape_feature') {
      message.info('Reshape: draw a line that crosses the feature boundary to reshape it')
      // TODO: Custom reshape interaction
    }
    if (mapTool === 'trim_extend') {
      message.info('Trim/Extend: click a reference line, then click the line to trim/extend')
      // TODO: Custom trim/extend interaction
    }

    if (mapTool === 'split_feature' && projectLayer.current) {
      if (!selectedProjectId) { message.warning('Select a project before splitting'); return }
      const src = projectLayer.current.getSource()!
      const draw = new Draw({ source: measureLayer.current!.getSource()!, type: 'LineString' })
      draw.on('drawend', (e) => {
        const fmt = new GeoJSON()
        const splitLine = fmt.writeFeatureObject(e.feature, {
          dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
        })
        const selSrc = selectLayer.current?.getSource()
        const selFeatures = selSrc?.getFeatures() ?? []
        const targets = selFeatures.length > 0
          ? selFeatures.map((f) => f.getId()).filter(Boolean) as number[]
          : (src.getFeatures().map((f) => f.getId()).filter(Boolean) as number[]).slice(0, 1)
        if (targets.length === 0) { message.warning('No feature selected to split'); return }
        Promise.all(
          targets.map((id) =>
            api.post(`/projects/features/${id}/split/`, { split_line: splitLine.geometry })
          )
        ).then(() => {
          message.success('Feature split successfully')
          measureLayer.current?.getSource()?.clear()
          selSrc?.clear()
          setSelectedCount(0)
          qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
        }).catch((err) => message.error(err?.response?.data?.detail || 'Split failed'))
      })
      map.addInteraction(draw)
      drawInteraction.current = draw
      message.info('Draw a line to split selected/first feature')
      return
    }

    if (mapTool === 'merge_features') {
      handleMergeSelected()
      setMapTool('pan')
      return
    }

    if (drawType && projectLayer.current && !isReadOnly) {
      const src = projectLayer.current.getSource()!
      const draw = new Draw({ source: src, type: drawType as 'Point' | 'LineString' | 'Polygon' })

      // Live measure feedback
      if (drawType === 'Polygon') {
        draw.on('drawstart', (e) => {
          e.feature.getGeometry()!.on('change', () => {
            const geom = e.feature.getGeometry() as Polygon
            const area = getArea(geom)
            if (area > 0) setMeasureResult(`Area: ${(area / 10000).toFixed(3)} ha`)
          })
        })
      } else if (drawType === 'LineString') {
        draw.on('drawstart', (e) => {
          e.feature.getGeometry()!.on('change', () => {
            const geom = e.feature.getGeometry() as LineString
            const len = getLength(geom)
            if (len > 0) setMeasureResult(`Length: ${(len / 1000).toFixed(3)} km`)
          })
        })
      }

      draw.on('drawend', (e) => {
        setMeasureResult(null)
        if (!selectedProjectId) { message.warning('Select a project before drawing features'); return }
        pendingDrawFeatureRef.current = e.feature
        pendingDrawTypeRef.current = drawType

        // When an active layer is preset (from "New Layer" flow), skip the chooser modal.
        // Use the ref so we always get the current value even after re-renders.
        const preset = activeDrawLayerRef.current
        if (preset) {
          saveDrawnFeature(preset.name, preset.folderId)
          return
        }

        // Otherwise open the layer chooser as usual
        const defaultLayer = drawType === 'Point' ? 'point_layer' : drawType === 'LineString' ? 'line_layer' : 'polygon_layer'
        setDrawExistingLayer(defaultLayer)
        setDrawNewLayerName(defaultLayer)
        setDrawLayerChoice(editableLayerNames.length > 0 ? 'existing' : 'new')
        setDrawLayerModal(true)
      })

      map.addInteraction(draw)
      drawInteraction.current = draw

      // Snap to existing features when drawing
      const snap = new Snap({ source: src })
      map.addInteraction(snap)
      snapInteraction.current = snap
    }
  }, [mapTool, selectedProjectId, selectedFolderId, isReadOnly])

  const handleZoom = useCallback((delta: number) => {
    const view = mapInstance.current?.getView()
    if (view) view.setZoom((view.getZoom() ?? 5) + delta)
  }, [])

  const onFeatureZoom = useCallback((featureId: number) => {
    const src = projectLayer.current?.getSource()
    if (!src) return
    const feature = src.getFeatureById(featureId) as Feature | null
    if (feature) {
      const extent = feature.getGeometry()?.getExtent()
      if (extent) {
        mapInstance.current?.getView().fit(extent, { padding: [80, 80, 80, 80], duration: 500, maxZoom: 18 })
      }
    }
  }, [])

  const handleUndo = useCallback(() => {
    if (isReadOnly) { message.warning('Editing is locked for this survey area'); return }
    const entry = undoStack.current.pop()
    if (!entry) { message.info('Nothing to undo'); return }
    if (entry.type === 'draw') {
      projectLayer.current?.getSource()?.removeFeature(entry.feature)
      const id = entry.feature.getId() as number
      if (id) {
        api.delete(`/projects/features/${id}/`).then(() => {
          qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
        }).catch(() => {})
      }
    } else if (entry.type === 'move') {
      const fmt = new GeoJSON()
      for (const { id, geomGeoJSON } of entry.geoms) {
        // Restore original geometry on map
        const src = projectLayer.current?.getSource()
        const feat = src?.getFeatureById(id)
        if (feat) {
          const geom = fmt.readGeometry(geomGeoJSON, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })
          feat.setGeometry(geom)
        }
        // Restore original geometry on backend
        api.patch(`/projects/features/${id}/`, { geometry: geomGeoJSON }).catch(() => {})
      }
      qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
      message.success('Move undone')
    }
  }, [selectedProjectId, isReadOnly])

  // Escape key → release any active tool back to Pan
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMapTool('pan')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setMapTool])

  const handleGoTo = useCallback(() => {
    const lat = parseFloat(gotoLat)
    const lon = parseFloat(gotoLon)
    if (isNaN(lat) || isNaN(lon)) { message.warning('Enter valid coordinates'); return }
    mapInstance.current?.getView().animate({ center: fromLonLat([lon, lat]), zoom: 14, duration: 600 })
    setGotoOpen(false)
    setGotoLat('')
    setGotoLon('')
  }, [gotoLat, gotoLon])

  const handleSaveBookmark = useCallback(() => {
    if (!bookmarkName.trim()) { message.warning('Enter a bookmark name'); return }
    const view = mapInstance.current?.getView()
    if (!view) return
    const center = toLonLat(view.getCenter() ?? INDIA_CENTER) as [number, number]
    const zoom = view.getZoom() ?? 5
    const bm: MapBookmark = { id: Date.now().toString(), name: bookmarkName.trim(), center, zoom }
    const updated = [...bookmarks, bm]
    setBookmarks(updated)
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(updated))
    setBookmarkName('')
    message.success('Bookmark saved')
  }, [bookmarks, bookmarkName])

  const saveDrawnFeature = useCallback((layerName: string, overrideFolderId?: number | null) => {
    const feat = pendingDrawFeatureRef.current
    const dt = pendingDrawTypeRef.current
    if (!feat || !selectedProjectId) return
    const src = projectLayer.current?.getSource()
    const locked = getLayerStyle(layerStylesRef.current, layerName).locked
    if (locked) {
      message.warning(`Layer "${layerName}" is locked`)
      src?.removeFeature(feat)
      pendingDrawFeatureRef.current = null
      return
    }
    const fmt = new GeoJSON()
    const gf = fmt.writeFeatureObject(feat, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })
    // Folder priority: active-draw-layer folder > URL override > selectedFolderId > survey area root
    const folderId = overrideFolderId ?? activeDrawLayer?.folderId ?? selectedFolderId ?? selectedSurveyArea?.folder ?? null
    api.post('/projects/features/', {
      project: selectedProjectId,
      folder: folderId,
      layer_name: layerName,
      geometry_type: dt === 'Point' ? 'POINT' : dt === 'LineString' ? 'LINE' : 'POLYGON',
      geometry: gf.geometry,
      attributes: {},
      ...(isCantonmentUploader ? { deo_visible: deoVisibleRef.current } : {}),
    }).then((r) => {
      const saved: GISFeature = r.data
      // Update OL feature in-place (already on the map from Draw interaction)
      feat.setId(saved.id)
      feat.set('layer_name', layerName)
      feat.set('feature_id', saved.feature_id)
      feat.set('folder', saved.folder)
      undoStack.current.push({ type: 'draw', feature: feat })
      // Add to React Query cache immediately so visibleFeatures includes it
      // without waiting for a full refetch (which would clear the source)
      qc.setQueryData<GISFeature[]>(['map-features', selectedProjectId], (old) =>
        old ? [...old, saved] : [saved]
      )
      pendingDrawFeatureRef.current = null
      // Broadcast to collaborators
      wsSendCreated({ id: saved.id, geometry: gf.geometry, layer_name: layerName, attributes: {} })
    }).catch((err) => {
      const data = err?.response?.data
      const msg = data?.detail
        || (data?.layer_name?.[0] ? `Layer name: ${data.layer_name[0]}` : null)
        || (data?.geometry?.[0] ? `Geometry: ${data.geometry[0]}` : null)
        || (data?.non_field_errors?.[0])
        || 'Failed to save feature'
      message.error(msg)
      src?.removeFeature(feat)
      pendingDrawFeatureRef.current = null
    })
  }, [selectedProjectId, selectedFolderId, selectedSurveyArea, activeDrawLayer, wsSendCreated])

  const handleGoToBookmark = useCallback((bm: MapBookmark) => {
    mapInstance.current?.getView().animate({
      center: fromLonLat(bm.center),
      zoom: bm.zoom,
      duration: 600,
    })
  }, [])

  const handleDeleteBookmark = useCallback((id: string) => {
    const updated = bookmarks.filter((b) => b.id !== id)
    setBookmarks(updated)
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(updated))
  }, [bookmarks])

  async function handleCheckTopology() {
    if (!selectedProjectId) { message.warning('Select a project first'); return }
    setTopoLoading(true)
    try {
      const r = await api.get(`/projects/topology/?project=${selectedProjectId}`)
      setTopoIssues(r.data.issues ?? [])
      setTopoOpen(true)
    } catch {
      message.error('Topology check failed')
    } finally {
      setTopoLoading(false)
    }
  }

  // ── Layer management helpers ────────────────────────────────────────────────

  function zoomToLayer(ln: string) {
    const src = projectLayer.current?.getSource()
    if (!src) return
    const features = src.getFeatures().filter((f) => f.get('layer_name') === ln)
    if (!features.length) { message.warning('No features in layer'); return }
    const ext = src.getExtent()
    const layerExt = features.reduce<[number,number,number,number] | null>((acc, f) => {
      const fe = f.getGeometry()?.getExtent()
      if (!fe) return acc
      if (!acc) return [...fe] as [number,number,number,number]
      return [Math.min(acc[0],fe[0]),Math.min(acc[1],fe[1]),Math.max(acc[2],fe[2]),Math.max(acc[3],fe[3])]
    }, null)
    if (layerExt) mapInstance.current?.getView().fit(layerExt, { padding: [80,80,80,80], duration: 500, maxZoom: 18 })
    void ext
  }

  function selectAllInLayer(ln: string) {
    const src = projectLayer.current?.getSource()
    const selSrc = selectLayer.current?.getSource()
    if (!src || !selSrc) return
    selSrc.clear()
    const feats = src.getFeatures().filter((f) => f.get('layer_name') === ln)
    selSrc.addFeatures(feats)
    setSelectedCount(feats.length)
    message.info(`${feats.length} feature(s) selected in "${ln}"`)
  }

  function clearSelection() {
    selectLayer.current?.getSource()?.clear()
    setSelectedCount(0)
  }

  function invertSelection(ln: string) {
    const src = projectLayer.current?.getSource()
    const selSrc = selectLayer.current?.getSource()
    if (!src || !selSrc) return
    const selectedIds = new Set(selSrc.getFeatures().map((f) => f.getId()))
    selSrc.clear()
    const feats = src.getFeatures().filter((f) => f.get('layer_name') === ln && !selectedIds.has(f.getId()))
    selSrc.addFeatures(feats)
    setSelectedCount(feats.length)
  }

  function selectByAttribute(ln: string, field: string, op: string, val: string) {
    const src = projectLayer.current?.getSource()
    const selSrc = selectLayer.current?.getSource()
    if (!src || !selSrc) return
    selSrc.clear()
    const matched = src.getFeatures().filter((f) => {
      if (f.get('layer_name') !== ln) return false
      const fv = String(f.get(field) ?? f.getProperties()[field] ?? '')
      switch (op) {
        case '=': return fv === val
        case '!=': return fv !== val
        case '>': return parseFloat(fv) > parseFloat(val)
        case '<': return parseFloat(fv) < parseFloat(val)
        case '>=': return parseFloat(fv) >= parseFloat(val)
        case '<=': return parseFloat(fv) <= parseFloat(val)
        case 'contains': return fv.toLowerCase().includes(val.toLowerCase())
        case 'starts': return fv.toLowerCase().startsWith(val.toLowerCase())
        case 'ends': return fv.toLowerCase().endsWith(val.toLowerCase())
        default: return false
      }
    })
    selSrc.addFeatures(matched)
    setSelectedCount(matched.length)
    message.info(`${matched.length} feature(s) matched`)
  }

  function copySelected() {
    const feats = selectLayer.current?.getSource()?.getFeatures() ?? []
    clipboardRef.current = feats.map((f) => f.clone())
    message.success(`${feats.length} feature(s) copied`)
  }

  async function pasteFeatures(ln: string) {
    if (isReadOnly) { message.warning('Editing is locked for this survey area'); return }
    if (!clipboardRef.current.length) { message.warning('Nothing to paste'); return }
    if (!selectedProjectId) { message.warning('Select a project'); return }
    const fmt = new GeoJSON()
    let count = 0
    for (const f of clipboardRef.current) {
      try {
        const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
        await api.post('/projects/features/', {
          project: selectedProjectId, folder: selectedFolderId ?? null,
          layer_name: ln, geometry_type: gf.geometry?.type?.toUpperCase() === 'POINT' ? 'POINT' : gf.geometry?.type?.toUpperCase() === 'LINESTRING' ? 'LINE' : 'POLYGON',
          geometry: gf.geometry, attributes: f.getProperties(),
          ...(isCantonmentUploader ? { deo_visible: deoVisibleRef.current } : {}),
        })
        count++
      } catch (_) {}
    }
    message.success(`Pasted ${count} feature(s)`)
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
  }

  async function deleteSelectedFeatures() {
    if (isReadOnly) { message.warning('Editing is locked for this survey area'); return }
    const selSrc = selectLayer.current?.getSource()
    const ids = selSrc?.getFeatures().map((f) => f.getId()).filter(Boolean) as number[] ?? []
    if (!ids.length) { message.warning('No features selected'); return }
    await Promise.all(ids.map((id) => api.delete(`/projects/features/${id}/`).catch(() => {})))
    selSrc?.clear()
    setSelectedCount(0)
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Deleted ${ids.length} feature(s)`)
  }

  async function deleteAllInLayer(ln: string) {
    if (isReadOnly) { message.warning('Editing is locked for this survey area'); return }
    const ids = mapFeatures.filter((f) => f.layer_name === ln).map((f) => f.id)
    if (!ids.length) return
    await Promise.all(ids.map((id) => api.delete(`/projects/features/${id}/`).catch(() => {})))
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Cleared ${ids.length} feature(s) from "${ln}"`)
  }

  async function calculateField(ln: string, field: string, value: string, target: 'selected' | 'all') {
    if (isReadOnly) { message.warning('Editing is locked for this survey area'); return }
    const selSrc = selectLayer.current?.getSource()
    const ids = target === 'selected'
      ? (selSrc?.getFeatures().map((f) => f.getId()).filter(Boolean) as number[] ?? [])
      : mapFeatures.filter((f) => f.layer_name === ln).map((f) => f.id)
    if (!ids.length) { message.warning('No features to update'); return }
    let expr = value
    const numVal = parseFloat(value)
    const finalVal = !isNaN(numVal) ? numVal : value
    await Promise.all(ids.map((id) => {
      const existing = mapFeatures.find((f) => f.id === id)?.attributes ?? {}
      return api.patch(`/projects/features/${id}/`, { attributes: { ...existing, [field]: finalVal } }).catch(() => {})
    }))
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Updated "${field}" on ${ids.length} feature(s)`)
    void expr
  }

  function activateMoveLayer(ln: string) {
    if (isReadOnly) { message.warning('Editing is locked for this survey area'); return }
    const map = mapInstance.current
    const src = projectLayer.current?.getSource()
    if (!map || !src) return
    if (translateRef.current) { map.removeInteraction(translateRef.current); translateRef.current = null }
    activeManageLayerRef.current = ln
    const translate = new Translate({
      filter: (f) => f.get('layer_name') === ln,
    })
    translate.on('translateend', (e) => {
      const fmt = new GeoJSON()
      e.features.forEach((f: any) => {
        const id = ((f as Feature).getId() ?? (f as Feature).get('id')) as number
        if (!id) return
        const gf = fmt.writeFeatureObject(f as Feature, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
        api.patch(`/projects/features/${id}/`, { geometry: gf.geometry }).catch(() => {})
      })
    })
    map.addInteraction(translate)
    translateRef.current = translate
    setMoveLayerActive(ln)
    message.info(`Move mode ON for "${ln}" — drag features, then click Stop`)
  }

  function deactivateMoveLayer() {
    if (translateRef.current) {
      mapInstance.current?.removeInteraction(translateRef.current)
      translateRef.current = null
    }
    setMoveLayerActive(null)
    message.success('Move mode OFF — changes saved')
  }

  // ── Editing operation apply functions ─────────────────────────────────────

  async function applyRotate(angleDeg: number) {
    const selSrc = selectLayer.current?.getSource()
    const feats = selSrc?.getFeatures() ?? []
    if (!feats.length) return
    const { default: turfRotate } = await import('@turf/transform-rotate')
    const fmt = new GeoJSON()
    for (const f of feats) {
      const id = (f.getId() ?? f.get('id')) as number
      if (!id) continue
      const folderId = (f.get('folder') as number | null)
      if (selectedAreaFolderIds && folderId != null && !selectedAreaFolderIds.has(folderId)) continue
      const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      const rotated = turfRotate(gf.geometry as any, angleDeg)
      const coords3857 = new GeoJSON().readGeometry(rotated, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      f.setGeometry(coords3857)
      await api.patch(`/projects/features/${id}/`, { geometry: rotated }).catch(() => {})
    }
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Rotated ${feats.length} feature(s) by ${angleDeg}°`)
  }

  async function applyScale(factor: number) {
    const selSrc = selectLayer.current?.getSource()
    const feats = selSrc?.getFeatures() ?? []
    if (!feats.length) return
    const { default: turfScale } = await import('@turf/transform-scale')
    const fmt = new GeoJSON()
    for (const f of feats) {
      const id = (f.getId() ?? f.get('id')) as number
      if (!id) continue
      const folderId = (f.get('folder') as number | null)
      if (selectedAreaFolderIds && folderId != null && !selectedAreaFolderIds.has(folderId)) continue
      const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      const scaled = turfScale(gf.geometry as any, factor)
      const geom3857 = new GeoJSON().readGeometry(scaled, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      f.setGeometry(geom3857)
      await api.patch(`/projects/features/${id}/`, { geometry: scaled }).catch(() => {})
    }
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Scaled ${feats.length} feature(s) by ×${factor}`)
  }

  async function applySimplify(toleranceM: number) {
    const selSrc = selectLayer.current?.getSource()
    const feats = selSrc?.getFeatures() ?? []
    if (!feats.length) return
    const { default: turfSimplify } = await import('@turf/simplify')
    const toleranceDeg = toleranceM / 111320
    const fmt = new GeoJSON()
    for (const f of feats) {
      const id = (f.getId() ?? f.get('id')) as number
      if (!id) continue
      const folderId = (f.get('folder') as number | null)
      if (selectedAreaFolderIds && folderId != null && !selectedAreaFolderIds.has(folderId)) continue
      const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      const simplified = turfSimplify(gf.geometry as any, { tolerance: toleranceDeg, highQuality: true })
      const geom3857 = new GeoJSON().readGeometry(simplified, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      f.setGeometry(geom3857)
      await api.patch(`/projects/features/${id}/`, { geometry: simplified }).catch(() => {})
    }
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Simplified ${feats.length} feature(s) (tolerance: ${toleranceM}m)`)
  }

  async function applyOffsetCurve(distM: number) {
    const selSrc = selectLayer.current?.getSource()
    const feats = (selSrc?.getFeatures() ?? []).filter((f) => f.getGeometry()?.getType() === 'LineString')
    if (!feats.length) { message.warning('No line features selected'); return }
    const { default: turfLineOffset } = await import('@turf/line-offset')
    const fmt = new GeoJSON()
    for (const f of feats) {
      const gf = fmt.writeFeatureObject(f, { dataProjection:'EPSG:4326', featureProjection:'EPSG:3857' })
      const offset = turfLineOffset(gf.geometry as any, distM, { units: 'meters' })
      await api.post('/projects/features/', {
        project: selectedProjectId, folder: selectedFolderId ?? null,
        layer_name: f.get('layer_name') ?? 'line_layer',
        geometry_type: 'LINE', geometry: offset.geometry,
      }).catch(() => {})
    }
    qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
    message.success(`Created ${feats.length} offset line(s)`)
  }

  function getLayerAttributes(ln: string): string[] {
    const keys = new Set<string>(['feature_id'])
    mapFeatures.filter((f) => f.layer_name === ln).forEach((f) => {
      Object.keys(f.attributes || {}).forEach((k) => keys.add(k))
    })
    return Array.from(keys)
  }

  const layerFeatureCount = useMemo(() => {
    const c: Record<string, number> = {}
    mapFeatures.forEach((f) => { c[f.layer_name] = (c[f.layer_name] ?? 0) + 1 })
    return c
  }, [mapFeatures])

  const formatCoords = () => {
    if (!mapCoords) return ''
    const ll = toLonLat(mapCoords)
    return `${ll[1].toFixed(5)}, ${ll[0].toFixed(5)}`
  }

  const bookmarkContent = (
    <div style={{ width: 240 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Save current view</div>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="small"
            placeholder="Bookmark name"
            value={bookmarkName}
            onChange={(e) => setBookmarkName(e.target.value)}
            onPressEnter={handleSaveBookmark}
          />
          <Button size="small" type="primary" onClick={handleSaveBookmark}>Save</Button>
        </Space.Compact>
      </div>
      {bookmarks.length === 0 ? (
        <div style={{ color: '#555', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>No bookmarks yet</div>
      ) : (
        bookmarks.map((bm) => (
          <div key={bm.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Button
              type="link"
              size="small"
              style={{ flex: 1, textAlign: 'left', padding: 0, fontSize: 12, color: '#4fc3f7' }}
              onClick={() => handleGoToBookmark(bm)}
            >
              {bm.name}
            </Button>
            <Button
              size="small" type="text" icon={<DeleteOutlined />}
              style={{ color: '#666', padding: 0 }}
              onClick={() => handleDeleteBookmark(bm.id)}
            />
          </div>
        ))
      )}
    </div>
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Map canvas */}
      <div ref={mapRef} className="ol-map" />

      {/* External-layer keyword search */}
      <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 31, width: 400, maxWidth: '70vw' }}>
        <AutoComplete
          style={{ width: '100%' }}
          value={extSearchValue}
          allowClear
          placeholder="🔍 Search external layers (any keyword)…"
          options={extSearchResults.map((res, i) => ({
            value: `${res.layer_id}:${res.id}:${i}`,
            data: res,
            label: (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <b>{res.match_value || res.label}</b>
                  {res.match_field && <span style={{ color: '#888', fontSize: 11 }}> · {res.match_field}</span>}
                </span>
                <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>{res.layer_name}</Tag>
              </div>
            ),
          }))}
          onSearch={(v) => { setExtSearchValue(v); setExtSearchLoading(v.trim().length >= 2); runExtSearch(v) }}
          onChange={(v) => setExtSearchValue(v ?? '')}
          onSelect={(_v, opt: any) => {
            const res = opt?.data as ExtSearchResult
            if (res) { flyToSearchResult(res); setExtSearchValue(res.match_value || res.label) }
          }}
          notFoundContent={
            extSearchLoading ? <div style={{ textAlign: 'center', padding: 8 }}><Spin size="small" /></div>
              : extSearchValue.trim().length >= 2 ? <div style={{ padding: 8, color: '#888' }}>No matches</div>
              : null
          }
        />
      </div>

      {/* Collaboration presence indicator */}
      {(collabConnected || collabReconnecting) && (
        <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 30 }}>
          <CollabPresence
            connected={collabConnected}
            reconnecting={collabReconnecting}
            users={presenceUsers}
          />
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
           Left toolbar — QGIS-style collapsible tool groups
          ═══════════════════════════════════════════════════════════════════ */}
      <div style={{
        position: 'absolute', top: 8, left: 8, zIndex: 20,
        width: 148,
        maxHeight: 'calc(100% - 16px)',
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        scrollbarWidth: 'none',
      }}>
        {/* Helper to render a collapsible group */}
        {(() => {
          const btnStyle = (active: boolean): React.CSSProperties => ({
            background: active ? '#1565c0' : 'rgba(14,18,30,0.92)',
            border: `1px solid ${active ? '#1565c0' : '#2a2a3e'}`,
            color: active ? '#fff' : '#b0bec5',
            width: 32, height: 32, padding: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            borderRadius: 4, cursor: 'pointer', fontSize: 13,
            transition: 'all 0.15s',
          })

          function GroupHeader({ id, label, color }: { id: string; label: string; color: string }) {
            const collapsed = toolGroupsCollapsed.has(id)
            return (
              <div
                onClick={() => setToolGroupsCollapsed((prev) => {
                  const next = new Set(prev)
                  collapsed ? next.delete(id) : next.add(id)
                  return next
                })}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '3px 6px', background: 'rgba(12,14,26,0.95)',
                  border: '1px solid #1a1a2e', borderRadius: 4, cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.05em' }}>{label}</span>
                <span style={{ color: '#444', fontSize: 9 }}>{collapsed ? '▶' : '▼'}</span>
              </div>
            )
          }

          function ToolGrid({ tools, groupKey }: { tools: typeof PRIMARY_TOOLS; groupKey: string }) {
            if (toolGroupsCollapsed.has(groupKey)) return null
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '2px 0' }}>
                {tools.map((t) => (
                  <Tooltip key={t.key} title={<span><b>{t.label}</b><br /><span style={{fontSize:11,color:'#aaa'}}>{(t as any).desc}</span></span>} placement="right">
                    <div style={btnStyle(mapTool === t.key)} onClick={() => setMapTool(t.key as any)}>
                      {t.icon}
                    </div>
                  </Tooltip>
                ))}
              </div>
            )
          }

          const ZOOM_TOOLS = [
            { key: '_zi', icon: <ZoomInOutlined />,  label: 'Zoom In',     desc: 'Zoom in one level', action: () => handleZoom(1) },
            { key: '_zo', icon: <ZoomOutOutlined />, label: 'Zoom Out',    desc: 'Zoom out one level', action: () => handleZoom(-1) },
            { key: '_zw', icon: <GlobalOutlined />,  label: 'Zoom to India', desc: 'Fit India in view', action: () => mapInstance.current?.getView().animate({ center: INDIA_CENTER, zoom: 5, duration: 500 }) },
            { key: '_zh', icon: <HistoryOutlined />, label: 'Prev Extent', desc: 'Navigate to previous map extent', action: () => {
              if (extentHistoryIdx.current <= 0) return
              extentHistoryIdx.current -= 1
              const e = extentHistory.current[extentHistoryIdx.current]
              mapInstance.current?.getView().animate({ center: e.center, zoom: e.zoom, duration: 200 })
              setCanHistBack(extentHistoryIdx.current > 0); setCanHistFwd(true)
            }},
            { key: '_zf', icon: <RetweetOutlined />, label: 'Next Extent', desc: 'Navigate to next map extent', action: () => {
              if (extentHistoryIdx.current >= extentHistory.current.length - 1) return
              extentHistoryIdx.current += 1
              const e = extentHistory.current[extentHistoryIdx.current]
              mapInstance.current?.getView().animate({ center: e.center, zoom: e.zoom, duration: 200 })
              setCanHistBack(true); setCanHistFwd(extentHistoryIdx.current < extentHistory.current.length - 1)
            }},
          ]

          const areaStatusColor = (st: string): string => {
            const m: Record<string, string> = {
              DRAFT: '#8c8c8c', RETURNED: '#faad14',
              SUBMITTED: '#1677ff', UNDER_REVIEW: '#722ed1',
              APPROVED: '#52c41a', PUBLISHED: '#13c2c2',
            }
            return m[st] ?? '#8c8c8c'
          }
          const areaStatusLabel = (st: string): string => {
            const m: Record<string, string> = {
              DRAFT: 'Draft', RETURNED: 'Returned',
              SUBMITTED: 'Submitted', UNDER_REVIEW: 'In Review',
              APPROVED: 'Approved', PUBLISHED: 'Published',
            }
            return m[st] ?? st
          }

          return (
            <>
              {/* ── Survey Area Selector ── */}
              {surveyAreas.length > 0 && (
                <div style={{ marginBottom: 8, borderBottom: '1px solid #1e2a3a', paddingBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#64b5f6', letterSpacing: 1, marginBottom: 4, textTransform: 'uppercase' }}>
                    Survey Areas
                  </div>
                  {/* All Areas */}
                  <div
                    onClick={() => setSelectedSurveyAreaId(null)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '5px 8px', borderRadius: 4, cursor: 'pointer', marginBottom: 3,
                      fontSize: 11, fontWeight: !selectedSurveyAreaId ? 700 : 500,
                      background: !selectedSurveyAreaId ? 'rgba(100,181,246,0.2)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${!selectedSurveyAreaId ? '#64b5f6' : 'rgba(255,255,255,0.08)'}`,
                      color: !selectedSurveyAreaId ? '#64b5f6' : 'rgba(255,255,255,0.65)',
                    }}
                  >
                    <GlobalOutlined style={{ fontSize: 11, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>All Areas</span>
                    <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>{surveyAreas.length}</span>
                  </div>
                  {/* Individual areas */}
                  {surveyAreas.map((area) => {
                    const col = areaStatusColor(area.status)
                    const active = selectedSurveyAreaId === area.id
                    return (
                      <Tooltip key={area.id} title={`${area.name} — ${areaStatusLabel(area.status)}`} placement="right">
                        <div
                          onClick={() => setSelectedSurveyAreaId(area.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '5px 8px', borderRadius: 4, cursor: 'pointer', marginBottom: 3,
                            fontSize: 11, fontWeight: active ? 700 : 500,
                            background: active ? `${col}26` : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${active ? col : 'rgba(255,255,255,0.08)'}`,
                            color: active ? col : 'rgba(255,255,255,0.75)',
                            transition: 'all 0.15s',
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: col, flexShrink: 0, boxShadow: active ? `0 0 5px ${col}` : 'none' }} />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{area.name}</span>
                          <span style={{
                            fontSize: 9, background: `${col}33`, color: col,
                            borderRadius: 3, padding: '1px 4px', flexShrink: 0, fontWeight: 600,
                          }}>
                            {areaStatusLabel(area.status)}
                          </span>
                        </div>
                      </Tooltip>
                    )
                  })}
                </div>
              )}

              {/* ── New Shapefile Layer + Import buttons ──────────── */}
              {canDraw && selectedProjectId && (
                <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
                  <Tooltip title="Create a new layer and start drawing immediately (QGIS-style)" placement="right">
                    <div
                      onClick={() => setNewLayerModalOpen(true)}
                      style={{
                        flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                        padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                        fontSize: 11, fontWeight: 600,
                        background: 'rgba(79,195,247,0.12)',
                        border: '1px dashed #4fc3f7',
                        color: '#4fc3f7',
                        transition: 'all 0.15s',
                      }}
                    >
                      <FileAddOutlined style={{ fontSize: 12 }} />
                      <span>New Layer</span>
                    </div>
                  </Tooltip>
                  <Tooltip title="Import Shapefile ZIP, GeoJSON, KML or GeoPackage into the selected area" placement="right">
                    <div
                      onClick={() => {
                        if (!selectedSurveyAreaId) {
                          message.warning('Select a survey area first to import into')
                          return
                        }
                        setImportGISModalOpen(true)
                      }}
                      style={{
                        flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                        padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                        fontSize: 11, fontWeight: 600,
                        background: 'rgba(82,196,26,0.10)',
                        border: '1px dashed #52c41a',
                        color: '#52c41a',
                        transition: 'all 0.15s',
                      }}
                    >
                      <UploadOutlined style={{ fontSize: 12 }} />
                      <span>Import File</span>
                    </div>
                  </Tooltip>
                </div>
              )}

              {/* ── Active layer banner ──────────────────────────────── */}
              {activeDrawLayer && (
                <div style={{
                  background: 'rgba(79,195,247,0.15)', border: '1px solid #4fc3f7',
                  borderRadius: 4, padding: '6px 8px', marginBottom: 8,
                  fontSize: 11,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#4fc3f7', fontWeight: 700, marginBottom: 2 }}>
                    <FileAddOutlined />
                    <span>Active Layer</span>
                    <span
                      style={{ marginLeft: 'auto', cursor: 'pointer', color: 'rgba(255,255,255,0.5)' }}
                      onClick={() => { setActiveDrawLayer(null); setMapTool('pan') }}
                    >
                      <CloseOutlined style={{ fontSize: 9 }} />
                    </span>
                  </div>
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: 12 }}>{activeDrawLayer.name}</div>
                  <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 10, marginTop: 2 }}>
                    Draw on the map to add features. Each shape saves instantly.
                  </div>
                </div>
              )}

              {/* ── Release active tool banner (hidden in overview) ── */}
              {mapTool !== 'pan' && !isOverviewMode && (
                <Tooltip title="Release current tool and return to Pan mode (Esc)" placement="right">
                  <div
                    onClick={() => setMapTool('pan')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: '#ff6b35', color: '#fff', borderRadius: 4,
                      padding: '4px 8px', marginBottom: 6, cursor: 'pointer',
                      fontSize: 11, fontWeight: 600,
                    }}
                  >
                    <CloseOutlined style={{ fontSize: 10 }} />
                    Release Tool (Esc)
                  </div>
                </Tooltip>
              )}

              {/* ── Navigate (hidden in overview mode) ── */}
              {!isOverviewMode && (
                <>
                  <GroupHeader id="nav" label="NAVIGATE" color="#4fc3f7" />
                  {!toolGroupsCollapsed.has('nav') && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '2px 0' }}>
                      {PRIMARY_TOOLS.map((t) => (
                        <Tooltip key={t.key} title={<span><b>{t.label}</b><br /><span style={{fontSize:11,color:'#aaa'}}>{(t as any).desc}</span></span>} placement="right">
                          <div style={btnStyle(mapTool === t.key)} onClick={() => setMapTool(t.key as any)}>{t.icon}</div>
                        </Tooltip>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ── Zoom / View (always visible) ── */}
              <GroupHeader id="zoom" label="ZOOM / VIEW" color="#80cbc4" />
              {!toolGroupsCollapsed.has('zoom') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '2px 0' }}>
                  {ZOOM_TOOLS.map((t) => (
                    <Tooltip key={t.key} title={<span><b>{t.label}</b><br /><span style={{fontSize:11,color:'#aaa'}}>{t.desc}</span></span>} placement="right">
                      <div style={btnStyle(false)} onClick={t.action}>{t.icon}</div>
                    </Tooltip>
                  ))}
                  <Tooltip title={mapLocked ? 'Unlock map' : 'Lock map extent'} placement="right">
                    <div style={btnStyle(mapLocked)} onClick={() => setMapLocked(!mapLocked)}>
                      {mapLocked ? <LockOutlined /> : <UnlockOutlined />}
                    </div>
                  </Tooltip>
                  <Tooltip title="Toggle grid (graticule)" placement="right">
                    <div style={btnStyle(graticuleVisible)} onClick={() => setGraticuleVisible(!graticuleVisible)}>
                      <GlobalOutlined />
                    </div>
                  </Tooltip>
                </div>
              )}

              {/* ── Selection (hidden in overview / simplified mode) ── */}
              {!isOverviewMode && !simplified && (
                <>
                  <GroupHeader id="sel" label="SELECTION" color="#ce93d8" />
                  <ToolGrid tools={SELECT_TOOLS} groupKey="sel" />
                </>
              )}

              {/* ── Measure (hidden in simplified DGDE/PDDE view) ── */}
              {!simplified && (
                <>
                  <GroupHeader id="meas" label="MEASURE" color="#ffcc80" />
                  <ToolGrid tools={MEASURE_TOOLS} groupKey="meas" />
                </>
              )}

              {/* ── Actions (always visible) ── */}
              <GroupHeader id="act" label="ACTIONS" color="#a5d6a7" />
              {!toolGroupsCollapsed.has('act') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '2px 0' }}>
                  {canDraw && !isOverviewMode && (
                    <Tooltip title={<span><b>Undo</b><br /><span style={{fontSize:11,color:'#aaa'}}>Undo last drawn feature</span></span>} placement="right">
                      <div style={btnStyle(false)} onClick={handleUndo}><UndoOutlined /></div>
                    </Tooltip>
                  )}
                  {!simplified && (
                    <Tooltip title={<span><b>Attribute Table</b><br /><span style={{fontSize:11,color:'#aaa'}}>Open the feature attribute table</span></span>} placement="right">
                      <div style={btnStyle(attrTableOpen)} onClick={() => setAttrTableOpen((v) => !v)}><TableOutlined /></div>
                    </Tooltip>
                  )}
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'pdf',
                          label: '📄 PDF with Details (Legend, Scale, North Arrow)',
                          onClick: () => setPrintOpen(true),
                        },
                        {
                          key: 'png',
                          label: '🖼️ PNG High-Quality (300+ DPI)',
                          onClick: () => setMapExportOpen(true),
                        },
                      ],
                    }}
                    trigger={['click']}
                  >
                    <Tooltip title={<span><b>Print/Export Map</b><br /><span style={{fontSize:11,color:'#aaa'}}>PDF (detailed) or PNG (300+ DPI)</span></span>} placement="right">
                      <div style={btnStyle(false)}><PrinterOutlined /></div>
                    </Tooltip>
                  </Dropdown>
                  <Popover content={bookmarkContent} title="Bookmarks" trigger="click" placement="right">
                    <Tooltip title={<span><b>Bookmarks</b></span>} placement="right">
                      <div style={btnStyle(false)}><BookOutlined /></div>
                    </Tooltip>
                  </Popover>
                  <Tooltip title={<span><b>Go to Coordinate</b></span>} placement="right">
                    <div style={btnStyle(false)} onClick={() => setGotoOpen(true)}><EnvironmentOutlined /></div>
                  </Tooltip>
                  <Tooltip title={<span><b>Layers & Tools</b><br /><span style={{fontSize:11,color:'#aaa'}}>View and enable external data layers</span></span>} placement="right">
                    <div style={btnStyle(extLayersPanelOpen)} onClick={() => setExtLayersPanelOpen(v => !v)}>
                      <CloudServerOutlined />
                      {extVisibleIds.size > 0 && (
                        <span style={{ position: 'absolute', top: 1, right: 1, width: 8, height: 8, borderRadius: '50%', background: '#1890ff', display: 'block' }} />
                      )}
                    </div>
                  </Tooltip>
                  <Tooltip title={<span><b>Temp Layers</b><br /><span style={{fontSize:11,color:'#aaa'}}>Upload KML/KMZ/GeoJSON/Shapefile for ad-hoc viewing</span></span>} placement="right">
                    <div style={btnStyle(tempLayerPanelOpen)} onClick={() => setTempLayerPanelOpen(v => !v)}>
                      <FileAddOutlined />
                      {tempVisibleIds.size > 0 && (
                        <span style={{ position: 'absolute', top: 1, right: 1, width: 8, height: 8, borderRadius: '50%', background: '#ff6b35', display: 'block' }} />
                      )}
                    </div>
                  </Tooltip>
                </div>
              )}

              {/* ── Draw / Edit (area selected + DRAFT/RETURNED only) ── */}
              {canDraw && !isReadOnly && !isOverviewMode && (
                <>
                  <GroupHeader id="draw" label="DRAW" color="#ef9a9a" />
                  <ToolGrid tools={DRAW_TOOLS} groupKey="draw" />

                  <GroupHeader id="edit" label="EDIT TOOLS" color="#ffab91" />
                  {!toolGroupsCollapsed.has('edit') && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, padding: '2px 0' }}>
                      {EDIT_TOOLS.map((t) => (
                        <Tooltip key={t.key} title={<span><b>{t.label}</b><br /><span style={{fontSize:11,color:'#aaa'}}>{t.desc}</span></span>} placement="right">
                          <div style={btnStyle(mapTool === t.key)} onClick={() => setMapTool(t.key as any)}>{t.icon}</div>
                        </Tooltip>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ── Status banners ── */}
              {isOverviewMode && (
                <div style={{
                  margin: '6px 2px', padding: '6px 8px', borderRadius: 4, fontSize: 10,
                  background: 'rgba(100,181,246,0.08)', border: '1px solid rgba(100,181,246,0.25)',
                  color: 'rgba(255,255,255,0.5)', lineHeight: 1.5,
                }}>
                  Select a survey area above to enable editing tools.
                </div>
              )}
              {canDraw && !isOverviewMode && isReadOnly && selectedSurveyArea && !['DRAFT','RETURNED'].includes(selectedSurveyArea.status) && (
                <div style={{
                  margin: '4px 2px', padding: '6px 8px', borderRadius: 4, fontSize: 11,
                  background: ['APPROVED','PUBLISHED'].includes(selectedSurveyArea.status)
                    ? 'rgba(82,196,26,0.12)' : 'rgba(250,173,20,0.12)',
                  border: `1px solid ${['APPROVED','PUBLISHED'].includes(selectedSurveyArea.status) ? '#52c41a' : '#faad14'}`,
                  color: ['APPROVED','PUBLISHED'].includes(selectedSurveyArea.status) ? '#52c41a' : '#faad14',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  🔒 {areaStatusLabel(selectedSurveyArea.status)} — read-only
                </div>
              )}
            </>
          )
        })()}
      </div>

      {/* Top-right: basemap + layer panel */}
      <div
        style={{
          position: 'absolute', top: 12, right: 12,
          display: 'flex', flexDirection: 'column', gap: 8, zIndex: 20,
        }}
      >
        {simplified && (
          <AntSelect
            size="small"
            style={{ width: 200 }}
            placeholder="Select office"
            showSearch
            optionFilterProp="label"
            allowClear
            value={officeFilter}
            onChange={(v) => setOfficeFilter(v ?? null)}
            options={officeOptions.map((o: any) => ({
              value: o.id,
              label: o.level ? `${o.name} (${o.level})` : o.name,
            }))}
          />
        )}
        <AntSelect
          size="small"
          style={{ width: 160 }}
          placeholder="Basemap"
          value={activeBasemap?.id}
          onChange={(id) => setActiveBasemap(basemaps?.find((b) => b.id === id) ?? null)}
          options={basemaps?.filter((b) => b.is_active).map((b) => ({
            label: b.is_default ? `${b.name} ★` : b.name,
            value: b.id,
          }))}
        />
        <Tooltip title="Layers" placement="left">
          <Button
            icon={<BarsOutlined />} size="small"
            onClick={() => setLayerPanelOpen(true)}
            style={{ background: 'rgba(20,20,30,0.85)', border: '1px solid #333', color: '#ddd', alignSelf: 'flex-end' }}
          />
        </Tooltip>
      </div>

      {/* Coordinate display */}
      {mapCoords && (
        <div className="map-coords">{formatCoords()}</div>
      )}

      {/* Surveyor (CEO/ADEO): share new shapes with the parent DEO office */}
      {isCantonmentUploader && canDraw && selectedProjectId && (
        <div style={{
          position: 'absolute', top: 48, left: '50%', transform: 'translateX(-50%)', zIndex: 30,
          background: 'rgba(26,26,26,0.92)', border: '1px solid #333', borderRadius: 6,
          padding: '4px 12px',
        }}>
          <Tooltip title="When checked, new shapes you draw here are visible to the parent DEO office in the Map Viewer.">
            <Checkbox checked={deoVisible} onChange={(e) => setDeoVisible(e.target.checked)}>
              <span style={{ color: '#ccc', fontSize: 12 }}>New shapes visible to parent DEO</span>
            </Checkbox>
          </Tooltip>
        </div>
      )}

      {/* Classification legend(s) for visible thematic external layers */}
      {Object.keys(extClassLegends).length > 0 && (
        <div style={{
          position: 'absolute', bottom: 28, right: 12, zIndex: 30,
          background: 'rgba(26,26,26,0.92)', border: '1px solid #333', borderRadius: 6,
          padding: '8px 12px', maxWidth: 240, maxHeight: '45vh', overflowY: 'auto',
          color: '#e0e0e0', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
        }}>
          {Object.entries(extClassLegends).map(([key, lg]) => (
            <div key={key} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {lg.title}
                <span style={{ color: '#888', fontWeight: 400 }}> · {lg.field}</span>
              </div>
              {lg.entries.map((e) => (
                <div key={e.value} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{
                    display: 'inline-block', width: 14, height: 14, borderRadius: 3,
                    background: hexToRgba(e.color, e.opacity), border: `1px solid ${e.color}`,
                  }} />
                  <span style={{ color: '#ccc' }}>{e.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Read-only banner */}
      {isReadOnly && canDraw && selectedProjectId && (
        <div style={{
          position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(82,196,26,0.15)', border: '1px solid #52c41a',
          borderRadius: 4, padding: '4px 16px',
          color: '#52c41a', fontSize: 12, zIndex: 30,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          🔒 {selectedAreaStatus === 'APPROVED' || selectedAreaStatus === 'PUBLISHED'
            ? 'Approved layer — editing disabled'
            : 'Layer pending review — editing disabled'}
        </div>
      )}

      {/* Active version chip */}
      {canDraw && !isReadOnly && selectedProjectId && (
        <div
          style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(8,12,24,0.92)',
            border: `1px solid ${activeVersion ? '#4CAF50' : '#555'}`,
            borderRadius: 20, padding: '3px 12px',
            display: 'flex', alignItems: 'center', gap: 8, zIndex: 20, fontSize: 12,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeVersion ? '#4CAF50' : '#888', flexShrink: 0 }} />
          <span style={{ color: '#ddd' }}>
            {activeVersion ? `Drawing to: ${activeVersion.name}` : 'Preparing version…'}
          </span>
          {activeVersion && (
            <Tooltip title="Create next version (Ver-II, Ver-III…)">
              <Button
                size="small" type="text"
                style={{ fontSize: 10, color: '#4fc3f7', padding: '0 4px', height: 18 }}
                loading={newVersionMutation.isPending}
                onClick={() => newVersionMutation.mutate()}
              >
                + New Ver
              </Button>
            </Tooltip>
          )}
        </div>
      )}

      {/* Live measure / draw feedback */}
      {measureResult && (
        <div
          style={{
            position: 'absolute', top: 48, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(10,10,26,0.9)', color: '#ff5722',
            padding: '4px 12px', borderRadius: 4, fontSize: 13, fontWeight: 600,
            border: '1px solid #ff5722', zIndex: 20,
          }}
        >
          {measureResult}
          <Button size="small" type="text"
            onClick={() => { setMeasureResult(null); measureLayer.current?.getSource()?.clear() }}
            style={{ color: '#ff5722', marginLeft: 8, fontSize: 11 }}
          >×</Button>
        </div>
      )}

      {/* Box select count + merge */}
      {mapTool === 'box_select' && selectedCount > 0 && (
        <div
          style={{
            position: 'absolute', top: 48, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(255,152,0,0.15)', color: '#ff9800',
            padding: '4px 8px 4px 12px', borderRadius: 4, fontSize: 12, fontWeight: 600,
            border: '1px solid #ff9800', zIndex: 20, display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <span>{selectedCount} feature(s) selected</span>
          {selectedCount >= 2 && canDraw && (
            <Button
              size="small" type="primary" danger icon={<ApartmentOutlined />}
              loading={merging}
              style={{ fontSize: 11, height: 22 }}
              onClick={handleMergeSelected}
            >
              Merge
            </Button>
          )}
        </div>
      )}

      {/* Delete-feature active hint */}
      {mapTool === 'delete_feature' && (
        <div style={{
          position: 'absolute', bottom: attrTableOpen ? 270 : 8, left: '50%',
          transform: 'translateX(-50%)', zIndex: 20,
          background: 'rgba(220,38,38,0.9)', borderRadius: 6,
          padding: '5px 14px', display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)', pointerEvents: 'none',
        }}>
          <DeleteOutlined style={{ color: '#fff' }} />
          <span style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>
            DELETE MODE — Click a feature to delete it
          </span>
          <Button size="small" style={{ pointerEvents: 'auto', fontSize: 11, marginLeft: 4 }}
            onClick={() => setMapTool('pan')}>
            Cancel
          </Button>
        </div>
      )}

      {/* Buffer configuration panel */}
      {mapTool === 'buffer' && (
        <div
          style={{
            position: 'absolute', bottom: attrTableOpen ? 270 : 36, left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(8,12,24,0.96)', border: '1px solid #1a2a4a',
            borderRadius: 8, padding: '10px 14px', zIndex: 20,
            minWidth: 360, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#4fc3f7', fontWeight: 600, fontSize: 12 }}>
              {bufferLoading ? '⏳ Analyzing…'
                : bufferMode === 'point' ? '📍 Click map to analyse'
                : bufferMode === 'layer' ? '📂 Layer Buffer'
                : '🔷 Feature Buffer'}
            </span>
            <Button size="small" type="text" icon={<CloseOutlined />} style={{ color: '#666' }}
              onClick={() => { setMapTool('pan'); bufferLayer.current?.getSource()?.clear() }} />
          </div>

          {/* Mode selector */}
          <Segmented
            size="small"
            value={bufferMode}
            onChange={(v) => setBufferMode(v as 'point' | 'layer' | 'feature')}
            options={[
              { label: 'Point', value: 'point' },
              { label: 'Layer', value: 'layer' },
              { label: 'Selected', value: 'feature' },
            ]}
            style={{ width: '100%', marginBottom: 8, fontSize: 11 }}
          />

          {/* Layer selector (layer mode) — only vector feature layers, no raster/basemap */}
          {bufferMode === 'layer' && (
            <AntSelect
              size="small"
              placeholder="Select layer…"
              value={bufferLayerName || undefined}
              onChange={setBufferLayerName}
              style={{ width: '100%', marginBottom: 8, fontSize: 11 }}
              options={layerNames.map((ln) => ({ value: ln, label: ln }))}
            />
          )}

          {/* Point-mode hint */}
          {bufferMode === 'point' && (
            <div style={{ color: '#8ab4f8', fontSize: 11, marginBottom: 8 }}>
              Click anywhere on the map — the system will find all defence lands within the buffer radius
            </div>
          )}

          {/* Feature-mode hint */}
          {bufferMode === 'feature' && (
            <div style={{ color: selectedCount > 0 ? '#4CAF50' : '#ff9800', fontSize: 11, marginBottom: 8 }}>
              {selectedCount > 0
                ? `✓ ${selectedCount} feature(s) selected`
                : 'Use Box Select to select features first'}
            </div>
          )}

          {/* Unit toggle */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(['meters', 'kilometers'] as const).map((u) => (
              <Button key={u} size="small" type={bufferUnit === u ? 'primary' : 'default'}
                onClick={() => setBufferUnit(u)} style={{ fontSize: 11, flex: 1 }}>
                {u === 'meters' ? 'Meters' : 'Kilometers'}
              </Button>
            ))}
          </div>

          {/* Distance rings */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
            {bufferDistances.map((d, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: BUFFER_COLORS[idx % BUFFER_COLORS.length], flexShrink: 0, border: '1px solid rgba(255,255,255,0.2)' }} />
                <InputNumber size="small" min={1} value={d}
                  onChange={(val) => { if (val !== null) setBufferDistances((prev) => prev.map((x, i) => (i === idx ? val : x))) }}
                  style={{ flex: 1, fontSize: 12 }}
                  addonAfter={<span style={{ fontSize: 10 }}>{bufferUnit === 'meters' ? 'm' : 'km'}</span>}
                />
                {bufferDistances.length > 1 && (
                  <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#666', padding: 0 }}
                    onClick={() => setBufferDistances((prev) => prev.filter((_, i) => i !== idx))} />
                )}
              </div>
            ))}
          </div>

          {/* Dissolve + Add ring + Run */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Switch size="small" checked={bufferDissolve} onChange={setBufferDissolve} />
            <span style={{ color: '#aaa', fontSize: 11 }}>Dissolve rings</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="small" icon={<PlusOutlined />} style={{ fontSize: 11, flex: 1 }}
              disabled={bufferDistances.length >= 8}
              onClick={() => setBufferDistances((prev) => [...prev, (prev[prev.length - 1] ?? 100) * 2])}>
              Add Ring
            </Button>
            {bufferMode !== 'point' && (
              <Button size="small" type="primary" icon={<RadiusUpleftOutlined />}
                style={{ fontSize: 11, flex: 1 }} loading={bufferLoading}
                onClick={runFeatureBuffer}>
                Run Buffer
              </Button>
            )}
            {bufferResults.length > 0 && (
              <Button size="small" type="default" style={{ fontSize: 11 }} onClick={() => setBufferModalOpen(true)}>
                Results
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Attribute Table Panel */}
      <AttributeTablePanel
        open={attrTableOpen}
        onClose={() => setAttrTableOpen(false)}
        projectId={selectedProjectId}
        onFeatureZoom={onFeatureZoom}
        isReadOnly={isReadOnly}
        areaFolderIds={selectedAreaFolderIds}
      />

      {/* Modals & drawers */}
      <BufferAnalysisModal
        open={bufferModalOpen}
        onClose={() => setBufferModalOpen(false)}
        results={bufferResults}
        centerLonLat={bufferPoint}
      />

      <PrintLayoutModal
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        mapInstance={mapInstance.current}
        projectName={projects?.results?.find((p) => p.id === selectedProjectId)?.name ?? 'Project'}
        orgName={user?.organisation_name ?? ''}
        legend={printLegend}
      />

      <MapExportModal
        visible={mapExportOpen}
        onClose={() => setMapExportOpen(false)}
        mapInstance={mapInstance.current}
        mapState={{
          center: mapInstance.current ? (toLonLat(mapInstance.current.getView().getCenter() || [78, 20]) as [number, number]) : [78, 20],
          zoom: mapInstance.current ? mapInstance.current.getView().getZoom() || 10 : 10,
        }}
      />

      <ExternalLayersPanel
        open={extLayersPanelOpen}
        onClose={() => setExtLayersPanelOpen(false)}
        visibleIds={extVisibleIds}
        onToggleVisible={(key, layer) => showExtLayer(key, layer as ExtLayerConfig)}
        onHide={(key) => hideExtLayer(key)}
        onStyleApply={(key, layer) => restyleExtLayer(key, layer as ExtLayerConfig)}
      />

      <TempLayersPanel
        open={tempLayerPanelOpen}
        onClose={() => setTempLayerPanelOpen(false)}
        visibleIds={tempVisibleIds}
        onToggleVisible={(id, geojson) => showTempLayer(id, geojson)}
        onHide={(id) => hideTempLayer(id)}
        extVisibleIds={extVisibleIds}
        onToggleExtVisible={(key, geojson) => showExtLayer(key, geojson)}
        onHideExt={(key) => hideExtLayer(key)}
      />

      {/* Go-to coordinate modal */}
      <DraggableModal
        title={<><EnvironmentOutlined style={{ marginRight: 8 }} />Go to Coordinate</>}
        open={gotoOpen}
        onCancel={() => setGotoOpen(false)}
        onOk={handleGoTo}
        okText="Go"
        width={360}
        styles={{ body: { background: '#0e0e1e' } }}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={10}>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Latitude (°N)</div>
            <Input placeholder="e.g. 12.9716" value={gotoLat}
              onChange={(e) => setGotoLat(e.target.value)} onPressEnter={handleGoTo} />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Longitude (°E)</div>
            <Input placeholder="e.g. 77.5946" value={gotoLon}
              onChange={(e) => setGotoLon(e.target.value)} onPressEnter={handleGoTo} />
          </div>
        </Space>
      </DraggableModal>

      {/* Topology results modal */}
      <DraggableModal
        title={<><CheckCircleOutlined style={{ marginRight: 8 }} />Topology Check Results</>}
        open={topoOpen}
        onCancel={() => setTopoOpen(false)}
        footer={<Button onClick={() => setTopoOpen(false)}>Close</Button>}
        width={560}
        styles={{ body: { background: '#0e0e1e', maxHeight: 420, overflowY: 'auto' } }}
      >
        {topoIssues.length === 0 ? (
          <div style={{ color: '#4CAF50', textAlign: 'center', padding: 24, fontSize: 14 }}>
            <CheckCircleOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block' }} />
            No topology issues found!
          </div>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {topoIssues.map((issue, i) => (
              <div key={i}
                style={{ background: '#0a0e1a', border: '1px solid #1a3a5a', borderRadius: 4, padding: '8px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <WarningOutlined style={{ color: issue.type === 'OVERLAP' ? '#ff9800' : '#f44336' }} />
                  <Tag color={issue.type === 'OVERLAP' ? 'orange' : 'red'} style={{ fontSize: 11 }}>
                    {issue.type}
                  </Tag>
                </div>
                <div style={{ color: '#ccc', fontSize: 12 }}>
                  Parcel: <span style={{ color: '#4fc3f7' }}>{issue.parcel_a.parcel_id}</span> — {issue.parcel_a.name}
                  {issue.parcel_b && (
                    <> &amp; <span style={{ color: '#4fc3f7' }}>{issue.parcel_b.parcel_id}</span> — {issue.parcel_b.name}</>
                  )}
                </div>
              </div>
            ))}
          </Space>
        )}
      </DraggableModal>

      {/* Coordinate picker modal */}
      <DraggableModal
        title={<><EnvironmentOutlined style={{ marginRight: 8 }} />Picked Coordinate</>}
        open={coordModalOpen}
        onCancel={() => setCoordModalOpen(false)}
        footer={<Button onClick={() => setCoordModalOpen(false)}>Close</Button>}
        width={340}
        styles={{ body: { background: '#0e0e1e' } }}
      >
        {coordResult && (
          <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={10}>
            {[
              { label: 'Latitude', value: coordResult.lat.toFixed(6) },
              { label: 'Longitude', value: coordResult.lon.toFixed(6) },
              { label: 'DMS', value: `${Math.abs(coordResult.lat).toFixed(4)}°${coordResult.lat >= 0 ? 'N' : 'S'} ${Math.abs(coordResult.lon).toFixed(4)}°${coordResult.lon >= 0 ? 'E' : 'W'}` },
            ].map((row) => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#888', fontSize: 12 }}>{row.label}</span>
                <Space>
                  <span style={{ color: '#e0e0e0', fontFamily: 'monospace', fontSize: 13 }}>{row.value}</span>
                  <Button
                    size="small" type="text" icon={<CopyOutlined />}
                    style={{ color: '#4fc3f7', padding: 0 }}
                    onClick={() => { navigator.clipboard.writeText(row.value); message.success('Copied') }}
                  />
                </Space>
              </div>
            ))}
            <Button
              block style={{ marginTop: 4 }} size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                const txt = `${coordResult.lat.toFixed(6)}, ${coordResult.lon.toFixed(6)}`
                navigator.clipboard.writeText(txt)
                message.success('Coordinates copied')
              }}
            >
              Copy Lat, Lon
            </Button>
          </Space>
        )}
      </DraggableModal>

      {/* WMS Import modal */}
      <DraggableModal
        title={<><ApiOutlined style={{ marginRight: 8 }} />Add WMS / BHUVAN Layer</>}
        open={wmsModalOpen}
        onCancel={() => setWmsModalOpen(false)}
        onOk={handleAddWmsLayer}
        okText="Add Layer"
        width={460}
        styles={{ body: { background: '#0e0e1e' } }}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={12}>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>WMS Service URL *</div>
            <Input
              placeholder="https://bhuvan-vec1.nrsc.gov.in/bhuvan/wms"
              value={wmsUrl} onChange={(e) => setWmsUrl(e.target.value)}
            />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Layer Name *</div>
            <Input placeholder="e.g. india_admin:india_district" value={wmsLayerName} onChange={(e) => setWmsLayerName(e.target.value)} />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Display Title</div>
            <Input placeholder="e.g. BHUVAN Districts" value={wmsTitle} onChange={(e) => setWmsTitle(e.target.value)} />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>SRS / CRS</div>
            <AntSelect
              style={{ width: '100%' }}
              value={wmsSrs}
              onChange={setWmsSrs}
              options={[
                { value: 'EPSG:4326', label: 'EPSG:4326 (WGS 84)' },
                { value: 'EPSG:3857', label: 'EPSG:3857 (Web Mercator)' },
                { value: 'EPSG:32643', label: 'EPSG:32643 (UTM Zone 43N)' },
                { value: 'EPSG:32644', label: 'EPSG:32644 (UTM Zone 44N)' },
              ]}
            />
          </div>
        </Space>
      </DraggableModal>

      {/* Feature attributes modal */}
      <Modal
        title={
          <Space>
            {featureModalMeta?.layerType === 'external'
              ? <CloudServerOutlined style={{ color: '#ff6600' }} />
              : featureModalMeta?.layerType === 'temp'
                ? <UploadOutlined style={{ color: '#a855f7' }} />
                : <AimOutlined style={{ color: '#1890ff' }} />}
            <span style={{ color: '#e0e0e0' }}>
              {featureModalMeta?.layerLabel ?? 'Feature Attributes'}
            </span>
            {featureModalMeta?.layerType === 'external' && (
              <Tag color="orange" style={{ fontSize: 10 }}>External</Tag>
            )}
            {featureModalMeta?.layerType === 'temp' && (
              <Tag color="purple" style={{ fontSize: 10 }}>Temp Layer</Tag>
            )}
          </Space>
        }
        open={drawerOpen}
        onCancel={() => { setDrawerOpen(false); setFeatureInfo(null); setFeatureModalMeta(null) }}
        footer={<Button onClick={() => { setDrawerOpen(false); setFeatureInfo(null); setFeatureModalMeta(null) }}>Close</Button>}
        width={480}
        styles={{
          content: { background: '#1e1e1e', border: '1px solid #333' },
          header: { background: '#1e1e1e', borderBottom: '1px solid #333' },
          footer: { background: '#1e1e1e', borderTop: '1px solid #333' },
          mask: { background: 'rgba(0,0,0,0.6)' },
        }}
      >
        {featureInfo && (() => {
          // Separate nested `attributes` object from top-level metadata
          const meta: [string, unknown][] = []
          const attrs: [string, string][] = []
          const skip = new Set(['geometry', 'attributes'])
          for (const [k, v] of Object.entries(featureInfo)) {
            if (skip.has(k)) continue
            if (v !== null && v !== undefined && String(v) !== '') meta.push([k, v])
          }
          const attrObj = featureInfo.attributes as Record<string, unknown> | undefined
          if (attrObj && typeof attrObj === 'object') {
            for (const [k, v] of Object.entries(attrObj)) {
              if (v !== null && v !== undefined && String(v) !== '') attrs.push([k, String(v)])
            }
          }
          const labelStyle: React.CSSProperties = { color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }
          const valueStyle: React.CSSProperties = { color: '#e8e8e8', fontSize: 13, wordBreak: 'break-word' }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {meta.length > 0 && (
                <div>
                  <div style={{ color: '#666', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Layer Info</div>
                  <Descriptions column={1} size="small" bordered
                    labelStyle={{ background: '#2a2a2a', color: '#888', fontSize: 11, width: 120 }}
                    contentStyle={{ background: '#1e1e1e', color: '#e8e8e8', fontSize: 12 }}>
                    {meta.map(([k, v]) => (
                      <Descriptions.Item key={k} label={k}>
                        {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                </div>
              )}
              {attrs.length > 0 && (
                <div>
                  <div style={{ color: '#666', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Attributes</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                    {attrs.map(([k, v]) => (
                      <div key={k} style={{ borderBottom: '1px solid #2a2a2a', paddingBottom: 6 }}>
                        <div style={labelStyle}>{k}</div>
                        <div style={valueStyle}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {meta.length === 0 && attrs.length === 0 && (
                <div style={{ color: '#666', textAlign: 'center', padding: '20px 0' }}>No attributes available</div>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* Layer panel drawer */}
      <Drawer
        title="Layers & Tools"
        placement="right"
        open={layerPanelOpen}
        onClose={() => setLayerPanelOpen(false)}
        width={380}
        styles={{ body: { background: '#0e0e1e', padding: '12px 14px' }, header: { background: '#0e0e1e', borderBottom: '1px solid #222' } }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={0}>
          {/* Static layers */}
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>BASE LAYERS</div>
          {[
            { label: 'District Boundaries', color: '#4fc3f7' },
            { label: 'Project Features', color: DEFAULT_LAYER_COLOR },
          ].map((l) => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ width: 14, height: 14, background: l.color, borderRadius: 2, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: '#ccc' }}>{l.label}</span>
            </div>
          ))}

          {/* ── FEATURE LAYERS ────────────────────────────────── */}
          {layerNames.length > 0 && (
            <>
              <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
              <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>FEATURE LAYERS</div>
              {layerNames.map((ln) => {
                const s = getLayerStyle(layerStyles, ln)
                const upd = (patch: Partial<LayerStyle>) =>
                  setLayerStyles((prev) => ({ ...prev, [ln]: { ...getLayerStyle(prev, ln), ...patch } }))
                const isExpanded = expandedLayer === ln
                const cnt = layerFeatureCount[ln] ?? 0
                const attrs = getLayerAttributes(ln)

                const sliderRow = (label: string, key: keyof LayerStyle, min: number, max: number, step: number, fmt?: (v: number) => string) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    <span style={{ color: '#666', fontSize: 10, width: 60, flexShrink: 0 }}>{label}</span>
                    <Slider min={min} max={max} step={step} value={s[key] as number}
                      onChange={(v) => upd({ [key]: v })}
                      style={{ flex: 1, margin: 0 }}
                      tooltip={{ formatter: fmt ? (v) => fmt(v!) : undefined }} />
                    <InputNumber size="small" min={min} max={max} step={step} value={s[key] as number}
                      onChange={(v) => v != null && upd({ [key]: v as any })}
                      style={{ width: 48, fontSize: 11 }} />
                  </div>
                )

                return (
                  <div
                    key={ln}
                    draggable
                    onDragStart={() => { dragLayerRef.current = ln }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      const from = dragLayerRef.current
                      if (!from || from === ln) return
                      setLayerOrder((prev) => {
                        const arr = [...prev]; const fi = arr.indexOf(from), ti = arr.indexOf(ln)
                        if (fi < 0 || ti < 0) return prev
                        arr.splice(fi, 1); arr.splice(ti, 0, from); return arr
                      })
                      dragLayerRef.current = null
                    }}
                    style={{ marginBottom: 6, background: '#0d1a2a', border: `1px solid ${isExpanded ? '#4fc3f766' : '#1a2a3a'}`, borderRadius: 4, opacity: s.visible ? 1 : 0.5 }}
                  >
                    {/* Compact header row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px' }}>
                      <DragOutlined style={{ color: '#555', cursor: 'grab', fontSize: 11, flexShrink: 0 }} />
                      <Button size="small" type="text" style={{ padding: 0, color: s.visible ? '#4fc3f7' : '#444', flexShrink: 0 }}
                        icon={s.visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                        onClick={() => upd({ visible: !s.visible })} />
                      <Button size="small" type="text" style={{ padding: 0, color: s.locked ? '#faad14' : '#555', flexShrink: 0 }}
                        icon={s.locked ? <LockOutlined /> : <UnlockOutlined />}
                        onClick={() => upd({ locked: !s.locked })} />
                      <div style={{ width: 12, height: 12, borderRadius: 2, background: s.fillColor, border: `2px solid ${s.strokeColor}`, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#ddd', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ln}>{ln}</span>
                      <Badge count={cnt} size="small" style={{ background: '#1a3a4a', fontSize: 9 }} overflowCount={9999} />
                      {moveLayerActive === ln && (
                        <Button size="small" danger style={{ fontSize: 10, padding: '0 4px', height: 18, flexShrink: 0 }}
                          onClick={deactivateMoveLayer}>Stop</Button>
                      )}
                      <Button size="small" type="text" style={{ padding: 0, color: isExpanded ? '#4fc3f7' : '#555', flexShrink: 0 }}
                        icon={<SettingOutlined />}
                        onClick={() => setExpandedLayer(isExpanded ? null : ln)} />
                    </div>

                    {/* Expanded editor */}
                    {isExpanded && (
                      <div style={{ borderTop: '1px solid #1a2a3a', padding: '6px 4px 4px' }}>
                        <Tabs size="small" defaultActiveKey="symbol"
                          tabBarStyle={{ marginBottom: 6, fontSize: 11 }}
                          items={[
                            {
                              key: 'symbol', label: 'Symbol',
                              children: (
                                <div style={{ fontSize: 11 }}>
                                  {/* Fill */}
                                  <div style={{ color: '#4fc3f7', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>FILL</div>
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ color: '#888', width: 60 }}>Color</span>
                                    <ColorPicker size="small" value={s.fillColor} onChange={(c) => upd({ fillColor: c.toHexString() })} />
                                    <span style={{ color: '#888', marginLeft: 8 }}>Pattern</span>
                                    <AntSelect size="small" value={s.fillPattern} onChange={(v) => upd({ fillPattern: v })}
                                      style={{ flex: 1 }}
                                      options={[{value:'solid',label:'Solid'},{value:'none',label:'None'},{value:'hatched',label:'Hatched'},{value:'crosshatched',label:'Cross-hatch'}]} />
                                  </div>
                                  {sliderRow('Opacity %', 'fillOpacity', 0, 100, 5, (v) => `${v}%`)}
                                  <Divider style={{ borderColor: '#1a2a3a', margin: '6px 0' }} />
                                  {/* Stroke */}
                                  <div style={{ color: '#4fc3f7', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>STROKE / BORDER</div>
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                                    <span style={{ color: '#888', width: 60 }}>Color</span>
                                    <ColorPicker size="small" value={s.strokeColor} onChange={(c) => upd({ strokeColor: c.toHexString() })} />
                                  </div>
                                  {sliderRow('Width px', 'strokeWidth', 0, 12, 0.5, (v) => `${v}px`)}
                                  {sliderRow('Opacity %', 'strokeOpacity', 0, 100, 5, (v) => `${v}%`)}
                                  <div style={{ display: 'flex', gap: 6, marginBottom: 3, alignItems: 'center' }}>
                                    <span style={{ color: '#888', width: 60, fontSize: 10 }}>Style</span>
                                    <AntSelect size="small" value={s.strokeStyle} onChange={(v) => upd({ strokeStyle: v })} style={{ flex: 1 }}
                                      options={[{value:'solid',label:'Solid'},{value:'dash',label:'Dashed'},{value:'dot',label:'Dotted'},{value:'dashdot',label:'Dash-dot'},{value:'longdash',label:'Long dash'}]} />
                                  </div>
                                  <div style={{ display: 'flex', gap: 6, marginBottom: 3, alignItems: 'center' }}>
                                    <span style={{ color: '#888', width: 60, fontSize: 10 }}>Cap</span>
                                    <Segmented size="small" value={s.strokeCap} onChange={(v) => upd({ strokeCap: v as any })}
                                      options={['butt','round','square']} style={{ fontSize: 10 }} />
                                  </div>
                                  <div style={{ display: 'flex', gap: 6, marginBottom: 3, alignItems: 'center' }}>
                                    <span style={{ color: '#888', width: 60, fontSize: 10 }}>Join</span>
                                    <Segmented size="small" value={s.strokeJoin} onChange={(v) => upd({ strokeJoin: v as any })}
                                      options={['miter','round','bevel']} style={{ fontSize: 10 }} />
                                  </div>
                                  <Divider style={{ borderColor: '#1a2a3a', margin: '6px 0' }} />
                                  {/* Point */}
                                  <div style={{ color: '#4fc3f7', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>POINT SYMBOL</div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                                    {(['circle','square','triangle','diamond','star','cross','x'] as const).map((shape) => (
                                      <Button key={shape} size="small"
                                        type={s.pointShape === shape ? 'primary' : 'default'}
                                        style={{ padding: '0 6px', fontSize: 10, height: 22 }}
                                        onClick={() => upd({ pointShape: shape })}>{shape}</Button>
                                    ))}
                                  </div>
                                  {sliderRow('Size px', 'pointSize', 2, 20, 1, (v) => `${v}px`)}
                                  {sliderRow('Rotation°', 'pointRotation', 0, 360, 5, (v) => `${v}°`)}
                                </div>
                              ),
                            },
                            {
                              key: 'labels', label: 'Labels',
                              children: (
                                <div style={{ fontSize: 11 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <span style={{ color: '#ccc' }}>Show Labels</span>
                                    <Switch size="small" checked={s.showLabels} onChange={(v) => upd({ showLabels: v })} />
                                  </div>
                                  <div style={{ opacity: s.showLabels ? 1 : 0.4, pointerEvents: s.showLabels ? 'auto' : 'none' }}>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
                                      <span style={{ color: '#888', width: 60 }}>Field</span>
                                      <AntSelect size="small" value={s.labelField} onChange={(v) => upd({ labelField: v })} style={{ flex: 1 }}
                                        options={attrs.map((a) => ({ value: a, label: a }))} />
                                    </div>
                                    {sliderRow('Font size', 'labelFontSize', 8, 24, 1, (v) => `${v}px`)}
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 }}>
                                      <span style={{ color: '#888', width: 60 }}>Bold</span>
                                      <Switch size="small" checked={s.labelBold} onChange={(v) => upd({ labelBold: v })} />
                                      <span style={{ color: '#888', marginLeft: 8 }}>Color</span>
                                      <ColorPicker size="small" value={s.labelColor} onChange={(c) => upd({ labelColor: c.toHexString() })} />
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 }}>
                                      <span style={{ color: '#888', width: 60 }}>Halo</span>
                                      <ColorPicker size="small" value={s.labelHaloColor} onChange={(c) => upd({ labelHaloColor: c.toHexString() })} />
                                      <span style={{ color: '#888', marginLeft: 4 }}>Width</span>
                                      <InputNumber size="small" min={0} max={6} value={s.labelHaloWidth} onChange={(v) => v != null && upd({ labelHaloWidth: v })} style={{ width: 50 }} />
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
                                      <span style={{ color: '#888', width: 60 }}>Placement</span>
                                      <AntSelect size="small" value={s.labelPlacement} onChange={(v) => upd({ labelPlacement: v })} style={{ flex: 1 }}
                                        options={['center','above','below','left','right'].map((v) => ({ value: v, label: v }))} />
                                    </div>
                                    {sliderRow('Offset Y', 'labelOffsetY', -40, 40, 2)}
                                  </div>
                                </div>
                              ),
                            },
                            {
                              key: 'render', label: 'Rendering',
                              children: (
                                <div style={{ fontSize: 11 }}>
                                  {sliderRow('Opacity %', 'opacity', 0, 100, 5, (v) => `${v}%`)}
                                  {sliderRow('Min zoom', 'minZoom', 0, 22, 1)}
                                  {sliderRow('Max zoom', 'maxZoom', 0, 22, 1)}
                                  <Divider style={{ borderColor: '#1a2a3a', margin: '6px 0' }} />
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ color: '#888', width: 60 }}>Lock layer</span>
                                    <Switch size="small" checked={s.locked} onChange={(v) => upd({ locked: v })} />
                                    <span style={{ color: '#666', fontSize: 10, marginLeft: 4 }}>(prevents editing)</span>
                                  </div>
                                </div>
                              ),
                            },
                            {
                              key: 'manage', label: 'Manage',
                              children: (
                                <div style={{ fontSize: 11 }}>
                                  <div style={{ color: '#aaa', marginBottom: 6 }}>Features: <strong style={{ color: '#4fc3f7' }}>{cnt}</strong></div>
                                  {/* Selection */}
                                  <div style={{ color: '#4fc3f7', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>SELECTION</div>
                                  <Space wrap size={4} style={{ marginBottom: 6 }}>
                                    <Button size="small" icon={<SelectOutlined />} onClick={() => selectAllInLayer(ln)} style={{ fontSize: 10 }}>Select All</Button>
                                    <Button size="small" icon={<CloseOutlined />} onClick={clearSelection} style={{ fontSize: 10 }}>Clear</Button>
                                    <Button size="small" icon={<SwapOutlined />} onClick={() => invertSelection(ln)} style={{ fontSize: 10 }}>Invert</Button>
                                    <Button size="small" icon={<FilterOutlined />}
                                      onClick={() => { setAttrField(attrs[0] ?? ''); setAttrOp('='); setAttrValue(''); setSelectAttrModal({ ln }) }}
                                      style={{ fontSize: 10 }}>By Attribute…</Button>
                                  </Space>
                                  <Divider style={{ borderColor: '#1a2a3a', margin: '5px 0' }} />
                                  {/* Editing */}
                                  <div style={{ color: '#4fc3f7', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>EDIT</div>
                                  <Space wrap size={4} style={{ marginBottom: 6 }}>
                                    <Button size="small" icon={<DeleteOutlined />} danger disabled={isReadOnly} onClick={deleteSelectedFeatures} style={{ fontSize: 10 }}>Del Selected</Button>
                                    <Button size="small" icon={<CopyOutlined />} onClick={copySelected} style={{ fontSize: 10 }}>Copy</Button>
                                    <Button size="small" icon={<MergeCellsOutlined />} disabled={isReadOnly} onClick={() => pasteFeatures(ln)} style={{ fontSize: 10 }}>Paste</Button>
                                    <Button size="small"
                                      icon={moveLayerActive === ln ? <CloseOutlined /> : <DragOutlined />}
                                      type={moveLayerActive === ln ? 'primary' : 'default'}
                                      disabled={isReadOnly}
                                      onClick={() => moveLayerActive === ln ? deactivateMoveLayer() : activateMoveLayer(ln)}
                                      style={{ fontSize: 10 }}>{moveLayerActive === ln ? 'Stop Move' : 'Move'}</Button>
                                    <Button size="small" icon={<CalculatorOutlined />}
                                      disabled={isReadOnly}
                                      onClick={() => { setCalcField(''); setCalcValue(''); setCalcTarget('selected'); setCalcFieldModal({ ln }) }}
                                      style={{ fontSize: 10 }}>Calc Field…</Button>
                                    <Button size="small" icon={<SearchOutlined />}
                                      onClick={() => { setAnalysisField(''); setFindVal(''); setReplaceVal(''); setFindReplaceModal({ ln }) }}
                                      style={{ fontSize: 10 }}>Find &amp; Replace</Button>
                                  </Space>
                                  <Divider style={{ borderColor: '#1a2a3a', margin: '5px 0' }} />
                                  {/* Layer management */}
                                  <div style={{ color: '#4fc3f7', fontSize: 10, fontWeight: 600, marginBottom: 4 }}>LAYER</div>
                                  <Space wrap size={4}>
                                    <Button size="small" icon={<FullscreenOutlined />} onClick={() => zoomToLayer(ln)} style={{ fontSize: 10 }}>Zoom to</Button>
                                    <Button size="small" icon={<DownloadOutlined />}
                                      onClick={() => window.open(`/api/projects/${selectedProjectId}/export/?format=geojson&layer_name=${encodeURIComponent(ln)}`, '_blank')}
                                      style={{ fontSize: 10 }}>Export</Button>
                                    <Button size="small" danger icon={<ClearOutlined />}
                                      disabled={isReadOnly}
                                      onClick={() => { if (confirm(`Delete ALL ${cnt} features in "${ln}"?`)) deleteAllInLayer(ln) }}
                                      style={{ fontSize: 10 }}>Clear All</Button>
                                    <Button size="small" icon={<FunctionOutlined />}
                                      onClick={() => { setGradField(''); setGraduatedModal({ ln }) }}
                                      style={{ fontSize: 10 }}>Classify…</Button>
                                  </Space>
                                </div>
                              ),
                            },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* GeoTiff layers */}
          {geotiffs.length > 0 && (
            <>
              <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
              <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>GEOTIFF LAYERS</div>
              {geotiffs.map((g) => {
                const isVisible = cogVisible[g.id] !== false
                return (
                  <div key={g.id} style={{ marginBottom: 10, opacity: isVisible ? 1 : 0.5 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: '#ddd', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.folder_name ? <span style={{ color: '#888', fontSize: 10 }}>{g.folder_name} / </span> : null}
                        {g.name}
                      </span>
                      <Tooltip title={isVisible ? 'Hide layer' : 'Show layer'}>
                        <Button
                          size="small" type="text"
                          icon={isVisible ? <EyeOutlined style={{ color: '#4fc3f7' }} /> : <EyeInvisibleOutlined style={{ color: '#555' }} />}
                          onClick={() => {
                            const next = !isVisible
                            setCogVisible((prev) => ({ ...prev, [g.id]: next }))
                            api.patch(`/projects/geotiffs/${g.id}/`, { is_visible: next }).catch(() => {})
                          }}
                          style={{ padding: 0, flexShrink: 0 }}
                        />
                      </Tooltip>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: '#888', fontSize: 11, width: 50 }}>Opacity</span>
                      <Slider min={0} max={1} step={0.05} value={cogOpacities[g.id] ?? g.opacity} style={{ flex: 1 }}
                        onChange={(val) => {
                          cogLayers.current[g.id]?.setOpacity(val)
                          setCogOpacities((prev) => ({ ...prev, [g.id]: val }))
                        }}
                        onChangeComplete={(val) => {
                          api.patch(`/projects/geotiffs/${g.id}/`, { opacity: val }).catch(() => {})
                        }} />
                      <span style={{ color: '#888', fontSize: 11, width: 30 }}>
                        {Math.round((cogOpacities[g.id] ?? g.opacity) * 100)}%
                      </span>
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {/* Heatmap + WMS / Vector Analysis / Snapping — disabled when area is read-only */}
          <div style={{ opacity: isReadOnly ? 0.4 : 1, pointerEvents: isReadOnly ? 'none' : 'auto', transition: 'opacity 0.2s' }}>
          <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>ANALYSIS LAYERS</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: '#ddd' }}>
              <HeatMapOutlined style={{ marginRight: 6, color: '#f5222d' }} />
              Parcel Heatmap
            </span>
            <Switch
              size="small"
              loading={heatmapLoading}
              checked={heatmapVisible}
              onChange={setHeatmapVisible}
            />
          </div>

          <Button
            size="small"
            icon={<ApiOutlined />}
            onClick={() => setWmsModalOpen(true)}
            style={{ width: '100%', fontSize: 12, marginBottom: wmsLayerList.length > 0 ? 6 : 0 }}
          >
            Add WMS / BHUVAN Layer
          </Button>
          {wmsLayerList.map((l) => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <span style={{ fontSize: 12, color: '#90caf9', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.title}</span>
              <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#666', flexShrink: 0 }} onClick={() => removeWmsLayer(l.id)} />
            </div>
          ))}

          {/* Topology check */}
          <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TOPOLOGY</div>
          <Button
            size="small"
            icon={<CheckCircleOutlined />}
            loading={topoLoading}
            onClick={handleCheckTopology}
            style={{ width: '100%', fontSize: 12 }}
          >
            Check Topology
          </Button>

          {/* Vector Analysis */}
          <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>VECTOR ANALYSIS</div>
          <Space wrap size={4}>
            <Button size="small" icon={<SisternodeOutlined />} onClick={() => { setAnalysisLayer(''); setDissolveModal(true) }} style={{ fontSize: 10 }}>Dissolve</Button>
            <Button size="small" icon={<NodeIndexOutlined />} onClick={() => { setSpatialJoinModal(true) }} style={{ fontSize: 10 }}>Spatial Join</Button>
            <Button size="small" icon={<ScissorOutlined />} onClick={() => { setClipModal(true) }} style={{ fontSize: 10 }}>Clip</Button>
            <Button size="small" icon={<CalculatorOutlined />} onClick={() => { setSummaryModal(true); setSummaryData(null) }} style={{ fontSize: 10 }}>Summary Stats</Button>
            <Button size="small" icon={<RadiusUprightOutlined />} onClick={() => { setNearModal(true) }} style={{ fontSize: 10 }}>Near</Button>
            <Button size="small" icon={<RadiusUpleftOutlined />} onClick={() => { setHullModal(true) }} style={{ fontSize: 10 }}>Convex Hull</Button>
            <Button size="small" icon={<EnvironmentOutlined />} onClick={() => { setCentroidModal(true) }} style={{ fontSize: 10 }}>Centroids</Button>
            <Button size="small" icon={<CalculatorOutlined />} onClick={() => {
              if (selectedProjectId) {
                setAnalysisLoading(true)
                api.post('/projects/features/auto-geometry-stats/', { project: selectedProjectId })
                  .then(r => message.success(r.data.detail))
                  .catch(() => message.error('Failed'))
                  .finally(() => setAnalysisLoading(false))
              }
            }} loading={analysisLoading} style={{ fontSize: 10 }}>Geometry Stats</Button>
          </Space>

          {/* Swipe comparison */}
          <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>LAYER SWIPE</div>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <AntSelect
              placeholder="Select layer to swipe"
              style={{ width: '100%', fontSize: 11 }}
              size="small"
              allowClear
              value={swiperLayer}
              onChange={(v) => { setSwiperLayer(v ?? null); setSwiperActive(!!v) }}
              options={layerNames.map(ln => ({ value: ln, label: ln }))}
            />
            {swiperActive && (
              <Slider
                min={0} max={100} value={swiperPos}
                onChange={setSwiperPos}
                tooltip={{ formatter: (v) => `${v}%` }}
              />
            )}
          </Space>

          {/* Snapping */}
          <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>SNAPPING</div>
          <Space size={4} wrap>
            <Button size="small" type={snapVertex ? 'primary' : 'default'} onClick={() => setSnapVertex(!snapVertex)} style={{ fontSize: 10 }}>Vertex</Button>
            <Button size="small" type={snapEdge ? 'primary' : 'default'} onClick={() => setSnapEdge(!snapEdge)} style={{ fontSize: 10 }}>Edge</Button>
            <Button size="small" type={snapMidpoint ? 'primary' : 'default'} onClick={() => setSnapMidpoint(!snapMidpoint)} style={{ fontSize: 10 }}>Midpoint</Button>
          </Space>
          </div>{/* end read-only gate */}

          {/* Projects */}
          <Divider style={{ borderColor: '#1a1a2e', margin: '10px 0' }} />
          <div style={{ color: '#aaa', fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>PROJECTS</div>
          {projects?.results?.map((p) => (
            <div
              key={p.id}
              style={{
                marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                background: selectedProjectId === p.id ? 'rgba(79,195,247,0.12)' : 'transparent',
                border: selectedProjectId === p.id ? '1px solid #4fc3f744' : '1px solid transparent',
              }}
              onClick={() => { setSelectedProjectId(p.id); setLayerPanelOpen(false) }}
            >
              <div>
                <div style={{ fontSize: 12, color: selectedProjectId === p.id ? '#4fc3f7' : '#ddd' }}>{p.name}</div>
                {selectedProjectId === p.id && activeVersion && (
                  <div style={{ fontSize: 10, color: '#4CAF50', marginTop: 1 }}>✓ {activeVersion.name}</div>
                )}
              </div>
              <Tag style={{ fontSize: 10, lineHeight: '16px', height: 16 }}
                color={p.status === 'PUBLISHED' ? 'green' : p.status === 'DRAFT' ? 'default' : 'blue'}>
                {p.status}
              </Tag>
            </div>
          ))}
        </Space>
      </Drawer>

      {/* ── Select by Attribute modal ─────────────────────────────────── */}
      <DraggableModal
        title={<><FilterOutlined style={{ marginRight: 8 }} />Select by Attribute — {selectAttrModal?.ln}</>}
        open={!!selectAttrModal}
        onCancel={() => setSelectAttrModal(null)}
        onOk={() => {
          if (selectAttrModal) selectByAttribute(selectAttrModal.ln, attrField, attrOp, attrValue)
          setSelectAttrModal(null)
        }}
        okText="Select"
        width={460}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={10}>
          <div style={{ display: 'flex', gap: 8 }}>
            <AntSelect
              value={attrField}
              onChange={setAttrField}
              style={{ flex: 1 }}
              placeholder="Field"
              options={(selectAttrModal ? getLayerAttributes(selectAttrModal.ln) : []).map((a) => ({ value: a, label: a }))}
            />
            <AntSelect
              value={attrOp}
              onChange={setAttrOp}
              style={{ width: 110 }}
              options={[
                { value: '=', label: '= equals' },
                { value: '!=', label: '≠ not equals' },
                { value: '>', label: '> greater' },
                { value: '<', label: '< less' },
                { value: '>=', label: '≥ ≥' },
                { value: '<=', label: '≤ ≤' },
                { value: 'contains', label: '⊃ contains' },
                { value: 'starts', label: '⌶ starts with' },
                { value: 'ends', label: '⌷ ends with' },
              ]}
            />
          </div>
          <Input
            placeholder="Value to match"
            value={attrValue}
            onChange={(e) => setAttrValue(e.target.value)}
            onPressEnter={() => {
              if (selectAttrModal) selectByAttribute(selectAttrModal.ln, attrField, attrOp, attrValue)
              setSelectAttrModal(null)
            }}
          />
        </Space>
      </DraggableModal>

      {/* ── Calculate Field modal ─────────────────────────────────────── */}
      <DraggableModal
        title={<><CalculatorOutlined style={{ marginRight: 8 }} />Calculate Field — {calcFieldModal?.ln}</>}
        open={!!calcFieldModal}
        onCancel={() => setCalcFieldModal(null)}
        onOk={async () => {
          if (calcFieldModal) await calculateField(calcFieldModal.ln, calcField, calcValue, calcTarget)
          setCalcFieldModal(null)
        }}
        okText="Apply"
        width={460}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={10}>
          <div style={{ display: 'flex', gap: 8 }}>
            <AntSelect
              value={calcField || undefined}
              onChange={setCalcField}
              style={{ flex: 1 }}
              placeholder="Field name (existing or new)"
              showSearch
              allowClear
              options={(calcFieldModal ? getLayerAttributes(calcFieldModal.ln) : []).map((a) => ({ value: a, label: a }))}
            />
            <Input
              placeholder="Field name (new)"
              value={calcField}
              onChange={(e) => setCalcField(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <Input
            placeholder="Value (number or text)"
            value={calcValue}
            onChange={(e) => setCalcValue(e.target.value)}
          />
          <div>
            <span style={{ color: '#aaa', fontSize: 12, marginRight: 8 }}>Apply to:</span>
            <Radio.Group value={calcTarget} onChange={(e) => setCalcTarget(e.target.value)} size="small">
              <Radio value="selected">Selected features ({selectedCount})</Radio>
              <Radio value="all">All features in layer ({calcFieldModal ? (layerFeatureCount[calcFieldModal.ln] ?? 0) : 0})</Radio>
            </Radio.Group>
          </div>
        </Space>
      </DraggableModal>

      {/* ── Dissolve Modal ──────────────────────────────────────────────── */}
      <DraggableModal title="Dissolve Layer" open={dissolveModal} onCancel={() => setDissolveModal(false)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Layer to dissolve" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer} />
          <Input placeholder="Field to dissolve by (e.g. district)" value={analysisField} onChange={e => setAnalysisField(e.target.value)} />
          <Input placeholder="Output layer name" value={analysisOutLayer} onChange={e => setAnalysisOutLayer(e.target.value)} />
          <Button type="primary" loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!analysisLayer) { message.warning('Select a layer to dissolve'); return }
              if (!analysisField.trim()) { message.warning('Enter a field to dissolve by'); return }
              if (!selectedProjectId) { message.warning('Select a project first'); return }
              setAnalysisLoading(true)
              api.post('/projects/features/dissolve/', { project: selectedProjectId, layer_name: analysisLayer, dissolve_field: analysisField, out_layer: analysisOutLayer || undefined })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setDissolveModal(false) })
                .catch(e => message.error(e?.response?.data?.detail || 'Dissolve failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Run Dissolve</Button>
        </Space>
      </DraggableModal>

      {/* ── Spatial Join Modal ──────────────────────────────────────────── */}
      <DraggableModal title="Spatial Join" open={spatialJoinModal} onCancel={() => setSpatialJoinModal(false)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Base layer (receives attributes)" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer} />
          <AntSelect placeholder="Overlay layer (provides attributes)" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer2} />
          <Button type="primary" loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!analysisLayer) { message.warning('Select a base layer'); return }
              if (!analysisLayer2) { message.warning('Select an overlay layer'); return }
              setAnalysisLoading(true)
              api.post('/projects/features/spatial-join/', { project: selectedProjectId, base_layer: analysisLayer, overlay_layer: analysisLayer2 })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setSpatialJoinModal(false) })
                .catch(e => message.error(e?.response?.data?.detail || 'Spatial join failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Run Spatial Join</Button>
        </Space>
      </DraggableModal>

      {/* ── Clip Modal ──────────────────────────────────────────────────── */}
      <DraggableModal title="Clip Layer to Boundary" open={clipModal} onCancel={() => setClipModal(false)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Layer to clip" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer} />
          <AntSelect placeholder="Clip boundary layer" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer2} />
          <Button type="primary" danger loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!analysisLayer) { message.warning('Select a layer to clip'); return }
              if (!analysisLayer2) { message.warning('Select a clip boundary layer'); return }
              setAnalysisLoading(true)
              api.post('/projects/features/clip-to-boundary/', { project: selectedProjectId, layer_name: analysisLayer, clip_layer: analysisLayer2 })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setClipModal(false) })
                .catch(e => message.error(e?.response?.data?.detail || 'Clip failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Clip (modifies features in-place)</Button>
        </Space>
      </DraggableModal>

      {/* ── Summary Stats Modal ─────────────────────────────────────────── */}
      <DraggableModal title="Summary Statistics" open={summaryModal} onCancel={() => setSummaryModal(false)} footer={null} width={560}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Select layer" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))}
            onChange={(v) => {
              setAnalysisLayer(v)
              setAnalysisLoading(true)
              api.get(`/projects/features/summary-stats/?project=${selectedProjectId}&layer_name=${v}`)
                .then(r => setSummaryData(r.data))
                .catch(() => message.error('Failed'))
                .finally(() => setAnalysisLoading(false))
            }} />
          {summaryData && (
            <div>
              <Tag color="blue">Total features: {summaryData.feature_count}</Tag>
              {Object.entries(summaryData.fields || {}).map(([field, stats]: any) => (
                <div key={field} style={{ marginTop: 8, background: '#0e1a2e', padding: 8, borderRadius: 4 }}>
                  <div style={{ color: '#4fc3f7', fontWeight: 600, marginBottom: 4 }}>{field}</div>
                  <Space wrap size={4}>
                    {['count','sum','min','max','avg'].map(k => (
                      <Tag key={k}>{k}: {stats[k]}</Tag>
                    ))}
                  </Space>
                </div>
              ))}
            </div>
          )}
        </Space>
      </DraggableModal>

      {/* ── Near Analysis Modal ─────────────────────────────────────────── */}
      <DraggableModal title="Near Analysis" open={nearModal} onCancel={() => setNearModal(false)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Base layer (features to analyze)" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer} />
          <AntSelect placeholder="Near layer (find nearest from)" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer2} />
          <Button type="primary" loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!analysisLayer) { message.warning('Select a base layer'); return }
              if (!analysisLayer2) { message.warning('Select a near layer'); return }
              setAnalysisLoading(true)
              api.post('/projects/features/near-analysis/', { project: selectedProjectId, base_layer: analysisLayer, near_layer: analysisLayer2 })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setNearModal(false) })
                .catch(e => message.error(e?.response?.data?.detail || 'Near analysis failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Run Near Analysis</Button>
        </Space>
      </DraggableModal>

      {/* ── Convex Hull Modal ───────────────────────────────────────────── */}
      <DraggableModal title="Convex Hull" open={hullModal} onCancel={() => setHullModal(false)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Source layer" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer} />
          <Input placeholder="Output layer name (optional)" value={analysisOutLayer} onChange={e => setAnalysisOutLayer(e.target.value)} />
          <Button type="primary" loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!analysisLayer) { message.warning('Select a source layer'); return }
              setAnalysisLoading(true)
              api.post('/projects/features/convex-hull/', { project: selectedProjectId, layer_name: analysisLayer, out_layer: analysisOutLayer || undefined })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setHullModal(false) })
                .catch(e => message.error(e?.response?.data?.detail || 'Convex hull failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Generate Convex Hull</Button>
        </Space>
      </DraggableModal>

      {/* ── Centroid Extract Modal ──────────────────────────────────────── */}
      <DraggableModal title="Extract Centroids" open={centroidModal} onCancel={() => setCentroidModal(false)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <AntSelect placeholder="Polygon layer" style={{ width: '100%' }} options={layerNames.map(l => ({ value: l, label: l }))} onChange={setAnalysisLayer} />
          <Input placeholder="Output layer name (optional)" value={analysisOutLayer} onChange={e => setAnalysisOutLayer(e.target.value)} />
          <Button type="primary" loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!analysisLayer) { message.warning('Select a polygon layer'); return }
              setAnalysisLoading(true)
              api.post('/projects/features/centroid-extract/', { project: selectedProjectId, layer_name: analysisLayer, out_layer: analysisOutLayer || undefined })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setCentroidModal(false) })
                .catch(e => message.error(e?.response?.data?.detail || 'Centroid extraction failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Extract Centroids</Button>
        </Space>
      </DraggableModal>

      {/* ── Find & Replace Modal ────────────────────────────────────────── */}
      <DraggableModal title={`Find & Replace — ${findReplaceModal?.ln}`} open={!!findReplaceModal} onCancel={() => setFindReplaceModal(null)} footer={null}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Input placeholder="Field name" value={analysisField} onChange={e => setAnalysisField(e.target.value)} />
          <Input placeholder="Find value" value={findVal} onChange={e => setFindVal(e.target.value)} />
          <Input placeholder="Replace with" value={replaceVal} onChange={e => setReplaceVal(e.target.value)} />
          <Button type="primary" loading={analysisLoading} style={{ width: '100%' }}
            onClick={() => {
              if (!findReplaceModal) return
              setAnalysisLoading(true)
              api.post('/projects/features/find-replace/', {
                project: selectedProjectId, layer_name: findReplaceModal.ln,
                field_name: analysisField, find_val: findVal, replace_val: replaceVal,
              })
                .then(r => { message.success(r.data.detail); qc.invalidateQueries({ queryKey: qk.projectFeatures(selectedProjectId ?? 0) }); setFindReplaceModal(null) })
                .catch(e => message.error(e?.response?.data?.detail || 'Failed'))
                .finally(() => setAnalysisLoading(false))
            }}>Replace All</Button>
        </Space>
      </DraggableModal>

      {/* ── Graduated / Classify Modal ──────────────────────────────────── */}
      <DraggableModal title={`Classify Layer — ${graduatedModal?.ln}`} open={!!graduatedModal} onCancel={() => setGraduatedModal(null)} footer={null} width={500}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Radio.Group value={gradMode} onChange={e => setGradMode(e.target.value)}>
            <Radio.Button value="unique">Unique Values</Radio.Button>
            <Radio.Button value="graduated">Graduated Colors</Radio.Button>
          </Radio.Group>
          <Input placeholder="Attribute field to classify by (e.g. category, district)" value={gradField} onChange={e => setGradField(e.target.value)} />
          {gradMode === 'graduated' && (
            <div>
              <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Number of classes</div>
              <InputNumber min={2} max={10} value={gradBreaks} onChange={v => setGradBreaks(v ?? 5)} />
            </div>
          )}
          <Button type="primary" style={{ width: '100%' }}
            onClick={() => {
              const ln = graduatedModal?.ln
              if (!ln || !gradField) return
              const src = projectLayer.current?.getSource()
              if (!src) return
              const vals = new Set<string>()
              src.getFeatures().forEach(f => {
                if (f.get('layer_name') === ln) {
                  const a = f.get('attributes') as any
                  if (a && gradField in a) vals.add(String(a[gradField]))
                }
              })
              const PALETTE = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#e91e63','#00bcd4']
              const rules: Record<string, string[]> = {}
              Array.from(vals).forEach((v, i) => {
                rules[v] = [PALETTE[i % PALETTE.length], PALETTE[i % PALETTE.length]]
              })
              setGraduatedRules(prev => ({ ...prev, [ln]: rules }))
              graduatedRulesRef.current = { ...(graduatedRulesRef.current || {}), [ln]: rules }
              graduatedFieldRef.current = { ...(graduatedFieldRef.current || {}), [ln]: gradField }
              projectLayer.current?.getSource()?.changed()
              message.success(`Applied ${vals.size} color classes for "${gradField}"`)
              setGraduatedModal(null)
            }}>Apply Classification</Button>
          <Button style={{ width: '100%' }} onClick={() => {
            const ln = graduatedModal?.ln
            if (!ln) return
            const newRules = { ...graduatedRulesRef.current }
            delete newRules[ln]
            graduatedRulesRef.current = newRules
            const newFields = { ...graduatedFieldRef.current }
            delete newFields[ln]
            graduatedFieldRef.current = newFields
            projectLayer.current?.getSource()?.changed()
            setGraduatedModal(null)
          }}>Clear Classification</Button>
        </Space>
      </DraggableModal>

      {/* ── Rotate Feature modal ── */}
      <DraggableModal
        title="Rotate Feature(s)"
        open={rotateModalOpen}
        onCancel={() => { setRotateModalOpen(false); setRotateAngle(0) }}
        onOk={() => { applyRotate(rotateAngle); setRotateModalOpen(false) }}
        okText="Apply Rotation"
        width={340}
      >
        <Space direction="vertical" style={{ width: '100%', padding: '8px 0' }}>
          <div style={{ color: '#aaa', fontSize: 12 }}>Rotation angle (degrees, positive = counter-clockwise)</div>
          <Slider min={-180} max={180} step={1} value={rotateAngle} onChange={setRotateAngle}
            marks={{ '-90': '-90°', 0: '0°', 90: '90°', 180: '180°' }} />
          <InputNumber addonAfter="°" value={rotateAngle} onChange={(v) => setRotateAngle(v ?? 0)}
            min={-360} max={360} style={{ width: '100%' }} />
        </Space>
      </DraggableModal>

      {/* ── Scale Feature modal ── */}
      <DraggableModal
        title="Scale Feature(s)"
        open={scaleModalOpen}
        onCancel={() => { setScaleModalOpen(false); setScaleFactor(1) }}
        onOk={() => { applyScale(scaleFactor); setScaleModalOpen(false) }}
        okText="Apply Scale"
        width={340}
      >
        <Space direction="vertical" style={{ width: '100%', padding: '8px 0' }}>
          <div style={{ color: '#aaa', fontSize: 12 }}>Scale factor (1.0 = no change, 2.0 = double size, 0.5 = half)</div>
          <Slider min={0.1} max={5} step={0.1} value={scaleFactor} onChange={setScaleFactor}
            marks={{ 0.5: '0.5×', 1: '1×', 2: '2×', 5: '5×' }} />
          <InputNumber addonAfter="×" value={scaleFactor} onChange={(v) => setScaleFactor(v ?? 1)}
            min={0.01} max={100} step={0.1} style={{ width: '100%' }} />
        </Space>
      </DraggableModal>

      {/* ── Simplify Geometry modal ── */}
      <DraggableModal
        title="Simplify Geometry"
        open={simplifyModalOpen}
        onCancel={() => { setSimplifyModalOpen(false) }}
        onOk={() => { applySimplify(simplifyTolerance); setSimplifyModalOpen(false) }}
        okText="Apply Simplify"
        width={360}
      >
        <Space direction="vertical" style={{ width: '100%', padding: '8px 0' }}>
          <div style={{ color: '#aaa', fontSize: 12 }}>Tolerance in metres — higher = fewer vertices (more simplified)</div>
          <Slider min={0.1} max={100} step={0.1} value={simplifyTolerance} onChange={setSimplifyTolerance}
            marks={{ 0.5: '0.5m', 5: '5m', 20: '20m', 100: '100m' }} />
          <InputNumber addonAfter="m" value={simplifyTolerance} onChange={(v) => setSimplifyTolerance(v ?? 0.5)}
            min={0.1} max={10000} step={0.1} style={{ width: '100%' }} />
          <div style={{ color: '#666', fontSize: 11 }}>Douglas-Peucker simplification. Use small values for detailed boundaries.</div>
        </Space>
      </DraggableModal>

      {/* ── Offset Curve modal ── */}
      {/* ── Draw Layer Chooser ─────────────────────────────────────────── */}
      <DraggableModal
        title="Save Feature — Choose Layer"
        open={drawLayerModal}
        okText="Save Feature"
        onCancel={() => {
          // Remove the unsaved feature from the map
          if (pendingDrawFeatureRef.current)
            projectLayer.current?.getSource()?.removeFeature(pendingDrawFeatureRef.current)
          pendingDrawFeatureRef.current = null
          setDrawLayerModal(false)
        }}
        onOk={() => {
          let ln: string
          if (drawLayerChoice === 'new') {
            ln = drawNewLayerName.trim().slice(0, 200)
            if (!ln) { message.warning('Enter a layer name'); return }
          } else {
            ln = drawExistingLayer
            if (!ln) { message.warning('Select a layer from the list'); return }
          }
          saveDrawnFeature(ln)
          setDrawLayerModal(false)
        }}
        width={420}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Button
              type={drawLayerChoice === 'existing' ? 'primary' : 'default'}
              size="small"
              disabled={editableLayerNames.length === 0}
              onClick={() => setDrawLayerChoice('existing')}
              style={{ marginRight: 8 }}
            >
              Add to Existing Layer
            </Button>
            <Button
              type={drawLayerChoice === 'new' ? 'primary' : 'default'}
              size="small"
              onClick={() => setDrawLayerChoice('new')}
            >
              Create New Layer
            </Button>
          </div>
          {drawLayerChoice === 'existing' && editableLayerNames.length > 0 && (
            <>
              <AntSelect
                style={{ width: '100%' }}
                value={drawExistingLayer || undefined}
                onChange={setDrawExistingLayer}
                options={editableLayerNames.map((ln) => ({ value: ln, label: ln }))}
                placeholder="Select layer"
              />
              {editableLayerNames.length < rawLayerNames.length && (
                <div style={{ fontSize: 11, color: '#faad14' }}>
                  Layers from submitted/approved areas are hidden — only editable layers shown.
                </div>
              )}
            </>
          )}
          {drawLayerChoice === 'new' && (
            <Input
              placeholder="e.g. Survey Polygon, Phase-I Road"
              value={drawNewLayerName}
              onChange={(e) => setDrawNewLayerName(e.target.value)}
            />
          )}
        </Space>
      </DraggableModal>

      <DraggableModal
        title="Offset Curve"
        open={offsetModalOpen}
        onCancel={() => { setOffsetModalOpen(false) }}
        onOk={() => { applyOffsetCurve(offsetDistance); setOffsetModalOpen(false) }}
        okText="Create Offset Line"
        width={360}
      >
        <Space direction="vertical" style={{ width: '100%', padding: '8px 0' }}>
          <div style={{ color: '#aaa', fontSize: 12 }}>Offset distance in metres (positive = left side, negative = right side)</div>
          <Slider min={-500} max={500} step={1} value={offsetDistance} onChange={setOffsetDistance}
            marks={{ '-100': '-100m', 0: '0', 100: '100m' }} />
          <InputNumber addonAfter="m" value={offsetDistance} onChange={(v) => setOffsetDistance(v ?? 10)}
            min={-10000} max={10000} style={{ width: '100%' }} />
          <div style={{ color: '#666', fontSize: 11 }}>A new line feature will be created parallel to the selected line(s).</div>
        </Space>
      </DraggableModal>

      {/* ── New Shapefile Layer Modal ─────────────────────────── */}
      {selectedProjectId && (
        <NewLayerModal
          open={newLayerModalOpen}
          onClose={() => setNewLayerModalOpen(false)}
          projectId={selectedProjectId}
          surveyAreas={surveyAreas as any}
        />
      )}

      {/* ── Import GIS File Modal ─────────────────────────────── */}
      {selectedProjectId && (
        <ImportGISModal
          open={importGISModalOpen}
          onClose={() => setImportGISModalOpen(false)}
          projectId={selectedProjectId}
          surveyArea={selectedSurveyArea as any}
          flatFolders={flatFolders}
          onImported={() => {
            qc.invalidateQueries({ queryKey: ['map-features', selectedProjectId] })
            qc.invalidateQueries({ queryKey: ['folders-flat', selectedProjectId] })
          }}
        />
      )}
    </div>
  )
}
