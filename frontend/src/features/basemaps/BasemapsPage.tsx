import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Typography, Modal, Form, Input, Select, Switch,
  Space, Popconfirm, message,
} from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { BasemapConfig } from '@/types'

const PROVIDER_OPTIONS = ['OSM', 'XYZ', 'WMS', 'WMTS', 'BING', 'BHUVAN'].map((p) => ({ label: p, value: p }))

export default function BasemapsPage() {
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery<BasemapConfig[]>({
    queryKey: qk.basemaps(),
    queryFn: () => api.get('/gis/basemaps/').then((r) => r.data.results ?? r.data),
  })

  const createMutation = useMutation({
    mutationFn: (values: any) => api.post('/gis/basemaps/', values).then((r) => r.data),
    onSuccess: () => {
      message.success('Basemap added')
      qc.invalidateQueries({ queryKey: qk.basemaps() })
      setModalOpen(false)
      form.resetFields()
    },
    onError: () => message.error('Failed to create basemap'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/gis/basemaps/${id}/`),
    onSuccess: () => {
      message.success('Basemap deleted')
      qc.invalidateQueries({ queryKey: qk.basemaps() })
    },
    onError: (e: any) =>
      message.error(e.response?.data?.detail || 'Cannot delete system basemap'),
  })

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<BasemapConfig> }) =>
      api.patch(`/gis/basemaps/${id}/`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.basemaps() }),
    onError: () => message.error('Failed to update basemap'),
  })

  const setDefaultMutation = useMutation({
    mutationFn: (id: number) => api.post(`/gis/basemaps/${id}/set_default/`),
    onSuccess: () => {
      message.success('Default basemap updated')
      qc.invalidateQueries({ queryKey: qk.basemaps() })
    },
    onError: () => message.error('Failed to set default basemap'),
  })

  const isSuperAdmin = user?.role === 'SUPERADMIN'

  const columns: ColumnsType<BasemapConfig> = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Provider', dataIndex: 'provider', render: (p) => <Tag>{p}</Tag> },
    {
      title: 'URL / Template',
      dataIndex: 'url_template',
      ellipsis: true,
      responsive: ['md'],
    },
    {
      title: 'System',
      dataIndex: 'is_system',
      render: (v) => v ? <Tag color="blue">System</Tag> : null,
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      render: (v, record) => isSuperAdmin ? (
        <Switch
          size="small"
          checked={v}
          // The default basemap must stay active — block disabling it directly.
          disabled={record.is_default || patchMutation.isPending}
          onChange={(checked) => patchMutation.mutate({ id: record.id, data: { is_active: checked } })}
        />
      ) : (
        <Tag color={v ? 'green' : 'default'}>{v ? 'Active' : 'Off'}</Tag>
      ),
    },
    {
      title: 'Default',
      dataIndex: 'is_default',
      render: (v, record) => v ? (
        <Tag color="gold">★ Default</Tag>
      ) : isSuperAdmin ? (
        <Button size="small" onClick={() => setDefaultMutation.mutate(record.id)}>
          Set default
        </Button>
      ) : null,
    },
    ...(isSuperAdmin
      ? [{
          title: '',
          key: 'actions',
          width: 60,
          render: (_: any, record: BasemapConfig) => !record.is_system && (
            <Popconfirm title="Delete this basemap?" onConfirm={() => deleteMutation.mutate(record.id)}>
              <Button type="text" danger icon={<DeleteOutlined />} size="small" />
            </Popconfirm>
          ),
        }]
      : []),
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          Basemap Configuration
        </Typography.Title>
        {isSuperAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            Add Basemap
          </Button>
        )}
      </div>

      <Table
        dataSource={data}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={false}
      />

      <Modal
        title="Add Basemap"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
      >
        <Form form={form} layout="vertical" onFinish={createMutation.mutate}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
            <Select options={PROVIDER_OPTIONS} />
          </Form.Item>
          <Form.Item name="url_template" label="URL Template" rules={[{ required: true }]}>
            <Input placeholder="https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          </Form.Item>
          <Form.Item name="attribution" label="Attribution">
            <Input />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
          <Form.Item
            name="is_default"
            label="Set as default basemap"
            valuePropName="checked"
            initialValue={false}
            tooltip="The default loads automatically when the map opens. Only one basemap can be default."
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
