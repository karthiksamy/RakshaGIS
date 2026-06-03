import React, { useRef, useState } from 'react'
import {
  Button, Drawer, Table, Tag, Tooltip, Popconfirm, Space,
  Form, Input, Upload, Select, message, Badge, Typography,
  Modal, Alert, Spin, Descriptions, Tabs, Checkbox,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  UploadOutlined, DeleteOutlined, EyeOutlined, EyeInvisibleOutlined,
  PlusOutlined, FileOutlined, InboxOutlined, RadarChartOutlined,
  FilePdfOutlined, CheckCircleOutlined, WarningOutlined, InfoCircleOutlined,
  CloudServerOutlined, LockOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import type { TemporaryLayer } from '@/types'

interface ExternalLayer {
  id: number
  display_name: string
  database_name: string
  geometry_type: string
  feature_count: number | null
  is_active: boolean
  description: string
  level_filter_fields: Record<string, string>
  office_filter_field: string
}

interface SurveyAreaOption {
  id: number
  name: string
  area_code: string
  project: number
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

// ─── Buffer options (all valid distances, flat list) ──────────────────────────
const ALL_BUFFER_OPTIONS = [
  { label: '50 m',    metres: 50     },
  { label: '100 m',   metres: 100    },
  { label: '200 m',   metres: 200    },
  { label: '500 m',   metres: 500    },
  { label: '1 km',    metres: 1000   },
  { label: '2 km',    metres: 2000   },
  { label: '5 km',    metres: 5000   },
  { label: '10 km',   metres: 10000  },
  { label: '25 km',   metres: 25000  },
  { label: '50 km',   metres: 50000  },
  { label: '100 km',  metres: 100000 },
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

interface AnalysisFeature {
  id: number | string
  layer_name: string
  project: string
  project_id: number | null
  label?: string
  attributes: Record<string, string>
  distance_m?: number | null
  distance_km?: number | null
}

interface AnalysisResult {
  verdict: Verdict
  verdict_text: string
  intersecting_count: number
  nearby_count: number
  intersecting_features: AnalysisFeature[]
  nearby_features: AnalysisFeature[]
  upload_area_sqkm: number | null
  buffer_m: number
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
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [form] = Form.useForm()
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<File | null>(null)
  // SURVEYOR works at CEO/ADEO level — their temp layers can be shared with the parent DEO.
  const userRole = useAppStore((s) => s.user?.role)
  const isCantonmentUploader = userRole === 'SURVEYOR'
  const [deoVisible, setDeoVisible] = useState(true)

  // Watch conditional fields
  const purposeType    = Form.useWatch('purpose_type', form)
  const landRightsType = Form.useWatch('land_rights_type', form)

  // Analysis state
  const [analysisLayerId,  setAnalysisLayerId]  = useState<number | null>(null)
  const [analysisOpen,     setAnalysisOpen]     = useState(false)
  // Multi-range results keyed by buffer_m string
  const [analysisResults,  setAnalysisResults]  = useState<Record<string, AnalysisResult>>({})
  const [analysisLoading,  setAnalysisLoading]  = useState(false)
  const [reportLoading,    setReportLoading]    = useState(false)
  // Selected buffer distances (multi-select); default to 1 km
  const [selectedBuffers,  setSelectedBuffers]  = useState<number[]>([1000])
  // Selected analysis targets (empty = run against all of that type)
  const [selectedSurveyAreaIds, setSelectedSurveyAreaIds] = useState<number[]>([])
  const [selectedExtLayerIds,   setSelectedExtLayerIds]   = useState<number[]>([])

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

  const { data: surveyAreas = [] } = useQuery<SurveyAreaOption[]>({
    queryKey: ['survey-areas-for-analysis'],
    queryFn: () => api.get('/projects/survey-areas/', { params: { page_size: 500 } })
                      .then(r => r.data.results ?? r.data),
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
      const fc = r.data
      const count = fc?.features?.length ?? 0
      if (count === 0) {
        message.warning(t('external.layer_empty', { name: layer.display_name }))
      } else {
        message.success(t('external.layer_loaded', { name: layer.display_name, count }))
      }
      onToggleExtVisible?.(key, fc)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || `Failed to load "${layer.display_name}"`)
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
  async function handleUpload(values: Record<string, unknown>) {
    if (!fileRef.current) { message.warning('Please select a file'); return }
    const fd = new FormData()
    fd.append('name',              values.name as string)
    fd.append('purpose_type',      values.purpose_type as string)
    fd.append('purpose_other',     (values.purpose_other as string) ?? '')
    fd.append('land_rights_type',  values.land_rights_type as string)
    fd.append('land_rights_other', (values.land_rights_other as string) ?? '')
    fd.append('description',       (values.description as string) ?? '')
    fd.append('file',              fileRef.current)
    if (isCantonmentUploader) fd.append('deo_visible', String(deoVisible))

    // Snapshot current ID selections before the async upload
    const surveySnap = [...selectedSurveyAreaIds]
    const extSnap    = [...selectedExtLayerIds]

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

      // Open analysis modal with pre-filled targets — user selects ranges and clicks Run
      openAnalysis(layer.id, surveySnap, extSnap)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  // ── Spatial analysis ──────────────────────────────────────────────────────
  async function runAnalysis(
    layerId:   number,
    buffers:   number[],
    surveyIds?: number[],
    extIds?:    number[],
  ) {
    if (buffers.length === 0) {
      message.warning('Please select at least one buffer distance')
      return
    }
    setAnalysisLoading(true)
    setAnalysisResults({})
    const eSurvey = surveyIds ?? selectedSurveyAreaIds
    const eExt    = extIds    ?? selectedExtLayerIds

    const settled = await Promise.allSettled(
      buffers.map(bm =>
        api.post(`/projects/temp-layers/${layerId}/analyse/`, {
          buffer_m:           bm,
          survey_area_ids:    eSurvey.length > 0 ? eSurvey : null,
          external_layer_ids: eExt.length   > 0 ? eExt    : null,
        }).then(r => ({ bm, result: r.data as AnalysisResult }))
      )
    )

    const resultMap: Record<string, AnalysisResult> = {}
    let errCount = 0
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        resultMap[String(s.value.bm)] = s.value.result
      } else {
        errCount++
      }
    }
    if (errCount > 0) message.warning(`${errCount} buffer range(s) failed to analyse`)
    setAnalysisResults(resultMap)
    qc.invalidateQueries({ queryKey: ['temp-layers'] })
    setAnalysisLoading(false)
  }

  // Open the analysis modal — no auto-run; user selects ranges first
  function openAnalysis(layerId: number, surveyIds?: number[], extIds?: number[]) {
    setAnalysisLayerId(layerId)
    setAnalysisResults({})
    setAnalysisOpen(true)
    if (surveyIds !== undefined) setSelectedSurveyAreaIds(surveyIds)
    if (extIds    !== undefined) setSelectedExtLayerIds(extIds)
  }

  async function downloadReport() {
    if (!analysisLayerId) return
    setReportLoading(true)
    // PDF covers only the buffers that were selected for the current run
    const bufferParam = selectedBuffers.length > 0
      ? selectedBuffers.join(',')
      : Object.keys(analysisResults).join(',')
    try {
      const res = await api.get(`/projects/temp-layers/${analysisLayerId}/analyse/report/`, {
        params:       { buffers: bufferParam || undefined },
        responseType: 'blob',
      })
      const url  = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `defence_proximity_report_${analysisLayerId}.pdf`
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
        // analysis_result is keyed by buffer_m string or legacy flat result
        const stored = (row as any).analysis_result as Record<string, AnalysisResult> | AnalysisResult | null
        let badge: AnalysisResult | null = null
        if (stored && typeof stored === 'object') {
          if ('verdict' in stored) {
            badge = stored as AnalysisResult  // legacy flat
          } else {
            const keyed = stored as Record<string, AnalysisResult>
            // Show worst cached verdict
            const all = Object.values(keyed)
            badge = all.find(r => r.verdict === 'FALLS_WITHIN')
              ?? all.find(r => r.verdict === 'NEARBY')
              ?? all[0]
              ?? null
          }
        }
        if (!badge) return (
          <Tooltip title="Open analysis — select ranges and run">
            <Button size="small" type="link" icon={<RadarChartOutlined />}
              onClick={() => openAnalysis(row.id)} style={{ color: '#888' }}>
              Analyse
            </Button>
          </Tooltip>
        )
        const cfg = VERDICT_CFG[badge.verdict] ?? VERDICT_CFG.CLEAR
        return (
          <Tooltip title={`${badge.verdict_text} — click to view / re-run`}>
            <Button size="small" type="link"
              icon={cfg.icon}
              style={{ color: cfg.color }}
              onClick={() => openAnalysis(row.id)}>
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
              label: <span><CloudServerOutlined /> {t("nav.external_data")} ({extLayers.length})</span>,
              children: (
                <>
                  <Alert type="info" showIcon style={{ marginBottom: 10, fontSize: 12 }}
                    icon={<LockOutlined />}
                    message={t("external.read_only_info")} />
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
                        title: 'Source DB', dataIndex: 'database_name', width: 140,
                        render: v => <span style={{ color: '#888', fontSize: 12 }}>{v}</span>,
                      },
                      {
                        title: 'Total', dataIndex: 'feature_count', width: 70, align: 'right',
                        render: v => <span style={{ color: '#aaa' }}>{v != null ? v.toLocaleString() : '—'}</span>,
                      },
                      {
                        title: 'Filter', width: 90,
                        render: (_, row) => {
                          const lf = row.level_filter_fields || {}
                          const hasFilter = Object.values(lf).some(Boolean)
                          return hasFilter
                            ? <Tag color="purple" style={{ fontSize: 10 }}>{t("external.level_filter_tag")}</Tag>
                            : <Tag color="default" style={{ fontSize: 10 }}>{t("external.all_rows_tag")}</Tag>
                        },
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

          {/* Analysis Targets — 2-tab selector (controlled state, not form field) */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#ccc', fontSize: 13, marginBottom: 6 }}>
              Run Analysis Against
              <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>
                (leave empty to include all)
              </span>
            </div>
            <Tabs
              size="small"
              style={{ color: '#ccc' }}
              items={[
                {
                  key: 'survey',
                  label: <span style={{ color: '#ccc' }}>Survey Area</span>,
                  children: (
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="All survey areas — select to filter"
                      value={selectedSurveyAreaIds}
                      onChange={(vals) => setSelectedSurveyAreaIds(vals as number[])}
                      style={{ width: '100%' }}
                      optionFilterProp="label"
                      options={surveyAreas.map(a => ({
                        value: a.id,
                        label: a.area_code ? `${a.name} (${a.area_code})` : a.name,
                      }))}
                    />
                  ),
                },
                {
                  key: 'external',
                  label: <span style={{ color: '#ccc' }}>External Layers</span>,
                  children: (
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="All external layers — select to filter"
                      value={selectedExtLayerIds}
                      onChange={(vals) => setSelectedExtLayerIds(vals as number[])}
                      style={{ width: '100%' }}
                      optionFilterProp="label"
                      options={extLayers.map(l => ({
                        value: l.id,
                        label: l.display_name,
                      }))}
                    />
                  ),
                },
              ]}
            />
          </div>

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

          {isCantonmentUploader && (
            <Form.Item style={{ marginBottom: 0 }}>
              <Checkbox checked={deoVisible} onChange={(e) => setDeoVisible(e.target.checked)}>
                <span style={{ color: '#ccc' }}>Allow parent DEO office to view this layer</span>
              </Checkbox>
            </Form.Item>
          )}
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
        onCancel={() => { setAnalysisOpen(false); setAnalysisResults({}) }}
        width={780}
        footer={
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={() => { setAnalysisOpen(false); setAnalysisResults({}) }}>Close</Button>
            <Space>
              <Button
                icon={<RadarChartOutlined />}
                loading={analysisLoading}
                disabled={selectedBuffers.length === 0}
                onClick={() => analysisLayerId && runAnalysis(analysisLayerId, selectedBuffers)}
              >
                Run Analysis ({selectedBuffers.length} range{selectedBuffers.length !== 1 ? 's' : ''})
              </Button>
              <Button
                icon={<FilePdfOutlined />}
                loading={reportLoading}
                onClick={downloadReport}
                type="primary"
                disabled={Object.keys(analysisResults).length === 0}
              >
                Download Report
              </Button>
            </Space>
          </Space>
        }
        styles={{ content: { background: '#1e1e1e' }, header: { background: '#1e1e1e' }, footer: { background: '#1e1e1e' } }}
      >
        {/* ── Step 1: Buffer multi-select ── */}
        <div style={{
          background: '#2a2a2a', border: '1px solid #3a3a3a', borderRadius: 6,
          padding: '12px 14px', marginBottom: 12,
        }}>
          <div style={{ color: '#888', fontSize: 11, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            Step 1 — Select Buffer Distances
            <span style={{ color: '#666', fontSize: 10, marginLeft: 6, textTransform: 'none' }}>
              (multi-select)
            </span>
          </div>
          <Checkbox.Group
            value={selectedBuffers}
            onChange={(vals) => setSelectedBuffers(vals as number[])}
            style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 0' }}
          >
            {ALL_BUFFER_OPTIONS.map(opt => (
              <Checkbox
                key={opt.metres}
                value={opt.metres}
                style={{ color: '#ccc', marginInlineStart: 0, width: 90 }}
              >
                {opt.label}
              </Checkbox>
            ))}
          </Checkbox.Group>
        </div>

        {/* ── Step 2: Analysis targets ── */}
        <div style={{
          background: '#2a2a2a', border: '1px solid #3a3a3a', borderRadius: 6,
          padding: '12px 14px', marginBottom: 16,
        }}>
          <div style={{ color: '#888', fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
            Step 2 — Run Analysis Against
            <span style={{ color: '#666', fontSize: 10, marginLeft: 6, textTransform: 'none' }}>
              (empty = all)
            </span>
          </div>
          <Tabs
            size="small"
            style={{ color: '#ccc' }}
            items={[
              {
                key: 'survey',
                label: <span style={{ color: '#ccc', fontSize: 12 }}>Survey Area</span>,
                children: (
                  <Select
                    mode="multiple"
                    allowClear
                    size="small"
                    placeholder="All survey areas — select to filter"
                    value={selectedSurveyAreaIds}
                    onChange={(vals) => setSelectedSurveyAreaIds(vals as number[])}
                    style={{ width: '100%' }}
                    optionFilterProp="label"
                    options={surveyAreas.map(a => ({
                      value: a.id,
                      label: a.area_code ? `${a.name} (${a.area_code})` : a.name,
                    }))}
                  />
                ),
              },
              {
                key: 'external',
                label: <span style={{ color: '#ccc', fontSize: 12 }}>External Layers</span>,
                children: (
                  <Select
                    mode="multiple"
                    allowClear
                    size="small"
                    placeholder="All external layers — select to filter"
                    value={selectedExtLayerIds}
                    onChange={(vals) => setSelectedExtLayerIds(vals as number[])}
                    style={{ width: '100%' }}
                    optionFilterProp="label"
                    options={extLayers.map(l => ({
                      value: l.id,
                      label: l.display_name,
                    }))}
                  />
                ),
              },
            ]}
          />
        </div>

        {/* ── Results ── */}
        {analysisLoading && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <div style={{ color: '#aaa', marginTop: 12 }}>
              Analysing {selectedBuffers.length} buffer range{selectedBuffers.length !== 1 ? 's' : ''}…
            </div>
          </div>
        )}

        {!analysisLoading && Object.keys(analysisResults).length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: '#555' }}>
            Select buffer distances above and click <strong style={{ color: '#888' }}>Run Analysis</strong>.
          </div>
        )}

        {!analysisLoading && Object.keys(analysisResults).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {Object.keys(analysisResults)
              .sort((a, b) => Number(a) - Number(b))
              .map(bmKey => {
                const result = analysisResults[bmKey]
                const cfg = VERDICT_CFG[result.verdict] ?? VERDICT_CFG.CLEAR
                const bufLabel = result.buffer_m < 1000
                  ? `${result.buffer_m} m`
                  : `${result.buffer_m / 1000} km`

                // Split survey vs external layer features (external ids are 'ext:N')
                const isExt = (f: AnalysisFeature) => String(f.id).startsWith('ext:')
                const surveyInt  = result.intersecting_features.filter(f => !isExt(f))
                const extInt     = result.intersecting_features.filter(isExt)
                const surveyNear = result.nearby_features.filter(f => !isExt(f))
                const extNear    = result.nearby_features.filter(isExt)

                // Derive attribute keys PER group (no cross-group slicing)
                const surveyIntKeys  = Array.from(new Set(surveyInt.flatMap(f => Object.keys(f.attributes || {})))).slice(0, 6)
                const extIntKeys     = Array.from(new Set(extInt.flatMap(f => Object.keys(f.attributes || {}))))
                const surveyNearKeys = Array.from(new Set(surveyNear.flatMap(f => Object.keys(f.attributes || {})))).slice(0, 5)
                const extNearKeys    = Array.from(new Set(extNear.flatMap(f => Object.keys(f.attributes || {}))))

                const attrCols = (keys: string[]) => keys.map(k => ({
                  title: k, key: k, ellipsis: true, width: 110,
                  render: (_: unknown, r: AnalysisFeature) => (
                    <span style={{ color: '#ccc', fontSize: 11 }}>{r.attributes?.[k] ?? '—'}</span>
                  ),
                }))

                const baseIntCols = [
                  { title: 'ID',    dataIndex: 'id', width: 70 },
                  { title: 'Layer', dataIndex: 'layer_name', ellipsis: true, width: 140 },
                  { title: 'Label', dataIndex: 'label', ellipsis: true, width: 120,
                    render: (v: string, r: AnalysisFeature) => v || Object.values(r.attributes)[0] || '—' },
                ]
                const baseNearCols = [
                  { title: 'ID',    dataIndex: 'id', width: 70 },
                  { title: 'Layer', dataIndex: 'layer_name', ellipsis: true, width: 140 },
                  { title: 'Label', dataIndex: 'label', ellipsis: true, width: 110,
                    render: (v: string, r: AnalysisFeature) => v || Object.values(r.attributes)[0] || '—' },
                ]
                const distCol = {
                  title: 'Distance', dataIndex: 'distance_km', width: 90, align: 'right' as const,
                  render: (v: number | null) => v != null ? `${v.toFixed(3)} km` : '—',
                }

                return (
                  <div key={bmKey} style={{
                    border: `1px solid ${cfg.color}44`,
                    borderRadius: 6,
                    overflow: 'hidden',
                  }}>
                    {/* Range header */}
                    <div style={{
                      background: `${cfg.color}22`,
                      borderBottom: `1px solid ${cfg.color}44`,
                      padding: '8px 12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}>
                      <Space>
                        {cfg.icon}
                        <span style={{ color: cfg.color, fontWeight: 600, fontSize: 13 }}>
                          Buffer: {bufLabel}
                        </span>
                        <span style={{ color: '#aaa', fontSize: 12 }}>{cfg.label}</span>
                      </Space>
                      <Space>
                        <Tag color="red"    style={{ fontSize: 11 }}>Intersecting: {result.intersecting_count}</Tag>
                        <Tag color="orange" style={{ fontSize: 11 }}>Nearby: {result.nearby_count}</Tag>
                        {result.upload_area_sqkm != null && (
                          <Tag color="blue" style={{ fontSize: 11 }}>
                            Area: {result.upload_area_sqkm.toFixed(4)} km²
                          </Tag>
                        )}
                      </Space>
                    </div>

                    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>

                      {/* ── Intersecting: survey features ── */}
                      {surveyInt.length > 0 && (
                        <div>
                          <div style={{ color: '#ff4d4f', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            Intersecting Defence Parcels ({surveyInt.length})
                          </div>
                          <Table size="small" pagination={false} scroll={{ x: true }}
                            dataSource={surveyInt} rowKey="id"
                            style={{ background: 'transparent' }} className="dark-table"
                            columns={[...baseIntCols, ...attrCols(surveyIntKeys)]}
                          />
                        </div>
                      )}

                      {/* ── Intersecting: external layers (each shown with its own configured columns) ── */}
                      {extInt.length > 0 && (
                        <div>
                          <div style={{ color: '#ff4d4f', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            Intersecting External Layers ({extInt.length})
                          </div>
                          <Table size="small" pagination={false} scroll={{ x: true }}
                            dataSource={extInt} rowKey="id"
                            style={{ background: 'transparent' }} className="dark-table"
                            columns={[...baseIntCols, ...attrCols(extIntKeys)]}
                          />
                        </div>
                      )}

                      {/* ── Nearby: survey features ── */}
                      {surveyNear.length > 0 && (
                        <div>
                          <div style={{ color: '#fa8c16', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            Nearby Defence Parcels within {bufLabel} ({surveyNear.length})
                          </div>
                          <Table size="small" pagination={false} scroll={{ x: true }}
                            dataSource={surveyNear} rowKey="id"
                            style={{ background: 'transparent' }} className="dark-table"
                            columns={[...baseNearCols, ...attrCols(surveyNearKeys), distCol]}
                          />
                        </div>
                      )}

                      {/* ── Nearby: external layers (with configured columns) ── */}
                      {extNear.length > 0 && (
                        <div>
                          <div style={{ color: '#fa8c16', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                            Nearby External Layers within {bufLabel} ({extNear.length})
                          </div>
                          <Table size="small" pagination={false} scroll={{ x: true }}
                            dataSource={extNear} rowKey="id"
                            style={{ background: 'transparent' }} className="dark-table"
                            columns={[...baseNearCols, ...attrCols(extNearKeys), distCol]}
                          />
                        </div>
                      )}

                      {result.verdict === 'CLEAR' && (
                        <Alert type="success" showIcon
                          message={`No features found within ${bufLabel}.`}
                          style={{ background: '#1a3a1a', border: '1px solid #52c41a' }} />
                      )}
                    </div>
                  </div>
                )
              })
            }
          </div>
        )}
      </Modal>
    </>
  )
}
