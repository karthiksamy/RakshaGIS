# Mapnik Implementation Workflow - Step by Step

**Complete visual guide for implementing Mapnik in RakshaGIS**

---

## 🎯 Overall Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    RakshaGIS Application                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────────────────┐        ┌──────────────────────┐ │
│  │   React Frontend       │        │  Django Backend      │ │
│  │  ┌────────────────────┤        ├──────────────────────┤ │
│  │  │  MapPage           │        │  apps/core/views.py  │ │
│  │  │  ┌──────────────┐  │        │  ┌────────────────┐  │ │
│  │  │  │ Export Btn ──┼──┼────────┼─→│ export_map()   │  │ │
│  │  │  │              │  │        │  │ map_styles()   │  │ │
│  │  │  └──────────────┘  │        │  └────────┬───────┘  │ │
│  │  │                    │        │           │          │ │
│  │  │ MapExportModal     │        │  mapnik_service.py  │ │
│  │  │ ┌──────────────┐   │        │  ┌────────────────┐ │ │
│  │  │ │ Style Select │   │        │  │ MapnikService  │ │ │
│  │  │ │ Size Input   │   │        │  │ ┌────────────┐ │ │ │
│  │  │ │ Export Btn   │   │        │  │ │ render()   │ │ │ │
│  │  │ └──────────────┘   │        │  │ │ load_style │ │ │ │
│  │  └────────────────────┘        │  │ └────────────┘ │ │ │
│  │                                 │  └────────┬───────┘ │ │
│  └────────────────────────────────┬┴──────────┬─────────┘ │
│                                    │          │           │
└────────────────────────────────────┼──────────┼───────────┘
                                     │          │
                    ┌────────────────┘          │
                    │                           │
            ┌───────▼────────┐      ┌──────────▼──────────┐
            │    Mapnik      │      │   PostgreSQL       │
            │  Rendering     │      │   + PostGIS        │
            │    Engine      │      │  gis_layers_boundary│
            │                │      │  survey_projects_*  │
            │ Load XML style │      │  boundaries.xml    │
            │ Query DB       │      │  queries data      │
            │ Render PNG     │      │                    │
            └────────────────┘      └────────────────────┘
```

---

## 📋 Step-by-Step Implementation

### PHASE 1: Installation (5 minutes)

```
START
  │
  ├─→ Step 1: Install Mapnik System Packages
  │   ├─→ sudo apt-get update
  │   └─→ sudo apt-get install mapnik-utils python3-mapnik libmapnik-dev
  │
  ├─→ Step 2: Run install-mapnik.sh
  │   ├─→ bash install-mapnik.sh
  │   ├─→ Creates /services/mapnik/styles/
  │   └─→ Installs Python Mapnik via pip
  │
  ├─→ Step 3: Verify Installation
  │   ├─→ python3 -c "import mapnik; print(mapnik.mapnik_version())"
  │   └─→ ✓ Output: "Mapnik version X.X.X"
  │
  └─→ INSTALLATION COMPLETE
```

---

### PHASE 2: Configuration (3 minutes)

```
START
  │
  ├─→ Step 1: Update Database Config
  │   ├─→ Open: services/mapnik/styles/boundaries.xml
  │   ├─→ Find: <Parameter name="host">localhost</Parameter>
  │   ├─→ Find: <Parameter name="user">raksha</Parameter>
  │   ├─→ Find: <Parameter name="password">change-me</Parameter>
  │   ├─→ Find: <Parameter name="dbname">rakshagis</Parameter>
  │   │
  │   └─→ Update with your actual values:
  │       ├─→ host: localhost (or your DB host)
  │       ├─→ user: raksha (or your DB user)
  │       ├─→ password: YOUR_ACTUAL_PASSWORD
  │       └─→ dbname: rakshagis (or your DB name)
  │
  ├─→ Step 2: Update Table/Column Names (if different)
  │   ├─→ Check your actual tables:
  │   │   psql -h localhost -U raksha -d rakshagis
  │   │   \dt  (list tables)
  │   │
  │   └─→ Update in boundaries.xml:
  │       ├─→ Replace: gis_layers_boundary → YOUR_TABLE
  │       └─→ Replace: survey_projects_surveyarea → YOUR_TABLE
  │
  ├─→ Step 3: Verify Syntax
  │   ├─→ XML must be well-formed
  │   ├─→ All tags properly closed
  │   └─→ ✓ Or use XML validator: xmllint boundaries.xml
  │
  └─→ CONFIGURATION COMPLETE
```

---

### PHASE 3: Testing (2 minutes)

```
START
  │
  ├─→ Test 1: Direct Mapnik Rendering
  │   ├─→ python3 << 'EOF'
  │   ├─→   import mapnik
  │   ├─→   m = mapnik.Map(800, 600)
  │   ├─→   mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')
  │   ├─→   m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))
  │   ├─→   img = mapnik.Image(800, 600)
  │   ├─→   mapnik.render(m, img)
  │   ├─→   img.save('test.png')
  │   ├─→ EOF
  │   │
  │   └─→ ✓ Check: test.png created and displays map
  │
  ├─→ Test 2: Django Service Test
  │   ├─→ python manage.py shell
  │   ├─→ from apps.core.services.mapnik_service import get_mapnik_service
  │   ├─→ service = get_mapnik_service()
  │   ├─→ service.load_style('boundaries')
  │   ├─→ service.set_center_zoom(78.5, 20.5, 10)
  │   ├─→ png = service.render_png(1200, 800)
  │   ├─→ len(png)  # Should be > 10000
  │   │
  │   └─→ ✓ Output: 10000+ bytes rendered
  │
  ├─→ Test 3: API Endpoint Test
  │   ├─→ curl http://localhost:8000/api/core/map-styles/
  │   │   (requires: Authorization header with token)
  │   │
  │   └─→ ✓ Output: {"styles": ["boundaries"], "count": 1}
  │
  └─→ ALL TESTS PASSED
```

---

### PHASE 4: Integration (2 minutes)

```
START
  │
  ├─→ Step 1: Ensure Backend Running
  │   ├─→ python manage.py runserver
  │   └─→ ✓ Shows: "Starting development server at http://127.0.0.1:8000/"
  │
  ├─→ Step 2: Rebuild Frontend
  │   ├─→ cd frontend
  │   ├─→ npm run build
  │   └─→ ✓ Shows: "built in X.XXs"
  │
  ├─→ Step 3: Start Frontend Dev Server (optional)
  │   ├─→ npm run dev
  │   └─→ ✓ Shows: "Local: http://localhost:5173/"
  │
  ├─→ Step 4: Test in Browser
  │   ├─→ Dev: Open http://localhost:5173/map
  │   ├─→ Prod: Open http://localhost/map
  │   │
  │   ├─→ Expected: See "Export Map" button
  │   │
  │   ├─→ Click "Export Map"
  │   │   ├─→ Modal appears
  │   │   ├─→ Style dropdown shows "boundaries"
  │   │   ├─→ Width: 1200, Height: 800
  │   │   └─→ Click "Export as PNG"
  │   │
  │   ├─→ Expected: PNG file downloads
  │   │   └─→ File: rakshagis_map_YYYY-MM-DD.png
  │   │
  │   └─→ ✓ OPEN PNG → Should show your map!
  │
  └─→ INTEGRATION COMPLETE
```

---

## 🎨 Creating New Map Styles

```
START
  │
  ├─→ Step 1: Copy Existing Style
  │   └─→ cp services/mapnik/styles/boundaries.xml \
  │        services/mapnik/styles/survey.xml
  │
  ├─→ Step 2: Edit Survey Style
  │   └─→ nano services/mapnik/styles/survey.xml
  │
  │      Key changes:
  │      ├─→ Change parameter "name" → "Survey Areas"
  │      ├─→ Change table → survey_projects_surveyarea
  │      └─→ Update style colors/filters
  │
  │      Example:
  │      └─→ <Style name="survey_style">
  │             <Rule>
  │               <Filter>[status] = 'completed'</Filter>
  │               <PolygonSymbolizer fill="#00FF00"/>
  │             </Rule>
  │             <Rule>
  │               <Filter>[status] = 'pending'</Filter>
  │               <PolygonSymbolizer fill="#FF0000"/>
  │             </Rule>
  │           </Style>
  │
  ├─→ Step 3: Test New Style
  │   ├─→ curl http://localhost:8000/api/core/map-styles/
  │   │   (should now list: ["boundaries", "survey"])
  │   │
  │   └─→ ✓ "survey" appears in export modal
  │
  ├─→ Step 4: Refresh Browser
  │   ├─→ Reload map page
  │   ├─→ Click Export Map
  │   │
  │   └─→ ✓ "Survey" option now available!
  │
  └─→ NEW STYLE READY TO USE
```

---

## 📊 Data Flow Diagram

```
User Action
    │
    ├─→ Clicks "Export Map" button
    │
    ├─→ MapExportModal opens
    │   ├─→ Fetches available styles
    │   │   GET /api/core/map-styles/
    │   │   └─→ ["boundaries", "survey"]
    │   │
    │   └─→ User selects style & size
    │
    ├─→ Clicks "Export as PNG"
    │
    ├─→ API Request
    │   POST /api/core/export-map/
    │   {
    │     "width": 1200,
    │     "height": 800,
    │     "zoom": 10,
    │     "center_lon": 78.5,
    │     "center_lat": 20.5,
    │     "style": "boundaries"
    │   }
    │
    ├─→ Django Backend
    │   ├─→ export_map() in views.py
    │   ├─→ Calls get_mapnik_service()
    │   ├─→ Loads style: "boundaries.xml"
    │   ├─→ Sets bounds: center + zoom
    │   │
    │   └─→ Renders PNG
    │       ├─→ Queries database
    │       │   SELECT * FROM gis_layers_boundary...
    │       ├─→ Mapnik renders features
    │       └─→ Returns PNG bytes
    │
    ├─→ API Response
    │   ├─→ Content-Type: image/png
    │   └─→ PNG binary data
    │
    ├─→ Browser
    │   ├─→ Receives PNG file
    │   ├─→ Triggers download
    │   └─→ File saved: rakshagis_map_2026-05-30.png
    │
    └─→ User Views Map
        └─→ Opens PNG in image viewer
```

---

## ✅ Complete Checklist

### Installation ✓
```
[ ] 1. Install system packages
      sudo apt-get install mapnik-utils python3-mapnik libmapnik-dev
      
[ ] 2. Run install script
      bash install-mapnik.sh
      
[ ] 3. Verify Mapnik
      python3 -c "import mapnik; print(mapnik.mapnik_version())"
```

### Configuration ✓
```
[ ] 1. Update database credentials
      nano services/mapnik/styles/boundaries.xml
      
[ ] 2. Set host, user, password, dbname
      
[ ] 3. Verify table names match your schema
```

### Testing ✓
```
[ ] 1. Test direct rendering
      python3 << 'EOF'
      import mapnik
      m = mapnik.Map(800, 600)
      mapnik.load_map(m, 'services/mapnik/styles/boundaries.xml')
      m.zoom_to_box(mapnik.Box2d(68, 6, 97, 37))
      img = mapnik.Image(800, 600)
      mapnik.render(m, img)
      img.save('test.png')
      EOF
      
[ ] 2. Test Django service
      python manage.py shell
      from apps.core.services.mapnik_service import get_mapnik_service
      service = get_mapnik_service()
      service.load_style('boundaries')
      service.set_center_zoom(78.5, 20.5, 10)
      png = service.render_png(1200, 800)
      len(png)  # Should be > 10000
      
[ ] 3. Test API
      curl http://localhost:8000/api/core/map-styles/ \
        -H "Authorization: Bearer YOUR_TOKEN"
```

### Integration ✓
```
[ ] 1. Start Django server
      python manage.py runserver
      
[ ] 2. Rebuild frontend
      cd frontend && npm run build
      
[ ] 3. Start frontend (optional)
      npm run dev
      
[ ] 4. Test in browser
      http://localhost:5173/map  (or localhost/map)
      
[ ] 5. Click "Export Map"
      
[ ] 6. Select style and export
      
[ ] 7. Verify PNG downloads and opens
```

---

## 🐛 Debug Mode

If something doesn't work:

```bash
# 1. Check if Mapnik is installed
python3 -c "import mapnik; print(mapnik.mapnik_version())"

# 2. Check database connection
psql -h localhost -U raksha -d rakshagis -c "SELECT COUNT(*) FROM gis_layers_boundary"

# 3. Check style file exists
ls -la services/mapnik/styles/boundaries.xml

# 4. Check style syntax
xmllint services/mapnik/styles/boundaries.xml

# 5. Check API is returning styles
curl http://localhost:8000/api/core/map-styles/ -H "Authorization: Bearer TOKEN"

# 6. Check Django logs
python manage.py runserver > debug.log 2>&1

# 7. Check frontend build
ls -la staticfiles/assets/ | grep -i export

# 8. Check browser console
# Open http://localhost:5173/map
# Press F12 → Console tab
# Look for errors
```

---

## 🎓 Learning Resources

| Topic | File |
|-------|------|
| Quick start | `MAPNIK_QUICK_REFERENCE.md` |
| Full guide | `HOW_TO_USE_MAPNIK.md` |
| Technical details | `MAPNIK_INTEGRATION.md` |
| Docker setup | `DOCKER_MAPNIK_SETUP.md` |
| This workflow | `MAPNIK_WORKFLOW_STEPS.md` |

---

## 📞 Support

**Installation issues?**
→ See `install-mapnik.sh` output
→ See `HOW_TO_USE_MAPNIK.md` Step 1

**Configuration problems?**
→ Check database credentials
→ Verify table names with `psql`
→ Validate XML syntax with `xmllint`

**API not working?**
→ Check backend is running
→ Verify auth token included
→ Check logs: `docker compose logs web`

**Frontend issues?**
→ Check frontend rebuilt: `npm run build`
→ Clear cache: `Ctrl+Shift+Del`
→ Hard refresh: `Ctrl+F5`

---

**Time to complete: 10-15 minutes total**  
**Status: Ready for production**  
**Version: 2026-05-30**

✅ **You're ready to export maps!** 🗺️
