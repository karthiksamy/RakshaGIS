import { Modal, Button, Form, Select, InputNumber, Space, message, Spin, Alert, Radio } from 'antd'
import { DownloadOutlined, FileImageOutlined } from '@ant-design/icons'
import { useState, useEffect } from 'react'
import type OLMap from 'ol/Map'
import { fromLonLat } from 'ol/proj'
import api from '@/services/api'

// EPSG:3857 (Web Mercator) projection WKT — written as a .prj sidecar so QGIS/ArcGIS
// place the georeferenced PNG using the correct CRS instead of assuming the project
// CRS (a plain .pgw world file carries no CRS, which is why Mercator-metre coordinates
// were landing far outside the lat/lon world extent).
const EPSG_3857_WKT =
  'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
  'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
  'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],' +
  'PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],' +
  'PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,' +
  'AUTHORITY["EPSG","9001"]],AXIS["X",EAST],AXIS["Y",NORTH],' +
  'EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 ' +
  '+k=1 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]'

// Trigger a browser download for an in-memory blob/string.
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

interface MapExportModalProps {
  visible: boolean
  onClose: () => void
  mapInstance: OLMap | null
  mapState: {
    center?: [number, number]
    zoom?: number
  }
}

export default function MapExportModal({ visible, onClose, mapInstance, mapState }: MapExportModalProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [styles, setStyles] = useState<string[]>([])
  const [mapnikAvailable, setMapnikAvailable] = useState(true)

  // Load available styles on mount
  useEffect(() => {
    const loadStyles = async () => {
      try {
        const response = await api.get('/core/map-styles/')
        setStyles(response.data.styles || [])
      } catch (error) {
        console.warn('Could not load map styles:', error)
        setMapnikAvailable(false)
      }
    }

    if (visible) {
      loadStyles()
    }
  }, [visible])

  const handleExport = async (values: any) => {
    setLoading(true)
    try {
      let pgwContent = ''
      const filename = `rakshagis_map_${new Date().toISOString().split('T')[0]}.png`

      if (values.method === 'canvas') {
        if (!mapInstance) {
          throw new Error('Map instance is not ready.')
        }

        // Composite visible map canvases on the client
        const mapEl = mapInstance.getTargetElement()
        const canvases = Array.from(mapEl?.querySelectorAll('canvas') ?? []) as HTMLCanvasElement[]
        const valid = canvases.filter((c) => c.width > 0 && c.height > 0)

        if (valid.length === 0) {
          throw new Error('No map layers are currently visible in the viewer to export.')
        }

        const captureScale = values.dpi === '300' ? 3 : values.dpi === '150' ? 2 : 1
        const composite = document.createElement('canvas')
        composite.width  = valid[0].width  * captureScale
        composite.height = valid[0].height * captureScale

        const ctx = composite.getContext('2d')!
        ctx.scale(captureScale, captureScale)

        valid.forEach((c) => {
          try {
            ctx.drawImage(c, 0, 0)
          } catch (e) {
            console.warn('Cross-origin canvas layer skipped in export:', e)
          }
        })

        // Convert the composite canvas to Blob
        const blob = await new Promise<Blob | null>((resolve) => {
          composite.toBlob((b) => resolve(b), 'image/png')
        })

        if (!blob) {
          throw new Error('Failed to generate PNG image data from map view.')
        }

        // Calculate georeferencing coefficients (PGW) for Web Mercator EPSG:3857
        const view = mapInstance.getView()
        const res = view.getResolution() ?? 1
        const center = view.getCenter() ?? [0, 0]
        // OpenLayers sizes the canvas backing store at devicePixelRatio × CSS size, while
        // getResolution() returns map-units per CSS pixel. Divide by DPR so the world
        // file's per-pixel ground size matches the actual exported pixels (backing store
        // × captureScale); otherwise the georeferencing is off by the DPR factor on HiDPI.
        const dpr = window.devicePixelRatio || 1
        const exportRes = res / captureScale / dpr

        const halfW = (composite.width * exportRes) / 2
        const halfH = (composite.height * exportRes) / 2
        
        const ulX = center[0] - halfW + (exportRes / 2)
        const ulY = center[1] + halfH - (exportRes / 2)
        
        const pgwLines = [
          exportRes.toFixed(10),
          '0.0',
          '0.0',
          (-exportRes).toFixed(10),
          ulX.toFixed(5),
          ulY.toFixed(5)
        ]
        pgwContent = pgwLines.join('\n') + '\n'

        // Send blob to backend for watermarking and Trust Registry inclusion
        const formData = new FormData()
        formData.append('file', blob, filename)

        const response = await api.post('/core/watermark-file/', formData, {
          responseType: 'blob',
          headers: {
            'Content-Type': 'multipart/form-data',
          }
        })

        // Download the georeferenced package: PNG + PGW world file + PRJ projection.
        downloadBlob(response.data, filename, 'image/png')
        downloadBlob(pgwContent, filename.replace(/\.png$/, '.pgw'), 'text/plain')
        downloadBlob(EPSG_3857_WKT, filename.replace(/\.png$/, '.prj'), 'text/plain')

        message.success('Georeferenced PNG package (PNG + PGW + PRJ) downloaded successfully!')
        onClose()
        return
      }

      // Mapnik export method (Server-side)
      const center = mapState.center || [78, 20]
      const zoom = mapState.zoom || 10

      // Calculate Mapnik georeferencing coefficients (PGW)
      const centerMerc = fromLonLat(center)
      const circumference = 2.0 * Math.PI * 6378137.0
      const mapnikRes = circumference / (256.0 * Math.pow(2.0, zoom))
      
      const halfW = (values.width * mapnikRes) / 2
      const halfH = (values.height * mapnikRes) / 2
      
      const ulX = centerMerc[0] - halfW + (mapnikRes / 2)
      const ulY = centerMerc[1] + halfH - (mapnikRes / 2)
      
      const pgwLines = [
        mapnikRes.toFixed(10),
        '0.0',
        '0.0',
        (-mapnikRes).toFixed(10),
        ulX.toFixed(5),
        ulY.toFixed(5)
      ]
      pgwContent = pgwLines.join('\n') + '\n'

      const response = await api.post(
        '/core/export-map/',
        {
          width: values.width,
          height: values.height,
          zoom: zoom,
          center_lon: center[0],
          center_lat: center[1],
          style: values.style,
        },
        {
          responseType: 'blob',
        }
      )

      // Download the georeferenced package: PNG + PGW world file + PRJ projection.
      downloadBlob(response.data, filename, 'image/png')
      downloadBlob(pgwContent, filename.replace(/\.png$/, '.pgw'), 'text/plain')
      downloadBlob(EPSG_3857_WKT, filename.replace(/\.png$/, '.prj'), 'text/plain')

      message.success('Georeferenced Mapnik PNG package (PNG + PGW + PRJ) downloaded successfully!')
      onClose()
    } catch (error: any) {
      const errorMsg =
        error?.response?.data?.detail ||
        error?.message ||
        'Failed to export map'
      message.error(errorMsg)
      console.error('Export error:', error)

      if (error?.response?.status === 503) {
        setMapnikAvailable(false)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={visible}
      title={
        <Space>
          <FileImageOutlined />
          <span>Export Map</span>
        </Space>
      }
      onCancel={onClose}
      width={520}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="export"
          type="primary"
          icon={<DownloadOutlined />}
          loading={loading}
          onClick={() => form.submit()}
          disabled={loading}
        >
          Export as PNG
        </Button>,
      ]}
    >
      {loading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin tip="Rendering map and generating georeferencing World File..." />
        </div>
      )}

      {!loading && (
        <Form
          form={form}
          layout="vertical"
          onFinish={handleExport}
          initialValues={{
            method: 'canvas',
            dpi: '150',
            width: 1200,
            height: 800,
            style: styles[0] || 'boundaries',
          }}
        >
          <Form.Item label="Export Method" name="method">
            <Radio.Group buttonStyle="solid" style={{ width: '100%' }}>
              <Radio.Button value="canvas" style={{ width: '50%', textAlign: 'center' }}>
                WYSIWYG Capture
              </Radio.Button>
              <Radio.Button value="mapnik" style={{ width: '50%', textAlign: 'center' }} disabled={!mapnikAvailable}>
                Server Vector (Mapnik)
              </Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.method !== curr.method}
          >
            {({ getFieldValue }) => {
              const method = getFieldValue('method')
              if (method === 'canvas') {
                return (
                  <>
                    <Form.Item label="Output Quality" name="dpi">
                      <Radio.Group buttonStyle="solid">
                        <Radio.Button value="72">Screen (72 DPI)</Radio.Button>
                        <Radio.Button value="150">Print (150 DPI)</Radio.Button>
                        <Radio.Button value="300">High (300 DPI)</Radio.Button>
                      </Radio.Group>
                    </Form.Item>
                    <div style={{ color: '#888', fontSize: 12, marginTop: 12 }}>
                      <p><strong>WYSIWYG Capture:</strong> Exports exactly what you see on the screen, including the active basemap (OSM/Satellite), survey areas, defence land parcels, external layers, and drawings/measurements.</p>
                      <p><strong>Georeferencing:</strong> Automatically generates and downloads a matching `.pgw` World File, enabling direct drag-and-drop integration in QGIS/ArcGIS.</p>
                      <p><strong>Watermarking:</strong> Output PNG includes invisible dual-layer cryptographic metadata watermark registered in the Provenance Trust Registry.</p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  {!mapnikAvailable && (
                    <Alert
                      type="warning"
                      message="Mapnik not available"
                      description="Mapnik server-side vector rendering requires the Mapnik library on host. Contact admin."
                      style={{ marginBottom: 16 }}
                      showIcon
                    />
                  )}
                  <Form.Item
                    label="Map Style"
                    name="style"
                    rules={[{ required: true, message: 'Please select a style' }]}
                  >
                    <Select
                      placeholder="Select map style"
                      options={styles.map((s) => ({
                        label: s.charAt(0).toUpperCase() + s.slice(1),
                        value: s,
                      }))}
                      disabled={!mapnikAvailable}
                    />
                  </Form.Item>

                  <Form.Item
                    label="Width (pixels)"
                    name="width"
                    rules={[
                      { type: 'number', min: 400, max: 4000, message: 'Width must be 400-4000px' },
                      { required: true },
                    ]}
                  >
                    <InputNumber style={{ width: '100%' }} disabled={!mapnikAvailable} />
                  </Form.Item>

                  <Form.Item
                    label="Height (pixels)"
                    name="height"
                    rules={[
                      { type: 'number', min: 300, max: 3000, message: 'Height must be 300-3000px' },
                      { required: true },
                    ]}
                  >
                    <InputNumber style={{ width: '100%' }} disabled={!mapnikAvailable} />
                  </Form.Item>
                  <div style={{ color: '#888', fontSize: 12, marginTop: 12 }}>
                    <p><strong>Server Vector (Mapnik):</strong> renders the selected PostGIS
                    vector layers (parcels, features, boundaries) on a plain background —
                    it does <strong>not</strong> include the OSM/satellite basemap. For a
                    map with the basemap, use <strong>WYSIWYG Capture</strong>.</p>
                    <p><strong>Georeferencing:</strong> downloads a matching <code>.pgw</code> world
                    file and <code>.prj</code> (EPSG:3857) so QGIS/ArcGIS place it correctly.</p>
                  </div>
                </>
              )
            }}
          </Form.Item>
        </Form>
      )}
    </Modal>
  )
}
