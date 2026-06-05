import { useState, useMemo } from 'react'
import { Modal, Select, Input, InputNumber, Space, Button, Radio, Divider, message, Progress, Tag } from 'antd'
import { BookOutlined, DownloadOutlined } from '@ant-design/icons'
import api from '@/services/api'
import type { GISFeature } from '@/types'

interface Props {
  open: boolean
  onClose: () => void
  projectId: number | null
  features: GISFeature[]   // all loaded project features (for layer list + field discovery)
}

export default function MapAtlasModal({ open, onClose, projectId, features }: Props) {
  const [layerName, setLayerName] = useState<string | undefined>(undefined)
  const [titleField, setTitleField] = useState<string | undefined>(undefined)
  const [padding, setPadding] = useState(0.002)
  const [width, setWidth] = useState(1200)
  const [height, setHeight] = useState(800)
  const [dpi, setDpi] = useState(150)
  const [loading, setLoading] = useState(false)
  const [pageCount, setPageCount] = useState<number | null>(null)

  const layerNames = useMemo(
    () => [...new Set(features.map(f => f.layer_name))].filter(Boolean),
    [features]
  )

  const attrKeys = useMemo(() => {
    if (!layerName) return []
    const keys = new Set<string>()
    features
      .filter(f => f.layer_name === layerName)
      .forEach(f => Object.keys(f.attributes ?? {}).forEach(k => keys.add(k)))
    return [...keys]
  }, [layerName, features])

  const featureCount = useMemo(
    () => features.filter(f => f.layer_name === layerName).length,
    [layerName, features]
  )

  async function generate() {
    if (!projectId || !layerName) { message.warning('Select a layer first'); return }
    setLoading(true)
    setPageCount(null)
    try {
      const resp = await api.post(
        '/projects/features/atlas/',
        { project: projectId, layer_name: layerName, title_field: titleField ?? '', padding, width, height, dpi },
        { responseType: 'blob' },
      )
      const blob = new Blob([resp.data], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), {
        href: url,
        download: `${layerName}_atlas.pdf`,
      })
      a.click()
      URL.revokeObjectURL(url)
      setPageCount(featureCount)
      message.success(`Atlas generated — ${featureCount} page(s) downloaded`)
      onClose()
    } catch (err: any) {
      const detail = err?.response?.data
        ? await new Response(err.response.data).json().then((j: any) => j.detail).catch(() => 'Failed')
        : 'Atlas generation failed'
      message.error(detail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={<><BookOutlined style={{ marginRight: 8, color: '#a5d6a7' }} />Map Atlas — Print Series</>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      styles={{ body: { background: '#0e0e1e' } }}
    >
      <Space direction="vertical" style={{ width: '100%', marginTop: 10 }} size={12}>
        {/* Layer selector */}
        <div>
          <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>
            Layer to iterate <span style={{ color: '#666' }}>(one PDF page per feature)</span>
          </div>
          <Select
            style={{ width: '100%' }}
            placeholder="Select layer…"
            value={layerName}
            onChange={v => { setLayerName(v); setTitleField(undefined) }}
            options={layerNames.map(n => ({ value: n, label: n }))}
          />
          {layerName && (
            <div style={{ color: '#666', fontSize: 11, marginTop: 4 }}>
              {featureCount} features → {featureCount} pages
            </div>
          )}
        </div>

        {/* Title field */}
        <div>
          <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>
            Page title attribute <span style={{ color: '#666' }}>(optional)</span>
          </div>
          <Select
            style={{ width: '100%' }}
            allowClear
            placeholder="Use feature ID if blank"
            value={titleField}
            onChange={v => setTitleField(v)}
            options={attrKeys.map(k => ({ value: k, label: k }))}
          />
        </div>

        {/* Page settings */}
        <Divider style={{ margin: '4px 0', borderColor: '#1a2a3a' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 4 }}>Width (px)</div>
            <InputNumber min={400} max={4000} step={100} value={width} onChange={v => setWidth(v ?? 1200)} style={{ width: '100%' }} size="small" />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 4 }}>Height (px)</div>
            <InputNumber min={300} max={3000} step={100} value={height} onChange={v => setHeight(v ?? 800)} style={{ width: '100%' }} size="small" />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 4 }}>DPI</div>
            <Select size="small" value={dpi} onChange={setDpi} style={{ width: '100%' }}
              options={[{ value: 96, label: '96 (screen)' }, { value: 150, label: '150 (draft)' }, { value: 200, label: '200 (print)' }, { value: 300, label: '300 (high-res)' }]} />
          </div>
        </div>

        <div>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 4 }}>Map padding (degrees)</div>
          <InputNumber min={0} max={1} step={0.001} value={padding} onChange={v => setPadding(v ?? 0.002)}
            style={{ width: '100%' }} size="small" />
          <div style={{ color: '#555', fontSize: 10, marginTop: 3 }}>
            Extra space around each feature's bounding box (0.001° ≈ 100 m)
          </div>
        </div>

        <Divider style={{ margin: '2px 0', borderColor: '#1a2a3a' }} />

        {/* What each page contains */}
        <div style={{ background: '#0a1820', borderRadius: 4, padding: '8px 12px', fontSize: 11, color: '#666' }}>
          Each page: <Tag color="blue" style={{ fontSize: 10 }}>Mapnik map render</Tag>
          <Tag color="geekblue" style={{ fontSize: 10 }}>Title bar</Tag>
          <Tag style={{ fontSize: 10 }}>Feature ID + eNLI code</Tag>
        </div>

        <Button
          type="primary"
          block
          icon={<DownloadOutlined />}
          loading={loading}
          disabled={!layerName}
          onClick={generate}
          style={{ background: '#1a5c30' }}
        >
          {loading ? `Rendering ${featureCount} pages…` : `Generate Atlas PDF (${featureCount} page${featureCount !== 1 ? 's' : ''})`}
        </Button>
      </Space>
    </Modal>
  )
}
