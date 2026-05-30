import { useState } from 'react'
import {
  Button, Card, Table, Tag, Space, Modal, Form, Input, InputNumber,
  Switch, message, Popconfirm, Tooltip, Alert, Spin, Tabs, Select,
  Typography, Badge, Divider,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined,
  SyncOutlined, TableOutlined, CloudServerOutlined,
  CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined,
  FilterOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  style: Record<string, unknown>
  is_active: boolean
  display_order: number
  feature_count: number | null
  bbox: number[] | null
  last_synced_at: string | null
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

  // Office-filter configuration modal
  const [filterLayer,    setFilterLayer]    = useState<ExtLayer | null>(null)
  const [filterCols,     setFilterCols]     = useState<TableColumn[]>([])
  const [filterColsLoad, setFilterColsLoad] = useState(false)
  const [filterField,    setFilterField]    = useState<string>('')
  const [savingFilter,   setSavingFilter]   = useState(false)

  async function openFilterConfig(layer: ExtLayer) {
    setFilterLayer(layer)
    setFilterField(layer.office_filter_field || '')
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

  async function saveFilterConfig() {
    if (!filterLayer) return
    setSavingFilter(true)
    try {
      await api.patch(`/external/layers/${filterLayer.id}/`, { office_filter_field: filterField })
      message.success(filterField
        ? `Office filter set to "${filterField}"`
        : 'Office filter cleared — all users see all rows')
      qc.invalidateQueries({ queryKey: ['ext-layers'] })
      setFilterLayer(null)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Save failed')
    } finally {
      setSavingFilter(false)
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
        message.success('Database updated')
      } else {
        await api.post('/external/databases/', values)
        message.success('Database added')
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
      message.success('Layer registered')
      qc.invalidateQueries({ queryKey: ['ext-layers'] })
      setLayerModalOpen(false)
      layerForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Failed')
    }
  }

  const deleteLayerMut = useMutation({
    mutationFn: (id: number) => api.delete(`/external/layers/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ext-layers'] }); message.success('Removed') },
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
              onClick={() => testConnection(row)}>Test</Button>
          </Tooltip>
          <Tooltip title="Import mst_office → Organisations">
            <Button size="small" icon={<SyncOutlined />} loading={syncingId === row.id}
              onClick={() => syncOrgs(row)}>Sync Orgs</Button>
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
      title: 'Office Filter', width: 150,
      render: (_, row) => row.office_filter_field
        ? <Tag color="purple" style={{ fontSize: 11 }}>{row.office_filter_field}</Tag>
        : <Tag color="default" style={{ fontSize: 11 }}>All users see all</Tag>,
    },
    {
      title: 'Actions', width: 130,
      render: (_, row) => (
        <Space>
          <Tooltip title="Configure office data filter">
            <Button size="small" icon={<FilterOutlined />}
              onClick={() => openFilterConfig(row)} />
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
              onClick={() => addLayerFromTable(row)}>Add to Map</Button>
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

      {/* ── Office Data Filter Modal ──────────────────────────────────────── */}
      <Modal
        title={<Space><FilterOutlined />Configure Office Data Filter</Space>}
        open={!!filterLayer}
        onCancel={() => setFilterLayer(null)}
        onOk={saveFilterConfig}
        confirmLoading={savingFilter}
        okText="Save Filter"
        width={540}
      >
        {filterLayer && (
          <div style={{ marginTop: 8 }}>
            <Alert
              type="info" showIcon style={{ marginBottom: 16 }}
              message={`Layer: ${filterLayer.display_name}`}
              description={
                <span style={{ fontSize: 12 }}>
                  Choose the column holding the <b>office code</b> (e.g. officeid).
                  Each non-DGDE user then sees only rows matching their own office and
                  the offices beneath it. <b>DGDE-level users and super admins always see
                  all rows.</b> Leave blank to disable filtering.
                </span>
              }
            />
            <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>Office filter field</div>
            <Select
              showSearch allowClear
              loading={filterColsLoad}
              value={filterField || undefined}
              placeholder="Select a column (blank = no filter)"
              style={{ width: '100%' }}
              onChange={(v) => setFilterField(v || '')}
              optionFilterProp="label"
              options={filterCols.map(c => ({
                value: c.column_name,
                label: `${c.column_name}  (${c.data_type})`,
              }))}
            />
            <div style={{ marginTop: 16, padding: 12, background: '#f6f6ff', borderRadius: 4, fontSize: 12, color: '#555' }}>
              <b>Filtering by login level:</b>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                <li><b>DGDE</b> — all rows (no filter)</li>
                <li><b>PDDE / DEO / CEO / ADEO</b> — only rows whose
                  {' '}<Text code style={{ fontSize: 11 }}>{filterField || '(field)'}</Text>{' '}
                  matches their office or a subordinate office</li>
              </ul>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
