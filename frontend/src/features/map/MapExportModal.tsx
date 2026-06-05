import { Modal, Button, Form, Radio, message, Spin, Alert } from 'antd'
import { DownloadOutlined, FileImageOutlined } from '@ant-design/icons'
import { useState, useMemo } from 'react'
import type OLMap from 'ol/Map'

import api from '@/services/api'

function downloadBlob(data: BlobPart, filename: string, type: string) {
  const url = window.URL.createObjectURL(new Blob([data], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

/**
 * Attach tile-load listeners on all layer sources and return a Promise that
 * resolves when all in-flight tile requests finish (or when the hard timeout fires).
 *
 * IMPORTANT: call this BEFORE triggering any map render so that tileloadstart
 * events fired synchronously during renderSync() are captured.
 */
function waitForTilesLoaded(map: OLMap, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve) => {
    let pending = 0
    let settled = false
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const done = (extraMs = 200) => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      if (idleTimer) clearTimeout(idleTimer)
      setTimeout(resolve, extraMs)
    }

    const onStart  = () => {
      pending++
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    }
    const onFinish = () => {
      pending = Math.max(0, pending - 1)
      if (pending === 0) {
        // Wait a bit longer to let the browser composite the last tile before resolving
        idleTimer = setTimeout(() => done(300), 400)
      }
    }

    // Attach per-source listeners (including sublayers from nested groups)
    const attachListeners = (layer: any) => {
      const source = layer.getSource?.()
      if (source && typeof source.on === 'function') {
        source.on('tileloadstart',  onStart)
        source.on('tileloadend',    onFinish)
        source.on('tileloaderror',  onFinish)
      }
      // Handle layer groups
      if (typeof layer.getLayers === 'function') {
        layer.getLayers().forEach(attachListeners)
      }
    }
    map.getLayers().forEach(attachListeners)

    // Hard timeout — never block forever
    hardTimer = setTimeout(() => done(0), timeoutMs)

    // If no tiles start loading within 800 ms the viewport must be fully cached —
    // resolve after the same idle delay used above
    idleTimer = setTimeout(() => done(300), 800)
  })
}

interface MapExportModalProps {
  visible: boolean
  onClose: () => void
  mapInstance: OLMap | null
  mapState: {
    center?: [number, number]
    zoom?: number
  }
  legend?: { name: string; color: string; type?: 'vector' | 'raster' }[]
  selectedCount?: number
  selectLayer?: React.RefObject<any>
}

export default function MapExportModal({
  visible, onClose, mapInstance, legend,
  selectedCount: selectedCountProp = 0, selectLayer,
}: MapExportModalProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const selectedCount = selectedCountProp

  const selectedLayers = useMemo(() => {
    if (!visible) return []
    let feats: any[] = []
    if (selectLayer?.current) {
      feats = selectLayer.current.getSource?.()?.getFeatures?.() ?? []
    } else if (mapInstance) {
      const layers = mapInstance.getLayers().getArray()
      const selLyr = layers.find((l: any) => l.getZIndex?.() === 11) as any
      feats = selLyr?.getSource?.()?.getFeatures?.() ?? []
    }
    return Array.from(new Set(feats.map((f: any) => f.get('layer_name')).filter(Boolean))) as string[]
  }, [visible, selectedCountProp, selectLayer, mapInstance])

  const handleExport = async (values: any) => {
    setLoading(true)
    try {
      if (!mapInstance) throw new Error('Map instance is not ready.')

      const dateStr = new Date().toISOString().split('T')[0]
      const view = mapInstance.getView()
      const originalSize = mapInstance.getSize()!
      const originalResolution = view.getResolution()!

      // Scale factor: 300 DPI → 3×, 150 DPI → 2×, 72 DPI → 1×
      const captureScale = values.dpi === '300' ? 3 : values.dpi === '150' ? 2 : 1
      const isHiDpi = captureScale > 1

      // ── Save and restore map state ────────────────────────────────────────
      const layers = mapInstance.getLayers().getArray()
      const originalStates: { layer: any; visible: boolean; style?: any }[] = []
      layers.forEach(l => {
        originalStates.push({
          layer: l,
          visible: l.getVisible(),
          style: typeof (l as any).getStyle === 'function' ? (l as any).getStyle() : undefined,
        })
      })

      const restoreMap = () => {
        if (isHiDpi) {
          mapInstance.setSize(originalSize)
          view.setResolution(originalResolution)
        }
        originalStates.forEach(s => {
          s.layer.setVisible(s.visible)
          if (s.style !== undefined && typeof s.layer.setStyle === 'function') {
            s.layer.setStyle(s.style)
          }
        })
        mapInstance.renderSync()
      }

      // ── Apply high-DPI scaling ────────────────────────────────────────────
      // Enlarging the canvas AND halving the resolution causes OL to request
      // tiles at a higher zoom level → more tile pixels → sharper basemap.
      // Crucially, attach tile-load listeners BEFORE triggering the render so
      // that synchronous tileloadstart events (fired inside renderSync) are caught.
      if (isHiDpi) {
        const targetSize: [number, number] = [
          originalSize[0] * captureScale,
          originalSize[1] * captureScale,
        ]
        mapInstance.setSize(targetSize)
        view.setResolution(originalResolution / captureScale)
      }

      // ── Hide selection highlight, optionally filter vector layer ──────────
      const selHighlightLyr = selectLayer?.current
        ?? (layers.find((l: any) => l.getZIndex?.() === 11) as any)
      if (selHighlightLyr) selHighlightLyr.setVisible(false)

      const selFeatures: any[] = selHighlightLyr?.getSource?.()?.getFeatures?.() ?? []
      const hasSelection = selFeatures.length > 0
      const selectedIds = new Set(
        selFeatures.map((f: any) => f.get('feature_id') || String(f.getId() || ''))
      )

      const vectorLyr = layers.find((l: any) => {
        const src = l.getSource?.()
        return src && typeof src.getFeatures === 'function' && l !== selHighlightLyr
      }) as any

      if (vectorLyr && hasSelection) {
        const origState = originalStates.find(s => s.layer === vectorLyr)
        const origStyle = origState?.style
        if (origState?.visible) {
          vectorLyr.setStyle((feature: any, resolution: any) => {
            const fid = feature.get('feature_id') || String(feature.getId() || '')
            if (!selectedIds.has(fid)) return null
            if (typeof origStyle === 'function') return origStyle(feature, resolution)
            return origStyle || null
          })
        }
      }

      // ── Attach tile listeners FIRST, then trigger render ─────────────────
      // If we call waitForTilesLoaded after renderSync(), the synchronous
      // tileloadstart events have already fired and pending stays at 0 —
      // the listener resolves immediately with tiles still in-flight.
      const tileWaitMs = captureScale === 3 ? 18000 : captureScale === 2 ? 12000 : 8000
      const tilesDone = waitForTilesLoaded(mapInstance, tileWaitMs)

      // Trigger the actual tile requests
      mapInstance.renderSync()

      // Wait for every tile to finish loading
      await tilesDone

      // One final synchronous render to composite the freshly-loaded tiles
      mapInstance.renderSync()

      // ── Composite all visible canvases ────────────────────────────────────
      const mapEl = mapInstance.getTargetElement()
      const canvases = Array.from(mapEl?.querySelectorAll('canvas') ?? []) as HTMLCanvasElement[]
      const valid = canvases.filter(c => c.width > 0 && c.height > 0)
      if (valid.length === 0) throw new Error('No map layers are currently visible to export.')

      const composite = document.createElement('canvas')
      composite.width  = valid[0].width
      composite.height = valid[0].height
      const ctx = composite.getContext('2d')!
      valid.forEach(c => { try { ctx.drawImage(c, 0, 0) } catch { /* cross-origin tile */ } })

      const blob = await new Promise<Blob | null>((res) =>
        composite.toBlob(b => res(b), 'image/png')
      )
      if (!blob) throw new Error('Failed to generate PNG from map view.')

      // ── Build GeoTIFF via backend watermark service ───────────────────────
      const extent = view.calculateExtent(mapInstance.getSize() ?? [800, 600])
      const [ul_x, ul_y, lr_x, lr_y] = [extent[0], extent[3], extent[2], extent[1]]

      const formData = new FormData()
      formData.append('file', blob, `rakshagis_map_${dateStr}.png`)
      formData.append('ul_x', String(ul_x))
      formData.append('ul_y', String(ul_y))
      formData.append('lr_x', String(lr_x))
      formData.append('lr_y', String(lr_y))

      const activeLayers = legend
        ? legend.filter(l => l.type === 'raster' || selectedLayers.includes(l.name)).map(l => l.name)
        : []
      formData.append('layers', JSON.stringify(activeLayers))

      const response = await api.post('/core/watermark-file/', formData, {
        responseType: 'blob',
        headers: { 'Content-Type': 'multipart/form-data' },
      })

      restoreMap()
      downloadBlob(response.data, `rakshagis_map_${dateStr}.tif`, 'image/tiff')
      message.success('GeoTIFF downloaded — drag it straight into QGIS/ArcGIS.')
      onClose()
    } catch (error: any) {
      const errorMsg = error?.response?.data?.detail || error?.message || 'Failed to export map'
      message.error(errorMsg)

      // Always restore map state on error
      try {
        if (mapInstance) mapInstance.renderSync()
      } catch { /* ignore */ }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={visible}
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileImageOutlined />
          <span>Export Map</span>
        </span>
      }
      onCancel={onClose}
      width={480}
      footer={[
        <Button key="cancel" onClick={onClose}>Cancel</Button>,
        <Button
          key="export"
          type="primary"
          icon={<DownloadOutlined />}
          loading={loading}
          onClick={() => form.submit()}
          disabled={loading}
        >
          Export as TIFF
        </Button>,
      ]}
    >
      {loading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin tip="Loading high-resolution tiles and generating GeoTIFF…" />
        </div>
      )}

      {!loading && (
        <Form
          form={form}
          layout="vertical"
          onFinish={handleExport}
          initialValues={{ dpi: '150' }}
        >
          {selectedCount === 0 ? (
            <Alert
              type="info"
              showIcon
              message="All Features Mode"
              description={
                <span>
                  No selection active — exports <strong>all visible features</strong> from the current map view.
                  To export specific features, close this dialog, use the <strong>SELECTION</strong> tools on the left toolbar, then reopen.
                </span>
              }
              style={{ marginBottom: 16 }}
            />
          ) : (
            <Alert
              type="success"
              showIcon
              message={`Feature Selection Active — ${selectedCount} feature(s)`}
              description={`${selectedCount} feature(s) across ${selectedLayers.length} layer(s) will be exported. Only the selected features are captured.`}
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item label="Output Quality" name="dpi">
            <Radio.Group buttonStyle="solid">
              <Radio.Button value="72">Screen (72 DPI)</Radio.Button>
              <Radio.Button value="150">Print (150 DPI)</Radio.Button>
              <Radio.Button value="300">High (300 DPI)</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
            <p><strong>Georeferencing:</strong> A matching <code>.pgw</code> World File is included — drag the TIFF straight into QGIS/ArcGIS.</p>
            <p style={{ marginTop: 4 }}><strong>Watermarking:</strong> Output includes an invisible cryptographic provenance watermark.</p>
            <p style={{ marginTop: 4 }}><strong>Note:</strong> At 150/300 DPI the export waits for all high-zoom tiles to fully load before capturing — this may take 5–15 seconds depending on network speed.</p>
          </div>
        </Form>
      )}
    </Modal>
  )
}
