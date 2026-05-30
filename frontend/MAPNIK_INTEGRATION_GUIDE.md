# Mapnik Integration - React Component Setup

## Quick Start: Add Export Button to MapPage

### Step 1: Update MapPage Component

Edit your **MapPage.tsx** (or wherever your main map component is):

```tsx
import { Button, Space } from 'antd'
import { FileImageOutlined } from '@ant-design/icons'
import MapExportModal from './MapExportModal'
import { useState } from 'react'

export default function MapPage() {
  const [mapState, setMapState] = useState({
    center: [78.5, 20.5],
    zoom: 10
  })
  const [exportModalVisible, setExportModalVisible] = useState(false)

  // ... your existing map code ...

  return (
    <div>
      {/* Map toolbar with export button */}
      <Space style={{ marginBottom: 16 }}>
        <Button
          icon={<FileImageOutlined />}
          onClick={() => setExportModalVisible(true)}
        >
          Export Map
        </Button>
      </Space>

      {/* Map container */}
      {/* ... your map component ... */}

      {/* Export modal */}
      <MapExportModal
        visible={exportModalVisible}
        onClose={() => setExportModalVisible(false)}
        mapState={mapState}
      />
    </div>
  )
}
```

### Step 2: Update Map State on Zoom/Pan

When user moves/zooms map, update the state:

```tsx
// In your map event handlers:
const handleMapZoom = (newZoom: number) => {
  setMapState(prev => ({ ...prev, zoom: newZoom }))
}

const handleMapCenter = (newCenter: [number, number]) => {
  setMapState(prev => ({ ...prev, center: newCenter }))
}
```

### Step 3: Verify Component Import

Ensure the component path is correct:

```tsx
import MapExportModal from '@/features/map/MapExportModal'
// or relative path:
import MapExportModal from './MapExportModal'
```

---

## OpenLayers Integration Example

If you're using OpenLayers (not Cesium):

```tsx
import { useState, useRef } from 'react'
import { Map, View } from 'ol'
import { Button } from 'antd'
import MapExportModal from './MapExportModal'

export default function MapPage() {
  const mapRef = useRef<Map | null>(null)
  const [mapState, setMapState] = useState({ center: [78.5, 20.5], zoom: 10 })
  const [exportVisible, setExportVisible] = useState(false)

  // Initialize map
  useEffect(() => {
    const view = new View({
      center: [78.5, 20.5],
      zoom: 10
    })

    const map = new Map({
      target: 'map-container',
      view: view,
      // ... layers ...
    })

    // Update state when map changes
    view.on('change:center', () => {
      const [lon, lat] = view.getCenter()
      setMapState(prev => ({ ...prev, center: [lon, lat] }))
    })

    view.on('change:resolution', () => {
      setMapState(prev => ({ ...prev, zoom: view.getZoom() || 10 }))
    })

    mapRef.current = map
  }, [])

  return (
    <>
      <Button onClick={() => setExportVisible(true)}>Export</Button>
      <div id="map-container" style={{ width: '100%', height: '600px' }} />
      <MapExportModal
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapState={mapState}
      />
    </>
  )
}
```

---

## Cesium 3D Map Integration

If using Cesium Viewer:

```tsx
import { useState, useRef, useEffect } from 'react'
import MapExportModal from './MapExportModal'
import { Viewer, Cartesian3 } from 'cesium'

export default function Cesium3DMap() {
  const viewerRef = useRef<Viewer | null>(null)
  const [mapState, setMapState] = useState({ center: [78.5, 20.5], zoom: 10 })
  const [exportVisible, setExportVisible] = useState(false)

  useEffect(() => {
    const viewer = new Viewer('cesium-container')
    viewerRef.current = viewer

    // Listen for camera changes
    viewer.camera.changed.addEventListener(() => {
      const ellipsoid = viewer.scene.globe.ellipsoid
      const cartographic = ellipsoid.cartesianToCartographic(
        viewer.camera.position
      )
      const lon = Cesium.Math.toDegrees(cartographic.longitude)
      const lat = Cesium.Math.toDegrees(cartographic.latitude)
      const zoom = Math.round(viewer.camera.positionCartographic.height / 1000)

      setMapState({ center: [lon, lat], zoom })
    })
  }, [])

  return (
    <>
      <button onClick={() => setExportVisible(true)}>Export Map</button>
      <div id="cesium-container" style={{ width: '100%', height: '100vh' }} />
      <MapExportModal
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapState={mapState}
      />
    </>
  )
}
```

---

## Customize Export Button Position

### Floating Action Button (FAB)

```tsx
import { FloatButton } from 'antd'
import { FileImageOutlined } from '@ant-design/icons'

<FloatButton
  icon={<FileImageOutlined />}
  onClick={() => setExportModalVisible(true)}
  tooltip="Export Map"
/>
```

### Toolbar Button Group

```tsx
import { Button, Space, Tooltip } from 'antd'
import { ZoomInOutlined, ZoomOutOutlined, FileImageOutlined } from '@ant-design/icons'

<div style={{ position: 'absolute', top: 20, right: 20, zIndex: 1000 }}>
  <Space direction="vertical">
    <Tooltip title="Zoom In">
      <Button icon={<ZoomInOutlined />} onClick={handleZoomIn} />
    </Tooltip>
    <Tooltip title="Zoom Out">
      <Button icon={<ZoomOutOutlined />} onClick={handleZoomOut} />
    </Tooltip>
    <Tooltip title="Export Map">
      <Button
        icon={<FileImageOutlined />}
        onClick={() => setExportModalVisible(true)}
        type="primary"
      />
    </Tooltip>
  </Space>
</div>
```

---

## Testing the Integration

### 1. Run Frontend Dev Server

```bash
cd frontend
npm run dev
```

### 2. Navigate to Map Page

Open `http://localhost:5173/map` in browser

### 3. Click Export Button

- Modal should appear
- Styles dropdown should show "boundaries" (and other styles if created)
- Default size: 1200×800

### 4. Test Export

- Change width to 1500
- Change height to 1000
- Click "Export as PNG"
- File should download: `rakshagis_map_2026-05-30.png`

### 5. Monitor Network

Open DevTools → Network tab to see:
- **Request**: `POST /api/core/export-map/`
- **Response**: PNG file (~50-200KB depending on size)
- **Time**: Should be 50-200ms

---

## Styling Customization

Edit [MapExportModal.tsx:178-189](./src/features/map/MapExportModal.tsx#L178-L189) to customize info display:

```tsx
<div style={{ color: '#666', fontSize: 12, marginTop: 12 }}>
  <p><strong>Current zoom:</strong> {mapState.zoom || 10}</p>
  <p><strong>Quality:</strong> 300+ DPI (professional print quality)</p>
  <p><strong>Rendering time:</strong> ~50-100ms</p>
</div>
```

Change colors, text, or add more info like:

```tsx
<p><strong>Center:</strong> {mapState.center?.join(', ')}</p>
<p><strong>Output:</strong> PNG format</p>
<p><strong>Max file size:</strong> ~500KB</p>
```

---

## Troubleshooting Integration

### Modal doesn't open
- Check `exportVisible` state is being set to `true`
- Verify `MapExportModal` is imported correctly
- Check console for TypeScript errors

### Export fails with 503
- Mapnik is not installed
- See parent `MAPNIK_SETUP_COMPLETE.md` Step 1

### Export fails with 404
- Style file doesn't exist in `services/mapnik/styles/`
- Check filename matches style name selected

### Download doesn't start
- Check browser allows downloads
- Check `Content-Type: image/png` in response
- Verify `link.click()` fires (may be blocked by popup blocker)

---

## Advanced: Custom Export Options

Extend `MapExportModal` props to add features:

```tsx
interface MapExportModalProps {
  visible: boolean
  onClose: () => void
  mapState: { center?: [number, number], zoom?: number }
  presets?: { label: string, width: number, height: number }[] // Add this
}

// Then in form initialValues:
<Form.Item label="Presets">
  <ButtonGroup>
    {presets?.map(preset => (
      <Button
        key={preset.label}
        onClick={() => form.setFieldsValue({
          width: preset.width,
          height: preset.height
        })}
      >
        {preset.label}
      </Button>
    ))}
  </ButtonGroup>
</Form.Item>
```

Use with presets:

```tsx
<MapExportModal
  visible={exportVisible}
  onClose={() => setExportVisible(false)}
  mapState={mapState}
  presets={[
    { label: 'Web (1200×800)', width: 1200, height: 800 },
    { label: 'Print (2400×1600)', width: 2400, height: 1600 },
    { label: 'Square (1000×1000)', width: 1000, height: 1000 },
  ]}
/>
```

---

## Summary

✅ **Component ready**: `MapExportModal.tsx`
✅ **Backend ready**: API endpoints configured
✅ **Mapnik ready**: Service + styles configured
✅ **Integration**: Follow examples above for your map type

**Next**: Install Mapnik (see `MAPNIK_SETUP_COMPLETE.md`) and test!
