import { useState } from 'react'
import {
  Button, Card, Table, Tag, Space, Modal, Form, Input, InputNumber,
  Switch, message, Popconfirm, Tooltip, Alert, Spin, Tabs, Select,
  Typography, Badge, Divider, Radio,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined,
  SyncOutlined, TableOutlined, CloudServerOutlined,
  CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined,
  FilterOutlined, BarChartOutlined, BgColorsOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '@/services/api'

const { Text } = Typography

interface ExtDB {
  id: number
  name: string
  host: string
  port: number
  database: string
  schema: string
  username: string
  is_active: boolean
  description: string
  test_status: 'UNTESTED' | 'OK' | 'ERROR'
  test_message: string
  last_tested_at: string | null
  last_sync_at: string | null
  layer_count: number
  password_set: boolean
}

// Per-level filter map: {"PDDE":"colname", "DEO":"colname", ...}
type LevelFilterFields = Record<string, string>

interface ExtLayer {
  id: number
  database: number
  database_name: string
  table_name: string
  schema_name: string
  display_name: string
  geometry_type: string
  geometry_column: string
  id_column: string
  label_column: string
  office_filter_field: string
  level_filter_fields: LevelFilterFields
  analysis_columns: string[]
  style: Record<string, unknown>
  cantonment_scope: 'INSIDE' | 'OUTSIDE'
  inside_render_type: 'GLR_PLAN' | 'OTHERS'
  classification_field: string
  classification_colors: Record<string, { color: string; opacity?: number }>
  is_active: boolean
  display_order: number
  feature_count: number | null
  bbox: number[] | null
  last_synced_at: string | null
}

// All org levels — super admin maps each to the appropriate column in the external table
const FILTERABLE_LEVELS = [
  { key: 'DGDE', label: 'DGDE (National)' },
  { key: 'PDDE', label: 'PDDE (Command)' },
  { key: 'DEO',  label: 'DEO (District/Area)' },
  { key: 'CEO',  label: 'CEO (Cantonment)' },
  { key: 'ADEO', label: 'ADEO (Sub-Area)' },
]

const LEVEL_TAG_COLOR: Record<string, string> = {
  DGDE: 'gold', PDDE: 'blue', DEO: 'cyan', CEO: 'green', ADEO: 'orange',
}

const CLASS_NULL_KEY = '__null__'

// Suggested colours for common GLR land-classification codes (super admin can override).
const SUGGESTED_CLASS_COLORS: Record<string, string> = {
  'A1': '#1b5e20', 'A2': '#66bb6a', 'B1': '#1565c0', 'B2': '#00bcd4',
  'B2-PRIVATE': '#7b1fa2', 'B3': '#ef6c00', 'B4': '#795548', 'C': '#d32f2f',
  'FREE HOLD': '#fdd835', 'FREEHOLD': '#fdd835', 'NIL': '#9e9e9e',
  'PVT': '#ec407a', [CLASS_NULL_KEY]: '#e0e0e0',
}
// Fallback rotating palette for values not in the suggested map.
const CLASS_PALETTE = [
  '#1b5e20', '#1565c0', '#ef6c00', '#6a1b9a', '#00838f', '#c62828',
  '#558b2f', '#4527a0', '#ad1457', '#00695c', '#e65100', '#283593',
]
function suggestColor(value: string, idx: number): string {
  const k = (value || '').toUpperCase().trim()
  return SUGGESTED_CLASS_COLORS[k] || CLASS_PALETTE[idx % CLASS_PALETTE.length]
}

interface TableColumn {
  column_name: string
  data_type: string
}

interface SpatialTable {
  schema: string
  table: string
  geom_column: string
  geom_type: string
  srid: number
  row_count: number | null
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  OK:       <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  ERROR:    <CloseCircleOutlined style={{ color: '#ff4d4f' }} />,
  UNTESTED: <QuestionCircleOutlined style={{ color: '#faad14' }} />,
}

const GEOM_COLOR: Record<string, string> = {
  POINT: 'blue', MULTIPOINT: 'blue',
  LINESTRING: 'cyan', MULTILINESTRING: 'cyan',
  POLYGON: 'green', MULTIPOLYGON: 'green',
  GEOMETRY: 'default',
}

export default function ExternalDatabasePage() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [dbModalOpen, setDbModalOpen]     = useState(false)
  const [editingDb,   setEditingDb]       = useState<ExtDB | null>(null)
  const [dbForm]                           = Form.useForm()
  const [savingDb, setSavingDb]           = useState(false)

  const [selectedDbId,  setSelectedDbId]  = useState<number | null>(null)
  const [tablesOpen,    setTablesOpen]    = useState(false)
  const [tables,        setTables]        = useState<SpatialTable[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)

  const [layerModalOpen, setLayerModalOpen] = useState(false)
  const [layerForm]                          = Form.useForm()

  const [testingId, setTestingId]  = useState<number | null>(null)
  const [syncingId,  setSyncingId]  = useState<number | null>(null)

  // Per-level office-filter configuration modal
  const [filterLayer,       setFilterLayer]       = useState<ExtLayer | null>(null)
  const [filterCols,        setFilterCols]        = useState<TableColumn[]>([])
  const [filterColsLoad,    setFilterColsLoad]    = useState(false)
  // Draft state: per-level map + legacy fallback field
  const [levelFields,       setLevelFields]       = useState<LevelFilterFields>({})
  const [defaultFilterField, setDefaultFilterField] = useState<string>('')
  const [cantonmentScope,   setCantonmentScope]   = useState<'INSIDE' | 'OUTSIDE'>('OUTSIDE')
  const [savingFilter,      setSavingFilter]      = useState(false)

  // Analysis columns configuration modal
  const [analysisLayer,     setAnalysisLayer]     = useState<ExtLayer | null>(null)
  const [analysisCols,      setAnalysisCols]      = useState<TableColumn[]>([])
  const [analysisColsLoad,  setAnalysisColsLoad]  = useState(false)
  const [selectedAnalysisCols, setSelectedAnalysisCols] = useState<string[]>([])
  const [savingAnalysis,    setSavingAnalysis]    = useState(false)

  async function openAnalysisConfig(layer: ExtLayer) {
    setAnalysisLayer(layer)
    setSelectedAnalysisCols(layer.analysis_columns ?? [])
    setAnalysisCols([])
    setAnalysisColsLoad(true)
    try {
      const r = await api.get(`/external/layers/${layer.id}/columns/`)
      setAnalysisCols(r.data)
    } catch {
      message.error('Could not load columns')
    } finally {
      setAnalysisColsLoad(false)
    }
  }

  async function saveAnalysisConfig() {
    if (!analysisLayer) return
    setSavingAnalysis(true)
    try {
      await api.patch(`/external/layers/${analysisLayer.id}/`, { analysis_columns: selectedAnalysisCols })
      qc.invalidateQueries({ queryKey: ['ext-layers'] })
      message.success('Analysis columns saved')
      setAnalysisLayer(null)
    } catch {
      message.error('Save failed')
    } finally {
      setSavingAnalysis(false)
    }
  }

  async function openFilterConfig(layer: ExtLayer) {
    setFilterLayer(layer)
    setLevelFields(layer.level_filter_fields || {})
    setDefaultFilterField(layer.office_filter_field || '')
    setCantonmentScope(layer.cantonment_scope || 'OUTSIDE')
    setFilterCols([])
    setFilterColsLoad(true)
    try {
      const r = await api.get(`/external/layers/${layer.id}/columns/`)
      setFilterCols(r.data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Could not load columns')
    } finally {
      setFilterColsLoad(false)
    }
  }

  function setLevelField(level: string, col: string) {
    setLevelFields(prev => ({ ...prev, [level]: col }))
  }

  async function saveFilterConfig() {
    if (!filterLayer) return
    setSavingFilter(true)
    // Strip empty-string entries so the backend JSON stays clean
    const cleaned: LevelFilterFields = {}
    for (const [k, v] of Object.entries(levelFields)) {
      if (v) cleaned[k] = v
    }
    try {
      await api.patch(`/external/layers/${filterLayer.id}/`, {
        level_filter_fields: cleaned,
        office_filter_field: defaultFilterField.trim(),
        cantonment_scope: cantonmentScope,
      })
      const configuredCount = Object.keys(cleaned).length
      message.success(configuredCount || defaultFilterField
        ? `Filter saved (${configuredCount} level(s) + ${defaultFilterField ? 'default set' : 'no default'})`
        : 'All filters cleared — all users see all rows')
      qc.invalidateQueries({ queryKey: ['ext-layers'] })
      setFilterLayer(null)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Save failed')
    } finally {
      setSavingFilter(false)
    }
  }

  // Classification (thematic rendering) configuration modal
  const [classLayer,      setClassLayer]      = useState<ExtLayer | null>(null)
  const [classCols,       setClassCols]       = useState<TableColumn[]>([])
  const [classColsLoad,   setClassColsLoad]   = useState(false)
  const [classField,      setClassField]      = useState<string>('')
  // Draft colour map: { value: { color, opacity } }
  const [classColors,     setClassColors]     = useState<Record<string, { color: string; opacity: number }>>({})
  const [classValsLoad,   setClassValsLoad]   = useState(false)
  const [savingClass,     setSavingClass]     = useState(false)
  // INSIDE-cantonment render choice + flat colour (for Outside / Inside-Others)
  const [insideType,      setInsideType]      = useState<'GLR_PLAN' | 'OTHERS'>('OTHERS')
  const [flatColor,       setFlatColor]       = useState<string>('#ff6600')
  const [flatOpacity,     setFlatOpacity]     = useState<number>(0.4)

  async function openClassConfig(layer: ExtLayer) {
    setClassLayer(layer)
    setClassField(layer.classification_field || '')
    setInsideType(layer.inside_render_type || (layer.classification_field ? 'GLR_PLAN' : 'OTHERS'))
    const st = (layer.style || {}) as { color?: string; opacity?: number }
    setFlatColor(st.color || '#ff6600')
    setFlatOpacity(st.opacity == null ? 0.4 : st.opacity)
    const existing: Record<string, { color: string; opacity: number }> = {}
    for (const [k, v] of Object.entries(layer.classification_colors || {})) {
      existing[k] = { color: v.color || '#bdbdbd', opacity: v.opacity == null ? 0.6 : v.opacity }
    }
    setClassColors(existing)
    setClassCols([])
    setClassColsLoad(true)
    try {
      const r = await api.get(`/external/layers/${layer.id}/columns/`)
      setClassCols(r.data)
    } catch {
      message.error('Could not load columns')
    } finally {
      setClassColsLoad(false)
    }
  }

  // Pull distinct values for the chosen field and auto-assign suggested colours.
  async function autoGenerateClassColors() {
    if (!classLayer || !classField) {
      message.warning('Select a classification field first.')
      return
    }
    setClassValsLoad(true)
    try {
      const r = await api.get(`/external/layers/${classLayer.id}/distinct-values/`, {
        params: { field: classField },
      })
      const values: string[] = r.data.values || []
      setClassColors(prev => {
        const next = { ...prev }
        values.forEach((v, i) => {
          if (!next[v]) next[v] = { color: suggestColor(v, i), opacity: 0.6 }
        })
        if (!next[CLASS_NULL_KEY]) next[CLASS_NULL_KEY] = { color: '#e0e0e0', opacity: 0.5 }
        return next
      })
      message.success(`Loaded ${values.length} value(s)`)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Could not load distinct values')
    } finally {
      setClassValsLoad(false)
    }
  }

  function setClassColor(value: string, patch: Partial<{ color: string; opacity: number }>) {
    setClassColors(prev => ({ ...prev, [value]: { ...prev[value], ...patch } }))
  }
  function removeClassValue(value: string) {
    setClassColors(prev => { const n = { ...prev }; delete n[value]; return n })
  }

  async function saveClassConfig() {
    if (!classLayer) return
    // Classification colouring is available only for INSIDE + GLR Plan.
    const useClassification = classLayer.cantonment_scope === 'INSIDE' && insideType === 'GLR_PLAN'
    setSavingClass(true)
    try {
      const payload: Record<string, unknown> = classLayer.cantonment_scope === 'INSIDE'
        ? { inside_render_type: insideType } : {}
      if (useClassification) {
        payload.classification_field = classField.trim()
        payload.classification_colors = classField.trim() ? classColors : {}
      } else {
        // Flat single colour + opacity; clear any classification config.
        payload.classification_field = ''
        payload.classification_colors = {}
        payload.style = { color: flatColor, opacity: flatOpacity }
      }
      await api.patch(`/external/layers/${classLayer.id}/`, payload)
      qc.invalidateQueries({ queryKey: ['ext-layers'] })
      message.success(useClassification
        ? 'Classification rendering saved — reload the map to see it'
        : 'Colour saved — reload the map to see it')
      setClassLayer(null)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Save failed')
    } finally {
      setSavingClass(false)
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: databases = [], isLoading: dbLoading } = useQuery<ExtDB[]>({
    queryKey: ['ext-databases'],
    queryFn: () => api.get('/external/databases/').then(r => r.data.results ?? r.data),
  })

  const { data: layers = [], isLoading: layerLoading } = useQuery<ExtLayer[]>({
    queryKey: ['ext-layers'],
    queryFn: () => api.get('/external/layers/').then(r => r.data.results ?? r.data),
  })

  // ── DB CRUD ───────────────────────────────────────────────────────────────
  async function saveDb(values: Record<string, unknown>) {
    setSavingDb(true)
    try {
      if (editingDb) {
        await api.patch(`/external/databases/${editingDb.id}/`, values)
        message.success(t('common.updated'))
      } else {
        await api.post('/external/databases/', values)
        message.success(t('common.created'))
      }
      qc.invalidateQueries({ queryKey: ['ext-databases'] })
      setDbModalOpen(false)
      dbForm.resetFields()
      setEditingDb(null)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Save failed')
    } finally {
      setSavingDb(false)
    }
  }

  const deleteDbMut = useMutation({
    mutationFn: (id: number) => api.delete(`/external/databases/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ext-databases'] }); message.success('Deleted') },
  })

  // ── Test connection ───────────────────────────────────────────────────────
  async function testConnection(db: ExtDB) {
    setTestingId(db.id)
    try {
      const r = await api.post(`/external/databases/${db.id}/test/`)
      if (r.data.ok) message.success(`Connected: ${r.data.message?.slice(0, 60)}`)
      else message.error(`Failed: ${r.data.message}`)
      qc.invalidateQueries({ queryKey: ['ext-databases'] })
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Test failed')
    } finally {
      setTestingId(null)
    }
  }

  // ── Sync organisations ────────────────────────────────────────────────────
  async function syncOrgs(db: ExtDB) {
    setSyncingId(db.id)
    try {
      const r = await api.post(`/external/databases/${db.id}/sync-orgs/`)
      const { created, updated, errors } = r.data
      message.success(`Synced: ${created} created, ${updated} updated`)
      if (errors?.length) message.warning(`${errors.length} error(s) — check logs`)
      qc.invalidateQueries({ queryKey: ['ext-databases'] })
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Sync failed')
    } finally {
      setSyncingId(null)
    }
  }

  // ── Browse spatial tables ─────────────────────────────────────────────────
  async function browseTables(db: ExtDB) {
    setSelectedDbId(db.id)
    setTablesOpen(true)
    setTablesLoading(true)
    setTables([])
    try {
      const r = await api.get(`/external/databases/${db.id}/tables/`)
      setTables(r.data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Could not list tables')
    } finally {
      setTablesLoading(false)
    }
  }

  // ── Add layer from table ──────────────────────────────────────────────────
  function addLayerFromTable(t: SpatialTable) {
    layerForm.setFieldsValue({
      database:         selectedDbId,
      schema_name:      t.schema,
      table_name:       t.table,
      display_name:     t.table,
      geometry_column:  t.geom_column,
      geometry_type:    t.geom_type,
      srid:             t.srid,
      id_column:        'gid',
      is_active:        true,
      display_order:    0,
    })
    setLayerModalOpen(true)
  }

  async function saveLayer(values: Record<string, unknown>) {
    try {
      await api.post('/external/layers/', values)
      message.success(t('common.created'))
      qc.invalidateQueries({ queryKey: ['ext-layers'] })
      setLayerModalOpen(false)
      layerForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Failed')
    }
  }

  const deleteLayerMut = useMutation({
    mutationFn: (id: number) => api.delete(`/external/layers/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ext-layers'] }); message.success(t('common.deleted')) },
  })

  // ── Column definitions ────────────────────────────────────────────────────
  const dbCols: ColumnsType<ExtDB> = [
    {
      title: 'Database', dataIndex: 'name',
      render: (n, row) => (
        <Space>
          <CloudServerOutlined style={{ color: row.is_active ? '#1890ff' : '#888' }} />
          <span style={{ fontWeight: 500 }}>{n}</span>
          {!row.is_active && <Tag color="default">Inactive</Tag>}
        </Space>
      ),
    },
    { title: 'Host', render: (_, r) => <Text code>{r.host}:{r.port}/{r.database}</Text>, },
    {
      title: 'Status', width: 100,
      render: (_, r) => (
        <Space>
          {STATUS_ICON[r.test_status]}
          <span style={{ fontSize: 11, color: '#888' }}>{r.test_status}</span>
        </Space>
      ),
    },
    { title: 'Layers', dataIndex: 'layer_count', width: 65, align: 'right',
      render: (n) => <Badge count={n} showZero style={{ backgroundColor: '#1890ff' }} /> },
    { title: 'Last Sync', dataIndex: 'last_sync_at', width: 120,
      render: (v) => v ? new Date(v).toLocaleDateString('en-IN') : '—' },
    {
      title: 'Actions', width: 260,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tooltip title="Test connection">
            <Button size="small" icon={<ApiOutlined />} loading={testingId === row.id}
              onClick={() => testConnection(row)}>{t("external.test")}</Button>
          </Tooltip>
          <Tooltip title="Import mst_office → Organisations">
            <Button size="small" icon={<SyncOutlined />} loading={syncingId === row.id}
              onClick={() => syncOrgs(row)}>{t("external.sync_orgs")}</Button>
          </Tooltip>
          <Tooltip title="Browse spatial tables">
            <Button size="small" icon={<TableOutlined />} onClick={() => browseTables(row)}>
              Tables
            </Button>
          </Tooltip>
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setEditingDb(row)
            dbForm.setFieldsValue({ ...row, password: '' })
            setDbModalOpen(true)
          }} />
          <Popconfirm title="Delete this database config?" okButtonProps={{ danger: true }}
            onConfirm={() => deleteDbMut.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const layerCols: ColumnsType<ExtLayer> = [
    {
      title: 'Layer', dataIndex: 'display_name',
      render: (n, r) => (
        <Space>
          <Tag color={GEOM_COLOR[r.geometry_type] ?? 'default'} style={{ fontSize: 10 }}>
            {r.geometry_type?.replace('MULTI', 'M-') ?? '?'}
          </Tag>
          <span style={{ fontWeight: 500 }}>{n}</span>
          {!r.is_active && <Tag color="default" style={{ fontSize: 10 }}>Hidden</Tag>}
        </Space>
      ),
    },
    { title: 'Source', render: (_, r) => <Text code style={{ fontSize: 11 }}>{r.schema_name}.{r.table_name}</Text> },
    { title: 'Database', dataIndex: 'database_name', width: 130 },
    { title: 'Features', dataIndex: 'feature_count', width: 80, align: 'right',
      render: v => v != null ? v.toLocaleString() : '—' },
    {
      title: 'Level Filters', width: 200,
      render: (_, row) => {
        const lf = row.level_filter_fields || {}
        const entries = FILTERABLE_LEVELS.filter(l => lf[l.key])
        if (entries.length === 0)
          return <Tag color="default" style={{ fontSize: 10 }}>All users see all rows</Tag>
        return (
          <Space size={2} wrap>
            {entries.map(l => (
              <Tag key={l.key} color={LEVEL_TAG_COLOR[l.key] ?? 'default'} style={{ fontSize: 10 }}>
                {l.key}:{lf[l.key]}
              </Tag>
            ))}
          </Space>
        )
      },
    },
    {
      title: 'Actions', width: 200,
      render: (_, row) => (
        <Space>
          <Tooltip title="Configure analysis columns (shown in Intersecting/Nearby tables)">
            <Button size="small" icon={<BarChartOutlined />}
              onClick={() => openAnalysisConfig(row)} />
          </Tooltip>
          <Tooltip title="Configure office data filter">
            <Button size="small" icon={<FilterOutlined />}
              onClick={() => openFilterConfig(row)} />
          </Tooltip>
          <Tooltip title="Classification-based colour rendering">
            <Button size="small" icon={<BgColorsOutlined />}
              type={row.classification_field ? 'primary' : 'default'}
              onClick={() => openClassConfig(row)} />
          </Tooltip>
          <Tooltip title="Refresh stats from external DB">
            <Button size="small" icon={<SyncOutlined />}
              onClick={async () => {
                await api.post(`/external/layers/${row.id}/refresh-stats/`)
                qc.invalidateQueries({ queryKey: ['ext-layers'] })
                message.success('Stats refreshed')
              }} />
          </Tooltip>
          <Popconfirm title="Remove this layer from map?" okButtonProps={{ danger: true }}
            onConfirm={() => deleteLayerMut.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const tableCols: ColumnsType<SpatialTable> = [
    {
      title: 'Table', render: (_, r) => (
        <Space>
          <Tag color={GEOM_COLOR[r.geom_type?.replace('MULTI', 'MULTI')] ?? 'default'} style={{ fontSize: 10 }}>
            {r.geom_type}
          </Tag>
          <Text code>{r.schema}.{r.table}</Text>
        </Space>
      ),
    },
    { title: 'Geom Column', dataIndex: 'geom_column', width: 120 },
    { title: 'SRID', dataIndex: 'srid', width: 70, align: 'right' },
    { title: 'Rows (est.)', dataIndex: 'row_count', width: 100, align: 'right',
      render: v => v != null ? v.toLocaleString() : '—' },
    {
      title: '', width: 100,
      render: (_, row) => {
        const alreadyAdded = layers.some(
          l => l.database === selectedDbId && l.table_name === row.table && l.schema_name === row.schema
        )
        return alreadyAdded
          ? <Tag color="green">Added ✓</Tag>
          : <Button size="small" type="primary" icon={<PlusOutlined />}
              onClick={() => addLayerFromTable(row)}>{t("external.add_to_map")}</Button>
      },
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>External Data Sources</Typography.Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Connect to DGDE operational databases. Read-only layers are served live from the external DB.
          </Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingDb(null); dbForm.resetFields(); setDbModalOpen(true) }}>
          Add Database
        </Button>
      </div>

      <Tabs
        items={[
          {
            key: 'databases', label: <span><CloudServerOutlined /> Databases ({databases.length})</span>,
            children: (
              <Table dataSource={databases} columns={dbCols} rowKey="id"
                loading={dbLoading} size="small" pagination={false} />
            ),
          },
          {
            key: 'layers', label: <span><TableOutlined /> Map Layers ({layers.length})</span>,
            children: (
              <>
                <Alert type="info" showIcon style={{ marginBottom: 12 }}
                  message="These layers are read-only in the map viewer. Use the 'Tables' button on a database to add new layers." />
                <Table dataSource={layers} columns={layerCols} rowKey="id"
                  loading={layerLoading} size="small" pagination={false} />
              </>
            ),
          },
        ]}
      />

      {/* ── Add/Edit DB Modal ─────────────────────────────────────────────── */}
      <Modal
        title={editingDb ? 'Edit Database Connection' : 'Add External Database'}
        open={dbModalOpen}
        onCancel={() => { setDbModalOpen(false); dbForm.resetFields() }}
        onOk={() => dbForm.submit()}
        confirmLoading={savingDb}
        width={520}
      >
        <Form form={dbForm} layout="vertical" onFinish={saveDb} style={{ marginTop: 8 }}>
          <Form.Item name="name" label="Friendly Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. DGDE Operational DB" />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="host" label="Host" style={{ flex: 2 }} rules={[{ required: true }]}>
              <Input placeholder="192.168.1.100 or hostname" />
            </Form.Item>
            <Form.Item name="port" label="Port" style={{ flex: 1 }} initialValue={5432}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="database" label="Database" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input placeholder="postgres" />
            </Form.Item>
            <Form.Item name="schema" label="Schema" style={{ flex: 1 }} initialValue="public">
              <Input placeholder="public" />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="username" label="Username" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input placeholder="postgres" />
            </Form.Item>
            <Form.Item name="password" label={editingDb ? 'Password (leave blank to keep)' : 'Password'}
              style={{ flex: 1 }} rules={editingDb ? [] : [{ required: true }]}>
              <Input.Password />
            </Form.Item>
          </div>
          <Form.Item name="description" label="Notes">
            <Input.TextArea rows={2} placeholder="Optional description" />
          </Form.Item>
          <Form.Item name="is_active" valuePropName="checked" initialValue={true}>
            <Switch checkedChildren="Active" unCheckedChildren="Inactive" /> &nbsp;Active
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Browse Tables Modal ───────────────────────────────────────────── */}
      <Modal
        title={<Space><TableOutlined />Browse Spatial Tables</Space>}
        open={tablesOpen}
        onCancel={() => setTablesOpen(false)}
        footer={<Button onClick={() => setTablesOpen(false)}>Close</Button>}
        width={780}
      >
        {tablesLoading
          ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          : tables.length === 0
            ? <Alert type="warning" message="No spatial tables found or connection error." />
            : <Table dataSource={tables} columns={tableCols} rowKey={r => `${r.schema}.${r.table}`}
                size="small" pagination={{ pageSize: 15, hideOnSinglePage: true }}
                scroll={{ y: 400 }} />
        }
      </Modal>

      {/* ── Add Layer Modal ───────────────────────────────────────────────── */}
      <Modal
        title="Register Layer"
        open={layerModalOpen}
        onCancel={() => { setLayerModalOpen(false); layerForm.resetFields() }}
        onOk={() => layerForm.submit()}
        width={460}
      >
        <Form form={layerForm} layout="vertical" onFinish={saveLayer} style={{ marginTop: 8 }}>
          <Form.Item name="database" hidden><Input /></Form.Item>
          <Form.Item name="schema_name" hidden><Input /></Form.Item>
          <Form.Item name="table_name" hidden><Input /></Form.Item>
          <Form.Item name="geometry_column" hidden><Input /></Form.Item>
          <Form.Item name="geometry_type" hidden><Input /></Form.Item>
          <Form.Item name="srid" hidden><InputNumber /></Form.Item>

          <Form.Item name="display_name" label="Display Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="id_column" label="ID Column" initialValue="gid">
            <Input placeholder="gid" />
          </Form.Item>
          <Form.Item name="label_column" label="Label Column (tooltip)">
            <Input placeholder="name, officename, etc." />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="display_order" label="Display Order" initialValue={0} style={{ flex: 1 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="is_active" valuePropName="checked" initialValue={true} label=" " style={{ flex: 1 }}>
              <Switch checkedChildren="Visible" unCheckedChildren="Hidden" />
            </Form.Item>
          </div>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Analysis Columns Modal ────────────────────────────────────────── */}
      <Modal
        title={<Space><BarChartOutlined />Configure Analysis Columns</Space>}
        open={!!analysisLayer}
        onCancel={() => setAnalysisLayer(null)}
        onOk={saveAnalysisConfig}
        confirmLoading={savingAnalysis}
        okText="Save Columns"
        width={560}
      >
        {analysisLayer && (
          <div style={{ marginTop: 8 }}>
            <Alert
              type="info" showIcon style={{ marginBottom: 16 }}
              message={`Layer: ${analysisLayer.display_name}`}
              description={
                <span style={{ fontSize: 12 }}>
                  Select which columns from this external table appear as columns in the
                  <b> Intersecting Defence Parcels</b> and{' '}
                  <b>Nearby Defence Parcels within __ km</b> analysis result tables.
                  Leave empty to show the first 5 available columns automatically.
                </span>
              }
            />
            {analysisColsLoad
              ? <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
              : (
                <Select
                  mode="multiple"
                  style={{ width: '100%' }}
                  placeholder="Leave empty to auto-show first 5 columns"
                  value={selectedAnalysisCols}
                  onChange={setSelectedAnalysisCols}
                  optionFilterProp="label"
                  options={analysisCols.map(c => ({
                    value: c.column_name,
                    label: `${c.column_name}  (${c.data_type})`,
                  }))}
                />
              )
            }
            {selectedAnalysisCols.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: '#888' }}>
                <strong>Will show:</strong> {selectedAnalysisCols.join(' · ')}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── Per-Level Office Filter Modal ─────────────────────────────────── */}
      <Modal
        title={<Space><FilterOutlined />{t("external.filter_title")}</Space>}
        open={!!filterLayer}
        onCancel={() => setFilterLayer(null)}
        onOk={saveFilterConfig}
        confirmLoading={savingFilter}
        okText={t("external.save_filters")}
        width={580}
      >
        {filterLayer && (
          <div style={{ marginTop: 8 }}>
            <Alert
              type="info" showIcon style={{ marginBottom: 16 }}
              message={`Layer: ${filterLayer.display_name}`}
              description={
                <span style={{ fontSize: 12 }}>
                  For each level, pick the <b>column in the external table</b> whose value
                  must match the user's office code.  Users see only rows for their own
                  office and all offices beneath it in the hierarchy.
                  <br />
                  Leave a level blank to fall through to the <b>Default</b> column (if set),
                  or show all rows if no default is configured.
                  <b> Super Admin always sees all rows.</b>
                </span>
              }
            />

            {/* Inside / Outside cantonment scope */}
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>
                Data Scope
              </Text>
              <Radio.Group
                value={cantonmentScope}
                onChange={(e) => setCantonmentScope(e.target.value)}
                optionType="button" buttonStyle="solid"
              >
                <Radio.Button value="OUTSIDE">Outside Cantonment</Radio.Button>
                <Radio.Button value="INSIDE">Inside Cantonment</Radio.Button>
              </Radio.Group>
              <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                {cantonmentScope === 'INSIDE'
                  ? 'Rows are keyed by cantonment (CB) office code. PDDE → cantonments it controls; DEO → cantonments parented under it; CEO → its own cantonment. DGDE sees all.'
                  : 'Rows are filtered by the user\'s office and everything beneath it in the hierarchy.'}
              </div>
            </div>

            <Divider style={{ margin: '4px 0 12px' }} />

            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, marginBottom: 8 }}>
              <Text strong style={{ fontSize: 12, color: '#888' }}>Level</Text>
              <Text strong style={{ fontSize: 12, color: '#888' }}>Filter Column in External Table</Text>
            </div>

            {/* Super Admin — always unrestricted */}
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <Tag color="purple" style={{ width: 'fit-content' }}>Super Admin</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>No filter — always sees all rows</Text>
            </div>

            <Divider style={{ margin: '4px 0 12px' }} />

            {/* One select per org level */}
            {filterColsLoad
              ? <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>
              : FILTERABLE_LEVELS.map(({ key, label }) => (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                  <Tag color={LEVEL_TAG_COLOR[key] ?? 'default'} style={{ width: 'fit-content' }}>{label}</Tag>
                  <Select
                    showSearch allowClear
                    value={levelFields[key] || undefined}
                    placeholder="— use Default below —"
                    style={{ width: '100%' }}
                    onChange={(v) => setLevelField(key, v || '')}
                    optionFilterProp="label"
                    options={filterCols.map(c => ({
                      value: c.column_name,
                      label: `${c.column_name}  (${c.data_type})`,
                    }))}
                  />
                </div>
              ))
            }

            <Divider style={{ margin: '8px 0 12px' }} />

            {/* Default / fallback field */}
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center' }}>
              <div>
                <Tag color="default" style={{ width: 'fit-content' }}>Default</Tag>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>Fallback for levels not set above</div>
              </div>
              <Select
                showSearch allowClear
                value={defaultFilterField || undefined}
                placeholder="— no default (all rows if level blank) —"
                style={{ width: '100%' }}
                onChange={(v) => setDefaultFilterField(v || '')}
                optionFilterProp="label"
                disabled={filterColsLoad}
                options={filterCols.map(c => ({
                  value: c.column_name,
                  label: `${c.column_name}  (${c.data_type})`,
                }))}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* ── Layer rendering config (flat colour, or classification for GLR Plan) ─ */}
      <Modal
        title={<Space><BgColorsOutlined />Layer Rendering</Space>}
        open={!!classLayer}
        onCancel={() => setClassLayer(null)}
        onOk={saveClassConfig}
        confirmLoading={savingClass}
        okText="Save Rendering"
        width={620}
      >
        {classLayer && (() => {
          const isInside = classLayer.cantonment_scope === 'INSIDE'
          const showClassification = isInside && insideType === 'GLR_PLAN'
          return (
            <div style={{ marginTop: 8 }}>
              <Alert
                type="info" showIcon style={{ marginBottom: 16 }}
                message={`Layer: ${classLayer.display_name} · ${isInside ? 'Inside Cantonment' : 'Outside Cantonment'}`}
                description={
                  <span style={{ fontSize: 12 }}>
                    {isInside
                      ? 'Choose GLR Plan for classification-based colouring, or Others for a single flat colour.'
                      : 'Outside-cantonment layers use a single flat colour with opacity.'}
                  </span>
                }
              />

              {/* Inside-cantonment: GLR Plan vs Others */}
              {isInside && (
                <div style={{ marginBottom: 16 }}>
                  <Text strong style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>
                    Rendering Type
                  </Text>
                  <Radio.Group
                    value={insideType}
                    onChange={(e) => setInsideType(e.target.value)}
                    optionType="button" buttonStyle="solid"
                  >
                    <Radio.Button value="GLR_PLAN">GLR Plan</Radio.Button>
                    <Radio.Button value="OTHERS">Others</Radio.Button>
                  </Radio.Group>
                </div>
              )}

              {showClassification ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                    <Text strong style={{ fontSize: 12, color: '#888' }}>Classification Field</Text>
                    <Select
                      showSearch allowClear
                      value={classField || undefined}
                      placeholder="— select attribute column —"
                      style={{ width: '100%' }}
                      onChange={(v) => setClassField(v || '')}
                      optionFilterProp="label"
                      disabled={classColsLoad}
                      options={classCols.map(c => ({
                        value: c.column_name,
                        label: `${c.column_name}  (${c.data_type})`,
                      }))}
                    />
                  </div>

                  <Space style={{ marginBottom: 12 }}>
                    <Button type="primary" ghost loading={classValsLoad}
                      disabled={!classField}
                      onClick={autoGenerateClassColors}>
                      Auto-generate from data
                    </Button>
                    {Object.keys(classColors).length > 0 && (
                      <Button danger onClick={() => setClassColors({})}>Clear all</Button>
                    )}
                  </Space>

                  {Object.keys(classColors).length > 0 && (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 32px', gap: 8, marginBottom: 6 }}>
                        <Text strong style={{ fontSize: 12, color: '#888' }}>Value</Text>
                        <Text strong style={{ fontSize: 12, color: '#888' }}>Colour</Text>
                        <Text strong style={{ fontSize: 12, color: '#888' }}>Opacity</Text>
                        <span />
                      </div>
                      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                        {Object.entries(classColors).map(([value, cfg]) => (
                          <div key={value} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 90px 32px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                            <Tag style={{ width: 'fit-content' }}>
                              {value === CLASS_NULL_KEY ? 'Null / Others' : value}
                            </Tag>
                            <input
                              type="color"
                              value={cfg.color}
                              onChange={(e) => setClassColor(value, { color: e.target.value })}
                              style={{ width: 60, height: 28, border: 'none', background: 'none', cursor: 'pointer' }}
                            />
                            <InputNumber
                              size="small" min={0} max={1} step={0.1}
                              value={cfg.opacity}
                              onChange={(v) => setClassColor(value, { opacity: v ?? 0.6 })}
                              style={{ width: 80 }}
                            />
                            <Button size="small" type="text" danger icon={<DeleteOutlined />}
                              onClick={() => removeClassValue(value)} />
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : (
                /* Flat single colour + opacity (Outside, or Inside → Others) */
                <div style={{ display: 'grid', gridTemplateColumns: '150px 80px 1fr', gap: 12, alignItems: 'center' }}>
                  <Text strong style={{ fontSize: 12, color: '#888' }}>Fill Colour</Text>
                  <input
                    type="color"
                    value={flatColor}
                    onChange={(e) => setFlatColor(e.target.value)}
                    style={{ width: 70, height: 32, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                  <span />
                  <Text strong style={{ fontSize: 12, color: '#888' }}>Opacity</Text>
                  <InputNumber
                    size="small" min={0} max={1} step={0.1}
                    value={flatOpacity}
                    onChange={(v) => setFlatOpacity(v ?? 0.4)}
                    style={{ width: 80 }}
                  />
                  <span />
                </div>
              )}
            </div>
          )
        })()}
      </Modal>
    </div>
  )
}
