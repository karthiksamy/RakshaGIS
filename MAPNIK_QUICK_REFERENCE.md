# Mapnik Quick Reference Card

**Complete Mapnik setup and usage in 10 minutes**

---

## ⚡ Quick Install (5 minutes)

```bash
cd /home/karthi/RakshaGIS

# Step 1: Run installer
bash install-mapnik.sh

# Step 2: Update config (edit file with your credentials)
nano services/mapnik/styles/boundaries.xml
# Change:
#   host: localhost
#   user: raksha
#   password: YOUR_PASSWORD
#   dbname: rakshagis

# Step 3: Test
python3 -c "
import mapnik
m = mapnik.Map(800, 600)
mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')
m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))
img = mapnik.Image(800, 600)
mapnik.render(m, img)
img.save('test.png')
print('✓ Success!')
"
```

---

## 🚀 Use in Your App (5 minutes)

### Backend (Already Ready)
```python
# In apps/core/views.py

# POST /api/core/export-map/
# Input: {width, height, zoom, center_lon, center_lat, style}
# Output: PNG file

# GET /api/core/map-styles/
# Output: {styles: [], count: N}
```

### Frontend (React Component)
```tsx
import MapExportModal from '@/features/map/MapExportModal'
import { useState } from 'react'

export default function MyMapPage() {
  const [visible, setVisible] = useState(false)
  const [mapState] = useState({
    center: [78.5, 20.5],
    zoom: 10
  })

  return (
    <>
      <button onClick={() => setVisible(true)}>Export Map</button>
      <MapExportModal 
        visible={visible}
        onClose={() => setVisible(false)}
        mapState={mapState}
      />
    </>
  )
}
```

---

## 📁 File Locations

| Purpose | Location |
|---------|----------|
| **Styles (XML)** | `services/mapnik/styles/` |
| **Default style** | `services/mapnik/styles/boundaries.xml` |
| **API endpoints** | `apps/core/views.py` |
| **Service layer** | `apps/core/services/mapnik_service.py` |
| **React component** | `frontend/src/features/map/MapExportModal.tsx` |
| **Database utils** | `frontend/src/services/documentUtils.ts` |

---

## 🎯 Available Endpoints

### Export Map as PNG
```bash
curl -X POST http://localhost:8000/api/core/export-map/ \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "width": 1200,
    "height": 800,
    "zoom": 10,
    "center_lon": 78.5,
    "center_lat": 20.5,
    "style": "boundaries"
  }' \
  -o map.png
```

### List Available Styles
```bash
curl http://localhost:8000/api/core/map-styles/ \
  -H "Authorization: Bearer YOUR_TOKEN"

# Response:
# {"styles": ["boundaries", "survey"], "count": 2}
```

---

## 🎨 Create New Styles

### Copy existing style
```bash
cp services/mapnik/styles/boundaries.xml \
   services/mapnik/styles/my_style.xml
```

### Edit the new style
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Map>
<Map srs="+proj=merc +a=6378137 +b=6378137 +over">

  <Layer name="my_layer">
    <Datasource>
      <Parameter name="type">postgis</Parameter>
      <Parameter name="host">localhost</Parameter>
      <Parameter name="user">raksha</Parameter>
      <Parameter name="password">YOUR_PASSWORD</Parameter>
      <Parameter name="dbname">rakshagis</Parameter>
      <Parameter name="table">
        (SELECT id, geometry FROM your_table) AS layer
      </Parameter>
    </Datasource>
  </Layer>

  <Style name="my_style">
    <Rule>
      <PolygonSymbolizer fill="#FF0000" fill-opacity="0.5"/>
      <LineSymbolizer stroke="#000000" stroke-width="1"/>
    </Rule>
  </Style>

</Map>
```

### Use it
```bash
# It will automatically appear in /api/core/map-styles/
curl http://localhost:8000/api/core/map-styles/
# {"styles": ["boundaries", "my_style"], "count": 2}
```

---

## ⚙️ Configuration

### Database Connection (in XML files)
```xml
<Datasource>
  <Parameter name="type">postgis</Parameter>
  <Parameter name="host">localhost</Parameter>
  <Parameter name="port">5432</Parameter>
  <Parameter name="user">raksha</Parameter>
  <Parameter name="password">YOUR_PASSWORD</Parameter>
  <Parameter name="dbname">rakshagis</Parameter>
  <Parameter name="table">
    (SELECT id, geometry FROM your_table) AS your_layer
  </Parameter>
  <Parameter name="geometry_field">geometry</Parameter>
  <Parameter name="use_spatial_index">true</Parameter>
</Datasource>
```

### For Docker (host.docker.internal)
```xml
<Parameter name="host">host.docker.internal</Parameter>
```

### Map Styling (CartoCSS/Mapnik syntax)
```xml
<!-- Polygon fill and stroke -->
<PolygonSymbolizer fill="#RRGGBB" fill-opacity="0.5"/>
<LineSymbolizer stroke="#RRGGBB" stroke-width="2"/>

<!-- Text labels -->
<TextSymbolizer fontset-name="my_font" fill="#000000">
  [name]
</TextSymbolizer>

<!-- Conditional styling -->
<Rule>
  <Filter>[status] = 'completed'</Filter>
  <PolygonSymbolizer fill="#00FF00"/>
</Rule>
```

---

## 🧪 Testing

### Test 1: Direct Python
```bash
python3 << 'EOF'
import mapnik
m = mapnik.Map(800, 600)
mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')
m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))
img = mapnik.Image(800, 600)
mapnik.render(m, img)
img.save('test.png')
print("✓ Map saved to test.png")
EOF
```

### Test 2: Django Shell
```bash
python manage.py shell
```
```python
from apps.core.services.mapnik_service import get_mapnik_service
service = get_mapnik_service()
service.load_style('boundaries')
service.set_center_zoom(78.5, 20.5, 10)
png = service.render_png(1200, 800)
print(f"✓ Rendered {len(png)} bytes")
```

### Test 3: API
```bash
curl http://localhost:8000/api/core/map-styles/ \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test 4: Browser
1. Go to map page
2. Click "Export Map" button
3. Select style → Set size → Click Export
4. PNG file downloads

---

## 🐛 Troubleshooting

| Problem | Solution |
|---------|----------|
| Mapnik not found | `pip install mapnik` |
| DB connection error | Update host/user/password in XML |
| Blank maps | Check data exists: `SELECT COUNT(*) FROM your_table` |
| Slow rendering | Add indexes: `CREATE INDEX idx_geom ON table USING GIST(geometry)` |
| 404 on style | Ensure .xml file exists in `services/mapnik/styles/` |
| API 503 | Mapnik not installed or failed to load style |

---

## 📊 Performance Tuning

```bash
# Add spatial indexes
psql -h localhost -U raksha -d rakshagis << 'SQL'
CREATE INDEX idx_boundary_geom ON gis_layers_boundary USING GIST(geometry);
CREATE INDEX idx_survey_geom ON survey_projects_surveyarea USING GIST(geometry);
SQL

# In boundaries.xml, use simple queries
<Parameter name="table">
  (SELECT id, geometry FROM gis_layers_boundary LIMIT 1000) AS layer
</Parameter>

# Cache rendered maps
# Add to export_map() in views.py:
@cache_page(60 * 5)  # Cache for 5 minutes
```

---

## 📋 Checklists

### Installation
- [ ] Run `bash install-mapnik.sh`
- [ ] `import mapnik` works in Python
- [ ] boundaries.xml created
- [ ] DB credentials updated

### Configuration
- [ ] Database host correct
- [ ] Database user/password correct
- [ ] Database name correct
- [ ] XML file syntax valid

### Integration
- [ ] Django app running
- [ ] API endpoints accessible
- [ ] React component imported
- [ ] Frontend rebuilt (`npm run build`)

### Testing
- [ ] Direct Python test works
- [ ] Django shell test works
- [ ] API returns styles list
- [ ] Export modal visible
- [ ] PNG downloads successfully

---

## 🔗 Related Documentation

| Document | Purpose |
|----------|---------|
| `HOW_TO_USE_MAPNIK.md` | Detailed setup guide |
| `MAPNIK_INTEGRATION.md` | Technical reference |
| `DOCKER_MAPNIK_SETUP.md` | Docker deployment |
| `MAP_PRINTING_OPTIONS.md` | Tool comparison |

---

## 💡 Tips & Tricks

### Render different zoom levels
```python
for zoom in range(1, 21):
    service.set_center_zoom(78.5, 20.5, zoom)
    png = service.render_png(800, 600)
    print(f"Zoom {zoom}: {len(png)} bytes")
```

### Batch render multiple areas
```python
areas = [
    {"name": "north", "lon": 75, "lat": 30},
    {"name": "south", "lon": 78, "lat": 15},
    {"name": "east", "lon": 85, "lat": 25},
]

for area in areas:
    service.set_center_zoom(area["lon"], area["lat"], 12)
    png = service.render_png(1200, 800)
    with open(f"map_{area['name']}.png", "wb") as f:
        f.write(png)
```

### Custom color schemes
```xml
<Style name="custom_style">
  <Rule>
    <Filter>[type] = 'residential'</Filter>
    <PolygonSymbolizer fill="#FF6B6B"/>
  </Rule>
  <Rule>
    <Filter>[type] = 'commercial'</Filter>
    <PolygonSymbolizer fill="#4ECDC4"/>
  </Rule>
</Style>
```

---

## 📞 Support

- **Install issues**: See `install-mapnik.sh` output
- **Usage questions**: See `HOW_TO_USE_MAPNIK.md`
- **Technical details**: See `MAPNIK_INTEGRATION.md`
- **Docker problems**: See `DOCKER_MAPNIK_SETUP.md`

---

**Ready to export maps!** 🗺️

```bash
# Quick start (30 seconds)
bash install-mapnik.sh  # 5 min
nano services/mapnik/styles/boundaries.xml  # 2 min
# Then use in app!
```
