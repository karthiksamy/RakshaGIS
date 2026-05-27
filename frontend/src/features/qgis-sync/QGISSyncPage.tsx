import { useState } from 'react'
import {
  Card, Table, Tag, Typography, Space, Select, Button,
  Statistic, Row, Col, Tooltip, Input, Alert, Popconfirm, message,
} from 'antd'
import {
  SyncOutlined, CheckSquareOutlined, ExclamationCircleOutlined,
  MinusCircleOutlined, CodeOutlined, FolderOutlined,
  SearchOutlined, DownloadOutlined, RedoOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import type { QGISUploadLog, SurveyProject } from '@/types'

const { Title, Text } = Typography

function formatBytes(b: number) {
  if (!b) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 ** 2).toFixed(1)} MB`
}

function formatDate(s: string) {
  return new Date(s).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const STATUS_TAG: Record<string, React.ReactNode> = {
  SUCCESS: <Tag color="success"  icon={<CheckSquareOutlined />}  style={{ fontSize: 11 }}>SUCCESS</Tag>,
  FAILED:  <Tag color="error"   icon={<ExclamationCircleOutlined />} style={{ fontSize: 11 }}>FAILED</Tag>,
  SKIPPED: <Tag color="default" icon={<MinusCircleOutlined />}   style={{ fontSize: 11 }}>SKIPPED</Tag>,
}

export default function QGISSyncPage() {
  const user = useAppStore((s) => s.user)
  const qc = useQueryClient()
  const [projectFilter, setProjectFilter] = useState<number | null>(null)
  const [statusFilter, setStatusFilter]   = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const retryMutation = useMutation({
    mutationFn: (id: number) => api.post(`/projects/qgis-uploads/${id}/retry/`),
    onSuccess: () => {
      message.success('Retry requested — the uploader has been notified to re-run from QGIS.')
      qc.invalidateQueries({ queryKey: ['qgis-uploads-global'] })
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || 'Retry request failed')
    },
  })

  const { data: projects = [] } = useQuery<SurveyProject[]>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/?page_size=200').then(r => r.data.results ?? r.data),
  })

  const { data: logsData, isLoading, refetch } = useQuery<{ results: QGISUploadLog[]; count: number }>({
    queryKey: ['qgis-uploads-global', projectFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page_size: '500' })
      if (projectFilter) params.set('project', String(projectFilter))
      if (statusFilter)  params.set('status', statusFilter)
      return api.get(`/projects/qgis-uploads/?${params}`).then(r => r.data)
    },
  })

  const allLogs = logsData?.results ?? []

  // Client-side filename search
  const logs = search.trim()
    ? allLogs.filter(l =>
        l.filename.toLowerCase().includes(search.toLowerCase()) ||
        l.module_name.toLowerCase().includes(search.toLowerCase()) ||
        l.algorithm_id.toLowerCase().includes(search.toLowerCase())
      )
    : allLogs

  const totalFiles  = allLogs.length
  const successCount = allLogs.filter(l => l.status === 'SUCCESS').length
  const failCount    = allLogs.filter(l => l.status === 'FAILED').length
  const totalSize    = allLogs.reduce((s, l) => s + (l.file_size || 0), 0)

  // Export CSV
  function handleExportCsv() {
    const headers = ['Time', 'Project', 'Module', 'File', 'Folder', 'Size(bytes)', 'Algorithm', 'Status', 'Error', 'Uploaded By']
    const rows = logs.map(l => [
      l.uploaded_at, l.project_number, l.module_name, l.filename,
      l.folder_name, l.file_size, l.algorithm_id, l.status, l.error_message, l.uploaded_by_name,
    ])
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `qgis_uploads_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  const columns: ColumnsType<QGISUploadLog> = [
    {
      title: 'Time',
      dataIndex: 'uploaded_at',
      width: 140,
      render: formatDate,
      sorter: (a, b) => new Date(a.uploaded_at).getTime() - new Date(b.uploaded_at).getTime(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Project',
      dataIndex: 'project_number',
      width: 100,
      render: (v: string, row: QGISUploadLog) => (
        <a href={`/projects/${row.project}`} style={{ fontSize: 12 }}>{v}</a>
      ),
    },
    {
      title: 'File',
      dataIndex: 'filename',
      ellipsis: true,
      render: (v: string, row: QGISUploadLog) => (
        <div>
          <div style={{ fontSize: 12, color: '#ddd' }}>{v}</div>
          {row.original_path && (
            <Tooltip title={row.original_path}>
              <div style={{ fontSize: 10, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.original_path}
              </div>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: 'Module',
      dataIndex: 'module_name',
      width: 150,
      ellipsis: true,
      render: (v: string) => v
        ? <span style={{ fontSize: 11, color: '#4fc3f7' }}><FolderOutlined style={{ marginRight: 4 }} />{v}</span>
        : <span style={{ color: '#444' }}>—</span>,
    },
    {
      title: 'Folder',
      dataIndex: 'folder_name',
      width: 100,
      render: (v: string) => v ? <Tag style={{ fontSize: 10 }}>{v}</Tag> : <span style={{ color: '#444' }}>—</span>,
    },
    {
      title: 'Size',
      dataIndex: 'file_size',
      width: 80,
      render: formatBytes,
      sorter: (a, b) => (a.file_size || 0) - (b.file_size || 0),
    },
    {
      title: 'Algorithm',
      dataIndex: 'algorithm_id',
      width: 140,
      ellipsis: true,
      render: (v: string) => v
        ? (
          <Tooltip title={v}>
            <Tag style={{ fontSize: 10, fontFamily: 'monospace' }}>{v.split(':').pop()}</Tag>
          </Tooltip>
        )
        : <span style={{ color: '#444', fontSize: 11 }}>manual</span>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => STATUS_TAG[v] ?? <Tag>{v}</Tag>,
      filters: [
        { text: 'Success', value: 'SUCCESS' },
        { text: 'Failed',  value: 'FAILED'  },
        { text: 'Skipped', value: 'SKIPPED' },
      ],
      onFilter: (value, record) => record.status === value,
    },
    {
      title: 'Error',
      dataIndex: 'error_message',
      ellipsis: true,
      render: (v: string) => v
        ? <Tooltip title={v}><span style={{ color: '#ff4d4f', fontSize: 11 }}>{v}</span></Tooltip>
        : null,
    },
    {
      title: 'By',
      dataIndex: 'uploaded_by_name',
      width: 100,
      ellipsis: true,
      render: (v: string) => <span style={{ color: '#888', fontSize: 11 }}>{v || '—'}</span>,
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: any, row: QGISUploadLog) =>
        row.status === 'FAILED' ? (
          <Popconfirm
            title="Request a retry?"
            description="The uploader will be notified to re-upload this file from QGIS."
            onConfirm={() => retryMutation.mutate(row.id)}
            okText="Yes"
            cancelText="No"
          >
            <Tooltip title="Request retry">
              <Button
                size="small"
                type="text"
                icon={<RedoOutlined />}
                style={{ color: '#fa8c16' }}
                loading={retryMutation.isPending}
              />
            </Tooltip>
          </Popconfirm>
        ) : null,
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 20 }} align="center">
        <Title level={4} style={{ margin: 0 }}>
          <SyncOutlined style={{ marginRight: 8, color: '#4fc3f7' }} />
          QGIS Sync — Upload Log
        </Title>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Server-side record of all files uploaded by the RakshaGIS Sync QGIS plugin
        </Text>
      </Space>

      {/* Stats row */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        {[
          { title: 'Total Uploads',  value: totalFiles,   prefix: <SyncOutlined /> },
          { title: 'Successful',     value: successCount,  prefix: <CheckSquareOutlined style={{ color: '#52c41a' }} /> },
          { title: 'Failed',         value: failCount,     prefix: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} /> },
          { title: 'Total Data',     value: formatBytes(totalSize) as any, prefix: <DownloadOutlined /> },
        ].map((s) => (
          <Col key={s.title} xs={12} sm={6}>
            <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050' }}>
              <Statistic title={s.title} value={s.value} prefix={s.prefix}
                valueStyle={{ color: '#e8eeff', fontSize: 18 }} />
            </Card>
          </Col>
        ))}
      </Row>

      {/* Filters */}
      <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050', marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="All Projects"
            allowClear
            style={{ width: 260 }}
            onChange={(v) => setProjectFilter(v ?? null)}
            options={projects.map(p => ({
              value: p.id,
              label: `${(p as any).project_number ?? p.id} — ${p.name}`,
            }))}
          />
          <Select
            placeholder="All Statuses"
            allowClear
            style={{ width: 140 }}
            onChange={(v) => setStatusFilter(v ?? null)}
            options={[
              { value: 'SUCCESS', label: 'Success' },
              { value: 'FAILED',  label: 'Failed'  },
              { value: 'SKIPPED', label: 'Skipped' },
            ]}
          />
          <Input
            prefix={<SearchOutlined style={{ color: '#555' }} />}
            placeholder="Search filename / module…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
          <Button icon={<SyncOutlined />} onClick={() => refetch()}>Refresh</Button>
          <Button icon={<DownloadOutlined />} onClick={handleExportCsv}>Export CSV</Button>
        </Space>
      </Card>

      {/* Setup guide for admins */}
      {totalFiles === 0 && !isLoading && (
        <Alert
          type="info"
          showIcon
          icon={<CodeOutlined />}
          style={{ marginBottom: 16 }}
          message="No QGIS uploads recorded yet"
          description={
            <Space direction="vertical" size={4}>
              <Text style={{ fontSize: 13 }}>
                Install the <strong>RakshaGIS Sync</strong> QGIS plugin on your GIS workstations.
                The plugin ZIP is at: <code>qgis_plugin/rakshagis_sync/</code>
              </Text>
              <Text style={{ fontSize: 12, color: '#888' }}>
                Once installed, configure the server URL and credentials in QGIS → RakshaGIS Sync → ⚙ Settings.
                Upload history from all connected QGIS instances will appear here.
              </Text>
            </Space>
          }
        />
      )}

      {/* Log table */}
      <Table<QGISUploadLog>
        dataSource={logs}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        scroll={{ x: 1200 }}
        pagination={{
          pageSize: 50,
          showSizeChanger: true,
          showTotal: (total) => `${total} records`,
        }}
        rowClassName={(row) =>
          row.status === 'FAILED' ? 'qgis-row-failed' : ''
        }
      />

      <style>{`
        .qgis-row-failed td { background: rgba(255, 77, 79, 0.05) !important; }
      `}</style>
    </div>
  )
}
