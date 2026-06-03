import React from 'react'
import {
  Button, Drawer, Table, Tag, Tooltip, Space,
  message, Badge, Typography, Alert, Spin, Switch,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  UploadOutlined, EyeOutlined, EyeInvisibleOutlined,
  CloudServerOutlined, LockOutlined, DatabaseOutlined, BgColorsOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import ExternalLayerStyleModal from './ExternalLayerStyleModal'

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

const EXT_GEOM_COLOR: Record<string, string> = {
  POINT: 'blue',
  MULTIPOINT: 'blue',
  LINESTRING: 'cyan',
  MULTILINESTRING: 'cyan',
  POLYGON: 'green',
  MULTIPOLYGON: 'green',
}

interface Props {
  open: boolean
  onClose: () => void
  visibleIds: Set<string>
  onToggleVisible: (extId: string, layer: ExternalLayer) => void
  onHide: (extId: string) => void
  /** Re-apply a layer's style live on the map (no feature reload). */
  onStyleApply?: (extId: string, layer: ExternalLayer) => void
}

const { Text } = Typography

export default function ExternalLayersPanel({
  open,
  onClose,
  visibleIds,
  onToggleVisible,
  onHide,
  onStyleApply,
}: Props) {
  const { t } = useTranslation()
  const { user } = useAppStore()
  const canPersist = user?.role === 'SUPERADMIN'
  const [styleLayer, setStyleLayer] = React.useState<ExternalLayer | null>(null)

  // Fetch only active external layers
  const { data: extLayers = [], isLoading: extLoading } = useQuery<ExternalLayer[]>({
    queryKey: ['ext-layers-active'],
    queryFn: () => api.get('/external/layers/').then(r => r.data.results ?? r.data),
    enabled: open,
  })

  function toggleExtLayer(layer: ExternalLayer) {
    const key = `ext:${layer.id}`
    if (visibleIds.has(key)) {
      onHide(key)
      return
    }
    // The map handles fetching (viewport-based for large layers, full for small).
    onToggleVisible(key, layer)
    message.success(`Showing "${layer.display_name}" on the map`)
  }

  const columns: ColumnsType<ExternalLayer> = [
    {
      title: 'Layer Name',
      dataIndex: 'display_name',
      render: (name, row) => (
        <Space>
          <Tag
            color={EXT_GEOM_COLOR[row.geometry_type] ?? 'default'}
            style={{ fontSize: 10 }}
          >
            {row.geometry_type?.replace('MULTI', 'M-') ?? '?'}
          </Tag>
          <span style={{ color: '#e0e0e0', fontWeight: 500 }}>{name}</span>
        </Space>
      ),
    },
    {
      title: 'Source',
      dataIndex: 'database_name',
      width: 120,
      render: (v) => (
        <Text style={{ color: '#888', fontSize: 12 }} ellipsis>
          {v}
        </Text>
      ),
    },
    {
      title: 'Total Features',
      dataIndex: 'feature_count',
      width: 100,
      align: 'right',
      render: (v) => (
        <Text style={{ color: '#aaa' }}>
          {v != null ? v.toLocaleString() : '—'}
        </Text>
      ),
    },
    {
      title: 'Filter Type',
      width: 120,
      render: (_, row) => {
        const lf = row.level_filter_fields || {}
        const hasFilter = Object.values(lf).some(Boolean)
        return hasFilter ? (
          <Tooltip title="Filtered by your organization level">
            <Tag color="purple" style={{ fontSize: 10 }}>
              <LockOutlined /> Level-based
            </Tag>
          </Tooltip>
        ) : (
          <Tag color="default" style={{ fontSize: 10 }}>
            All Rows
          </Tag>
        )
      },
    },
    {
      title: 'Style',
      width: 70,
      align: 'center',
      render: (_, row) => (
        <Tooltip title="Edit stroke, fill pattern & symbol (QGIS-style)">
          <Button
            size="small"
            type="text"
            icon={<BgColorsOutlined />}
            style={{ color: '#4fc3f7' }}
            onClick={() => setStyleLayer(row)}
          />
        </Tooltip>
      ),
    },
    {
      title: 'Enable',
      width: 70,
      align: 'center',
      render: (_, row) => {
        const key = `ext:${row.id}`
        const visible = visibleIds.has(key)
        return (
          <Tooltip
            title={visible ? 'Click to hide from map' : 'Click to show on map'}
          >
            <Switch
              checked={visible}
              onChange={() => toggleExtLayer(row)}
            />
          </Tooltip>
        )
      },
    },
  ]

  return (
    <>
      <Drawer
        title={
          <Space>
            <CloudServerOutlined />
            <span>Layers & Tools</span>
            <Badge
              count={extLayers.length}
              style={{ backgroundColor: '#1890ff' }}
            />
          </Space>
        }
        placement="left"
        width={900}
        open={open}
        onClose={onClose}
        styles={{
          body: { padding: 12, background: '#1a1a1a' },
          header: {
            background: '#1a1a1a',
            borderBottom: '1px solid #333',
            color: '#e0e0e0',
          },
        }}
      >
        <Alert
          type="info"
          showIcon
          icon={<DatabaseOutlined />}
          message="External Data Layers (Read-Only)"
          description="These layers are maintained in the external database. Geometry data is fetched live and filtered based on your access level. Only Enable/Disable controls are available."
          style={{ marginBottom: 16 }}
        />

        {extLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <div style={{ color: '#aaa', marginTop: 12 }}>
              Loading external layers…
            </div>
          </div>
        ) : extLayers.length === 0 ? (
          <Alert
            type="warning"
            showIcon
            message="No External Layers"
            description="No active external layers are configured. Contact administrator to add external data sources."
            style={{ marginTop: 8 }}
          />
        ) : (
          <Table
            dataSource={extLayers}
            rowKey="id"
            columns={columns}
            size="small"
            pagination={{ pageSize: 50, hideOnSinglePage: true }}
            style={{ background: 'transparent' }}
            className="dark-table"
            rowClassName={(row) => {
              const key = `ext:${row.id}`
              return visibleIds.has(key) ? 'ext-layer-visible-row' : ''
            }}
          />
        )}
      </Drawer>

      <ExternalLayerStyleModal
        open={!!styleLayer}
        layer={styleLayer}
        canPersist={canPersist}
        onApply={(updated) => onStyleApply?.(`ext:${updated.id}`, updated as ExternalLayer)}
        onClose={() => setStyleLayer(null)}
      />
    </>
  )
}
