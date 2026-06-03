# Mapnik Implementation Checklist ✓

**Status**: All code files created and ready ✅  
**Date**: 2026-05-30  
**Next**: Follow the steps below to deploy

---

## ✅ Code Files Created

- [x] `apps/core/services/mapnik_service.py` — Mapnik rendering service
- [x] `apps/core/views/mapnik_export.py` — Django API endpoints
- [x] `apps/core/urls.py` — Route registration (updated)
- [x] `frontend/src/features/map/MapExportModal.tsx` — React export component
- [x] `services/mapnik/styles/boundaries.xml` — Sample map style
- [x] `install-mapnik.sh` — Installation script
- [x] `MAPNIK_INTEGRATION.md` — Full documentation (22KB)
- [x] `MAPNIK_SETUP_COMPLETE.md` — Setup guide with 6 steps
- [x] `frontend/MAPNIK_INTEGRATION_GUIDE.md` — Integration examples
- [x] `IMPLEMENTATION_SUMMARY.md` — Project overview

---

## 📋 Installation & Setup

### Step 1: Install Mapnik (5 min)
```bash
# Option A: Direct install
sudo apt-get update
sudo apt-get install -y mapnik-utils python3-mapnik libmapnik-dev libmapnik3.1

# Verify installation
python3 -c "import mapnik; print(f'✓ Mapnik {mapnik.mapnik_version()}')"
```

**Estimated time**: 5 minutes  
**Blocker if**: Mapnik package not available for your OS

---

### Step 2: Update Database Credentials (2 min)
Edit: `services/mapnik/styles/boundaries.xml`

Find these lines (around line 20):
```xml
<Parameter name="host">localhost</Parameter>
<Parameter name="user">raksha</Parameter>
<Parameter name="password">change-me</Parameter>
<Parameter name="dbname">rakshagis</Parameter>
```

Replace with your actual values from `.env`:
- `host`: Usually `db` (Docker) or `localhost` (local)
- `user`: Your DB username (e.g., `raksha`)
- `password`: Your DB password
- `dbname`: Your DB name (e.g., `rakshagis`)

**Estimated time**: 2 minutes

---

### Step 3: Rebuild Frontend (3 min)
```bash
cd /home/karthi/RakshaGIS/frontend
npm run build
```

**Estimated time**: 3 minutes  
**Expected output**: `built in X.XXs`

---

### Step 4: Test Mapnik Service (5 min)
```bash
cd /home/karthi/RakshaGIS
python3 << 'EOF'
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')

import django
django.setup()

from apps.core.services.mapnik_service import get_mapnik_service

try:
    service = get_mapnik_service()
    service.load_style('boundaries')
    service.set_center_zoom(78.5, 20.5, 10)
    png_data = service.render_png(1200, 800)
    print(f"✓ SUCCESS: Rendered {len(png_data)} bytes")
except Exception as e:
    print(f"✗ FAILED: {e}")
EOF
```

**Expected output**: `✓ SUCCESS: Rendered XXXXX bytes`  
**Estimated time**: 5 minutes

---

### Step 5: Test API Routes (2 min)
```bash
cd /home/karthi/RakshaGIS
python manage.py shell << 'EOF'
from django.urls import reverse
print("✓ Routes registered:")
print(f"  export-map: {reverse('export-map')}")
print(f"  map-styles: {reverse('map-styles')}")
EOF
```

**Expected output**:
```
✓ Routes registered:
  export-map: /api/core/export-map/
  map-styles: /api/core/map-styles/
```

**Estimated time**: 2 minutes

---

### Step 6: Test in Browser (10 min)
1. Start Django dev server:
   ```bash
   cd /home/karthi/RakshaGIS
   python manage.py runserver
   ```

2. Start frontend dev server (new terminal):
   ```bash
   cd /home/karthi/RakshaGIS/frontend
   npm run dev
   ```

3. Open browser: `http://localhost:5173/map`

4. Look for **"Export Map"** button (should be visible)

5. Click Export → Select "Boundaries" → Click "Export as PNG"

6. File should download as `rakshagis_map_2026-05-30.png`

**Estimated time**: 10 minutes  
**Troubleshooting**: See `MAPNIK_SETUP_COMPLETE.md` section "Troubleshooting"

---

## 🔌 Integration Points

### If Using OpenLayers
Add to your `MapPage.tsx`:
```tsx
import MapExportModal from './MapExportModal'
const [exportVisible, setExportVisible] = useState(false)

return (
  <>
    <button onClick={() => setExportVisible(true)}>Export</button>
    <MapExportModal visible={exportVisible} onClose={() => setExportVisible(false)} mapState={{center: [78.5, 20.5], zoom: 10}} />
  </>
)
```

**Reference**: `frontend/MAPNIK_INTEGRATION_GUIDE.md` (OpenLayers example)

---

### If Using Cesium
Add to your `TerrainPage.tsx`:
```tsx
import MapExportModal from '../map/MapExportModal'
const [exportVisible, setExportVisible] = useState(false)
const [mapState, setMapState] = useState({center: [78.5, 20.5], zoom: 10})

// Update mapState when Cesium camera moves...

return (
  <>
    <button onClick={() => setExportVisible(true)}>Export 3D Map</button>
    <MapExportModal visible={exportVisible} onClose={() => setExportVisible(false)} mapState={mapState} />
  </>
)
```

**Reference**: `frontend/MAPNIK_INTEGRATION_GUIDE.md` (Cesium example)

---

## 🐳 Docker Deployment

### Update Dockerfile
Add to `Dockerfile` in the RUN apt-get install section:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    mapnik-utils \
    python3-mapnik \
    libmapnik-dev \
    libmapnik3.1 \
    && rm -rf /var/lib/apt/lists/*

COPY services/mapnik /app/services/mapnik
```

### Update docker-compose.yml
Add volume mount to the `web` service:
```yaml
services:
  web:
    volumes:
      - ./services/mapnik:/app/services/mapnik:ro
```

### Build and Deploy
```bash
docker compose build
docker compose up -d
docker compose logs -f web
```

**Estimated time**: 10 minutes  
**Expected**: App should start with no Mapnik errors

---

## ✓ Validation Checklist

After following steps above, verify:

- [ ] Mapnik installed: `python3 -c "import mapnik; print(mapnik.mapnik_version())"`
- [ ] Credentials updated in `boundaries.xml`
- [ ] Frontend built: `ls frontend/dist/` (should have files)
- [ ] Service test passed (Step 4)
- [ ] Routes registered (Step 5)
- [ ] Export button visible (Step 6)
- [ ] PNG downloads successfully (Step 6)
- [ ] Downloaded file is valid PNG (can open in image viewer)

---

## 📊 Performance Expectations

After setup, you should see:

| Operation | Expected Time |
|-----------|----------------|
| Render 1200×800 PNG | 50-100ms |
| API response time | 50-150ms (including network) |
| Browser download | <1 second |
| File size | 50-200KB (PNG) |

If slower, check:
- Database connection speed
- Network latency
- System CPU/memory availability
- Mapnik complexity (zoom level, number of features)

---

## 🆘 Common Issues & Solutions

### Issue: "ImportError: No module named mapnik"
**Solution**: Run Step 1 install-mapnik again
```bash
sudo apt-get install python3-mapnik
```

### Issue: "Style not found: boundaries"
**Solution**: Check file exists
```bash
ls services/mapnik/styles/boundaries.xml
```

### Issue: "could not translate host name 'localhost' to address"
**Solution**: Update database credentials in `boundaries.xml` to match your setup

### Issue: Export button doesn't appear
**Solution**: 
1. Check frontend build succeeded
2. Check MapExportModal is imported in your MapPage
3. Check browser console for errors

### Issue: Export fails with 503 (Service Unavailable)
**Solution**: Mapnik not installed or not working
- Run Step 4 test again
- Check `python3 -c "import mapnik"`

### Issue: Downloaded PNG is black or blank
**Solution**: 
1. Database might be empty
2. Boundaries might not exist in DB
3. Style query might be wrong

Try Step 4 debug:
```python
service = get_mapnik_service()
service.load_style('boundaries')
service.set_center_zoom(78.5, 20.5, 15)  # Higher zoom
png = service.render_png(1200, 800)
```

---

## 📚 Documentation

| Document | Purpose | Time |
|----------|---------|------|
| `MAPNIK_SETUP_COMPLETE.md` | Complete guide (6 steps + testing) | 5 min read |
| `MAPNIK_INTEGRATION.md` | Technical deep-dive (22KB) | 20 min read |
| `frontend/MAPNIK_INTEGRATION_GUIDE.md` | React integration examples | 10 min read |
| `MAP_PRINTING_OPTIONS.md` | Comparison of export tools | 15 min read |

---

## 🚀 Next Steps After Validation

1. **Create Additional Styles**
   - Copy `boundaries.xml` to `survey.xml`
   - Modify queries and colors
   - Test with `curl -d '{"style": "survey"}' ...`

2. **Integrate Everywhere**
   - Add Export button to all map pages
   - Add custom presets (Web, Print, Social Media sizes)
   - Add batch export feature

3. **Performance Tuning**
   - Add spatial indexes: `CREATE INDEX idx_geometry ON table_name USING GIST(geometry);`
   - Cache rendered maps in Redis
   - Add image compression

4. **Advanced Features**
   - User-customizable map styles (color picker UI)
   - Scheduled report generation
   - Map overlays (grids, scale, compass)
   - Multiple output formats (PDF, GeoTIFF, etc.)

---

## ⏱️ Total Implementation Time

| Step | Time |
|------|------|
| Install Mapnik | 5 min |
| Update credentials | 2 min |
| Rebuild frontend | 3 min |
| Test service | 5 min |
| Test routes | 2 min |
| Browser test | 10 min |
| **Total** | **27 minutes** ⏱️ |

---

## Support

- **Issue**: See `MAPNIK_SETUP_COMPLETE.md` Troubleshooting section
- **Questions**: Check `MAPNIK_INTEGRATION.md` FAQ
- **Integration Help**: See `frontend/MAPNIK_INTEGRATION_GUIDE.md`
- **Email**: balusamy.karthikeyan@gmail.com

---

**Status**: Ready to Deploy ✅  
**Last Updated**: 2026-05-30  
**Next Checkpoint**: All steps completed by 2026-06-02
