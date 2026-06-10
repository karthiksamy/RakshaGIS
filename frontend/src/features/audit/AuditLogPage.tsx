import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table, Tabs, Tag, Typography, Select, DatePicker, Space, Row, Col, Tooltip, Input } from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined,
  EditOutlined, DeleteOutlined, PlusCircleOutlined, ExportOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

interface LoginLog {
  id: number
  username_attempted: string
  success: boolean
  ip_address: string
  user_agent: string
  failure_reason: string
  timestamp: string
}

interface ExportLog {
  id: number
  user: number
  user_name: string
  export_type: string
  project_number: string
  row_count: number
  file_size_bytes: number
  timestamp: string
}

interface SessionItem {
  id: number
  jti: string
  ip_address: string
  device_name: string
  user_agent: string
  created_at: string
  last_used: string
  is_revoked: boolean
}

const EXPORT_TYPE_COLOR: Record<string, string> = {
  csv: 'blue', csv_import: 'cyan', geojson: 'green',
  shapefile: 'orange', xlsx: 'purple', pdf: 'magenta',
}

function LoginAuditTab() {
  const { t } = useTranslation()
  const [successFilter, setSuccessFilter] = useState<string>('')
  const { data, isLoading } = useQuery<{ results: LoginLog[] }>({
    queryKey: ['login-audit', successFilter],
    queryFn: () => api.get(`/accounts/login-audit/${successFilter ? `?success=${successFilter}` : ''}`).then(r => r.data),
  })

  return (
    <div>
      <Row gutter={8} style={{ marginBottom: 12 }}>
        <Col>
          <Select
            value={successFilter}
            onChange={setSuccessFilter}
            style={{ width: 140 }}
            placeholder="All results"
            allowClear
            options={[
              { value: 'true', label: 'Success only' },
              { value: 'false', label: 'Failures only' },
            ]}
          />
        </Col>
      </Row>
      <Table
        dataSource={data?.results ?? []}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
        columns={[
          {
            title: 'Result', dataIndex: 'success', width: 80,
            render: v => v
              ? <Tag icon={<CheckCircleOutlined />} color="success">OK</Tag>
              : <Tag icon={<CloseCircleOutlined />} color="error">FAIL</Tag>,
          },
          { title: 'Username', dataIndex: 'username_attempted', width: 140 },
          { title: 'IP Address', dataIndex: 'ip_address', width: 130 },
          { title: 'Failure Reason', dataIndex: 'failure_reason', render: v => <Text type="secondary" style={{ fontSize: 11 }}>{v || '—'}</Text> },
          {
            title: 'User Agent', dataIndex: 'user_agent', ellipsis: true,
            render: v => <Tooltip title={v}><Text style={{ fontSize: 11, color: '#666' }}>{v?.slice(0, 50)}</Text></Tooltip>,
          },
          {
            title: 'Time', dataIndex: 'timestamp', width: 150,
            render: v => <Text style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('DD MMM YY HH:mm:ss')}</Text>,
          },
        ]}
      />
    </div>
  )
}

function ExportAuditTab() {
  const { data, isLoading } = useQuery<{ results: ExportLog[] }>({
    queryKey: ['export-audit'],
    queryFn: () => api.get('/accounts/export-audit/').then(r => r.data),
  })

  return (
    <Table
      dataSource={data?.results ?? []}
      rowKey="id"
      loading={isLoading}
      size="small"
      pagination={{ pageSize: 25 }}
      columns={[
        { title: 'User', dataIndex: 'user_name', width: 160 },
        {
          title: 'Type', dataIndex: 'export_type', width: 110,
          render: v => <Tag color={EXPORT_TYPE_COLOR[v] || 'default'}>{v}</Tag>,
        },
        { title: 'Project', dataIndex: 'project_number', width: 120, render: v => <Text style={{ color: '#4fc3f7', fontSize: 12 }}>{v || '—'}</Text> },
        { title: 'Rows', dataIndex: 'row_count', width: 80, align: 'right' },
        {
          title: 'Size', dataIndex: 'file_size_bytes', width: 90, align: 'right',
          render: v => v ? `${(v / 1024).toFixed(1)} KB` : '—',
        },
        {
          title: 'Time', dataIndex: 'timestamp', width: 150,
          render: v => <Text style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('DD MMM YY HH:mm')}</Text>,
        },
      ]}
    />
  )
}

const ACTION_COLOR: Record<string, string> = {
  CREATE: 'green', UPDATE: 'blue', DELETE: 'red',
}
const ACTION_ICON: Record<string, React.ReactNode> = {
  CREATE: <PlusCircleOutlined />,
  UPDATE: <EditOutlined />,
  DELETE: <DeleteOutlined />,
}
const MAP_ACTION_COLOR: Record<string, string> = {
  CREATE_FEATURE: 'green', EDIT_FEATURE: 'blue', DELETE_FEATURE: 'red',
  SUBMIT_AREA: 'purple', APPROVE_AREA: 'cyan', PUBLISH_AREA: 'gold',
  IMPORT_GIS: 'orange', EXPORT_MAP: 'lime',
  VIEW_MAP: 'default', TOOL_CHANGE: 'default', SELECT_AREA: 'geekblue',
  LOCK_FEATURE: 'volcano', RETURN_AREA: 'magenta',
}

function WorkflowAuditTab() {
  const user = useAppStore(s => s.user)
  const isSuperAdmin = user?.role === 'SUPERADMIN'
  const [actionFilter, setActionFilter] = useState('')
  const [search, setSearch] = useState('')
  const { data, isLoading } = useQuery<{ results: any[] }>({
    queryKey: ['workflow-audit', actionFilter],
    queryFn: () => api.get(`/workflow/audit/${actionFilter ? `?action=${actionFilter}` : ''}`).then(r => r.data),
  })

  const rows = (data?.results ?? []).filter(r =>
    !search || r.model_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.object_repr?.toLowerCase().includes(search.toLowerCase()) ||
    r.user_name?.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div>
      <Row gutter={8} style={{ marginBottom: 10 }}>
        <Col>
          <Select
            value={actionFilter} onChange={setActionFilter}
            style={{ width: 140 }} placeholder="All actions" allowClear
            options={[
              { value: 'CREATE', label: 'Create' },
              { value: 'UPDATE', label: 'Update' },
              { value: 'DELETE', label: 'Delete' },
            ]}
          />
        </Col>
        <Col flex="auto">
          <Input.Search
            placeholder="Filter by model, object or user…"
            value={search} onChange={e => setSearch(e.target.value)}
            size="small" allowClear style={{ maxWidth: 280 }}
          />
        </Col>
        {isSuperAdmin && (
          <Col>
            <Text style={{ color: '#666', fontSize: 11 }}>All organisations visible (superadmin)</Text>
          </Col>
        )}
      </Row>
      <Table
        dataSource={rows}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
        columns={[
          {
            title: 'Action', dataIndex: 'action', width: 90,
            render: (v) => (
              <Tag icon={ACTION_ICON[v]} color={ACTION_COLOR[v] || 'default'} style={{ fontSize: 10 }}>
                {v}
              </Tag>
            ),
          },
          { title: 'Model', dataIndex: 'model_name', width: 130,
            render: v => <Text style={{ color: '#4fc3f7', fontSize: 11 }}>{v}</Text> },
          { title: 'Object', dataIndex: 'object_repr', ellipsis: true,
            render: v => <Text style={{ fontSize: 11 }}>{v || '—'}</Text> },
          { title: 'User', dataIndex: 'user_name', width: 140,
            render: v => <Text style={{ color: '#aaa', fontSize: 11 }}>{v || '—'}</Text> },
          { title: 'IP', dataIndex: 'ip_address', width: 120,
            render: v => <Text style={{ color: '#666', fontSize: 10 }}>{v || '—'}</Text> },
          {
            title: 'Time', dataIndex: 'timestamp', width: 150,
            render: v => <Text style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('DD MMM YY HH:mm:ss')}</Text>,
          },
        ]}
        expandable={{
          expandedRowRender: (r: any) => (
            <pre style={{ fontSize: 10, color: '#888', margin: 0, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(r.changes, null, 2)}
            </pre>
          ),
          rowExpandable: (r: any) => r.changes && Object.keys(r.changes).length > 0,
        }}
      />
    </div>
  )
}

function MapActivityTab() {
  const [actionFilter, setActionFilter] = useState('')
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const params: Record<string, string> = {}
  if (actionFilter) params.action = actionFilter
  if (dateRange?.[0]) params.timestamp_after  = dateRange[0].toISOString()
  if (dateRange?.[1]) params.timestamp_before = dateRange[1].toISOString()

  const { data, isLoading } = useQuery<{ results: any[] }>({
    queryKey: ['map-activity', actionFilter, dateRange],
    queryFn: () => api.get('/workflow/map-activity/', { params }).then(r => r.data),
  })

  const actionOptions = [
    'VIEW_MAP','SELECT_AREA','TOOL_CHANGE',
    'CREATE_FEATURE','EDIT_FEATURE','DELETE_FEATURE','LOCK_FEATURE',
    'IMPORT_GIS','EXPORT_MAP',
    'SUBMIT_AREA','RETURN_AREA','APPROVE_AREA','PUBLISH_AREA',
  ].map(v => ({ value: v, label: v.replace(/_/g, ' ') }))

  return (
    <div>
      <Row gutter={8} style={{ marginBottom: 10 }}>
        <Col>
          <Select
            value={actionFilter} onChange={setActionFilter}
            style={{ width: 180 }} placeholder="All actions" allowClear
            options={actionOptions}
          />
        </Col>
        <Col>
          <RangePicker
            size="small"
            onChange={(vals) => setDateRange(vals as [any, any] | null)}
            style={{ width: 240 }}
          />
        </Col>
        <Col>
          <Tooltip title="Export CSV">
            <a
              href="/api/workflow/map-activity/export/"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#4fc3f7', fontSize: 12 }}
            >
              <ExportOutlined /> Export CSV
            </a>
          </Tooltip>
        </Col>
      </Row>
      <Table
        dataSource={data?.results ?? []}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
        columns={[
          {
            title: 'Action', dataIndex: 'action', width: 140,
            render: (v, r: any) => (
              <Tag color={MAP_ACTION_COLOR[v] || 'default'} style={{ fontSize: 10 }}>
                {r.action_display || v}
              </Tag>
            ),
          },
          { title: 'User', dataIndex: 'user_name', width: 130,
            render: v => <Text style={{ color: '#aaa', fontSize: 11 }}>{v || '—'}</Text> },
          { title: 'Project', dataIndex: 'project_name', width: 140, ellipsis: true,
            render: v => <Text style={{ color: '#4fc3f7', fontSize: 11 }}>{v || '—'}</Text> },
          { title: 'Area', dataIndex: 'survey_area_name', width: 130, ellipsis: true,
            render: v => <Text style={{ fontSize: 11 }}>{v || '—'}</Text> },
          { title: 'Layer', dataIndex: 'layer_name', width: 110, ellipsis: true,
            render: v => <Text style={{ color: '#888', fontSize: 10 }}>{v || '—'}</Text> },
          { title: 'IP', dataIndex: 'ip_address', width: 115,
            render: v => <Text style={{ color: '#555', fontSize: 10 }}>{v || '—'}</Text> },
          {
            title: 'Time', dataIndex: 'timestamp', width: 150,
            render: v => <Text style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('DD MMM YY HH:mm:ss')}</Text>,
          },
        ]}
      />
    </div>
  )
}

function SessionsTab() {
  const { data, isLoading } = useQuery<{ results: SessionItem[] }>({
    queryKey: ['my-sessions'],
    queryFn: () => api.get('/accounts/sessions/').then(r => r.data),
  })

  return (
    <Table
      dataSource={data?.results ?? []}
      rowKey="id"
      loading={isLoading}
      size="small"
      pagination={false}
      columns={[
        { title: 'Device', dataIndex: 'device_name', width: 100 },
        { title: 'IP Address', dataIndex: 'ip_address', width: 130 },
        {
          title: 'User Agent', dataIndex: 'user_agent', ellipsis: true,
          render: v => <Tooltip title={v}><Text style={{ fontSize: 11, color: '#666' }}>{v?.slice(0, 60)}</Text></Tooltip>,
        },
        {
          title: 'Created', dataIndex: 'created_at', width: 130,
          render: v => <Text style={{ fontSize: 11 }}>{dayjs(v).format('DD MMM HH:mm')}</Text>,
        },
        {
          title: 'Last Used', dataIndex: 'last_used', width: 130,
          render: v => <Text style={{ fontSize: 11 }}>{dayjs(v).fromNow()}</Text>,
        },
        {
          title: 'Status', dataIndex: 'is_revoked', width: 90,
          render: v => v ? <Tag color="red">Revoked</Tag> : <Tag color="green">Active</Tag>,
        },
      ]}
    />
  )
}

export default function AuditLogPage() {
  const user = useAppStore(s => s.user)
  const isSuperAdmin = user?.role === 'SUPERADMIN'

  const tabs = [
    { key: 'sessions',  label: 'My Sessions',      children: <SessionsTab /> },
    { key: 'exports',   label: 'Export Audit',      children: <ExportAuditTab /> },
    { key: 'workflow',  label: 'Workflow CRUD',      children: <WorkflowAuditTab /> },
    { key: 'map',       label: 'Map Activity',       children: <MapActivityTab /> },
    ...(isSuperAdmin ? [{ key: 'logins', label: 'Login Audit', children: <LoginAuditTab /> }] : []),
  ]

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#050510' }}>
      <Title level={4} style={{ color: '#4fc3f7', marginBottom: 20 }}>Audit Logs</Title>
      <Tabs items={tabs} />
    </div>
  )
}
