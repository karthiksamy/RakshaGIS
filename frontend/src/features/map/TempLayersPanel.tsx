import React, { useRef, useState } from 'react'
import {
  Button, Drawer, Table, Tag, Tooltip, Popconfirm, Space,
  Form, Input, Upload, Select, message, Badge, Typography,
  Modal,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  UploadOutlined, DeleteOutlined, EyeOutlined, EyeInvisibleOutlined,
  PlusOutlined, FileOutlined, InboxOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { TemporaryLayer } from '@/types'

// ─── Unique color palette for temp layers ─────────────────────────────────────
// Vivid, distinct from the default blue project features
const TEMP_COLORS = [
  '#ff6b35', // orange-red
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#f59e0b', // amber
  '#ec4899', // pink
  '#10b981', // emerald
  '#f97316', // orange
  '#6366f1', // indigo
  '#14b8a6', // teal
  '#ef4444', // red
]

export function getTempLayerColor(id: number): string {
  return TEMP_COLORS[id % TEMP_COLORS.length]
}

interface Props {
  open: boolean
  onClose: () => void
  visibleIds: Set<number>
  onToggleVisible: (id: number, geojson: Record<string, unknown>) => void
  onHide: (id: number) => void
}

const FORMAT_LABELS: Record<string, string> = {
  kml: 'KML',
  kmz: 'KMZ',
  geojson: 'GeoJSON',
  shapefile: 'Shapefile',
}

const FORMAT_COLORS: Record<string, string> = {
  kml: 'green',
  kmz: 'lime',
  geojson: 'blue',
  shapefile: 'orange',
}

const ACCEPT = '.kml,.kmz,.geojson,.json,.zip'

export default function TempLayersPanel({ open, onClose, visibleIds, onToggleVisible, onHide }: Props) {
  const qc = useQueryClient()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [form] = Form.useForm()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<File | null>(null)

  const { data: layers = [], isLoading } = useQuery<TemporaryLayer[]>({
    queryKey: ['temp-layers'],
    queryFn: () => api.get('/projects/temp-layers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/temp-layers/${id}/`),
    onSuccess: (_, id) => {
      onHide(id)
      qc.invalidateQueries({ queryKey: ['temp-layers'] })
      message.success('Temp layer deleted')
    },
    onError: () => message.error('Failed to delete'),
  })

  async function handleUpload(values: { name: string; purpose?: string; description?: string }) {
    if (!fileRef.current) { message.warning('Please select a file'); return }
    const fd = new FormData()
    fd.append('name', values.name)
    fd.append('purpose', values.purpose ?? '')
    fd.append('description', values.description ?? '')
    fd.append('file', fileRef.current)
    setUploading(true)
    try {
      const res = await api.post('/projects/temp-layers/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const layer: TemporaryLayer = res.data
      qc.invalidateQueries({ queryKey: ['temp-layers'] })
      message.success(`Uploaded "${layer.name}" — ${layer.feature_count} feature(s)`)
      setUploadOpen(false)
      form.resetFields()
      fileRef.current = null
      // Auto-show on map immediately after upload
      if (layer.geojson) {
        onToggleVisible(layer.id, layer.geojson as Record<string, unknown>)
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail || 'Upload failed'
      message.error(detail)
    } finally {
      setUploading(false)
    }
  }

  const columns: ColumnsType<TemporaryLayer> = [
    {
      title: 'Layer Name',
      dataIndex: 'name',
      render: (name, row) => (
        <Space>
          <span
            style={{
              display: 'inline-block',
              width: 12, height: 12, borderRadius: 2,
              background: getTempLayerColor(row.id),
              flexShrink: 0,
            }}
          />
          <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{name}</span>
        </Space>
      ),
    },
    {
      title: 'Format',
      dataIndex: 'file_format',
      width: 90,
      render: (fmt) => (
        <Tag color={FORMAT_COLORS[fmt] ?? 'default'} style={{ fontSize: 11 }}>
          {FORMAT_LABELS[fmt] ?? fmt}
        </Tag>
      ),
    },
    {
      title: 'Features',
      dataIndex: 'feature_count',
      width: 75,
      align: 'right',
      render: (n) => <span style={{ color: '#aaa' }}>{n}</span>,
    },
    {
      title: 'Purpose',
      dataIndex: 'purpose',
      ellipsis: true,
      render: (v) => <span style={{ color: '#888', fontSize: 12 }}>{v || '—'}</span>,
    },
    {
      title: 'Actions',
      width: 90,
      render: (_, row) => {
        const visible = visibleIds.has(row.id)
        return (
          <Space size={4}>
            <Tooltip title={visible ? 'Hide from map' : 'Show on map'}>
              <Button
                size="small"
                type="text"
                icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                style={{ color: visible ? getTempLayerColor(row.id) : '#888' }}
                onClick={() => {
                  if (visible) {
                    onHide(row.id)
                  } else if (row.geojson) {
                    onToggleVisible(row.id, row.geojson as Record<string, unknown>)
                  } else {
                    // Fetch geojson from API (not included in list response by default)
                    api.get(`/projects/temp-layers/${row.id}/`).then(r => {
                      if (r.data.geojson) onToggleVisible(row.id, r.data.geojson)
                      else message.warning('No geometry data found')
                    })
                  }
                }}
              />
            </Tooltip>
            <Popconfirm
              title="Delete this temp layer?"
              onConfirm={() => deleteMut.mutate(row.id)}
              okText="Delete"
              okButtonProps={{ danger: true }}
            >
              <Tooltip title="Delete">
                <Button
                  size="small" type="text" danger
                  icon={<DeleteOutlined />}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <>
      <Drawer
        title={
          <Space>
            <FileOutlined />
            <span>Temporary Layers</span>
            <Badge count={layers.length} style={{ backgroundColor: '#1890ff' }} />
          </Space>
        }
        placement="right"
        width={600}
        open={open}
        onClose={onClose}
        styles={{ body: { padding: 12, background: '#1a1a1a' }, header: { background: '#1a1a1a', borderBottom: '1px solid #333', color: '#e0e0e0' } }}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            size="small"
            onClick={() => setUploadOpen(true)}
          >
            Upload
          </Button>
        }
      >
        <Typography.Text style={{ color: '#888', fontSize: 12, display: 'block', marginBottom: 8 }}>
          Upload KML, KMZ, GeoJSON, or Shapefile ZIP for temporary map viewing. These layers are stored separately from project data.
        </Typography.Text>
        <Table
          dataSource={layers}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="small"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          style={{ background: 'transparent' }}
          className="dark-table"
          rowClassName={(row) => visibleIds.has(row.id) ? 'temp-layer-visible-row' : ''}
        />
      </Drawer>

      <Modal
        title={<span style={{ color: '#e0e0e0' }}>Upload Temporary Layer</span>}
        open={uploadOpen}
        onCancel={() => { setUploadOpen(false); form.resetFields(); fileRef.current = null }}
        onOk={() => form.submit()}
        okText={uploading ? 'Uploading…' : 'Upload'}
        confirmLoading={uploading}
        styles={{ content: { background: '#1e1e1e' }, header: { background: '#1e1e1e' }, footer: { background: '#1e1e1e' } }}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleUpload}
          style={{ marginTop: 8 }}
        >
          <Form.Item
            name="name"
            label={<span style={{ color: '#ccc' }}>Layer Name</span>}
            rules={[{ required: true, message: 'Enter a layer name' }]}
          >
            <Input
              placeholder="e.g. Proposed Road Alignment"
              style={{ background: '#2a2a2a', border: '1px solid #444', color: '#e0e0e0' }}
            />
          </Form.Item>

          <Form.Item
            name="purpose"
            label={<span style={{ color: '#ccc' }}>Purpose</span>}
          >
            <Select
              placeholder="Select purpose"
              style={{ background: '#2a2a2a' }}
              options={[
                { value: 'Proximity Check', label: 'Proximity Check' },
                { value: 'Encroachment Review', label: 'Encroachment Review' },
                { value: 'Proposed Construction', label: 'Proposed Construction' },
                { value: 'Reference Boundary', label: 'Reference Boundary' },
                { value: 'Survey Reference', label: 'Survey Reference' },
                { value: 'Other', label: 'Other' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="description"
            label={<span style={{ color: '#ccc' }}>Description</span>}
          >
            <Input.TextArea
              rows={2}
              placeholder="Optional details about this layer…"
              style={{ background: '#2a2a2a', border: '1px solid #444', color: '#e0e0e0' }}
            />
          </Form.Item>

          <Form.Item
            label={<span style={{ color: '#ccc' }}>File <span style={{ color: '#888', fontSize: 11 }}>(KML / KMZ / GeoJSON / Shapefile ZIP)</span></span>}
            required
          >
            <Upload.Dragger
              accept={ACCEPT}
              maxCount={1}
              beforeUpload={(file) => {
                fileRef.current = file
                return false // prevent auto-upload
              }}
              onRemove={() => { fileRef.current = null }}
              style={{ background: '#2a2a2a', border: '1px dashed #555' }}
            >
              <p className="ant-upload-drag-icon" style={{ color: '#1890ff' }}>
                <InboxOutlined />
              </p>
              <p style={{ color: '#ccc', margin: 0 }}>Click or drag file here</p>
              <p style={{ color: '#666', fontSize: 11, margin: 0 }}>
                .kml · .kmz · .geojson · .json · .zip (shapefile)
              </p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
