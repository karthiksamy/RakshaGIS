# Mapnik Docker Setup - Live Progress

**Started**: 2026-05-30  
**Status**: Building Docker image...

---

## ✅ Completed Steps

### Step 1: Auto-Update Configuration ✓
```bash
./update-mapnik-for-docker.sh
```
**Result**: 
- ✓ Loaded DB_PASSWORD from .env
- ✓ Updated boundaries.xml with host.docker.internal
- ✓ Set credentials: raksha / raksha_dev_pass
- ✓ Updated all 3 layers (state, district, survey)
- ✓ Backup created: boundaries.xml.backup

---

## 🔄 In Progress

### Step 2: Build Docker Image
```bash
docker compose build web
```
**Status**: Building...
**What it's doing**:
- Installing base Python 3.11
- Installing GeoDjango dependencies (GDAL, GEOS, PostGIS libs)
- Installing Mapnik packages (mapnik-utils, python3-mapnik, libmapnik-dev)
- Installing other dependencies (libreoffice, fonts)
- Copying your code
- Copying Mapnik styles

**Estimated time**: 3-5 minutes  
**Expected size**: ~1.5 GB

---

## ⏭️ Next Steps (After Build Completes)

### Step 3: Start Services
```bash
docker compose up -d
```
**Will start**:
- PostgreSQL database
- Redis cache
- Django web server (Daphne)
- Celery worker
- Nginx reverse proxy

**Time**: ~30 seconds

### Step 4: Test Mapnik Connection
```bash
docker compose exec web python3 << 'EOF'
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
import django; django.setup()
from apps.core.services.mapnik_service import get_mapnik_service
service = get_mapnik_service()
service.load_style('boundaries')
service.set_center_zoom(78.5, 20.5, 10)
png = service.render_png(1200, 800)
print(f"✓ SUCCESS: Rendered {len(png)} bytes from host database!")
EOF
```
**Expected output**: `✓ SUCCESS: Rendered XXXXX bytes from host database!`

### Step 5: Test in Browser
**Dev mode**:
```bash
cd frontend && npm run dev
# Open: http://localhost:5173/map
```

**Production mode**:
```bash
# Open: http://localhost/map
```

**Look for**: "Export Map" button → Click → Download PNG

---

## Database Connection

**Your local PostgreSQL**:
- Host: `localhost:5432`
- User: `raksha`
- Password: `raksha_dev_pass`
- Database: `rakshagis`
- Status: ✅ Running (should be on host)

**Docker Mapnik connection**:
- Host: `host.docker.internal:5432` (Docker bridge to host)
- User: `raksha`
- Password: `raksha_dev_pass`
- Database: `rakshagis`
- Status: ✅ Will work after `docker compose up`

---

## Architecture Diagram

```
┌─────────────────────────────────┐
│      YOUR MACHINE               │
│  ┌───────────────────────────┐  │
│  │  PostgreSQL (localhost)   │  │
│  │  ✓ Data stays here        │  │
│  │  ✓ Easy to backup         │  │
│  └───────────────┬───────────┘  │
│                  │               │
│       host.docker.internal:5432  │
│                  │               │
└──────────────────┼───────────────┘
                   │
┌──────────────────┼───────────────┐
│     DOCKER       │               │
│  ┌──────────────▼─────────────┐  │
│  │ Mapnik Service             │  │
│  │ ✓ Renders maps             │  │
│  │ ✓ Connects to host DB      │  │
│  │ ✓ 50-100ms per export      │  │
│  └───────────┬────────────────┘  │
│              │                    │
│  ┌───────────▼────────────────┐  │
│  │ Django REST API            │  │
│  │ POST /api/core/export-map/ │  │
│  │ GET /api/core/map-styles/  │  │
│  └───────────┬────────────────┘  │
│              │                    │
└──────────────┼────────────────────┘
               │
            BROWSER
         Download PNG
```

---

## Checklist for Completion

- [ ] Step 1: Auto-update ✓ DONE
- [ ] Step 2: Docker build (in progress...)
- [ ] Step 3: Start services
- [ ] Step 4: Test Mapnik
- [ ] Step 5: Test browser
- [ ] See "Export Map" button
- [ ] Download PNG successfully

---

## Logs to Check

If anything fails:

```bash
# View full build output
docker compose build web --progress=plain

# Check running containers
docker compose ps

# View logs
docker compose logs -f web

# Test database
psql -h localhost -U raksha -d rakshagis -c "SELECT 1"

# Test Docker connection to host DB
docker compose exec web python3 -c "
import psycopg2
conn = psycopg2.connect('dbname=rakshagis user=raksha password=raksha_dev_pass host=host.docker.internal port=5432')
print('✓ Database connected!')
"
```

---

## Success Indicators

✅ Build succeeds (no red ERROR messages)  
✅ Services start (`docker compose up -d`)  
✅ Test prints "✓ SUCCESS: XXXXX bytes!"  
✅ Browser shows "Export Map" button  
✅ PNG downloads when clicked  

If all ✅, you're done! 🎉

---

**Status**: Building Docker image...  
**Next update**: When build completes  
**Estimated completion**: 5 minutes from now
