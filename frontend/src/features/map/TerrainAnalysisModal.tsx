import React, { useState } from 'react'
import { Button, Select as AntSelect, Space, InputNumber, message, Divider, Tag } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'
import api from '@/services/api'
import DraggableModal from '@/components/DraggableModal'
import type { GeoTiffLayer } from '@/types'

interface TerrainAnalysisModalProps {
  open: boolean
  onClose: () => void
  projectId: number
  geotiffs: GeoTiffLayer[]
  onLayerAdded: (result: any) => void
}

const OPERATIONS = [
  { value: 'hillshade', label: 'Hillshade', description: 'Shaded relief from DEM using sunlight angle' },
  { value: 'slope', label: 'Slope', description: 'Slope angle in degrees' },
  { value: 'aspect', label: 'Aspect', description: 'Direction of slope (north-facing, etc.)' },
  { value: 'contour', label: 'Contours', description: 'Elevation contour lines (vector output)' },
]

export default function TerrainAnalysisModal({ open, onClose, projectId, geotiffs, onLayerAdded }: TerrainAnalysisModalProps) {
  const [selectedGeotiff, setSelectedGeotiff] = useState<number | undefined>()
  const [operation, setOperation] = useState('hillshade')
  const [zFactor, setZFactor] = useState(1.0)
  const [contourInterval, setContourInterval] = useState(10)
  const [loading, setLoading] = useState(false)
  const [lastResult, setLastResult] = useState<string | null>(null)

  const isDEMNeeded = true // all operations need a DEM
  const opInfo = OPERATIONS.find(o => o.value === operation)

  async function runAnalysis() {
    if (!selectedGeotiff) { message.warning('Select a DEM layer'); return }
    setLoading(true)
    setLastResult(null)
    try {
      const r = await api.post(`/projects/geotiffs/${selectedGeotiff}/terrain-analysis/`, {
        operation,
        z_factor: zFactor,
        contour_interval: contourInterval,
      })
      const data = r.data
      setLastResult(`Done: ${operation}${data.layer_name ? ` → ${data.layer_name}` : ''}`)
      onLayerAdded(data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DraggableModal
      title="Terrain Analysis (GDAL DEM)"
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {geotiffs.length === 0 ? (
          <div style={{ color: '#faad14', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
            No GeoTiff layers found for this project.<br />
            Upload a DEM raster first.
          </div>
        ) : (
          <>
            <div>
              <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>DEM Layer</div>
              <AntSelect
                style={{ width: '100%' }}
                value={selectedGeotiff}
                onChange={setSelectedGeotiff}
                placeholder="Select DEM layer"
                options={geotiffs.map(g => ({ value: g.id, label: g.name }))}
              />
            </div>

            <div>
              <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Operation</div>
              <AntSelect
                style={{ width: '100%' }}
                value={operation}
                onChange={setOperation}
                options={OPERATIONS.map(o => ({ value: o.value, label: o.label }))}
              />
              {opInfo && (
                <div style={{ fontSize: 10, color: '#666', marginTop: 3 }}>{opInfo.description}</div>
              )}
            </div>

            {operation === 'hillshade' && (
              <div>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Z Factor (vertical exaggeration)</div>
                <InputNumber
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={zFactor}
                  onChange={v => setZFactor(v ?? 1.0)}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>
                  Default 1.0 — use 2–3 for exaggerated relief in flat terrain
                </div>
              </div>
            )}

            {operation === 'contour' && (
              <div>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Contour Interval (metres)</div>
                <InputNumber
                  min={1}
                  max={1000}
                  value={contourInterval}
                  onChange={v => setContourInterval(v ?? 10)}
                  style={{ width: '100%' }}
                />
              </div>
            )}

            {lastResult && (
              <div style={{ fontSize: 11, color: '#52c41a', padding: '6px 10px', background: 'rgba(82,196,26,0.1)', borderRadius: 4 }}>
                ✓ {lastResult}
              </div>
            )}

            <div style={{ fontSize: 10, color: '#555' }}>
              {operation === 'contour'
                ? 'Contours are added as a vector layer on the map.'
                : `${opInfo?.label} will be saved as a new GeoTiff layer and added to the map as a WebGL raster.`}
            </div>

            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={loading}
              onClick={runAnalysis}
              style={{ width: '100%' }}
            >
              Run {opInfo?.label} Analysis
            </Button>
          </>
        )}
      </Space>
    </DraggableModal>
  )
}
