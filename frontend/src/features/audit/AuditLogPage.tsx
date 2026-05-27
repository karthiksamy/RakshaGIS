import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table, Tabs, Tag, Typography, Select, DatePicker, Space, Row, Col, Tooltip } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
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
    { key: 'sessions', label: 'My Sessions', children: <SessionsTab /> },
    { key: 'exports', label: 'Export Audit', children: <ExportAuditTab /> },
    ...(isSuperAdmin ? [{ key: 'logins', label: 'Login Audit', children: <LoginAuditTab /> }] : []),
  ]

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#050510' }}>
      <Title level={4} style={{ color: '#4fc3f7', marginBottom: 20 }}>Audit Logs</Title>
      <Tabs items={tabs} />
    </div>
  )
}
