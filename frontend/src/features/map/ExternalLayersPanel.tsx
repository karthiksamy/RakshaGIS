import React, { useState } from 'react'
import {
  Button, Drawer, Table, Tag, Tooltip, Space, Tabs,
  message, Badge, Typography, Alert, Spin, Switch,
  Modal, Form, Input, InputNumber, Select as AntSelect,
  Slider, Row, Col, Progress,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudServerOutlined, DatabaseOutlined, BgColorsOutlined,
  LockOutlined, PlusOutlined, CheckCircleOutlined,
  CloseCircleOutlined, QuestionCircleOutlined, GlobalOutlined,
  ThunderboltOutlined, ApiOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import ExternalLayerStyleModal from './ExternalLayerStyleModal'

// ── Type definitions ──────────────────────────────────────────────────────────

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
  classification_field?: string
  classification_colors?: Record<string, { color: string; opacity?: number }>
  style?: Record<string, unknown>
  min_zoom?: number
  bbox?: number[] | null
}

interface GISServerLayer {
  id: number
  display_name: string
  connection_name: string
  server_type: string
  protocol: string
  protocol_display: string
  layer_name: string
  description: string
  geometry_type: string
  feature_count: number | null
  is_active: boolean
  is_vector: boolean
  is_tile: boolean
  opacity: number
  classification_field?: string
  classification_colors?: Record<string, { color: string; opacity?: number }>
  style?: Record<string, unknown>
  min_zoom?: number
  bbox?: number[] | null
  organisation: number | null
  organisation_name: string | null
  // tile config (from server)
  wms_version?: string
  wms_format?: string
  wms_params?: Record<string, unknown>
}

interface GISServerConnection {
  id: number
  name: string
  server_type: string
  server_type_display: string
  base_url: string
  auth_type: string
  is_active: boolean
  test_status: string
  test_message: string
  layer_count: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EXT_GEOM_COLOR: Record<string, string> = {
  POINT: 'blue', MULTIPOINT: 'blue',
  LINESTRING: 'cyan', MULTILINESTRING: 'cyan',
  POLYGON: 'green', MULTIPOLYGON: 'green',
}

const PROTOCOL_COLOR: Record<string, string> = {
  WMS: 'orange', WMTS: 'orange', ARCGIS_MAP: 'orange',
  WFS: 'green', ARCGIS_FEATURE: 'green', XYZ: 'blue',
}

const SERVER_TYPE_ICON: Record<string, React.ReactNode> = {
  GEOSERVER: <GlobalOutlined />,
  ARCGIS: <ThunderboltOutlined />,
  MAPSERVER: <ApiOutlined />,
  QGIS: <GlobalOutlined />,
  GENERIC: <CloudServerOutlined />,
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  // External DB layers
  visibleIds: Set<string>
  onToggleVisible: (extId: string, layer: ExternalLayer) => void
  onHide: (extId: string) => void
  onStyleApply?: (extId: string, layer: ExternalLayer) => void
  // GIS Server layers
  gsrvVisibleIds: Set<string>
  onToggleGsrv: (key: string, layer: GISServerLayer) => void
  onHideGsrv: (key: string) => void
  onGsrvStyleApply?: (key: string, layer: GISServerLayer) => void
  onGsrvOpacity?: (key: string, opacity: number) => void
}

const { Text } = Typography

// ── Main component ────────────────────────────────────────────────────────────

export default function ExternalLayersPanel({
  open, onClose,
  visibleIds, onToggleVisible, onHide, onStyleApply,
  gsrvVisibleIds, onToggleGsrv, onHideGsrv, onGsrvStyleApply, onGsrvOpacity,
}: Props) {
  const { user } = useAppStore()
  const qc = useQueryClient()
  const canAdmin = !!user            // any authenticated user can add GIS server layers
  const isSuperAdmin = user?.role === 'SUPERADMIN'

  // Style modals
  const [styleLayer,    setStyleLayer]    = useState<ExternalLayer | null>(null)
  const [gsrvStyleLayer, setGsrvStyleLayer] = useState<GISServerLayer | null>(null)

  // GIS server add modal state
  const [addServerOpen, setAddServerOpen] = useState(false)
  const [addLayerOpen,  setAddLayerOpen]  = useState(false)
  const [selectedServer, setSelectedServer] = useState<GISServerConnection | null>(null)
  const [capabilities, setCapabilities]   = useState<any[]>([])
  const [capLoading,   setCapLoading]     = useState(false)
  const [serverForm]  = Form.useForm()
  const [layerForm]   = Form.useForm()

  // ── Data queries ──────────────────────────────────────────────────────────

  const { data: extLayers = [], isLoading: extLoading } = useQuery<ExternalLayer[]>({
    queryKey: ['ext-layers-active'],
    queryFn: () => api.get('/external/layers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })

  const { data: gisServers = [], isLoading: serversLoading } = useQuery<GISServerConnection[]>({
    queryKey: ['gis-servers'],
    queryFn: () => api.get('/external/gis-servers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })

  const { data: gsrvLayers = [], isLoading: gsrvLoading } = useQuery<GISServerLayer[]>({
    queryKey: ['gis-server-layers'],
    queryFn: () => api.get('/external/gis-server-layers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })

  // ── Handlers ──────────────────────────────────────────────────────────────

  function toggleExtLayer(layer: ExternalLayer) {
    const key = `ext:${layer.id}`
    if (visibleIds.has(key)) { onHide(key); return }
    onToggleVisible(key, layer)
    message.success(`Showing "${layer.display_name}" on the map`)
  }

  function toggleGsrvLayer(layer: GISServerLayer) {
    const prefix = layer.is_tile ? 'wms' : 'gsrv'
    const key = `${prefix}:${layer.id}`
    if (gsrvVisibleIds.has(key)) { onHideGsrv(key); return }
    onToggleGsrv(key, layer)
    message.success(`Showing "${layer.display_name}" on the map`)
  }

  async function loadCapabilities(server: GISServerConnection) {
    setSelectedServer(server)
    setCapLoading(true)
    setCapabilities([])
    try {
      const r = await api.get(`/external/gis-servers/${server.id}/capabilities/`)
      setCapabilities(r.data.layers ?? [])
    } catch {
      message.error('Could not load server capabilities')
    } finally {
      setCapLoading(false)
    }
  }

  async function testServer(server: GISServerConnection) {
    try {
      const r = await api.post(`/external/gis-servers/${server.id}/test/`)
      if (r.data.ok) message.success(r.data.message)
      else message.error(r.data.message)
      qc.invalidateQueries({ queryKey: ['gis-servers'] })
    } catch {
      message.error('Test failed')
    }
  }

  async function saveServer(values: any) {
    try {
      await api.post('/external/gis-servers/', values)
      message.success('GIS server added')
      qc.invalidateQueries({ queryKey: ['gis-servers'] })
      setAddServerOpen(false)
      serverForm.resetFields()
    } catch (e: any) {
      message.error(e.response?.data?.detail ?? 'Save failed')
    }
  }

  async function saveLayer(values: any) {
    try {
      await api.post('/external/gis-server-layers/', values)
      message.success('Layer added')
      qc.invalidateQueries({ queryKey: ['gis-server-layers'] })
      setAddLayerOpen(false)
      layerForm.resetFields()
    } catch (e: any) {
      message.error(e.response?.data?.detail ?? 'Save failed')
    }
  }

  // ── External DB layer columns ─────────────────────────────────────────────

  const extColumns: ColumnsType<ExternalLayer> = [
    {
      title: 'Layer Name', dataIndex: 'display_name',
      render: (name, row) => (
        <Space>
          <Tag color={EXT_GEOM_COLOR[row.geometry_type] ?? 'default'} style={{ fontSize: 10 }}>
            {row.geometry_type?.replace('MULTI', 'M-') ?? '?'}
          </Tag>
          <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{name}</span>
        </Space>
      ),
    },
    { title: 'Source', dataIndex: 'database_name', width: 120,
      render: v => <Text style={{ color: '#888', fontSize: 12 }} ellipsis>{v}</Text> },
    { title: 'Features', dataIndex: 'feature_count', width: 80, align: 'right',
      render: v => <Text style={{ color: '#aaa' }}>{v != null ? v.toLocaleString() : '—'}</Text> },
    { title: 'Filter', width: 110,
      render: (_, row) => {
        const hasFilter = Object.values(row.level_filter_fields || {}).some(Boolean)
        return hasFilter
          ? <Tooltip title="Filtered by your organization level"><Tag color="purple" style={{ fontSize: 10 }}><LockOutlined /> Level</Tag></Tooltip>
          : <Tag color="default" style={{ fontSize: 10 }}>All Rows</Tag>
      },
    },
    { title: 'Style', width: 60, align: 'center',
      render: (_, row) => (
        <Button size="small" type="text" icon={<BgColorsOutlined />} style={{ color: '#4fc3f7' }}
          onClick={() => setStyleLayer(row)} />
      ),
    },
    { title: 'Show', width: 60, align: 'center',
      render: (_, row) => {
        const key = `ext:${row.id}`
        return <Switch checked={visibleIds.has(key)} onChange={() => toggleExtLayer(row)} />
      },
    },
  ]

  // ── GIS Server layer columns ──────────────────────────────────────────────

  const gsrvColumns: ColumnsType<GISServerLayer> = [
    {
      title: 'Layer Name', dataIndex: 'display_name',
      render: (name, row) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <Tag color={PROTOCOL_COLOR[row.protocol] ?? 'default'} style={{ fontSize: 10 }}>
              {row.protocol_display?.split(' ')[0] ?? row.protocol}
            </Tag>
            {row.geometry_type && (
              <Tag color={EXT_GEOM_COLOR[row.geometry_type] ?? 'default'} style={{ fontSize: 10 }}>
                {row.geometry_type?.replace('MULTI', 'M-') ?? '?'}
              </Tag>
            )}
          </Space>
          <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{name}</span>
        </Space>
      ),
    },
    { title: 'Server', dataIndex: 'connection_name', width: 130,
      render: (v, row) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <span style={{ color: '#888' }}>{SERVER_TYPE_ICON[row.server_type]}</span>
            <Text style={{ color: '#888', fontSize: 12 }} ellipsis>{v}</Text>
          </Space>
          {row.organisation_name
            ? <Tag color="purple" style={{ fontSize: 9 }}>{row.organisation_name}</Tag>
            : <Tag color="cyan" style={{ fontSize: 9 }}>Global</Tag>
          }
        </Space>
      ),
    },
    { title: 'Features', dataIndex: 'feature_count', width: 80, align: 'right',
      render: (v, row) => row.is_tile
        ? <Tag style={{ fontSize: 9 }}>Tile</Tag>
        : <Text style={{ color: '#aaa' }}>{v != null ? v.toLocaleString() : '—'}</Text>,
    },
    { title: 'Opacity', width: 90,
      render: (_, row) => {
        const prefix = row.is_tile ? 'wms' : 'gsrv'
        const key = `${prefix}:${row.id}`
        const isVisible = gsrvVisibleIds.has(key)
        return isVisible ? (
          <Slider
            min={0} max={1} step={0.05}
            defaultValue={row.opacity ?? 1}
            style={{ width: 70, margin: 0 }}
            onChange={(v) => onGsrvOpacity?.(key, v)}
          />
        ) : <Text style={{ color: '#555', fontSize: 11 }}>—</Text>
      },
    },
    { title: 'Style', width: 60, align: 'center',
      render: (_, row) => row.is_vector ? (
        <Button size="small" type="text" icon={<BgColorsOutlined />} style={{ color: '#4fc3f7' }}
          onClick={() => setGsrvStyleLayer(row)} />
      ) : <Text style={{ color: '#555', fontSize: 11 }}>—</Text>,
    },
    { title: 'Show', width: 60, align: 'center',
      render: (_, row) => {
        const prefix = row.is_tile ? 'wms' : 'gsrv'
        const key = `${prefix}:${row.id}`
        return <Switch checked={gsrvVisibleIds.has(key)} onChange={() => toggleGsrvLayer(row)} />
      },
    },
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  const statusIcon = (s: string) => s === 'OK'
    ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
    : s === 'ERROR'
    ? <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
    : <QuestionCircleOutlined style={{ color: '#888' }} />

  return (
    <>
      <Drawer
        title={
          <Space>
            <CloudServerOutlined />
            <span>Layers & Tools</span>
            <Badge count={extLayers.length + gsrvLayers.length} style={{ backgroundColor: '#1890ff' }} />
          </Space>
        }
        placement="left"
        width={1000}
        open={open}
        onClose={onClose}
        styles={{
          body: { padding: 12, background: '#1a1a1a' },
          header: { background: '#1a1a1a', borderBottom: '1px solid #333', color: '#e0e0e0' },
        }}
      >
        <Tabs
          defaultActiveKey={isSuperAdmin ? 'db' : 'gis'}
          items={[
            {
              key: 'db',
              label: (
                <Space>
                  <DatabaseOutlined />
                  <span>External DB Layers</span>
                  <Badge count={extLayers.length} style={{ backgroundColor: '#1890ff' }} />
                </Space>
              ),
              children: (
                <>
                  <Alert type="info" showIcon icon={<DatabaseOutlined />}
                    message="External Database Layers (Read-Only)"
                    description="Geometry fetched live from the external database, filtered by your access level."
                    style={{ marginBottom: 12 }} />
                  {extLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
                  ) : extLayers.length === 0 ? (
                    <Alert type="warning" showIcon message="No external DB layers configured." />
                  ) : (
                    <Table dataSource={extLayers} rowKey="id" columns={extColumns}
                      size="small" pagination={{ pageSize: 50, hideOnSinglePage: true }}
                      style={{ background: 'transparent' }} className="dark-table"
                      rowClassName={row => visibleIds.has(`ext:${row.id}`) ? 'ext-layer-visible-row' : ''} />
                  )}
                </>
              ),
            },
            {
              key: 'gis',
              label: (
                <Space>
                  <CloudServerOutlined />
                  <span>GIS Servers</span>
                  <Badge count={gsrvLayers.length} style={{ backgroundColor: '#52c41a' }} />
                </Space>
              ),
              children: (
                <>
                  {/* Server list (admin only) */}
                  {canAdmin && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <Text style={{ color: '#aaa', fontSize: 12 }}>
                          Registered GIS Servers
                          {!isSuperAdmin && (
                            <span style={{ color: '#888', fontSize: 11, marginLeft: 6 }}>
                              · Layers you add will be scoped to your organisation
                            </span>
                          )}
                        </Text>
                        <Space>
                          <Button size="small" icon={<PlusOutlined />}
                            onClick={() => setAddLayerOpen(true)}>
                            Add Layer
                          </Button>
                          <Button size="small" type="primary" icon={<PlusOutlined />}
                            onClick={() => setAddServerOpen(true)}>
                            Add Server
                          </Button>
                        </Space>
                      </div>
                      {serversLoading ? <Spin size="small" /> : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {gisServers.map(srv => (
                            <div key={srv.id} style={{
                              background: '#222', border: '1px solid #333', borderRadius: 6,
                              padding: '6px 10px', minWidth: 180,
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ color: '#4fc3f7' }}>{SERVER_TYPE_ICON[srv.server_type]}</span>
                                <Text strong style={{ color: '#e0e0e0', fontSize: 12 }}>{srv.name}</Text>
                                <span style={{ marginLeft: 'auto' }}>{statusIcon(srv.test_status)}</span>
                              </div>
                              <div style={{ fontSize: 10, color: '#666', margin: '3px 0' }}>
                                {srv.server_type_display} · {srv.layer_count} layer{srv.layer_count !== 1 ? 's' : ''}
                              </div>
                              <Space size={4}>
                                <Button size="small" style={{ fontSize: 10 }}
                                  onClick={() => testServer(srv)}>
                                  Test
                                </Button>
                                <Button size="small" icon={<ReloadOutlined style={{ fontSize: 10 }} />}
                                  style={{ fontSize: 10 }} onClick={() => loadCapabilities(srv)}>
                                  Discover
                                </Button>
                              </Space>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Discovered layers from GetCapabilities */}
                      {capLoading && <div style={{ marginTop: 8 }}><Spin size="small" /> <Text style={{ color: '#888', fontSize: 12 }}>Loading capabilities…</Text></div>}
                      {capabilities.length > 0 && selectedServer && (
                        <div style={{ marginTop: 8, background: '#1a2030', border: '1px solid #333', borderRadius: 4, padding: 8, maxHeight: 180, overflowY: 'auto' }}>
                          <Text style={{ color: '#64b5f6', fontSize: 11, fontWeight: 700 }}>
                            Available layers on {selectedServer.name} ({capabilities.length})
                          </Text>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                            {capabilities.map((c, i) => (
                              <Tag key={i} color={PROTOCOL_COLOR[c.protocol] ?? 'default'}
                                style={{ fontSize: 10, cursor: 'pointer' }}
                                onClick={() => {
                                  layerForm.setFieldsValue({
                                    connection: selectedServer.id,
                                    layer_name: c.name,
                                    display_name: c.title || c.name,
                                    protocol: c.protocol,
                                  })
                                  setAddLayerOpen(true)
                                }}>
                                {c.protocol}: {c.title || c.name}
                              </Tag>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* GIS server layer table */}
                  <Alert type="info" showIcon icon={<CloudServerOutlined />}
                    message="GIS Server Layers"
                    description={isSuperAdmin
                      ? 'Global layers (cyan tag) are visible to all users. Org-tagged layers are visible only within that organisation.'
                      : 'Layers tagged with your organisation and global layers are shown here. Layers you add will be visible only to your organisation.'}
                    style={{ marginBottom: 12 }} />
                  {gsrvLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
                  ) : gsrvLayers.length === 0 ? (
                    <Alert type="warning" showIcon message="No GIS server layers configured." />
                  ) : (
                    <Table dataSource={gsrvLayers} rowKey="id" columns={gsrvColumns}
                      size="small" pagination={{ pageSize: 50, hideOnSinglePage: true }}
                      style={{ background: 'transparent' }} className="dark-table"
                      rowClassName={row => {
                        const key = `${row.is_tile ? 'wms' : 'gsrv'}:${row.id}`
                        return gsrvVisibleIds.has(key) ? 'ext-layer-visible-row' : ''
                      }} />
                  )}
                </>
              ),
            },
          ]}
        />
      </Drawer>

      {/* External DB layer style modal */}
      <ExternalLayerStyleModal
        open={!!styleLayer} layer={styleLayer} canPersist={canAdmin}
        onApply={updated => onStyleApply?.(`ext:${updated.id}`, updated as ExternalLayer)}
        onClose={() => setStyleLayer(null)} />

      {/* GIS server layer style modal — same component, adapted */}
      <ExternalLayerStyleModal
        open={!!gsrvStyleLayer} layer={gsrvStyleLayer as any} canPersist={canAdmin}
        onApply={updated => onGsrvStyleApply?.(`gsrv:${updated.id}`, updated as any)}
        onClose={() => setGsrvStyleLayer(null)} />

      {/* Add GIS Server modal */}
      <Modal
        title={<Space><PlusOutlined /><span>Add GIS Server Connection</span></Space>}
        open={addServerOpen}
        onCancel={() => { setAddServerOpen(false); serverForm.resetFields() }}
        onOk={() => serverForm.submit()}
        okText="Add Server"
        width={520}
      >
        <Form form={serverForm} layout="vertical" onFinish={saveServer}>
          <Form.Item name="name" label="Friendly Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. DGDE GeoServer" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="server_type" label="Server Type" initialValue="GENERIC">
                <AntSelect options={[
                  { value: 'GEOSERVER', label: 'GeoServer' },
                  { value: 'ARCGIS',    label: 'ArcGIS REST' },
                  { value: 'MAPSERVER', label: 'MapServer' },
                  { value: 'QGIS',      label: 'QGIS Server' },
                  { value: 'GENERIC',   label: 'Generic OGC' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="auth_type" label="Authentication" initialValue="NONE">
                <AntSelect options={[
                  { value: 'NONE',  label: 'None' },
                  { value: 'BASIC', label: 'Basic Auth' },
                  { value: 'TOKEN', label: 'Token / API Key' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true }]}>
            <Input placeholder="https://gis.example.com/geoserver/ows" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="username" label="Username">
                <Input autoComplete="off" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="password" label="Password">
                <Input.Password autoComplete="off" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="token" label="API Token / Bearer Token">
            <Input.Password />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Add GIS Server Layer modal */}
      <Modal
        title={<Space><PlusOutlined /><span>Add GIS Server Layer</span></Space>}
        open={addLayerOpen}
        onCancel={() => { setAddLayerOpen(false); layerForm.resetFields() }}
        onOk={() => layerForm.submit()}
        okText="Add Layer"
        width={560}
      >
        <Form form={layerForm} layout="vertical" onFinish={saveLayer}>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item name="connection" label="GIS Server" rules={[{ required: true }]}>
                <AntSelect
                  options={gisServers.map(s => ({ value: s.id, label: s.name }))}
                  placeholder="Select server"
                />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="protocol" label="Protocol" rules={[{ required: true }]}>
                <AntSelect options={[
                  { value: 'WMS',            label: 'WMS (raster)' },
                  { value: 'WFS',            label: 'WFS (vector)' },
                  { value: 'WMTS',           label: 'WMTS (tiled)' },
                  { value: 'ARCGIS_FEATURE', label: 'ArcGIS Feature' },
                  { value: 'ARCGIS_MAP',     label: 'ArcGIS Map' },
                  { value: 'XYZ',            label: 'XYZ Tiles' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="layer_name" label="Layer Name / ID" rules={[{ required: true }]}
            help="WMS/WFS type name, ArcGIS layer path (e.g. MyService/FeatureServer/0), or XYZ URL template">
            <Input placeholder="e.g. dgde:glr_plan  or  0  or  https://tileserver/{z}/{x}/{y}.png" />
          </Form.Item>
          <Form.Item name="display_name" label="Display Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="min_zoom" label="Min Zoom" initialValue={5}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="wms_version" label="WMS Version" initialValue="1.1.1">
                <AntSelect options={[{ value: '1.1.1', label: '1.1.1' }, { value: '1.3.0', label: '1.3.0' }]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="wms_format" label="WMS Format" initialValue="image/png">
                <AntSelect options={[
                  { value: 'image/png', label: 'PNG' },
                  { value: 'image/jpeg', label: 'JPEG' },
                  { value: 'image/png8', label: 'PNG8' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
