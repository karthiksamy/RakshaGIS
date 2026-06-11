import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Typography, Modal, Form, Input, Select, Switch,
  Space, Popconfirm, message, Upload, Alert, Progress, Divider, Tooltip,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, UploadOutlined, CheckCircleOutlined,
  SyncOutlined, CloseCircleOutlined, StarOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { BasemapConfig } from '@/types'

const GLOBAL_PROVIDERS = ['OSM', 'XYZ', 'WMS', 'WMTS', 'BING', 'BHUVAN', 'ARCGIS', 'SENTINEL2']
const GLOBAL_PROVIDER_OPTIONS = [
  { label: 'OpenStreetMap',                      value: 'OSM'       },
  { label: 'Custom XYZ Tiles',                   value: 'XYZ'       },
  { label: 'WMS Service',                        value: 'WMS'       },
  { label: 'WMTS Service',                       value: 'WMTS'      },
  { label: 'Bing Maps',                          value: 'BING'      },
  { label: 'Bhuvan (ISRO India)',                value: 'BHUVAN'    },
  { label: 'ArcGIS Map Service',                 value: 'ARCGIS'    },
  { label: 'Sentinel-2 Satellite (Copernicus, free)', value: 'SENTINEL2' },
]
const PROVIDERS_WITH_API_KEY = ['ARCGIS', 'BING']
const SENTINEL2_DEFAULT_URL =
  'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023/default/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg'

function CogStatusTag({ status, error }: { status?: string; error?: string | null }) {
  if (!status || status === 'PENDING')
    return <Tag icon={<SyncOutlined spin />} color="default">Converting…</Tag>
  if (status === 'PROCESSING')
    return <Tag icon={<SyncOutlined spin />} color="processing">Processing</Tag>
  if (status === 'DONE')
    return <Tag icon={<CheckCircleOutlined />} color="success">Ready</Tag>
  return <Tooltip title={error || 'Conversion failed'}>
    <Tag icon={<CloseCircleOutlined />} color="error">Failed</Tag>
  </Tooltip>
}

export default function BasemapsPage() {
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [form] = Form.useForm()
  const [uploadForm] = Form.useForm()
  const [formProvider, setFormProvider] = useState<string>('')

  function handleProviderChange(v: string) {
    setFormProvider(v)
    if (v === 'SENTINEL2') {
      form.setFieldsValue({
        url_template: SENTINEL2_DEFAULT_URL,
        attribution: '© EOX IT Services GmbH & Sentinel Hub, contains modified Copernicus Sentinel data',
        cache_zoom_max: 13,
      })
    }
  }
  const [tiffFile, setTiffFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isSuperAdmin = user?.role === 'SUPERADMIN'
  const canUploadLocal = isSuperAdmin || ['DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN', 'SDO', 'SURVEYOR'].includes(user?.role || '')

  const { data, isLoading, refetch } = useQuery<BasemapConfig[]>({
    queryKey: qk.basemaps(),
    queryFn: () => api.get('/gis/basemaps/').then((r) => r.data.results ?? r.data),
  })

  // Poll COG status for any LOCAL_COG basemaps still processing
  const pendingCog = (data || []).filter(
    (b) => b.provider === 'LOCAL_COG' && (b.cog_status === 'PENDING' || b.cog_status === 'PROCESSING')
  )
  if (pendingCog.length > 0 && !pollRef.current) {
    pollRef.current = setInterval(() => {
      refetch().then((r) => {
        const still = (r.data || []).filter(
          (b: BasemapConfig) => b.provider === 'LOCAL_COG' &&
            (b.cog_status === 'PENDING' || b.cog_status === 'PROCESSING')
        )
        if (still.length === 0 && pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      })
    }, 3000)
  }

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

  async function handleLocalUpload(values: { name: string; is_default: boolean }) {
    if (!tiffFile) { message.error('Please select a GeoTIFF file'); return }
    setUploading(true)
    setUploadProgress(0)
    try {
      const fd = new FormData()
      fd.append('name', values.name)
      fd.append('provider', 'LOCAL_COG')
      fd.append('tiff_file', tiffFile)
      fd.append('is_default', String(values.is_default || false))
      await api.post('/gis/basemaps/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) setUploadProgress(Math.round((e.loaded / e.total) * 100))
        },
      })
      message.success('Basemap uploaded — COG conversion started. It will appear as "Ready" shortly.')
      qc.invalidateQueries({ queryKey: qk.basemaps() })
      setUploadModalOpen(false)
      setTiffFile(null)
      uploadForm.resetFields()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Upload failed')
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  const canManage = (bm: BasemapConfig) => {
    if (isSuperAdmin) return true
    if (bm.provider === 'LOCAL_COG' && bm.organisation) return true
    return false
  }

  const columns: ColumnsType<BasemapConfig> = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (n, r) => (
        <Space size={4}>
          {n}
          {r.is_default && <Tag color="gold" style={{ fontSize: 10 }}>Default</Tag>}
          {(r as any).organisation_name && (
            <Tag color="cyan" style={{ fontSize: 10 }}>{(r as any).organisation_name}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Provider',
      dataIndex: 'provider',
      render: (p) => {
        const colors: Record<string, string> = {
          LOCAL_COG: 'purple', SENTINEL2: 'geekblue',
        }
        const labels: Record<string, string> = {
          LOCAL_COG: 'Local TIFF', SENTINEL2: 'Sentinel-2',
        }
        return <Tag color={colors[p] ?? 'default'}>{labels[p] ?? p}</Tag>
      },
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, r) => r.provider === 'LOCAL_COG'
        ? <CogStatusTag status={(r as any).cog_status} error={(r as any).cog_error} />
        : r.provider === 'SENTINEL2'
        ? <Tag color="geekblue" icon={<SyncOutlined />}>Live + cache</Tag>
        : <Tag color="success">Ready</Tag>,
    },
    {
      title: 'URL / Template',
      dataIndex: 'url_template',
      ellipsis: true,
      responsive: ['md'],
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      render: (v, record) => canManage(record) ? (
        <Switch
          size="small"
          checked={v}
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
        <Tag color="gold" icon={<StarOutlined />}>Default</Tag>
      ) : canManage(record) ? (
        <Button size="small" onClick={() => setDefaultMutation.mutate(record.id)}>
          Set default
        </Button>
      ) : null,
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_, record) => canManage(record) && !record.is_system ? (
        <Popconfirm title="Delete this basemap?" onConfirm={() => deleteMutation.mutate(record.id)}>
          <Button type="text" danger icon={<DeleteOutlined />} size="small" />
        </Popconfirm>
      ) : null,
    },
  ]

  const globalBasemaps = (data || []).filter((b) => !(b as any).organisation)
  const localBasemaps  = (data || []).filter((b) => (b as any).organisation)

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          Basemap Configuration
        </Typography.Title>
        <Space wrap>
          {canUploadLocal && (
            <Button
              icon={<UploadOutlined />}
              style={{ borderColor: '#9c27b0', color: '#9c27b0' }}
              onClick={() => setUploadModalOpen(true)}
            >
              Upload Local Basemap
            </Button>
          )}
          {isSuperAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              Add Basemap (URL/Tile)
            </Button>
          )}
        </Space>
      </div>

      {localBasemaps.length > 0 && (
        <>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            Local Basemaps (uploaded by your office)
          </Typography.Text>
          <Table
            dataSource={localBasemaps}
            columns={columns}
            rowKey="id"
            size="small"
            pagination={false}
            style={{ marginBottom: 24 }}
          />
          <Divider style={{ borderColor: 'var(--border-color)' }} />
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            Global Basemaps
          </Typography.Text>
        </>
      )}

      <Table
        dataSource={localBasemaps.length > 0 ? globalBasemaps : data}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={false}
      />

      {/* ── Global basemap (superadmin) ─────────── */}
      <Modal
        title="Add URL / Tile Basemap"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); setFormProvider('') }}
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
      >
        <Form form={form} layout="vertical" onFinish={createMutation.mutate}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
            <Select options={GLOBAL_PROVIDER_OPTIONS} onChange={handleProviderChange} />
          </Form.Item>
          {formProvider === 'SENTINEL2' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="Sentinel-2 free imagery (10 m, ~5-day revisit)"
              description={
                <>
                  The default URL uses the EOX Sentinel-2 cloudless annual mosaic — no API key required.
                  For live updated imagery configure the Sentinel Hub WMTS URL with your free account token.
                  Set <strong>AOI bounds</strong> below to enable offline tile pre-caching.
                </>
              }
            />
          )}
          <Form.Item
            name="url_template"
            label={formProvider === 'ARCGIS' ? 'MapServer Base URL' : 'URL / WMTS Template'}
            rules={[{ required: true }]}
            extra={formProvider === 'ARCGIS'
              ? 'Enter the MapServer URL, e.g. https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'
              : formProvider === 'SENTINEL2'
              ? 'Supports {z}/{x}/{y} (XYZ) and {TileMatrix}/{TileRow}/{TileCol} (WMTS) placeholders'
              : undefined}
          >
            <Input placeholder={
              formProvider === 'ARCGIS'
                ? 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'
                : formProvider === 'SENTINEL2'
                ? SENTINEL2_DEFAULT_URL
                : 'https://{a-c}.tile.openstreetmap.org/{z}/{x}/{y}.png'
            } />
          </Form.Item>
          {PROVIDERS_WITH_API_KEY.includes(formProvider) && (
            <Form.Item name="api_key" label="API Key / Token" rules={[{ required: true }]}>
              <Input.Password placeholder="Paste your ArcGIS token here" />
            </Form.Item>
          )}
          {formProvider === 'SENTINEL2' && (
            <>
              <Form.Item
                name="cache_zoom_max"
                label="Max cache zoom level"
                extra="Tiles at zoom 0–N for the AOI below are pre-fetched by the Celery beat task (8–15 recommended, higher = more disk)"
                initialValue={13}
              >
                <Input type="number" min={8} max={15} style={{ width: 100 }} />
              </Form.Item>
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                AOI bounds for tile pre-caching (leave blank to skip offline caching)
              </Typography.Text>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Form.Item name="bounds_west"  label="West lon"  style={{ marginBottom: 8 }}><Input type="number" step="0.001" /></Form.Item>
                <Form.Item name="bounds_east"  label="East lon"  style={{ marginBottom: 8 }}><Input type="number" step="0.001" /></Form.Item>
                <Form.Item name="bounds_south" label="South lat" style={{ marginBottom: 8 }}><Input type="number" step="0.001" /></Form.Item>
                <Form.Item name="bounds_north" label="North lat" style={{ marginBottom: 8 }}><Input type="number" step="0.001" /></Form.Item>
              </div>
            </>
          )}
          <Form.Item name="attribution" label="Attribution">
            <Input />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
          <Form.Item name="is_default" label="Set as default" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Local TIFF upload (SDO/Admin) ────────── */}
      <Modal
        title={
          <Space>
            <UploadOutlined style={{ color: '#9c27b0' }} />
            Upload Local Basemap (GeoTIFF)
          </Space>
        }
        open={uploadModalOpen}
        onCancel={() => { if (!uploading) { setUploadModalOpen(false); setTiffFile(null); uploadForm.resetFields() } }}
        footer={null}
        width={520}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="For field-office downloaded basemaps"
          description={
            <>
              Upload a GeoTIFF basemap downloaded for offline / local use.
              It will be converted to Cloud-Optimized GeoTIFF (COG) and appear
              in the map's basemap selector for your office only.
              <br /><br />
              <strong>Supported formats:</strong> GeoTIFF (.tif, .tiff) in any projection.
              Large files (up to 2 GB) are supported.
            </>
          }
        />
        <Form form={uploadForm} layout="vertical" onFinish={handleLocalUpload}>
          <Form.Item name="name" label="Basemap Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Chennai City Survey Map 2024" />
          </Form.Item>
          <Form.Item label="GeoTIFF File" required>
            <Upload
              accept=".tif,.tiff"
              maxCount={1}
              beforeUpload={(file) => { setTiffFile(file); return false }}
              onRemove={() => setTiffFile(null)}
              fileList={tiffFile ? [{ uid: '-1', name: tiffFile.name, status: 'done' as const }] : []}
            >
              <Button icon={<UploadOutlined />}>Select GeoTIFF</Button>
            </Upload>
            {tiffFile && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {(tiffFile.size / 1024 / 1024).toFixed(1)} MB selected
              </Typography.Text>
            )}
          </Form.Item>
          <Form.Item name="is_default" label="Set as default for my office" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>

          {uploading && (
            <Progress percent={uploadProgress} size="small" style={{ marginBottom: 12 }} />
          )}

          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={() => { setUploadModalOpen(false); setTiffFile(null); uploadForm.resetFields() }}
              disabled={uploading}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={uploading} disabled={!tiffFile}>
              Upload & Convert
            </Button>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
