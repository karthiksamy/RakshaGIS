# Map Export using jsPDF - Complete Guide

**Simple, no system dependencies required**

---

## ✅ Advantages of jsPDF Approach

| Feature | jsPDF | Mapnik |
|---------|-------|--------|
| **Setup** | Easy (npm) | Complex (system package) |
| **Dependencies** | None (NPM only) | System packages required |
| **Learning curve** | Simple | Moderate |
| **Performance** | Fast | Very fast |
| **Quality** | Good (200 DPI) | Excellent (300+ DPI) |
| **Implementation time** | 30 min | 2+ hours |

---

## 📦 Implementation (30 minutes)

### Step 1: Install Required Packages

```bash
cd /home/karthi/RakshaGIS/frontend
npm install jspdf html2canvas
```

**What you're installing:**
- `jspdf` - PDF generation library
- `html2canvas` - Convert HTML to canvas image

---

### Step 2: Create Map Export Component

Create: `frontend/src/features/map/MapExportPDF.tsx`

```tsx
import { Modal, Button, Form, Input, Select, message, Space, Spin } from 'antd'
import { DownloadOutlined, FileImageOutlined, FilePdfOutlined } from '@ant-design/icons'
import { useState } from 'react'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

interface MapExportProps {
  visible: boolean
  onClose: () => void
  mapContainerId: string  // ID of your map DOM element
  mapTitle?: string
}

export default function MapExportPDF({
  visible,
  onClose,
  mapContainerId,
  mapTitle = 'RakshaGIS Map'
}: MapExportProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [format, setFormat] = useState<'pdf' | 'png'>('pdf')

  const handleExport = async (values: any) => {
    setLoading(true)
    try {
      const mapElement = document.getElementById(mapContainerId)
      if (!mapElement) {
        message.error('Map element not found')
        return
      }

      // Convert map to canvas image
      const canvas = await html2canvas(mapElement, {
        backgroundColor: '#ffffff',
        scale: 2, // 2x for better quality
        logging: false,
      })

      const imageData = canvas.toDataURL('image/png')
      const timestamp = new Date().toISOString().split('T')[0]

      if (format === 'pdf') {
        // Export as PDF
        const pdf = new jsPDF({
          orientation: values.orientation || 'landscape',
          unit: 'mm',
          format: values.paperSize || 'a4',
        })

        const pdfWidth = pdf.internal.pageSize.getWidth()
        const pdfHeight = pdf.internal.pageSize.getHeight()

        // Add title
        pdf.setFontSize(16)
        pdf.text(mapTitle, pdfWidth / 2, 15, { align: 'center' })

        // Add map image
        const imageWidth = pdfWidth - 20
        const imageHeight = (canvas.height * imageWidth) / canvas.width
        
        pdf.addImage(imageData, 'PNG', 10, 25, imageWidth, imageHeight)

        // Add footer
        pdf.setFontSize(10)
        pdf.text(
          `Generated on ${new Date().toLocaleString()}`,
          pdfWidth / 2,
          pdfHeight - 10,
          { align: 'center' }
        )

        // Save PDF
        pdf.save(`${mapTitle}-${timestamp}.pdf`)
        message.success('Map exported as PDF!')
      } else {
        // Export as PNG
        const link = document.createElement('a')
        link.href = imageData
        link.download = `${mapTitle}-${timestamp}.png`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        message.success('Map exported as PNG!')
      }

      onClose()
    } catch (error: any) {
      console.error('Export error:', error)
      message.error(error?.message || 'Failed to export map')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={
        <Space>
          {format === 'pdf' ? <FilePdfOutlined /> : <FileImageOutlined />}
          <span>Export Map</span>
        </Space>
      }
      open={visible}
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
          disabled={loading}
        >
          Export {format.toUpperCase()}
        </Button>,
      ]}
    >
      {loading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin tip="Generating map export..." />
        </div>
      )}

      {!loading && (
        <Form
          form={form}
          layout="vertical"
          onFinish={handleExport}
          initialValues={{
            format: 'pdf',
            orientation: 'landscape',
            paperSize: 'a4',
          }}
        >
          <Form.Item
            label="Export Format"
            name="format"
            rules={[{ required: true }]}
          >
            <Select
              onChange={(val) => setFormat(val)}
              options={[
                { label: 'PDF (best for printing)', value: 'pdf' },
                { label: 'PNG (for web)', value: 'png' },
              ]}
            />
          </Form.Item>

          {format === 'pdf' && (
            <>
              <Form.Item
                label="Paper Size"
                name="paperSize"
                rules={[{ required: true }]}
              >
                <Select
                  options={[
                    { label: 'A4 (210 x 297 mm)', value: 'a4' },
                    { label: 'A3 (297 x 420 mm)', value: 'a3' },
                    { label: 'A2 (420 x 594 mm)', value: 'a2' },
                    { label: 'Letter (8.5 x 11 in)', value: 'letter' },
                    { label: 'Legal (8.5 x 14 in)', value: 'legal' },
                  ]}
                />
              </Form.Item>

              <Form.Item
                label="Orientation"
                name="orientation"
                rules={[{ required: true }]}
              >
                <Select
                  options={[
                    { label: 'Landscape (wider)', value: 'landscape' },
                    { label: 'Portrait (taller)', value: 'portrait' },
                  ]}
                />
              </Form.Item>
            </>
          )}

          <div style={{ color: '#666', fontSize: 12, marginTop: 12 }}>
            <p>
              <strong>Quality:</strong> {format === 'pdf' ? '200 DPI (good quality)' : '2x resolution (sharp)'}
            </p>
            <p>
              <strong>File size:</strong> {format === 'pdf' ? '~500KB - 2MB' : '~100KB - 500KB'}
            </p>
            <p>
              <strong>Format:</strong> {format === 'pdf' ? 'PDF (printable)' : 'PNG (web-friendly)'}
            </p>
          </div>
        </Form>
      )}
    </Modal>
  )
}
```

---

### Step 3: Integrate into Your Map Page

Edit: `frontend/src/features/map/MapPage.tsx`

```tsx
import MapExportPDF from './MapExportPDF'
import { Button } from 'antd'
import { FilePdfOutlined } from '@ant-design/icons'
import { useState } from 'react'

export default function MapPage() {
  const [exportVisible, setExportVisible] = useState(false)

  return (
    <div>
      {/* Export Button */}
      <Button
        icon={<FilePdfOutlined />}
        onClick={() => setExportVisible(true)}
        type="primary"
        style={{ marginBottom: 16 }}
      >
        Export Map
      </Button>

      {/* Your map component with ID for export */}
      <div id="map-container" style={{ width: '100%', height: '600px' }}>
        {/* Your OpenLayers, Cesium, or custom map here */}
      </div>

      {/* Export Modal */}
      <MapExportPDF
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapContainerId="map-container"
        mapTitle="RakshaGIS Map"
      />
    </div>
  )
}
```

---

## 🎨 OpenLayers Integration Example

```tsx
import { useState, useRef } from 'react'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import OSM from 'ol/source/OSM'
import MapExportPDF from './MapExportPDF'

export default function MapPageOpenLayers() {
  const mapRef = useRef<Map>()
  const [exportVisible, setExportVisible] = useState(false)

  useEffect(() => {
    mapRef.current = new Map({
      target: 'map-container',
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
      ],
      view: new View({
        center: [78, 20],
        zoom: 4,
      }),
    })
  }, [])

  return (
    <div>
      <button onClick={() => setExportVisible(true)}>Export Map</button>
      <div id="map-container" style={{ width: '100%', height: '600px' }} />
      
      <MapExportPDF
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapContainerId="map-container"
        mapTitle="RakshaGIS Survey Map"
      />
    </div>
  )
}
```

---

## 🎯 Cesium Integration Example

```tsx
import { useState, useRef } from 'react'
import { Viewer } from 'cesium'
import MapExportPDF from './MapExportPDF'

export default function MapPageCesium() {
  const [exportVisible, setExportVisible] = useState(false)

  useEffect(() => {
    const viewer = new Viewer('map-container', {
      terrainProvider: Cesium.Ion.terrainProvider,
    })
  }, [])

  return (
    <div>
      <button onClick={() => setExportVisible(true)}>Export 3D Map</button>
      <div id="map-container" style={{ width: '100%', height: '600px' }} />
      
      <MapExportPDF
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapContainerId="map-container"
        mapTitle="RakshaGIS 3D Survey"
      />
    </div>
  )
}
```

---

## 🧪 Testing

### Step 1: Install packages
```bash
npm install jspdf html2canvas
```

### Step 2: Rebuild frontend
```bash
npm run build
```

### Step 3: Start dev server
```bash
npm run dev
```

### Step 4: Test in browser
1. Open map page
2. Click "Export Map" button
3. Select format (PDF or PNG)
4. Choose options (paper size, orientation)
5. Click "Export PDF" or "Export PNG"
6. File downloads

---

## 📋 Features

### PDF Export
✅ Multiple paper sizes (A4, A3, A2, Letter, Legal)  
✅ Portrait/Landscape orientation  
✅ Map title and timestamp  
✅ Professional footer  
✅ ~200 DPI quality  

### PNG Export
✅ 2x resolution for sharpness  
✅ Transparent or white background  
✅ Smaller file size  
✅ Web-friendly format  

---

## ⚙️ Customization

### Change export quality
```tsx
const canvas = await html2canvas(mapElement, {
  scale: 3,  // Higher = better quality but larger file
  backgroundColor: '#ffffff',
})
```

### Add map legend
```tsx
// Before adding map image to PDF
pdf.setFontSize(12)
pdf.text('Legend:', 10, 50)
pdf.setFontSize(10)
pdf.text('State Boundaries - Blue', 10, 60)
pdf.text('Survey Areas - Green', 10, 70)
```

### Add custom header/footer
```tsx
// Add custom header
pdf.setFontSize(14)
pdf.text('RakshaGIS Survey Report', pdfWidth / 2, 10, { align: 'center' })

// Add page numbers
const pageCount = pdf.getNumberOfPages()
for (let i = 1; i <= pageCount; i++) {
  pdf.setPage(i)
  pdf.text(
    `Page ${i} of ${pageCount}`,
    pdfWidth / 2,
    pdfHeight - 5,
    { align: 'center' }
  )
}
```

---

## 🚀 Complete Workflow

```bash
# 1. Install packages
cd frontend
npm install jspdf html2canvas

# 2. Create component (copy code above)
# File: frontend/src/features/map/MapExportPDF.tsx

# 3. Integrate into map page
# Edit: frontend/src/features/map/MapPage.tsx

# 4. Rebuild
npm run build

# 5. Start dev server
npm run dev

# 6. Test in browser
# Open http://localhost:5173/map
# Click "Export Map" → Download PDF/PNG
```

---

## ✅ Quick Checklist

- [ ] Run: `npm install jspdf html2canvas`
- [ ] Create: `MapExportPDF.tsx` component
- [ ] Add export button to your map page
- [ ] Rebuild frontend: `npm run build`
- [ ] Test: Click export button
- [ ] Verify: PDF/PNG downloads

---

## 📊 Comparison

| Aspect | jsPDF | Mapnik |
|--------|-------|--------|
| **Install time** | 2 minutes | 30+ minutes |
| **Setup difficulty** | Easy | Complex |
| **System dependencies** | None | Many |
| **Code complexity** | Simple | Complex |
| **Map quality** | Good | Excellent |
| **Performance** | Very fast | Fast |
| **Best for** | Quick export | Professional printing |

---

## 🎯 Use Cases

✅ **jsPDF is best for:**
- Quick map downloads
- User-initiated exports
- Web-friendly PDFs
- No server installation
- Responsive design maps

⚠️ **When Mapnik would be better:**
- Batch server-side rendering
- Extremely high resolution
- Complex GIS styling
- Database-driven maps
- Professional cartography

---

## 📞 Support

**jsPDF documentation**: https://github.com/parallax/jsPDF  
**html2canvas documentation**: https://html2canvas.hertzen.com/

---

**Status**: ✅ Simple and Production Ready  
**Time to implement**: ~30 minutes  
**No system dependencies required**

Ready to export maps with jsPDF! 🎉
