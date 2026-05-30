import React, { useRef, useState } from 'react'
import {
  Button, Drawer, Table, Tag, Tooltip, Popconfirm, Space,
  Form, Input, Upload, Select, message, Badge, Typography,
  Modal, Alert, Spin, Descriptions, Tabs,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  UploadOutlined, DeleteOutlined, EyeOutlined, EyeInvisibleOutlined,
  PlusOutlined, FileOutlined, InboxOutlined, RadarChartOutlined,
  FilePdfOutlined, CheckCircleOutlined, WarningOutlined, InfoCircleOutlined,
  CloudServerOutlined, LockOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { TemporaryLayer } from '@/types'

interface ExternalLayer {
  id: number
  display_name: string
  database_name: string
  geometry_type: string
  feature_count: number | null
  is_active: boolean
  description: string
}

// ─── Unique color palette for temp layers ─────────────────────────────────────
const TEMP_COLORS = [
  '#ff6b35', '#a855f7', '#06b6d4', '#f59e0b', '#ec4899',
  '#10b981', '#f97316', '#6366f1', '#14b8a6', '#ef4444',
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
  // External layer callbacks — IDs prefixed with 'ext:' to avoid collision
  extVisibleIds?: Set<string>
  onToggleExtVisible?: (extId: string, geojson: Record<string, unknown>) => void
  onHideExt?: (extId: string) => void
}

const FORMAT_LABELS: Record<string, string> = {
  kml: 'KML', kmz: 'KMZ', geojson: 'GeoJSON', shapefile: 'Shapefile',
}
const FORMAT_COLORS: Record<string, string> = {
  kml: 'green', kmz: 'lime', geojson: 'blue', shapefile: 'orange',
}
const ACCEPT = '.kml,.kmz,.geojson,.json,.zip'

const PURPOSE_OPTIONS = [
  { value: 'NOC_WORKING_PERMISSION', label: 'NOC Working Permission' },
  { value: 'PM_GATI_SHAKTI',         label: 'PM GatiShakti'          },
  { value: 'OTHER',                  label: 'Other'                  },
]
const LAND_RIGHTS_OPTIONS = [
  { value: 'LICENSE',            label: 'License'            },
  { value: 'LEASE',              label: 'Lease'              },
  { value: 'PERMANENT_TRANSFER', label: 'Permanent Transfer' },
  { value: 'OTHER',              label: 'Other'              },
]

// ─── Verdict helpers ──────────────────────────────────────────────────────────
type Verdict = 'FALLS_WITHIN' | 'NEARBY' | 'CLEAR'

const VERDICT_CFG: Record<Verdict, { color: string; bg: string; icon: React.ReactNode; label: string }> = {
  FALLS_WITHIN: {
    color: '#ff4d4f', bg: '#fff1f0',
    icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
    label: 'FALLS WITHIN Defence Land',
  },
  NEARBY: {
    color: '#fa8c16', bg: '#fff7e6',
    icon: <InfoCircleOutlined style={{ color: '#fa8c16' }} />,
    label: 'NEARBY Defence Land (< 1 km)',
  },
  CLEAR: {
    color: '#52c41a', bg: '#f6ffed',
    icon: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
    label: 'DOES NOT FALL in Defence Land',
  },
}

interface AnalysisResult {
  verdict: Verdict
  verdict_text: string
  intersecting_count: number
  nearby_count: number
  intersecting_parcels: Array<{ parcel_id: string; name: string; category: string; area_ha: number; district: string; state: string }>
  nearby_parcels: Array<{ parcel_id: string; name: string; category: string; area_ha: number; distance_km?: number; district: string; state: string }>
  upload_area_sqkm: number | null
  buffer_km: number
}

const EXT_GEOM_COLOR: Record<string, string> = {
  POINT: 'blue', MULTIPOINT: 'blue',
  LINESTRING: 'cyan', MULTILINESTRING: 'cyan',
  POLYGON: 'green', MULTIPOLYGON: 'green',
}

export default function TempLayersPanel({
  open, onClose, visibleIds, onToggleVisible, onHide,
  extVisibleIds = new Set(), onToggleExtVisible, onHideExt,
}: Props) {
  const qc = useQueryClient()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [form] = Form.useForm()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<File | null>(null)

  // Watch conditional fields
  const purposeType    = Form.useWatch('purpose_type', form)
  const landRightsType = Form.useWatch('land_rights_type', form)

  // Analysis state
  const [analysisLayerId,  setAnalysisLayerId]  = useState<number | null>(null)
  const [analysisOpen,     setAnalysisOpen]     = useState(false)
  const [analysisResult,   setAnalysisResult]   = useState<AnalysisResult | null>(null)
  const [analysisLoading,  setAnalysisLoading]  = useState(false)
  const [reportLoading,    setReportLoading]    = useState(false)

  const { data: layers = [], isLoading } = useQuery<TemporaryLayer[]>({
    queryKey: ['temp-layers'],
    queryFn: () => api.get('/projects/temp-layers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })

  const { data: extLayers = [], isLoading: extLoading } = useQuery<ExternalLayer[]>({
    queryKey: ['ext-layers-map'],
    queryFn: () => api.get('/external/layers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })
  const [loadingExtId, setLoadingExtId] = useState<number | null>(null)

  async function toggleExtLayer(layer: ExternalLayer) {
    const key = `ext:${layer.id}`
    if (extVisibleIds.has(key)) {
      onHideExt?.(key)
      return
    }
    setLoadingExtId(layer.id)
    try {
      const r = await api.get(`/external/layers/${layer.id}/geojson/`, { params: { limit: 5000 } })
      onToggleExtVisible?.(key, r.data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Failed to load external layer')
    } finally {
      setLoadingExtId(null)
    }
  }

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/temp-layers/${id}/`),
    onSuccess: (_, id) => {
      onHide(id)
      qc.invalidateQueries({ queryKey: ['temp-layers'] })
      message.success('Temp layer deleted')
    },
    onError: () => message.error('Failed to delete'),
  })

  // ── Upload + auto-analyse ──────────────────────────────────────────────────
  async function handleUpload(values: Record<string, string>) {
    if (!fileRef.current) { message.warning('Please select a file'); return }
    const fd = new FormData()
    fd.append('name',              values.name)
    fd.append('purpose_type',      values.purpose_type)
    fd.append('purpose_other',     values.purpose_other ?? '')
    fd.append('land_rights_type',  values.land_rights_type)
    fd.append('land_rights_other', values.land_rights_other ?? '')
    fd.append('description',       values.description ?? '')
    fd.append('file',              fileRef.current)

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

      if (layer.geojson) {
        onToggleVisible(layer.id, layer.geojson as Record<string, unknown>)
      }

      // Auto-trigger spatial analysis
      openAnalysis(layer.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  // ── Spatial analysis ──────────────────────────────────────────────────────
  async function openAnalysis(layerId: number, cached?: AnalysisResult) {
    setAnalysisLayerId(layerId)
    setAnalysisOpen(true)

    if (cached) {
      setAnalysisResult(cached)
      return
    }

    setAnalysisLoading(true)
    setAnalysisResult(null)
    try {
      const res = await api.post(`/projects/temp-layers/${layerId}/analyse/`)
      setAnalysisResult(res.data)
      qc.invalidateQueries({ queryKey: ['temp-layers'] })
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Analysis failed')
      setAnalysisOpen(false)
    } finally {
      setAnalysisLoading(false)
    }
  }

  async function downloadReport() {
    if (!analysisLayerId) return
    setReportLoading(true)
    try {
      const res = await api.get(`/projects/temp-layers/${analysisLayerId}/analyse/report/`, {
        responseType: 'blob',
      })
      const url  = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `defence_analysis_${analysisLayerId}.pdf`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Report generation failed')
    } finally {
      setReportLoading(false)
    }
  }

  // ── Table columns ─────────────────────────────────────────────────────────
  const columns: ColumnsType<TemporaryLayer> = [
    {
      title: 'Layer Name',
      dataIndex: 'name',
      render: (name, row) => (
        <Space>
          <span style={{
            display: 'inline-block', width: 12, height: 12, borderRadius: 2,
            background: getTempLayerColor(row.id), flexShrink: 0,
          }} />
          <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{name}</span>
        </Space>
      ),
    },
    {
      title: 'Format', dataIndex: 'file_format', width: 85,
      render: (fmt) => (
        <Tag color={FORMAT_COLORS[fmt] ?? 'default'} style={{ fontSize: 11 }}>
          {FORMAT_LABELS[fmt] ?? fmt}
        </Tag>
      ),
    },
    { title: 'Features', dataIndex: 'feature_count', width: 72, align: 'right',
      render: (n) => <span style={{ color: '#aaa' }}>{n}</span> },
    {
      title: 'Purpose', dataIndex: 'effective_purpose', ellipsis: true,
      render: (v) => <span style={{ color: '#888', fontSize: 11 }}>{v || '—'}</span>,
    },
    {
      title: 'Land Rights', dataIndex: 'effective_land_rights', ellipsis: true,
      render: (v) => <span style={{ color: '#888', fontSize: 11 }}>{v || '—'}</span>,
    },
    {
      title: 'Analysis',
      width: 80,
      render: (_, row) => {
        const res = (row as any).analysis_result as AnalysisResult | null
        if (!res) return (
          <Tooltip title="Run defence land analysis">
            <Button size="small" type="link" icon={<RadarChartOutlined />}
              onClick={() => openAnalysis(row.id)} style={{ color: '#888' }}>
              Analyse
            </Button>
          </Tooltip>
        )
        const cfg = VERDICT_CFG[res.verdict] ?? VERDICT_CFG.CLEAR
        return (
          <Tooltip title={res.verdict_text}>
            <Button size="small" type="link"
              icon={cfg.icon}
              style={{ color: cfg.color }}
              onClick={() => openAnalysis(row.id, res)}>
              View
            </Button>
          </Tooltip>
        )
      },
    },
    {
      title: 'Actions', width: 80,
      render: (_, row) => {
        const visible = visibleIds.has(row.id)
        return (
          <Space size={4}>
            <Tooltip title={visible ? 'Hide from map' : 'Show on map'}>
              <Button size="small" type="text"
                icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                style={{ color: visible ? getTempLayerColor(row.id) : '#888' }}
                onClick={() => {
                  if (visible) { onHide(row.id) }
                  else if ((row as any).geojson) {
                    onToggleVisible(row.id, (row as any).geojson)
                  } else {
                    api.get(`/projects/temp-layers/${row.id}/`).then(r => {
                      if (r.data.geojson) onToggleVisible(row.id, r.data.geojson)
                      else message.warning('No geometry data found')
                    })
                  }
                }}
              />
            </Tooltip>
            <Popconfirm title="Delete this temp layer?" onConfirm={() => deleteMut.mutate(row.id)}
              okText="Delete" okButtonProps={{ danger: true }}>
              <Tooltip title="Delete">
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  const inputStyle = { background: '#2a2a2a', border: '1px solid #444', color: '#e0e0e0' }

  return (
    <>
      {/* ── Main Drawer ────────────────────────────────────────────────────── */}
      <Drawer
        title={
          <Space>
            <FileOutlined />
            <span>Layers</span>
            <Badge count={layers.length + extLayers.length} style={{ backgroundColor: '#1890ff' }} />
          </Space>
        }
        placement="right" width={760} open={open} onClose={onClose}
        styles={{ body: { padding: 12, background: '#1a1a1a' }, header: { background: '#1a1a1a', borderBottom: '1px solid #333', color: '#e0e0e0' } }}
        extra={
          <Button type="primary" icon={<PlusOutlined />} size="small"
            onClick={() => setUploadOpen(true)}>Upload</Button>
        }
      >
        <Tabs
          style={{ color: '#ccc' }}
          items={[
            {
              key: 'temp',
              label: <span><FileOutlined /> Temp Uploads ({layers.length})</span>,
              children: (
                <>
                  <Typography.Text style={{ color: '#888', fontSize: 12, display: 'block', marginBottom: 8 }}>
                    Upload KML, KMZ, GeoJSON, or Shapefile ZIP. Auto-analysed against Defence land boundaries.
                  </Typography.Text>
                  <Table dataSource={layers} columns={columns} rowKey="id" loading={isLoading}
                    size="small" pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    style={{ background: 'transparent' }} className="dark-table"
                    rowClassName={(row) => visibleIds.has(row.id) ? 'temp-layer-visible-row' : ''}
                  />
                </>
              ),
            },
            {
              key: 'external',
              label: <span><CloudServerOutlined /> External DB Layers ({extLayers.length})</span>,
              children: (
                <>
                  <Alert type="info" showIcon style={{ marginBottom: 10, fontSize: 12 }}
                    icon={<LockOutlined />}
                    message="These layers are read-only — served live from the external database configured by the super admin." />
                  <Table
                    dataSource={extLayers}
                    rowKey="id"
                    loading={extLoading}
                    size="small"
                    pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    style={{ background: 'transparent' }}
                    className="dark-table"
                    columns={[
                      {
                        title: 'Layer',
                        dataIndex: 'display_name',
                        render: (name, row) => (
                          <Space>
                            <Tag color={EXT_GEOM_COLOR[row.geometry_type] ?? 'default'} style={{ fontSize: 10 }}>
                              {row.geometry_type?.replace('MULTI', 'M-') ?? '?'}
                            </Tag>
                            <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{name}</span>
                          </Space>
                        ),
                      },
                      {
                        title: 'Source DB', dataIndex: 'database_name', width: 160,
                        render: v => <span style={{ color: '#888', fontSize: 12 }}>{v}</span>,
                      },
                      {
                        title: 'Features', dataIndex: 'feature_count', width: 80, align: 'right',
                        render: v => <span style={{ color: '#aaa' }}>{v != null ? v.toLocaleString() : '—'}</span>,
                      },
                      {
                        title: 'Actions', width: 80,
                        render: (_, row) => {
                          const key = `ext:${row.id}`
                          const visible = extVisibleIds.has(key)
                          return (
                            <Tooltip title={visible ? 'Hide from map' : 'Show on map'}>
                              <Button
                                size="small" type="text"
                                icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                                loading={loadingExtId === row.id}
                                style={{ color: visible ? '#1890ff' : '#888' }}
                                onClick={() => toggleExtLayer(row)}
                              />
                            </Tooltip>
                          )
                        },
                      },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
      </Drawer>

      {/* ── Upload Modal ───────────────────────────────────────────────────── */}
      <Modal
        title={<span style={{ color: '#e0e0e0' }}>Upload Temporary Layer</span>}
        open={uploadOpen}
        onCancel={() => { setUploadOpen(false); form.resetFields(); fileRef.current = null }}
        onOk={() => form.submit()}
        okText={uploading ? 'Uploading…' : 'Upload'}
        confirmLoading={uploading}
        width={520}
        styles={{ content: { background: '#1e1e1e' }, header: { background: '#1e1e1e' }, footer: { background: '#1e1e1e' } }}
      >
        <Form form={form} layout="vertical" onFinish={handleUpload} style={{ marginTop: 8 }}>
          {/* Layer name */}
          <Form.Item name="name" label={<span style={{ color: '#ccc' }}>Layer Name</span>}
            rules={[{ required: true, message: 'Enter a layer name' }]}>
            <Input placeholder="e.g. Proposed Road Alignment" style={inputStyle} />
          </Form.Item>

          {/* Purpose dropdown */}
          <Form.Item name="purpose_type" label={<span style={{ color: '#ccc' }}>Purpose <span style={{ color: '#ff4d4f' }}>*</span></span>}
            rules={[{ required: true, message: 'Purpose is required' }]}>
            <Select placeholder="Select purpose" options={PURPOSE_OPTIONS}
              style={{ background: '#2a2a2a' }} />
          </Form.Item>

          {purposeType === 'OTHER' && (
            <Form.Item name="purpose_other"
              label={<span style={{ color: '#ccc' }}>Specify Other Purpose <span style={{ color: '#ff4d4f' }}>*</span></span>}
              rules={[{ required: true, message: 'Please specify the purpose' }]}>
              <Input placeholder="Describe the purpose" style={inputStyle} />
            </Form.Item>
          )}

          {/* Land Rights Type dropdown */}
          <Form.Item name="land_rights_type" label={<span style={{ color: '#ccc' }}>Land Rights Type <span style={{ color: '#ff4d4f' }}>*</span></span>}
            rules={[{ required: true, message: 'Land Rights Type is required' }]}>
            <Select placeholder="Select land rights type" options={LAND_RIGHTS_OPTIONS}
              style={{ background: '#2a2a2a' }} />
          </Form.Item>

          {landRightsType === 'OTHER' && (
            <Form.Item name="land_rights_other"
              label={<span style={{ color: '#ccc' }}>Specify Other Land Rights Type <span style={{ color: '#ff4d4f' }}>*</span></span>}
              rules={[{ required: true, message: 'Please specify the land rights type' }]}>
              <Input placeholder="Describe the land rights type" style={inputStyle} />
            </Form.Item>
          )}

          {/* Description */}
          <Form.Item name="description" label={<span style={{ color: '#ccc' }}>Description</span>}>
            <Input.TextArea rows={2} placeholder="Optional details…" style={inputStyle} />
          </Form.Item>

          {/* File upload */}
          <Form.Item label={<span style={{ color: '#ccc' }}>File <span style={{ color: '#888', fontSize: 11 }}>(KML / KMZ / GeoJSON / Shapefile ZIP)</span></span>} required>
            <Upload.Dragger accept={ACCEPT} maxCount={1}
              beforeUpload={(file) => { fileRef.current = file; return false }}
              onRemove={() => { fileRef.current = null }}
              style={{ background: '#2a2a2a', border: '1px dashed #555' }}>
              <p className="ant-upload-drag-icon" style={{ color: '#1890ff' }}><InboxOutlined /></p>
              <p style={{ color: '#ccc', margin: 0 }}>Click or drag file here</p>
              <p style={{ color: '#666', fontSize: 11, margin: 0 }}>.kml · .kmz · .geojson · .json · .zip</p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Analysis Result Modal ──────────────────────────────────────────── */}
      <Modal
        title={
          <Space>
            <RadarChartOutlined style={{ color: '#1890ff' }} />
            <span style={{ color: '#e0e0e0' }}>Defence Land Proximity Analysis</span>
          </Space>
        }
        open={analysisOpen}
        onCancel={() => { setAnalysisOpen(false); setAnalysisResult(null) }}
        width={680}
        footer={
          analysisResult ? (
            <Space>
              <Button onClick={() => { setAnalysisOpen(false); setAnalysisResult(null) }}>Close</Button>
              <Button icon={<FilePdfOutlined />} loading={reportLoading} onClick={downloadReport}
                type="primary">
                Download PDF Report
              </Button>
            </Space>
          ) : null
        }
        styles={{ content: { background: '#1e1e1e' }, header: { background: '#1e1e1e' }, footer: { background: '#1e1e1e' } }}
      >
        {analysisLoading && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <div style={{ color: '#aaa', marginTop: 12 }}>Analysing against Defence land boundaries…</div>
          </div>
        )}

        {!analysisLoading && analysisResult && (() => {
          const cfg = VERDICT_CFG[analysisResult.verdict] ?? VERDICT_CFG.CLEAR
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Verdict banner */}
              <Alert
                type={analysisResult.verdict === 'FALLS_WITHIN' ? 'error'
                  : analysisResult.verdict === 'NEARBY' ? 'warning' : 'success'}
                icon={cfg.icon}
                showIcon
                message={<strong>{cfg.label}</strong>}
                description={analysisResult.verdict_text}
                style={{ background: cfg.bg }}
              />

              {/* Summary stats */}
              <Descriptions size="small" column={2} bordered
                labelStyle={{ color: '#aaa', background: '#2a2a2a' }}
                contentStyle={{ color: '#e0e0e0', background: '#1e1e1e' }}>
                <Descriptions.Item label="Intersecting Parcels">{analysisResult.intersecting_count}</Descriptions.Item>
                <Descriptions.Item label="Nearby Parcels (< 1 km)">{analysisResult.nearby_count}</Descriptions.Item>
                {analysisResult.upload_area_sqkm != null && (
                  <Descriptions.Item label="Upload Area (est.)" span={2}>
                    {analysisResult.upload_area_sqkm.toFixed(4)} km²
                  </Descriptions.Item>
                )}
              </Descriptions>

              {/* Intersecting parcels table */}
              {analysisResult.intersecting_count > 0 && (
                <div>
                  <div style={{ color: '#ff4d4f', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    Intersecting Defence Parcels ({analysisResult.intersecting_count})
                  </div>
                  <Table size="small" pagination={false}
                    dataSource={analysisResult.intersecting_parcels}
                    rowKey="parcel_id"
                    style={{ background: 'transparent' }}
                    className="dark-table"
                    columns={[
                      { title: 'Parcel ID',  dataIndex: 'parcel_id', width: 100 },
                      { title: 'Name',       dataIndex: 'name', ellipsis: true },
                      { title: 'Category',   dataIndex: 'category', width: 130 },
                      { title: 'Area (ha)',  dataIndex: 'area_ha', width: 80, align: 'right',
                        render: (v) => v.toFixed(2) },
                    ]}
                  />
                </div>
              )}

              {/* Nearby parcels table */}
              {analysisResult.nearby_count > 0 && (
                <div>
                  <div style={{ color: '#fa8c16', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    Nearby Defence Parcels within {analysisResult.buffer_km} km ({analysisResult.nearby_count})
                  </div>
                  <Table size="small" pagination={false}
                    dataSource={analysisResult.nearby_parcels}
                    rowKey="parcel_id"
                    style={{ background: 'transparent' }}
                    className="dark-table"
                    columns={[
                      { title: 'Parcel ID',  dataIndex: 'parcel_id', width: 100 },
                      { title: 'Name',       dataIndex: 'name', ellipsis: true },
                      { title: 'Category',   dataIndex: 'category', width: 120 },
                      { title: 'Distance',   dataIndex: 'distance_km', width: 90, align: 'right',
                        render: (v) => v != null ? `${v.toFixed(3)} km` : '—' },
                      { title: 'Area (ha)',  dataIndex: 'area_ha', width: 80, align: 'right',
                        render: (v) => v.toFixed(2) },
                    ]}
                  />
                </div>
              )}

              {analysisResult.verdict === 'CLEAR' && (
                <Alert type="success" showIcon
                  message="No Defence land found within 1 km of the uploaded file."
                  style={{ background: '#f6ffed' }} />
              )}
            </div>
          )
        })()}
      </Modal>
    </>
  )
}
