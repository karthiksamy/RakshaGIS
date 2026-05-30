import { Modal, Button, Form, Select, InputNumber, Space, message, Spin, Alert } from 'antd'
import { DownloadOutlined, FileImageOutlined } from '@ant-design/icons'
import { useState, useEffect } from 'react'
import api from '@/services/api'

interface MapExportModalProps {
  visible: boolean
  onClose: () => void
  mapState: {
    center?: [number, number]
    zoom?: number
  }
}

export default function MapExportModal({ visible, onClose, mapState }: MapExportModalProps) {
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
      const center = mapState.center || [78, 20]
      const zoom = mapState.zoom || 10

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

      // Download file
      const url = window.URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url
      link.download = `rakshagis_map_${new Date().toISOString().split('T')[0]}.png`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      message.success('Map exported successfully!')
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
      width={500}
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
          disabled={!mapnikAvailable || loading}
        >
          Export as PNG
        </Button>,
      ]}
    >
      {!mapnikAvailable && (
        <Alert
          type="warning"
          message="Mapnik not available"
          description="Map export requires Mapnik to be installed. Contact administrator for setup."
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin tip="Rendering map at high quality (300+ DPI)..." />
        </div>
      )}

      {!loading && (
        <Form
          form={form}
          layout="vertical"
          onFinish={handleExport}
          initialValues={{
            width: 1200,
            height: 800,
            style: styles[0] || 'boundaries',
          }}
        >
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

          <div style={{ color: '#666', fontSize: 12, marginTop: 12 }}>
            <p>
              <strong>Current zoom:</strong> {mapState.zoom || 10}
            </p>
            <p>
              <strong>Quality:</strong> 300+ DPI (professional print quality)
            </p>
            <p>
              <strong>Rendering time:</strong> ~50-100ms
            </p>
          </div>
        </Form>
      )}
    </Modal>
  )
}
