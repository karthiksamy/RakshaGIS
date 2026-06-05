import React, { useState, useRef, useCallback } from 'react'
import { Button, Input, Space, Upload, message, Steps, InputNumber, Table, Tag, Select as AntSelect } from 'antd'
import { UploadOutlined, PlusOutlined, DeleteOutlined, CheckCircleOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd/es/upload'
import api from '@/services/api'
import DraggableModal from '@/components/DraggableModal'

interface GeoreferencerModalProps {
  open: boolean
  onClose: () => void
  projectId: number
  surveyAreas: any[]
  onSaved: () => void
}

interface GCP {
  id: string
  px: number | null
  py: number | null
  lon: number | null
  lat: number | null
}

export default function GeoreferencerModal({ open, onClose, projectId, surveyAreas, onSaved }: GeoreferencerModalProps) {
  const [step, setStep] = useState(0)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [layerName, setLayerName] = useState('georeferenced_scan')
  const [gcps, setGcps] = useState<GCP[]>([
    { id: '1', px: null, py: null, lon: null, lat: null },
    { id: '2', px: null, py: null, lon: null, lat: null },
    { id: '3', px: null, py: null, lon: null, lat: null },
  ])
  const [loading, setLoading] = useState(false)
  const [warpResult, setWarpResult] = useState<{ id: number; layer_name: string; cog_url: string } | null>(null)
  const [selectedArea, setSelectedArea] = useState<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [clickTarget, setClickTarget] = useState<string | null>(null)

  function handleImageUpload(file: File) {
    setImageFile(file)
    const url = URL.createObjectURL(file)
    setImageUrl(url)
    // Load image for canvas display
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      drawCanvas(img, [])
    }
    img.src = url
    return false
  }

  function drawCanvas(img: HTMLImageElement, gcpList: GCP[]) {
    const canvas = canvasRef.current
    if (!canvas) return
    const scale = Math.min(500 / img.width, 340 / img.height, 1)
    canvas.width = img.width * scale
    canvas.height = img.height * scale
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // Draw GCP points
    gcpList.forEach((gcp, i) => {
      if (gcp.px != null && gcp.py != null) {
        const cx = (gcp.px / img.width) * canvas.width
        const cy = (gcp.py / img.height) * canvas.height
        ctx.beginPath()
        ctx.arc(cx, cy, 6, 0, Math.PI * 2)
        ctx.fillStyle = '#ff4444'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = '12px monospace'
        ctx.fillText(String(i + 1), cx + 8, cy - 4)
      }
    })
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!clickTarget || !canvasRef.current || !imgRef.current) return
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const img = imgRef.current
    const px = Math.round((cx / canvas.width) * img.width)
    const py = Math.round((cy / canvas.height) * img.height)
    setGcps(prev => {
      const updated = prev.map(g => g.id === clickTarget ? { ...g, px, py } : g)
      if (imgRef.current) drawCanvas(imgRef.current, updated)
      return updated
    })
    setClickTarget(null)
  }

  function addGCP() {
    setGcps(prev => [...prev, { id: String(Date.now()), px: null, py: null, lon: null, lat: null }])
  }

  function removeGCP(id: string) {
    setGcps(prev => {
      const updated = prev.filter(g => g.id !== id)
      if (imgRef.current) drawCanvas(imgRef.current, updated)
      return updated
    })
  }

  function updateGCP(id: string, field: keyof GCP, value: number | null) {
    setGcps(prev => {
      const updated = prev.map(g => g.id === id ? { ...g, [field]: value } : g)
      if (field === 'px' || field === 'py') {
        if (imgRef.current) drawCanvas(imgRef.current, updated)
      }
      return updated
    })
  }

  async function handleWarp() {
    const validGcps = gcps.filter(g => g.px != null && g.py != null && g.lon != null && g.lat != null)
    if (validGcps.length < 3) {
      message.warning('At least 3 complete GCP pairs are required')
      return
    }
    if (!imageFile) { message.warning('No image uploaded'); return }
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('image', imageFile)
      formData.append('gcps', JSON.stringify(validGcps.map(g => ({ px: g.px, py: g.py, lon: g.lon, lat: g.lat }))))
      formData.append('project', String(projectId))
      formData.append('layer_name', layerName || 'georeferenced_scan')
      const r = await api.post('/projects/georeference/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setWarpResult(r.data)
      setStep(2)
      message.success('Image warped successfully!')
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Warping failed')
    } finally {
      setLoading(false)
    }
  }

  function handleSave() {
    onSaved()
    message.success('Georeferenced layer saved to project')
    // Reset state
    setStep(0)
    setImageFile(null)
    setImageUrl(null)
    setGcps([
      { id: '1', px: null, py: null, lon: null, lat: null },
      { id: '2', px: null, py: null, lon: null, lat: null },
      { id: '3', px: null, py: null, lon: null, lat: null },
    ])
    setWarpResult(null)
  }

  const inputStyle = { background: '#0d1a2a', borderColor: '#1a3050', color: '#ccc' }
  const validGcpCount = gcps.filter(g => g.px != null && g.py != null && g.lon != null && g.lat != null).length

  return (
    <DraggableModal
      title="Georeferencer — Warp Scanned Image"
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 20 }}
        items={[
          { title: 'Upload Image' },
          { title: 'Control Points' },
          { title: 'Save' },
        ]}
      />

      {/* Step 1: Upload */}
      {step === 0 && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ fontSize: 12, color: '#aaa' }}>
            Upload a scanned map image (JPG, PNG, or TIFF) to georeference.
          </div>
          <Upload
            accept=".jpg,.jpeg,.png,.tif,.tiff"
            showUploadList={false}
            beforeUpload={handleImageUpload}
          >
            <Button icon={<UploadOutlined />}>Select Image File</Button>
          </Upload>
          {imageUrl && (
            <div>
              <img src={imageUrl} alt="preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 4, border: '1px solid #1a3050' }} />
              <div style={{ fontSize: 11, color: '#52c41a', marginTop: 4 }}>✓ Image loaded: {imageFile?.name}</div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Layer Name</div>
            <Input
              value={layerName}
              onChange={e => setLayerName(e.target.value)}
              placeholder="Name for the georeferenced layer"
              style={inputStyle}
            />
          </div>
          <Button
            type="primary"
            disabled={!imageFile}
            onClick={() => setStep(1)}
          >
            Next — Add Control Points
          </Button>
        </Space>
      )}

      {/* Step 2: Control Points */}
      {step === 1 && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ fontSize: 11, color: '#aaa' }}>
            For each GCP: click "Pick" to click on the image canvas to set pixel coordinates,
            then type the corresponding map longitude and latitude.
            Minimum 3 GCP pairs required.
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {/* Canvas */}
            <div style={{ flex: '0 0 auto' }}>
              <div style={{ fontSize: 10, color: '#4fc3f7', marginBottom: 4 }}>
                {clickTarget ? `Click on image to mark GCP ${gcps.findIndex(g => g.id === clickTarget) + 1}...` : 'Image Preview'}
              </div>
              <canvas
                ref={canvasRef}
                onClick={handleCanvasClick}
                style={{
                  display: 'block',
                  border: `2px solid ${clickTarget ? '#ff4444' : '#1a3050'}`,
                  borderRadius: 4,
                  cursor: clickTarget ? 'crosshair' : 'default',
                  maxWidth: 320,
                  maxHeight: 250,
                }}
              />
            </div>
            {/* GCP Table */}
            <div style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
              <div style={{ fontSize: 10, color: '#4fc3f7', marginBottom: 4 }}>Ground Control Points</div>
              {gcps.map((gcp, i) => (
                <div key={gcp.id} style={{
                  display: 'grid', gridTemplateColumns: '20px 60px 60px 80px 80px 24px',
                  gap: 4, alignItems: 'center', marginBottom: 4, fontSize: 11,
                }}>
                  <span style={{ color: '#aaa' }}>{i + 1}</span>
                  <InputNumber
                    size="small"
                    style={{ width: '100%' }}
                    value={gcp.px}
                    placeholder="Px X"
                    onChange={v => updateGCP(gcp.id, 'px', v)}
                  />
                  <InputNumber
                    size="small"
                    style={{ width: '100%' }}
                    value={gcp.py}
                    placeholder="Px Y"
                    onChange={v => updateGCP(gcp.id, 'py', v)}
                  />
                  <InputNumber
                    size="small"
                    style={{ width: '100%' }}
                    value={gcp.lon}
                    placeholder="Lon"
                    step={0.0001}
                    onChange={v => updateGCP(gcp.id, 'lon', v)}
                  />
                  <InputNumber
                    size="small"
                    style={{ width: '100%' }}
                    value={gcp.lat}
                    placeholder="Lat"
                    step={0.0001}
                    onChange={v => updateGCP(gcp.id, 'lat', v)}
                  />
                  <Button
                    size="small"
                    type={clickTarget === gcp.id ? 'primary' : 'default'}
                    style={{ fontSize: 10, padding: '0 4px' }}
                    onClick={() => setClickTarget(clickTarget === gcp.id ? null : gcp.id)}
                    title="Click to pick pixel coordinates from image"
                  >Pick</Button>
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '20px 60px 60px 80px 80px 24px', gap: 4, fontSize: 10, color: '#555', marginBottom: 6 }}>
                <span>#</span><span>Pixel X</span><span>Pixel Y</span><span>Lon</span><span>Lat</span><span></span>
              </div>
              <Button size="small" icon={<PlusOutlined />} onClick={addGCP} style={{ fontSize: 11 }}>Add GCP</Button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: validGcpCount >= 3 ? '#52c41a' : '#faad14' }}>
            {validGcpCount} / {gcps.length} GCPs complete {validGcpCount < 3 && '(need at least 3)'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button
              type="primary"
              loading={loading}
              disabled={validGcpCount < 3}
              onClick={handleWarp}
            >
              Warp Image
            </Button>
          </div>
        </Space>
      )}

      {/* Step 3: Save */}
      {step === 2 && warpResult && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ fontSize: 13, color: '#52c41a', fontWeight: 600 }}>
            <CheckCircleOutlined /> Warping Successful!
          </div>
          <div style={{ background: '#0d1a2a', border: '1px solid #1a3050', borderRadius: 6, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#aaa' }}>Layer: <span style={{ color: '#4fc3f7' }}>{warpResult.layer_name}</span></div>
            <div style={{ fontSize: 11, color: '#aaa' }}>COG URL: <span style={{ color: '#666' }}>{warpResult.cog_url}</span></div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Associate with Survey Area (optional)</div>
            <AntSelect
              style={{ width: '100%' }}
              allowClear
              value={selectedArea || undefined}
              onChange={v => setSelectedArea(v ?? null)}
              placeholder="Select survey area..."
              options={surveyAreas.map((a: any) => ({ value: a.id, label: a.name }))}
            />
          </div>
          <div style={{ fontSize: 11, color: '#555' }}>
            The georeferenced raster has been saved and will appear in the GeoTiff layers panel.
          </div>
          <Button type="primary" onClick={handleSave}>
            Done — Add to Map
          </Button>
        </Space>
      )}
    </DraggableModal>
  )
}
