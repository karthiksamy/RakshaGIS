# How to Use Mapnik in RakshaGIS - Complete Guide

**After successful Mapnik installation, follow these steps to enable map export functionality.**

---

## Step 1: Install Mapnik (System Level)

### Option A: Automatic Installation (Recommended)
```bash
cd /home/karthi/RakshaGIS
bash install-mapnik.sh
```

**What it does:**
- ✓ Installs system packages (mapnik-utils, python3-mapnik, libmapnik-dev)
- ✓ Creates directories (services/mapnik/styles, services/mapnik/data)
- ✓ Installs Python Mapnik via pip
- ✓ Tests installation
- ✓ Creates sample boundaries.xml

### Option B: Manual Installation
```bash
# Install system packages
sudo apt-get update
sudo apt-get install -y mapnik-utils python3-mapnik libmapnik-dev

# Activate virtual environment
cd /home/karthi/RakshaGIS
source venv/bin/activate

# Install Python Mapnik
pip install mapnik

# Verify installation
python3 -c "import mapnik; print(f'✓ Mapnik {mapnik.mapnik_version()}')"
```

---

## Step 2: Configure Mapnik Styles

### Update boundaries.xml with Your Database

**File**: `services/mapnik/styles/boundaries.xml`

Replace the empty template with actual database connections:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Map>
<Map srs="+proj=merc +a=6378137 +b=6378137 +over" background-color="#b3d9ff">

  <Parameters>
    <Parameter name="name">RakshaGIS Boundaries</Parameter>
    <Parameter name="description">Survey and administrative boundaries</Parameter>
  </Parameters>

  <!-- Layer: State Boundaries -->
  <Layer name="state_boundaries" srs="+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs">
    <StyleName>state_style</StyleName>
    <Datasource>
      <Parameter name="type">postgis</Parameter>
      <Parameter name="dbname">rakshagis</Parameter>
      <Parameter name="host">localhost</Parameter>
      <Parameter name="port">5432</Parameter>
      <Parameter name="user">raksha</Parameter>
      <Parameter name="password">YOUR_DB_PASSWORD</Parameter>
      <Parameter name="table">
        (SELECT id, name, geometry FROM gis_layers_boundary
         WHERE boundary_type = 'STATE' AND geometry IS NOT NULL) AS state_boundaries
      </Parameter>
      <Parameter name="geometry_field">geometry</Parameter>
      <Parameter name="use_spatial_index">true</Parameter>
    </Datasource>
  </Layer>

  <!-- Layer: District Boundaries -->
  <Layer name="district_boundaries" srs="+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs">
    <StyleName>district_style</StyleName>
    <Datasource>
      <Parameter name="type">postgis</Parameter>
      <Parameter name="dbname">rakshagis</Parameter>
      <Parameter name="host">localhost</Parameter>
      <Parameter name="port">5432</Parameter>
      <Parameter name="user">raksha</Parameter>
      <Parameter name="password">YOUR_DB_PASSWORD</Parameter>
      <Parameter name="table">
        (SELECT id, name, geometry FROM gis_layers_boundary
         WHERE boundary_type = 'DISTRICT' AND geometry IS NOT NULL) AS district_boundaries
      </Parameter>
      <Parameter name="geometry_field">geometry</Parameter>
      <Parameter name="use_spatial_index">true</Parameter>
    </Datasource>
  </Layer>

  <!-- Layer: Survey Areas -->
  <Layer name="survey_areas" srs="+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs">
    <StyleName>survey_style</StyleName>
    <Datasource>
      <Parameter name="type">postgis</Parameter>
      <Parameter name="dbname">rakshagis</Parameter>
      <Parameter name="host">localhost</Parameter>
      <Parameter name="port">5432</Parameter>
      <Parameter name="user">raksha</Parameter>
      <Parameter name="password">YOUR_DB_PASSWORD</Parameter>
      <Parameter name="table">
        (SELECT id, name, status, geometry FROM survey_projects_surveyarea
         WHERE geometry IS NOT NULL) AS survey_areas
      </Parameter>
      <Parameter name="geometry_field">geometry</Parameter>
      <Parameter name="use_spatial_index">true</Parameter>
    </Datasource>
  </Layer>

  <!-- Styles -->
  <Style name="state_style">
    <Rule>
      <MaxScaleDenominator>250000</MaxScaleDenominator>
      <LineSymbolizer stroke="#333333" stroke-width="2" stroke-opacity="0.9"/>
    </Rule>
  </Style>

  <Style name="district_style">
    <Rule>
      <MaxScaleDenominator>100000</MaxScaleDenominator>
      <LineSymbolizer stroke="#666666" stroke-width="1.5" stroke-opacity="0.7"/>
    </Rule>
  </Style>

  <Style name="survey_style">
    <Rule>
      <PolygonSymbolizer fill="#4ecdc4" fill-opacity="0.25"/>
      <LineSymbolizer stroke="#4ecdc4" stroke-width="1.5" stroke-opacity="0.8"/>
    </Rule>
  </Style>

</Map>
```

**Replace:**
- `YOUR_DB_PASSWORD` - Your actual PostgreSQL password
- `localhost` - Your database host
- Table/column names - Match your actual database schema

---

## Step 3: Verify Mapnik Works

### Test 1: Direct Python Test
```bash
cd /home/karthi/RakshaGIS
source venv/bin/activate

python3 << 'EOF'
import mapnik

# Load map
m = mapnik.Map(800, 600)
mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')

# Set zoom to India bounds
m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))

# Render
img = mapnik.Image(800, 600)
mapnik.render(m, img)
img.save('test_map.png')

print("✓ Map rendered successfully!")
print("✓ Saved to: test_map.png")
EOF
```

**Expected output:**
```
✓ Map rendered successfully!
✓ Saved to: test_map.png
```

### Test 2: Test via Django
```bash
cd /home/karthi/RakshaGIS
source venv/bin/activate
python manage.py shell

# Inside Django shell:
from apps.core.services.mapnik_service import get_mapnik_service

service = get_mapnik_service()
service.load_style('boundaries')
service.set_center_zoom(78.5, 20.5, 10)
png_data = service.render_png(1200, 800)

print(f"✓ Rendered {len(png_data)} bytes!")
exit()
```

---

## Step 4: Use Mapnik in Your Application

### 4A: Backend API (Already Configured)

The API endpoints are ready in `apps/core/views.py`:

**POST /api/core/export-map/**
```python
# Request
{
    "width": 1200,
    "height": 800,
    "zoom": 10,
    "center_lon": 78.5,
    "center_lat": 20.5,
    "style": "boundaries"
}

# Response
<PNG binary data>
```

**GET /api/core/map-styles/**
```python
# Response
{
    "styles": ["boundaries"],
    "count": 1
}
```

### 4B: Frontend React Component

The `MapExportModal.tsx` component is ready to use:

```tsx
import MapExportModal from '@/features/map/MapExportModal'
import { useState } from 'react'

export default function MapPage() {
  const [exportVisible, setExportVisible] = useState(false)
  const [mapState, setMapState] = useState({
    center: [78.5, 20.5],
    zoom: 10
  })

  return (
    <>
      <button onClick={() => setExportVisible(true)}>
        Export Map
      </button>

      <MapExportModal
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapState={mapState}
      />
    </>
  )
}
```

### 4C: Full Integration Example

**Step 1: Add Export Button to Your Map Page**

Edit: `frontend/src/features/map/MapPage.tsx`

```tsx
import MapExportModal from './MapExportModal'
import { Button } from 'antd'
import { FileImageOutlined } from '@ant-design/icons'
import { useState } from 'react'

export default function MapPage() {
  const [exportVisible, setExportVisible] = useState(false)
  const [mapState, setMapState] = useState({
    center: [78.5, 20.5],
    zoom: 10
  })

  // When map zoom/pan changes, update mapState
  const handleMapChange = (center, zoom) => {
    setMapState({ center, zoom })
  }

  return (
    <div>
      <Button
        icon={<FileImageOutlined />}
        onClick={() => setExportVisible(true)}
        type="primary"
      >
        Export Map as PNG
      </Button>

      {/* Your map component */}
      {/* <Map onChange={handleMapChange} /> */}

      <MapExportModal
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        mapState={mapState}
      />
    </div>
  )
}
```

**Step 2: Update Map Change Handler**

For OpenLayers:
```tsx
const handleMapZoom = (view) => {
  const zoom = view.getZoom()
  const [lon, lat] = view.getCenter()
  setMapState({ center: [lon, lat], zoom })
}
```

For Cesium:
```tsx
const handleCesiumChange = () => {
  const camera = viewer.camera
  const cartographic = camera.positionCartographic
  const lon = Cesium.Math.toDegrees(cartographic.longitude)
  const lat = Cesium.Math.toDegrees(cartographic.latitude)
  const zoom = Math.round(cartographic.height / 1000)
  setMapState({ center: [lon, lat], zoom })
}
```

---

## Step 5: Create Additional Map Styles

### Create a Survey Style

Copy and modify boundaries.xml:

```bash
cp services/mapnik/styles/boundaries.xml services/mapnik/styles/survey.xml
```

Edit `services/mapnik/styles/survey.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Map>
<Map srs="+proj=merc +a=6378137 +b=6378137 +over" background-color="#ffffff">

  <Parameters>
    <Parameter name="name">Survey Areas</Parameter>
    <Parameter name="description">Survey project areas with status</Parameter>
  </Parameters>

  <Layer name="survey_areas" srs="+proj:longlat +ellps=WGS84 +datum=WGS84 +no_defs">
    <StyleName>survey_style</StyleName>
    <Datasource>
      <Parameter name="type">postgis</Parameter>
      <Parameter name="dbname">rakshagis</Parameter>
      <Parameter name="host">localhost</Parameter>
      <Parameter name="port">5432</Parameter>
      <Parameter name="user">raksha</Parameter>
      <Parameter name="password">YOUR_DB_PASSWORD</Parameter>
      <Parameter name="table">
        (SELECT id, name, status, geometry FROM survey_projects_surveyarea
         WHERE geometry IS NOT NULL) AS survey_areas
      </Parameter>
      <Parameter name="geometry_field">geometry</Parameter>
      <Parameter name="use_spatial_index">true</Parameter>
    </Datasource>
  </Layer>

  <Style name="survey_style">
    <Rule>
      <Filter>[status] = 'completed'</Filter>
      <PolygonSymbolizer fill="#2ecc71" fill-opacity="0.4"/>
      <LineSymbolizer stroke="#27ae60" stroke-width="2"/>
    </Rule>
    <Rule>
      <Filter>[status] = 'in_progress'</Filter>
      <PolygonSymbolizer fill="#f39c12" fill-opacity="0.4"/>
      <LineSymbolizer stroke="#d68910" stroke-width="2"/>
    </Rule>
    <Rule>
      <Filter>[status] = 'pending'</Filter>
      <PolygonSymbolizer fill="#e74c3c" fill-opacity="0.4"/>
      <LineSymbolizer stroke="#c0392b" stroke-width="2"/>
    </Rule>
  </Style>

</Map>
```

Now the survey style will be available in the export modal!

---

## Step 6: Advanced Features

### Add Database Indexes for Performance

```bash
psql -h localhost -U raksha -d rakshagis << 'SQL'
-- Add spatial indexes for faster rendering
CREATE INDEX IF NOT EXISTS idx_boundary_geometry ON gis_layers_boundary USING GIST(geometry);
CREATE INDEX IF NOT EXISTS idx_survey_geometry ON survey_projects_surveyarea USING GIST(geometry);

-- Add status index for filtering
CREATE INDEX IF NOT EXISTS idx_survey_status ON survey_projects_surveyarea(status);
SQL
```

### Enable Caching

Edit `apps/core/views.py` in the `export_map` function:

```python
from django.views.decorators.cache import cache_page

@cache_page(60 * 5)  # Cache for 5 minutes
@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def export_map(request):
    # ... existing code ...
```

### Add Rate Limiting

```python
from django_ratelimit.decorators import ratelimit

@ratelimit(key='user', rate='10/h', method='POST')
@api_view(['POST'])
def export_map(request):
    # ... existing code ...
```

---

## Testing Checklist

- [ ] Mapnik installed: `python3 -c "import mapnik; print(mapnik.mapnik_version())"`
- [ ] boundaries.xml updated with your DB credentials
- [ ] Test render: `python manage.py shell` → test export
- [ ] Django server running: `python manage.py runserver`
- [ ] Frontend rebuilt: `cd frontend && npm run build`
- [ ] API endpoint works: `curl http://localhost/api/core/map-styles/`
- [ ] Export button visible on map page
- [ ] Click export → PNG downloads
- [ ] Multiple styles working (boundaries, survey, etc.)

---

## Common Issues & Solutions

### Issue: "ModuleNotFoundError: No module named 'mapnik'"

**Solution:**
```bash
source venv/bin/activate
pip install mapnik
```

### Issue: "could not translate host name 'localhost' to address"

**Solution:**
```bash
# 1. Check PostgreSQL is running
psql -h localhost -U raksha -d rakshagis -c "SELECT 1"

# 2. Update boundaries.xml with correct host/password
nano services/mapnik/styles/boundaries.xml

# 3. Test again
```

### Issue: Blank maps rendering

**Solution:**
```bash
# 1. Check your data exists
psql -h localhost -U raksha -d rakshagis << 'SQL'
SELECT COUNT(*) FROM gis_layers_boundary;
SELECT COUNT(*) FROM survey_projects_surveyarea;
SQL

# 2. Add sample data if needed
# 3. Increase zoom level to see features
```

### Issue: Slow map rendering

**Solution:**
```bash
# 1. Add database indexes (see Step 6)
# 2. Simplify queries in boundaries.xml
# 3. Use higher zoom level
# 4. Reduce image size
```

---

## Full Workflow Example

```bash
# 1. Install
cd /home/karthi/RakshaGIS
bash install-mapnik.sh

# 2. Configure
nano services/mapnik/styles/boundaries.xml
# Update: host, user, password, dbname

# 3. Test
python3 << 'EOF'
import mapnik
m = mapnik.Map(800, 600)
mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')
m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))
img = mapnik.Image(800, 600)
mapnik.render(m, img)
img.save('test.png')
print("✓ Success!")
EOF

# 4. Start application
python manage.py runserver &
cd frontend && npm run dev &

# 5. Test in browser
# Open: http://localhost:5173/map
# Click: Export Map
# Expected: PNG downloads
```

---

## Documentation References

- **Full Mapnik Guide**: See `MAPNIK_INTEGRATION.md`
- **Docker Setup**: See `DOCKER_MAPNIK_SETUP.md`
- **API Reference**: See `apps/core/views.py`
- **Component Props**: See `frontend/src/features/map/MapExportModal.tsx`

---

**Version**: 2026-05-30  
**Status**: Production Ready  
**Support**: balusamy.karthikeyan@gmail.com
