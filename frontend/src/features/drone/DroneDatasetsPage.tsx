/**
 * Drone Survey Data Manager
 *
 * Handles upload and viewing for:
 *   ORTHO_2D    — 2D orthomosaic GeoTIFF    → overlaid on the map as COG
 *   DSM_DTM     — Elevation raster          → same COG overlay; terrain-coloured
 *   POINT_CLOUD — LAS / LAZ / COPC          → Potree viewer (new window)
 *   MESH_3D     — 3D Tiles / OBJ / PLY      → Cesium 3D viewer
 *
 * Large-file note:
 *   The standard multipart upload works for files up to the nginx 500 MB limit.
 *   For larger point clouds / meshes, the user is guided to use the QGIS Sync
 *   plugin or direct network-share copy + manual registration.
 */

import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Typography, Modal, Form, Input, Select, Switch,
  Space, Popconfirm, message, Upload, Alert, Progress, Tooltip,
  Descriptions, Badge, Divider,
} from 'antd'
import {
  UploadOutlined, DeleteOutlined, EyeOutlined, BarChartOutlined,
  GlobalOutlined, PictureOutlined, SyncOutlined, CheckCircleOutlined,
  CloseCircleOutlined, InfoCircleOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

interface DroneDataset {
  id: number
  name: string
  description: string
  data_type: 'ORTHO_2D' | 'DSM_DTM' | 'POINT_CLOUD' | 'MESH_3D'
  data_type_display: string
  organisation_name: string
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED'
  error: string | null
  file_url: string | null
  cog_url: string | null
  potree_url: string | null
  tiles_url: string | null
  file_size: number
  original_filename: string
  point_cloud_meta: Record<string, any> | null
  bounds: { west: number; south: number; east: number; north: number } | null
  is_visible: boolean
  opacity: number
  uploaded_by_name: string
  created_at: string
}

const DATA_TYPE_OPTIONS = [
  {
    value: 'ORTHO_2D',
    label: '2D Orthomosaic (GeoTIFF)',
    desc: 'Drone-captured 2D map. Overlaid on the RakshaGIS map after COG conversion.',
    accept: '.tif,.tiff',
    icon: <PictureOutlined style={{ color: '#52c41a' }} />,
  },
  {
    value: 'DSM_DTM',
    label: 'DSM / DTM (Elevation Raster)',
    desc: 'Digital Surface / Terrain Model. Visualised with elevation colour ramp.',
    accept: '.tif,.tiff',
    icon: <BarChartOutlined style={{ color: '#faad14' }} />,
  },
  {
    value: 'POINT_CLOUD',
    label: 'Point Cloud (LAS / LAZ / COPC)',
    desc: 'LiDAR or photogrammetry point cloud. Metadata extracted; Potree viewer for full 3D visualisation.',
    accept: '.las,.laz,.copc,.laz.copc',
    icon: <GlobalOutlined style={{ color: '#1890ff' }} />,
  },
  {
    value: 'MESH_3D',
    label: '3D Mesh / 3D Tiles',
    desc: 'Photogrammetric 3D mesh (OBJ, PLY) or 3D Tiles (tileset.json). Viewed in Cesium.',
    accept: '.obj,.ply,.b3dm,.json,.3dtiles,.zip',
    icon: <GlobalOutlined style={{ color: '#9c27b0' }} />,
  },
]

function fmtBytes(b: number) {
  if (!b) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { status: 'processing' | 'success' | 'error' | 'default'; text: string }> = {
    PENDING:    { status: 'processing', text: 'Queued' },
    PROCESSING: { status: 'processing', text: 'Processing' },
    DONE:       { status: 'success',    text: 'Ready' },
    FAILED:     { status: 'error',      text: 'Failed' },
  }
  const s = map[status] ?? { status: 'default' as const, text: status }
  return <Badge status={s.status} text={s.text} />
}

function TypeTag({ type }: { type: string }) {
  const map: Record<string, { color: string; label: string }> = {
    ORTHO_2D:    { color: 'green',  label: '2D Ortho' },
    DSM_DTM:     { color: 'gold',   label: 'DSM/DTM' },
    POINT_CLOUD: { color: 'blue',   label: 'Point Cloud' },
    MESH_3D:     { color: 'purple', label: '3D Mesh' },
  }
  const t = map[type] ?? { color: 'default', label: type }
  return <Tag color={t.color} style={{ fontSize: 10 }}>{t.label}</Tag>
}

export default function DroneDatasetsPage() {
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [detailDataset, setDetailDataset] = useState<DroneDataset | null>(null)
  const [selectedType, setSelectedType] = useState<string>('ORTHO_2D')
  const [droneFile, setDroneFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [form] = Form.useForm()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: datasets = [], isLoading, refetch } = useQuery<DroneDataset[]>({
    queryKey: ['drone-datasets'],
    queryFn: () => api.get('/core/drone-datasets/').then(r => r.data.results ?? r.data),
    refetchInterval: 8000,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/core/drone-datasets/${id}/`),
    onSuccess: () => { message.success('Dataset deleted'); qc.invalidateQueries({ queryKey: ['drone-datasets'] }) },
    onError: () => message.error('Delete failed'),
  })

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) =>
      api.patch(`/core/drone-datasets/${id}/`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drone-datasets'] }),
  })

  async function handleUpload(values: any) {
    if (!droneFile) { message.error('Please select a file'); return }
    setUploading(true)
    setUploadProgress(0)
    const fd = new FormData()
    fd.append('name', values.name)
    fd.append('description', values.description || '')
    fd.append('data_type', selectedType)
    fd.append('file', droneFile)
    try {
      await api.post('/core/drone-datasets/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) setUploadProgress(Math.round((e.loaded / e.total) * 100))
        },
      })
      message.success('Upload successful — processing started')
      qc.invalidateQueries({ queryKey: ['drone-datasets'] })
      setUploadOpen(false)
      setDroneFile(null)
      form.resetFields()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.response?.data?.file?.[0] || 'Upload failed')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  function openViewer(ds: DroneDataset) {
    if (ds.data_type === 'POINT_CLOUD') {
      if (ds.potree_url) {
        window.open(`/potree/index.html?r=${encodeURIComponent(ds.potree_url)}`, '_blank')
      } else {
        Modal.info({
          title: 'Point Cloud Viewer',
          content: (
            <div>
              <p>Potree octree conversion has not been run yet for this dataset.</p>
              <p><strong>Point count:</strong> {ds.point_cloud_meta?.point_count?.toLocaleString() ?? '—'}</p>
              <p><strong>To view in 3D:</strong> Download the raw file and open in CloudCompare, QGIS, or run potree-converter locally.</p>
              {ds.file_url && (
                <Button href={ds.file_url} download target="_blank" type="primary" size="small" style={{ marginTop: 8 }}>
                  Download Raw File
                </Button>
              )}
            </div>
          ),
        })
      }
    } else if (ds.data_type === 'MESH_3D') {
      const url = ds.tiles_url || ds.file_url
      if (url) window.open(`/terrain?model=${encodeURIComponent(url)}`, '_blank')
      else message.warning('No 3D Tiles URL available yet')
    } else if (ds.cog_url) {
      // For ORTHO/DSM: open the map and layer will be added via the layer panel
      message.info('Open the Map and enable this layer in the Layers panel.')
    }
  }

  const selectedTypeInfo = DATA_TYPE_OPTIONS.find(o => o.value === selectedType)

  const columns: ColumnsType<DroneDataset> = [
    { title: 'Name', dataIndex: 'name', ellipsis: true },
    {
      title: 'Type',
      dataIndex: 'data_type',
      render: (t) => <TypeTag type={t} />,
      width: 110,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (s) => <StatusBadge status={s} />,
    },
    {
      title: 'Size',
      dataIndex: 'file_size',
      width: 90,
      render: fmtBytes,
      responsive: ['md'],
    },
    {
      title: 'Uploaded by',
      dataIndex: 'uploaded_by_name',
      ellipsis: true,
      responsive: ['lg'],
    },
    {
      title: 'Date',
      dataIndex: 'created_at',
      width: 100,
      render: (d) => new Date(d).toLocaleDateString(),
      responsive: ['md'],
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="Details / Viewer">
            <Button
              size="small" type="text" icon={<InfoCircleOutlined />}
              onClick={() => setDetailDataset(record)}
            />
          </Tooltip>
          {record.status === 'DONE' && (
            <Tooltip title="Open viewer">
              <Button
                size="small" type="text" icon={<EyeOutlined />}
                style={{ color: '#52c41a' }}
                onClick={() => openViewer(record)}
              />
            </Tooltip>
          )}
          <Popconfirm title="Delete this dataset?" onConfirm={() => deleteMutation.mutate(record.id)}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
            Drone Survey Data
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Upload orthomosaics, DSM/DTM, point clouds and 3D meshes from drone surveys.
          </Typography.Text>
        </div>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          Upload Drone Data
        </Button>
      </div>

      {/* Data type guide */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {DATA_TYPE_OPTIONS.map(o => (
          <div key={o.value} style={{
            flex: '1 1 180px', minWidth: 160,
            background: 'var(--component-background)',
            border: '1px solid var(--border-color)',
            borderRadius: 6, padding: '8px 12px',
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{o.icon} {o.label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{o.desc}</div>
          </div>
        ))}
      </div>

      <Table
        dataSource={datasets}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 20, size: 'small' }}
      />

      {/* ── Upload modal ──────────────────────────────────────── */}
      <Modal
        title={<Space><UploadOutlined />Upload Drone Dataset</Space>}
        open={uploadOpen}
        onCancel={() => { if (!uploading) { setUploadOpen(false); setDroneFile(null); form.resetFields() } }}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleUpload}>
          <Form.Item label="Data Type" required>
            <Select
              value={selectedType}
              onChange={setSelectedType}
              options={DATA_TYPE_OPTIONS.map(o => ({ label: o.label, value: o.value }))}
            />
            {selectedTypeInfo && (
              <Alert
                type="info" showIcon
                message={selectedTypeInfo.desc}
                style={{ marginTop: 8 }}
              />
            )}
          </Form.Item>

          {selectedType === 'POINT_CLOUD' && (
            <Alert
              type="warning" showIcon style={{ marginBottom: 12 }}
              message="Large file guidance"
              description={
                <>
                  Point clouds can be very large (10–100+ GB). Files up to 500 MB can be
                  uploaded here. For larger datasets, use the <strong>QGIS Sync plugin</strong> or
                  copy to the server via network share and register manually.
                  <br />
                  For in-browser 3D viewing, run <code>potree-converter</code> on the server
                  after upload — the Potree viewer will then work automatically.
                </>
              }
            />
          )}

          <Form.Item name="name" label="Dataset Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. AFS Sulur Ortho Survey Dec 2024" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Flight date, area, sensor used, etc." />
          </Form.Item>

          <Form.Item label="File" required>
            <Upload
              accept={selectedTypeInfo?.accept}
              maxCount={1}
              beforeUpload={(f) => { setDroneFile(f); return false }}
              onRemove={() => setDroneFile(null)}
              fileList={droneFile ? [{ uid: '-1', name: droneFile.name, status: 'done' as const }] : []}
            >
              <Button icon={<UploadOutlined />}>
                Select {selectedTypeInfo?.label.split(' (')[0]} File
              </Button>
            </Upload>
            {droneFile && (
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                {droneFile.name} — {fmtBytes(droneFile.size)}
              </Typography.Text>
            )}
          </Form.Item>

          {uploading && (
            <Progress
              percent={uploadProgress}
              size="small"
              status={uploadProgress < 100 ? 'active' : 'success'}
              style={{ marginBottom: 12 }}
            />
          )}

          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={() => { setUploadOpen(false); setDroneFile(null); form.resetFields() }} disabled={uploading}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={uploading} disabled={!droneFile}>
              Upload & Process
            </Button>
          </Space>
        </Form>
      </Modal>

      {/* ── Detail / viewer modal ─────────────────────────────── */}
      <Modal
        title={detailDataset?.name}
        open={!!detailDataset}
        onCancel={() => setDetailDataset(null)}
        width={600}
        footer={[
          <Button key="close" onClick={() => setDetailDataset(null)}>Close</Button>,
          detailDataset?.status === 'DONE' && (
            <Button key="view" type="primary" icon={<EyeOutlined />}
              onClick={() => { if (detailDataset) openViewer(detailDataset) }}>
              Open Viewer
            </Button>
          ),
          detailDataset?.file_url && (
            <Button key="dl" href={detailDataset.file_url} download target="_blank">
              Download Raw
            </Button>
          ),
        ].filter(Boolean)}
      >
        {detailDataset && (
          <div>
            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Type"><TypeTag type={detailDataset.data_type} /></Descriptions.Item>
              <Descriptions.Item label="Status"><StatusBadge status={detailDataset.status} /></Descriptions.Item>
              <Descriptions.Item label="File">{detailDataset.original_filename}</Descriptions.Item>
              <Descriptions.Item label="Size">{fmtBytes(detailDataset.file_size)}</Descriptions.Item>
              <Descriptions.Item label="Organisation">{detailDataset.organisation_name}</Descriptions.Item>
              <Descriptions.Item label="Uploaded by">{detailDataset.uploaded_by_name}</Descriptions.Item>
              {detailDataset.bounds && (
                <Descriptions.Item label="Bounds" span={2}>
                  W {detailDataset.bounds.west?.toFixed(4)}, S {detailDataset.bounds.south?.toFixed(4)},
                  E {detailDataset.bounds.east?.toFixed(4)}, N {detailDataset.bounds.north?.toFixed(4)}
                </Descriptions.Item>
              )}
            </Descriptions>

            {detailDataset.error && (
              <Alert type="error" message="Processing error" description={detailDataset.error}
                showIcon style={{ marginBottom: 12 }} />
            )}

            {detailDataset.data_type === 'POINT_CLOUD' && detailDataset.point_cloud_meta && (
              <>
                <Divider style={{ borderColor: 'var(--border-color)', marginBottom: 8 }}>Point Cloud Metadata</Divider>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="Point Count">
                    {detailDataset.point_cloud_meta.point_count?.toLocaleString() ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="LAS Version">
                    {detailDataset.point_cloud_meta.las_version ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="CRS">
                    {detailDataset.point_cloud_meta.crs ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Z range">
                    {detailDataset.point_cloud_meta.min_z?.toFixed(1) ?? '—'} →{' '}
                    {detailDataset.point_cloud_meta.max_z?.toFixed(1) ?? '—'} m
                  </Descriptions.Item>
                </Descriptions>

                <Alert
                  type="info" showIcon style={{ marginTop: 12 }}
                  message="3D Viewing"
                  description={
                    detailDataset.potree_url
                      ? 'Potree octree is ready — click "Open Viewer" for interactive 3D viewing.'
                      : 'To view in 3D: run potree-converter on the server, or open the raw file in CloudCompare / QGIS.'
                  }
                />
              </>
            )}

            {(detailDataset.data_type === 'ORTHO_2D' || detailDataset.data_type === 'DSM_DTM') &&
              detailDataset.status === 'DONE' && (
              <Alert
                type="success" showIcon style={{ marginTop: 12 }}
                message="Ready to overlay on map"
                description="Go to the Map page → Layer panel → Drone Layers to toggle this dataset as a map overlay."
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
