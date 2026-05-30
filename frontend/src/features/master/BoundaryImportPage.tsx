import { useState } from 'react'
import {
  Typography, Form, Select, Input, Switch, Upload, Button, Table,
  Tag, Space, Popconfirm, message, Alert, Divider, Card, Tooltip,
} from 'antd'
import {
  UploadOutlined, ReloadOutlined, DeleteOutlined, InfoCircleOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UploadFile } from 'antd/es/upload/interface'
import api from '@/services/api'

const { Title, Text } = Typography

interface ImportJob {
  id: number
  level: string
  name_field: string
  code_field: string
  parent_code_field: string
  spatial_parent: boolean
  clear_existing: boolean
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  result: { created: number; updated: number; skipped: number; errors: number } | null
  error_log: string
  uploaded_by_name: string
  created_at: string
  completed_at: string | null
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'default',
  RUNNING: 'processing',
  DONE: 'success',
  FAILED: 'error',
}

const GADM_DEFAULTS: Record<string, { name: string; code: string; parent: string }> = {
  state:    { name: 'NAME_1', code: 'GID_1',  parent: '' },
  district: { name: 'NAME_2', code: 'GID_2',  parent: 'GID_1' },
  taluk:    { name: 'NAME_3', code: 'GID_3',  parent: 'GID_2' },
  village:  { name: 'NAME_4', code: 'GID_4',  parent: 'GID_3' },
}

export default function BoundaryImportPage() {
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [level, setLevel] = useState('state')

  const { data: jobs = [], isLoading } = useQuery<ImportJob[]>({
    queryKey: ['boundary-imports'],
    queryFn: () => api.get('/gis/boundary-imports/?page_size=50').then(r => r.data.results ?? r.data),
    refetchInterval: (q) => {
      const running = (q.state.data as ImportJob[] | undefined)?.some(
        j => j.status === 'PENDING' || j.status === 'RUNNING'
      )
      return running ? 4000 : false
    },
  })

  const submit = useMutation({
    mutationFn: (fd: FormData) => api.post('/gis/boundary-imports/', fd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['boundary-imports'] })
      message.success('Import job queued — processing in background.')
      form.resetFields()
      setFileList([])
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Upload failed'),
  })

  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/gis/boundary-imports/${id}/retry/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['boundary-imports'] })
      message.success('Job re-queued.')
    },
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/gis/boundary-imports/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['boundary-imports'] })
      message.success('Job deleted.')
    },
  })

  function onLevelChange(val: string) {
    setLevel(val)
    const d = GADM_DEFAULTS[val]
    form.setFieldsValue({ name_field: d.name, code_field: d.code, parent_code_field: d.parent })
  }

  function onFinish(values: any) {
    if (!fileList.length || !fileList[0].originFileObj) {
      message.error('Please select a shapefile (.shp or .zip)')
      return
    }
    const fd = new FormData()
    fd.append('file', fileList[0].originFileObj)
    fd.append('level', values.level)
    fd.append('name_field', values.name_field || 'NAME')
    fd.append('code_field', values.code_field || 'CODE')
    fd.append('parent_code_field', values.parent_code_field || '')
    fd.append('spatial_parent', values.spatial_parent ? 'true' : 'false')
    fd.append('clear_existing', values.clear_existing ? 'true' : 'false')
    submit.mutate(fd)
  }

  const columns = [
    {
      title: 'Level',
      dataIndex: 'level',
      width: 90,
      render: (v: string) => <Tag>{v.toUpperCase()}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => <Tag color={STATUS_COLOR[s]}>{s}</Tag>,
    },
    {
      title: 'Fields',
      render: (_: any, r: ImportJob) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          name={r.name_field} / code={r.code_field}
          {r.parent_code_field ? ` / parent=${r.parent_code_field}` : ''}
        </Text>
      ),
    },
    {
      title: 'Result',
      render: (_: any, r: ImportJob) =>
        r.result ? (
          <Text style={{ fontSize: 12 }}>
            +{r.result.created} created, ~{r.result.updated} updated,
            {r.result.skipped} skipped, {r.result.errors} errors
          </Text>
        ) : r.status === 'FAILED' ? (
          <Tooltip title={r.error_log}>
            <Text type="danger" style={{ fontSize: 12 }}>Failed — hover for error</Text>
          </Tooltip>
        ) : null,
    },
    {
      title: 'Submitted',
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '',
      width: 80,
      render: (_: any, r: ImportJob) => (
        <Space>
          {r.status === 'FAILED' && (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => retry.mutate(r.id)} />
          )}
          <Popconfirm title="Delete this import job?" onConfirm={() => del.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const needsParent = ['district', 'taluk', 'village'].includes(level)

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <Title level={4} style={{ marginBottom: 4 }}>Admin Boundary Import</Title>
      <Text type="secondary">
        Load state, district, taluk, or village shapefiles into the master data tables.
        Accepts .shp or .zip archive. Reprojects to EPSG:4326 automatically.
      </Text>

      <Alert
        style={{ marginTop: 16, marginBottom: 24 }}
        type="info"
        showIcon
        message="GADM defaults pre-filled"
        description={
          <>
            Defaults are set for <strong>GADM 4.1 India</strong> shapefiles (gadm41_IND_1.zip … gadm41_IND_4.zip).
            Adjust field names for Census of India, Survey of India, or Bhuvan sources.
            Load levels in order: state → district → taluk → village.
          </>
        }
      />

      <Card size="small" style={{ marginBottom: 32 }}>
        <Form
          form={form}
          layout="vertical"
          onFinish={onFinish}
          initialValues={{
            level: 'state',
            name_field: GADM_DEFAULTS.state.name,
            code_field: GADM_DEFAULTS.state.code,
            parent_code_field: '',
            spatial_parent: false,
            clear_existing: false,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <Form.Item name="level" label="Level" rules={[{ required: true }]}>
              <Select onChange={onLevelChange}>
                <Select.Option value="state">State</Select.Option>
                <Select.Option value="district">District</Select.Option>
                <Select.Option value="taluk">Taluk / Sub-district</Select.Option>
                <Select.Option value="village">Village</Select.Option>
              </Select>
            </Form.Item>

            <Form.Item name="name_field" label="Name field" rules={[{ required: true }]}>
              <Input placeholder="e.g. NAME_1" />
            </Form.Item>

            <Form.Item name="code_field" label="Code field" rules={[{ required: true }]}>
              <Input placeholder="e.g. GID_1" />
            </Form.Item>
          </div>

          {needsParent && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <Form.Item
                name="parent_code_field"
                label={
                  <span>
                    Parent code field&nbsp;
                    <Tooltip title="The shapefile attribute whose value matches the parent table's code column. Leave empty to use spatial containment instead.">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </span>
                }
              >
                <Input placeholder="e.g. GID_1" />
              </Form.Item>

              <Form.Item
                name="spatial_parent"
                label="Resolve parent spatially"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'flex-end' }}>
            <Form.Item label="Shapefile (.shp or .zip)" required>
              <Upload
                fileList={fileList}
                beforeUpload={(file) => {
                  setFileList([file as any])
                  return false
                }}
                onRemove={() => setFileList([])}
                accept=".shp,.zip"
                maxCount={1}
              >
                <Button icon={<UploadOutlined />}>Select file</Button>
              </Upload>
            </Form.Item>

            <Form.Item
              name="clear_existing"
              label={
                <span>
                  Clear existing records&nbsp;
                  <Tooltip title="Delete all existing records for this level before importing. Useful for full replacement.">
                    <InfoCircleOutlined />
                  </Tooltip>
                </span>
              }
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </div>

          <Button
            type="primary"
            htmlType="submit"
            loading={submit.isPending}
            disabled={!fileList.length}
          >
            Start Import
          </Button>
        </Form>
      </Card>

      <Divider>Import History</Divider>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={jobs}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 20 }}
      />
    </div>
  )
}
