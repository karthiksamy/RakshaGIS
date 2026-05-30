# Docker Mapnik Setup (Local Database)

**Goal**: Run Mapnik in Docker while keeping PostgreSQL database on your host machine.

---

## Architecture

```
Host Machine              Docker Container
─────────────────────────────────────────
PostgreSQL (local)  ←→   Mapnik Service
   :5432           via   (in web container)
                   host.docker.internal:5432
```

---

## Step 1: Update Mapnik Style for Host Database

Edit: `services/mapnik/styles/boundaries.xml`

Change the database connection parameters to use **host.docker.internal**:

```xml
<!-- CHANGE THESE LINES (around line 20): -->

<!-- OLD (localhost - doesn't work in Docker): -->
<Parameter name="host">localhost</Parameter>

<!-- NEW (host.docker.internal - works from Docker → host): -->
<Parameter name="host">host.docker.internal</Parameter>

<!-- Rest of credentials -->
<Parameter name="port">5432</Parameter>
<Parameter name="user">raksha</Parameter>
<Parameter name="password">YOUR_PASSWORD_HERE</Parameter>
<Parameter name="dbname">rakshagis</Parameter>
```

**Complete section should look like:**
```xml
<Layer name="state_boundaries" srs="+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs">
  <StyleName>state_style</StyleName>
  <Datasource>
    <Parameter name="type">postgis</Parameter>
    <Parameter name="dbname">rakshagis</Parameter>
    <Parameter name="host">host.docker.internal</Parameter>
    <Parameter name="port">5432</Parameter>
    <Parameter name="user">raksha</Parameter>
    <Parameter name="password">your-actual-password</Parameter>
    <Parameter name="table">
      (SELECT id, name, geometry FROM gis_layers_boundary
       WHERE boundary_type = 'STATE' AND geometry IS NOT NULL
       ORDER BY id) AS state_boundaries
    </Parameter>
    <Parameter name="geometry_field">geometry</Parameter>
    <Parameter name="use_spatial_index">true</Parameter>
  </Datasource>
</Layer>
```

Do the same for **all three layers** in the XML file (state, district, survey).

---

## Step 2: Verify Dockerfile Has Mapnik

Check that Dockerfile was updated with Mapnik packages:

```bash
grep -n "mapnik" /home/karthi/RakshaGIS/Dockerfile
```

**Should output:**
```
4:        mapnik-utils \
5:        python3-mapnik \
6:        libmapnik-dev \
7:        libmapnik3.1 \
...
24:COPY --chown=raksha:raksha services/mapnik /app/services/mapnik
```

If not, see `DOCKERFILE_MAPNIK_UPDATE.md` in root.

---

## Step 3: Build Docker Image

```bash
cd /home/karthi/RakshaGIS

# Build the image (includes Mapnik + Mapnik styles)
docker compose build web

# Expected output:
# [+] Building 45.5s (10/10) FINISHED
```

**Time**: 2-5 minutes (first build with Mapnik packages)

---

## Step 4: Start All Services

```bash
# Start PostgreSQL and all services
docker compose up -d

# Check if everything started
docker compose ps

# Should show:
# web     ... Up
# db      ... Up
# redis   ... Up
```

**Time**: 1-2 minutes

---

## Step 5: Verify Mapnik in Docker

Test that Mapnik can connect to your host database:

```bash
# Run Python test inside the Docker container
docker compose exec web python3 << 'EOF'
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
    print(f"✓ SUCCESS: Rendered {len(png_data)} bytes from host database!")
except Exception as e:
    print(f"✗ FAILED: {e}")
    import traceback
    traceback.print_exc()
EOF
```

**Expected output:**
```
✓ SUCCESS: Rendered XXXXX bytes from host database!
```

**If it fails with "could not translate host name":**
- Database password in XML is wrong
- Rebuild image: `docker compose build web`
- Restart: `docker compose restart web`

---

## Step 6: Test API from Browser

### Option A: Frontend Dev Server (Recommended for Development)

```bash
# Terminal 1: Start Docker backend
cd /home/karthi/RakshaGIS
docker compose up -d

# Terminal 2: Start frontend dev server
cd /home/karthi/RakshaGIS/frontend
npm run dev

# Browser: http://localhost:5173/map
# Click Export Map → should work!
```

### Option B: Production Build

```bash
# Build frontend
cd /home/karthi/RakshaGIS/frontend
npm run build

# Rebuild Docker with new frontend
cd /home/karthi/RakshaGIS
docker compose build web
docker compose up -d

# Browser: http://localhost/map
# (Served by Nginx on port 80)
```

---

## Step 7: Test API Directly

```bash
# Get available styles
curl http://localhost/api/core/map-styles/

# Should return:
# {"styles": ["boundaries"], "count": 1}

# Export a map (requires authentication)
curl -X POST http://localhost/api/core/export-map/ \
  -H "Content-Type: application/json" \
  -d '{
    "width": 1200,
    "height": 800,
    "zoom": 10,
    "center_lon": 78.5,
    "center_lat": 20.5,
    "style": "boundaries"
  }' \
  -o test_map.png

# Opens test_map.png in image viewer
```

---

## Data Persistence

Your data stays on your host:

```
~/.rakshagis/                    ← Set in .env as DATA_DIR
├── postgres/                    ← PostgreSQL data (persistent)
│   ├── base/
│   └── ...
├── redis/                       ← Redis cache
├── staticfiles/                 ← Built frontend assets
└── media/                       ← User uploads
```

**To backup everything:**
```bash
tar -czf rakshagis-backup.tar.gz ~/.rakshagis/
```

**To restore:**
```bash
tar -xzf rakshagis-backup.tar.gz -C ~
docker compose up -d
```

---

## Troubleshooting

### "could not translate host name 'host.docker.internal' to address"

**Cause**: Database credentials in XML are wrong or host is unreachable

**Fix**:
```bash
# 1. Verify your local database is running
psql -h localhost -U raksha -d rakshagis -c "SELECT 1"

# 2. Check password in .env
grep DB_PASSWORD .env

# 3. Update XML with correct password
nano services/mapnik/styles/boundaries.xml

# 4. Rebuild Docker
docker compose build web
docker compose restart web

# 5. Test again
docker compose exec web python3 << 'EOF'
...
EOF
```

### "style not found: boundaries"

**Cause**: XML file not copied to Docker image

**Fix**:
```bash
# Check if file exists in image
docker compose exec web ls -la /app/services/mapnik/styles/

# If not, rebuild
docker compose build web --no-cache
docker compose restart web
```

### "PermissionError" on database

**Cause**: PostgreSQL credentials wrong

**Fix**:
```bash
# Test local connection
psql -h localhost -U raksha -d rakshagis

# Get actual password
cat .env | grep DB_PASSWORD

# Update XML with exact password
nano services/mapnik/styles/boundaries.xml
```

### Port 5432 already in use

**Cause**: Docker's `db` service conflicts with local PostgreSQL

**Solutions**:
1. **Stop Docker db service** (use local DB only):
   ```bash
   docker compose stop db
   docker compose up -d web redis
   ```
   Or comment out `db:` service in docker-compose.yml

2. **Change Docker port**:
   ```yaml
   # In docker-compose.yml, db service:
   ports:
     - "5433:5432"
   ```
   Then update XML: `<Parameter name="port">5433</Parameter>`

---

## Docker Commands

```bash
# View logs
docker compose logs -f web

# Shell into container
docker compose exec web bash

# Restart services
docker compose restart web

# Stop all services
docker compose down

# Stop and remove data (WARNING!)
docker compose down -v

# View database from host
psql -h localhost -U raksha -d rakshagis
```

---

## Performance Tips

1. **Database Indexes**: Add indexes on geometry columns
   ```sql
   CREATE INDEX idx_boundary_geometry ON gis_layers_boundary USING GIST(geometry);
   CREATE INDEX idx_survey_geometry ON survey_projects_surveyarea USING GIST(geometry);
   ```

2. **Limit Zoom Levels**: In XML, use `MaxScaleDenominator` to limit rendering
   ```xml
   <Rule>
     <MaxScaleDenominator>100000</MaxScaleDenominator>
     ...
   </Rule>
   ```

3. **Cache Maps**: Implement Redis caching in `mapnik_export.py`

---

## Next Steps

1. ✅ Update XML credentials
2. ✅ Build Docker image
3. ✅ Test Mapnik service
4. ✅ Test API
5. Create more map styles (survey.xml, disputes.xml)
6. Add custom styles UI
7. Deploy to production server

---

## Summary

| Step | Command | Time |
|------|---------|------|
| Update XML | nano boundaries.xml | 2 min |
| Build Docker | docker compose build web | 3-5 min |
| Start services | docker compose up -d | 1 min |
| Test service | docker compose exec web python3 ... | 1 min |
| Test browser | Open http://localhost:5173/map | 2 min |
| **Total** | | **~10-15 min** |

✅ **Done!** Your data stays on host, Mapnik runs in Docker.
